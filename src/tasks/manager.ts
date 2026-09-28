import { randomUUID } from "node:crypto";
import { z } from "zod";
import { readRegistry, type ProjectRecord } from "../projects/registry.js";
import { TaskError } from "./errors.js";
import type { TaskSignals } from "./signals.js";
import { serializedTaskByteLength } from "./store.js";
import type { TaskStore } from "./store.js";
import {
  CONTINUE_IDEMPOTENCY_SCHEMA,
  MAX_EVENTS_PER_TASK,
  MAX_FINAL_RESPONSE_BYTES,
  MAX_IDEMPOTENCY_RECORDS_PER_TASK,
  MAX_TASKS,
  MAX_TOTAL_TASK_BYTES,
  MAX_TURNS_PER_TASK,
  ACTIVITY_KINDS,
  PendingInputSchema,
  START_IDEMPOTENCY_SCHEMA,
  TimestampSchema,
  TaskEventSchema,
  TaskRecordSchema,
  TokenBreakdownSchema,
  emptyActivitySummary,
  emptyTaskUsageSummary,
  emptyTurnUsage,
  hashText,
  isTaskUuid,
  summarizePrompt,
  truncateUtf8,
  type FinalResponse,
  type ActivityKind,
  type GitBaseline,
  type IdempotencyRecord,
  type PendingInput,
  type SafeTaskErrorCode,
  type TaskEvent,
  type TaskMode,
  type TaskRecord,
  type TaskState,
  type TaskView,
  type TokenBreakdown,
} from "./types.js";

const IntentBindingSchema = z
  .object({
    project_id: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    display_name: z
      .string()
      .min(1)
      .max(256)
      .refine((value) => isSafeDisplayName(value)),
    registration_id: z.string().uuid(),
    registration_added_at: TimestampSchema,
  })
  .strict();

const IntentMetadataSchema = z
  .object({
    profile: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    model_id: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/),
    mode: z.enum(["default", "plan"]).optional(),
    request_id: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[\x21-\x7e]+$/)
      .optional(),
  })
  .strict();

const StartIntentSchema = IntentBindingSchema.extend({
  prompt: z.string(),
})
  .merge(IntentMetadataSchema)
  .strict();

const ContinueIntentSchema = z
  .object({
    task_id: z.string().uuid(),
    prompt: z.string(),
    profile: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
      .optional(),
    model_id: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/)
      .optional(),
    mode: z.enum(["default", "plan"]).optional(),
    request_id: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[\x21-\x7e]+$/)
      .optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.profile !== undefined && value.model_id === undefined) {
      context.addIssue({ code: "custom", message: "resolved model required" });
    }
  });

export type CreateTaskIntentInput = z.infer<typeof StartIntentSchema>;
export type AppendTurnIntentInput = z.infer<typeof ContinueIntentSchema>;

export interface TaskAllocation {
  task_id: string;
  turn_number: number;
  replayed: boolean;
}

export interface TaskListItem {
  task_id: string;
  project_id: string;
  display_name: string;
  state: TaskState;
  created_at: string;
  updated_at: string;
  current_profile: string;
  turn_count: number;
  local_action_required: boolean;
  event_seq: number;
  events_truncated_before_seq: number;
}

export interface NewTaskEvent {
  turn_number: number | null;
  category: TaskEvent["category"];
  kind: TaskEvent["kind"];
  status: TaskEvent["status"];
  duration_ms?: number | null;
}

export function appendTaskEventToRecord(
  record: TaskRecord,
  input: NewTaskEvent,
  timestamp = new Date().toISOString(),
): void {
  if (record.event_seq >= Number.MAX_SAFE_INTEGER) {
    throw new TaskError("task_store_capacity");
  }
  const parsed = TaskEventSchema.safeParse({
    seq: record.event_seq + 1,
    timestamp,
    turn_number: input.turn_number,
    category: input.category,
    kind: input.kind,
    status: input.status,
    duration_ms: input.duration_ms ?? null,
  });
  if (!parsed.success) throw new TaskError("task_store_error");
  record.event_seq = parsed.data.seq;
  record.events.push(parsed.data);
  if (record.events.length > MAX_EVENTS_PER_TASK) {
    const removed = record.events.shift();
    if (removed) record.events_truncated_before_seq = removed.seq;
  }
}

function canonicalPayloadHash(value: Record<string, string | number>): string {
  const canonical = Object.fromEntries(
    Object.entries(value).sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0,
    ),
  );
  return hashText(JSON.stringify(canonical));
}

export function hashRequestId(requestId: string): string {
  if (!/^[\x21-\x7e]{1,128}$/.test(requestId)) {
    throw new TaskError("task_invalid_input");
  }
  return hashText(requestId);
}

export function assertUniquePersistedIdempotency(records: TaskRecord[]): void {
  const seen = new Set<string>();
  for (const record of records) {
    for (const entry of record.idempotency) {
      if (seen.has(entry.request_id_hash)) {
        throw new TaskError("task_store_error");
      }
      seen.add(entry.request_id_hash);
    }
  }
}

function isTerminal(state: TaskState): boolean {
  return (
    state === "completed" ||
    state === "failed" ||
    state === "cancelled" ||
    state === "interrupted"
  );
}

const MAX_ACTIVITY_DURATION_MS = 24 * 60 * 60 * 1_000;
const TOKEN_BREAKDOWN_FIELDS = [
  "input_tokens",
  "cached_input_tokens",
  "cache_write_input_tokens",
  "output_tokens",
  "reasoning_output_tokens",
  "total_tokens",
] as const satisfies readonly (keyof TokenBreakdown)[];

function isCompleteTokenBreakdown(
  value: TokenBreakdown | null,
): value is TokenBreakdown {
  return (
    value !== null &&
    TOKEN_BREAKDOWN_FIELDS.every((field) => {
      const count = value[field];
      return typeof count === "number" && Number.isSafeInteger(count);
    })
  );
}

