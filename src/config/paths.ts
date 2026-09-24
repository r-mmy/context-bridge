import os from "node:os";
import path from "node:path";

export function getConfigDirectory(
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (process.platform === "win32") {
    return path.join(
      env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"),
      "ctxbridge",
    );
  }
  if (process.platform === "darwin") {
    return path.join(
      os.homedir(),
      "Library",
      "Application Support",
      "ctxbridge",
    );
  }
  return path.join(
    env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"),
    "ctxbridge",
  );
}

export function getRegistryPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(getConfigDirectory(env), "projects.json");
}
