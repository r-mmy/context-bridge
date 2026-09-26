import type {
  AgentBackendInfo,
  AgentExecutionAdapter,
  AgentExecutionEvent,
  AgentExecutionThread,
  AgentExecutionTurn,
  AgentModel,
} from "../adapter.js";
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

export class CodexAgentAdapter implements AgentExecutionAdapter {
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

  subscribe(listener: (event: AgentExecutionEvent) => void): () => void {
    return this.appServer.subscribe((event) => {
      if (event.type === "failure") {
        listener({ type: "session_failed" });
        return;
      }
      if (event.type === "server_request") {
        const params = isRecord(event.value.params)
          ? event.value.params
          : undefined;
        const threadId = boundedIdentifier(params?.threadId);
        const turnId = boundedIdentifier(params?.turnId);
        listener({
          type: "unsupported_request",
          ...(threadId ? { threadId } : {}),
          ...(turnId ? { turnId } : {}),
        });
        return;
      }
      const { method, params } = event.value;
      if (!isRecord(params)) {
        if (
          method === "turn/started" ||
          method === "turn/completed" ||
          method === "item/completed"
        ) {
          listener({ type: "session_failed" });
        }
        return;
      }
      const threadId = boundedIdentifier(params.threadId);
      if (!threadId) {
        if (
          method === "turn/started" ||
          method === "turn/completed" ||
          method === "item/completed"
        ) {
          listener({ type: "session_failed" });
        }
        return;
      }
      if (method === "turn/started" || method === "turn/completed") {
        const turn = isRecord(params.turn) ? params.turn : undefined;
        const turnId = boundedIdentifier(turn?.id);
        if (!turn || !turnId) {
          listener({ type: "session_failed" });
          return;
        }
        if (method === "turn/started") {
          listener({ type: "turn_started", threadId, turnId });
          return;
        }
        const status = turn.status;
        if (
          status !== "completed" &&
          status !== "interrupted" &&
          status !== "failed"
        ) {
          listener({ type: "session_failed" });
          return;
        }
        listener({ type: "turn_completed", threadId, turnId, status });
        return;
      }
      if (method === "item/completed" && isRecord(params.item)) {
        const item = params.item;
        const turnId = boundedIdentifier(params.turnId);
        if (!turnId) {
          listener({ type: "session_failed" });
          return;
        }
        if (
          item.type === "agentMessage" &&
          item.phase === "final_answer" &&
          typeof item.text === "string"
        ) {
          listener({
            type: "final_message",
            threadId,
            turnId,
            text: item.text,
          });
        }
      }
    });
  }

  async startThread(input: {
    root: string;
    model: string;
  }): Promise<AgentExecutionThread> {
    const result = await this.appServer.startThread({
      model: input.model,
      allowProviderModelFallback: false,
      cwd: input.root,
      runtimeWorkspaceRoots: [input.root],
      approvalPolicy: "never",
      sandbox: "workspace-write",
    });
    const sandbox =
      isRecord(result) && isRecord(result.sandbox) ? result.sandbox : undefined;
    const writableRoots = sandbox?.writableRoots;
    const invalidWritableRoots =
      writableRoots !== undefined &&
      (!Array.isArray(writableRoots) ||
        writableRoots.some((root) => typeof root !== "string") ||
        (Array.isArray(writableRoots) &&
          writableRoots.length > 0 &&
          (writableRoots.length !== 1 || writableRoots[0] !== input.root)));
    if (
      !isRecord(result) ||
      !isRecord(result.thread) ||
      typeof result.thread.id !== "string" ||
      result.thread.id.length === 0 ||
      result.thread.id.length > 512 ||
      result.model !== input.model ||
      result.cwd !== input.root ||
      result.approvalPolicy !== "never" ||
      !sandbox ||
      sandbox.type !== "workspaceWrite" ||
      (sandbox.networkAccess !== undefined &&
        typeof sandbox.networkAccess !== "boolean") ||
      sandbox.networkAccess === true ||
      (sandbox.excludeTmpdirEnvVar !== undefined &&
        typeof sandbox.excludeTmpdirEnvVar !== "boolean") ||
      (sandbox.excludeSlashTmp !== undefined &&
        typeof sandbox.excludeSlashTmp !== "boolean") ||
      invalidWritableRoots ||
      !Array.isArray(result.runtimeWorkspaceRoots) ||
      result.runtimeWorkspaceRoots.length !== 1 ||
      result.runtimeWorkspaceRoots[0] !== input.root ||
      typeof result.modelProvider !== "string" ||
      result.modelProvider.length === 0 ||
      result.modelProvider.length > 128 ||
      !Object.hasOwn(result, "approvalsReviewer")
    ) {
      throw new AgentAdapterError("app_server_incompatible");
    }
    return { threadId: result.thread.id };
  }

  async startTurn(input: {
    threadId: string;
    root: string;
    model: string;
    effort: string;
    prompt: string;
  }): Promise<AgentExecutionTurn> {
    const result = await this.appServer.startTurn({
      threadId: input.threadId,
      input: [{ type: "text", text: input.prompt }],
      cwd: input.root,
      runtimeWorkspaceRoots: [input.root],
      approvalPolicy: "never",
      sandboxPolicy: {
        type: "workspaceWrite",
        writableRoots: [input.root],
        networkAccess: false,
        excludeTmpdirEnvVar: true,
        excludeSlashTmp: true,
      },
      model: input.model,
      effort: input.effort,
    });
    if (
      !isRecord(result) ||
      !isRecord(result.turn) ||
      typeof result.turn.id !== "string" ||
      result.turn.id.length === 0 ||
      result.turn.id.length > 512 ||
      !["completed", "interrupted", "failed", "inProgress"].includes(
        String(result.turn.status),
      )
    ) {
      throw new AgentAdapterError("app_server_incompatible");
    }
    return {
      turnId: result.turn.id,
      status: result.turn.status as AgentExecutionTurn["status"],
    };
  }

  async interruptTurn(input: {
    threadId: string;
    turnId: string;
  }): Promise<void> {
    const result = await this.appServer.interruptTurn(input);
    if (
      result !== null &&
      (!isRecord(result) || Object.keys(result).length > 0)
    ) {
      throw new AgentAdapterError("app_server_incompatible");
    }
  }

  async close(): Promise<void> {
    await this.appServer.close();
  }
}

function boundedIdentifier(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= 512
    ? value
    : undefined;
}

let sharedCodexAdapter: CodexAgentAdapter | undefined;

export function getCodexAgentAdapter(): AgentExecutionAdapter {
  sharedCodexAdapter ??= new CodexAgentAdapter();
  return sharedCodexAdapter;
}
