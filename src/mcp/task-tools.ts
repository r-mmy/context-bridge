import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { isAgentAdapterError } from "../agents/errors.js";
import type { TaskToolHost } from "./task-host.js";
import { ContextBridgeError } from "../security/errors.js";
import { isTaskError, TaskError } from "../tasks/errors.js";
import type { TaskEvent, TaskRecord, TaskState } from "../tasks/types.js";
import { jsonResult } from "./results.js";

const PROJECT_ID = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const PROFILE = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const TASK_ID = z.string().uuid();

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

const PROMPT = z
  .string()
  .min(1)
  .refine((value) => !value.includes("\0"))
  .refine(isWellFormedUnicode)
  .refine((value) => Buffer.byteLength(value, "utf8") <= 32 * 1024);
const REQUEST_ID = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[\x21-\x7e]+$/);

export const TaskStartInputSchema = z
  .object({
    project_id: PROJECT_ID,
    prompt: PROMPT,
    profile: PROFILE.optional(),
    mode: z.enum(["default", "plan"]).default("default"),
    request_id: REQUEST_ID.optional(),
  })
  .strict();

export const TaskGetInputSchema = z
  .object({
    task_id: TASK_ID,
    after_seq: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),
    max_events: z.number().int().min(1).max(100).default(50),
    include_final_response: z.boolean().default(true),
    wait_ms: z.number().int().min(0).max(30_000).default(0),
  })
  .strict();

export const TasksListInputSchema = z
  .object({
    project_id: PROJECT_ID.optional(),
    limit: z.number().int().min(1).max(100).default(20),
  })
  .strict();

export const TaskCancelInputSchema = z.object({ task_id: TASK_ID }).strict();

const TASK_STATES = [
  "queued",
  "running",
  "waiting_for_input",
  "completed",
  "failed",
  "cancelled",
  "interrupted",
] as const;
const ISO_TIME = z.string().datetime();
const TOKEN_COUNT = z.number().int().nonnegative().nullable();
const TOKEN_BREAKDOWN = z
  .object({
    input_tokens: TOKEN_COUNT,
    cached_input_tokens: TOKEN_COUNT,
    cache_write_input_tokens: TOKEN_COUNT,
    output_tokens: TOKEN_COUNT,
    reasoning_output_tokens: TOKEN_COUNT,
    total_tokens: TOKEN_COUNT,
  })
  .strict();
const USAGE_OUTPUT = z
  .object({
    thread_total: TOKEN_BREAKDOWN.nullable(),
    latest_last: TOKEN_BREAKDOWN.nullable(),
    turn_delta: TOKEN_BREAKDOWN.nullable(),
    model_context_window: z.number().int().positive().nullable(),
    delta_quality: z.enum(["authoritative_delta", "degraded", "unavailable"]),
    model_request_count: z.null(),
  })
  .strict();
const GIT_BASELINE_OUTPUT = z
  .object({
    branch: z.string().max(256).nullable(),
    head: z.string().max(128).nullable(),
    staged_count: z.number().int().nonnegative(),
    modified_count: z.number().int().nonnegative(),
    deleted_count: z.number().int().nonnegative(),
    untracked_count: z.number().int().nonnegative(),
    truncated: z.boolean(),
  })
  .strict();
const TASK_STATE = z.enum(TASK_STATES);
const PROFILE_OUTPUT = PROFILE;
const MODE_OUTPUT = z.enum(["default", "plan"]);

const TURN_OUTPUT = z
  .object({
    turn_number: z.number().int().min(1),
    state: TASK_STATE,
    profile: PROFILE_OUTPUT,
    mode: MODE_OUTPUT,
    started_at: ISO_TIME.nullable(),
    completed_at: ISO_TIME.nullable(),
    git_baseline: GIT_BASELINE_OUTPUT.nullable(),
    usage: USAGE_OUTPUT,
  })
  .strict();
const FINAL_RESPONSE_OUTPUT = z
  .object({
    text: z
      .string()
      .max(65_536)
      .refine((value) => Buffer.byteLength(value, "utf8") <= 65_536),
    truncated: z.boolean(),
  })
  .strict();
