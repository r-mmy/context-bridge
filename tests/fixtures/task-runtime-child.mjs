import { createInterface } from "node:readline";
import process from "node:process";
import { readTextFile } from "../../src/filesystem/read.ts";
import { getGitStatus } from "../../src/git/service.ts";
import { getProject } from "../../src/projects/registry.ts";
import { TaskRuntime } from "../../src/tasks/runtime.ts";

const [mode, ...args] = process.argv.slice(2);

function send(event, fields = {}) {
  process.stdout.write(`${JSON.stringify({ event, ...fields })}\n`);
}

function waitForRelease() {
  const input = createInterface({ input: process.stdin });
  return new Promise((resolve) => {
    input.once("line", () => {
      input.close();
      process.stdin.pause();
      process.stdin.destroy();
      resolve();
    });
  });
}

let runtime;
try {
  if (mode === "try") {
    const projects = await getProject(args[0]);
    const file = await readTextFile(projects, "safe.txt", { maxBytes: 100 });
    const gitStatus = await getGitStatus(projects);
    try {
      runtime = await TaskRuntime.start();
      send("acquired", {
        read_only_ok: file.text === "read safe",
        git_ok: gitStatus.branch !== null,
      });
      await runtime.close();
    } catch (error) {
      send("rejected", {
        code:
          error && typeof error === "object" && "code" in error
            ? error.code
            : "unknown",
        read_only_ok: file.text === "read safe" && gitStatus.branch !== null,
      });
      process.exitCode = 1;
    }
  } else if (mode === "hold") {
    runtime = await TaskRuntime.start();
    send("acquired");
    await waitForRelease();
    await runtime.close();
    send("released");
  } else if (mode === "hold-active-task") {
    const [projectId, displayName, registrationId, registrationAddedAt] = args;
    if (!projectId || !displayName || !registrationId || !registrationAddedAt) {
      throw new Error("registered project identity is required");
    }
    runtime = await TaskRuntime.start();
    const manager = runtime.manager;
    const syntheticPrompt = `synthetic crash recovery fixture ${"p".repeat(600)}`;
    const allocation = await manager.createTaskIntent({
      project_id: projectId,
      display_name: displayName,
      registration_id: registrationId,
      registration_added_at: registrationAddedAt,
      prompt: syntheticPrompt,
      profile: "luna-max",
      model_id: "gpt-6-luna",
      request_id: "synthetic-runtime-request",
    });
    await manager.transitionTurn(allocation.task_id, 1, "running");
    await manager.setPrivateThreadId(
      allocation.task_id,
      "private-thread-fixture",
    );
    send("task_ready", { task_id: allocation.task_id });
    await waitForRelease();
    await runtime.close();
    send("released");
  } else {
    throw new Error("unsupported test fixture mode");
  }
} catch (error) {
  send("failed", {
    code:
      error && typeof error === "object" && "code" in error
        ? error.code
        : "unknown",
  });
  process.exitCode = 1;
} finally {
  if (runtime && !runtime.isClosed)
    await runtime.close().catch(() => undefined);
}