function finalizeTurnUsage(
  record: TaskRecord,
  turnNumber: number,
  terminalObserved: boolean,
): void {
  const turn = record.turns[turnNumber - 1];
  if (!turn) throw new TaskError("task_store_error");
  const hadSnapshot = turn.usage.latest_last !== null;
  const alreadyDegraded = turn.usage.delta_quality === "degraded";
  turn.usage.turn_delta = null;
  if (!terminalObserved) {
    turn.usage.end_total = null;
    turn.usage.delta_quality =
      hadSnapshot || alreadyDegraded ? "degraded" : "unavailable";
    record.usage_summary.delta_quality = turn.usage.delta_quality;
    return;
  }
  if (!hadSnapshot) {
    turn.usage.end_total = null;
    turn.usage.delta_quality = alreadyDegraded ? "degraded" : "unavailable";
  } else {
    const end = record.usage_summary.thread_total;
    turn.usage.end_total = safeClone(end);
    const start = turn.usage.start_total;
    if (
      alreadyDegraded ||
      !isCompleteTokenBreakdown(start) ||
      !isCompleteTokenBreakdown(end)
    ) {
      turn.usage.delta_quality = "degraded";
    } else {
      const delta = {} as TokenBreakdown;
      let monotonic = true;
      for (const field of TOKEN_BREAKDOWN_FIELDS) {
        const startCount = start[field];
        const endCount = end[field];
        if (
          typeof startCount !== "number" ||
          typeof endCount !== "number" ||
          endCount < startCount
        ) {
          monotonic = false;
          break;
        }
        delta[field] = endCount - startCount;
      }
      if (monotonic) {
        turn.usage.turn_delta = delta;
        turn.usage.delta_quality = "authoritative_delta";
      } else {
        turn.usage.delta_quality = "degraded";
      }
    }
  }
  record.usage_summary.delta_quality = turn.usage.delta_quality;
}

function incrementActivityCount(value: number): number {
  if (value >= Number.MAX_SAFE_INTEGER) {
    throw new TaskError("task_store_capacity");
  }
  return value + 1;
}

function errorCodeForState(state: TaskState): SafeTaskErrorCode | null {
  if (state === "failed") return "task_failed";
  if (state === "cancelled") return "task_cancelled";
  if (state === "interrupted") return "task_interrupted";
  return null;
}

function safeClone<T>(value: T): T {
  return structuredClone(value);
}

function isWellFormedThreadId(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function isSafeDisplayName(value: string): boolean {
  if (value.includes("/") || value.includes("\\")) return false;
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit < 0x20 || unit === 0x7f) return false;
  }
  return true;
}

function containsControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit < 0x20 || unit === 0x7f) return true;
  }
  return false;
}

function normalizeTaskId(taskId: string): string {
  if (!isTaskUuid(taskId)) throw new TaskError("task_not_found");
  return taskId.toLowerCase();
}

function registrationMatchesTask(
  record: TaskRecord,
  project: ProjectRecord | undefined,
): project is ProjectRecord {
  return Boolean(
    project &&
    project.id === record.project_id &&
    project.name === record.display_name &&
    project.registrationId === record.registration_id &&
    project.addedAt === record.registration_added_at,
  );
}

export function toTaskListItem(record: TaskRecord): TaskListItem {
  return {
    task_id: record.task_id,
    project_id: record.project_id,
    display_name: record.display_name,
    state: record.state,
    created_at: record.created_at,
    updated_at: record.updated_at,
    current_profile: record.current_profile,
    turn_count: record.turn_count,
    local_action_required: record.local_action_required,
    event_seq: record.event_seq,
    events_truncated_before_seq: record.events_truncated_before_seq,
  };
}

export function toTaskView(
  record: TaskRecord,
  currentProject: ProjectRecord | undefined,
): TaskView {
  if (!registrationMatchesTask(record, currentProject)) {
    throw new TaskError("task_registration_stale");
  }
  return {
    ...toTaskListItem(record),
    events: safeClone(record.events),
    final_response: safeClone(record.final_response),
  };
}

type IdempotencyIndexValue = IdempotencyRecord;
type OwnerAssertion = () => void;

export class TaskManager {
  private readonly taskIds = new Set<string>();
  private readonly idempotency = new Map<string, IdempotencyIndexValue>();
  private readonly taskByteLengths = new Map<string, number>();
  private totalBytes = 0;
  private readonly taskQueues = new Map<string, Promise<void>>();
  private readonly requestQueues = new Map<string, Promise<void>>();
  private readonly createQueues = new Map<string, Promise<void>>();

  constructor(
    private readonly store: TaskStore,
    private readonly signals: TaskSignals,
    private readonly assertOwner: OwnerAssertion,
    initialRecords: TaskRecord[],
  ) {
    assertUniquePersistedIdempotency(initialRecords);
    for (const record of initialRecords) {
      this.taskIds.add(record.task_id);
      const byteLength = serializedTaskByteLength(record);
      this.taskByteLengths.set(record.task_id, byteLength);
      this.totalBytes += byteLength;
      for (const entry of record.idempotency) {
        this.idempotency.set(entry.request_id_hash, entry);
      }
    }
    if (
      this.taskIds.size > MAX_TASKS ||
      this.totalBytes > MAX_TOTAL_TASK_BYTES
    ) {
      throw new TaskError("task_store_capacity");
    }
  }

