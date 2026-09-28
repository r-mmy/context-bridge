import { createHash, randomUUID } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import {
  AgentExecutionService,
  makeContextBridgeThreadName,
} from "../../src/agents/execution.js";
import { CodexAgentAdapter } from "../../src/agents/codex/adapter.js";
import {
  PINNED_CODEX_VERSION,
  type CodexRuntime,
} from "../../src/agents/codex/runtime.js";
import {
  tryAcquireProjectWriterLock,
  type FileLockHandle,
} from "../../src/locks/file-lock.js";
import {
  disableProjectAuthorization,
  enableProjectAuthorization,
  readAgentPolicy,
  addAgentProfile,
  setProjectAllowedProfiles,
  writeAgentPolicy,
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
  children: ChildProcessWithoutNullStreams[];
  childLifecycles: Array<{ exitObserved: boolean }>;
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
  const childLifecycles: Harness["childLifecycles"] = [];
  const fakeEnvironment: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? "",
    SYSTEMROOT: process.env.SYSTEMROOT ?? "C:\\Windows",
    TEMP: process.env.TEMP ?? os.tmpdir(),
    TMP: process.env.TMP ?? os.tmpdir(),
    HOME: path.join(root, "fake-home"),
    TMPDIR: os.tmpdir(),
    CODEX_HOME: path.join(root, "fake-codex-home"),
    OPENAI_API_KEY: "SYNTHETIC_OPENAI_SECRET_SENTINEL",
    ANTHROPIC_API_KEY: "SYNTHETIC_ANTHROPIC_SECRET_SENTINEL",
    GITHUB_TOKEN: "SYNTHETIC_GITHUB_TOKEN_SENTINEL",
    SECURE_MCP_TUNNEL_TOKEN: "SYNTHETIC_TUNNEL_SECRET_SENTINEL",
    ARBITRARY_APP_SECRET: "SYNTHETIC_APP_SECRET_SENTINEL",
  };
  const adapter = new CodexAgentAdapter({
    environment: fakeEnvironment,
    homeDirectory: path.join(root, "fake-home"),
    resolveRuntime: async (): Promise<CodexRuntime> => ({
      executable: process.execPath,
      argsPrefix: [fixturePath],
      version: PINNED_CODEX_VERSION,
      source: "managed",
    }),
    spawnProcess: (_executable, args, spawnOptions) => {
      const command =
        args.at(-1) === "--version"
          ? [fixturePath, "version", tracePath, "", PINNED_CODEX_VERSION]
          : [
              fixturePath,
              mode,
              tracePath,
              options.startupMutationProjectName
                ? path.join(root, options.startupMutationProjectName)
                : "",
            ];
      const child = spawn(process.execPath, command, {
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        env: spawnOptions.env,
        windowsHide: true,
      }) as ChildProcessWithoutNullStreams;
      children.push(child);
      const lifecycle = { exitObserved: false };
      childLifecycles.push(lifecycle);
      child.on("exit", () => (lifecycle.exitObserved = true));
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
    for (const pid of await readStdioHolderPids(tracePath)) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        // The synthetic stdio holder may already have exited.
      }
    }
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
  return {
    root,
    tracePath,
    children,
    childLifecycles,
    projects,
    runtime,
    service,
  };
}

async function readStdioHolderPids(tracePath: string): Promise<number[]> {
  const trace = await readFile(tracePath, "utf8").catch(() => "");
  const pids: number[] = [];
  for (const line of trace.split("\n")) {
    if (!line) continue;
    try {
      const entry: unknown = JSON.parse(line);
      if (
        entry !== null &&
        typeof entry === "object" &&
        "kind" in entry &&
        entry.kind === "stdio-holder" &&
        "pid" in entry &&
        typeof entry.pid === "number" &&
        Number.isSafeInteger(entry.pid)
      ) {
        pids.push(entry.pid);
      }
    } catch {
      // Ignore incomplete synthetic trace lines during teardown.
    }
  }
  return pids;
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
    if (record.state === "waiting_for_input") {
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
      record = await runtime.manager.getTask(taskId);
    } else {
      record = await runtime.manager.waitForTask(
        taskId,
        record.event_seq,
        1_000,
      );
    }
  }
  return record;
}

