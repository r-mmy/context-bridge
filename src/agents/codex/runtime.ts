import { realpath, stat, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { AgentAdapterError } from "../errors.js";

export const PINNED_CODEX_VERSION = "0.157.1";

export interface CodexRuntime {
  executable: string;
  argsPrefix: string[];
  version: string;
  source: "managed";
}

const require = createRequire(import.meta.url);
const CODEX_PACKAGE = "@openai/codex";
const VERSION_PATTERN =
  /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

function isWithin(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return (
    relative.length > 0 &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function launcherPath(bin: unknown): string | undefined {
  const candidate =
    typeof bin === "string"
      ? bin
      : bin !== null && typeof bin === "object" && !Array.isArray(bin)
        ? (bin as Record<string, unknown>).codex
        : undefined;
  if (
    typeof candidate !== "string" ||
    candidate.length === 0 ||
    path.isAbsolute(candidate) ||
    candidate.includes("\0")
  ) {
    return undefined;
  }
  return candidate;
}

export async function resolveCodexRuntime(): Promise<CodexRuntime> {
  try {
    const packageJsonPath = await realpath(
      require.resolve(`${CODEX_PACKAGE}/package.json`),
    );
    const packageRoot = path.dirname(packageJsonPath);
    const manifest = JSON.parse(await readFile(packageJsonPath, "utf8")) as {
      name?: unknown;
      version?: unknown;
      bin?: unknown;
    };
    if (
      manifest.name !== CODEX_PACKAGE ||
      manifest.version !== PINNED_CODEX_VERSION ||
      typeof manifest.version !== "string" ||
      !VERSION_PATTERN.test(manifest.version)
    ) {
      throw new Error("The managed Codex package metadata is incompatible.");
    }
    const declaredLauncher = launcherPath(manifest.bin);
    if (!declaredLauncher) {
      throw new Error("The managed Codex package has no declared CLI bin.");
    }
    const candidate = path.resolve(packageRoot, declaredLauncher);
    if (!isWithin(packageRoot, candidate)) {
      throw new Error("The managed Codex CLI bin is outside its package.");
    }
    const entryPoint = await realpath(candidate);
    const packageRealPath = await realpath(packageRoot);
    if (!isWithin(packageRealPath, entryPoint) || !entryPoint.endsWith(".js")) {
      throw new Error("The managed Codex CLI bin is invalid.");
    }
    if (!(await stat(entryPoint)).isFile()) {
      throw new Error("The managed Codex CLI bin is not a file.");
    }

    return {
      executable: process.execPath,
      argsPrefix: [entryPoint],
      version: manifest.version,
      source: "managed",
    };
  } catch {
    throw new AgentAdapterError("codex_runtime_unavailable");
  }
}
