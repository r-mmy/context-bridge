import { spawn } from "node:child_process";
import { access, stat } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { getRegistryPath } from "../config/paths.js";
import {
  addProject,
  ensureRegistry,
  getProject,
  readRegistry,
  removeProject,
} from "../projects/registry.js";
import { ContextBridgeError } from "../security/errors.js";
import { isGitRepository } from "../git/run.js";
import { startHttpServer } from "../transports/http.js";
import { startStdioServer } from "../transports/stdio.js";

const VERSION = "0.1.0";

const HELP = `Context Bridge v${VERSION}
Read-only access to explicitly registered local projects through MCP.

Usage:
  ctxbridge init
  ctxbridge project add [path]
  ctxbridge project list
  ctxbridge project show <id>
  ctxbridge project remove <id>
  ctxbridge doctor
  ctxbridge mcp --stdio
  ctxbridge mcp --http [--port 7331]
  ctxbridge --version
  ctxbridge --help
`;

export interface CliIO {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  cwd: string;
}

function defaultIO(): CliIO {
  return {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
    cwd: process.cwd(),
  };
}

async function gitAvailable(): Promise<boolean> {
  return await new Promise((resolve) => {
    const child = spawn("git", ["--version"], {
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "ignore", "ignore"],
    });
    child.once("error", () => resolve(false));
    child.once("close", (code) => resolve(code === 0));
  });
}

async function commandInit(io: CliIO): Promise<void> {
  const registryPath = await ensureRegistry();
  await readRegistry();
  io.stdout(`Context Bridge is initialized. Registry: ${registryPath}\n`);
}

async function commandProject(args: string[], io: CliIO): Promise<void> {
  const [action, ...rest] = args;
  if (!action || action === "--help" || action === "-h") {
    io.stdout(`${HELP.split("\n").slice(4, 10).join("\n")}\n`);
    return;
  }
  if (action === "add") {
    if (rest.length > 1)
      throw new ContextBridgeError(
        "usage",
        "project add accepts at most one path.",
      );
    await ensureRegistry();
    const inputPath = rest[0] ? path.resolve(io.cwd, rest[0]) : io.cwd;
    const project = await addProject(inputPath);
    io.stdout(
      `Registered ${project.name} as ${project.id}\nPath: ${project.root}\n`,
    );
    return;
  }
  if (action === "list") {
    if (rest.length > 0)
      throw new ContextBridgeError("usage", "project list takes no arguments.");
    const registry = await readRegistry();
    io.stdout("ID\tNAME\tAVAILABILITY\n");
    if (registry.projects.length === 0) {
      io.stdout(
        "No projects registered. Use `ctxbridge project add [path]`.\n",
      );
      return;
    }
    for (const project of registry.projects) {
      let availability = "unavailable";
      try {
        await stat(project.root);
        availability = (await isGitRepository(project)) ? "git" : "not git";
      } catch {
        // Keep a missing root visible in the local CLI so it can be diagnosed.
      }
      io.stdout(`${project.id}\t${project.name}\t${availability}\n`);
    }
    return;
  }
  if (action === "show") {
    if (rest.length !== 1)
      throw new ContextBridgeError(
        "usage",
        "project show requires one project ID.",
      );
    const project = await getProject(rest[0] ?? "");
    io.stdout(
      `ID: ${project.id}\nName: ${project.name}\nPath: ${project.root}\nAdded: ${project.addedAt}\nGit repository: ${(await isGitRepository(project)) ? "yes" : "no"}\n`,
    );
    return;
  }
  if (action === "remove") {
    if (rest.length !== 1)
      throw new ContextBridgeError(
        "usage",
        "project remove requires one project ID.",
      );
    const removed = await removeProject(rest[0] ?? "");
    io.stdout(`Removed ${removed.id}. Project files were not changed.\n`);
    return;
  }
  throw new ContextBridgeError("usage", `Unknown project command "${action}".`);
}

async function commandDoctor(io: CliIO): Promise<void> {
  let registryExists = true;
  try {
    await access(getRegistryPath(), constants.F_OK);
  } catch {
    registryExists = false;
  }
  const hasGit = await gitAvailable();
  io.stdout(
    `Node.js: ${process.versions.node} (${Number(process.versions.node.split(".")[0]) >= 20 ? "supported" : "requires Node 20+"})\n`,
  );
  io.stdout(`Git: ${hasGit ? "available" : "not found on PATH"}\n`);
  io.stdout(`Registry: ${registryExists ? "available" : "not initialized"}\n`);
  if (!registryExists) return;
  const registry = await readRegistry();
  if (registry.projects.length === 0) {
    io.stdout("Projects: none registered\n");
    return;
  }
  for (const project of registry.projects) {
    try {
      const checked = await getProject(project.id);
      io.stdout(
        `Project ${project.id}: available; Git ${(await isGitRepository(checked)) ? "repository" : "not a repository"}\n`,
      );
    } catch (error) {
      const message =
        error instanceof ContextBridgeError ? error.message : "unavailable";
      io.stdout(`Project ${project.id}: ${message}\n`);
    }
  }
}

async function commandMcp(args: string[]): Promise<void> {
  let mode: "stdio" | "http" | undefined;
  let port = 7331;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--stdio") {
      if (mode)
        throw new ContextBridgeError("usage", "Choose one MCP transport.");
      mode = "stdio";
    } else if (argument === "--http") {
      if (mode)
        throw new ContextBridgeError("usage", "Choose one MCP transport.");
      mode = "http";
    } else if (argument === "--port") {
      if (mode === "stdio")
        throw new ContextBridgeError("usage", "--port applies only to --http.");
      const value = args[index + 1];
      if (!value || !/^\d+$/.test(value))
        throw new ContextBridgeError(
          "invalid_port",
          "--port requires a number between 1 and 65535.",
        );
      port = Number(value);
      index += 1;
    } else {
      throw new ContextBridgeError(
        "usage",
        `Unknown MCP option "${argument}".`,
      );
    }
  }
  if (mode === "stdio") {
    await startStdioServer();
    return;
  }
  if (mode === "http") {
    await startHttpServer(port);
    return;
  }
  throw new ContextBridgeError(
    "usage",
    "Choose an MCP transport: --stdio or --http.",
  );
}

export async function runCli(
  argv: string[],
  io: CliIO = defaultIO(),
): Promise<number> {
  const args = [...argv];
  try {
    const first = args[0];
    if (!first || first === "--help" || first === "-h") {
      io.stdout(HELP);
      return 0;
    }
    if (first === "--version" || first === "-v") {
      io.stdout(`${VERSION}\n`);
      return 0;
    }
    if (first === "init") {
      if (args.length > 1)
        throw new ContextBridgeError("usage", "init takes no arguments.");
      await commandInit(io);
      return 0;
    }
    if (first === "project") {
      await commandProject(args.slice(1), io);
      return 0;
    }
    if (first === "doctor") {
      if (args.length > 1)
        throw new ContextBridgeError("usage", "doctor takes no arguments.");
      await commandDoctor(io);
      return 0;
    }
    if (first === "mcp") {
      await commandMcp(args.slice(1));
      return 0;
    }
    throw new ContextBridgeError(
      "usage",
      `Unknown command "${first}". Use --help for usage.`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    io.stderr(`ctxbridge: ${message}\n`);
    return 1;
  }
}
