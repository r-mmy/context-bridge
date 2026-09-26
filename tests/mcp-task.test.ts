import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import type * as z from "zod/v4";
import { AgentAdapterError } from "../src/agents/errors.js";
import { ContextBridgeError } from "../src/security/errors.js";
import { TaskError } from "../src/tasks/errors.js";
import {
  emptyTaskUsageSummary,
  emptyTurnUsage,
  TaskRecordSchema,
  type TaskEvent,
  type TaskRecord,
  type TaskState,
} from "../src/tasks/types.js";
import { createContextBridgeServer } from "../src/mcp/server.js";
import type { TaskRecordPage, TaskToolHost } from "../src/mcp/task-host.js";
import {
  TaskAcceptedOutputSchema,
  TaskCancelOutputSchema,
  TaskGetInputSchema,
  TaskStartInputSchema,
  TasksListInputSchema,
} from "../src/mcp/task-tools.js";
import type { TaskGetOutputSchema } from "../src/mcp/task-tools.js";

const NOW = "2026-09-26T12:00:00.000Z";

function makeEvent(
  seq: number,
  category: TaskEvent["category"],
  kind: TaskEvent["kind"],
  status: TaskEvent["status"],
  turn_number: number | null,
): TaskEvent {
  return {
    seq,
    timestamp: NOW,
    turn_number,
    category,
    kind,
    status,
    duration_ms: null,
  };
}

function makeRecord(
  options: {
    state?: TaskState;
    marker?: number;
    events?: TaskEvent[];
  } = {},
): TaskRecord {
  const taskId = randomUUID();
  const state = options.state ?? "running";
  const finalResponse = { text: "PRIVATE_FINAL_RESPONSE", truncated: true };
  const turn = {
    turn_number: 1,
    state,
    mode: "default" as const,
    profile: "luna-max",
    model_id: "PRIVATE_MODEL_ID",
    created_at: NOW,
    started_at: NOW,
    completed_at:
      state === "completed" || state === "failed" || state === "cancelled"
        ? NOW
        : null,
    prompt_preview: "PRIVATE_PROMPT_PREVIEW",
    prompt_sha256: "a".repeat(64),
    git_baseline: {
      branch: "main",
      head: "c".repeat(40),
      staged: 1,
      modified: 2,
      deleted: 3,
      untracked: 4,
      truncated: false,
    },
    input_wait_ms: 0,
    input_wait_count: 0,
    final_response: state === "completed" ? finalResponse : null,
    safe_error:
      state === "failed"
        ? { code: "task_failed" as const }
        : state === "cancelled"
          ? { code: "task_cancelled" as const }
          : state === "interrupted"
            ? { code: "task_interrupted" as const }
            : null,
    usage: emptyTurnUsage(),
  };
  const events = options.events ?? [
    makeEvent(1, "lifecycle", "created", "queued", null),
    makeEvent(2, "lifecycle", "turn_queued", "queued", 1),
    makeEvent(3, "turn", "state_changed", "running", 1),
    makeEvent(4, "input", "activity", "waiting_for_input", 1),
    makeEvent(5, "runtime", "activity", "observed", 1),
    makeEvent(6, "recovery", "recovered", "recovered", 1),
  ];
  const record: TaskRecord = {
    schema_version: 1,
    task_id: taskId,
    project_id: "sample-project",
    display_name: "Sample project",
    registration_id: randomUUID(),
    registration_added_at: NOW,
    state,
    created_at: NOW,
    updated_at: NOW,
    current_profile: "luna-max",
    detected_codex_version: "PRIVATE_CODEX_VERSION",
    private_thread_id: "PRIVATE_THREAD_ID",
    turn_count: 1,
    turns: [turn],
    idempotency: [
      {
        request_id_hash: "b".repeat(64),
        operation: "start",
        payload_hash: "d".repeat(64),
        task_id: taskId,
        turn_number: 1,
      },
    ],
    events,
    event_seq: events.at(-1)?.seq ?? options.marker ?? 0,
    events_truncated_before_seq: options.marker ?? 0,
    pending_input: null,
    local_action_required: false,
    final_response: state === "completed" ? finalResponse : null,
    safe_error: turn.safe_error,
    usage_summary: emptyTaskUsageSummary(),
  };
  const parsed = TaskRecordSchema.parse(record);
  return parsed;
}