  async createTaskIntent(
    input: CreateTaskIntentInput,
    requestLockHeld = false,
  ): Promise<TaskAllocation> {
    this.assertOwner();
    const parsed = StartIntentSchema.safeParse(input);
    if (!parsed.success) throw new TaskError("task_invalid_input");
    const intent = parsed.data;
    let prompt;
    try {
      prompt = summarizePrompt(intent.prompt);
    } catch {
      throw new TaskError("task_invalid_input");
    }
    const mode = intent.mode ?? "default";
    const semanticPayload = START_IDEMPOTENCY_SCHEMA.safeParse({
      operation: "start",
      project_id: intent.project_id,
      display_name: intent.display_name,
      registration_id: intent.registration_id.toLowerCase(),
      registration_added_at: intent.registration_added_at,
      prompt_sha256: prompt.prompt_sha256,
      profile: intent.profile,
      model_id: intent.model_id,
      mode,
    });
    if (!semanticPayload.success) throw new TaskError("task_store_error");
    const payloadHash = canonicalPayloadHash(
      semanticPayload.data as unknown as Record<string, string | number>,
    );
    const requestHash = intent.request_id
      ? hashRequestId(intent.request_id)
      : undefined;
    const operation = async (): Promise<TaskAllocation> => {
      if (requestHash) {
        const replay = await this.findReplay(requestHash, payloadHash, "start");
        if (replay) return replay;
      }
      return this.withKeyQueue(this.createQueues, "capacity", async () => {
        if (this.taskIds.size >= MAX_TASKS) {
          throw new TaskError("task_store_capacity");
        }
        const now = new Date().toISOString();
        const taskId = randomUUID();
        const turn = {
          turn_number: 1,
          state: "queued" as const,
          mode,
          profile: intent.profile,
          model_id: intent.model_id,
          created_at: now,
          started_at: null,
          completed_at: null,
          prompt_preview: prompt.prompt_preview,
          prompt_sha256: prompt.prompt_sha256,
          git_baseline: null,
          input_wait_ms: 0,
          input_wait_count: 0,
          final_response: null,
          safe_error: null,
          usage: emptyTurnUsage(),
          activity_summary: emptyActivitySummary(),
        };
        const record: TaskRecord = {
          schema_version: 1,
          task_id: taskId,
          project_id: intent.project_id,
          display_name: intent.display_name,
          registration_id: intent.registration_id.toLowerCase(),
          registration_added_at: intent.registration_added_at,
          state: "queued",
          created_at: now,
          updated_at: now,
          current_profile: intent.profile,
          detected_codex_version: null,
          private_thread_id: null,
          turn_count: 1,
          turns: [turn],
          idempotency: [],
          events: [],
          event_seq: 0,
          events_truncated_before_seq: 0,
          pending_input: null,
          local_action_required: false,
          final_response: null,
          safe_error: null,
          usage_summary: emptyTaskUsageSummary(),
        };
        if (requestHash) {
          record.idempotency.push({
            request_id_hash: requestHash,
            operation: "start",
            payload_hash: payloadHash,
            task_id: taskId,
            turn_number: 1,
          });
        }
        appendTaskEventToRecord(
          record,
          {
            turn_number: 1,
            category: "lifecycle",
            kind: "created",
            status: "queued",
          },
          now,
        );
        const byteLength = serializedTaskByteLength(record);
        if (this.totalBytes + byteLength > MAX_TOTAL_TASK_BYTES) {
          throw new TaskError("task_store_capacity");
        }
        await this.store.create(record);
        this.taskIds.add(taskId);
        this.taskByteLengths.set(taskId, byteLength);
        this.totalBytes += byteLength;
        if (requestHash) {
          const entry = record.idempotency[0];
          if (!entry) throw new TaskError("task_store_error");
          this.idempotency.set(requestHash, entry);
        }
        this.signals.notify(taskId);
        return { task_id: taskId, turn_number: 1, replayed: false };
      });
    };
    return requestHash && !requestLockHeld
      ? this.withKeyQueue(this.requestQueues, requestHash, operation)
      : operation();
  }

  async withStartRequestLock<T>(
    requestId: string | undefined,
    operation: () => Promise<T>,
  ): Promise<T> {
    this.assertOwner();
    if (requestId === undefined) return operation();
    const requestHash = hashRequestId(requestId);
    return this.withKeyQueue(this.requestQueues, requestHash, operation);
  }

  async findStartReplay(
    input: CreateTaskIntentInput,
  ): Promise<TaskAllocation | undefined> {
    this.assertOwner();
    const parsed = StartIntentSchema.safeParse(input);
    if (!parsed.success) throw new TaskError("task_invalid_input");
    const intent = parsed.data;
    if (!intent.request_id) return undefined;
    let prompt;
    try {
      prompt = summarizePrompt(intent.prompt);
    } catch {
      throw new TaskError("task_invalid_input");
    }
    const payload = START_IDEMPOTENCY_SCHEMA.safeParse({
      operation: "start",
      project_id: intent.project_id,
      display_name: intent.display_name,
      registration_id: intent.registration_id.toLowerCase(),
      registration_added_at: intent.registration_added_at,
      prompt_sha256: prompt.prompt_sha256,
      profile: intent.profile,
      model_id: intent.model_id,
      mode: intent.mode ?? "default",
    });
    if (!payload.success) throw new TaskError("task_store_error");
    const payloadHash = canonicalPayloadHash(
      payload.data as unknown as Record<string, string | number>,
    );
    return this.findReplay(
      hashRequestId(intent.request_id),
      payloadHash,
      "start",
    );
  }

