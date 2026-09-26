import { ContextBridgeError } from "../security/errors.js";

export type TaskErrorCode =
  | "agent_runtime_busy"
  | "agent_runtime_unavailable"
  | "task_not_found"
  | "task_store_error"
  | "task_store_capacity"
  | "task_invalid_input"
  | "task_id_conflict"
  | "task_state_conflict"
  | "request_id_conflict"
  | "task_wait_aborted"
  | "task_runtime_closed"
  | "task_registration_stale";

const SAFE_MESSAGES: Record<TaskErrorCode, string> = {
  agent_runtime_busy: "Another Context Bridge process owns the task runtime.",
  agent_runtime_unavailable:
    "The task runtime is unavailable on this installation.",
  task_not_found: "The requested task is not available.",
  task_store_error: "The task store is invalid or could not be accessed.",
  task_store_capacity: "The task store has reached its configured capacity.",
  task_invalid_input: "Task input is invalid.",
  task_id_conflict: "A task with this identifier already exists.",
  task_state_conflict: "The requested task state transition is not valid.",
  request_id_conflict:
    "This request identifier was already used for a different operation.",
  task_wait_aborted: "Waiting for task changes was aborted.",
  task_runtime_closed: "The task runtime is closed.",
  task_registration_stale:
    "The task is not available for the current project registration.",
};

export class TaskError extends ContextBridgeError {
  declare readonly code: TaskErrorCode;

  constructor(code: TaskErrorCode) {
    super(code, SAFE_MESSAGES[code]);
    this.name = "TaskError";
  }
}

export function isTaskError(error: unknown): error is TaskError {
  return error instanceof TaskError;
}

export function safeTaskError(code: TaskErrorCode): TaskError {
  return new TaskError(code);
}
