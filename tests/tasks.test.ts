import { createHash, randomUUID } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getTaskPath } from "../src/config/paths.js";
import { addProject, type ProjectRecord } from "../src/projects/registry.js";
import { appendTaskEventToRecord } from "../src/tasks/manager.js";
import { TaskRuntime } from "../src/tasks/runtime.js";
import { TaskSignals } from "../src/tasks/signals.js";
import { TaskStore } from "../src/tasks/store.js";
import {
  MAX_EVENTS_PER_TASK,
  MAX_FINAL_RESPONSE_BYTES,
  MAX_PROMPT_PREVIEW_BYTES,
  MAX_TASK_FILE_BYTES,
  TaskRecordSchema,
  TokenBreakdownSchema,
  hashText,
  summarizePrompt,
  truncateUtf8,
  type TaskRecord,
  type TaskState,
} from "../src/tasks/types.js";

const temporaryRoots: string[] = [];
const runtimes: TaskRuntime[] = [];
const oldAppData = process.env.APPDATA;
const oldXdg = process.env.XDG_CONFIG_HOME;
const oldHome = process.env.HOME;

interface Harness {
  root: string;
  project: ProjectRecord;
  runtime: TaskRuntime;
  store: TaskStore;
}

class GatedTaskStore extends TaskStore {
  private nextGate:
    | {
        entered: () => void;
        release: Promise<void>;
      }
    | undefined;

  holdNextReplacement(): { entered: Promise<void>; release(): void } {
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const releasePromise = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.nextGate = { entered: enter, release: releasePromise };
    return { entered, release };
  }

  override async replace(record: TaskRecord): Promise<void> {
    const gate = this.nextGate;
    if (gate) {
      this.nextGate = undefined;
      gate.entered();
      await gate.release;
    }
    await super.replace(record);
  }
}

async function createHarness(
  store: TaskStore = new TaskStore(),
): Promise<Harness> {
  const root = await mkdtemp(path.join(os.tmpdir(), "ctxbridge-task-test-"));
  temporaryRoots.push(root);
  process.env.APPDATA = path.join(root, "appdata");
  process.env.XDG_CONFIG_HOME = path.join(root, "xdg");
  process.env.HOME = root;
  const projectRoot = path.join(root, "synthetic-project");
  await mkdir(projectRoot, { recursive: true });
  const project = await addProject(projectRoot);
  const runtime = await TaskRuntime.start({ store });
  runtimes.push(runtime);
  return { root, project, runtime, store };
}

function intentFor(
  project: ProjectRecord,
  overrides: Record<string, unknown> = {},
) {
  if (!project.registrationId)
    throw new Error("Test project is not identified.");
  return {
    project_id: project.id,
    display_name: project.name,
    registration_id: project.registrationId,
    registration_added_at: project.addedAt,
    prompt: "synthetic prompt",
    profile: "luna-max",
    model_id: "gpt-6-luna",
    mode: "default" as const,
    ...overrides,
  };
}

async function createTask(
  harness: Harness,
  overrides: Record<string, unknown> = {},
) {
  const allocation = await harness.runtime.manager.createTaskIntent(
    intentFor(harness.project, overrides),
  );
  return { allocation, record: await harness.store.read(allocation.task_id) };
}

