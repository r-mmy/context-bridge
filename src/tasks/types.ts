import { createHash } from "node:crypto";
import { z } from "zod";

export const MAX_TASKS = 1_000;
export const MAX_TOTAL_TASK_BYTES = 64 * 1024 * 1024;
export const MAX_TASK_FILE_BYTES = 6 * 1024 * 1024;
export const MAX_TURNS_PER_TASK = 64;
export const MAX_IDEMPOTENCY_RECORDS_PER_TASK = 128;
export const MAX_EVENTS_PER_TASK = 1_000;
export const MAX_PROMPT_BYTES = 32 * 1024;
export const MAX_PROMPT_PREVIEW_BYTES = 512;
export const MAX_FINAL_RESPONSE_BYTES = 64 * 1024;
export const MAX_TASK_WAIT_MS = 30_000;

export const TASK_STATES = [
  "queued",
  "running",
  "waiting_for_input",
  "completed",
  "failed",
  "cancelled",
  "interrupted",
] as const;

export type TaskState = (typeof TASK_STATES)[number];
export type TaskMode = "default" | "plan";
export type TaskOperation = "start" | "continue";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const KEBAB_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const HASH_PATTERN = /^[0-9a-f]{64}$/;

export function isTaskUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

function isWellFormedUnicode(value: string): boolean {
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

function boundedText(maxBytes: number) {
  return z
    .string()
    .refine(isWellFormedUnicode)
    .refine((value) => Buffer.byteLength(value, "utf8") <= maxBytes);
}

export const TimestampSchema = z
  .string()
  .max(24)
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  .refine((value) => Number.isFinite(Date.parse(value)));
const UuidSchema = z.string().regex(UUID_PATTERN);
const ProjectIdSchema = z.string().min(1).max(64).regex(KEBAB_PATTERN);
const ProfileSchema = z.string().min(1).max(64).regex(KEBAB_PATTERN);
const ModelIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/);
const NullableTimestampSchema = TimestampSchema.nullable();
const CountSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const NullableCountSchema = CountSchema.nullable();
const NullablePositiveCountSchema = z
  .number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER)
  .nullable();
function isSafeDisplayName(value: string): boolean {
  if (value.length === 0 || value.includes("/") || value.includes("\\")) {
    return false;
  }
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit < 0x20 || unit === 0x7f) return false;
  }
  return true;
}

export const TokenBreakdownSchema = z
  .object({
    input_tokens: NullableCountSchema,
    cached_input_tokens: NullableCountSchema,
    cache_write_input_tokens: NullableCountSchema,
    output_tokens: NullableCountSchema,
    reasoning_output_tokens: NullableCountSchema,
    total_tokens: NullableCountSchema,
  })
  .strict();

export type TokenBreakdown = z.infer<typeof TokenBreakdownSchema>;

const UsageQualitySchema = z.enum([
  "authoritative_delta",
  "degraded",
  "unavailable",
]);

const TurnUsageSchema = z
  .object({
    start_total: TokenBreakdownSchema.nullable(),
    end_total: TokenBreakdownSchema.nullable(),
    latest_last: TokenBreakdownSchema.nullable(),
    turn_delta: TokenBreakdownSchema.nullable(),
    model_context_window: NullablePositiveCountSchema,
    delta_quality: UsageQualitySchema,
    model_request_count: z.null(),
  })
  .strict();

const SafeErrorCodeSchema = z.enum([
  "task_failed",
  "task_interrupted",
  "task_cancelled",
  "secret_input_requires_local_action",
]);

export type SafeTaskErrorCode = z.infer<typeof SafeErrorCodeSchema>;

const SafeErrorSchema = z.object({ code: SafeErrorCodeSchema }).strict();
const DisplayNameSchema = boundedText(256).refine(isSafeDisplayName);

const TaskUsageSummarySchema = z
  .object({
    thread_total: TokenBreakdownSchema,
    latest_last: TokenBreakdownSchema.nullable(),
    model_context_window: NullablePositiveCountSchema,
    delta_quality: UsageQualitySchema,
    model_request_count: z.null(),
  })
  .strict();

export const FinalResponseSchema = z
  .object({
    text: boundedText(MAX_FINAL_RESPONSE_BYTES),
    truncated: z.boolean(),
  })
  .strict();

export type FinalResponse = z.infer<typeof FinalResponseSchema>;

export const TaskEventSchema = z
  .object({
    seq: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    timestamp: TimestampSchema,
    turn_number: z.number().int().min(1).max(MAX_TURNS_PER_TASK).nullable(),
    category: z.enum(["lifecycle", "recovery", "turn", "input", "runtime"]),
    kind: z.enum([
      "created",
      "turn_queued",
      "state_changed",
      "thread_bound",
      "response_saved",
      "recovered",
      "activity",
    ]),
    status: z.enum([
      "queued",
      "running",
      "waiting_for_input",
      "completed",
      "failed",
      "cancelled",
      "interrupted",
      "saved",
      "recovered",
      "observed",
    ]),
    duration_ms: z
      .number()
      .int()
      .min(0)
      .max(Number.MAX_SAFE_INTEGER)
      .nullable(),
  })
  .strict();

