import {
  spawn as nodeSpawn,
  type ChildProcessWithoutNullStreams,
  type SpawnOptions,
} from "node:child_process";
import os from "node:os";
import path from "node:path";
import { AgentAdapterError, safeAgentAdapterError } from "../errors.js";
import { DEFAULT_REQUEST_TIMEOUT_MS, JsonRpcConnection } from "./protocol.js";

const CODEX_EXECUTABLE = "codex";
const CODEX_ARGUMENTS = ["app-server", "--listen", "stdio://"];
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
  environment?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  homeDirectory?: string;
  requestTimeoutMs?: number;
  shutdownTimeoutMs?: number;
}

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

  constructor(
    readonly child: ChildProcessWithoutNullStreams,
    private readonly requestTimeoutMs: number,
  ) {
    this.closed = new Promise((resolve) => {
      this.resolveClosed = resolve;
    });
    this.connection = new JsonRpcConnection(child.stdin, child.stdout, {
      requestTimeoutMs,
      onFailure: (error) => this.fail(error),
    });

    child.stderr.on("data", () => undefined);
    child.on("error", (error: NodeJS.ErrnoException) => {
      this.fail(safeAgentAdapterError(error));
    });
    child.on("close", () => {
      this.closedState = true;
      this.resolveClosed();
      if (!this.stopping) {
        this.fail(new AgentAdapterError("app_server_exited"));
      }
    });
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
          version: "0.1.0",
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

  async close(gracefulTimeoutMs: number): Promise<void> {
    this.stopping = true;
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
    this.connection.fail(error, false);
    if (!this.closedState && !this.stopping) {
      try {
        this.child.kill();
      } catch {
        // The child may already have exited.
      }
    }
  }
}

export class CodexAppServer {
  private readonly spawnProcess: NonNullable<AppServerOptions["spawnProcess"]>;
  private readonly environment: NodeJS.ProcessEnv;
  private readonly platform: NodeJS.Platform;
  private readonly homeDirectory: string;
  private readonly requestTimeoutMs: number;
  private readonly shutdownTimeoutMs: number;
  private session: AppServerSession | undefined;
  private starting: Promise<AppServerInfo> | undefined;
  private cliVersion: Promise<string | null> | undefined;

  constructor(options: AppServerOptions = {}) {
    this.spawnProcess =
      options.spawnProcess ??
      ((executable, args, spawnOptions) =>
        nodeSpawn(
          executable,
          args,
          spawnOptions,
        ) as ChildProcessWithoutNullStreams);
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

  private async startInner(): Promise<AppServerInfo> {
    const previous = this.session;
    this.session = undefined;
    if (previous) await previous.close(this.shutdownTimeoutMs);

    let child: ChildProcessWithoutNullStreams;
    try {
      child = this.spawnProcess(CODEX_EXECUTABLE, [...CODEX_ARGUMENTS], {
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: this.platform === "win32",
        env: buildCodexChildEnvironment(
          this.platform,
          this.environment,
          this.homeDirectory,
        ),
      });
    } catch (error) {
      throw safeAgentAdapterError(error);
    }

    const session = new AppServerSession(child, this.requestTimeoutMs);
    this.session = session;
    try {
      const info = await session.initialize();
      if (info.version) return info;
      this.cliVersion ??= this.queryCliVersion();
      return { version: await this.cliVersion };
    } catch (error) {
      await session.close(this.shutdownTimeoutMs);
      if (this.session === session) this.session = undefined;
      if (error instanceof AgentAdapterError) throw error;
      throw new AgentAdapterError("app_server_start_failed");
    }
  }

  private async queryCliVersion(): Promise<string | null> {
    return await new Promise((resolve) => {
      let child: ChildProcessWithoutNullStreams;
      try {
        child = this.spawnProcess(CODEX_EXECUTABLE, ["--version"], {
          shell: false,
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: this.platform === "win32",
          env: buildCodexChildEnvironment(
            this.platform,
            this.environment,
            this.homeDirectory,
          ),
        });
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