afterEach(async () => {
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

describe.sequential("task persistence and manager", () => {
  it("uses validated UUID task paths and rejects caller-controlled path text", () => {
    const taskId = randomUUID();
    expect(getTaskPath(taskId)).toMatch(new RegExp(`${taskId}\\.json$`));
    expect(() => getTaskPath("../private.json")).toThrow(TypeError);
    expect(() => getTaskPath("C:\\outside\\task.json")).toThrow(TypeError);
  });

  it("hashes exact UTF-8 prompt bytes and truncates previews on Unicode boundaries", () => {
    const prompt = `${"a".repeat(MAX_PROMPT_PREVIEW_BYTES - 1)}🙂tail`;
    const summary = summarizePrompt(prompt);
    expect(summary.prompt_sha256).toBe(
      createHash("sha256").update(Buffer.from(prompt, "utf8")).digest("hex"),
    );
    expect(summary.prompt_preview).toBe(
      "a".repeat(MAX_PROMPT_PREVIEW_BYTES - 1),
    );
    expect(Buffer.byteLength(summary.prompt_preview, "utf8")).toBe(
      MAX_PROMPT_PREVIEW_BYTES - 1,
    );
    expect(summary.prompt_sha256).not.toContain(prompt);
    expect(() => summarizePrompt("\ud800")).toThrow(RangeError);
  });

  it("bounds final response in UTF-8 bytes without splitting a multibyte code point", () => {
    const source = `${"x".repeat(MAX_FINAL_RESPONSE_BYTES - 2)}🙂`;
    const response = truncateUtf8(source, MAX_FINAL_RESPONSE_BYTES);
    expect(response.truncated).toBe(true);
    expect(response.text).toBe("x".repeat(MAX_FINAL_RESPONSE_BYTES - 2));
    expect(Buffer.byteLength(response.text, "utf8")).toBe(
      MAX_FINAL_RESPONSE_BYTES - 2,
    );
    const whole = truncateUtf8("a🙂", 5);
    expect(whole).toEqual({ text: "a🙂", truncated: false });
    expect(truncateUtf8("\ud800x", 6)).toEqual({
      text: "\ufffdx",
      truncated: false,
    });
  });

  it("creates, strictly reads, atomically replaces, and refuses duplicate task IDs", async () => {
    const harness = await createHarness();
    const { allocation, record } = await createTask(harness);
    expect((await harness.store.read(allocation.task_id)).task_id).toBe(
      allocation.task_id,
    );

    await expect(harness.store.create(record)).rejects.toMatchObject({
      code: "task_id_conflict",
    });
    const filesAfterDuplicate = await readdir(
      path.dirname(getTaskPath(record.task_id)),
    );
    expect(filesAfterDuplicate).toEqual([`${record.task_id}.json`]);

    record.detected_codex_version = "1.2.3";
    await harness.store.replace(record);
    expect(
      (await harness.store.read(record.task_id)).detected_codex_version,
    ).toBe("1.2.3");
  });

  it("accepts future local-action states and initializes the approved usage shape", async () => {
    const harness = await createHarness();
    const { allocation, record } = await createTask(harness);
    const now = new Date().toISOString();

    const waiting = structuredClone(record);
    waiting.state = "waiting_for_input";
    waiting.turns[0]!.state = "waiting_for_input";
    waiting.updated_at = now;
    appendTaskEventToRecord(
      waiting,
      {
        turn_number: 1,
        category: "turn",
        kind: "state_changed",
        status: "waiting_for_input",
      },
      now,
    );
    expect(waiting.local_action_required).toBe(false);
    expect(TaskRecordSchema.safeParse(waiting).success).toBe(true);

    const localOnly = structuredClone(record);
    localOnly.state = "interrupted";
    localOnly.turns[0]!.state = "interrupted";
    localOnly.turns[0]!.completed_at = now;
    localOnly.turns[0]!.safe_error = {
      code: "secret_input_requires_local_action",
    };
    localOnly.updated_at = now;
    localOnly.local_action_required = true;
    localOnly.safe_error = { code: "secret_input_requires_local_action" };
    appendTaskEventToRecord(
      localOnly,
      {
        turn_number: 1,
        category: "turn",
        kind: "state_changed",
        status: "interrupted",
      },
      now,
    );
    expect(localOnly.pending_input).toBeNull();
    expect(TaskRecordSchema.safeParse(localOnly).success).toBe(true);

    const serialized = await readFile(getTaskPath(allocation.task_id), "utf8");
    const persisted = JSON.parse(serialized) as TaskRecord;
    const breakdown = persisted.usage_summary.thread_total;
    expect(breakdown).toEqual({
      input_tokens: null,
      cached_input_tokens: null,
      cache_write_input_tokens: null,
      output_tokens: null,
      reasoning_output_tokens: null,
      total_tokens: null,
    });
    expect(serialized).toContain('"cache_write_input_tokens":null');
    expect(persisted.usage_summary.model_context_window).toBeNull();
    expect(persisted.usage_summary.latest_last).toBeNull();
    expect(persisted.usage_summary.delta_quality).toBe("unavailable");
    expect(persisted.usage_summary.model_request_count).toBeNull();
    expect(persisted.turns[0]?.usage).toEqual({
      start_total: null,
      end_total: null,
      latest_last: null,
      turn_delta: null,
      model_context_window: null,
      delta_quality: "unavailable",
      model_request_count: null,
    });
    expect(
      TokenBreakdownSchema.safeParse({
        ...breakdown,
        model_context_window: null,
      }).success,
    ).toBe(false);
  });

  it("waits for an in-flight durable mutation before releasing runtime ownership", async () => {
    const store = new GatedTaskStore();
    const harness = await createHarness(store);
    const { allocation } = await createTask(harness);
    const gate = store.holdNextReplacement();
    const mutation = harness.runtime.manager.appendEvent(allocation.task_id, {
      turn_number: 1,
      category: "runtime",
      kind: "activity",
      status: "observed",
    });
    await gate.entered;

    let closeResolved = false;
    const closing = harness.runtime.close().then(() => {
      closeResolved = true;
    });
    await Promise.resolve();
    expect(closeResolved).toBe(false);
    gate.release();
    await mutation;
    await closing;

    expect((await store.read(allocation.task_id)).events.at(-1)?.kind).toBe(
      "activity",
    );
    const next = await TaskRuntime.start({ store });
    runtimes.push(next);
    expect(next.isClosed).toBe(false);
  });

  it("preserves a valid file when an attempted replacement is invalid", async () => {
    const harness = await createHarness();
    const { allocation } = await createTask(harness);
    const before = await readFile(getTaskPath(allocation.task_id));
    const invalid = (await harness.store.read(
      allocation.task_id,
    )) as TaskRecord & {
      unexpected?: string;
    };
    invalid.unexpected = "must not persist";
    await expect(harness.store.replace(invalid)).rejects.toMatchObject({
      code: "task_store_error",
    });
    expect(await readFile(getTaskPath(allocation.task_id))).toEqual(before);
  });

  it("fails closed on malformed records, future schemas, invalid state, extra keys, and ID mismatch", async () => {
    const mutations: Array<(record: Record<string, unknown>) => unknown> = [
      () => "{not json",
      (record) => ({ ...record, schema_version: 2 }),
      (record) => ({ ...record, state: "unknown" }),
      (record) => ({ ...record, extra_private_payload: "unexpected" }),
      (record) => ({
        ...record,
        events: [
          {
            ...(record.events as Array<Record<string, unknown>>)[0],
            details: "not allowed",
          },
        ],
      }),
      (record) => ({ ...record, task_id: randomUUID() }),
      (record) => ({ ...record, created_at: "yesterday" }),
    ];
    for (const mutate of mutations) {
      const harness = await createHarness();
      const { allocation } = await createTask(harness);
      await harness.runtime.close();
      const taskPath = getTaskPath(allocation.task_id);
      const original = await readFile(taskPath);
      const decoded = JSON.parse(original.toString("utf8")) as Record<
        string,
        unknown
      >;
      const changed = mutate(decoded);
      await writeFile(
        taskPath,
        typeof changed === "string" ? changed : JSON.stringify(changed),
      );
      const corruptBytes = await readFile(taskPath);
      await expect(TaskRuntime.start()).rejects.toMatchObject({
        code: "task_store_error",
      });
      expect(await readFile(taskPath)).toEqual(corruptBytes);
    }
  });

  it("fails closed for unexpected files and oversized task files without changing them", async () => {
    const harness = await createHarness();
    const { allocation } = await createTask(harness);
    await harness.runtime.close();
    const taskDirectory = path.dirname(getTaskPath(allocation.task_id));
    const unexpected = path.join(taskDirectory, "notes.txt");
    await writeFile(unexpected, "do not remove");
    await expect(TaskRuntime.start()).rejects.toMatchObject({
      code: "task_store_error",
    });
    expect(await readFile(unexpected, "utf8")).toBe("do not remove");
    await rm(unexpected);

    const oversized = Buffer.alloc(MAX_TASK_FILE_BYTES + 1, 0x20);
    const taskPath = getTaskPath(allocation.task_id);
    await writeFile(taskPath, oversized);
    await expect(TaskRuntime.start()).rejects.toMatchObject({
      code: "task_store_capacity",
    });
    expect((await readFile(taskPath)).byteLength).toBe(oversized.byteLength);
  });

  it("validates turn transitions and requires a new turn after a terminal turn", async () => {
    const harness = await createHarness();
    const { allocation } = await createTask(harness);
    const manager = harness.runtime.manager;
    await expect(
      manager.transitionTurn(allocation.task_id, 1, "completed"),
    ).rejects.toMatchObject({ code: "task_state_conflict" });
    await manager.transitionTurn(allocation.task_id, 1, "running");
    const waiting = await manager.transitionTurn(
      allocation.task_id,
      1,
      "waiting_for_input",
    );
    expect(waiting.local_action_required).toBe(false);
    await manager.transitionTurn(allocation.task_id, 1, "running");
    const completed = await manager.transitionTurn(
      allocation.task_id,
      1,
      "completed",
    );
    expect(completed.turns[0]?.state).toBe("completed");
    await expect(
      manager.transitionTurn(allocation.task_id, 1, "running"),
    ).rejects.toMatchObject({ code: "task_state_conflict" });

    const next = await manager.appendTurnIntent({
      task_id: allocation.task_id,
      prompt: "follow up",
    });
    expect(next).toMatchObject({ turn_number: 2, replayed: false });
    const updated = await manager.getTask(allocation.task_id);
    expect(updated.state).toBe("queued");
    expect(updated.turns.map((turn) => turn.state)).toEqual([
      "completed",
      "queued",
    ]);

    for (const [from, to] of [
      ["queued", "waiting_for_input"],
      ["running", "queued"],
      ["waiting_for_input", "completed"],
      ["failed", "running"],
      ["cancelled", "running"],
      ["interrupted", "running"],
    ] as const) {
      const invalid = await createTask(harness);
      if (from === "running" || from === "waiting_for_input") {
        await manager.transitionTurn(invalid.allocation.task_id, 1, "running");
      }
      if (from === "waiting_for_input") {
        await manager.transitionTurn(
          invalid.allocation.task_id,
          1,
          "waiting_for_input",
        );
      }
      if (from === "failed" || from === "cancelled" || from === "interrupted") {
        await manager.transitionTurn(invalid.allocation.task_id, 1, from);
      }
      await expect(
        manager.transitionTurn(invalid.allocation.task_id, 1, to),
      ).rejects.toMatchObject({ code: "task_state_conflict" });
    }
  });

  it("enforces every allowed transition from queued, running, and input-wait states", async () => {
    const harness = await createHarness();
    const manager = harness.runtime.manager;
    const cases: Array<{ from: TaskState; to: TaskState; via?: TaskState }> = [
      { from: "queued", to: "running" },
      { from: "queued", to: "failed" },
      { from: "queued", to: "cancelled" },
      { from: "queued", to: "interrupted" },
      { from: "running", via: "running", to: "waiting_for_input" },
      { from: "running", via: "running", to: "completed" },
      { from: "running", via: "running", to: "failed" },
      { from: "running", via: "running", to: "cancelled" },
      { from: "running", via: "running", to: "interrupted" },
      { from: "waiting_for_input", via: "running", to: "failed" },
      { from: "waiting_for_input", via: "running", to: "cancelled" },
      { from: "waiting_for_input", via: "running", to: "interrupted" },
      { from: "waiting_for_input", via: "running", to: "running" },
    ];
    for (const item of cases) {
      const { allocation } = await createTask(harness);
      if (item.from === "running" || item.from === "waiting_for_input") {
        await manager.transitionTurn(allocation.task_id, 1, "running");
      }
      if (item.from === "waiting_for_input") {
        await manager.transitionTurn(
          allocation.task_id,
          1,
          "waiting_for_input",
        );
      }
      if (item.from === "waiting_for_input" && item.to === "running") {
        const resumed = await manager.transitionTurn(
          allocation.task_id,
          1,
          "running",
        );
        expect(resumed.state).toBe("running");
      } else {
        const result = await manager.transitionTurn(
          allocation.task_id,
          1,
          item.to,
        );
        expect(result.state).toBe(item.to);
        if (item.to === "waiting_for_input" || item.to === "interrupted") {
          expect(result.local_action_required).toBe(false);
        }
      }
    }
  });

  it("serializes concurrent updates to one task without losing event sequence", async () => {
    const harness = await createHarness();
    const { allocation } = await createTask(harness);
    const manager = harness.runtime.manager;
    const before = await manager.getTask(allocation.task_id);
    await Promise.all([
      manager.appendEvent(allocation.task_id, {
        turn_number: 1,
        category: "runtime",
        kind: "activity",
        status: "observed",
      }),
      manager.appendEvent(allocation.task_id, {
        turn_number: 1,
        category: "runtime",
        kind: "activity",
        status: "observed",
      }),
    ]);
    const after = await manager.getTask(allocation.task_id);
    expect(after.event_seq).toBe(before.event_seq + 2);
    expect(after.events.slice(-2).map((event) => event.seq)).toEqual([
      before.event_seq + 1,
      before.event_seq + 2,
    ]);
  });

  it("wakes every task waiter only after the event is durably visible", async () => {
    const store = new GatedTaskStore();
    const harness = await createHarness(store);
    const { allocation } = await createTask(harness);
    const manager = harness.runtime.manager;
    const before = await harness.store.read(allocation.task_id);
    const first = manager.waitForTask(
      allocation.task_id,
      before.event_seq,
      5_000,
    );
    const second = manager.waitForTask(
      allocation.task_id,
      before.event_seq,
      5_000,
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    let firstResolved = false;
    void first.then(() => {
      firstResolved = true;
    });
    const gate = store.holdNextReplacement();
    const mutation = manager.appendEvent(allocation.task_id, {
      turn_number: 1,
      category: "runtime",
      kind: "activity",
      status: "observed",
    });
    await gate.entered;
    await Promise.resolve();
    expect(firstResolved).toBe(false);
    gate.release();
    await mutation;
    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult.event_seq).toBe(before.event_seq + 1);
    expect(secondResult.event_seq).toBe(before.event_seq + 1);
    expect(firstResult.events.at(-1)?.kind).toBe("activity");
  });

  it("truncates the timeline at 1,000 entries and keeps monotonic sequence markers", async () => {
    const harness = await createHarness();
    const { allocation, record } = await createTask(harness);
    for (let index = 0; index < MAX_EVENTS_PER_TASK; index += 1) {
      appendTaskEventToRecord(record, {
        turn_number: 1,
        category: "runtime",
        kind: "activity",
        status: "observed",
      });
    }
    expect(record.events).toHaveLength(MAX_EVENTS_PER_TASK);
    expect(record.event_seq).toBe(MAX_EVENTS_PER_TASK + 1);
    expect(record.events_truncated_before_seq).toBe(1);
    expect(record.events[0]?.seq).toBe(2);
    expect(record.events.at(-1)?.seq).toBe(record.event_seq);
    expect(TaskRecordSchema.safeParse(record).success).toBe(true);
    await harness.store.replace(record);
    expect((await harness.store.read(allocation.task_id)).events).toHaveLength(
      MAX_EVENTS_PER_TASK,
    );
  });

  it("persists idempotency hashes, replays identical requests, and conflicts on changed payloads", async () => {
    const harness = await createHarness();
    const requestId = "internal-request-key-A";
    const input = intentFor(harness.project, { request_id: requestId });
    const first = await harness.runtime.manager.createTaskIntent(input);
    const replay = await harness.runtime.manager.createTaskIntent(input);
    expect(replay).toEqual({ ...first, replayed: true });
    await expect(
      harness.runtime.manager.createTaskIntent({
        ...input,
        prompt: "different prompt",
      }),
    ).rejects.toMatchObject({ code: "request_id_conflict" });

    const raw = await readFile(getTaskPath(first.task_id), "utf8");
    expect(raw).not.toContain(requestId);
    expect(raw).toContain(hashText(requestId));
    const persisted = JSON.parse(raw) as Record<string, unknown>;
    expect(persisted).not.toHaveProperty("json_rpc_request_id");
    expect(
      TaskRecordSchema.safeParse({
        ...persisted,
        json_rpc_request_id: "upstream-id-must-not-persist",
      }).success,
    ).toBe(false);
  });

  it("rebuilds start and continue idempotency indexes after runtime restart", async () => {
    const harness = await createHarness();
    const input = intentFor(harness.project, {
      request_id: "restart-start-key",
    });
    const started = await harness.runtime.manager.createTaskIntent(input);
    await harness.runtime.manager.transitionTurn(started.task_id, 1, "running");
    await harness.runtime.manager.transitionTurn(
      started.task_id,
      1,
      "completed",
    );
    const continuation = {
      task_id: started.task_id,
      prompt: "continue after restart",
      request_id: "restart-continue-key",
    };
    const continued =
      await harness.runtime.manager.appendTurnIntent(continuation);
    await harness.runtime.close();

    const restarted = await TaskRuntime.start({ store: harness.store });
    runtimes.push(restarted);
    expect(await restarted.manager.createTaskIntent(input)).toEqual({
      ...started,
      replayed: true,
    });
    expect(await restarted.manager.appendTurnIntent(continuation)).toEqual({
      ...continued,
      replayed: true,
    });
    await expect(
      restarted.manager.appendTurnIntent({
        ...continuation,
        prompt: "different continuation",
      }),
    ).rejects.toMatchObject({ code: "request_id_conflict" });
  });

  it("fails startup before recovery when persisted request hashes conflict", async () => {
    const harness = await createHarness();
    const { allocation, record } = await createTask(harness, {
      request_id: "duplicated-persisted-key",
    });
    const duplicate = structuredClone(record);
    duplicate.task_id = randomUUID();
    for (const entry of duplicate.idempotency)
      entry.task_id = duplicate.task_id;
    await harness.store.create(duplicate);
    await harness.runtime.close();

    await expect(
      TaskRuntime.start({ store: harness.store }),
    ).rejects.toMatchObject({
      code: "task_store_error",
    });
    expect((await harness.store.read(allocation.task_id)).state).toBe("queued");
  });

  it("persists private thread IDs but omits them and registration metadata from safe views", async () => {
    const harness = await createHarness();
    const { allocation } = await createTask(harness);
    await harness.runtime.manager.setPrivateThreadId(
      allocation.task_id,
      "private-thread-opaque-value",
    );
    const raw = await readFile(getTaskPath(allocation.task_id), "utf8");
    expect(raw).toContain("private-thread-opaque-value");
    expect(raw).not.toContain("json_rpc");
    expect(raw).not.toContain(harness.project.root);
    expect(raw).not.toContain("root_fingerprint");

    const view = await harness.runtime.manager.getTaskView(allocation.task_id);
    const sanitized = JSON.stringify(view);
    expect(sanitized).not.toContain("private-thread-opaque-value");
    expect(sanitized).not.toContain(harness.project.registrationId ?? "");
    expect(sanitized).not.toContain(harness.project.root);
    expect(sanitized).not.toContain("prompt_preview");
    expect(sanitized).not.toContain("idempotency");
    expect(
      await harness.runtime.manager.listTaskViews({ limit: 10 }),
    ).toHaveLength(1);
  });

  it("hides historical task views after project removal or registration replacement", async () => {
    const harness = await createHarness();
    const { allocation } = await createTask(harness);
    await expect(
      harness.runtime.manager.getTaskView(allocation.task_id),
    ).resolves.toMatchObject({ task_id: allocation.task_id });
    const { removeProject, readRegistry, writeRegistry } =
      await import("../src/projects/registry.js");
    await removeProject(harness.project.id);
    await expect(
      harness.runtime.manager.getTaskView(allocation.task_id),
    ).rejects.toMatchObject({ code: "task_registration_stale" });
    expect(await harness.runtime.manager.listTaskViews({ limit: 10 })).toEqual(
      [],
    );

    const registry = await readRegistry();
    registry.projects.push({
      ...harness.project,
      registrationId: randomUUID(),
    });
    await writeRegistry(registry);
    await expect(
      harness.runtime.manager.getTaskView(allocation.task_id),
    ).rejects.toMatchObject({ code: "task_registration_stale" });
  });

  it("enforces per-record byte limits without overwriting the previous valid file", async () => {
    const harness = await createHarness();
    const { allocation } = await createTask(harness);
    const record = await harness.store.read(allocation.task_id);
    record.final_response = {
      text: "z".repeat(MAX_FINAL_RESPONSE_BYTES + 1),
      truncated: false,
    };
    const before = await readFile(getTaskPath(allocation.task_id));
    await expect(harness.store.replace(record)).rejects.toMatchObject({
      code: "task_store_error",
    });
    expect(await readFile(getTaskPath(allocation.task_id))).toEqual(before);
  });

  it("does not persist a full prompt and stores the bounded final response", async () => {
    const harness = await createHarness();
    const prompt = `${"p".repeat(511)}🙂${"q".repeat(100)}`;
    const allocation = await harness.runtime.manager.createTaskIntent(
      intentFor(harness.project, { prompt }),
    );
    const before = await readFile(getTaskPath(allocation.task_id), "utf8");
    expect(before).not.toContain(prompt);
    expect(
      Buffer.byteLength(
        (await harness.store.read(allocation.task_id)).turns[0]
          ?.prompt_preview ?? "",
        "utf8",
      ),
    ).toBe(511);
    const response = "🙂".repeat(MAX_FINAL_RESPONSE_BYTES / 4 + 1);
    const saved = await harness.runtime.manager.setFinalResponse(
      allocation.task_id,
      response,
    );
    expect(saved.truncated).toBe(true);
    expect(Buffer.byteLength(saved.text, "utf8")).toBe(
      MAX_FINAL_RESPONSE_BYTES,
    );
    expect(
      (await harness.store.read(allocation.task_id)).final_response,
    ).toEqual(saved);
  });
});

describe("task signals", () => {
  const sample = { event_seq: 0, state: "queued" as const };

  it("returns immediately for newer events, input waits, and terminal states", async () => {
    const signals = new TaskSignals();
    await expect(
      signals.waitForChange("task", 0, 5_000, async () => ({
        ...sample,
        event_seq: 1,
      })),
    ).resolves.toMatchObject({ event_seq: 1 });
    await expect(
      signals.waitForChange("task", 0, 5_000, async () => ({
        ...sample,
        state: "waiting_for_input" as const,
      })),
    ).resolves.toMatchObject({ state: "waiting_for_input" });
    await expect(
      signals.waitForChange("task", 0, 5_000, async () => ({
        ...sample,
        state: "completed" as const,
      })),
    ).resolves.toMatchObject({ state: "completed" });
  });

  it("closes the lost-wakeup window by rereading after listener registration", async () => {
    const signals = new TaskSignals();
    let reads = 0;
    const result = await signals.waitForChange(
      "lost-wakeup",
      0,
      5_000,
      async () => {
        reads += 1;
        if (reads === 2) {
          signals.notify("lost-wakeup");
          return { ...sample, event_seq: 1 };
        }
        return sample;
      },
    );
    expect(reads).toBe(2);
    expect(result.event_seq).toBe(1);
    expect(signals.listenerCount).toBe(0);
  });

  it("rereads durable state after timeout and removes the listener", async () => {
    const signals = new TaskSignals();
    let reads = 0;
    const result = await signals.waitForChange("timeout", 0, 15, async () => {
      reads += 1;
      return sample;
    });
    expect(result).toEqual(sample);
    expect(reads).toBe(3);
    expect(signals.listenerCount).toBe(0);
  });

  it("cleans up AbortSignal listeners and wakes every waiter", async () => {
    const signals = new TaskSignals();
    const controller = new AbortController();
    const aborted = signals.waitForChange(
      "abort",
      0,
      5_000,
      async () => sample,
      controller.signal,
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    controller.abort();
    await expect(aborted).rejects.toMatchObject({ code: "task_wait_aborted" });
    expect(signals.listenerCount).toBe(0);

    const first = signals.waitForChange("many", 0, 5_000, async () => sample);
    const second = signals.waitForChange("many", 0, 5_000, async () => sample);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(signals.listenerCount).toBe(2);
    signals.notify("many");
    await expect(Promise.all([first, second])).resolves.toEqual([
      sample,
      sample,
    ]);
    expect(signals.listenerCount).toBe(0);
  });
});