  async appendTurnIntent(
    input: AppendTurnIntentInput,
    requestLockHeld = false,
  ): Promise<TaskAllocation> {
    this.assertOwner();
    const parsed = ContinueIntentSchema.safeParse(input);
    if (!parsed.success) throw new TaskError("task_invalid_input");
    const intent = {
      ...parsed.data,
      task_id: parsed.data.task_id.toLowerCase(),
    };
    const requestHash = intent.request_id
      ? hashRequestId(intent.request_id)
      : undefined;
    const operation = async (): Promise<TaskAllocation> => {
      const replay = await this.findContinueReplayForIntent(intent);
      if (replay) return replay;

      return this.withKeyQueue(this.taskQueues, intent.task_id, async () => {
        const record = await this.store.read(intent.task_id);
        if (!isTerminal(record.state) || record.local_action_required)
          throw new TaskError("task_state_conflict");
        if (record.turn_count >= MAX_TURNS_PER_TASK) {
          throw new TaskError("task_store_capacity");
        }
        const turnNumber = record.turn_count + 1;
        const prompt = this.summarizeIntentPrompt(intent.prompt);
        const profile = intent.profile ?? record.current_profile;
        const priorTurn = record.turns.at(-1);
        if (!priorTurn) throw new TaskError("task_store_error");
        const modelId = intent.model_id ?? priorTurn.model_id;
        const mode = intent.mode ?? "default";
        const payloadHash = this.continuePayloadHash(
          record,
          turnNumber,
          prompt.prompt_sha256,
          profile,
          modelId,
          mode,
        );
        const now = new Date().toISOString();
        const turn = {
          turn_number: turnNumber,
          state: "queued" as const,
          mode,
          profile,
          model_id: modelId,
          created_at: now,
          started_at: null,
          completed_at: null,
          prompt_preview: prompt.prompt_preview,
          prompt_sha256: prompt.prompt_sha256,
          git_baseline: null,
          input_wait_ms: 0,
          input_wait_count: 0,
          final_response: null,
          safe_error: null,
          usage: emptyTurnUsage(),
          activity_summary: emptyActivitySummary(),
        };
        record.turns.push(turn);
        record.turn_count = turnNumber;
        record.state = "queued";
        record.updated_at = now;
        record.current_profile = profile;
        record.pending_input = null;
        record.local_action_required = false;
        record.final_response = null;
        record.safe_error = null;
        if (requestHash) {
          if (record.idempotency.length >= MAX_IDEMPOTENCY_RECORDS_PER_TASK) {
            throw new TaskError("task_store_capacity");
          }
          record.idempotency.push({
            request_id_hash: requestHash,
            operation: "continue",
            payload_hash: payloadHash,
            task_id: record.task_id,
            turn_number: turnNumber,
          });
        }
        appendTaskEventToRecord(
          record,
          {
            turn_number: turnNumber,
            category: "turn",
            kind: "turn_queued",
            status: "queued",
          },
          now,
        );
        await this.persistReplacement(record);
        if (requestHash) {
          const entry = record.idempotency.at(-1);
          if (!entry) throw new TaskError("task_store_error");
          this.idempotency.set(requestHash, entry);
        }
        this.signals.notify(record.task_id);
        return {
          task_id: record.task_id,
          turn_number: turnNumber,
          replayed: false,
        };
      });
    };
    return requestHash && !requestLockHeld
      ? this.withKeyQueue(this.requestQueues, requestHash, operation)
      : operation();
  }

  async findContinueReplay(
    input: AppendTurnIntentInput,
  ): Promise<TaskAllocation | undefined> {
    this.assertOwner();
    const parsed = ContinueIntentSchema.safeParse(input);
    if (!parsed.success) throw new TaskError("task_invalid_input");
    const intent = {
      ...parsed.data,
      task_id: parsed.data.task_id.toLowerCase(),
    };
    if (!intent.request_id) return undefined;
    return this.findContinueReplayForIntent(intent);
  }

  private async findContinueReplayForIntent(
    intent: z.infer<typeof ContinueIntentSchema> & { task_id: string },
  ): Promise<TaskAllocation | undefined> {
    if (!intent.request_id) return undefined;
    const existing = this.idempotency.get(hashRequestId(intent.request_id));
    if (!existing) return undefined;
    if (
      existing.operation !== "continue" ||
      existing.task_id !== intent.task_id
    ) {
      throw new TaskError("request_id_conflict");
    }
    const record = await this.store.read(existing.task_id);
    const turn = record.turns[existing.turn_number - 1];
    if (!turn) throw new TaskError("task_store_error");
    const prompt = this.summarizeIntentPrompt(intent.prompt);
    const payloadHash = this.continuePayloadHash(
      record,
      existing.turn_number,
      prompt.prompt_sha256,
      intent.profile ?? turn.profile,
      intent.model_id ?? turn.model_id,
      intent.mode ?? "default",
    );
    if (existing.payload_hash !== payloadHash) {
      throw new TaskError("request_id_conflict");
    }
    return {
      task_id: existing.task_id,
      turn_number: existing.turn_number,
      replayed: true,
    };
  }

  async transitionTurn(
    taskId: string,
    turnNumber: number,
    nextState: TaskState,
    terminalObserved = false,
  ): Promise<TaskRecord> {
    this.assertOwner();
    taskId = normalizeTaskId(taskId);
    return this.withKeyQueue(this.taskQueues, taskId, async () => {
      const record = await this.store.read(taskId);
      const turn = record.turns[turnNumber - 1];
      if (
        !turn ||
        turn.turn_number !== turnNumber ||
        turnNumber !== record.turn_count ||
        nextState === "waiting_for_input" ||
        (turn.state === "waiting_for_input" && nextState === "running") ||
        !this.canTransition(turn.state, nextState)
      ) {
        throw new TaskError("task_state_conflict");
      }
      const now = new Date().toISOString();
      if (record.pending_input) {
        const waitMs = Math.max(
          0,
          Date.parse(now) - Date.parse(record.pending_input.received_at),
        );
        if (turn.input_wait_ms + waitMs > Number.MAX_SAFE_INTEGER) {
          throw new TaskError("task_store_capacity");
        }
        turn.input_wait_ms += waitMs;
      }
      turn.state = nextState;
      if (nextState === "running" && turn.started_at === null) {
        turn.started_at = now;
      }
      if (isTerminal(nextState)) turn.completed_at = now;
      if (nextState === "queued") turn.completed_at = null;
      turn.safe_error = errorCodeForState(nextState)
        ? { code: errorCodeForState(nextState)! }
        : null;
      if (isTerminal(nextState)) {
        finalizeTurnUsage(record, turnNumber, terminalObserved);
      }
      record.state = nextState;
      record.updated_at = now;
      record.pending_input = null;
      record.safe_error = turn.safe_error;
      appendTaskEventToRecord(
        record,
        {
          turn_number: turnNumber,
          category: "turn",
          kind: "state_changed",
          status: nextState,
        },
        now,
      );
      await this.persistReplacement(record);
      this.signals.notify(taskId);
      return record;
    });
  }

