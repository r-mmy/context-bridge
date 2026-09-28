import { randomUUID } from "node:crypto";
import {
  spawn as nodeSpawn,
  type ChildProcessWithoutNullStreams,
  type SpawnOptions,
} from "node:child_process";
import os from "node:os";
import path from "node:path";
import { AgentAdapterError, safeAgentAdapterError } from "../errors.js";
import {
  PINNED_CODEX_VERSION,
  resolveCodexRuntime,
  type CodexRuntime,
} from "./runtime.js";
import {
  DEFAULT_REQUEST_TIMEOUT_MS,
  JsonRpcConnection,
  type JsonRpcNotification,
} from "./protocol.js";

const CODEX_ARGUMENTS = [
  "app-server",
  "--config",
  "thread_unload_delay_secs=0",
  "--listen",
  "stdio://",
];
const INITIALIZE_TIMEOUT_MS = 30_000;
const GRACEFUL_SHUTDOWN_MS = 1_500;
const FORCED_SHUTDOWN_MS = 500;
const VERSION_QUERY_TIMEOUT_MS = 3_000;
const MAX_VERSION_OUTPUT_BYTES = 4_096;

export interface AppServerInfo {
  version: string | null;
}

export interface AppServerOptions {
  /** Internal test seam; never sourced from CLI, policy, or MCP input. */
  spawnProcess?: (
    executable: string,
    args: string[],
    options: SpawnOptions,
  ) => ChildProcessWithoutNullStreams;
  /** Internal test seam; never sourced from CLI, policy, or MCP input. */
  resolveRuntime?: () => Promise<CodexRuntime>;
  environment?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  homeDirectory?: string;
  requestTimeoutMs?: number;
  shutdownTimeoutMs?: number;
}

type AppServerEvent =
  | { type: "notification"; value: JsonRpcNotification }
  | {
      type: "server_request";
      correlationId: string;
      method: string;
      params: unknown;
    }
  | { type: "failure" };

const SERVER_REQUEST_ERROR = {
  code: -32000,
  message:
    "The request requires a local action that Context Bridge cannot perform.",
} as const;

function addIfPresent(
  output: NodeJS.ProcessEnv,
  key: string,
  value: string | undefined,
): void {
  if (value !== undefined && value.length > 0) output[key] = value;
}

export function buildCodexChildEnvironment(
  platform: NodeJS.Platform = process.platform,
  source: NodeJS.ProcessEnv = process.env,
  homeDirectory: string = os.homedir(),
): NodeJS.ProcessEnv {
  const output: NodeJS.ProcessEnv = {};
  const join = platform === "win32" ? path.win32.join : path.join;
  const codexHome = source.CODEX_HOME || join(homeDirectory, ".codex");
  addIfPresent(output, "CODEX_HOME", codexHome);
  addIfPresent(output, "PATH", source.PATH);

  if (platform === "win32") {
    const userProfile = source.USERPROFILE || homeDirectory;
    addIfPresent(output, "USERPROFILE", userProfile);
    addIfPresent(output, "HOME", source.HOME || userProfile);
    addIfPresent(
      output,
      "APPDATA",
      source.APPDATA || join(userProfile, "AppData", "Roaming"),
    );
    addIfPresent(
      output,
      "LOCALAPPDATA",
      source.LOCALAPPDATA || join(userProfile, "AppData", "Local"),
    );
    addIfPresent(output, "SYSTEMROOT", source.SYSTEMROOT ?? source.SystemRoot);
    addIfPresent(output, "TEMP", source.TEMP ?? source.Tmp);
    addIfPresent(output, "TMP", source.TMP ?? source.Tmp);
  } else {
    addIfPresent(output, "HOME", source.HOME || homeDirectory);
    addIfPresent(output, "TMPDIR", source.TMPDIR);
    addIfPresent(output, "LANG", source.LANG);
    addIfPresent(output, "LC_ALL", source.LC_ALL);
  }
  return output;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function safeVersion(result: Record<string, unknown>): string | null {
  const serverInfo = isRecord(result.serverInfo)
    ? result.serverInfo
    : undefined;
  const direct = serverInfo?.version ?? result.version ?? result.codexVersion;
  if (
    typeof direct === "string" &&
    /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]{1,48})?$/.test(direct)
  ) {
    return direct;
  }
  const userAgent = result.userAgent;
  if (typeof userAgent === "string") {
    const match = userAgent.match(
      /codex(?:_cli_rs)?[/@ ]v?([0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?)/i,
    );
    if (match?.[1]) return match[1];
  }
  return null;
}

