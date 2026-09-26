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
