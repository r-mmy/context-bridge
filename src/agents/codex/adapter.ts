import type { AgentAdapter, AgentBackendInfo, AgentModel } from "../adapter.js";
import { validateProfileCapabilities } from "../adapter.js";
import { AgentAdapterError } from "../errors.js";
import type { AgentProfile } from "../profiles.js";
import { CodexAppServer, type AppServerOptions } from "./app-server.js";

const MAX_MODEL_PAGES = 16;
const MAX_MODELS = 512;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseEfforts(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 64) {
    throw new AgentAdapterError("app_server_incompatible");
  }
  const efforts: string[] = [];
  for (const entry of value) {
    const effort =
      typeof entry === "string"
        ? entry
        : isRecord(entry) && typeof entry.reasoningEffort === "string"
          ? entry.reasoningEffort
          : undefined;
    if (!effort || !/^[a-z][a-z0-9-]{0,31}$/.test(effort)) {
      throw new AgentAdapterError("app_server_incompatible");
    }
    if (!efforts.includes(effort)) efforts.push(effort);
  }
  return efforts;
}

function parseModelPage(value: unknown): {
  models: AgentModel[];
  nextCursor: string | null;
} {
  if (
    !isRecord(value) ||
    !Array.isArray(value.data) ||
    value.data.length > 100
  ) {
    throw new AgentAdapterError("app_server_incompatible");
  }
  const models: AgentModel[] = [];
  for (const candidate of value.data) {
    if (
      !isRecord(candidate) ||
      typeof candidate.id !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(candidate.id)
    ) {
      throw new AgentAdapterError("app_server_incompatible");
    }
    const reasoningEfforts = parseEfforts(candidate.supportedReasoningEfforts);
    if (candidate.hidden !== true) {
      models.push({ id: candidate.id, reasoningEfforts });
    }
  }
  const nextCursor = value.nextCursor;
  if (
    nextCursor !== undefined &&
    nextCursor !== null &&
    (typeof nextCursor !== "string" ||
      nextCursor.length === 0 ||
      nextCursor.length > 512)
  ) {
    throw new AgentAdapterError("app_server_incompatible");
  }
  return {
    models,
    nextCursor: typeof nextCursor === "string" ? nextCursor : null,
  };
}

export class CodexAgentAdapter implements AgentAdapter {
  private readonly appServer: CodexAppServer;

  constructor(options: AppServerOptions = {}) {
    this.appServer = new CodexAppServer(options);
  }

  async start(): Promise<AgentBackendInfo> {
    const info = await this.appServer.start();
    return {
      provider: "codex",
      connected: true,
      experimentalApi: true,
      version: info.version,
    };
  }

  async checkAuthentication(): Promise<boolean> {
    const result = await this.appServer.readAccount();
    if (!isRecord(result) || !Object.hasOwn(result, "account")) {
      throw new AgentAdapterError("app_server_incompatible");
    }
    if (
      result.requiresOpenaiAuth !== undefined &&
      typeof result.requiresOpenaiAuth !== "boolean"
    ) {
      throw new AgentAdapterError("app_server_incompatible");
    }
    if (result.account === null) return false;
    if (!isRecord(result.account) || typeof result.account.type !== "string") {
      throw new AgentAdapterError("app_server_incompatible");
    }
    return true;
  }

  async requireAuthentication(): Promise<void> {
    if (!(await this.checkAuthentication())) {
      throw new AgentAdapterError("codex_unauthenticated");
    }
  }

  async listModels(): Promise<AgentModel[]> {
    const all = new Map<string, AgentModel>();
    const cursors = new Set<string>();
    let cursor: string | undefined;

    for (let pageNumber = 0; pageNumber < MAX_MODEL_PAGES; pageNumber += 1) {
      const page = parseModelPage(await this.appServer.listModels(cursor));
      for (const model of page.models) {
        const existing = all.get(model.id);
        if (existing) {
          existing.reasoningEfforts = [
            ...new Set([
              ...existing.reasoningEfforts,
              ...model.reasoningEfforts,
            ]),
          ];
        } else {
          all.set(model.id, model);
        }
        if (all.size > MAX_MODELS) {
          throw new AgentAdapterError("app_server_incompatible");
        }
      }
      if (page.nextCursor === null) return [...all.values()];
      if (cursors.has(page.nextCursor)) {
        throw new AgentAdapterError("app_server_incompatible");
      }
      cursors.add(page.nextCursor);
      cursor = page.nextCursor;
    }
    throw new AgentAdapterError("app_server_incompatible");
  }

  async validateProfile(profile: AgentProfile): Promise<void> {
    validateProfileCapabilities(profile, await this.listModels());
  }

  async close(): Promise<void> {
    await this.appServer.close();
  }
}

let sharedCodexAdapter: CodexAgentAdapter | undefined;

export function getCodexAgentAdapter(): AgentAdapter {
  sharedCodexAdapter ??= new CodexAgentAdapter();
  return sharedCodexAdapter;
}
