export type AgentAdapterErrorCode =
  | "codex_not_found"
  | "codex_unauthenticated"
  | "app_server_start_failed"
  | "app_server_incompatible"
  | "app_server_protocol_error"
  | "app_server_timeout"
  | "app_server_exited"
  | "model_unavailable"
  | "effort_unsupported";

const SAFE_MESSAGES: Record<AgentAdapterErrorCode, string> = {
  codex_not_found: "The Codex executable was not found on PATH.",
  codex_unauthenticated: "No local Codex account is available.",
  app_server_start_failed: "The local Codex App Server could not be started.",
  app_server_incompatible:
    "The local Codex App Server does not support the required protocol capabilities.",
  app_server_protocol_error:
    "The local Codex App Server returned an invalid or unsupported protocol message.",
  app_server_timeout: "The local Codex App Server did not respond in time.",
  app_server_exited: "The local Codex App Server exited unexpectedly.",
  model_unavailable:
    "The configured model is not available in the local Codex model list.",
  effort_unsupported:
    "The configured reasoning effort is not supported by the selected local Codex model.",
};

export class AgentAdapterError extends Error {
  readonly code: AgentAdapterErrorCode;

  constructor(code: AgentAdapterErrorCode) {
    super(SAFE_MESSAGES[code]);
    this.name = "AgentAdapterError";
    this.code = code;
  }
}

export function isAgentAdapterError(
  error: unknown,
): error is AgentAdapterError {
  return error instanceof AgentAdapterError;
}

export function safeAgentAdapterError(
  error: unknown,
  fallback: AgentAdapterErrorCode = "app_server_start_failed",
): AgentAdapterError {
  if (isAgentAdapterError(error)) return error;
  if (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    error.code === "ENOENT"
  ) {
    return new AgentAdapterError("codex_not_found");
  }
  return new AgentAdapterError(fallback);
}