async function waitForPendingInput(
  runtime: TaskRuntime,
  taskId: string,
): Promise<TaskRecord> {
  let record = await runtime.manager.getTask(taskId);
  const deadline = Date.now() + 10_000;
  while (
    !record.pending_input &&
    !["failed", "interrupted", "cancelled"].includes(record.state)
  ) {
    if (Date.now() > deadline)
      throw new Error("task did not request user input");
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

async function waitForProjectWriterLock(
  project: ProjectRecord,
): Promise<FileLockHandle> {
  const deadline = Date.now() + 10_000;
  while (Date.now() <= deadline) {
    const lock = await tryAcquireProjectWriterLock(project.root);
    if (lock) return lock;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("project writer lock did not become available");
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
  const lock = await waitForProjectWriterLock(project);
  await lock.release();
}

async function expectWriterHeld(project: ProjectRecord): Promise<void> {
  const lock = await tryAcquireProjectWriterLock(project.root);
  expect(lock).toBeFalsy();
  if (lock) await lock.release();
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

async function waitForTraceMethod(
  harness: Harness,
  method: string,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const content = await readFile(harness.tracePath, "utf8").catch(() => "");
    const entry = content
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((candidate) => candidate.method === method);
    if (entry) return entry;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`fake App Server did not receive ${method}`);
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
      request_id: "private-request-id-for-name-test",
    });
    const record = await waitForTerminal(harness.runtime, allocation.task_id);
    expect(record.state).toBe("completed");
    expect(record.private_thread_id).toMatch(/^fake-thread-/);
    const internalThreadId = record.private_thread_id!;
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
    await waitForExecutionIdle(harness.service);

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
    const naming = entries.find((entry) => entry.method === "thread/name/set");
    const unsubscribe = entries.find(
      (entry) => entry.method === "thread/unsubscribe",
    );
    expect(naming?.params).toEqual({
      threadId: internalThreadId,
      name: `Context Bridge · ${project.name} · ${allocation.task_id.slice(0, 8)}`,
    });
    expect(entries.indexOf(naming!)).toBeLessThan(
      entries.indexOf(unsubscribe!),
    );
    const matchingClosed = entries.find(
      (entry) =>
        entry.kind === "thread-closed-sent" &&
        entry.threadId === internalThreadId,
    );
    const terminalNotification = entries.find(
      (entry) =>
        entry.kind === "turn-terminal-sent" &&
        entry.threadId === internalThreadId,
    );
    expect(Number(terminalNotification?.at)).toBeLessThanOrEqual(
      Number(naming?.at),
    );
    expect(Number(matchingClosed?.at)).toBeGreaterThanOrEqual(
      Number(unsubscribe?.at),
    );
    expect(Number(matchingClosed?.at)).toBeLessThan(
      Number(unsubscribe?.at) + 1_000,
    );
    expect(JSON.stringify(naming?.params)).not.toContain(originalPrompt);
    expect(JSON.stringify(naming?.params)).not.toContain(project.root);
    const generatedName =
      (naming?.params as { name?: string } | undefined)?.name ?? "";
    expect(generatedName).not.toContain(internalThreadId);
    expect(generatedName).not.toContain("private-request-id-for-name-test");
    expect(generatedName).not.toContain("gpt-6-luna");
    expect(generatedName).not.toContain("private_thread_id");
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
      collaborationMode: "default",
      collaborationModel: "gpt-6-luna",
      collaborationEffort: "max",
      defaultMode: true,
      oneTextInput: true,
      model: "gpt-6-luna",
      effort: "max",
    });
  });

  it("continues the same unloaded thread with a fresh baseline, idempotent replay, and Plan mode", async () => {
    const harness = await createHarness("normal");
    const project = await registerGitProject(harness, "continuation-project");
    const started = await harness.service.startTask({
      project_id: project.id,
      prompt: "Set the value to beta.",
    });
    const first = await waitForTerminal(harness.runtime, started.task_id);
    expect(first.state).toBe("completed");
    await waitForExecutionIdle(harness.service);
    const threadId = first.private_thread_id;
    expect(threadId).toMatch(/^fake-thread-/);

    await writeFile(path.join(project.root, "value.txt"), "beta\n", "utf8");
    const continueInput = {
      task_id: started.task_id,
      prompt: "Use the prior turn's value and change beta to gamma.",
      request_id: "same-thread-continuation",
    };
    const secondAllocation = await harness.service.continueTask(continueInput);
    expect(secondAllocation).toMatchObject({ turn_number: 2, replayed: false });
    const second = await waitForTerminal(harness.runtime, started.task_id);
    expect(second.turn_count).toBe(2);
    expect(second.turns[1]?.git_baseline).toMatchObject({
      modified: 1,
      staged: 0,
      deleted: 0,
      untracked: 0,
    });
    expect(second.turns[1]?.prompt_preview).toBe(continueInput.prompt);
    expect(second.turns[1]?.prompt_sha256).toBe(
      createHash("sha256").update(continueInput.prompt, "utf8").digest("hex"),
    );
    await waitForExecutionIdle(harness.service);

    const beforeReplay = await traceMethods(harness);
    await expect(harness.service.continueTask(continueInput)).resolves.toEqual({
      ...secondAllocation,
      replayed: true,
    });
    await expect(
      harness.service.continueTask({
        ...continueInput,
        prompt: "A changed continuation must conflict.",
      }),
    ).rejects.toMatchObject({ code: "request_id_conflict" });
    expect(await traceMethods(harness)).toEqual(beforeReplay);

    await writeFile(path.join(project.root, "value.txt"), "gamma\n", "utf8");
    const thirdAllocation = await harness.service.continueTask({
      task_id: started.task_id,
      prompt: "The previous turn set gamma; create a Plan for the next step.",
      mode: "plan",
    });
    expect(thirdAllocation).toMatchObject({ turn_number: 3, replayed: false });
    const third = await waitForTerminal(harness.runtime, started.task_id);
    expect(third.state).toBe("completed");
    expect(third.turns[2]?.mode).toBe("plan");
    expect(third.turns[2]?.git_baseline?.modified).toBe(1);
    await waitForExecutionIdle(harness.service);

    const entries = (await readFile(harness.tracePath, "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const methods = entries.filter((entry) => entry.method);
    const starts = methods.filter((entry) => entry.method === "thread/start");
    const resumes = methods.filter((entry) => entry.method === "thread/resume");
    const turnStarts = methods.filter((entry) => entry.method === "turn/start");
    const names = methods.filter((entry) => entry.method === "thread/name/set");
    const releases = methods.filter(
      (entry) => entry.method === "thread/unsubscribe",
    );
    expect(starts).toHaveLength(1);
    expect(resumes).toHaveLength(2);
    expect(turnStarts).toHaveLength(3);
    expect(names).toHaveLength(1);
    expect(releases).toHaveLength(3);
    for (const entry of [...resumes, ...turnStarts]) {
      expect((entry.params as { threadId?: string }).threadId).toBe(threadId);
    }
    expect(resumes[0]?.params).toMatchObject({
      threadId,
      cwd: project.root,
      runtimeWorkspaceRoots: [project.root],
      approvalPolicy: "never",
      sandbox: "workspace-write",
      model: "gpt-6-luna",
      excludeTurns: true,
    });
    expect(
      entries
        .filter((entry) => entry.kind === "thread-resume-security-check")
        .every((entry) =>
          Object.entries({
            exactStoredThread: true,
            oneRuntimeRoot: true,
            cwdMatchesRoot: true,
            approvalNever: true,
            workspaceWrite: true,
            excludesTurns: true,
          }).every(([key, value]) => entry[key] === value),
        ),
    ).toBe(true);
    expect(
      entries
        .filter((entry) => entry.kind === "execution-security-check")
        .map((entry) => entry.collaborationMode),
    ).toEqual(["default", "default", "plan"]);
    expect(
      entries
        .filter((entry) => entry.kind === "execution-security-check")
        .every((entry) =>
          [
            entry.oneRuntimeRoot,
            entry.cwdMatchesRoot,
            entry.oneWritableRoot,
            entry.writableRootMatches,
            entry.approvalNever,
            entry.networkDisabled,
            entry.excludesTemp,
            entry.excludesSlashTmp,
          ].every(Boolean),
        ),
    ).toBe(true);
    await expectWriterReleased(harness, project);
  });

  it("persists pinned-protocol usage deltas and private activity aggregates across same-thread turns", async () => {
    const harness = await createHarness("m6-telemetry");
    const project = await registerGitProject(harness, "telemetry-project");
    const started = await harness.service.startTask({
      project_id: project.id,
      prompt: "Summarize the existing workspace without changing any files.",
    });
    const first = await waitForTerminal(harness.runtime, started.task_id);
    await waitForExecutionIdle(harness.service);
    const firstTurn = first.turns[0];
    expect(firstTurn?.usage).toEqual({
      start_total: {
        input_tokens: 0,
        cached_input_tokens: 0,
        cache_write_input_tokens: 0,
        output_tokens: 0,
        reasoning_output_tokens: 0,
        total_tokens: 0,
      },
      end_total: {
        input_tokens: 100,
        cached_input_tokens: 10,
        cache_write_input_tokens: 4,
        output_tokens: 20,
        reasoning_output_tokens: 10,
        total_tokens: 120,
      },
      latest_last: {
        input_tokens: 60,
        cached_input_tokens: 8,
        cache_write_input_tokens: 2,
        output_tokens: 10,
        reasoning_output_tokens: 6,
        total_tokens: 70,
      },
      turn_delta: {
        input_tokens: 100,
        cached_input_tokens: 10,
        cache_write_input_tokens: 4,
        output_tokens: 20,
        reasoning_output_tokens: 10,
        total_tokens: 120,
      },
      model_context_window: 258_400,
      delta_quality: "authoritative_delta",
      model_request_count: null,
    });
    expect(firstTurn?.activity_summary).toMatchObject({
      command_execution: {
        started_count: 1,
        completed_count: 1,
        failed_count: 0,
        duration_sample_count: 1,
        duration_total_ms: 25,
      },
      file_change: {
        started_count: 1,
        completed_count: 1,
        failed_count: 0,
        duration_sample_count: 1,
        duration_total_ms: 25,
      },
      mcp_tool_call: {
        started_count: 1,
        completed_count: 1,
        failed_count: 1,
        duration_sample_count: 1,
        duration_total_ms: 25,
      },
      dynamic_tool_call: {
        started_count: 1,
        completed_count: 1,
        failed_count: 0,
        duration_sample_count: 1,
        duration_total_ms: 25,
      },
      other: {
        started_count: 1,
        completed_count: 1,
        failed_count: 0,
        duration_sample_count: 1,
        duration_total_ms: 25,
      },
    });
    expect(first.usage_summary.thread_total).toEqual(
      firstTurn?.usage.end_total,
    );
    expect(first.usage_summary.latest_last).toEqual(
      firstTurn?.usage.latest_last,
    );

    const secondAllocation = await harness.service.continueTask({
      task_id: started.task_id,
      prompt: "Continue the harmless summary without changing files.",
    });
    const second = await waitForTerminal(harness.runtime, started.task_id);
    await waitForExecutionIdle(harness.service);
    expect(secondAllocation.turn_number).toBe(2);
    expect(second.private_thread_id).toBe(first.private_thread_id);
    expect(second.turns[1]?.usage).toMatchObject({
      start_total: firstTurn?.usage.end_total,
      end_total: {
        input_tokens: 200,
        cached_input_tokens: 25,
        cache_write_input_tokens: 6,
        output_tokens: 40,
        reasoning_output_tokens: 18,
        total_tokens: 240,
      },
      turn_delta: {
        input_tokens: 100,
        cached_input_tokens: 15,
        cache_write_input_tokens: 2,
        output_tokens: 20,
        reasoning_output_tokens: 8,
        total_tokens: 120,
      },
      model_context_window: 262_144,
      delta_quality: "authoritative_delta",
      model_request_count: null,
    });
    expect(second.usage_summary.thread_total).toEqual(
      second.turns[1]?.usage.end_total,
    );
    expect(second.usage_summary.latest_last).toEqual(
      second.turns[1]?.usage.latest_last,
    );
    expect(second.usage_summary.model_context_window).toBe(262_144);

    const persisted = await readFile(getTaskPath(started.task_id), "utf8");
    for (const secret of [
      "PRIVATE_COMMAND_SENTINEL",
      "PRIVATE_TOOL_ARGUMENT_SENTINEL",
      "PRIVATE_TOOL_OUTPUT_SENTINEL",
      "PRIVATE_USAGE_PAYLOAD_SENTINEL",
      "PRIVATE_UNKNOWN_FIELD_SENTINEL",
      "C:\\private\\project\\root",
      "private-command-activity-id",
      "private-file-activity-id",
      "private-mcp-activity-id",
      "private-dynamic-activity-id",
      "private-other-activity-id",
    ]) {
      expect(persisted).not.toContain(secret);
    }
  });

  it("routes usage only to the matching active thread and turn", async () => {
    const harness = await createHarness("m6-routing");
    const project = await registerGitProject(harness, "telemetry-routing");
    const allocation = await harness.service.startTask({
      project_id: project.id,
      prompt: "Summarize without changing files.",
    });
    await waitForTerminal(harness.runtime, allocation.task_id);
    await waitForExecutionIdle(harness.service);

    const record = await harness.runtime.manager.getTask(allocation.task_id);
    expect(record.usage_summary.thread_total).toEqual({
      input_tokens: 100,
      cached_input_tokens: 10,
      cache_write_input_tokens: 4,
      output_tokens: 20,
      reasoning_output_tokens: 10,
      total_tokens: 120,
    });
    const persisted = await readFile(getTaskPath(allocation.task_id), "utf8");
    expect(persisted).not.toContain("stale-private-turn-id");
    expect(persisted).not.toContain("unrelated-private-thread-id");
    expect(persisted).not.toContain('"total_tokens":999');
  });

  it("does not add repeated identical cumulative or last snapshots", async () => {
    const harness = await createHarness("m6-repeated-last");
    const project = await registerGitProject(harness, "telemetry-repeated");
    const allocation = await harness.service.startTask({
      project_id: project.id,
      prompt: "Summarize without changing files.",
    });
    await waitForTerminal(harness.runtime, allocation.task_id);
    await waitForExecutionIdle(harness.service);

    const record = await harness.runtime.manager.getTask(allocation.task_id);
    expect(record.turns[0]?.usage.turn_delta?.total_tokens).toBe(120);
    expect(record.turns[0]?.usage.latest_last?.total_tokens).toBe(70);
    expect(record.usage_summary.thread_total.total_tokens).toBe(120);
    expect(record.usage_summary.model_request_count).toBeNull();
  });

  it("keeps user-input waiting separate while telemetry continues on the same turn", async () => {
    const harness = await createHarness("m6-input-telemetry");
    const project = await registerGitProject(harness, "telemetry-input");
    const allocation = await harness.service.startTask({
      project_id: project.id,
      prompt: "Ask one harmless question, then finish without edits.",
    });
    const waiting = await waitForPendingInput(
      harness.runtime,
      allocation.task_id,
    );
    await harness.service.answerUserInput({
      task_id: allocation.task_id,
      pending_input_id: waiting.pending_input!.pending_input_id,
      answers: [
        { question_id: "choice", answers: ["Proceed"] },
        { question_id: "note", answers: ["answered for the test"] },
        { question_id: "choice-with-note", answers: ["Proceed"] },
        {
          question_id: "__proto__",
          answers: ["opaque identifier accepted"],
        },
      ],
    });
    await waitForTerminal(harness.runtime, allocation.task_id);
    await waitForExecutionIdle(harness.service);

    const record = await harness.runtime.manager.getTask(allocation.task_id);
    expect(record.turn_count).toBe(1);
    expect(record.turns[0]).toMatchObject({
      input_wait_count: 1,
      usage: {
        turn_delta: {
          input_tokens: 100,
          cached_input_tokens: 10,
          cache_write_input_tokens: 4,
          output_tokens: 20,
          reasoning_output_tokens: 10,
          total_tokens: 120,
        },
      },
    });
    expect(record.turns[0]?.activity_summary).not.toHaveProperty(
      "request_user_input",
    );
  });

  it("ignores usage notifications received after terminal settlement", async () => {
    const harness = await createHarness("m6-post-terminal-usage");
    const project = await registerGitProject(
      harness,
      "telemetry-post-terminal",
    );
    const allocation = await harness.service.startTask({
      project_id: project.id,
      prompt: "Summarize without changing files.",
    });
    await waitForTerminal(harness.runtime, allocation.task_id);
    await waitForExecutionIdle(harness.service);
    const before = await harness.runtime.manager.getTask(allocation.task_id);
    await new Promise((resolve) => setTimeout(resolve, 80));
    const trace = await readFile(harness.tracePath, "utf8");
    expect(trace).toContain("m6-post-terminal-notification-sent");
    const after = await harness.runtime.manager.getTask(allocation.task_id);
    expect(after.usage_summary).toEqual(before.usage_summary);
    expect(after.turns[0]?.usage).toEqual(before.turns[0]?.usage);
  });

  it("keeps concurrent telemetry bound to each task's private thread", async () => {
    const harness = await createHarness("m6-concurrent-telemetry");
    const firstProject = await registerGitProject(harness, "telemetry-first");
    const secondProject = await registerGitProject(harness, "telemetry-second");
    const [firstAllocation, secondAllocation] = await Promise.all([
      harness.service.startTask({
        project_id: firstProject.id,
        prompt: "Summarize without changing files.",
      }),
      harness.service.startTask({
        project_id: secondProject.id,
        prompt: "Summarize without changing files.",
      }),
    ]);
    await Promise.all([
      waitForTerminal(harness.runtime, firstAllocation.task_id),
      waitForTerminal(harness.runtime, secondAllocation.task_id),
    ]);
    await waitForExecutionIdle(harness.service);

    const records = await Promise.all([
      harness.runtime.manager.getTask(firstAllocation.task_id),
      harness.runtime.manager.getTask(secondAllocation.task_id),
    ]);
    const totals = records.map((record) => record.usage_summary.thread_total);
    expect(
      totals
        .map((total) => total.total_tokens)
        .sort((a, b) => (a ?? -1) - (b ?? -1)),
    ).toEqual([120, 240]);
    expect(
      records.every(
        (record) =>
          record.turns[0]?.usage.end_total?.total_tokens ===
          record.usage_summary.thread_total.total_tokens,
      ),
    ).toBe(true);
  });

  it.each([
    ["m6-malformed-usage", "degraded"],
    ["m6-decreasing-usage", "degraded"],
  ] as const)(
    "completes safely with %s telemetry marked %s",
    async (mode, expectedQuality) => {
      const harness = await createHarness(mode);
      const project = await registerGitProject(harness, `telemetry-${mode}`);
      const allocation = await harness.service.startTask({
        project_id: project.id,
        prompt: "Summarize the workspace without modifying it.",
      });
      const record = await waitForTerminal(harness.runtime, allocation.task_id);
      expect(record.state).toBe("completed");
      expect(record.turns[0]?.usage.delta_quality).toBe(expectedQuality);
      expect(record.turns[0]?.usage.turn_delta).toBeNull();
      expect(record.turns[0]?.usage.end_total).not.toBeNull();
      if (mode === "m6-decreasing-usage") {
        expect(record.turns[0]?.usage.end_total).toEqual({
          input_tokens: 50,
          cached_input_tokens: 10,
          cache_write_input_tokens: 3,
          output_tokens: 20,
          reasoning_output_tokens: 8,
          total_tokens: 70,
        });
        expect(record.usage_summary.thread_total).toEqual(
          record.turns[0]?.usage.end_total,
        );
      }
      await waitForExecutionIdle(harness.service);

      const persisted = await readFile(getTaskPath(allocation.task_id), "utf8");
      expect(persisted).not.toContain("PRIVATE_USAGE_PAYLOAD_SENTINEL");
    },
  );

  it("leaves usage unavailable and end_total unset when the protocol sends no snapshots", async () => {
    const harness = await createHarness("normal");
    const project = await registerGitProject(harness, "no-telemetry-project");
    const allocation = await harness.service.startTask({
      project_id: project.id,
      prompt: "Summarize the workspace without modifying it.",
    });
    const record = await waitForTerminal(harness.runtime, allocation.task_id);
    expect(record.turns[0]?.usage.end_total).toBeNull();
    expect(record.turns[0]?.usage.turn_delta).toBeNull();
    expect(record.turns[0]?.usage.delta_quality).toBe("unavailable");
  });

  it.each([
    "resume-wrong-cwd",
    "resume-missing-cwd",
    "resume-wrong-roots",
    "resume-missing-roots",
  ])("does not start a turn when thread/resume returns %s", async (mode) => {
    const harness = await createHarness(mode);
    const project = await registerGitProject(harness, `resume-${mode}`);
    const started = await harness.service.startTask({
      project_id: project.id,
      prompt: "Complete before testing resume binding.",
    });
    await waitForTerminal(harness.runtime, started.task_id);
    await waitForExecutionIdle(harness.service);

    await expect(
      harness.service.continueTask({
        task_id: started.task_id,
        prompt: "This must not run under a mismatched root.",
      }),
    ).rejects.toMatchObject({ code: "app_server_incompatible" });
    const record = await harness.runtime.manager.getTask(started.task_id);
    expect(record.state).toBe("failed");
    expect(record.turn_count).toBe(2);
    const methods = await traceMethods(harness);
    expect(methods.filter((method) => method === "thread/start")).toHaveLength(
      1,
    );
    expect(methods.filter((method) => method === "thread/resume")).toHaveLength(
      1,
    );
    expect(methods.filter((method) => method === "turn/start")).toHaveLength(1);
    expect(
      methods.filter((method) => method === "thread/unsubscribe"),
    ).toHaveLength(2);
    await expectWriterReleased(harness, project);
  });

  it("starts initial Plan turns with the pinned collaboration mode and unchanged sandbox", async () => {
    const harness = await createHarness("normal");
    const project = await registerGitProject(harness, "plan-start-project");
    const allocation = await harness.service.startTask({
      project_id: project.id,
      prompt: "Make a harmless plan only.",
      mode: "plan",
    });
    const record = await waitForTerminal(harness.runtime, allocation.task_id);
    expect(record.turns[0]?.mode).toBe("plan");
    const security = (await readFile(harness.tracePath, "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((entry) => entry.kind === "execution-security-check");
    expect(security).toMatchObject({
      collaborationMode: "plan",
      collaborationModel: "gpt-6-luna",
      collaborationEffort: "max",
      networkDisabled: true,
      approvalNever: true,
      excludesTemp: true,
      excludesSlashTmp: true,
    });
    await waitForExecutionIdle(harness.service);
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

  it("does not forward synthetic environment secrets into App Server or task data", async () => {
    const harness = await createHarness("auth-absent");
    const project = await registerGitProject(harness, "environment-secrets");
    const input = {
      project_id: project.id,
      prompt: "Do not expose synthetic environment sentinels.",
    };
    const failure = await harness.service
      .startTask(input)
      .catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: "codex_unauthenticated" });
    const record = await getOnlyStoredTask(harness);
    const publicView = await harness.runtime.manager.getTaskView(
      record.task_id,
    );
    const persisted = await readFile(getTaskPath(record.task_id), "utf8");
    const trace = await readFile(harness.tracePath, "utf8");
    for (const sentinel of [
      "SYNTHETIC_OPENAI_SECRET_SENTINEL",
      "SYNTHETIC_ANTHROPIC_SECRET_SENTINEL",
      "SYNTHETIC_GITHUB_TOKEN_SENTINEL",
      "SYNTHETIC_TUNNEL_SECRET_SENTINEL",
      "SYNTHETIC_APP_SECRET_SENTINEL",
    ]) {
      expect(String(failure)).not.toContain(sentinel);
      expect(JSON.stringify(record)).not.toContain(sentinel);
      expect(JSON.stringify(publicView)).not.toContain(sentinel);
      expect(persisted).not.toContain(sentinel);
      expect(trace).not.toContain(sentinel);
    }
    const environmentCheck = trace
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((entry) => entry.kind === "environment-check");
    expect(environmentCheck).toMatchObject({
      hasOpenAiKey: false,
      hasAnthropicKey: false,
      hasGithubToken: false,
      hasTunnelSecret: false,
      hasArbitrarySecret: false,
    });
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
    expect(await traceMethods(harness)).toContain("thread/unsubscribe");
    expect(await traceMethods(harness)).not.toContain("thread/name/set");
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

  it("keeps an unapproved registration off without allocating or starting Codex", async () => {
    const harness = await createHarness("normal");
    const root = path.join(harness.root, "default-off-project");
    await mkdir(root, { recursive: true });
    const project = await addProject(root);
    harness.projects.push(project);
    await expect(
      harness.service.startTask({
        project_id: project.id,
        prompt: "An unapproved project must remain off.",
      }),
    ).rejects.toMatchObject({ code: "agent_disabled" });
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
    const methods = await traceMethods(harness);
    expect(
      methods.filter((method) => method === "thread/unsubscribe"),
    ).toHaveLength(2);
  });

  it("keeps active turns subscribed until confirmed terminal completion", async () => {
    const harness = await createHarness("delayed-turn");
    const project = await registerGitProject(
      harness,
      "active-subscription-project",
    );
    const allocation = await harness.service.startTask({
      project_id: project.id,
      prompt: "Remain active until cancellation is confirmed.",
    });
    expect(await traceMethods(harness)).not.toContain("thread/unsubscribe");
    expect(await traceMethods(harness)).not.toContain("thread/name/set");
    expect(harness.service.activeCount).toBe(1);

    const result = await harness.service.cancelTask(allocation.task_id);
    expect(result.state).toBe("cancelled");
    expect(await traceMethods(harness)).toContain("thread/unsubscribe");
    await expectWriterReleased(harness, project);
  });

  it("waits for the matching thread/closed notification and bounds a missing notification", async () => {
    const unrelated = await createHarness("unrelated-thread-closed");
    const unrelatedProject = await registerGitProject(
      unrelated,
      "unrelated-close-project",
    );
    const allocation = await unrelated.service.startTask({
      project_id: unrelatedProject.id,
      prompt: "Ignore unrelated closure notifications.",
    });
    await waitForTerminal(unrelated.runtime, allocation.task_id);
    await waitForExecutionIdle(unrelated.service);
    const unrelatedTrace = (await readFile(unrelated.tracePath, "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const unrelatedUnsubscribe = unrelatedTrace.find(
      (entry) => entry.method === "thread/unsubscribe",
    );
    const expectedClosed = unrelatedTrace.find(
      (entry) =>
        entry.kind === "thread-closed-sent" &&
        entry.threadId !== "unrelated-thread",
    );
    const unrelatedSettledAt = Date.now();
    expect(
      Number(expectedClosed?.at) - Number(unrelatedUnsubscribe?.at),
    ).toBeGreaterThanOrEqual(20);
    expect(
      unrelatedSettledAt - Number(unrelatedUnsubscribe?.at),
    ).toBeGreaterThanOrEqual(20);
    expect(unrelatedSettledAt - Number(unrelatedUnsubscribe?.at)).toBeLessThan(
      1_000,
    );

    const missing = await createHarness("no-thread-closed");
    const missingProject = await registerGitProject(
      missing,
      "missing-close-project",
    );
    const missingAllocation = await missing.service.startTask({
      project_id: missingProject.id,
      prompt: "Complete even if the cosmetic close event is absent.",
    });
    const record = await waitForTerminal(
      missing.runtime,
      missingAllocation.task_id,
    );
    await waitForExecutionIdle(missing.service);
    expect(record.state).toBe("completed");
    const missingTrace = (await readFile(missing.tracePath, "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const missingUnsubscribe = missingTrace.find(
      (entry) => entry.method === "thread/unsubscribe",
    );
    const elapsedFromUnsubscribe = Date.now() - Number(missingUnsubscribe?.at);
    expect(elapsedFromUnsubscribe).toBeGreaterThanOrEqual(1_500);
    expect(elapsedFromUnsubscribe).toBeLessThan(5_000);
  });

  it("keeps completed results successful when naming or unsubscribe fails", async () => {
    for (const mode of ["thread-name-failure", "unsubscribe-failure"]) {
      const harness = await createHarness(mode);
      const project = await registerGitProject(harness, `${mode}-project`);
      const allocation = await harness.service.startTask({
        project_id: project.id,
        prompt: "Complete successfully despite cosmetic cleanup failure.",
        request_id: `${mode}-request-id`,
      });
      const record = await waitForTerminal(harness.runtime, allocation.task_id);
      await waitForExecutionIdle(harness.service);
      expect(record.state).toBe("completed");
      expect(record.final_response?.text).toBe(
        "Changed value.txt from alpha to beta.",
      );
      const json = JSON.stringify(
        await harness.runtime.manager.getTaskView(allocation.task_id),
      );
      for (const privateValue of [
        project.root,
        record.private_thread_id ?? "",
        `${mode}-request-id`,
      ]) {
        expect(json).not.toContain(privateValue);
      }
    }
  });

  it("persists the terminal result before naming and keeps the writer until release settles", async () => {
    const harness = await createHarness("delayed-thread-name");
    const project = await registerGitProject(
      harness,
      "terminal-name-order-project",
    );
    const allocation = await harness.service.startTask({
      project_id: project.id,
      prompt: "Persist terminal state before cleanup.",
    });
    const naming = await waitForTraceMethod(harness, "thread/name/set");
    const record = await harness.runtime.manager.getTask(allocation.task_id);
    expect(record.state).toBe("completed");
    expect(record.final_response?.text).toBe(
      "Changed value.txt from alpha to beta.",
    );
    expect(harness.service.activeCount).toBe(1);
    expect(await tryAcquireProjectWriterLock(project.root)).toBeUndefined();
    await waitForExecutionIdle(harness.service);
    const methods = await traceMethods(harness);
    expect(methods.indexOf("thread/name/set")).toBeLessThan(
      methods.indexOf("thread/unsubscribe"),
    );
    expect(naming.method).toBe("thread/name/set");
    await expectWriterReleased(harness, project);
  });

  it("sanitizes and bounds generated native-history names", () => {
    const taskId = "12345678-1234-4234-8234-123456789abc";
    const name = makeContextBridgeThreadName(
      `unsafe/\u0001project\u202e${"x".repeat(200)}`,
      taskId,
    );
    expect(name).toMatch(/^Context Bridge · unsafe project x+ · 12345678/);
    expect(name).not.toContain("\u0001");
    expect(name).not.toContain("\u202e");
    expect(name).not.toContain("/");
    expect(name).not.toContain(taskId);
    expect(name.length).toBeLessThanOrEqual(90);
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

  it("rejects continuation when the durable thread binding is missing", async () => {
    const harness = await createHarness("normal");
    const project = await registerGitProject(harness, "missing-thread-project");
    const started = await harness.service.startTask({
      project_id: project.id,
      prompt: "Create a completed task before removing its private binding.",
    });
    await waitForTerminal(harness.runtime, started.task_id);
    await waitForExecutionIdle(harness.service);
    const record = await harness.runtime.manager.getTask(started.task_id);
    record.private_thread_id = null;
    await writeFile(
      getTaskPath(started.task_id),
      JSON.stringify(record) + "\n",
      "utf8",
    );

    await expect(
      harness.service.continueTask({
        task_id: started.task_id,
        prompt: "This continuation has no private thread proof.",
      }),
    ).rejects.toMatchObject({ code: "task_state_conflict" });
    expect(await traceMethods(harness)).not.toContain("thread/resume");
    await expectWriterReleased(harness, project);
  });

  it("requires current enabled authorization and the same registration before continuation", async () => {
    const disabled = await createHarness("normal");
    const disabledProject = await registerGitProject(
      disabled,
      "disabled-continuation-project",
    );
    const disabledTask = await disabled.service.startTask({
      project_id: disabledProject.id,
      prompt: "Create a terminal task before disabling authorization.",
    });
    await waitForTerminal(disabled.runtime, disabledTask.task_id);
    await waitForExecutionIdle(disabled.service);
    await disableProjectAuthorization(disabledProject);
    await expect(
      disabled.service.continueTask({
        task_id: disabledTask.task_id,
        prompt: "Authorization is now disabled.",
      }),
    ).rejects.toMatchObject({ code: "agent_disabled" });
    expect(await traceMethods(disabled)).not.toContain("thread/resume");

    const stale = await createHarness("normal");
    const staleProject = await registerGitProject(
      stale,
      "stale-continuation-project",
    );
    const staleTask = await stale.service.startTask({
      project_id: staleProject.id,
      prompt: "Create a terminal task before re-registration.",
    });
    await waitForTerminal(stale.runtime, staleTask.task_id);
    await waitForExecutionIdle(stale.service);
    await removeProject(staleProject.id);
    const replacement = await addProject(staleProject.root);
    stale.projects.push(replacement);
    await expect(
      stale.service.continueTask({
        task_id: staleTask.task_id,
        prompt: "The task belongs to an older registration.",
      }),
    ).rejects.toMatchObject({ code: "task_registration_stale" });
    expect(await traceMethods(stale)).not.toContain("thread/resume");
  });

  it("blocks continuation when a valid authorization is rebound to another root fingerprint", async () => {
    const harness = await createHarness("normal");
    const project = await registerGitProject(harness, "fingerprint-project");
    const task = await harness.service.startTask({
      project_id: project.id,
      prompt: "Create a completed task before authorization tampering.",
    });
    await waitForTerminal(harness.runtime, task.task_id);
    await waitForExecutionIdle(harness.service);
    const methodsBefore = await traceMethods(harness);
    const policy = await readAgentPolicy();
    const authorization = policy.projects[project.id];
    if (!authorization) throw new Error("Expected project authorization.");
    policy.projects[project.id] = {
      ...authorization,
      root_fingerprint: "0".repeat(64),
    };
    await writeAgentPolicy(policy);

    await expect(
      harness.service.continueTask({
        task_id: task.task_id,
        prompt: "A changed root binding must never resume this thread.",
      }),
    ).rejects.toMatchObject({ code: "task_registration_stale" });
    expect(await traceMethods(harness)).toEqual(methodsBefore);
    await expectWriterReleased(harness, project);
  });

  it("reuses project writer exclusion for continuation", async () => {
    const harness = await createHarness("normal");
    const project = await registerGitProject(
      harness,
      "busy-continuation-project",
    );
    const started = await harness.service.startTask({
      project_id: project.id,
      prompt: "Create a terminal task before taking its writer lock.",
    });
    await waitForTerminal(harness.runtime, started.task_id);
    await waitForExecutionIdle(harness.service);
    const lock = await waitForProjectWriterLock(project);
    try {
      await expect(
        harness.service.continueTask({
          task_id: started.task_id,
          prompt: "A second writer holds this project.",
        }),
      ).rejects.toMatchObject({ code: "project_busy" });
    } finally {
      await lock?.release();
    }
    expect(await traceMethods(harness)).not.toContain("thread/resume");
  });

  it("rejects continuation when the task requires local action", async () => {
    const harness = await createHarness("normal");
    const project = await registerGitProject(
      harness,
      "local-action-continuation-project",
    );
    const started = await harness.service.startTask({
      project_id: project.id,
      prompt: "Create a terminal task before requiring local action.",
    });
    await waitForTerminal(harness.runtime, started.task_id);
    await waitForExecutionIdle(harness.service);
    const record = await harness.runtime.manager.getTask(started.task_id);
    record.state = "failed";
    const lastTurn = record.turns.at(-1);
    if (!lastTurn) throw new Error("expected the failed task turn");
    lastTurn.state = "failed";
    record.safe_error = { code: "secret_input_requires_local_action" };
    record.local_action_required = true;
    await writeFile(
      getTaskPath(started.task_id),
      JSON.stringify(record) + "\n",
      "utf8",
    );

    await expect(
      harness.service.continueTask({
        task_id: started.task_id,
        prompt: "Do not continue while local action is required.",
      }),
    ).rejects.toMatchObject({ code: "task_state_conflict" });
    expect(await traceMethods(harness)).not.toContain("thread/resume");
    await expectWriterReleased(harness, project);
  });

  it("inherits and overrides only currently allowed continuation profiles", async () => {
    const harness = await createHarness("normal");
    const project = await registerGitProject(
      harness,
      "profile-continuation-project",
    );
    await addAgentProfile("codex-sol-high", {
      model_id: "gpt-6-sol",
      reasoning_effort: "high",
    });
    await setProjectAllowedProfiles(
      project,
      ["luna-max", "codex-sol-high"],
      "luna-max",
    );
    const started = await harness.service.startTask({
      project_id: project.id,
      prompt: "Create a terminal task with the inherited profile.",
    });
    await waitForTerminal(harness.runtime, started.task_id);
    await waitForExecutionIdle(harness.service);

    const inherited = await harness.service.continueTask({
      task_id: started.task_id,
      prompt: "Continue with the inherited profile.",
    });
    expect(inherited.turn_number).toBe(2);
    expect(
      (await waitForTerminal(harness.runtime, started.task_id)).turns[1],
    ).toMatchObject({ profile: "luna-max", model_id: "gpt-6-luna" });
    await waitForExecutionIdle(harness.service);

    const overridden = await harness.service.continueTask({
      task_id: started.task_id,
      prompt: "Continue with the explicit allowed profile.",
      profile: "codex-sol-high",
    });
    expect(overridden.turn_number).toBe(3);
    expect(
      (await waitForTerminal(harness.runtime, started.task_id)).turns[2],
    ).toMatchObject({ profile: "codex-sol-high", model_id: "gpt-6-sol" });
    await waitForExecutionIdle(harness.service);

    await expect(
      harness.service.continueTask({
        task_id: started.task_id,
        prompt: "A profile outside current authorization must fail.",
        profile: "not-allowed",
      }),
    ).rejects.toMatchObject({ code: "profile_not_allowed" });
    expect(
      (await traceMethods(harness)).filter(
        (method) => method === "thread/resume",
      ),
    ).toHaveLength(2);
    await expectWriterReleased(harness, project);
  });

  it("applies the global active-turn cap to continuation allocations", async () => {
    const harness = await createHarness("delayed-turn");
    const terminalProject = await registerGitProject(
      harness,
      "continuation-cap-terminal",
    );
    const terminalTask = await harness.service.startTask({
      project_id: terminalProject.id,
      prompt: "Create a task that can be continued after cancellation.",
    });
    await harness.service.cancelTask(terminalTask.task_id);
    const activeProjects = await Promise.all(
      ["one", "two", "three", "four"].map((name) =>
        registerGitProject(harness, `continuation-cap-${name}`),
      ),
    );
    // This test verifies the active-turn cap, not concurrent config-lock
    // acquisition. Avoid queuing four Git/authorization checks on that lock.
    const activeTasks = [];
    for (const activeProject of activeProjects) {
      activeTasks.push(
        await harness.service.startTask({
          project_id: activeProject.id,
          prompt: "Hold one active turn for the continuation capacity check.",
        }),
      );
    }
    expect(harness.service.activeCount).toBe(4);
    await expect(
      harness.service.continueTask({
        task_id: terminalTask.task_id,
        prompt: "The fifth active turn must be rejected.",
      }),
    ).rejects.toMatchObject({ code: "agent_capacity" });
    expect(await traceMethods(harness)).not.toContain("thread/resume");
    await Promise.all(
      activeTasks.map((activeTask) =>
        harness.service.cancelTask(activeTask.task_id),
      ),
    );
    await expectWriterReleased(harness, terminalProject);
  });

  it("relays bounded multi-question input and continues the same default and Plan turns", async () => {
    const harness = await createHarness(
      "execution-server-request-delayed-terminal",
    );
    const project = await registerGitProject(harness, "server-request-project");
    const allocation = await harness.service.startTask({
      project_id: project.id,
      prompt: "Ask the user before continuing.",
    });
    const waiting = await waitForPendingInput(
      harness.runtime,
      allocation.task_id,
    );
    expect(waiting.state).toBe("waiting_for_input");
    expect(waiting.pending_input?.questions).toHaveLength(4);
    expect(waiting.pending_input?.questions[0]).toMatchObject({
      question_id: "choice",
      is_other: false,
      options: [
        { label: "Proceed", description: "Continue the same turn." },
        { label: "Wait", description: "Keep waiting." },
      ],
    });
    expect(waiting.pending_input?.questions[1]).toMatchObject({
      options: [],
      is_other: false,
    });
    expect(waiting.pending_input?.questions[2]?.is_other).toBe(true);
    expect(waiting.pending_input?.questions[3]?.question_id).toBe("__proto__");
    expect(harness.service.activeCount).toBe(1);
    await expectWriterHeld(project);

    const pendingId = waiting.pending_input!.pending_input_id;
    await expect(
      harness.service.answerUserInput({
        task_id: allocation.task_id,
        pending_input_id: randomUUID(),
        answers: [{ question_id: "choice", answers: ["Proceed"] }],
      }),
    ).rejects.toMatchObject({ code: "pending_input_stale" });
    const validAnswers = [
      { question_id: "choice", answers: ["Proceed"] },
      { question_id: "note", answers: ["approved by the user"] },
      { question_id: "choice-with-note", answers: ["Proceed", "because"] },
      { question_id: "__proto__", answers: ["opaque identifier accepted"] },
    ];
    const invalidAnswers = [
      [
        { question_id: "choice", answers: ["Proceed"] },
        { question_id: "note", answers: ["approved"] },
      ],
      [
        ...validAnswers.slice(0, 2),
        { question_id: "unknown", answers: ["extra"] },
      ],
      [
        { question_id: "choice", answers: ["Proceed"] },
        { question_id: "choice", answers: ["Wait"] },
        ...validAnswers.slice(1),
      ],
      [
        { question_id: "choice", answers: ["not an option"] },
        ...validAnswers.slice(1),
      ],
    ];
    for (const answers of invalidAnswers) {
      await expect(
        harness.service.answerUserInput({
          task_id: allocation.task_id,
          pending_input_id: pendingId,
          answers,
        }),
      ).rejects.toMatchObject({ code: "invalid_answers" });
    }
    expect(
      (await harness.runtime.manager.getTask(allocation.task_id)).state,
    ).toBe("waiting_for_input");

    const answered = await harness.service.answerUserInput({
      task_id: allocation.task_id,
      pending_input_id: pendingId,
      answers: validAnswers,
    });
    expect(answered).toMatchObject({ state: "running", turn_number: 1 });
    await expect(
      harness.service.answerUserInput({
        task_id: allocation.task_id,
        pending_input_id: pendingId,
        answers: validAnswers,
      }),
    ).rejects.toMatchObject({ code: "pending_input_not_found" });
    expect(harness.service.activeCount).toBe(1);
    const firstTerminal = await waitForTerminal(
      harness.runtime,
      allocation.task_id,
    );
    expect(firstTerminal.turn_count).toBe(1);
    expect(firstTerminal.turns[0]).toMatchObject({
      mode: "default",
      input_wait_count: 1,
    });
    expect(firstTerminal.turns[0]!.input_wait_ms).toBeGreaterThanOrEqual(0);
    expect(
      firstTerminal.events.filter((event) => event.category === "input").at(-1),
    ).toMatchObject({
      kind: "activity",
      status: "saved",
      duration_ms: expect.any(Number),
    });
    await waitForExecutionIdle(harness.service);

    const continued = await harness.service.continueTask({
      task_id: allocation.task_id,
      prompt: "Continue in Plan mode after user input.",
      mode: "plan",
    });
    const secondWaiting = await waitForPendingInput(
      harness.runtime,
      allocation.task_id,
    );
    expect(secondWaiting.pending_input?.turn_number).toBe(2);
    const secondId = secondWaiting.pending_input!.pending_input_id;
    await harness.service.answerUserInput({
      task_id: allocation.task_id,
      pending_input_id: secondId,
      answers: [
        { question_id: "choice", answers: ["Wait"] },
        { question_id: "note", answers: ["plan approved"] },
        { question_id: "choice-with-note", answers: ["free-form other"] },
        { question_id: "__proto__", answers: ["opaque identifier accepted"] },
      ],
    });
    const final = await waitForTerminal(harness.runtime, allocation.task_id);
    expect(continued.turn_number).toBe(2);
    expect(final.turn_count).toBe(2);
    expect(final.turns[1]).toMatchObject({ mode: "plan", input_wait_count: 1 });
    expect(final.pending_input).toBeNull();
    const trace = await readFile(harness.tracePath, "utf8");
    const records = trace
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const responses = records.filter(
      (entry) => entry.kind === "user-input-response",
    );
    expect(responses).toHaveLength(2);
    expect(responses[0]).toMatchObject({
      id: "ephemeral-private-server-request-id",
      result: {
        answers: {
          choice: { answers: ["Proceed"] },
          note: { answers: ["approved by the user"] },
          "choice-with-note": { answers: ["Proceed", "because"] },
        },
      },
    });
    const firstResponseAnswers = (
      responses[0]?.result as { answers: Record<string, unknown> } | undefined
    )?.answers;
    expect(firstResponseAnswers).toBeDefined();
    expect(Object.hasOwn(firstResponseAnswers!, "__proto__")).toBe(true);
    expect(firstResponseAnswers?.["__proto__"]).toEqual({
      answers: ["opaque identifier accepted"],
    });
    expect(
      records.filter((entry) => entry.method === "turn/start"),
    ).toHaveLength(2);
    expect(
      records.filter((entry) => entry.method === "thread/start"),
    ).toHaveLength(1);
    expect(JSON.stringify(final)).not.toContain(
      "ephemeral-private-server-request-id",
    );
    expect(JSON.stringify(final)).not.toContain("private-user-input-item");
    await waitForExecutionIdle(harness.service);
    await expectWriterReleased(harness, project);
  });

  it.each(["execution-secret-request", "execution-malformed-secret"])(
    "suppresses secret questions from %s, interrupts, and requires local action",
    async (mode) => {
      const harness = await createHarness(mode);
      const project = await registerGitProject(harness, `secret-${mode}`);
      const allocation = await harness.service.startTask({
        project_id: project.id,
        prompt: "A secret question must stay local.",
      });
      const record = await waitForTerminal(harness.runtime, allocation.task_id);
      expect(record).toMatchObject({
        state: "interrupted",
        local_action_required: true,
        safe_error: { code: "secret_input_requires_local_action" },
        pending_input: null,
      });
      const serialized = JSON.stringify(record);
      for (const privateValue of [
        "PRIVATE secret header",
        "PRIVATE secret question",
        "PRIVATE malformed secret question",
        "PRIVATE secret option",
        "PRIVATE secret description",
        "ephemeral-private-server-request-id",
        "private-user-input-item",
      ]) {
        expect(serialized).not.toContain(privateValue);
      }
      await expect(
        harness.service.continueTask({
          task_id: allocation.task_id,
          prompt: "Cannot continue the secret-input task.",
        }),
      ).rejects.toMatchObject({ code: "task_state_conflict" });
      const methods = await traceMethods(harness);
      expect(methods).toContain("turn/interrupt");
      await waitForExecutionIdle(harness.service);
      await expectWriterReleased(harness, project);
    },
  );

  it("relays a single blocking question without creating a replacement turn", async () => {
    const harness = await createHarness("execution-server-request-single");
    const project = await registerGitProject(harness, "single-input-project");
    const allocation = await harness.service.startTask({
      project_id: project.id,
      prompt: "Ask one harmless question before finishing.",
    });
    const waiting = await waitForPendingInput(
      harness.runtime,
      allocation.task_id,
    );
    expect(waiting.pending_input?.questions).toHaveLength(1);
    const answered = await harness.service.answerUserInput({
      task_id: allocation.task_id,
      pending_input_id: waiting.pending_input!.pending_input_id,
      answers: [{ question_id: "choice", answers: ["Proceed"] }],
    });
    expect(answered).toMatchObject({ turn_number: 1, state: "running" });
    const completed = await waitForTerminal(
      harness.runtime,
      allocation.task_id,
    );
    expect(completed.state).toBe("completed");
    expect(completed.turn_count).toBe(1);
    expect(
      (await traceMethods(harness)).filter((method) => method === "turn/start"),
    ).toHaveLength(1);
    await waitForExecutionIdle(harness.service);
    await expectWriterReleased(harness, project);
  });

  it.each([
    "execution-nonblocking-request",
    "execution-unsupported-request",
    "execution-duplicate-question",
    "execution-too-many-questions",
    "execution-second-request",
  ])(
    "fails closed for %s and does not persist request contents",
    async (mode) => {
      const harness = await createHarness(mode);
      const project = await registerGitProject(harness, `unsupported-${mode}`);
      const allocation = await harness.service.startTask({
        project_id: project.id,
        prompt: "Unsupported user input must fail closed.",
      });
      const record = await waitForTerminal(harness.runtime, allocation.task_id);
      expect(record.state).toBe("failed");
      expect(record.pending_input).toBeNull();
      expect(JSON.stringify(record)).not.toContain(
        "ephemeral-private-server-request-id",
      );
      await waitForExecutionIdle(harness.service);
      await expectWriterReleased(harness, project);
    },
  );

  it("rejects and invalidates pending input when the user cancels", async () => {
    const harness = await createHarness("execution-server-request");
    const project = await registerGitProject(harness, "cancel-input-project");
    const allocation = await harness.service.startTask({
      project_id: project.id,
      prompt: "Wait for a user answer, then cancel.",
    });
    const waiting = await waitForPendingInput(
      harness.runtime,
      allocation.task_id,
    );
    const pendingId = waiting.pending_input!.pending_input_id;
    const cancelled = await harness.service.cancelTask(allocation.task_id);
    expect(cancelled.state).toBe("cancelled");
    await expect(
      harness.service.answerUserInput({
        task_id: allocation.task_id,
        pending_input_id: pendingId,
        answers: [{ question_id: "choice", answers: ["Proceed"] }],
      }),
    ).rejects.toMatchObject({ code: "pending_input_not_found" });
    const trace = await readFile(harness.tracePath, "utf8");
    expect(trace).toContain('"kind":"user-input-response"');
    expect(trace).toContain('"error":{"code":-32000');
    await waitForExecutionIdle(harness.service);
    await expectWriterReleased(harness, project);
  });

  it("recovers an App Server death while waiting without replaying the private request", async () => {
    const harness = await createHarness("execution-server-request");
    const project = await registerGitProject(
      harness,
      "input-server-death-project",
    );
    const allocation = await harness.service.startTask({
      project_id: project.id,
      prompt: "Wait for one user answer, then lose the App Server.",
    });
    const waiting = await waitForPendingInput(
      harness.runtime,
      allocation.task_id,
    );
    expect(waiting.state).toBe("waiting_for_input");
    expect(waiting.pending_input).not.toBeNull();
    const appServer = harness.children.at(-1);
    if (!appServer || appServer.exitCode !== null) {
      throw new Error("expected an active fake App Server process");
    }
    const closed = new Promise<void>((resolve) =>
      appServer.once("close", () => resolve()),
    );
    expect(appServer.kill()).toBe(true);
    await expect(
      Promise.race([
        closed.then(() => true),
        new Promise<boolean>((resolve) =>
          setTimeout(() => resolve(false), 2_000),
        ),
      ]),
    ).resolves.toBe(true);

    const recovered = await waitForTerminal(
      harness.runtime,
      allocation.task_id,
    );
    expect(recovered.state).toBe("interrupted");
    expect(recovered.pending_input).toBeNull();
    expect(JSON.stringify(recovered)).not.toContain(
      "ephemeral-private-server-request-id",
    );
    expect(await readFile(harness.tracePath, "utf8")).not.toContain(
      '"kind":"user-input-response"',
    );
    await waitForExecutionIdle(harness.service);
    await expectWriterReleased(harness, project);
  });

  it("never retries a user answer after forwarding becomes uncertain", async () => {
    const harness = await createHarness("execution-answer-exit-after-forward");
    const project = await registerGitProject(
      harness,
      "answer-uncertainty-project",
    );
    const allocation = await harness.service.startTask({
      project_id: project.id,
      prompt: "Wait for one answer, then lose the disposable App Server.",
    });
    const waiting = await waitForPendingInput(
      harness.runtime,
      allocation.task_id,
    );
    if (!waiting.pending_input) throw new Error("expected pending input");
    const pendingId = waiting.pending_input.pending_input_id;
    const answers = [
      { question_id: "choice", answers: ["Proceed"] },
      { question_id: "note", answers: ["confirmed"] },
      { question_id: "choice-with-note", answers: ["Proceed"] },
      { question_id: "__proto__", answers: ["confirmed"] },
    ];
    await harness.service
      .answerUserInput({
        task_id: allocation.task_id,
        pending_input_id: pendingId,
        answers,
      })
      .catch(() => undefined);

    const appServer = harness.children.at(-1);
    if (!appServer) throw new Error("expected the fake App Server process");
    const processClosed =
      appServer.exitCode !== null || appServer.signalCode !== null
        ? true
        : await Promise.race([
            new Promise<boolean>((resolve) =>
              appServer.once("close", () => resolve(true)),
            ),
            new Promise<boolean>((resolve) =>
              setTimeout(() => resolve(false), 1_000),
            ),
          ]);
    expect(processClosed).toBe(true);

    const terminal = await waitForTerminal(harness.runtime, allocation.task_id);
    expect(["failed", "interrupted"]).toContain(terminal.state);
    expect(terminal.pending_input).toBeNull();
    expect(terminal.turn_count).toBe(1);
    await expect(
      harness.service.answerUserInput({
        task_id: allocation.task_id,
        pending_input_id: pendingId,
        answers,
      }),
    ).rejects.toMatchObject({
      code: expect.stringMatching(/pending_input_(?:not_found|stale)/),
    });

    const trace = (await readFile(harness.tracePath, "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(trace.filter((entry) => entry.method === "turn/start")).toHaveLength(
      1,
    );
    expect(
      trace.filter((entry) => entry.method === "thread/start"),
    ).toHaveLength(1);
    expect(
      trace.filter((entry) => entry.kind === "user-input-response"),
    ).toHaveLength(1);
    await waitForExecutionIdle(harness.service);
    await expectWriterReleased(harness, project);
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
    expect(await traceMethods(harness)).not.toContain("thread/unsubscribe");
  });

  it("settles a running task when the App Server process exits", async () => {
    const harness = await createHarness("process-death-held-stdio");
    const project = await registerGitProject(
      harness,
      "process-death-held-stdio-project",
    );
    const allocation = await harness.service.startTask({
      project_id: project.id,
      prompt: "This turn's App Server process will exit unexpectedly.",
    });

    const record = await waitForTerminal(harness.runtime, allocation.task_id);
    expect(record.state).toBe("interrupted");
    expect(record.turn_count).toBe(1);
    expect(harness.childLifecycles.at(-1)?.exitObserved).toBe(true);
    expect(await readStdioHolderPids(harness.tracePath)).toHaveLength(1);
    expect(harness.service.activeCount).toBe(0);
    await expectWriterReleased(harness, project);
    expect(
      (await traceMethods(harness)).filter((method) => method === "turn/start"),
    ).toHaveLength(1);
  });
});
