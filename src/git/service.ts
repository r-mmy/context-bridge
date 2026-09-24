import { open, stat } from "node:fs/promises";
import type { ProjectRecord } from "../projects/registry.js";
import { ContextBridgeError } from "../security/errors.js";
import { isProjectPathVisible, resolveProjectPath } from "../security/paths.js";
import { clampOutputBytes, truncateUtf8 } from "../filesystem/read.js";
import { collectProjectFiles } from "../filesystem/walk.js";
import { GitRepository } from "./run.js";

export interface GitStatus {
  branch: string | null;
  upstream: string | null;
  ahead: number | null;
  behind: number | null;
  staged: string[];
  modified: string[];
  deleted: string[];
  untracked: string[];
  truncated: boolean;
}

export interface CommitSummary {
  revision: string;
  author: string;
  date: string;
  subject: string;
}

export type DiffMode = "working" | "staged" | "unstaged" | "refs";

const MAX_UNTRACKED_PATHS = 2048;
const MAX_UNTRACKED_BATCH_PATHS = 64;
const MAX_UNTRACKED_BATCH_CHARS = 8 * 1024;

function splitNul(buffer: Buffer): string[] {
  return buffer.toString("utf8").split("\0").filter(Boolean);
}

async function visiblePaths(
  project: ProjectRecord,
  candidates: string[],
): Promise<string[]> {
  const allowed: string[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (!candidate || seen.has(candidate)) continue;
    seen.add(candidate);
    if (await isProjectPathVisible(project, candidate)) allowed.push(candidate);
  }
  return allowed;
}

async function pathArgument(
  project: ProjectRecord,
  supplied: string | undefined,
): Promise<string | undefined> {
  if (supplied === undefined) return undefined;
  const resolved = await resolveProjectPath(project, supplied, {
    allowMissing: true,
  });
  return resolved.relativePath || undefined;
}

async function validateRevision(
  repository: GitRepository,
  revision: string,
): Promise<string> {
  if (revision.length < 1 || revision.length > 256 || revision.includes("\0")) {
    throw new ContextBridgeError(
      "invalid_revision",
      "The Git revision is invalid.",
    );
  }
  const output = await repository.run(
    ["rev-parse", "--verify", "--end-of-options", `${revision}^{commit}`],
    { maxBytes: 4096 },
  );
  const commit = output.stdout.toString("utf8").trim();
  if (!/^[0-9a-f]{40,64}$/i.test(commit))
    throw new ContextBridgeError(
      "invalid_revision",
      "The revision does not resolve to a commit.",
    );
  return commit;
}

async function changedPaths(
  repository: GitRepository,
  args: string[],
  pathFilter?: string,
): Promise<{ paths: string[]; truncated: boolean }> {
  const scope = await repository.scope();
  const command = [...args, "--name-only", "-z"];
  if (pathFilter) command.push("--", await repository.gitPath(pathFilter));
  else if (scope.prefix) command.push("--", scope.prefix);
  const result = await repository.run(command, { maxBytes: 8 * 1024 * 1024 });
  const paths: string[] = [];
  for (const worktreePath of splitNul(result.stdout)) {
    const projectPath = await repository.projectPath(worktreePath);
    if (projectPath) paths.push(projectPath);
  }
  return { paths, truncated: result.truncated };
}

function appendBounded(
  current: string,
  addition: Buffer,
  maxBytes: number,
): { text: string; truncated: boolean } {
  const used = Buffer.byteLength(current, "utf8");
  const remaining = Math.max(0, maxBytes - used);
  const kept = truncateUtf8(addition, remaining);
  return {
    text: current + new TextDecoder("utf-8", { fatal: true }).decode(kept),
    truncated: addition.byteLength > remaining,
  };
}

async function collectPatch(
  project: ProjectRecord,
  repository: GitRepository,
  pathList: string[],
  commandPrefix: string[],
  maxBytes: number,
): Promise<{ patch: string; includedPaths: string[]; truncated: boolean }> {
  const allowed = await visiblePaths(project, pathList);
  const includedPaths: string[] = [];
  const scope = await repository.scope();
  let patch = "";
  let truncated = false;
  for (const filePath of allowed) {
    const remaining = maxBytes - Buffer.byteLength(patch, "utf8");
    if (remaining <= 0) {
      truncated = true;
      break;
    }
    const result = await repository.run(
      [
        ...commandPrefix,
        ...(scope.prefix ? [`--relative=${scope.prefix}`] : []),
        "--no-ext-diff",
        "--no-textconv",
        "--no-color",
        "--no-renames",
        "--unified=3",
        "--",
        await repository.gitPath(filePath),
      ],
      { maxBytes: remaining + 1 },
    );
    const appended = appendBounded(patch, result.stdout, maxBytes);
    patch = appended.text;
    if (result.stdout.length > 0) includedPaths.push(filePath);
    if (result.truncated || appended.truncated) {
      truncated = true;
      break;
    }
  }
  return { patch, includedPaths, truncated };
}