function parseCliVersion(output: string): string | null {
  if (Buffer.byteLength(output, "utf8") > MAX_VERSION_OUTPUT_BYTES) return null;
  const match = output.match(
    /(?:^|\s)v?([0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?)(?:\s|$)/,
  );
  return match?.[1] ?? null;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

class AppServerSession {
  readonly closed: Promise<void>;
  readonly connection: JsonRpcConnection;
  private resolveClosed!: () => void;
  private closedState = false;
  private stopping = false;
  private failure: AgentAdapterError | undefined;
  private backendInfo: AppServerInfo | undefined;
  private readonly pendingServerRequests = new Map<string, number | string>();

  constructor(
    readonly child: ChildProcessWithoutNullStreams,
    private readonly requestTimeoutMs: number,
    private readonly emit: (event: AppServerEvent) => boolean,
  ) {
    this.closed = new Promise((resolve) => {
      this.resolveClosed = resolve;
    });
    this.connection = new JsonRpcConnection(child.stdin, child.stdout, {
      requestTimeoutMs,
      onNotification: (value) => {
        this.emit({ type: "notification", value });
      },
      onServerRequest: (value) => {
        if (this.pendingServerRequests.size >= 32) return false;
        const correlationId = randomUUID();
        this.pendingServerRequests.set(correlationId, value.id);
        const accepted = this.emit({
          type: "server_request",
          correlationId,
          method: value.method,
          params: value.params,
        });
        if (!accepted) this.pendingServerRequests.delete(correlationId);
        return accepted;
      },
      onFailure: (error) => this.fail(error),
    });

    child.stderr.on("data", () => undefined);
    child.on("error", (error: NodeJS.ErrnoException) => {
      this.fail(safeAgentAdapterError(error));
    });
    const observeChildEnd = () => {
      if (this.closedState) return;
      this.closedState = true;
      this.resolveClosed();
      if (!this.stopping) {
        this.fail(new AgentAdapterError("app_server_exited"));
      }
      // A runtime launcher may leave descendants holding inherited stdio
      // handles after the App Server process exits. No further protocol data
      // is trustworthy once that process is gone, and destroying these local
      // streams lets the session unload without waiting for those handles.
      this.child.stdin.destroy();
      this.child.stdout.destroy();
      this.child.stderr.destroy();
    };
    child.on("exit", observeChildEnd);
    child.on("close", observeChildEnd);
  }

  get isUsable(): boolean {
    return !this.closedState && !this.failure;
  }

  get info(): AppServerInfo | undefined {
    return this.backendInfo;
  }

  async initialize(): Promise<AppServerInfo> {
    const result = await this.connection.request(
      "initialize",
      {
        clientInfo: {
          name: "context_bridge",
          title: "Context Bridge",
          version: "0.2.0",
        },
        capabilities: { experimentalApi: true },
      },
      INITIALIZE_TIMEOUT_MS,
    );
    if (
      !isRecord(result) ||
      typeof result.userAgent !== "string" ||
      result.userAgent.length === 0 ||
      result.userAgent.length > 512 ||
      typeof result.platformFamily !== "string" ||
      result.platformFamily.length === 0 ||
      result.platformFamily.length > 64 ||
      typeof result.platformOs !== "string" ||
      result.platformOs.length === 0 ||
      result.platformOs.length > 64
    ) {
      throw new AgentAdapterError("app_server_incompatible");
    }
    const info = { version: safeVersion(result) };
    this.connection.notify("initialized");
    this.backendInfo = info;
    return info;
  }

  async request(
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    if (this.failure) throw this.failure;
    if (this.closedState) throw new AgentAdapterError("app_server_exited");
    return this.connection.request(method, params, this.requestTimeoutMs);
  }

  async answerUserInput(
    correlationId: string,
    answers: Array<{ questionId: string; answers: string[] }>,
  ): Promise<void> {
    if (
      answers.length < 1 ||
      answers.length > 10 ||
      answers.some(
        (entry) =>
          entry.questionId.length === 0 ||
          entry.questionId.length > 256 ||
          entry.answers.length < 1 ||
          entry.answers.length > 2 ||
          entry.answers.some(
            (answer) =>
              answer.length === 0 || Buffer.byteLength(answer, "utf8") > 4096,
          ),
      )
    ) {
      throw new AgentAdapterError("app_server_protocol_error");
    }
    const answerMap = Object.create(null) as Record<
      string,
      { answers: string[] }
    >;
    for (const entry of answers)
      answerMap[entry.questionId] = { answers: entry.answers };
    await this.respondServerRequest(correlationId, {
      result: { answers: answerMap },
    });
  }

  async rejectServerRequest(correlationId: string): Promise<void> {
    await this.respondServerRequest(correlationId, {
      error: SERVER_REQUEST_ERROR,
    });
  }

  async close(gracefulTimeoutMs: number): Promise<void> {
    this.stopping = true;
    this.pendingServerRequests.clear();
    this.connection.fail(new AgentAdapterError("app_server_exited"), false);
    if (this.closedState) return;
    this.child.stdin.end();
    if (await this.waitForClose(gracefulTimeoutMs)) return;

    try {
      this.child.kill("SIGTERM");
    } catch {
      // The child may have exited between the close check and kill.
    }
    if (await this.waitForClose(FORCED_SHUTDOWN_MS)) return;

    try {
      this.child.kill("SIGKILL");
    } catch {
      // The child may have exited between the close check and kill.
    }
    await this.waitForClose(FORCED_SHUTDOWN_MS);
  }

  private async waitForClose(milliseconds: number): Promise<boolean> {
    if (this.closedState) return true;
    return Promise.race([
      this.closed.then(() => true),
      delay(milliseconds).then(() => false),
    ]);
  }

  private fail(error: AgentAdapterError): void {
    if (this.failure) return;
    this.failure = error;
    this.pendingServerRequests.clear();
    this.emit({ type: "failure" });
    this.connection.fail(error, false);
    if (!this.closedState && !this.stopping) {
      try {
        this.child.kill();
      } catch {
        // The child may already have exited.
      }
    }
  }

  private async respondServerRequest(
    correlationId: string,
    response:
      | { result: Record<string, unknown> }
      | { error: { code: number; message: string } },
  ): Promise<void> {
    const id = this.pendingServerRequests.get(correlationId);
    if (id === undefined)
      throw new AgentAdapterError("app_server_protocol_error");
    this.pendingServerRequests.delete(correlationId);
    await this.connection.respondServerRequest(id, response);
  }
}

export class CodexAppServer {
  private readonly spawnProcess: NonNullable<AppServerOptions["spawnProcess"]>;
  private readonly resolveRuntime: NonNullable<
    AppServerOptions["resolveRuntime"]
  >;
  private readonly environment: NodeJS.ProcessEnv;
  private readonly platform: NodeJS.Platform;
  private readonly homeDirectory: string;
  private readonly requestTimeoutMs: number;
  private readonly shutdownTimeoutMs: number;
  private session: AppServerSession | undefined;
  private starting: Promise<AppServerInfo> | undefined;
  private readonly listeners = new Set<(event: AppServerEvent) => void>();

  constructor(options: AppServerOptions = {}) {
    this.spawnProcess =
      options.spawnProcess ??
      ((executable, args, spawnOptions) =>
        nodeSpawn(
          executable,
          args,
          spawnOptions,
        ) as ChildProcessWithoutNullStreams);
    this.resolveRuntime = options.resolveRuntime ?? resolveCodexRuntime;
    this.environment = options.environment ?? process.env;
    this.platform = options.platform ?? process.platform;
    this.homeDirectory = options.homeDirectory ?? os.homedir();
    this.requestTimeoutMs =
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.shutdownTimeoutMs = options.shutdownTimeoutMs ?? GRACEFUL_SHUTDOWN_MS;
  }

  async start(): Promise<AppServerInfo> {
    if (this.session?.isUsable && this.session.info) return this.session.info;
    if (this.starting) return this.starting;
    const starting = this.startInner();
    this.starting = starting;
    void starting.then(
      () => {
        if (this.starting === starting) this.starting = undefined;
      },
      () => {
        if (this.starting === starting) this.starting = undefined;
      },
    );
    return starting;
  }

  async readAccount(): Promise<unknown> {
    const session = await this.getReadySession();
    return session.request("account/read", { refreshToken: false });
  }

  async listModels(cursor?: string): Promise<unknown> {
    const session = await this.getReadySession();
    return session.request("model/list", {
      limit: 100,
      includeHidden: false,
      ...(cursor ? { cursor } : {}),
    });
  }

  subscribe(listener: (event: AppServerEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async startThread(params: {
    model: string;
    allowProviderModelFallback: false;
    cwd: string;
    runtimeWorkspaceRoots: [string];
    approvalPolicy: "never";
    sandbox: "workspace-write";
  }): Promise<unknown> {
    const session = await this.getReadySession();
    return session.request("thread/start", params);
  }

  async resumeThread(params: {
    threadId: string;
    model: string;
    cwd: string;
    runtimeWorkspaceRoots: [string];
    approvalPolicy: "never";
    sandbox: "workspace-write";
    excludeTurns: true;
  }): Promise<unknown> {
    const session = await this.getReadySession();
    return session.request("thread/resume", params);
  }

  async startTurn(params: {
    threadId: string;
    input: [{ type: "text"; text: string }];
    cwd: string;
    runtimeWorkspaceRoots: [string];
    approvalPolicy: "never";
    sandboxPolicy: {
      type: "workspaceWrite";
      writableRoots: [string];
      networkAccess: false;
      excludeTmpdirEnvVar: true;
      excludeSlashTmp: true;
    };
    model: string;
    effort: string;
    collaborationMode: {
      mode: "default" | "plan";
      settings: {
        model: string;
        reasoning_effort: string;
        developer_instructions: null;
      };
    };
  }): Promise<unknown> {
    const session = await this.getReadySession();
    return session.request("turn/start", params);
  }

  async interruptTurn(params: {
    threadId: string;
    turnId: string;
  }): Promise<unknown> {
    const session = await this.getReadySession();
    return session.request("turn/interrupt", params);
  }

  async answerUserInput(params: {
    correlationId: string;
    answers: Array<{ questionId: string; answers: string[] }>;
  }): Promise<void> {
    return this.requireCurrentSession().answerUserInput(
      params.correlationId,
      params.answers,
    );
  }

  async rejectServerRequest(params: { correlationId: string }): Promise<void> {
    return this.requireCurrentSession().rejectServerRequest(
      params.correlationId,
    );
  }

  async setThreadName(params: {
    threadId: string;
    name: string;
  }): Promise<unknown> {
    const session = await this.getReadySession();
    return session.request("thread/name/set", params);
  }

  async unsubscribeThread(params: { threadId: string }): Promise<unknown> {
    const session = await this.getReadySession();
    return session.request("thread/unsubscribe", params);
  }

  async close(): Promise<void> {
    const starting = this.starting;
    if (starting) await starting.catch(() => undefined);
    const session = this.session;
    this.session = undefined;
    if (session) await session.close(this.shutdownTimeoutMs);
  }

  private async getReadySession(): Promise<AppServerSession> {
    await this.start();
    const session = this.session;
    if (!session?.isUsable) throw new AgentAdapterError("app_server_exited");
    return session;
  }

  private requireCurrentSession(): AppServerSession {
    const session = this.session;
    if (!session?.isUsable) throw new AgentAdapterError("app_server_exited");
    return session;
  }

  private async startInner(): Promise<AppServerInfo> {
    const previous = this.session;
    this.session = undefined;
    if (previous) await previous.close(this.shutdownTimeoutMs);

    let runtime: CodexRuntime;
    try {
      runtime = await this.resolveRuntime();
    } catch {
      throw new AgentAdapterError("codex_runtime_unavailable");
    }
    if (
      runtime === null ||
      typeof runtime !== "object" ||
      runtime.source !== "managed" ||
      runtime.executable !== process.execPath ||
      runtime.version !== PINNED_CODEX_VERSION ||
      !Array.isArray(runtime.argsPrefix) ||
      runtime.argsPrefix.length !== 1 ||
      typeof runtime.argsPrefix[0] !== "string" ||
      !path.isAbsolute(runtime.argsPrefix[0] ?? "")
    ) {
      throw new AgentAdapterError("codex_runtime_unavailable");
    }

    const runtimeVersion = await this.queryCliVersion(runtime);
    if (runtimeVersion !== runtime.version) {
      throw new AgentAdapterError("codex_runtime_unavailable");
    }

    let child: ChildProcessWithoutNullStreams;
    try {
      child = this.spawnProcess(
        runtime.executable,
        [...runtime.argsPrefix, ...CODEX_ARGUMENTS],
        {
          shell: false,
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: this.platform === "win32",
          env: buildCodexChildEnvironment(
            this.platform,
            this.environment,
            this.homeDirectory,
          ),
        },
      );
    } catch (error) {
      throw safeAgentAdapterError(error);
    }

    const session = new AppServerSession(
      child,
      this.requestTimeoutMs,
      (event) => {
        let handled = false;
        for (const listener of this.listeners) {
          try {
            listener(event);
            handled = true;
          } catch {
            // A consumer bug must not corrupt JSON-RPC framing.
          }
        }
        return handled;
      },
    );
    this.session = session;
    try {
      const info = await session.initialize();
      if (info.version && info.version !== runtime.version) {
        throw new AgentAdapterError("app_server_incompatible");
      }
      return { version: info.version ?? runtimeVersion };
    } catch (error) {
      await session.close(this.shutdownTimeoutMs);
      if (this.session === session) this.session = undefined;
      if (error instanceof AgentAdapterError) throw error;
      throw new AgentAdapterError("app_server_start_failed");
    }
  }

  private async queryCliVersion(runtime: CodexRuntime): Promise<string | null> {
    return await new Promise((resolve) => {
      let child: ChildProcessWithoutNullStreams;
      try {
        child = this.spawnProcess(
          runtime.executable,
          [...runtime.argsPrefix, "--version"],
          {
            shell: false,
            stdio: ["pipe", "pipe", "pipe"],
            windowsHide: this.platform === "win32",
            env: buildCodexChildEnvironment(
              this.platform,
              this.environment,
              this.homeDirectory,
            ),
          },
        );
      } catch {
        resolve(null);
        return;
      }

      let output = "";
      let outputBytes = 0;
      let settled = false;
      const finish = (version: string | null): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve(version);
      };
      const timeout = setTimeout(() => {
        try {
          child.kill();
        } catch {
          // The one-shot version child may already have exited.
        }
        finish(null);
      }, VERSION_QUERY_TIMEOUT_MS);

      child.stdout.on("data", (chunk: Buffer | string) => {
        if (settled) return;
        const bytes = Buffer.isBuffer(chunk)
          ? chunk
          : Buffer.from(chunk, "utf8");
        outputBytes += bytes.length;
        if (outputBytes > MAX_VERSION_OUTPUT_BYTES) {
          try {
            child.kill();
          } catch {
            // The child may already have exited.
          }
          finish(null);
          return;
        }
        output += bytes.toString("utf8");
      });
      child.stderr.on("data", () => undefined);
      child.on("error", () => finish(null));
      child.on("close", (code) => {
        finish(code === 0 ? parseCliVersion(output) : null);
      });
      child.stdin.end();
    });
  }
}
