import { spawn } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { getTaskPath } from "../src/config/paths.js";
import { getProject, addProject } from "../src/projects/registry.js";
import { readTextFile } from "../src/filesystem/read.js";
import { getGitStatus } from "../src/git/service.js";
import { TaskRuntime } from "../src/tasks/runtime.js";
import { TaskStore } from "../src/tasks/store.js";
import { git } from "./helpers.js";

interface ChildEvent {
  event: string;
  code?: string;
  task_id?: string;
  read_only_ok?: boolean;
  git_ok?: boolean;
}

interface TestChild {
  waitFor(event: string, timeoutMs?: number): Promise<ChildEvent>;
  release(): void;
  waitForExit(): Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>;
  kill(): Promise<void>;
}

interface RuntimeHarness {
  root: string;
  projectRoot: string;
  project: Awaited<ReturnType<typeof addProject>>;
  runtime: TaskRuntime;
  store: TaskStore;
}

const fixturePath = fileURLToPath(
  new URL("./fixtures/task-runtime-child.mjs", import.meta.url),
);
const repositoryRoot = path.resolve(path.dirname(fixturePath), "../..");
const children: TestChild[] = [];
const runtimes: TaskRuntime[] = [];
const temporaryRoots: string[] = [];
const oldAppData = process.env.APPDATA;
const oldXdg = process.env.XDG_CONFIG_HOME;
const oldHome = process.env.HOME;

function startChild(...args: string[]): TestChild {
  const childProcess = spawn(
    process.execPath,
    ["--import", "tsx", fixturePath, ...args],
    {
      cwd: repositoryRoot,
      stdio: ["pipe", "pipe", "ignore"],
      windowsHide: true,
    },
  );
  let pendingText = "";
  const events: ChildEvent[] = [];
  const waiters = new Map<string, Array<(event: ChildEvent) => void>>();
  let exited = false;
  const exitPromise = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve) => {
    childProcess.once("exit", (code, signal) => {
      exited = true;
      resolve({ code, signal });
    });
  });

  childProcess.stdout?.on("data", (chunk: Buffer) => {
    pendingText += chunk.toString("utf8");
    while (pendingText.includes("\n")) {
      const newline = pendingText.indexOf("\n");
      const line = pendingText.slice(0, newline);
      pendingText = pendingText.slice(newline + 1);
      const event = JSON.parse(line) as ChildEvent;
      const listeners = waiters.get(event.event);
      if (listeners?.length) listeners.shift()?.(event);
      else events.push(event);
    }
  });

  const child: TestChild = {
    waitFor(eventName, timeoutMs = 10_000) {
      const index = events.findIndex((event) => event.event === eventName);
      if (index >= 0) return Promise.resolve(events.splice(index, 1)[0]!);
      return new Promise((resolve, reject) => {
        const listener = (event: ChildEvent): void => {
          clearTimeout(timer);
          resolve(event);
        };
        const listeners = waiters.get(eventName) ?? [];
        listeners.push(listener);
        waiters.set(eventName, listeners);
        const timer = setTimeout(() => {
          const current = waiters.get(eventName) ?? [];
          const listenerIndex = current.indexOf(listener);
          if (listenerIndex >= 0) current.splice(listenerIndex, 1);
          const failure = events.find(
            (event) => event.event === "failed" || event.event === "rejected",
          );
          reject(
            new Error(
              `Timed out waiting for child event ${eventName}.${failure ? ` Child reported ${failure.event}:${failure.code ?? "unknown"}.` : ""}`,
            ),
          );
        }, timeoutMs);
        if (exited) {
          clearTimeout(timer);
          reject(new Error(`Child exited before event ${eventName}.`));
        }
      });
    },
    release() {
      if (!exited) childProcess.stdin?.write("release\n");
    },
    waitForExit: () => exitPromise,
    async kill() {
      if (!exited) childProcess.kill("SIGKILL");
      await exitPromise;
    },
  };
  children.push(child);
  return child;
}

async function createHarness(): Promise<RuntimeHarness> {
  const root = await mkdtemp(path.join(os.tmpdir(), "ctxbridge-runtime-test-"));
  temporaryRoots.push(root);
  process.env.APPDATA = path.join(root, "appdata");
  process.env.XDG_CONFIG_HOME = path.join(root, "xdg");
  process.env.HOME = root;
  const projectRoot = path.join(root, "registered-project");
  await mkdir(projectRoot, { recursive: true });
  git(projectRoot, ["init", "--quiet"]);
  await writeFile(path.join(projectRoot, "safe.txt"), "read safe", "utf8");
  const project = await addProject(projectRoot);
  const store = new TaskStore();
  const runtime = await TaskRuntime.start({ store });
  runtimes.push(runtime);
  return { root, projectRoot, project, runtime, store };
}

