import { createHash } from "node:crypto";
import path from "node:path";
import { getConfigDirectory } from "../config/paths.js";

export function getAgentLockDirectory(): string {
  return path.join(getConfigDirectory(), "agent-locks");
}

export function getConfigMutationLockPath(): string {
  return path.join(getAgentLockDirectory(), "config-mutation.lock");
}

export function getProjectWriterLockPath(canonicalRoot: string): string {
  const normalizedRoot = path.resolve(canonicalRoot);
  const identity =
    process.platform === "win32"
      ? normalizedRoot.toLocaleLowerCase("en-US")
      : normalizedRoot;
  const fingerprint = createHash("sha256")
    .update(identity, "utf8")
    .digest("hex");
  return path.join(getAgentLockDirectory(), `project-${fingerprint}.lock`);
}
