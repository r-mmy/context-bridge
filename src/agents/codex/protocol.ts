import type { Readable, Writable } from "node:stream";
import { TextDecoder } from "node:util";
import { AgentAdapterError } from "../errors.js";

export const MAX_PROTOCOL_LINE_BYTES = 1024 * 1024;
export const MAX_PENDING_REQUESTS = 32;
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

type RpcId = number | string;

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (error: AgentAdapterError) => void;
  timeout: NodeJS.Timeout;
}

export interface JsonRpcNotification {
  method: string;
  params: unknown;
}

export interface JsonRpcConnectionOptions {
  requestTimeoutMs?: number;
  maxLineBytes?: number;
  maxPendingRequests?: number;
  onNotification?: (notification: JsonRpcNotification) => void;
  onFailure?: (error: AgentAdapterError) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isRequestId(value: unknown): value is RpcId {
  return (
    (typeof value === "number" && Number.isSafeInteger(value)) ||
    (typeof value === "string" && value.length > 0 && value.length <= 128)
  );
}

/** Internal bounded JSONL transport for the Codex App Server. */
export class JsonRpcConnection {
  private readonly pending = new Map<number, PendingRequest>();
  private readonly requestTimeoutMs: number;
  private readonly maxLineBytes: number;
  private readonly maxPendingRequests: number;
  private readonly onNotification: (notification: JsonRpcNotification) => void;
  private readonly onFailure: (error: AgentAdapterError) => void;
  private readonly fragments: Buffer[] = [];
  private fragmentBytes = 0;
  private nextId = 1;
  private failure: AgentAdapterError | undefined;

  constructor(
    private readonly stdin: Writable,
    stdout: Readable,
    options: JsonRpcConnectionOptions = {},
  ) {
    this.requestTimeoutMs =
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.maxLineBytes = options.maxLineBytes ?? MAX_PROTOCOL_LINE_BYTES;
    this.maxPendingRequests =
      options.maxPendingRequests ?? MAX_PENDING_REQUESTS;
    this.onNotification = options.onNotification ?? (() => undefined);
    this.onFailure = options.onFailure ?? (() => undefined);

    stdin.on("error", () =>
      this.fail(new AgentAdapterError("app_server_exited")),
    );
    stdout.on("data", (chunk: Buffer | string) => this.receive(chunk));
    stdout.on("error", () =>
      this.fail(new AgentAdapterError("app_server_exited")),
    );
    stdout.on("end", () =>
      this.fail(new AgentAdapterError("app_server_exited")),
    );
  }

