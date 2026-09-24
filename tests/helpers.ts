import { execFileSync } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ProjectRecord } from "../src/projects/registry.js";

export async function makeTempDirectory(
  prefix = "ctxbridge-test-",
): Promise<string> {
  return await mkdtemp(path.join(os.tmpdir(), prefix));
}

export async function projectAt(
  root: string,
  id = "test-project",
): Promise<ProjectRecord> {
  let canonicalRoot: string;
  try {
    canonicalRoot = await realpath(root);
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !("code" in error) ||
      (error.code !== "ENOENT" && error.code !== "ENOTDIR")
    )
      throw error;
    canonicalRoot = path.resolve(root);
  }
  return {
    id,
    name: path.basename(canonicalRoot),
    root: canonicalRoot,
    addedAt: new Date(0).toISOString(),
  };
}

export function git(root: string, args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    windowsHide: true,
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
      GIT_AUTHOR_NAME: "Context Bridge Tests",
      GIT_AUTHOR_EMAIL: "ctxbridge-tests@example.invalid",
      GIT_COMMITTER_NAME: "Context Bridge Tests",
      GIT_COMMITTER_EMAIL: "ctxbridge-tests@example.invalid",
    },
  });
}

export async function removeTree(root: string): Promise<void> {
  await rm(root, { recursive: true, force: true });
}