  async beginPendingInput(
    taskId: string,
    turnNumber: number,
    pendingInput: PendingInput,
  ): Promise<TaskRecord> {
    this.assertOwner();
    taskId = normalizeTaskId(taskId);
    const parsed = PendingInputSchema.safeParse(pendingInput);
    if (!parsed.success || parsed.data.turn_number !== turnNumber) {
      throw new TaskError("task_invalid_input");
    }
    return this.withKeyQueue(this.taskQueues, taskId, async () => {
      const record = await this.store.read(taskId);
      const turn = record.turns[turnNumber - 1];
      if (
        !turn ||
        turnNumber !== record.turn_count ||
        turn.state !== "running" ||
        record.state !== "running" ||
        record.pending_input !== null ||
        record.local_action_required ||
        turn.input_wait_count >= Number.MAX_SAFE_INTEGER
      ) {
        throw new TaskError("task_state_conflict");
      }
      const now = new Date().toISOString();
      turn.state = "waiting_for_input";
      turn.input_wait_count += 1;
      record.state = "waiting_for_input";
      record.pending_input = structuredClone(parsed.data);
      record.updated_at = now;
      appendTaskEventToRecord(
        record,
        {
          turn_number: turnNumber,
          category: "input",
          kind: "state_changed",
          status: "waiting_for_input",
        },
        now,
      );
      await this.persistReplacement(record);
      this.signals.notify(taskId);
      return record;
    });
  }

  async resolvePendingInput(
    taskId: string,
    turnNumber: number,
    pendingInputId: string,
  ): Promise<TaskRecord> {
    this.assertOwner();
    taskId = normalizeTaskId(taskId);
    if (!isTaskUuid(pendingInputId)) throw new TaskError("task_invalid_input");
    pendingInputId = pendingInputId.toLowerCase();
    return this.withKeyQueue(this.taskQueues, taskId, async () => {
      const record = await this.store.read(taskId);
      const turn = record.turns[turnNumber - 1];
      const pending = record.pending_input;
      if (
        !turn ||
        turnNumber !== record.turn_count ||
        turn.state !== "waiting_for_input" ||
        record.state !== "waiting_for_input" ||
        !pending ||
        pending.turn_number !== turnNumber ||
        pending.pending_input_id !== pendingInputId
      ) {
        throw new TaskError("pending_input_stale");
      }
      const now = new Date().toISOString();
      const waitMs = Math.max(
        0,
        Date.parse(now) - Date.parse(pending.received_at),
      );
      if (turn.input_wait_ms + waitMs > Number.MAX_SAFE_INTEGER) {
        throw new TaskError("task_store_capacity");
      }
      turn.input_wait_ms += waitMs;
      turn.state = "running";
      record.state = "running";
      record.pending_input = null;
      record.updated_at = now;
      appendTaskEventToRecord(
        record,
        {
          turn_number: turnNumber,
          category: "input",
          kind: "state_changed",
          status: "running",
        },
        now,
      );
      appendTaskEventToRecord(
        record,
        {
          turn_number: turnNumber,
          category: "input",
          kind: "activity",
          status: "saved",
          duration_ms: waitMs,
        },
        now,
      );
      await this.persistReplacement(record);
      this.signals.notify(taskId);
      return record;
    });
  }

  async requireLocalAction(
    taskId: string,
    turnNumber: number,
    terminalObserved = false,
  ): Promise<TaskRecord> {
    this.assertOwner();
    taskId = normalizeTaskId(taskId);
    return this.withKeyQueue(this.taskQueues, taskId, async () => {
      const record = await this.store.read(taskId);
      const turn = record.turns[turnNumber - 1];
      if (
        !turn ||
        turnNumber !== record.turn_count ||
        !["running", "waiting_for_input"].includes(turn.state) ||
        record.state !== turn.state
      ) {
        if (record.local_action_required) return record;
        throw new TaskError("task_state_conflict");
      }
      const now = new Date().toISOString();
      if (record.pending_input) {
        const waitMs = Math.max(
          0,
          Date.parse(now) - Date.parse(record.pending_input.received_at),
        );
        if (turn.input_wait_ms + waitMs > Number.MAX_SAFE_INTEGER) {
          throw new TaskError("task_store_capacity");
        }
        turn.input_wait_ms += waitMs;
      }
      turn.state = "interrupted";
      turn.completed_at = now;
      turn.safe_error = { code: "secret_input_requires_local_action" };
      finalizeTurnUsage(record, turnNumber, terminalObserved);
      record.state = "interrupted";
      record.pending_input = null;
      record.local_action_required = true;
      record.safe_error = { code: "secret_input_requires_local_action" };
      record.updated_at = now;
      appendTaskEventToRecord(
        record,
        {
          turn_number: turnNumber,
          category: "input",
          kind: "state_changed",
          status: "interrupted",
        },
        now,
      );
      await this.persistReplacement(record);
      this.signals.notify(taskId);
      return record;
    });
  }