afterEach(async () => {
  await Promise.all(children.splice(0).map((child) => child.kill()));
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
  if (oldAppData === undefined) delete process.env.APPDATA;
  else process.env.APPDATA = oldAppData;
  if (oldXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = oldXdg;
  if (oldHome === undefined) delete process.env.HOME;
  else process.env.HOME = oldHome;
});

describe.sequential("task runtime ownership and recovery", () => {
  it("allows one local owner while read-only registry, filesystem, and Git remain usable", async () => {
    const harness = await createHarness();
    await expect(TaskRuntime.start()).rejects.toMatchObject({
      code: "agent_runtime_busy",
    });
    await expect(getProject(harness.project.id)).resolves.toMatchObject({
      id: harness.project.id,
    });
    await expect(
      readTextFile(harness.project, "safe.txt"),
    ).resolves.toMatchObject({
      text: "read safe",
    });
    await expect(getGitStatus(harness.project)).resolves.toMatchObject({
      branch: expect.any(String),
    });

    await harness.runtime.close();
    const next = await TaskRuntime.start({ store: harness.store });
    runtimes.push(next);
    expect(next.isClosed).toBe(false);
  });

  it("denies a second process with a sanitized busy error but keeps its read-only path available", async () => {
    const harness = await createHarness();
    await harness.runtime.close();
    const holder = startChild("hold");
    expect((await holder.waitFor("acquired")).event).toBe("acquired");

    const contender = startChild("try", harness.project.id);
    const rejected = await contender.waitFor("rejected");
    expect(rejected).toEqual({
      event: "rejected",
      code: "agent_runtime_busy",
      read_only_ok: true,
    });
    expect((await contender.waitForExit()).code).toBe(1);

    holder.release();
    expect((await holder.waitFor("released")).event).toBe("released");
    expect((await holder.waitForExit()).code).toBe(0);
    const next = startChild("try", harness.project.id);
    const acquired = await next.waitFor("acquired");
    expect(acquired).toEqual({
      event: "acquired",
      read_only_ok: true,
      git_ok: true,
    });
    expect((await next.waitForExit()).code).toBe(0);
  });

  it("recovers queued, running, and waiting tasks exactly once while preserving terminal history", async () => {
    const harness = await createHarness();
    const manager = harness.runtime.manager;
    const registrationId = harness.project.registrationId;
    if (!registrationId) throw new Error("Registered project has no identity.");
    const makeTask = (suffix: string) =>
      manager.createTaskIntent({
        project_id: harness.project.id,
        display_name: harness.project.name,
        registration_id: registrationId,
        registration_added_at: harness.project.addedAt,
        prompt: `synthetic ${suffix}`,
        profile: "luna-max",
        model_id: "gpt-6-luna",
        request_id: `recover-${suffix}`,
      });

    const queued = await makeTask("queued");
    const running = await makeTask("running");
    await manager.transitionTurn(running.task_id, 1, "running");
    await manager.setPrivateThreadId(
      running.task_id,
      "private-thread-recovery",
    );
    const waiting = await makeTask("waiting");
    await manager.transitionTurn(waiting.task_id, 1, "running");
    await manager.transitionTurn(waiting.task_id, 1, "waiting_for_input");

    const terminal: Array<{
      taskId: string;
      state: "completed" | "failed" | "cancelled" | "interrupted";
      localActionRequired?: boolean;
    }> = [];
    for (const state of [
      "completed",
      "failed",
      "cancelled",
      "interrupted",
    ] as const) {
      const allocation = await makeTask(`terminal-${state}`);
      await manager.transitionTurn(allocation.task_id, 1, "running");
      await manager.transitionTurn(allocation.task_id, 1, state);
      terminal.push({ taskId: allocation.task_id, state });
    }
    const localOnly = await makeTask("secret-local-action");
    await manager.transitionTurn(localOnly.task_id, 1, "interrupted");
    const localOnlyRecord = await manager.getTask(localOnly.task_id);
    localOnlyRecord.local_action_required = true;
    localOnlyRecord.safe_error = {
      code: "secret_input_requires_local_action",
    };
    localOnlyRecord.turns[0]!.safe_error = {
      code: "secret_input_requires_local_action",
    };
    await harness.store.replace(localOnlyRecord);
    terminal.push({
      taskId: localOnly.task_id,
      state: "interrupted",
      localActionRequired: true,
    });
    await expect(
      manager.appendTurnIntent({
        task_id: localOnly.task_id,
        prompt: "try forbidden continuation",
      }),
    ).rejects.toMatchObject({ code: "task_state_conflict" });
    const before = new Map(
      (await manager.listTasks()).map((record) => [record.task_id, record]),
    );
    await harness.runtime.close();

    const restarted = await TaskRuntime.start({ store: harness.store });
    runtimes.push(restarted);
    const recoveredIds = [queued.task_id, running.task_id, waiting.task_id];
    for (const taskId of recoveredIds) {
      const recovered = await restarted.manager.getTask(taskId);
      expect(recovered.state).toBe("interrupted");
      expect(recovered.turns.at(-1)?.completed_at).toBeTruthy();
      expect(recovered.pending_input).toBeNull();
      expect(recovered.local_action_required).toBe(false);
      expect(
        recovered.events.filter((event) => event.kind === "recovered"),
      ).toHaveLength(1);
      expect(recovered.turn_count).toBe(before.get(taskId)?.turn_count);
    }
    const preservedThread = await restarted.manager.getTask(running.task_id);
    expect(preservedThread.private_thread_id).toBe("private-thread-recovery");
    expect(preservedThread.idempotency[0]?.request_id_hash).toBeDefined();
    for (const item of terminal) {
      const record = await restarted.manager.getTask(item.taskId);
      expect(record.state).toBe(item.state);
      expect(record.local_action_required).toBe(
        item.localActionRequired ?? false,
      );
      expect(
        record.events.filter((event) => event.kind === "recovered"),
      ).toHaveLength(0);
    }

    await restarted.close();
    const secondRestart = await TaskRuntime.start({ store: harness.store });
    runtimes.push(secondRestart);
    for (const taskId of recoveredIds) {
      expect(
        (await secondRestart.manager.getTask(taskId)).events.filter(
          (event) => event.kind === "recovered",
        ),
      ).toHaveLength(1);
    }
  });

  it("reacquires after forced owner death and recovers its synthetic active task", async () => {
    const harness = await createHarness();
    const entriesBefore = await readdir(harness.projectRoot);
    const registrationId = harness.project.registrationId;
    if (!registrationId) throw new Error("Registered project has no identity.");
    await harness.runtime.close();
    const holder = startChild(
      "hold-active-task",
      harness.project.id,
      harness.project.name,
      registrationId,
      harness.project.addedAt,
    );
    const ready = await holder.waitFor("task_ready");
    expect(ready.task_id).toMatch(/^[0-9a-f-]{36}$/);
    await holder.kill();

    const recovered = await TaskRuntime.start({ store: harness.store });
    runtimes.push(recovered);
    const task = await recovered.manager.getTask(ready.task_id!);
    expect(task.state).toBe("interrupted");
    expect(task.project_id).toBe(harness.project.id);
    expect(task.private_thread_id).toBe("private-thread-fixture");
    expect(
      task.events.filter((event) => event.kind === "recovered"),
    ).toHaveLength(1);
    const persisted = await readFile(getTaskPath(ready.task_id!), "utf8");
    expect(persisted).toContain('"private_thread_id":"private-thread-fixture"');
    expect(persisted).not.toContain(harness.projectRoot);
    expect(persisted).not.toContain("root_fingerprint");
    expect(persisted).not.toContain("synthetic-runtime-request");
    expect(persisted).not.toContain(
      `synthetic crash recovery fixture ${"p".repeat(600)}`,
    );
    await recovered.close();

    const second = await TaskRuntime.start({ store: harness.store });
    runtimes.push(second);
    expect(
      (await second.manager.getTask(ready.task_id!)).events.filter(
        (event) => event.kind === "recovered",
      ),
    ).toHaveLength(1);
    expect(await readdir(harness.projectRoot)).toEqual(entriesBefore);
    expect(
      await readFile(path.join(harness.projectRoot, "safe.txt"), "utf8"),
    ).toBe("read safe");
  });
});
