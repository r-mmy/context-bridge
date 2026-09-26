import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { AgentExecutionService } from "../../src/agents/execution.js";
import { CodexAgentAdapter } from "../../src/agents/codex/adapter.js";
import { tryAcquireProjectWriterLock } from "../../src/locks/file-lock.js";
import {
  disableProjectAuthorization,
  enableProjectAuthorization,
} from "../../src/agents/policy.js";
import { getTaskPath } from "../../src/config/paths.js";
import { ContextBridgeError } from "../../src/security/errors.js";
import { TaskRuntime } from "../../src/tasks/runtime.js";
import type { GitBaseline, TaskRecord } from "../../src/tasks/types.js";
import {
  addProject,
  removeProject,
  type ProjectRecord,
} from "../../src/projects/registry.js";

const fixturePath = fileURLToPath(
  new URL("../fixtures/fake-app-server.mjs", import.meta.url),
);
const cleanups: Array<() => Promise<void>> = [];

interface Harness {
  root: string;
  tracePath: string;
  projects: ProjectRecord[];
  runtime: TaskRuntime;
  service: AgentExecutionService;
}

interface HarnessOptions {
  baselineCapture?: (project: ProjectRecord) => Promise<GitBaseline>;
  startupMutationProjectName?: string;
}

async function createHarness(
  mode: string,
  options: HarnessOptions = {},
): Promise<Harness> {
  const root = await mkdtemp(path.join(os.tmpdir(), "ctxbridge-execution-"));
  const prior = {
    appdata: process.env.APPDATA,
    xdg: process.env.XDG_CONFIG_HOME,
    home: process.env.HOME,
  };
  if (process.platform === "win32")
    process.env.APPDATA = path.join(root, "config");
  else if (process.platform === "darwin")
    process.env.HOME = path.join(root, "home");
  else process.env.XDG_CONFIG_HOME = path.join(root, "config");
  const runtime = await TaskRuntime.start();
  const tracePath = path.join(root, "app-server-trace.jsonl");
  const children: ChildProcessWithoutNullStreams[] = [];
  const fakeEnvironment: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? "",
    SYSTEMROOT: process.env.SYSTEMROOT ?? "C:\\Windows",
    TEMP: process.env.TEMP ?? os.tmpdir(),
    TMP: process.env.TMP ?? os.tmpdir(),
    HOME: path.join(root, "fake-home"),
    TMPDIR: os.tmpdir(),
    CODEX_HOME: path.join(root, "fake-codex-home"),
  };
  const adapter = new CodexAgentAdapter({
    environment: fakeEnvironment,
    homeDirectory: path.join(root, "fake-home"),
    spawnProcess: (_executable, _args, spawnOptions) => {
      const child = spawn(
        process.execPath,
        [
          fixturePath,
          mode,
          tracePath,
          options.startupMutationProjectName
            ? path.join(root, options.startupMutationProjectName)
            : "",
        ],
        {
          shell: false,
          stdio: ["pipe", "pipe", "pipe"],
          env: spawnOptions.env,
          windowsHide: true,
        },
      ) as ChildProcessWithoutNullStreams;
      children.push(child);
      return child;
    },
  });
  const service = new AgentExecutionService(
    runtime,
    adapter,
    options.baselineCapture,
  );
  const projects: ProjectRecord[] = [];
  cleanups.push(async () => {
    await service.close().catch(() => undefined);
    await runtime.close().catch(() => undefined);
    for (const project of projects) {
      await removeProject(project.id).catch(() => undefined);
    }
    for (const child of children) {
      if (child.exitCode === null) child.kill();
    }
    if (prior.appdata === undefined) delete process.env.APPDATA;
    else process.env.APPDATA = prior.appdata;
    if (prior.xdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prior.xdg;
    if (prior.home === undefined) delete process.env.HOME;
    else process.env.HOME = prior.home;
    await rm(root, { recursive: true, force: true });
  });
  return { root, tracePath, projects, runtime, service };
}

