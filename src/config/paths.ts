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

export function getAgentPolicyPath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return path.join(getConfigDirectory(env), "agent-policy.json");
}

export function getTasksDirectory(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return path.join(getConfigDirectory(env), "tasks");
}

export function getTaskPath(
  taskId: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      taskId,
    )
  ) {
    throw new TypeError("A valid task UUID is required.");
  }
  return path.join(getTasksDirectory(env), `${taskId.toLowerCase()}.json`);
}