  async appendEvent(taskId: string, event: NewTaskEvent): Promise<TaskRecord> {
    this.assertOwner();
    taskId = normalizeTaskId(taskId);
    return this.withKeyQueue(this.taskQueues, taskId, async () => {
      const record = await this.store.read(taskId);
      appendTaskEventToRecord(record, event);
      record.updated_at = new Date().toISOString();
      await this.persistReplacement(record);
      this.signals.notify(taskId);
      return record;
    });
  }

  async setTurnUsageStartTotal(
    taskId: string,
    turnNumber: number,
    startTotal: TokenBreakdown | null,
  ): Promise<void> {
    this.assertOwner();
    taskId = normalizeTaskId(taskId);
    const parsed = TokenBreakdownSchema.nullable().safeParse(startTotal);
    if (!parsed.success) throw new TaskError("task_invalid_input");
    await this.withKeyQueue(this.taskQueues, taskId, async () => {
      const record = await this.store.read(taskId);
      const turn = record.turns[turnNumber - 1];
      if (
        !turn ||
        turn.turn_number !== turnNumber ||
        turnNumber !== record.turn_count ||
        turn.state !== "queued"
      ) {
        throw new TaskError("task_state_conflict");
      }
      turn.usage.start_total = safeClone(parsed.data);
      record.updated_at = new Date().toISOString();
      await this.persistReplacement(record);
      this.signals.notify(taskId);
    });
  }

  async recordThreadUsage(
    taskId: string,
    turnNumber: number,
    input: {
      total: TokenBreakdown;
      last: TokenBreakdown;
      model_context_window?: number | null;
    },
  ): Promise<void> {
    this.assertOwner();
    taskId = normalizeTaskId(taskId);
    const total = TokenBreakdownSchema.safeParse(input.total);
    const last = TokenBreakdownSchema.safeParse(input.last);
    const contextValid =
      input.model_context_window === undefined ||
      input.model_context_window === null ||
      (Number.isSafeInteger(input.model_context_window) &&
        input.model_context_window > 0);
    if (!total.success || !last.success || !contextValid) {
      throw new TaskError("task_invalid_input");
    }
    await this.withKeyQueue(this.taskQueues, taskId, async () => {
      const record = await this.store.read(taskId);
      const turn = record.turns[turnNumber - 1];
      if (
        !turn ||
        turn.turn_number !== turnNumber ||
        turnNumber !== record.turn_count ||
        (turn.state !== "running" && turn.state !== "waiting_for_input")
      ) {
        throw new TaskError("task_state_conflict");
      }
      const now = new Date().toISOString();
      const totalSnapshot = safeClone(total.data);
      const lastSnapshot = safeClone(last.data);
      const regressed = TOKEN_BREAKDOWN_FIELDS.some((field) => {
        const previous = record.usage_summary.thread_total[field];
        const current = totalSnapshot[field];
        return (
          typeof previous === "number" &&
          typeof current === "number" &&
          current < previous
        );
      });
      // Cumulative counters are monotonic. If the server reports a
      // regression, retain the last defensible total and degrade the delta
      // instead of replacing it with a lower snapshot.
      if (!regressed) record.usage_summary.thread_total = totalSnapshot;
      record.usage_summary.latest_last = lastSnapshot;
      turn.usage.latest_last = lastSnapshot;
      if (regressed) {
        turn.usage.delta_quality = "degraded";
        record.usage_summary.delta_quality = "degraded";
      }
      if (
        input.model_context_window !== undefined &&
        input.model_context_window !== null
      ) {
        record.usage_summary.model_context_window = input.model_context_window;
        turn.usage.model_context_window = input.model_context_window;
      }
      record.updated_at = now;
      appendTaskEventToRecord(
        record,
        {
          turn_number: turnNumber,
          category: "runtime",
          kind: "activity",
          status: "observed",
        },
        now,
      );
      await this.persistReplacement(record);
      this.signals.notify(taskId);
    });
  }

  async markTurnUsageDegraded(
    taskId: string,
    turnNumber: number,
  ): Promise<void> {
    this.assertOwner();
    taskId = normalizeTaskId(taskId);
    await this.withKeyQueue(this.taskQueues, taskId, async () => {
      const record = await this.store.read(taskId);
      const turn = record.turns[turnNumber - 1];
      if (
        !turn ||
        turn.turn_number !== turnNumber ||
        turnNumber !== record.turn_count ||
        (turn.state !== "running" && turn.state !== "waiting_for_input")
      ) {
        throw new TaskError("task_state_conflict");
      }
      turn.usage.delta_quality = "degraded";
      record.usage_summary.delta_quality = "degraded";
      const now = new Date().toISOString();
      record.updated_at = now;
      appendTaskEventToRecord(
        record,
        {
          turn_number: turnNumber,
          category: "runtime",
          kind: "activity",
          status: "observed",
        },
        now,
      );
      await this.persistReplacement(record);
      this.signals.notify(taskId);
    });
  }

  async recordActivityStarted(
    taskId: string,
    turnNumber: number,
    activityKind: ActivityKind,
  ): Promise<void> {
    this.assertOwner();
    taskId = normalizeTaskId(taskId);
    if (!ACTIVITY_KINDS.includes(activityKind)) {
      throw new TaskError("task_invalid_input");
    }
    await this.withKeyQueue(this.taskQueues, taskId, async () => {
      const record = await this.store.read(taskId);
      const turn = record.turns[turnNumber - 1];
      if (
        !turn ||
        turn.turn_number !== turnNumber ||
        turnNumber !== record.turn_count ||
        (turn.state !== "running" && turn.state !== "waiting_for_input")
      ) {
        throw new TaskError("task_state_conflict");
      }
      const aggregate = turn.activity_summary[activityKind];
      aggregate.started_count = incrementActivityCount(aggregate.started_count);
      const now = new Date().toISOString();
      record.updated_at = now;
      appendTaskEventToRecord(
        record,
        {
          turn_number: turnNumber,
          category: "runtime",
          kind: "activity",
          status: "observed",
        },
        now,
      );
      await this.persistReplacement(record);
      this.signals.notify(taskId);
    });
  }