const EVENT_OUTPUT = z
  .object({
    seq: z.number().int().min(1),
    at: ISO_TIME,
    turn_number: z.number().int().min(1).nullable(),
    category: z.enum(["task", "turn", "item", "user_input", "usage", "system"]),
    kind: z.string().min(1).max(64),
    status: z.enum([
      "queued",
      "started",
      "in_progress",
      "waiting_for_input",
      "completed",
      "failed",
      "cancelled",
      "interrupted",
      "resolved",
      "observed",
    ]),
    duration_ms: z.number().int().nonnegative().nullable(),
  })
  .strict();
const PENDING_INPUT_OUTPUT = z.null();
const TASK_ERROR_OUTPUT = z
  .object({
    code: z.string().min(1).max(64),
    message: z.string().min(1).max(512),
    retryable: z.boolean(),
  })
  .strict();

export const TaskAcceptedOutputSchema = z
  .object({
    task_id: TASK_ID,
    project_id: PROJECT_ID,
    display_name: z.string().min(1).max(256),
    state: TASK_STATE,
    turn_number: z.number().int().min(1),
    profile: PROFILE_OUTPUT,
    mode: MODE_OUTPUT,
    created_at: ISO_TIME,
    updated_at: ISO_TIME,
  })
  .strict();

export const TaskGetOutputSchema = z
  .object({
    task_id: TASK_ID,
    project_id: PROJECT_ID,
    display_name: z.string().min(1).max(256),
    state: TASK_STATE,
    profile: PROFILE_OUTPUT,
    turn_count: z.number().int().nonnegative(),
    current_turn: TURN_OUTPUT.nullable(),
    latest_turn: TURN_OUTPUT.nullable(),
    events: z.array(EVENT_OUTPUT).max(100),
    next_after_seq: z.number().int().min(0).nullable(),
    has_more: z.boolean(),
    events_truncated_before_seq: z.number().int().min(1).nullable(),
    pending_input: PENDING_INPUT_OUTPUT,
    local_action_required: z.boolean(),
    final_response: FINAL_RESPONSE_OUTPUT.nullable(),
    final_response_included: z.boolean(),
    usage: USAGE_OUTPUT,
    error: TASK_ERROR_OUTPUT.nullable(),
    created_at: ISO_TIME,
    updated_at: ISO_TIME,
    truncation: z
      .object({ events: z.boolean(), final_response: z.boolean() })
      .strict(),
  })
  .strict();

export const TaskListItemOutputSchema = z
  .object({
    task_id: TASK_ID,
    project_id: PROJECT_ID,
    display_name: z.string().min(1).max(256),
    state: TASK_STATE,
    profile: PROFILE_OUTPUT,
    turn_count: z.number().int().nonnegative(),
    created_at: ISO_TIME,
    updated_at: ISO_TIME,
    latest_turn_at: ISO_TIME.nullable(),
    pending_input: z.boolean(),
  })
  .strict();

export const TasksListOutputSchema = z
  .object({
    tasks: z.array(TaskListItemOutputSchema).max(100),
    truncated: z.boolean(),
  })
  .strict();

export const TaskCancelOutputSchema = z
  .object({ task_id: TASK_ID, state: TASK_STATE })
  .strict();