async function registerGitProject(
  harness: Harness,
  name: string,
): Promise<ProjectRecord> {
  const root = path.join(harness.root, name);
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, "value.txt"), "alpha\n", "utf8");
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", root, ...args], { stdio: "ignore" });
  execFileSync("git", ["init", root], { stdio: "ignore" });
  git("config", "user.name", "Context Bridge Test");
  git("config", "user.email", "context-bridge-test@example.invalid");
  git("add", "value.txt");
  git("commit", "-m", "fixture baseline");
  const project = await addProject(root);
  await enableProjectAuthorization(project);
  harness.projects.push(project);
  return project;
}

async function waitForTerminal(
  runtime: TaskRuntime,
  taskId: string,
): Promise<TaskRecord> {
  let record = await runtime.manager.getTask(taskId);
  const deadline = Date.now() + 10_000;
  while (
    !["completed", "failed", "cancelled", "interrupted"].includes(record.state)
  ) {
    if (Date.now() > deadline)
      throw new Error("test task did not become terminal");
    record = await runtime.manager.waitForTask(taskId, record.event_seq, 1_000);
  }
  return record;
}

async function waitForExecutionIdle(
  service: AgentExecutionService,
): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (service.activeCount > 0) {
    if (Date.now() > deadline)
      throw new Error("execution service did not idle");
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

async function getOnlyStoredTask(harness: Harness): Promise<TaskRecord> {
  const tasks = await harness.runtime.manager.listTasks();
  expect(tasks).toHaveLength(1);
  const taskId = tasks[0]?.task_id;
  if (!taskId) throw new Error("expected the allocated task to be stored");
  return harness.runtime.manager.getTask(taskId);
}

async function expectWriterReleased(
  harness: Harness,
  project: ProjectRecord,
): Promise<void> {
  expect(harness.service.activeCount).toBe(0);
  const lock = await tryAcquireProjectWriterLock(project.root);
  expect(lock).not.toBeNull();
  await lock?.release();
}

async function expectPreAcceptanceFailure(
  harness: Harness,
  project: ProjectRecord,
  input: { project_id: string; prompt: string; request_id?: string },
  errorCode: string,
  state: "failed" | "interrupted" = "failed",
): Promise<TaskRecord> {
  await expect(harness.service.startTask(input)).rejects.toMatchObject({
    code: errorCode,
  });
  const record = await getOnlyStoredTask(harness);
  expect(record.state).toBe(state);
  await expectWriterReleased(harness, project);
  return record;
}

async function traceMethods(harness: Harness): Promise<string[]> {
  const raw = await readFile(harness.tracePath, "utf8");
  return raw
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { method?: unknown })
    .filter(
      (entry): entry is { method: string } => typeof entry.method === "string",
    )
    .map((entry) => entry.method);
}

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("internal controlled Codex execution", () => {
  it("persists a path-free Git baseline and only a bounded final answer", async () => {
    const harness = await createHarness("normal");
    const project = await registerGitProject(harness, "normal-project");
    const originalPrompt = "Change the example value.";
    const allocation = await harness.service.startTask({
      project_id: project.id,
      prompt: originalPrompt,
    });
    const record = await waitForTerminal(harness.runtime, allocation.task_id);
    expect(record.state).toBe("completed");
    expect(record.private_thread_id).toMatch(/^fake-thread-/);
    expect(record.turns[0]?.git_baseline).toMatchObject({
      staged: 0,
      modified: 0,
      deleted: 0,
      untracked: 0,
      truncated: false,
    });
    expect(record.turns[0]?.git_baseline).not.toHaveProperty("paths");
    expect(record.final_response?.text).toBe(
      "Changed value.txt from alpha to beta.",
    );
    const view = await harness.runtime.manager.getTaskView(allocation.task_id);
    expect(view).not.toHaveProperty("private_thread_id");

    const trace = await readFile(harness.tracePath, "utf8");
    const entries = trace
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const security = entries.find(
      (entry) => entry.kind === "execution-security-check",
    );
    const turnStart = entries.find((entry) => entry.method === "turn/start");
    const threadSecurity = entries.find(
      (entry) => entry.kind === "thread-security-check",
    );
    const turnStartParams = turnStart?.params as {
      input?: Array<{ type?: string; text?: string }>;
    };
    const upstreamPrompt = turnStartParams.input?.[0]?.text ?? "";
    const originalTask = upstreamPrompt.match(
      /----- BEGIN ORIGINAL TASK ([0-9a-f-]{36}) -----\n([\s\S]*?)\n----- END ORIGINAL TASK \1 -----/,
    );
    expect(upstreamPrompt).toContain(
      "Preserve existing work, including unrelated uncommitted changes; do not revert them.",
    );
    expect(upstreamPrompt).toContain(
      "Do not stage, commit, push, reset, clean, checkout, switch branches, or change Git history.",
    );
    expect(upstreamPrompt).toContain(
      "Network access is disabled. Use only the provided project workspace.",
    );
    expect(originalTask?.[2]).toBe(originalPrompt);
    expect(record.turns[0]?.prompt_preview).toBe(originalPrompt);
    expect(record.turns[0]?.prompt_sha256).toBe(
      createHash("sha256").update(originalPrompt, "utf8").digest("hex"),
    );
    const persisted = await readFile(getTaskPath(allocation.task_id), "utf8");
    expect(persisted).not.toContain("Context Bridge task execution rules");
    expect(persisted).not.toContain("END ORIGINAL TASK");
    expect(persisted).not.toContain("not captured");
    expect(threadSecurity).toMatchObject({
      oneRuntimeRoot: true,
      cwdMatchesRoot: true,
      approvalNever: true,
      workspaceWrite: true,
      noProviderFallback: true,
      noConfigOverride: true,
      noAdditionalWritableRoots: true,
      model: "gpt-6-luna",
    });
    expect(security).toMatchObject({
      oneRuntimeRoot: true,
      cwdMatchesRoot: true,
      oneWritableRoot: true,
      writableRootMatches: true,
      approvalNever: true,
      networkDisabled: true,
      excludesTemp: true,
      excludesSlashTmp: true,
      defaultMode: true,
      oneTextInput: true,
      model: "gpt-6-luna",
      effort: "max",
    });
  });

  it("captures filtered dirty counts and a null HEAD for an unborn repository", async () => {
    const harness = await createHarness("normal");
    const project = await registerGitProject(harness, "dirty-baseline-project");
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", project.root, ...args], { stdio: "ignore" });
    await writeFile(path.join(project.root, "deleted.txt"), "tracked\n");
    git("add", "deleted.txt");
    git("commit", "-m", "add deletion fixture");
    await writeFile(path.join(project.root, "staged.txt"), "staged\n");
    git("add", "staged.txt");
    await writeFile(path.join(project.root, "value.txt"), "modified\n");
    await rm(path.join(project.root, "deleted.txt"));
    await writeFile(path.join(project.root, "untracked.txt"), "loose\n");
    await writeFile(path.join(project.root, ".env"), "private=filtered\n");

    const dirtyAllocation = await harness.service.startTask({
      project_id: project.id,
      prompt: "Capture the dirty baseline.",
    });
    const dirtyRecord = await waitForTerminal(
      harness.runtime,
      dirtyAllocation.task_id,
    );
    expect(dirtyRecord.turns[0]?.git_baseline).toMatchObject({
      staged: 1,
      modified: 1,
      deleted: 1,
      untracked: 1,
      truncated: false,
    });
    expect(dirtyRecord.turns[0]?.git_baseline?.head).toMatch(
      /^[0-9a-f]{40,64}$/,
    );
    const dirtyJson = JSON.stringify(dirtyRecord);
    for (const pathName of [
      "staged.txt",
      "deleted.txt",
      "untracked.txt",
      ".env",
      "private=filtered",
    ]) {
      expect(dirtyJson).not.toContain(pathName);
    }

    const unbornRoot = path.join(harness.root, "unborn-baseline-project");
    await mkdir(unbornRoot);
    await writeFile(path.join(unbornRoot, "new.txt"), "unborn\n");
    execFileSync("git", ["init", unbornRoot], { stdio: "ignore" });
    const unbornProject = await addProject(unbornRoot);
    await enableProjectAuthorization(unbornProject);
    harness.projects.push(unbornProject);
    const unbornAllocation = await harness.service.startTask({
      project_id: unbornProject.id,
      prompt: "Capture an unborn repository baseline.",
    });
    const unbornRecord = await waitForTerminal(
      harness.runtime,
      unbornAllocation.task_id,
    );
    expect(unbornRecord.state).toBe("completed");
    expect(unbornRecord.turns[0]?.git_baseline).toMatchObject({
      head: null,
      untracked: 1,
      truncated: false,
    });
  });

  it("persists the Git baseline before fake App Server initialization mutates the project", async () => {
    const harness = await createHarness("startup-artifact", {
      startupMutationProjectName: "baseline-order-project",
    });
    const project = await registerGitProject(harness, "baseline-order-project");
    const allocation = await harness.service.startTask({
      project_id: project.id,
      prompt: "Capture the clean state before App Server setup.",
    });
    const record = await waitForTerminal(harness.runtime, allocation.task_id);
    expect(record.state).toBe("completed");
    expect(record.turns[0]?.git_baseline).toMatchObject({
      staged: 0,
      modified: 0,
      deleted: 0,
      untracked: 0,
      truncated: false,
    });
    await expect(
      readFile(path.join(project.root, "synthetic-artifact.txt"), "utf8"),
    ).resolves.toBe("created by the fake App Server\n");
  });

  it("fails and releases the durable allocation when Git baseline capture fails", async () => {
    const harness = await createHarness("normal", {
      baselineCapture: async () => {
        throw new ContextBridgeError(
          "git_error",
          "The project Git baseline is unavailable.",
        );
      },
    });
    const project = await registerGitProject(harness, "baseline-error-project");
    const record = await expectPreAcceptanceFailure(
      harness,
      project,
      { project_id: project.id, prompt: "This cannot start." },
      "git_error",
    );
    expect(record.turns[0]?.git_baseline).toBeNull();
    await expect(readFile(harness.tracePath, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("fails closed if the effective thread roots differ from the registered root", async () => {
    const harness = await createHarness("wrong-thread-roots");
    const project = await registerGitProject(harness, "mismatched-project");
    const record = await expectPreAcceptanceFailure(
      harness,
      project,
      { project_id: project.id, prompt: "This turn must not start." },
      "app_server_incompatible",
    );
    expect(record.state).toBe("failed");
    expect(record.private_thread_id).toBeNull();
    const methods = await traceMethods(harness);
    expect(methods).toContain("thread/start");
    expect(methods).not.toContain("turn/start");
  });

  it("rejects an unauthenticated start while retaining one failed allocation and replaying by request ID", async () => {
    const harness = await createHarness("auth-absent");
    const project = await registerGitProject(harness, "auth-failure-project");
    const input = {
      project_id: project.id,
      prompt: "Do not execute without local authentication.",
      request_id: "auth-failure-replay-id",
    };
    const record = await expectPreAcceptanceFailure(
      harness,
      project,
      input,
      "codex_unauthenticated",
    );
    expect(record.turns[0]?.safe_error).toEqual({ code: "task_failed" });
    const beforeRetry = await traceMethods(harness);
    expect(beforeRetry).toContain("account/read");
    expect(beforeRetry).not.toContain("thread/start");
    const replay = await harness.service.startTask(input);
    expect(replay).toMatchObject({
      task_id: record.task_id,
      replayed: true,
    });
    expect(await traceMethods(harness)).toEqual(beforeRetry);
    await expectWriterReleased(harness, project);
  });

  it("rejects an unavailable configured model before thread or turn start", async () => {
    const harness = await createHarness("model-unavailable");
    const project = await registerGitProject(harness, "model-failure-project");
    await expectPreAcceptanceFailure(
      harness,
      project,
      { project_id: project.id, prompt: "Use the configured model." },
      "model_unavailable",
    );
    const methods = await traceMethods(harness);
    expect(methods).toContain("model/list");
    expect(methods).not.toContain("thread/start");
    expect(methods).not.toContain("turn/start");
  });

  it("rejects a known turn/start refusal without leaking protocol details or replaying the turn", async () => {
    const harness = await createHarness("turn-start-rejected");
    const project = await registerGitProject(harness, "turn-rejection-project");
    const input = {
      project_id: project.id,
      prompt: "The App Server will refuse this turn.",
      request_id: "turn-rejection-replay-id",
    };
    const start = harness.service.startTask(input);
    await expect(start).rejects.toMatchObject({
      code: "app_server_protocol_error",
    });
    const error = await start.catch((caught: unknown) => caught);
    expect(error).toMatchObject({ requestRejected: true });
    expect(String(error)).not.toContain("PRIVATE_TURN_START_ERROR");
    expect(String(error)).not.toContain("private\\path");
    const record = await getOnlyStoredTask(harness);
    expect(record.state).toBe("failed");
    expect(record.private_thread_id).toMatch(/^fake-thread-/);
    await expectWriterReleased(harness, project);
    const beforeRetry = await traceMethods(harness);
    expect(
      beforeRetry.filter((method) => method === "turn/start"),
    ).toHaveLength(1);
    const replay = await harness.service.startTask(input);
    expect(replay).toMatchObject({
      task_id: record.task_id,
      replayed: true,
    });
    expect(await traceMethods(harness)).toEqual(beforeRetry);
  });

  it("settles an uncertain lost turn/start response as interrupted and never replays it", async () => {
    const harness = await createHarness("turn-start-lost-response");
    const project = await registerGitProject(harness, "lost-start-project");
    const input = {
      project_id: project.id,
      prompt: "The turn start response will be lost.",
      request_id: "lost-start-replay-id",
    };
    const record = await expectPreAcceptanceFailure(
      harness,
      project,
      input,
      "app_server_exited",
      "interrupted",
    );
    const beforeRetry = await traceMethods(harness);
    expect(
      beforeRetry.filter((method) => method === "turn/start"),
    ).toHaveLength(1);
    const replay = await harness.service.startTask(input);
    expect(replay).toMatchObject({
      task_id: record.task_id,
      replayed: true,
    });
    expect(await traceMethods(harness)).toEqual(beforeRetry);
  });

  it("settles a terminal turn/start result without waiting for turn/completed", async () => {
    const harness = await createHarness("terminal-start-result");
    const project = await registerGitProject(harness, "terminal-start-project");
    const allocation = await harness.service.startTask({
      project_id: project.id,
      prompt: "Complete from the terminal turn/start response.",
    });
    const record = await waitForTerminal(harness.runtime, allocation.task_id);
    expect(record.state).toBe("completed");
    await waitForExecutionIdle(harness.service);
  });

  it("does not double-settle when a terminal turn/start result is followed by its notification", async () => {
    const harness = await createHarness(
      "terminal-start-result-with-notification",
    );
    const project = await registerGitProject(
      harness,
      "terminal-start-notification-project",
    );
    const allocation = await harness.service.startTask({
      project_id: project.id,
      prompt: "Complete once from both lifecycle signals.",
    });
    const record = await waitForTerminal(harness.runtime, allocation.task_id);
    expect(record.state).toBe("completed");
    expect(
      record.events.filter(
        (event) =>
          event.kind === "state_changed" && event.status === "completed",
      ),
    ).toHaveLength(1);
    await waitForExecutionIdle(harness.service);
  });

  it("rejects non-Git projects before allocating a task or starting App Server", async () => {
    const harness = await createHarness("normal");
    const root = path.join(harness.root, "plain-project");
    await mkdir(root);
    const project = await addProject(root);
    await enableProjectAuthorization(project);
    harness.projects.push(project);
    await expect(
      harness.service.startTask({
        project_id: project.id,
        prompt: "This must not execute.",
      }),
    ).rejects.toMatchObject({ code: "project_not_git" });
    expect(await harness.runtime.manager.listTasks()).toHaveLength(0);
    await expect(readFile(harness.tracePath, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("bounds the stored final response at 64 KiB without losing truncation status", async () => {
    const harness = await createHarness("huge-final");
    const project = await registerGitProject(harness, "bounded-final-project");
    const allocation = await harness.service.startTask({
      project_id: project.id,
      prompt: "Return a large final message.",
    });
    const record = await waitForTerminal(harness.runtime, allocation.task_id);
    expect(record.final_response?.truncated).toBe(true);
    expect(Buffer.byteLength(record.final_response?.text ?? "", "utf8")).toBe(
      64 * 1024,
    );
  });

  it("makes disable and removal lose to an active project writer, then disables before a later start", async () => {
    const harness = await createHarness("delayed-turn");
    const project = await registerGitProject(
      harness,
      "authorization-race-project",
    );
    const allocation = await harness.service.startTask({
      project_id: project.id,
      prompt: "Hold the project writer lease.",
    });
    expect(harness.service.activeCount).toBe(1);
    expect(
      (await harness.runtime.manager.getTask(allocation.task_id)).state,
    ).toBe("running");
    await expect(disableProjectAuthorization(project)).rejects.toMatchObject({
      code: "project_busy",
    });
    await expect(removeProject(project.id)).rejects.toMatchObject({
      code: "project_busy",
    });
    await harness.service.cancelTask(allocation.task_id);
    await expect(disableProjectAuthorization(project)).resolves.toBe(true);
    await expect(
      harness.service.startTask({
        project_id: project.id,
        prompt: "A disabled project cannot start.",
      }),
    ).rejects.toMatchObject({ code: "agent_disabled" });
    await expect(removeProject(project.id)).resolves.toMatchObject({
      id: project.id,
    });
    harness.projects.splice(harness.projects.indexOf(project), 1);
  });

  it("serializes request IDs before writer acquisition and rejects changed payloads", async () => {
    const harness = await createHarness("delayed-turn");
    const project = await registerGitProject(harness, "idempotent-project");
    const input = {
      project_id: project.id,
      prompt: "Repeat this exact task.",
      request_id: "request-idempotency-sample",
    };
    const first = await harness.service.startTask(input);
    const replay = await harness.service.startTask(input);
    expect(replay).toMatchObject({ task_id: first.task_id, replayed: true });
    await expect(
      harness.service.startTask({ ...input, prompt: "Changed task payload." }),
    ).rejects.toMatchObject({ code: "request_id_conflict" });
    await expect(
      harness.service.startTask({
        project_id: project.id,
        prompt: "Another task.",
      }),
    ).rejects.toMatchObject({ code: "project_busy" });
    const raw = await readFile(getTaskPath(first.task_id), "utf8");
    expect(raw).not.toContain(input.request_id);
    await harness.service.cancelTask(first.task_id);
  });

  it("uses a four-turn capacity and runs different project writers concurrently", async () => {
    const harness = await createHarness("delayed-turn");
    const projects = await Promise.all(
      ["one", "two", "three", "four", "five"].map((name) =>
        registerGitProject(harness, `capacity-${name}`),
      ),
    );
    const allocations = await Promise.all(
      projects.slice(0, 4).map((project) =>
        harness.service.startTask({
          project_id: project.id,
          prompt: "Hold this turn.",
        }),
      ),
    );
    expect(harness.service.activeCount).toBe(4);
    await expect(
      harness.service.startTask({
        project_id: projects[4]!.id,
        prompt: "The fifth turn is rejected.",
      }),
    ).rejects.toMatchObject({ code: "agent_capacity" });
    await Promise.all(
      allocations.map((allocation) =>
        harness.service.cancelTask(allocation.task_id),
      ),
    );
    expect(harness.service.activeCount).toBe(0);
  });

  it("maps explicit failure and unexpected interruption to terminal task states", async () => {
    const harness = await createHarness("terminal-mapping");
    const project = await registerGitProject(
      harness,
      "terminal-mapping-project",
    );
    for (const [prompt, expectedState] of [
      ["Return an explicit failure.", "failed"],
      ["Return an unexpected interruption.", "interrupted"],
    ] as const) {
      const allocation = await harness.service.startTask({
        project_id: project.id,
        prompt,
      });
      const record = await waitForTerminal(harness.runtime, allocation.task_id);
      expect(record.state).toBe(expectedState);
      await waitForExecutionIdle(harness.service);
    }
  });

  it("waits for confirmed interruption before cancellation and tolerates repeats", async () => {
    const harness = await createHarness("delayed-interrupt");
    const project = await registerGitProject(
      harness,
      "delayed-interrupt-project",
    );
    const allocation = await harness.service.startTask({
      project_id: project.id,
      prompt: "Wait for the interrupt result.",
    });
    const firstCancel = harness.service.cancelTask(allocation.task_id);
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    expect(
      (await harness.runtime.manager.getTask(allocation.task_id)).state,
    ).toBe("running");
    const repeatedCancel = harness.service.cancelTask(allocation.task_id);
    const [firstResult, repeatedResult] = await Promise.all([
      firstCancel,
      repeatedCancel,
    ]);
    expect(firstResult.state).toBe("cancelled");
    expect(repeatedResult.state).toBe("cancelled");
    expect(harness.service.activeCount).toBe(0);
  });

  it("does not report cancelled when turn/interrupt fails", async () => {
    const harness = await createHarness("interrupt-failure");
    const project = await registerGitProject(
      harness,
      "interrupt-failure-project",
    );
    const allocation = await harness.service.startTask({
      project_id: project.id,
      prompt: "The interrupt request will fail.",
    });
    const result = await harness.service.cancelTask(allocation.task_id);
    expect(result.state).toBe("interrupted");
    expect(harness.service.activeCount).toBe(0);
  });

  it("fails an active turn on an unexpected correlated server request without saving its payload", async () => {
    const harness = await createHarness("execution-server-request");
    const project = await registerGitProject(harness, "server-request-project");
    const allocation = await harness.service.startTask({
      project_id: project.id,
      prompt: "Do not ask for more input.",
    });
    const record = await waitForTerminal(harness.runtime, allocation.task_id);
    expect(record.state).toBe("failed");
    expect(JSON.stringify(record)).not.toContain("private question text");
    expect(JSON.stringify(record)).not.toContain(
      "ephemeral-private-server-request-id",
    );
    expect(record.pending_input).toBeNull();
  });

  it("fails the session closed when a server request cannot be correlated", async () => {
    const harness = await createHarness("execution-uncorrelated-after-two");
    const projects = await Promise.all([
      registerGitProject(harness, "uncorrelated-project-one"),
      registerGitProject(harness, "uncorrelated-project-two"),
    ]);
    const allocations = await Promise.all(
      projects.map((project) =>
        harness.service.startTask({
          project_id: project.id,
          prompt: "Hold this turn until the shared session fails.",
        }),
      ),
    );
    const records = await Promise.all(
      allocations.map(({ task_id }) =>
        waitForTerminal(harness.runtime, task_id),
      ),
    );
    expect(records.map((record) => record.state)).toEqual([
      "interrupted",
      "interrupted",
    ]);
    expect(harness.service.activeCount).toBe(0);
    for (const { task_id } of allocations) {
      const stored = await readFile(getTaskPath(task_id), "utf8");
      expect(stored).not.toContain("uncorrelated private question");
      expect(stored).not.toContain("ephemeral-uncorrelated-request-id");
      expect(stored).not.toContain("unknown-private-thread-id");
    }
  });

  it("marks a process death interrupted and does not automatically replay it", async () => {
    const harness = await createHarness("process-death");
    const project = await registerGitProject(harness, "process-death-project");
    const allocation = await harness.service.startTask({
      project_id: project.id,
      prompt: "This turn may be interrupted.",
    });
    const record = await waitForTerminal(harness.runtime, allocation.task_id);
    expect(record.state).toBe("interrupted");
    expect(record.turn_count).toBe(1);
  });
});