async function listUntracked(
  project: ProjectRecord,
  repository: GitRepository,
  pathFilter?: string,
): Promise<{ paths: string[]; truncated: boolean }> {
  let discovered: Awaited<ReturnType<typeof collectProjectFiles>>;
  try {
    discovered = await collectProjectFiles(project, pathFilter ?? ".");
  } catch (error) {
    if (error instanceof ContextBridgeError && error.code === "path_missing")
      return { paths: [], truncated: false };
    throw error;
  }

  const candidates = new Map<string, string>();
  let truncated = discovered.truncated;
  let batch: Array<{ gitPath: string; projectPath: string }> = [];
  let batchChars = 0;
  const batches: Array<Array<{ gitPath: string; projectPath: string }>> = [];
  const flushBatch = () => {
    if (batch.length) batches.push(batch);
    batch = [];
    batchChars = 0;
  };
  for (const projectPath of discovered.files) {
    const gitPath = await repository.gitPath(projectPath);
    const argChars = gitPath.length + 1;
    if (argChars > MAX_UNTRACKED_BATCH_CHARS) {
      truncated = true;
      continue;
    }
    if (
      batch.length >= MAX_UNTRACKED_BATCH_PATHS ||
      batchChars + argChars > MAX_UNTRACKED_BATCH_CHARS
    )
      flushBatch();
    batch.push({ gitPath, projectPath });
    batchChars += argChars;
    candidates.set(gitPath, projectPath);
  }
  flushBatch();

  const paths: string[] = [];
  for (const pathBatch of batches) {
    // Scope Git to bounded, already policy-filtered file candidates. This
    // avoids enumerating ignored dependency trees and preserves Context
    // Bridge's ability to re-include ordinary Git-ignored files.
    const output = await repository.run(
      [
        "ls-files",
        "--others",
        "-z",
        "--",
        ...pathBatch.map((entry) => entry.gitPath),
      ],
      { maxBytes: 64 * 1024 },
    );
    truncated ||= output.truncated;
    for (const worktreePath of splitNul(output.stdout)) {
      const projectPath = await repository.projectPath(worktreePath);
      if (
        !projectPath ||
        !pathBatch.some((entry) => entry.gitPath === worktreePath)
      )
        continue;
      const expectedProjectPath = candidates.get(worktreePath);
      if (expectedProjectPath !== projectPath) continue;
      if (paths.length >= MAX_UNTRACKED_PATHS) {
        truncated = true;
        break;
      }
      paths.push(projectPath);
    }
    if (paths.length >= MAX_UNTRACKED_PATHS) break;
  }
  return { paths: [...new Set(paths)], truncated };
}

function quotePatchPath(prefix: string, relativePath: string): string {
  const escaped = `${prefix}${relativePath}`
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\t/g, "\\t")
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n");
  return `"${escaped}"`;
}