class MemoryTaskHost implements TaskToolHost {
  record = makeRecord();
  startInput: unknown = undefined;
  startError: unknown = undefined;
  startCalls = 0;
  cancelCalls = 0;
  cancelGate: Promise<void> | undefined;
  getError: unknown = undefined;
  waitCalls: Array<{
    taskId: string;
    afterSeq: number;
    waitMs: number;
    signal?: AbortSignal;
  }> = [];
  waitError: unknown = undefined;
  waitUpdate = false;
  listResult: TaskRecordPage | undefined;
  private readonly requests = new Map<
    string,
    { payload: string; record: TaskRecord }
  >();

  async startTask(input: Parameters<TaskToolHost["startTask"]>[0]) {
    this.startCalls += 1;
    this.startInput = input;
    if (this.startError) throw this.startError;
    if (input.mode === "plan") {
      throw new ContextBridgeError(
        "unsupported_task_mode",
        "raw internal plan-mode detail",
      );
    }
    const requestPayload = JSON.stringify({
      project_id: input.project_id,
      prompt: input.prompt,
      profile: input.profile,
      mode: input.mode,
    });
    if (input.request_id) {
      const previous = this.requests.get(input.request_id);
      if (previous) {
        if (previous.payload !== requestPayload)
          throw new TaskError("request_id_conflict");
        this.record = structuredClone(previous.record);
        return structuredClone(this.record);
      }
    }
    this.record = makeRecord({ state: "running" });
    if (input.request_id) {
      this.requests.set(input.request_id, {
        payload: requestPayload,
        record: structuredClone(this.record),
      });
    }
    return structuredClone(this.record);
  }

  async getTask(taskId: string) {
    if (this.getError) throw this.getError;
    if (taskId !== this.record.task_id) throw new TaskError("task_not_found");
    return structuredClone(this.record);
  }

  async waitForTask(
    taskId: string,
    afterSeq: number,
    waitMs: number,
    signal?: AbortSignal,
  ) {
    this.waitCalls.push({
      taskId,
      afterSeq,
      waitMs,
      ...(signal === undefined ? {} : { signal }),
    });
    if (this.waitError) throw this.waitError;
    if (this.waitUpdate) {
      this.record.state = "completed";
      this.record.turns[0]!.state = "completed";
      this.record.turns[0]!.completed_at = NOW;
      this.record.final_response = {
        text: "safe completed response",
        truncated: false,
      };
      this.record.turns[0]!.final_response = this.record.final_response;
      this.record.event_seq += 1;
      this.record.events.push(
        makeEvent(
          this.record.event_seq,
          "turn",
          "state_changed",
          "completed",
          1,
        ),
      );
      this.waitUpdate = false;
    }
    return structuredClone(this.record);
  }

  async listTasks(options: { project_id?: string; limit: number }) {
    if (this.listResult) return structuredClone(this.listResult);
    return {
      records:
        options.project_id && options.project_id !== this.record.project_id
          ? []
          : [structuredClone(this.record)].slice(0, options.limit),
      truncated: false,
    };
  }

  async cancelTask(taskId: string) {
    if (taskId !== this.record.task_id) throw new TaskError("task_not_found");
    if (
      this.record.state === "completed" ||
      this.record.state === "failed" ||
      this.record.state === "cancelled" ||
      this.record.state === "interrupted"
    ) {
      return structuredClone(this.record);
    }
    this.cancelCalls += 1;
    await this.cancelGate;
    this.record.state = "cancelled";
    this.record.turns[0]!.state = "cancelled";
    this.record.turns[0]!.completed_at = NOW;
    this.record.safe_error = { code: "task_cancelled" };
    this.record.turns[0]!.safe_error = this.record.safe_error;
    return structuredClone(this.record);
  }

  async close() {}
}

