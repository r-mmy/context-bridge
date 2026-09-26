import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { JsonRpcConnection } from "../../src/agents/codex/protocol.js";

function connection(
  options: ConstructorParameters<typeof JsonRpcConnection>[2] = {},
) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const sent: Record<string, unknown>[] = [];
  const notifications: { method: string; params: unknown }[] = [];
  stdin.on("data", (chunk: Buffer) => {
    for (const line of chunk.toString("utf8").trimEnd().split("\n")) {
      sent.push(JSON.parse(line) as Record<string, unknown>);
    }
  });
  const client = new JsonRpcConnection(stdin, stdout, {
    ...options,
    onNotification: (notification) => notifications.push(notification),
  });
  return { client, stdin, stdout, sent, notifications };
}

function respond(stdout: PassThrough, value: Record<string, unknown>): void {
  stdout.write(`${JSON.stringify(value)}\n`);
}

describe("bounded App Server JSONL protocol", () => {
  it("allocates monotonic IDs and correlates out-of-order responses", async () => {
    const state = connection();
    const first = state.client.request("first", {});
    const second = state.client.request("second", {});
    expect(state.sent.map((request) => request.id)).toEqual([1, 2]);
    expect(state.sent[0]).toEqual({ id: 1, method: "first", params: {} });

    respond(state.stdout, { id: 99, result: "unknown" });
    respond(state.stdout, { id: 2, result: "second-result" });
    respond(state.stdout, { id: 1, result: "first-result" });

    await expect(second).resolves.toBe("second-result");
    await expect(first).resolves.toBe("first-result");
  });

  it("routes notifications separately from responses", async () => {
    const state = connection();
    const pending = state.client.request("safe/read", {});
    respond(state.stdout, {
      method: "account/updated",
      params: { authMode: "chatgpt" },
    });
    respond(state.stdout, { id: 1, result: { ok: true } });

    await expect(pending).resolves.toEqual({ ok: true });
    expect(state.notifications).toEqual([
      { method: "account/updated", params: { authMode: "chatgpt" } },
    ]);
  });

  it("recognizes and rejects server-initiated requests instead of treating them as responses", async () => {
    const state = connection();
    const pending = state.client.request("safe/read", {});
    respond(state.stdout, {
      id: 1,
      method: "item/tool/requestUserInput",
      params: { question: "ignored" },
    });

    await expect(pending).rejects.toMatchObject({
      code: "app_server_protocol_error",
    });
    expect(state.sent).toHaveLength(1);
  });

  it.each([
    ["malformed JSON", "{not-json"],
    ["non-object message", "[]"],
    ["wrong protocol version", '{"jsonrpc":"1.0","id":1,"result":{}}'],
    ["missing response result", '{"id":1}'],
    ["response with both result and error", '{"id":1,"result":{},"error":{}}'],
    ["invalid response ID", '{"id":"1","result":{}}'],
  ])("fails safely on %s", async (_label, line) => {
    const state = connection();
    const pending = state.client.request("safe/read", {});
    state.stdout.write(`${line}\n`);

    await expect(pending).rejects.toMatchObject({
      code: "app_server_protocol_error",
      message: expect.not.stringContaining("not-json"),
    });
  });

  it("bounds incoming protocol lines and pending request count", async () => {
    const oversized = connection({ maxLineBytes: 128 });
    const pending = oversized.client.request("safe/read", {});
    oversized.stdout.write(`${"x".repeat(129)}\n`);
    await expect(pending).rejects.toMatchObject({
      code: "app_server_protocol_error",
    });

    const limited = connection({ maxPendingRequests: 1 });
    const first = limited.client.request("first", {});
    await expect(limited.client.request("second", {})).rejects.toMatchObject({
      code: "app_server_protocol_error",
    });
    respond(limited.stdout, { id: 1, result: "ok" });
    await expect(first).resolves.toBe("ok");
  });

  it("rejects invalid UTF-8 protocol data instead of accepting replacement characters", async () => {
    const state = connection();
    const pending = state.client.request("safe/read", {});
    state.stdout.write(
      Buffer.from([0x7b, 0x22, 0x61, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d, 0x0a]),
    );
    await expect(pending).rejects.toMatchObject({
      code: "app_server_protocol_error",
    });
  });

  it("times out and rejects every pending request with a safe error", async () => {
    const state = connection({ requestTimeoutMs: 15 });
    const first = state.client.request("first", {});
    const second = state.client.request("second", {});

    await expect(first).rejects.toMatchObject({ code: "app_server_timeout" });
    await expect(second).rejects.toMatchObject({ code: "app_server_timeout" });
  });

  it("rejects pending requests when stdin fails", async () => {
    const state = connection();
    const pending = state.client.request("safe/read", {});
    state.stdin.destroy(new Error("private failure detail"));

    await expect(pending).rejects.toMatchObject({
      code: "app_server_exited",
      message: expect.not.stringContaining("private failure detail"),
    });
  });
});
