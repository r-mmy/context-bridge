import type { AgentProfile } from "./profiles.js";
import { AgentAdapterError } from "./errors.js";

export interface AgentModel {
  id: string;
  reasoningEfforts: string[];
}

export interface AgentBackendInfo {
  provider: "codex";
  connected: true;
  experimentalApi: true;
  version: string | null;
}

export interface AgentExecutionThread {
  threadId: string;
}

export interface AgentExecutionTurn {
  turnId: string;
  status: "completed" | "interrupted" | "failed" | "inProgress";
}

export type AgentExecutionEvent =
  | { type: "turn_started"; threadId: string; turnId: string }
  | {
      type: "turn_completed";
      threadId: string;
      turnId: string;
      status: "completed" | "interrupted" | "failed";
    }
  | {
      type: "final_message";
      threadId: string;
      turnId: string;
      text: string;
    }
  | {
      type: "unsupported_request";
      threadId?: string;
      turnId?: string;
    }
  | { type: "session_failed" };

export interface AgentExecutionAdapter extends AgentAdapter {
  subscribe(listener: (event: AgentExecutionEvent) => void): () => void;
  startThread(input: {
    root: string;
    model: string;
  }): Promise<AgentExecutionThread>;
  startTurn(input: {
    threadId: string;
    root: string;
    model: string;
    effort: string;
    prompt: string;
  }): Promise<AgentExecutionTurn>;
  interruptTurn(input: { threadId: string; turnId: string }): Promise<void>;
}

/** M2 only provides backend capability and local profile operations. */
export interface AgentAdapter {
  start(): Promise<AgentBackendInfo>;
  checkAuthentication(): Promise<boolean>;
  requireAuthentication(): Promise<void>;
  listModels(): Promise<AgentModel[]>;
  validateProfile(profile: AgentProfile): Promise<void>;
  close(): Promise<void>;
}

export function validateProfileCapabilities(
  profile: AgentProfile,
  models: readonly AgentModel[],
): void {
  const model = models.find((candidate) => candidate.id === profile.model_id);
  if (!model) throw new AgentAdapterError("model_unavailable");
  if (!model.reasoningEfforts.includes(profile.reasoning_effort)) {
    throw new AgentAdapterError("effort_unsupported");
  }
}