async function withClient<T>(
  host: TaskToolHost,
  operation: (client: Client) => Promise<T>,
): Promise<T> {
  const server = createContextBridgeServer({ taskHost: host });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "mcp-task-tests", version: "1.0.0" });
  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ]);
  try {
    return await operation(client);
  } finally {
    await client.close();
    await server.close();
  }
}

function structured<T>(result: { structuredContent?: unknown }): T {
  return result.structuredContent as T;
}

function textError(result: {
  content: Array<{ type: string; text?: string }>;
}) {
  const block = result.content.find((entry) => entry.type === "text");
  if (!block?.text) throw new Error("MCP tool returned no text error.");
  return JSON.parse(block.text) as {
    code: string;
    message: string;
    retryable: boolean;
  };
}

describe("M4B public task MCP façade", () => {
  it("enforces strict bounded input schemas", () => {
    expect(
      TaskStartInputSchema.safeParse({
        project_id: "sample-project",
        prompt: "x",
      }).success,
    ).toBe(true);
    expect(
      TaskStartInputSchema.safeParse({
        project_id: "sample-project",
        prompt: "x".repeat(32 * 1024 + 1),
      }).success,
    ).toBe(false);
    expect(
      TaskStartInputSchema.safeParse({
        project_id: "sample-project",
        prompt: "\0",
      }).success,
    ).toBe(false);
    expect(
      TaskStartInputSchema.safeParse({
        project_id: "sample-project",
        prompt: "😀".repeat(8_193),
      }).success,
    ).toBe(false);
    expect(
      TaskStartInputSchema.safeParse({
        project_id: "sample-project",
        prompt: "x",
        request_id: "x".repeat(128),
      }).success,
    ).toBe(true);
    expect(
      TaskStartInputSchema.safeParse({
        project_id: "sample-project",
        prompt: "x",
        request_id: "x".repeat(129),
      }).success,
    ).toBe(false);
    for (const requestId of [" ", "\t", "\x7f", "é"]) {
      expect(
        TaskStartInputSchema.safeParse({
          project_id: "sample-project",
          prompt: "x",
          request_id: requestId,
        }).success,
      ).toBe(false);
    }
    expect(
      TaskStartInputSchema.safeParse({
        project_id: "sample-project",
        prompt: "x",
        extra: "rejected",
      }).success,
    ).toBe(false);
    expect(
      TaskGetInputSchema.safeParse({ task_id: randomUUID(), wait_ms: 30_001 })
        .success,
    ).toBe(false);
    expect(TasksListInputSchema.safeParse({ limit: 101 }).success).toBe(false);
  });

  it("registers thirteen stdio-capable tools with the exact task annotations", async () => {
    const host = new MemoryTaskHost();
    await withClient(host, async (client) => {
      const result = await client.listTools();
      expect(result.tools.map((tool) => tool.name).sort()).toEqual([
        "file_read",
        "files_list",
        "files_search",
        "git_diff",
        "git_log",
        "git_show",
        "git_status",
        "project_get",
        "projects_list",
        "task_cancel",
        "task_get",
        "task_start",
        "tasks_list",
      ]);
      const tools = new Map(result.tools.map((tool) => [tool.name, tool]));
      expect(tools.get("task_start")?.annotations).toMatchObject({
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: false,
      });
      for (const name of ["task_get", "tasks_list"]) {
        expect(tools.get(name)?.annotations).toMatchObject({
          readOnlyHint: true,
          destructiveHint: false,
          openWorldHint: false,
        });
      }
      expect(tools.get("task_cancel")?.annotations).toMatchObject({
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
      });
      expect(tools.get("task_cancel")?.description).toContain(
        "partial workspace edits",
      );
    });
  });

  it("maps accepted starts, events, turns, baselines, usage, and list fields without private data", async () => {
    const host = new MemoryTaskHost();
    await withClient(host, async (client) => {
      const started = await client.callTool({
        name: "task_start",
        arguments: {
          project_id: "sample-project",
          prompt: "Change one value.",
          request_id: "m4b-idempotency-test",
        },
      });
      expect(started.isError).not.toBe(true);
      const startOutput =
        structured<z.infer<typeof TaskAcceptedOutputSchema>>(started);
      expect(startOutput).toMatchObject({
        project_id: "sample-project",
        state: "running",
        turn_number: 1,
        profile: "luna-max",
        mode: "default",
      });
      expect(host.startInput).toMatchObject({
        project_id: "sample-project",
        prompt: "Change one value.",
        mode: "default",
      });
      const replay = await client.callTool({
        name: "task_start",
        arguments: {
          project_id: "sample-project",
          prompt: "Change one value.",
          request_id: "m4b-idempotency-test",
        },
      });
      expect(
        structured<z.infer<typeof TaskAcceptedOutputSchema>>(replay),
      ).toEqual(startOutput);
      expect(host.startCalls).toBe(2);
      const conflict = await client.callTool({
        name: "task_start",
        arguments: {
          project_id: "sample-project",
          prompt: "A different task payload.",
          request_id: "m4b-idempotency-test",
        },
      });
      expect(textError(conflict)).toMatchObject({
        code: "request_id_conflict",
        retryable: false,
      });
      expect(Object.keys(startOutput).sort()).toEqual([
        "created_at",
        "display_name",
        "mode",
        "profile",
        "project_id",
        "state",
        "task_id",
        "turn_number",
        "updated_at",
      ]);

      const got = await client.callTool({
        name: "task_get",
        arguments: {
          task_id: startOutput.task_id,
          after_seq: 1,
          max_events: 2,
          include_final_response: false,
        },
      });
      const getOutput = structured<z.infer<typeof TaskGetOutputSchema>>(got);
      expect(getOutput.events.map((event) => event.seq)).toEqual([2, 3]);
      expect(getOutput.events.map((event) => event.category)).toEqual([
        "turn",
        "turn",
      ]);
      expect(getOutput.events[1]?.status).toBe("in_progress");
      expect(getOutput.has_more).toBe(true);
      expect(getOutput.next_after_seq).toBe(3);
      expect(getOutput.truncation.events).toBe(true);
      expect(getOutput.final_response).toBeNull();
      expect(getOutput.final_response_included).toBe(false);
      expect(getOutput.truncation.final_response).toBe(false);
      expect(getOutput.current_turn).toMatchObject({
        profile: "luna-max",
        mode: "default",
        git_baseline: {
          staged_count: 1,
          modified_count: 2,
          deleted_count: 3,
          untracked_count: 4,
        },
        usage: {
          model_request_count: null,
          delta_quality: "unavailable",
        },
      });
      expect(getOutput.usage).toMatchObject({
        turn_delta: null,
        model_request_count: null,
      });

      const allEvents = await client.callTool({
        name: "task_get",
        arguments: { task_id: startOutput.task_id, max_events: 100 },
      });
      const allOutput =
        structured<z.infer<typeof TaskGetOutputSchema>>(allEvents);
      expect(allOutput.events.map((event) => event.category)).toEqual([
        "task",
        "turn",
        "turn",
        "user_input",
        "system",
        "system",
      ]);
      expect(allOutput.events[4]?.status).toBe("observed");
      expect(allOutput.events[5]?.status).toBe("interrupted");
      expect(allOutput.final_response).toBeNull();

      host.record = makeRecord({
        marker: 2,
        events: [
          makeEvent(3, "turn", "state_changed", "running", 1),
          makeEvent(4, "input", "activity", "waiting_for_input", 1),
        ],
      });
      const truncated = await client.callTool({
        name: "task_get",
        arguments: { task_id: host.record.task_id, max_events: 1 },
      });
      const truncatedOutput =
        structured<z.infer<typeof TaskGetOutputSchema>>(truncated);
      expect(truncatedOutput.events_truncated_before_seq).toBe(2);
      expect(truncatedOutput.truncation.events).toBe(true);

      host.record = makeRecord({ state: "completed" });
      const hiddenTruncatedFinal = await client.callTool({
        name: "task_get",
        arguments: {
          task_id: host.record.task_id,
          include_final_response: false,
        },
      });
      const hiddenFinalOutput =
        structured<z.infer<typeof TaskGetOutputSchema>>(hiddenTruncatedFinal);
      expect(hiddenFinalOutput.final_response).toBeNull();
      expect(hiddenFinalOutput.final_response_included).toBe(false);
      expect(hiddenFinalOutput.truncation.final_response).toBe(true);
      const includedFinal = await client.callTool({
        name: "task_get",
        arguments: { task_id: host.record.task_id },
      });
      const includedOutput =
        structured<z.infer<typeof TaskGetOutputSchema>>(includedFinal);
      expect(includedOutput.current_turn).toBeNull();
      expect(includedOutput.latest_turn?.state).toBe("completed");
      expect(includedOutput.final_response).toEqual({
        text: "PRIVATE_FINAL_RESPONSE",
        truncated: true,
      });

      host.listResult = { records: [host.record], truncated: true };
      const listed = await client.callTool({
        name: "tasks_list",
        arguments: { project_id: "sample-project", limit: 1 },
      });
      const listOutput = structured<{ tasks: unknown[]; truncated: boolean }>(
        listed,
      );
      expect(listOutput.truncated).toBe(true);
      expect(listOutput.tasks).toHaveLength(1);
      expect(Object.keys(listOutput.tasks[0] as object).sort()).toEqual([
        "created_at",
        "display_name",
        "latest_turn_at",
        "pending_input",
        "profile",
        "project_id",
        "state",
        "task_id",
        "turn_count",
        "updated_at",
      ]);

      const serialized = JSON.stringify([
        started,
        got,
        allEvents,
        truncated,
        listed,
      ]);
      for (const privateValue of [
        "PRIVATE_THREAD_ID",
        "PRIVATE_MODEL_ID",
        "PRIVATE_PROMPT_PREVIEW",
        "PRIVATE_FINAL_RESPONSE",
        "PRIVATE_CODEX_VERSION",
        "request_id_hash",
        "registration_id",
      ]) {
        expect(serialized).not.toContain(privateValue);
      }
    });
  });

  it("uses one bounded long-poll with the SDK AbortSignal and rereads after wake or cancellation", async () => {
    const host = new MemoryTaskHost();
    host.record = makeRecord({
      events: [],
    });
    host.record.event_seq = 0;
    host.record.events_truncated_before_seq = 0;
    host.waitUpdate = true;
    await withClient(host, async (client) => {
      const result = await client.callTool({
        name: "task_get",
        arguments: {
          task_id: host.record.task_id,
          after_seq: 0,
          wait_ms: 300,
        },
      });
      expect(
        structured<z.infer<typeof TaskGetOutputSchema>>(result).state,
      ).toBe("completed");
      expect(host.waitCalls).toHaveLength(1);
      expect(host.waitCalls[0]).toMatchObject({
        afterSeq: 0,
        waitMs: 300,
      });
      expect(host.waitCalls[0]?.signal).toBeInstanceOf(AbortSignal);
    });

    const cancelledWaitHost = new MemoryTaskHost();
    cancelledWaitHost.record = makeRecord({ events: [] });
    cancelledWaitHost.record.event_seq = 0;
    cancelledWaitHost.waitError = new TaskError("task_wait_aborted");
    await withClient(cancelledWaitHost, async (client) => {
      const result = await client.callTool({
        name: "task_get",
        arguments: {
          task_id: cancelledWaitHost.record.task_id,
          wait_ms: 100,
        },
      });
      expect(result.isError).not.toBe(true);
      expect(
        structured<z.infer<typeof TaskGetOutputSchema>>(result).state,
      ).toBe("running");
    });
  });

  it("sanitizes mode and task errors and returns only the cancellation state", async () => {
    const host = new MemoryTaskHost();
    await withClient(host, async (client) => {
      const unsupported = await client.callTool({
        name: "task_start",
        arguments: {
          project_id: "sample-project",
          prompt: "Do not start a Plan turn.",
          mode: "plan",
        },
      });
      expect(unsupported.isError).toBe(true);
      expect(textError(unsupported)).toEqual({
        code: "unsupported_task_mode",
        message:
          "Only the default Codex execution mode is available in this milestone.",
        retryable: false,
      });
      expect(JSON.stringify(unsupported)).not.toContain("raw internal");

      const cancelled = await client.callTool({
        name: "task_cancel",
        arguments: { task_id: host.record.task_id },
      });
      expect(
        structured<z.infer<typeof TaskCancelOutputSchema>>(cancelled),
      ).toEqual({ task_id: host.record.task_id, state: "cancelled" });

      host.getError = new Error("C:\\private\\root and SECRET_MARKER");
      const hiddenFailure = await client.callTool({
        name: "task_get",
        arguments: { task_id: host.record.task_id },
      });
      expect(textError(hiddenFailure)).toEqual({
        code: "internal_error",
        message: "The requested task operation failed.",
        retryable: false,
      });
      expect(JSON.stringify(hiddenFailure)).not.toContain("SECRET_MARKER");

      host.getError = new TaskError("task_registration_stale");
      const stale = await client.callTool({
        name: "task_get",
        arguments: { task_id: host.record.task_id },
      });
      expect(textError(stale)).toMatchObject({
        code: "task_registration_stale",
        retryable: false,
      });
    });
  });

  it("sanitizes authorization, adapter, and task errors and waits for cancellation settlement", async () => {
    const host = new MemoryTaskHost();
    host.startError = new ContextBridgeError(
      "agent_disabled",
      "C:\\private\\root AUTH_MARKER",
    );
    await withClient(host, async (client) => {
      const authorization = await client.callTool({
        name: "task_start",
        arguments: { project_id: "sample-project", prompt: "Start." },
      });
      expect(textError(authorization)).toMatchObject({
        code: "agent_disabled",
        retryable: false,
      });
      expect(JSON.stringify(authorization)).not.toContain("AUTH_MARKER");

      host.startError = new AgentAdapterError("app_server_protocol_error");
      const appServerError = await client.callTool({
        name: "task_start",
        arguments: { project_id: "sample-project", prompt: "Start." },
      });
      expect(textError(appServerError)).toEqual({
        code: "app_server_error",
        message: "The local Codex App Server returned an unsupported response.",
        retryable: false,
      });

      host.startError = new TaskError("request_id_conflict");
      const taskError = await client.callTool({
        name: "task_start",
        arguments: { project_id: "sample-project", prompt: "Start." },
      });
      expect(textError(taskError)).toMatchObject({
        code: "request_id_conflict",
        retryable: false,
      });

      host.startError = undefined;
      host.record = makeRecord();
      let release!: () => void;
      host.cancelGate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const pendingCancel = client.callTool({
        name: "task_cancel",
        arguments: { task_id: host.record.task_id },
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(host.cancelCalls).toBe(1);
      release();
      const cancelled = await pendingCancel;
      expect(
        structured<z.infer<typeof TaskCancelOutputSchema>>(cancelled).state,
      ).toBe("cancelled");

      const repeated = await client.callTool({
        name: "task_cancel",
        arguments: { task_id: host.record.task_id },
      });
      expect(
        structured<z.infer<typeof TaskCancelOutputSchema>>(repeated).state,
      ).toBe("cancelled");
      expect(host.cancelCalls).toBe(1);

      host.record = makeRecord({ state: "interrupted" });
      const interrupted = await client.callTool({
        name: "task_cancel",
        arguments: { task_id: host.record.task_id },
      });
      expect(
        structured<z.infer<typeof TaskCancelOutputSchema>>(interrupted).state,
      ).toBe("interrupted");
      expect(host.cancelCalls).toBe(1);
    });
  });

  it("rejects private fields at the complete-output schema boundary", () => {
    const record = makeRecord();
    expect(() =>
      TaskAcceptedOutputSchema.parse({
        task_id: record.task_id,
        project_id: record.project_id,
        display_name: record.display_name,
        state: record.state,
        turn_number: 1,
        profile: "luna-max",
        mode: "default",
        created_at: record.created_at,
        updated_at: record.updated_at,
        private_thread_id: record.private_thread_id,
        canonical_root: "C:\\private\\root",
        prompt_sha256: "private-hash",
      }),
    ).toThrow();
    expect(() =>
      TaskCancelOutputSchema.parse({
        task_id: record.task_id,
        state: record.state,
        registration_id: record.registration_id,
      }),
    ).toThrow();
  });
});