const SAFE_ERRORS = {
  agent_runtime_busy: {
    code: "agent_runtime_busy",
    message: "Another Context Bridge process owns the task runtime.",
    retryable: true,
  },
  agent_runtime_unavailable: {
    code: "agent_runtime_unavailable",
    message: "The task runtime is unavailable on this installation.",
    retryable: true,
  },
  task_not_found: {
    code: "task_not_found",
    message: "The requested task is not available.",
    retryable: false,
  },
  task_registration_stale: {
    code: "task_registration_stale",
    message: "The task is not available for the current project registration.",
    retryable: false,
  },
  task_store_error: {
    code: "task_store_error",
    message: "The task store is invalid or could not be accessed.",
    retryable: false,
  },
  task_store_capacity: {
    code: "task_store_error",
    message: "The task store has reached its configured capacity.",
    retryable: false,
  },
  task_invalid_input: {
    code: "invalid_task_input",
    message: "Task input is invalid.",
    retryable: false,
  },
  task_id_conflict: {
    code: "task_store_error",
    message: "The task could not be allocated safely.",
    retryable: false,
  },
  task_state_conflict: {
    code: "task_state_conflict",
    message: "The requested task state transition is not valid.",
    retryable: false,
  },
  request_id_conflict: {
    code: "request_id_conflict",
    message: "This request identifier was already used for a different task.",
    retryable: false,
  },
  task_runtime_closed: {
    code: "agent_runtime_unavailable",
    message: "The task runtime is unavailable on this installation.",
    retryable: true,
  },
  project_not_found: {
    code: "project_not_found",
    message: "The requested project is not registered.",
    retryable: false,
  },
  project_not_git: {
    code: "project_not_git",
    message: "Agent execution requires a registered Git project.",
    retryable: false,
  },
  agent_disabled: {
    code: "agent_disabled",
    message: "Agent execution is not enabled for this project registration.",
    retryable: false,
  },
  profile_not_found: {
    code: "profile_not_found",
    message: "The selected profile is unavailable.",
    retryable: false,
  },
  profile_not_allowed: {
    code: "profile_not_allowed",
    message: "The requested profile is not allowed for this project.",
    retryable: false,
  },
  project_busy: {
    code: "project_busy",
    message: "Another agent task is already active for this project.",
    retryable: true,
  },
  agent_capacity: {
    code: "agent_capacity",
    message: "The maximum number of active agent turns has been reached.",
    retryable: true,
  },
  codex_not_found: {
    code: "codex_not_found",
    message: "The Codex executable was not found on PATH.",
    retryable: false,
  },
  codex_unauthenticated: {
    code: "codex_unauthenticated",
    message: "No local Codex account is available.",
    retryable: false,
  },
  app_server_incompatible: {
    code: "app_server_incompatible",
    message:
      "The local Codex App Server does not support the required protocol capabilities.",
    retryable: false,
  },
  model_unavailable: {
    code: "model_unavailable",
    message:
      "The configured model is not available in the local Codex model list.",
    retryable: false,
  },
  effort_unsupported: {
    code: "effort_unsupported",
    message:
      "The configured reasoning effort is not supported by the selected model.",
    retryable: false,
  },
  unsupported_task_mode: {
    code: "unsupported_task_mode",
    message:
      "Only the default Codex execution mode is available in this milestone.",
    retryable: false,
  },
  git_error: {
    code: "task_store_error",
    message: "The project Git state could not be read safely.",
    retryable: false,
  },
  git_timeout: {
    code: "task_store_error",
    message: "The project Git state could not be read safely.",
    retryable: true,
  },
  git_unavailable: {
    code: "task_store_error",
    message: "The project Git state could not be read safely.",
    retryable: false,
  },
  git_scope_error: {
    code: "task_store_error",
    message: "The project Git state could not be read safely.",
    retryable: false,
  },
  app_server_start_failed: {
    code: "app_server_error",
    message: "The local Codex App Server could not be started.",
    retryable: true,
  },
  app_server_protocol_error: {
    code: "app_server_error",
    message: "The local Codex App Server returned an unsupported response.",
    retryable: false,
  },
  app_server_timeout: {
    code: "app_server_error",
    message: "The local Codex App Server did not respond in time.",
    retryable: true,
  },
  app_server_exited: {
    code: "app_server_error",
    message: "The local Codex App Server exited unexpectedly.",
    retryable: true,
  },
  internal_error: {
    code: "internal_error",
    message: "The requested task operation failed.",
    retryable: false,
  },
} as const;

type SafeErrorCode = keyof typeof SAFE_ERRORS;

function isSafeErrorCode(code: string): code is SafeErrorCode {
  return Object.hasOwn(SAFE_ERRORS, code);
}

function taskErrorResult(error: unknown) {
  const known =
    isTaskError(error) ||
    isAgentAdapterError(error) ||
    error instanceof ContextBridgeError;
  const code =
    known && isSafeErrorCode(error.code) ? error.code : "internal_error";
  const safe = SAFE_ERRORS[code];
  return {
    isError: true,
    content: [{ type: "text" as const, text: JSON.stringify(safe) }],
  };
}

async function runTaskTool<T extends Record<string, unknown>>(
  schema: z.ZodType<T>,
  operation: () => Promise<unknown>,
) {
  try {
    const output = schema.parse(await operation());
    return jsonResult(output);
  } catch (error) {
    return taskErrorResult(error);
  }
}

