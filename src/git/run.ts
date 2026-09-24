import { spawn } from "node:child_process";
import { realpath } from "node:fs/promises";
import path from "node:path";
import type { ProjectRecord } from "../projects/registry.js";
import { ContextBridgeError } from "../security/errors.js";
import { isSensitiveProjectRoot, isWithinProject } from "../security/paths.js";

export interface GitOutput {
  stdout: Buffer;
  exitCode: number;
  truncated: boolean;
}

export interface GitScope {
  worktreeRoot: string;
  projectRoot: string;
  prefix: string;
}

const DEFAULT_GIT_LIMIT = 8 * 1024 * 1024;

function childEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "SystemRoot", "WINDIR", "TEMP", "TMP"]) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  env.GIT_CONFIG_NOSYSTEM = "1";
  env.GIT_CONFIG_GLOBAL = process.platform === "win32" ? "NUL" : "/dev/null";
  env.GIT_TERMINAL_PROMPT = "0";
  env.GIT_NO_LAZY_FETCH = "1";
  env.GIT_ALLOW_PROTOCOL = "";
  env.GIT_OPTIONAL_LOCKS = "0";
  env.GIT_PAGER = "cat";
  env.PAGER = "cat";
  env.LC_ALL = "C";
  return env;
}

export class GitRepository {
  private filterConfig: string[] | undefined;
  private promisorConfig: string[] | undefined;
  private scopePromise: Promise<GitScope> | undefined;

  constructor(private readonly project: ProjectRecord) {}

  private async getFilterConfig(repositoryRoot: string): Promise<string[]> {
    if (this.filterConfig) return this.filterConfig;
    const result = await this.runRaw(
      [
        "config",
        "--local",
        "--name-only",
        "--get-regexp",
        "^filter\\..*\\.(clean|smudge|process)$",
      ],
      { allowExitCodes: [1], maxBytes: 64 * 1024, applySafeConfig: false },
      repositoryRoot,
    );
    const keys = result.stdout.toString("utf8").split(/\r?\n/).filter(Boolean);
    const drivers = new Set<string>();
    for (const key of keys) {
      const match = /^filter\.(.*)\.(?:clean|smudge|process)$/i.exec(key);
      if (match?.[1]) drivers.add(match[1]);
    }
    const config: string[] = [];
    for (const driver of drivers) {
      config.push(
        "-c",
        `filter.${driver}.clean=`,
        "-c",
        `filter.${driver}.smudge=`,
        "-c",
        `filter.${driver}.process=`,
      );
    }
    this.filterConfig = config;
    return config;
  }

  private async getPromisorConfig(repositoryRoot: string): Promise<string[]> {
    if (this.promisorConfig) return this.promisorConfig;
    const remotes = new Set<string>();
    const configuredRemotes = await this.runRaw(
      [
        "config",
        "--local",
        "--name-only",
        "--get-regexp",
        "^remote\\..*\\.promisor$",
      ],
      { allowExitCodes: [1], maxBytes: 64 * 1024, applySafeConfig: false },
      repositoryRoot,
    );
    for (const key of configuredRemotes.stdout
      .toString("utf8")
      .split(/\r?\n/)
      .filter(Boolean)) {
      const match = /^remote\.(.*)\.promisor$/i.exec(key);
      if (match?.[1]) remotes.add(match[1]);
    }
    const partialClone = await this.runRaw(
      ["config", "--local", "--get", "extensions.partialClone"],
      { allowExitCodes: [1], maxBytes: 4096, applySafeConfig: false },
      repositoryRoot,
    );
    const partialCloneRemote = partialClone.stdout.toString("utf8").trim();
    if (partialCloneRemote) remotes.add(partialCloneRemote);
    this.promisorConfig = [...remotes].flatMap((remote) => [
      "-c",
      `remote.${remote}.promisor=false`,
    ]);
    return this.promisorConfig;
  }

  private async runRaw(
    args: string[],
    options: {
      maxBytes?: number;
      timeoutMs?: number;
      allowExitCodes?: number[];
      applySafeConfig?: boolean;
    } = {},
    repositoryRoot = this.project.root,
  ): Promise<GitOutput> {
    const maxBytes = options.maxBytes ?? DEFAULT_GIT_LIMIT;
    const timeoutMs = options.timeoutMs ?? 15_000;
    const baseArgs = [
      "-C",
      repositoryRoot,
      "--no-pager",
      "--no-replace-objects",
      "--literal-pathspecs",
    ];
    if (options.applySafeConfig !== false) {
      baseArgs.push(
        "-c",
        "core.fsmonitor=false",
        "-c",
        "core.untrackedCache=false",
        "-c",
        "core.pager=cat",
        "-c",
        "credential.helper=",
        "-c",
        "diff.external=",
        "-c",
        "protocol.allow=never",
      );
      baseArgs.push(...(await this.getFilterConfig(repositoryRoot)));
      baseArgs.push(...(await this.getPromisorConfig(repositoryRoot)));
    }
    const child = spawn("git", [...baseArgs, ...args], {
      cwd: repositoryRoot,
      env: childEnvironment(),
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const stdoutChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let truncated = false;
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);

    const output = await new Promise<{ exitCode: number; stdout: Buffer }>(
      (resolve, reject) => {
        child.stdout.on("data", (chunk: Buffer) => {
          const remaining = maxBytes - stdoutBytes;
          if (remaining > 0) {
            const kept = chunk.subarray(0, remaining);
            stdoutChunks.push(kept);
            stdoutBytes += kept.length;
          }
          if (chunk.length > remaining) {
            truncated = true;
            child.kill("SIGTERM");
          }
        });
        child.once("error", (error) => {
          clearTimeout(timeout);
          if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            reject(
              new ContextBridgeError(
                "git_unavailable",
                "Git is not installed or is not available on PATH.",
              ),
            );
          } else {
            reject(
              new ContextBridgeError(
                "git_error",
                "Git could not run the requested read-only operation.",
              ),
            );
          }
        });
        child.once("close", (code) => {
          clearTimeout(timeout);
          resolve({
            exitCode: code ?? -1,
            stdout: Buffer.concat(stdoutChunks),
          });
        });
      },
    );

    if (timedOut)
      throw new ContextBridgeError(
        "git_timeout",
        "The Git operation exceeded its time limit.",
      );
    if (
      output.exitCode !== 0 &&
      !(options.allowExitCodes ?? []).includes(output.exitCode) &&
      !truncated
    ) {
      throw new ContextBridgeError(
        "git_error",
        `Git operation failed with exit code ${output.exitCode}.`,
      );
    }
    return { ...output, truncated };
  }

