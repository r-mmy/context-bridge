import type { AgentProfile } from "./profiles.js";
import { AgentAdapterError } from "./errors.js";
import type { ActivityKind, TokenBreakdown } from "../tasks/types.js";

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

export interface AgentUserInputQuestion {
  id: string;
  header: string;
  question: string;
  options: Array<{ label: string; description: string }>;
  isOther: boolean;
  isSecret: boolean;
}

export interface AgentUserInputAnswer {
  questionId: string;
  answers: string[];
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
      correlationId: string;
      containsSecret?: boolean;
      threadId?: string;
      turnId?: string;
    }
  | {
      type: "user_input_requested";
      correlationId: string;
      threadId: string;
      turnId: string;
      itemId: string;
      isBlocking: boolean;
      questions: AgentUserInputQuestion[];
      duplicate?: boolean;
    }
  | {
      type: "usage_updated";
      threadId: string;
      turnId: string;
      total: TokenBreakdown;
      last: TokenBreakdown;
      modelContextWindow?: number | null;
    }
  | { type: "usage_invalid"; threadId: string; turnId: string }
  | {
      type: "activity_started";
      threadId: string;
      turnId: string;
      itemId: string;
      activityKind: ActivityKind;
      startedAtMs: number;
    }
  | {
      type: "activity_completed";
      threadId: string;
      turnId: string;
      itemId: string;
      activityKind: ActivityKind;
      completedAtMs: number;
      failed: boolean;
    }
  | { type: "session_failed" };

export interface AgentExecutionAdapter extends AgentAdapter {
  subscribe(listener: (event: AgentExecutionEvent) => void): () => void;
  startThread(input: {
    root: string;
    model: string;
  }): Promise<AgentExecutionThread>;
  resumeThread(input: {
    threadId: string;
    root: string;
    model: string;
  }): Promise<AgentExecutionThread>;
  startTurn(input: {
    threadId: string;
    root: string;
    model: string;
    effort: string;
    prompt: string;
    mode: "default" | "plan";
  }): Promise<AgentExecutionTurn>;
  interruptTurn(input: { threadId: string; turnId: string }): Promise<void>;
  answerUserInput(input: {
    correlationId: string;
    answers: AgentUserInputAnswer[];
  }): Promise<void>;
  rejectServerRequest(input: { correlationId: string }): Promise<void>;
  setThreadName(input: { threadId: string; name: string }): Promise<void>;
  releaseThread(input: {
    threadId: string;
  }): Promise<{ closedObserved: boolean }>;
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