  request(
    method: string,
    params: Record<string, unknown>,
    timeoutMs = this.requestTimeoutMs,
  ): Promise<unknown> {
    if (this.failure) return Promise.reject(this.failure);
    if (this.pending.size >= this.maxPendingRequests) {
      return Promise.reject(new AgentAdapterError("app_server_protocol_error"));
    }
    if (!method || method.length > 256 || !Number.isSafeInteger(this.nextId)) {
      this.fail(new AgentAdapterError("app_server_protocol_error"));
      return Promise.reject(new AgentAdapterError("app_server_protocol_error"));
    }

    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.fail(new AgentAdapterError("app_server_timeout"));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timeout });
      this.writeMessage({ id, method, params });
    });
  }

  notify(method: string, params?: Record<string, unknown>): void {
    if (this.failure) throw this.failure;
    if (!method || method.length > 256) {
      this.fail(new AgentAdapterError("app_server_protocol_error"));
      throw new AgentAdapterError("app_server_protocol_error");
    }
    this.writeMessage({ method, ...(params ? { params } : {}) });
  }

  fail(error: AgentAdapterError, notify = true): void {
    if (this.failure) return;
    this.failure = error;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
    if (notify) this.onFailure(error);
  }

  private writeMessage(message: Record<string, unknown>): void {
    let line: string;
    try {
      line = `${JSON.stringify(message)}\n`;
    } catch {
      this.fail(new AgentAdapterError("app_server_protocol_error"));
      return;
    }
    if (Buffer.byteLength(line, "utf8") > this.maxLineBytes) {
      this.fail(new AgentAdapterError("app_server_protocol_error"));
      return;
    }
    try {
      this.stdin.write(line, "utf8", (error?: Error | null) => {
        if (error) this.fail(new AgentAdapterError("app_server_exited"));
      });
    } catch {
      this.fail(new AgentAdapterError("app_server_exited"));
    }
  }

  private receive(chunk: Buffer | string): void {
    if (this.failure) return;
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8");
    let segmentStart = 0;
    for (let index = 0; index < bytes.length; index += 1) {
      if (bytes[index] !== 0x0a) continue;
      if (!this.appendFragment(bytes.subarray(segmentStart, index))) return;
      let line = Buffer.concat(this.fragments, this.fragmentBytes);
      this.fragments.length = 0;
      this.fragmentBytes = 0;
      if (line.length > 0 && line[line.length - 1] === 0x0d) {
        line = line.subarray(0, line.length - 1);
      }
      this.handleLine(line);
      if (this.failure) return;
      segmentStart = index + 1;
    }
    if (segmentStart < bytes.length) {
      this.appendFragment(bytes.subarray(segmentStart));
    }
  }

  private appendFragment(fragment: Buffer): boolean {
    if (this.fragmentBytes + fragment.length > this.maxLineBytes) {
      this.fail(new AgentAdapterError("app_server_protocol_error"));
      return false;
    }
    if (fragment.length > 0) {
      this.fragments.push(fragment);
      this.fragmentBytes += fragment.length;
    }
    return true;
  }

  private handleLine(line: Buffer): void {
    let value: unknown;
    try {
      value = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(line),
      ) as unknown;
    } catch {
      this.fail(new AgentAdapterError("app_server_protocol_error"));
      return;
    }
    if (!isRecord(value)) {
      this.fail(new AgentAdapterError("app_server_protocol_error"));
      return;
    }
    if (Object.hasOwn(value, "jsonrpc") && value.jsonrpc !== "2.0") {
      this.fail(new AgentAdapterError("app_server_protocol_error"));
      return;
    }

    if (Object.hasOwn(value, "method")) {
      if (
        typeof value.method !== "string" ||
        value.method.length === 0 ||
        value.method.length > 256 ||
        Object.hasOwn(value, "result") ||
        Object.hasOwn(value, "error")
      ) {
        this.fail(new AgentAdapterError("app_server_protocol_error"));
        return;
      }
      if (Object.hasOwn(value, "id")) {
        if (!isRequestId(value.id)) {
          this.fail(new AgentAdapterError("app_server_protocol_error"));
          return;
        }
        this.fail(new AgentAdapterError("app_server_protocol_error"));
        return;
      }
      try {
        this.onNotification({
          method: value.method,
          params: value.params,
        });
      } catch {
        this.fail(new AgentAdapterError("app_server_protocol_error"));
      }
      return;
    }

    if (
      !Object.hasOwn(value, "id") ||
      typeof value.id !== "number" ||
      !Number.isSafeInteger(value.id) ||
      Object.hasOwn(value, "result") === Object.hasOwn(value, "error")
    ) {
      this.fail(new AgentAdapterError("app_server_protocol_error"));
      return;
    }
    const pending = this.pending.get(value.id);
    if (!pending) return;
    this.pending.delete(value.id);
    clearTimeout(pending.timeout);

    if (Object.hasOwn(value, "error")) {
      const rpcError = value.error;
      if (
        !isRecord(rpcError) ||
        typeof rpcError.code !== "number" ||
        !Number.isInteger(rpcError.code) ||
        typeof rpcError.message !== "string"
      ) {
        pending.reject(new AgentAdapterError("app_server_protocol_error"));
        this.fail(new AgentAdapterError("app_server_protocol_error"));
        return;
      }
      pending.reject(
        new AgentAdapterError(
          rpcError.code === -32601
            ? "app_server_incompatible"
            : "app_server_protocol_error",
        ),
      );
      return;
    }
    pending.resolve(value.result);
  }
}