function mapUsage(record: TaskRecord, turn?: TaskRecord["turns"][number]) {
  if (turn) {
    return {
      thread_total: turn.usage.end_total,
      latest_last: turn.usage.latest_last,
      turn_delta: turn.usage.turn_delta,
      model_context_window: turn.usage.model_context_window,
      delta_quality: turn.usage.delta_quality,
      model_request_count: null,
    };
  }
  return {
    thread_total: record.usage_summary.thread_total,
    latest_last: record.usage_summary.latest_last,
    turn_delta: null,
    model_context_window: record.usage_summary.model_context_window,
    delta_quality: record.usage_summary.delta_quality,
    model_request_count: null,
  };
}

function mapBaseline(baseline: TaskRecord["turns"][number]["git_baseline"]) {
  if (!baseline) return null;
  return {
    branch: baseline.branch,
    head: baseline.head,
    staged_count: baseline.staged,
    modified_count: baseline.modified,
    deleted_count: baseline.deleted,
    untracked_count: baseline.untracked,
    truncated: baseline.truncated,
  };
}

function mapTurn(record: TaskRecord, turn: TaskRecord["turns"][number]) {
  return {
    turn_number: turn.turn_number,
    state: turn.state,
    profile: turn.profile,
    mode: turn.mode,
    started_at: turn.started_at,
    completed_at: turn.completed_at,
    git_baseline: mapBaseline(turn.git_baseline),
    usage: mapUsage(record, turn),
  };
}

const EVENT_STATUS = {
  queued: "queued",
  running: "in_progress",
  waiting_for_input: "waiting_for_input",
  completed: "completed",
  failed: "failed",
  cancelled: "cancelled",
  interrupted: "interrupted",
  saved: "resolved",
  recovered: "interrupted",
  observed: "observed",
} as const;

function mapEvent(event: TaskEvent) {
  const category =
    event.category === "lifecycle"
      ? event.turn_number === null
        ? "task"
        : "turn"
      : event.category === "recovery" || event.category === "runtime"
        ? "system"
        : event.category === "input"
          ? "user_input"
          : "turn";
  return {
    seq: event.seq,
    at: event.timestamp,
    turn_number: event.turn_number,
    category,
    kind: event.kind,
    status: EVENT_STATUS[event.status],
    duration_ms: event.duration_ms,
  };
}

const TASK_STATE_ERRORS = {
  task_failed: {
    code: "task_failed",
    message: "The Codex task failed.",
    retryable: false,
  },
  task_interrupted: {
    code: "task_interrupted",
    message: "The task was interrupted before completion.",
    retryable: false,
  },
  task_cancelled: {
    code: "task_cancelled",
    message: "The task was cancelled.",
    retryable: false,
  },
  secret_input_requires_local_action: {
    code: "secret_input_requires_local_action",
    message: "The task requires a local action before it can continue.",
    retryable: false,
  },
} as const;

function mapTaskStateError(record: TaskRecord) {
  const code = record.safe_error?.code;
  if (!code) return null;
  return TASK_STATE_ERRORS[code];
}

function mapTaskGet(
  record: TaskRecord,
  input: z.infer<typeof TaskGetInputSchema>,
) {
  const turns = record.turns;
  const latest = turns.at(-1);
  const active =
    record.state === "queued" ||
    record.state === "running" ||
    record.state === "waiting_for_input";
  const eligible = record.events.filter((event) => event.seq > input.after_seq);
  const events = eligible.slice(0, input.max_events).map(mapEvent);
  const hasMore = eligible.length > input.max_events;
  const truncatedBefore = record.events_truncated_before_seq || null;
  const finalResponse = input.include_final_response
    ? record.final_response
    : null;
  return {
    task_id: record.task_id,
    project_id: record.project_id,
    display_name: record.display_name,
    state: record.state,
    profile: record.current_profile,
    turn_count: record.turn_count,
    current_turn: active && latest ? mapTurn(record, latest) : null,
    latest_turn: latest ? mapTurn(record, latest) : null,
    events,
    next_after_seq: hasMore ? (events.at(-1)?.seq ?? null) : null,
    has_more: hasMore,
    events_truncated_before_seq: truncatedBefore,
    pending_input: null,
    local_action_required: record.local_action_required,
    final_response: finalResponse,
    final_response_included: input.include_final_response,
    usage: mapUsage(record),
    error: mapTaskStateError(record),
    created_at: record.created_at,
    updated_at: record.updated_at,
    truncation: {
      events: input.after_seq < record.events_truncated_before_seq || hasMore,
      final_response: record.final_response?.truncated ?? false,
    },
  };
}