export type TaskEvent = z.infer<typeof TaskEventSchema>;

export const IdempotencyRecordSchema = z
  .object({
    request_id_hash: z.string().regex(HASH_PATTERN),
    operation: z.enum(["start", "continue"]),
    payload_hash: z.string().regex(HASH_PATTERN),
    task_id: UuidSchema,
    turn_number: z.number().int().min(1).max(MAX_TURNS_PER_TASK),
  })
  .strict();

export type IdempotencyRecord = z.infer<typeof IdempotencyRecordSchema>;

export const TurnRecordSchema = z
  .object({
    turn_number: z.number().int().min(1).max(MAX_TURNS_PER_TASK),
    state: z.enum(TASK_STATES),
    mode: z.enum(["default", "plan"]),
    profile: ProfileSchema,
    model_id: ModelIdSchema,
    created_at: TimestampSchema,
    started_at: NullableTimestampSchema,
    completed_at: NullableTimestampSchema,
    prompt_preview: boundedText(MAX_PROMPT_PREVIEW_BYTES),
    prompt_sha256: z.string().regex(HASH_PATTERN),
    git_baseline: z.null(),
    input_wait_ms: CountSchema,
    input_wait_count: CountSchema,
    final_response: FinalResponseSchema.nullable(),
    safe_error: SafeErrorSchema.nullable(),
    usage: TurnUsageSchema,
  })
  .strict();

export type TurnRecord = z.infer<typeof TurnRecordSchema>;

const TaskRecordBaseSchema = z
  .object({
    schema_version: z.literal(1),
    task_id: UuidSchema,
    project_id: ProjectIdSchema,
    display_name: DisplayNameSchema,
    registration_id: UuidSchema,
    registration_added_at: TimestampSchema,
    state: z.enum(TASK_STATES),
    created_at: TimestampSchema,
    updated_at: TimestampSchema,
    current_profile: ProfileSchema,
    detected_codex_version: boundedText(64).nullable(),
    private_thread_id: boundedText(512).nullable(),
    turn_count: z.number().int().min(1).max(MAX_TURNS_PER_TASK),
    turns: z.array(TurnRecordSchema).min(1).max(MAX_TURNS_PER_TASK),
    idempotency: z
      .array(IdempotencyRecordSchema)
      .max(MAX_IDEMPOTENCY_RECORDS_PER_TASK),
    events: z.array(TaskEventSchema).max(MAX_EVENTS_PER_TASK),
    event_seq: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    events_truncated_before_seq: z
      .number()
      .int()
      .min(0)
      .max(Number.MAX_SAFE_INTEGER),
    pending_input: z.null(),
    local_action_required: z.boolean(),
    final_response: FinalResponseSchema.nullable(),
    safe_error: SafeErrorSchema.nullable(),
    usage_summary: TaskUsageSummarySchema,
  })
  .strict();

export const TaskRecordSchema = TaskRecordBaseSchema.superRefine(
  (record, context) => {
    if (record.turn_count !== record.turns.length) {
      context.addIssue({ code: "custom", message: "turn_count mismatch" });
    }
    for (let index = 0; index < record.turns.length; index += 1) {
      if (record.turns[index]?.turn_number !== index + 1) {
        context.addIssue({ code: "custom", message: "turn sequence mismatch" });
      }
    }
    if (record.turns.at(-1)?.state !== record.state) {
      context.addIssue({ code: "custom", message: "task state mismatch" });
    }
    if (record.turns.at(-1)?.profile !== record.current_profile) {
      context.addIssue({ code: "custom", message: "current profile mismatch" });
    }
    const localActionError =
      record.safe_error?.code === "secret_input_requires_local_action";
    if (
      record.local_action_required &&
      ((record.state !== "interrupted" && record.state !== "failed") ||
        !localActionError)
    ) {
      context.addIssue({
        code: "custom",
        message: "local action requires a terminal secret-input error",
      });
    }
    if (localActionError && !record.local_action_required) {
      context.addIssue({
        code: "custom",
        message: "secret-input error requires local action",
      });
    }
    let previousSeq = record.events_truncated_before_seq;
    for (const event of record.events) {
      if (event.seq !== previousSeq + 1 || event.seq > record.event_seq) {
        context.addIssue({
          code: "custom",
          message: "event sequence mismatch",
        });
      }
      if (event.turn_number !== null && event.turn_number > record.turn_count) {
        context.addIssue({ code: "custom", message: "event turn mismatch" });
      }
      previousSeq = event.seq;
    }
    for (const turn of record.turns.slice(0, -1)) {
      if (
        turn.state !== "completed" &&
        turn.state !== "failed" &&
        turn.state !== "cancelled" &&
        turn.state !== "interrupted"
      ) {
        context.addIssue({ code: "custom", message: "nonterminal prior turn" });
      }
    }
    if (record.events.length > 0 && record.event_seq !== previousSeq) {
      context.addIssue({ code: "custom", message: "event tail mismatch" });
    }
    if (
      record.events.length === 0 &&
      record.event_seq !== record.events_truncated_before_seq
    ) {
      context.addIssue({
        code: "custom",
        message: "empty event sequence mismatch",
      });
    }
    for (const entry of record.idempotency) {
      if (entry.task_id !== record.task_id) {
        context.addIssue({
          code: "custom",
          message: "idempotency task mismatch",
        });
      }
      if (entry.turn_number > record.turn_count) {
        context.addIssue({
          code: "custom",
          message: "idempotency turn mismatch",
        });
      }
    }
    const latestResponse = record.turns.at(-1)?.final_response ?? null;
    if (
      (latestResponse?.text ?? null) !==
        (record.final_response?.text ?? null) ||
      (latestResponse?.truncated ?? null) !==
        (record.final_response?.truncated ?? null)
    ) {
      context.addIssue({ code: "custom", message: "final response mismatch" });
    }
  },
);