  async run(
    args: string[],
    options: {
      maxBytes?: number;
      timeoutMs?: number;
      allowExitCodes?: number[];
    } = {},
  ): Promise<GitOutput> {
    const scope = await this.scope();
    return this.runRaw(args, options, scope.worktreeRoot);
  }

  async scope(): Promise<GitScope> {
    this.scopePromise ??= this.resolveScope();
    return this.scopePromise;
  }

  private async resolveScope(): Promise<GitScope> {
    let projectRoot: string;
    try {
      projectRoot = await realpath(this.project.root);
    } catch {
      throw new ContextBridgeError(
        "project_root_missing",
        "The registered project root is no longer accessible.",
      );
    }
    if (isSensitiveProjectRoot(projectRoot))
      throw new ContextBridgeError(
        "git_scope_error",
        "Git access is unavailable for this project.",
      );
    const result = await this.runRaw(
      ["rev-parse", "--show-toplevel"],
      { maxBytes: 4096, applySafeConfig: false },
      this.project.root,
    );
    const reportedRoot = result.stdout.toString("utf8").replace(/[\r\n]+$/, "");
    let worktreeRoot: string;
    try {
      worktreeRoot = await realpath(reportedRoot);
    } catch {
      throw new ContextBridgeError(
        "git_scope_error",
        "Git returned an inaccessible worktree root.",
      );
    }
    const gitDirectory = await this.resolveGitDirectory(
      "--absolute-git-dir",
      projectRoot,
    );
    const commonDirectory = await this.resolveGitDirectory(
      "--git-common-dir",
      projectRoot,
    );
    if (!isWithinProject(worktreeRoot, projectRoot))
      throw new ContextBridgeError(
        "git_scope_error",
        "The registered project root is outside the Git worktree.",
      );
    if (
      !isWithinProject(worktreeRoot, gitDirectory) ||
      !isWithinProject(worktreeRoot, commonDirectory)
    )
      throw new ContextBridgeError(
        "git_scope_error",
        "Git metadata resolves outside the discovered worktree.",
      );
    return {
      worktreeRoot,
      projectRoot,
      prefix: path
        .relative(worktreeRoot, projectRoot)
        .split(path.sep)
        .join("/"),
    };
  }

  private async resolveGitDirectory(
    option: "--absolute-git-dir" | "--git-common-dir",
    projectRoot: string,
  ): Promise<string> {
    const result = await this.runRaw(
      ["rev-parse", option],
      { maxBytes: 4096, applySafeConfig: false },
      projectRoot,
    );
    const reportedPath = result.stdout.toString("utf8").replace(/[\r\n]+$/, "");
    try {
      return await realpath(path.resolve(projectRoot, reportedPath));
    } catch {
      throw new ContextBridgeError(
        "git_scope_error",
        "Git returned inaccessible repository metadata.",
      );
    }
  }

  async gitPath(projectRelativePath: string): Promise<string> {
    const { prefix } = await this.scope();
    if (!prefix) return projectRelativePath;
    return projectRelativePath ? `${prefix}/${projectRelativePath}` : prefix;
  }

  async projectPath(worktreeRelativePath: string): Promise<string | undefined> {
    const { prefix } = await this.scope();
    const candidate = worktreeRelativePath.replace(/\\/g, "/");
    if (!prefix) return candidate;
    const comparableCandidate =
      process.platform === "win32" ? candidate.toLowerCase() : candidate;
    const comparablePrefix =
      process.platform === "win32" ? prefix.toLowerCase() : prefix;
    if (comparableCandidate === comparablePrefix) return "";
    const marker = `${comparablePrefix}/`;
    if (!comparableCandidate.startsWith(marker)) return undefined;
    return candidate.slice(marker.length);
  }
}

export async function isGitRepository(
  project: ProjectRecord,
): Promise<boolean> {
  const repository = new GitRepository(project);
  try {
    await repository.scope();
    return true;
  } catch (error) {
    if (
      error instanceof ContextBridgeError &&
      ["git_error", "git_unavailable", "git_scope_error"].includes(error.code)
    )
      return false;
    throw error;
  }
}