  async recordActivityCompleted(
    taskId: string,
    turnNumber: number,
    activityKind: ActivityKind,
    failed: boolean,
    durationMs: number | null,
  ): Promise<void> {
    this.assertOwner();
    taskId = normalizeTaskId(taskId);
    if (
      !ACTIVITY_KINDS.includes(activityKind) ||
      typeof failed !== "boolean" ||
      (durationMs !== null &&
        (!Number.isSafeInteger(durationMs) ||
          durationMs < 0 ||
          durationMs > MAX_ACTIVITY_DURATION_MS))
    ) {
      throw new TaskError("task_invalid_input");
    }
    await this.withKeyQueue(this.taskQueues, taskId, async () => {
      const record = await this.store.read(taskId);
      const turn = record.turns[turnNumber - 1];
      if (
        !turn ||
        turn.turn_number !== turnNumber ||
        turnNumber !== record.turn_count ||
        (turn.state !== "running" && turn.state !== "waiting_for_input")
      ) {
        throw new TaskError("task_state_conflict");
      }
      const aggregate = turn.activity_summary[activityKind];
      aggregate.completed_count = incrementActivityCount(
        aggregate.completed_count,
      );
      if (failed) {
        aggregate.failed_count = incrementActivityCount(aggregate.failed_count);
      }
      if (durationMs !== null) {
        const total = (aggregate.duration_total_ms ?? 0) + durationMs;
        if (!Number.isSafeInteger(total)) {
          throw new TaskError("task_store_capacity");
        }
        aggregate.duration_sample_count = incrementActivityCount(
          aggregate.duration_sample_count,
        );
        aggregate.duration_total_ms = total;
      }
      const now = new Date().toISOString();
      record.updated_at = now;
      appendTaskEventToRecord(
        record,
        {
          turn_number: turnNumber,
          category: "runtime",
          kind: "activity",
          status: failed ? "failed" : "observed",
          duration_ms: durationMs,
        },
        now,
      );
      await this.persistReplacement(record);
      this.signals.notify(taskId);
    });
  }

  async setPrivateThreadId(taskId: string, threadId: string): Promise<void> {
    this.assertOwner();
    taskId = normalizeTaskId(taskId);
    if (
      threadId.length === 0 ||
      Buffer.byteLength(threadId, "utf8") > 512 ||
      containsControlCharacter(threadId) ||
      !isWellFormedThreadId(threadId)
    ) {
      throw new TaskError("task_invalid_input");
    }
    await this.withKeyQueue(this.taskQueues, taskId, async () => {
      const record = await this.store.read(taskId);
      record.private_thread_id = threadId;
      record.updated_at = new Date().toISOString();
      appendTaskEventToRecord(
        record,
        {
          turn_number: record.turn_count,
          category: "runtime",
          kind: "thread_bound",
          status: "saved",
        },
        record.updated_at,
      );
      await this.persistReplacement(record);
      this.signals.notify(taskId);
    });
  }

  async setGitBaseline(taskId: string, baseline: GitBaseline): Promise<void> {
    this.assertOwner();
    taskId = normalizeTaskId(taskId);
    await this.withKeyQueue(this.taskQueues, taskId, async () => {
      const record = await this.store.read(taskId);
      const turn = record.turns.at(-1);
      if (!turn || turn.state !== "queued") {
        throw new TaskError("task_state_conflict");
      }
      turn.git_baseline = structuredClone(baseline);
      record.updated_at = new Date().toISOString();
      await this.persistReplacement(record);
      this.signals.notify(taskId);
    });
  }