export type TaskRecord = z.infer<typeof TaskRecordSchema>;

export interface TaskView {
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
  /** Internal sanitized events; M4 must map these to the public EventOutput schema. */
  events: TaskEvent[];
  final_response: FinalResponse | null;
}

export const START_IDEMPOTENCY_SCHEMA = z
  .object({
    operation: z.literal("start"),
    project_id: ProjectIdSchema,
    display_name: boundedText(256),
    registration_id: UuidSchema,
    registration_added_at: TimestampSchema,
    prompt_sha256: z.string().regex(HASH_PATTERN),
    profile: ProfileSchema,
    model_id: ModelIdSchema,
    mode: z.enum(["default", "plan"]),
  })
  .strict();

export const CONTINUE_IDEMPOTENCY_SCHEMA = z
  .object({
    operation: z.literal("continue"),
    task_id: UuidSchema,
    turn_number: z.number().int().min(1).max(MAX_TURNS_PER_TASK),
    project_id: ProjectIdSchema,
    registration_id: UuidSchema,
    registration_added_at: TimestampSchema,
    prompt_sha256: z.string().regex(HASH_PATTERN),
    profile: ProfileSchema,
    model_id: ModelIdSchema,
    mode: z.enum(["default", "plan"]),
  })
  .strict();

export function hashText(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function truncateUtf8(value: string, maxBytes: number): FinalResponse {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new RangeError("Invalid UTF-8 byte limit.");
  }
  let byteLength = 0;
  let text = "";
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    let codePoint: string;
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        codePoint = value.slice(index, index + 2);
        index += 1;
      } else {
        codePoint = "\ufffd";
      }
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      codePoint = "\ufffd";
    } else {
      codePoint = value.charAt(index);
    }
    const codePointBytes = Buffer.byteLength(codePoint, "utf8");
    if (byteLength + codePointBytes > maxBytes) {
      return { text, truncated: true };
    }
    text += codePoint;
    byteLength += codePointBytes;
  }
  return { text, truncated: false };
}

export function summarizePrompt(prompt: string): {
  prompt_preview: string;
  prompt_sha256: string;
} {
  if (
    !isWellFormedUnicode(prompt) ||
    prompt.includes("\0") ||
    Buffer.byteLength(prompt, "utf8") === 0 ||
    Buffer.byteLength(prompt, "utf8") > MAX_PROMPT_BYTES
  ) {
    throw new RangeError("Invalid prompt bounds.");
  }
  return {
    prompt_preview: truncateUtf8(prompt, MAX_PROMPT_PREVIEW_BYTES).text,
    prompt_sha256: hashText(prompt),
  };
}

export function emptyTokenBreakdown(): TokenBreakdown {
  return {
    input_tokens: null,
    cached_input_tokens: null,
    cache_write_input_tokens: null,
    output_tokens: null,
    reasoning_output_tokens: null,
    total_tokens: null,
  };
}

export function emptyTurnUsage(): z.infer<typeof TurnUsageSchema> {
  return {
    start_total: null,
    end_total: null,
    latest_last: null,
    turn_delta: null,
    model_context_window: null,
    delta_quality: "unavailable",
    model_request_count: null,
  };
}

export function emptyTaskUsageSummary(): z.infer<
  typeof TaskUsageSummarySchema
> {
  return {
    thread_total: emptyTokenBreakdown(),
    latest_last: null,
    model_context_window: null,
    delta_quality: "unavailable",
    model_request_count: null,
  };
}