async function readUntrackedPatch(
  project: ProjectRecord,
  relativePath: string,
  maxBytes: number,
): Promise<{ patch: string; truncated: boolean } | undefined> {
  const resolved = await resolveProjectPath(project, relativePath);
  const details = await stat(resolved.absolutePath);
  if (!details.isFile()) return undefined;
  const bytesToRead = Math.min(details.size, maxBytes + 1);
  const handle = await open(resolved.absolutePath, "r");
  let buffer: Buffer;
  try {
    const allocated = Buffer.alloc(bytesToRead);
    const { bytesRead } =
      bytesToRead > 0
        ? await handle.read(allocated, 0, bytesToRead, 0)
        : { bytesRead: 0 };
    buffer = allocated.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
  if (buffer.includes(0)) return undefined;
  buffer = truncateUtf8(buffer, maxBytes);
  const truncated = details.size > maxBytes || bytesToRead > maxBytes;
  let content: string;
  try {
    content = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    return undefined;
  }
  const lines = content.split(/\r?\n/);
  if (content.endsWith("\n") || content.endsWith("\r")) lines.pop();
  const filenameA = quotePatchPath("a/", relativePath);
  const filenameB = quotePatchPath("b/", relativePath);
  const body = lines.map((line) => `+${line}`).join("\n");
  const header = `diff --git ${filenameA} ${filenameB}\nnew file mode 100644\n--- /dev/null\n+++ ${filenameB}\n@@ -0,0 +1,${lines.length} @@\n`;
  return { patch: `${header}${body}${body ? "\n" : ""}`, truncated };
}

export async function getGitStatus(project: ProjectRecord): Promise<GitStatus> {
  const repository = new GitRepository(project);
  const scope = await repository.scope();
  const args = [
    "status",
    "--porcelain=v1",
    "-b",
    "-z",
    "--untracked-files=no",
    "--no-renames",
    "--ignore-submodules=all",
  ];
  if (scope.prefix) args.push("--", scope.prefix);
  const output = await repository.run(args, { maxBytes: 8 * 1024 * 1024 });
  const records = splitNul(output.stdout);
  const header = records.shift() ?? "";
  let branch: string | null = null;
  let upstream: string | null = null;
  let ahead: number | null = null;
  let behind: number | null = null;
  if (header.startsWith("## ")) {
    const state = header.slice(3);
    const unbornBranch = /^(?:No commits yet|Initial commit) on (.+)$/.exec(
      state,
    );
    if (unbornBranch?.[1]) {
      branch = unbornBranch[1];
    } else if (!state.startsWith("HEAD")) {
      const [namePart, trackingPart] = state.split("...");
      branch = (namePart?.split(" ")[0] ?? "") || null;
      if (trackingPart) {
        const match = /^(.*?)\s+\[(.*)\]$/.exec(trackingPart);
        upstream = (match?.[1] ?? trackingPart).trim() || null;
        const aheadMatch = /ahead (\d+)/.exec(match?.[2] ?? "");
        const behindMatch = /behind (\d+)/.exec(match?.[2] ?? "");
        ahead = aheadMatch ? Number(aheadMatch[1]) : 0;
        behind = behindMatch ? Number(behindMatch[1]) : 0;
      }
    }
  }

  const staged = new Set<string>();
  const modified = new Set<string>();
  const deleted = new Set<string>();
  const untracked = new Set<string>();
  for (const record of records) {
    if (record.startsWith("## ") || record.length < 4) continue;
    const x = record[0] ?? " ";
    const y = record[1] ?? " ";
    const relativePath = await repository.projectPath(record.slice(3));
    if (!relativePath) continue;
    if (!(await isProjectPathVisible(project, relativePath))) continue;
    if (x === "?" && y === "?") {
      untracked.add(relativePath);
      continue;
    }
    if (x !== " ") staged.add(relativePath);
    if (
      y === "M" ||
      y === "A" ||
      y === "R" ||
      y === "C" ||
      y === "T" ||
      x === "M"
    )
      modified.add(relativePath);
    if (x === "D" || y === "D") deleted.add(relativePath);
  }
  const untrackedCandidates = await listUntracked(project, repository);
  for (const relativePath of await visiblePaths(
    project,
    untrackedCandidates.paths,
  ))
    untracked.add(relativePath);
  const sort = (values: Set<string>) =>
    [...values].sort((left, right) => left.localeCompare(right));
  const pathLists = {
    staged: sort(staged),
    modified: sort(modified),
    deleted: sort(deleted),
    untracked: sort(untracked),
  };
  const bounded: Pick<
    GitStatus,
    "staged" | "modified" | "deleted" | "untracked"
  > = {
    staged: [],
    modified: [],
    deleted: [],
    untracked: [],
  };
  let resultBytes = 0;
  let totalPaths = 0;
  let truncated = output.truncated || untrackedCandidates.truncated;
  for (const category of [
    "staged",
    "modified",
    "deleted",
    "untracked",
  ] as const) {
    let limitReached = false;
    for (const relativePath of pathLists[category]) {
      const pathBytes = Buffer.byteLength(relativePath, "utf8") + 8;
      if (totalPaths >= 2000 || resultBytes + pathBytes > 256 * 1024) {
        truncated = true;
        limitReached = true;
        break;
      }
      bounded[category].push(relativePath);
      resultBytes += pathBytes;
      totalPaths += 1;
    }
    if (limitReached) break;
  }
  return {
    branch,
    upstream,
    ahead,
    behind,
    ...bounded,
    truncated,
  };
}

export async function getGitDiff(
  project: ProjectRecord,
  options: {
    mode: DiffMode;
    base?: string;
    head?: string;
    path?: string;
    maxBytes?: number;
  },
): Promise<{
  mode: DiffMode;
  files: string[];
  patch: string;
  truncated: boolean;
}> {
  const maxBytes = clampOutputBytes(options.maxBytes);
  const repository = new GitRepository(project);
  const pathFilter = await pathArgument(project, options.path);
  let names: string[];
  let prefix: string[];
  let truncated = false;
  let untracked: string[] = [];
  let patchGroups: Array<{ paths: string[]; prefix: string[] }> | undefined;

  if (options.mode === "staged") {
    prefix = ["diff", "--cached"];
    const changed = await changedPaths(
      repository,
      ["diff", "--cached", "--no-renames"],
      pathFilter,
    );
    names = changed.paths;
    truncated ||= changed.truncated;
  } else if (options.mode === "unstaged") {
    prefix = ["diff"];
    const changed = await changedPaths(
      repository,
      ["diff", "--no-renames"],
      pathFilter,
    );
    names = changed.paths;
    truncated ||= changed.truncated;
  } else if (options.mode === "refs") {
    if (!options.base)
      throw new ContextBridgeError(
        "missing_revision",
        "base is required when mode is refs.",
      );
    const base = await validateRevision(repository, options.base);
    const head = await validateRevision(repository, options.head ?? "HEAD");
    prefix = ["diff", base, head];
    const changed = await changedPaths(
      repository,
      ["diff", base, head, "--no-renames"],
      pathFilter,
    );
    names = changed.paths;
    truncated ||= changed.truncated;
  } else {
    const head = await repository.run(
      ["rev-parse", "--verify", "--quiet", "HEAD"],
      { maxBytes: 4096, allowExitCodes: [1] },
    );
    if (head.exitCode === 0) {
      prefix = ["diff", "HEAD"];
      const changed = await changedPaths(
        repository,
        ["diff", "HEAD", "--no-renames"],
        pathFilter,
      );
      names = changed.paths;
      truncated ||= changed.truncated;
    } else {
      // An unborn repository has no HEAD. Preserve both index and worktree
      // patches; `git diff --cached` alone omits unstaged edits.
      const staged = await changedPaths(
        repository,
        ["diff", "--cached", "--no-renames"],
        pathFilter,
      );
      const unstaged = await changedPaths(
        repository,
        ["diff", "--no-renames"],
        pathFilter,
      );
      names = [...staged.paths, ...unstaged.paths];
      truncated ||= staged.truncated || unstaged.truncated;
      prefix = [];
      patchGroups = [
        { paths: staged.paths, prefix: ["diff", "--cached"] },
        { paths: unstaged.paths, prefix: ["diff"] },
      ];
    }
    const untrackedCandidates = await listUntracked(
      project,
      repository,
      pathFilter,
    );
    untracked = untrackedCandidates.paths;
    truncated ||= untrackedCandidates.truncated;
    if (pathFilter)
      untracked = untracked.filter(
        (entry) => entry === pathFilter || entry.startsWith(`${pathFilter}/`),
      );
  }

  const groups = patchGroups ?? [{ paths: names, prefix }];
  let patch = "";
  const files: string[] = [];
  for (const group of groups) {
    const remaining = maxBytes - Buffer.byteLength(patch, "utf8");
    if (remaining <= 0) {
      truncated = true;
      break;
    }
    const tracked = await collectPatch(
      project,
      repository,
      await visiblePaths(project, group.paths),
      group.prefix,
      remaining,
    );
    patch += tracked.patch;
    files.push(...tracked.includedPaths);
    truncated ||= tracked.truncated;
    if (tracked.truncated) break;
  }

  if (
    options.mode === "working" &&
    Buffer.byteLength(patch, "utf8") < maxBytes
  ) {
    for (const filePath of await visiblePaths(project, untracked)) {
      const remaining = maxBytes - Buffer.byteLength(patch, "utf8");
      if (remaining <= 0) {
        truncated = true;
        break;
      }
      const added = await readUntrackedPatch(project, filePath, remaining);
      if (!added) continue;
      const appended = appendBounded(
        patch,
        Buffer.from(added.patch, "utf8"),
        maxBytes,
      );
      patch = appended.text;
      files.push(filePath);
      if (added.truncated || appended.truncated) {
        truncated = true;
        break;
      }
    }
  }
  return { mode: options.mode, files: [...new Set(files)], patch, truncated };
}

export async function getGitLog(
  project: ProjectRecord,
  options: { limit?: number; path?: string },
): Promise<{ commits: CommitSummary[]; truncated: boolean }> {
  const limit = options.limit ?? 20;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    throw new ContextBridgeError(
      "invalid_limit",
      "limit must be between 1 and 100.",
    );
  const repository = new GitRepository(project);
  const pathFilter = await pathArgument(project, options.path);
  const scope = await repository.scope();
  const head = await repository.run(
    ["rev-parse", "--verify", "--quiet", "HEAD"],
    { maxBytes: 4096, allowExitCodes: [1] },
  );
  if (head.exitCode === 1) return { commits: [], truncated: false };
  const args = [
    "log",
    `--max-count=${limit}`,
    "--format=%H%x00%an%x00%aI%x00%s",
    "-z",
  ];
  if (pathFilter) args.push("--", await repository.gitPath(pathFilter));
  else if (scope.prefix) args.push("--", scope.prefix);
  const output = await repository.run(args, { maxBytes: 256 * 1024 });
  const fields = output.stdout.toString("utf8").split("\0").filter(Boolean);
  const commits: CommitSummary[] = [];
  let truncated = output.truncated;
  for (let index = 0; index + 3 < fields.length; index += 4) {
    const [revision, author, date, subject] = fields.slice(index, index + 4);
    if (revision && author !== undefined && date && subject !== undefined) {
      commits.push({
        revision,
        author: author.slice(0, 512),
        date: date.slice(0, 128),
        subject: subject.slice(0, 2048),
      });
      if (author.length > 512 || date.length > 128 || subject.length > 2048)
        truncated = true;
    }
  }
  return { commits, truncated };
}

async function getCommitSummary(
  repository: GitRepository,
  revision: string,
): Promise<CommitSummary & { parents: string[] }> {
  const commit = await validateRevision(repository, revision);
  const result = await repository.run(
    ["show", "-s", "--format=%H%x00%P%x00%an%x00%aI%x00%s", commit],
    { maxBytes: 64 * 1024 },
  );
  const [hash, parents, author, date, ...subject] = result.stdout
    .toString("utf8")
    .split("\0");
  return {
    revision: hash ?? commit,
    parents: (parents ?? "").split(" ").filter(Boolean),
    author: author ?? "",
    date: date ?? "",
    subject: subject.join("\0").replace(/[\r\n]+$/, ""),
  };
}

export async function getGitShow(
  project: ProjectRecord,
  options: { revision: string; path?: string; maxBytes?: number },
): Promise<
  | { revision: string; path: string; content: string; truncated: boolean }
  | {
      commit: CommitSummary;
      files: string[];
      patch: string;
      truncated: boolean;
    }
> {
  const maxBytes = clampOutputBytes(options.maxBytes);
  const repository = new GitRepository(project);
  const commit = await getCommitSummary(repository, options.revision);
  if (options.path !== undefined) {
    const resolved = await resolveProjectPath(project, options.path, {
      allowMissing: true,
    });
    if (!resolved.relativePath)
      throw new ContextBridgeError(
        "invalid_path",
        "A file path is required for a file revision.",
      );
    const object = `${commit.revision}:${await repository.gitPath(resolved.relativePath)}`;
    const type = await repository.run(["cat-file", "-t", object], {
      maxBytes: 256,
    });
    if (type.stdout.toString("utf8").trim() !== "blob") {
      throw new ContextBridgeError(
        "not_a_file_revision",
        "The selected revision does not contain a file at that path.",
      );
    }
    const output = await repository.run(["cat-file", "blob", object], {
      maxBytes: maxBytes + 1,
    });
    const bytes = truncateUtf8(output.stdout, maxBytes);
    if (bytes.includes(0)) {
      throw new ContextBridgeError(
        "binary_file",
        "Binary files cannot be returned as text.",
      );
    }
    let content: string;
    try {
      content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new ContextBridgeError(
        "binary_file",
        "Binary or non-UTF-8 files cannot be returned as text.",
      );
    }
    return {
      revision: commit.revision,
      path: resolved.relativePath,
      content,
      truncated: output.truncated || output.stdout.length > maxBytes,
    };
  }

  const changed = await changedPaths(repository, [
    "diff-tree",
    "--root",
    "--no-commit-id",
    "--name-only",
    "--no-renames",
    "-r",
    commit.revision,
  ]);
  const patch = await collectPatch(
    project,
    repository,
    changed.paths,
    ["show", "--format=", commit.revision],
    maxBytes,
  );
  return {
    commit: {
      revision: commit.revision,
      author: commit.author,
      date: commit.date,
      subject: commit.subject,
    },
    files: patch.includedPaths,
    patch: patch.patch,
    truncated: changed.truncated || patch.truncated,
  };
}