function mapTaskListItem(record: TaskRecord) {
  const latest = record.turns.at(-1);
  return {
    task_id: record.task_id,
    project_id: record.project_id,
    display_name: record.display_name,
    state: record.state,
    profile: record.current_profile,
    turn_count: record.turn_count,
    created_at: record.created_at,
    updated_at: record.updated_at,
    latest_turn_at:
      latest?.completed_at ?? latest?.started_at ?? latest?.created_at ?? null,
    pending_input: Boolean(
      record.state === "waiting_for_input" &&
      !record.local_action_required &&
      record.pending_input,
    ),
  };
}

const READ_ONLY_TASK = {
  readOnlyHint: true,
  destructiveHint: false,
  openWorldHint: false,
} as const;
const START_TASK = {
  readOnlyHint: false,
  destructiveHint: true,
  openWorldHint: false,
} as const;
const CANCEL_TASK = {
  readOnlyHint: false,
  destructiveHint: false,
  openWorldHint: false,
} as const;

export function registerTaskTools(server: McpServer, host: TaskToolHost): void {
  server.registerTool(
    "task_start",
    {
      description:
        "Start one default-mode Codex task in a locally agent-enabled registered Git project. The result means the turn was accepted, not completed; use task_get to inspect progress and review actual edits with git_status and git_diff.",
      inputSchema: TaskStartInputSchema,
      outputSchema: TaskAcceptedOutputSchema,
      annotations: START_TASK,
    },
    async (input) =>
      runTaskTool(TaskAcceptedOutputSchema, async () => {
        const record = await host.startTask(input);
        const turn = record.turns.find(
          (candidate) => candidate.turn_number === 1,
        );
        if (!turn) throw new TaskError("task_store_error");
        return {
          task_id: record.task_id,
          project_id: record.project_id,
          display_name: record.display_name,
          state: record.state,
          turn_number: turn.turn_number,
          profile: turn.profile,
          mode: turn.mode,
          created_at: record.created_at,
          updated_at: record.updated_at,
        };
      }),
  );

  server.registerTool(
    "task_get",
    {
      description:
        "Get a registration-checked task snapshot, sanitized lifecycle events, bounded final response, usage placeholders, and optional bounded long-poll updates.",
      inputSchema: TaskGetInputSchema,
      outputSchema: TaskGetOutputSchema,
      annotations: READ_ONLY_TASK,
    },
    async (input, context) =>
      runTaskTool(TaskGetOutputSchema, async () => {
        let record = await host.getTask(input.task_id);
        if (
          input.wait_ms > 0 &&
          record.event_seq <= input.after_seq &&
          record.state !== "waiting_for_input" &&
          !TASK_STATES_TERMINAL.has(record.state)
        ) {
          try {
            await host.waitForTask(
              input.task_id,
              input.after_seq,
              input.wait_ms,
              context.mcpReq.signal,
            );
          } catch (error) {
            if (!(isTaskError(error) && error.code === "task_wait_aborted")) {
              throw error;
            }
          }
          record = await host.getTask(input.task_id);
        }
        return mapTaskGet(record, input);
      }),
  );

  server.registerTool(
    "tasks_list",
    {
      description:
        "List recent tasks for current project registrations. Results omit prompts, transcripts, Git baselines, thread identifiers, and local paths.",
      inputSchema: TasksListInputSchema,
      outputSchema: TasksListOutputSchema,
      annotations: READ_ONLY_TASK,
    },
    async (input) =>
      runTaskTool(TasksListOutputSchema, async () => {
        const page = await host.listTasks({
          ...(input.project_id === undefined
            ? {}
            : { project_id: input.project_id }),
          limit: input.limit,
        });
        return {
          tasks: page.records.map(mapTaskListItem),
          truncated: page.truncated,
        };
      }),
  );

  server.registerTool(
    "task_cancel",
    {
      description:
        "Request cancellation of an active task or return its existing terminal state. Cancellation may leave partial workspace edits; inspect the result with git_status and git_diff.",
      inputSchema: TaskCancelInputSchema,
      outputSchema: TaskCancelOutputSchema,
      annotations: CANCEL_TASK,
    },
    async ({ task_id }) =>
      runTaskTool(TaskCancelOutputSchema, async () => {
        const record = await host.cancelTask(task_id);
        return { task_id: record.task_id, state: record.state };
      }),
  );
}

const TASK_STATES_TERMINAL = new Set<TaskState>([
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);