  async setDetectedCodexVersion(
    taskId: string,
    version: string | null,
  ): Promise<void> {
    this.assertOwner();
    taskId = normalizeTaskId(taskId);
    if (
      version !== null &&
      (version.length > 64 ||
        !/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]{1,48})?$/.test(version))
    ) {
      throw new TaskError("task_invalid_input");
    }
    await this.withKeyQueue(this.taskQueues, taskId, async () => {
      const record = await this.store.read(taskId);
      record.detected_codex_version = version;
      record.updated_at = new Date().toISOString();
      await this.persistReplacement(record);
      this.signals.notify(taskId);
    });
  }

  async setFinalResponse(taskId: string, text: string): Promise<FinalResponse> {
    this.assertOwner();
    taskId = normalizeTaskId(taskId);
    const response = truncateUtf8(text, MAX_FINAL_RESPONSE_BYTES);
    await this.withKeyQueue(this.taskQueues, taskId, async () => {
      const record = await this.store.read(taskId);
      const turn = record.turns.at(-1);
      if (!turn) throw new TaskError("task_store_error");
      turn.final_response = safeClone(response);
      record.final_response = safeClone(response);
      record.updated_at = new Date().toISOString();
      appendTaskEventToRecord(
        record,
        {
          turn_number: turn.turn_number,
          category: "turn",
          kind: "response_saved",
          status: "saved",
        },
        record.updated_at,
      );
      await this.persistReplacement(record);
      this.signals.notify(taskId);
    });
    return response;
  }

  async getTask(taskId: string): Promise<TaskRecord> {
    this.assertOwner();
    taskId = normalizeTaskId(taskId);
    return this.store.read(taskId);
  }

  async listTasks(): Promise<TaskRecord[]> {
    this.assertOwner();
    const records = await this.store.list();
    return records.sort(
      (left, right) =>
        right.updated_at.localeCompare(left.updated_at) ||
        left.task_id.localeCompare(right.task_id),
    );
  }

  async getTaskView(taskId: string): Promise<TaskView> {
    const { record, project } = await this.readRegisteredTask(taskId);
    return toTaskView(record, project);
  }

  /** Return the durable record only while its project registration still matches. */
  async getTaskRecordForCurrentRegistration(
    taskId: string,
  ): Promise<TaskRecord> {
    return (await this.readRegisteredTask(taskId)).record;
  }

  private async readRegisteredTask(taskId: string): Promise<{
    record: TaskRecord;
    project: ProjectRecord;
  }> {
    this.assertOwner();
    taskId = normalizeTaskId(taskId);
    const record = await this.store.read(taskId);
    const registry = await readRegistry().catch(() => {
      throw new TaskError("task_registration_stale");
    });
    const project = registry.projects.find(
      (entry) => entry.id === record.project_id,
    );
    if (!registrationMatchesTask(record, project)) {
      throw new TaskError("task_registration_stale");
    }
    return { record, project };
  }

  async listRegisteredTaskRecordsPage(options: {
    project_id?: string;
    limit: number;
  }): Promise<{ records: TaskRecord[]; truncated: boolean }> {
    this.assertOwner();
    if (
      !Number.isInteger(options.limit) ||
      options.limit < 1 ||
      options.limit > 100
    ) {
      throw new TaskError("task_store_error");
    }
    const registry = await readRegistry().catch(() => {
      throw new TaskError("task_registration_stale");
    });
    const projects = new Map(
      registry.projects.map((project) => [project.id, project]),
    );
    const eligible = (await this.store.list())
      .filter((record) => {
        if (options.project_id && record.project_id !== options.project_id) {
          return false;
        }
        return registrationMatchesTask(record, projects.get(record.project_id));
      })
      .sort(
        (left, right) =>
          right.updated_at.localeCompare(left.updated_at) ||
          left.task_id.localeCompare(right.task_id),
      );
    return {
      records: eligible.slice(0, options.limit),
      truncated: eligible.length > options.limit,
    };
  }

  async listTaskViews(options: {
    project_id?: string;
    limit: number;
  }): Promise<TaskListItem[]> {
    const page = await this.listRegisteredTaskRecordsPage(options);
    return page.records.map(toTaskListItem);
  }

  async waitForTask(
    taskId: string,
    afterSeq: number,
    waitMs: number,
    abortSignal?: AbortSignal,
  ): Promise<TaskRecord> {
    this.assertOwner();
    taskId = normalizeTaskId(taskId);
    return this.signals.waitForChange(
      taskId,
      afterSeq,
      waitMs,
      () => this.store.read(taskId),
      abortSignal,
    );
  }

  async drainMutations(): Promise<void> {
    while (true) {
      const pending = [
        ...this.taskQueues.values(),
        ...this.requestQueues.values(),
        ...this.createQueues.values(),
      ];
      if (pending.length === 0) return;
      await Promise.all(pending);
    }
  }

  private summarizeIntentPrompt(prompt: string): {
    prompt_preview: string;
    prompt_sha256: string;
  } {
    try {
      return summarizePrompt(prompt);
    } catch {
      throw new TaskError("task_invalid_input");
    }
  }

  private continuePayloadHash(
    record: TaskRecord,
    turnNumber: number,
    promptSha256: string,
    profile: string,
    modelId: string,
    mode: TaskMode,
  ): string {
    const semantic = CONTINUE_IDEMPOTENCY_SCHEMA.safeParse({
      operation: "continue",
      task_id: record.task_id,
      turn_number: turnNumber,
      project_id: record.project_id,
      registration_id: record.registration_id,
      registration_added_at: record.registration_added_at,
      prompt_sha256: promptSha256,
      profile,
      model_id: modelId,
      mode,
    });
    if (!semantic.success) throw new TaskError("task_store_error");
    return canonicalPayloadHash(
      semantic.data as unknown as Record<string, string | number>,
    );
  }

  private async findReplay(
    requestHash: string,
    payloadHash: string,
    operation: "start",
  ): Promise<TaskAllocation | undefined> {
    const existing = this.idempotency.get(requestHash);
    if (!existing) return undefined;
    if (
      existing.operation !== operation ||
      existing.payload_hash !== payloadHash
    ) {
      throw new TaskError("request_id_conflict");
    }
    await this.store.read(existing.task_id);
    return {
      task_id: existing.task_id,
      turn_number: existing.turn_number,
      replayed: true,
    };
  }

  private canTransition(current: TaskState, next: TaskState): boolean {
    const valid: Record<TaskState, readonly TaskState[]> = {
      queued: ["running", "failed", "cancelled", "interrupted"],
      running: [
        "waiting_for_input",
        "completed",
        "failed",
        "cancelled",
        "interrupted",
      ],
      waiting_for_input: ["running", "failed", "cancelled", "interrupted"],
      completed: [],
      failed: [],
      cancelled: [],
      interrupted: [],
    };
    return valid[current].includes(next);
  }

  private async persistReplacement(record: TaskRecord): Promise<void> {
    const parsed = TaskRecordSchema.safeParse(record);
    if (!parsed.success) throw new TaskError("task_store_error");
    const oldBytes = this.taskByteLengths.get(record.task_id);
    if (oldBytes === undefined) throw new TaskError("task_not_found");
    const newBytes = serializedTaskByteLength(parsed.data);
    const newTotal = this.totalBytes - oldBytes + newBytes;
    if (newTotal > MAX_TOTAL_TASK_BYTES) {
      throw new TaskError("task_store_capacity");
    }
    await this.store.replace(parsed.data);
    this.totalBytes = newTotal;
    this.taskByteLengths.set(record.task_id, newBytes);
  }

  private async withKeyQueue<T>(
    queues: Map<string, Promise<void>>,
    key: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = queues.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.catch(() => undefined).then(() => gate);
    queues.set(key, tail);
    await previous.catch(() => undefined);
    try {
      this.assertOwner();
      return await operation();
    } finally {
      release();
      if (queues.get(key) === tail) queues.delete(key);
    }
  }
}
