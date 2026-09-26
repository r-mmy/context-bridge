import { appendFileSync } from "node:fs";
import process from "node:process";
import { setInterval } from "node:timers";

const mode = process.argv[2] ?? "normal";
const tracePath = process.argv[3];
let input = "";
const queuedRequests = [];

if (mode === "version") {
  process.stdout.write("codex-cli 0.155.0-alpha.16.3\n", () => process.exit(0));
}

function record(value) {
  if (!tracePath) return;
  appendFileSync(tracePath, `${JSON.stringify(value)}\n`, "utf8");
}

function send(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function accountResult() {
  if (mode === "auth-absent") {
    return { account: null, requiresOpenaiAuth: true };
  }
  return {
    account: {
      type: "chatgpt",
      email: "private-account-identity@example.invalid",
    },
    requiresOpenaiAuth: true,
  };
}

function modelPage(params) {
  if (mode === "malformed-models") return { data: "invalid" };
  if (mode === "paginated-models" && params.cursor === "page-2") {
    return {
      data: [
        {
          id: "gpt-6-sol",
          supportedReasoningEfforts: [{ reasoningEffort: "high" }],
        },
      ],
      nextCursor: null,
    };
  }
  const data = [
    {
      id: "gpt-6-luna",
      displayName: "Private Model Display Name",
      hidden: false,
      supportedReasoningEfforts: [
        { reasoningEffort: "low" },
        { reasoningEffort: "max" },
      ],
    },
    {
      id: "gpt-6-sol",
      supportedReasoningEfforts: [{ reasoningEffort: "high" }],
    },
    {
      id: "hidden-model",
      hidden: true,
      supportedReasoningEfforts: [{ reasoningEffort: "max" }],
    },
  ];
  return {
    data,
    nextCursor: mode === "paginated-models" ? "page-2" : null,
  };
}

function processRequest(request) {
  if (typeof request?.method !== "string") return;
  record({
    method: request.method,
    ...(request.params === undefined ? {} : { params: request.params }),
  });

  if (request.method === "initialize") {
    record({
      kind: "environment-check",
      hasOpenAiKey: Object.hasOwn(process.env, "OPENAI_API_KEY"),
      hasCodexKey: Object.hasOwn(process.env, "CODEX_API_KEY"),
      hasTunnelSecret: Object.hasOwn(process.env, "SECURE_MCP_TUNNEL_TOKEN"),
      hasContextBridgeSecret: Object.hasOwn(
        process.env,
        "CONTEXTBRIDGE_SECRET",
      ),
    });
    if (mode === "malformed-json") {
      process.stdout.write("{malformed-json\n");
      return;
    }
    if (mode === "malformed-rpc") {
      send({ id: request.id, result: "not-an-initialize-object" });
      return;
    }
    if (mode === "malformed-initialize-shape") {
      send({ id: request.id, result: { platformFamily: "windows" } });
      return;
    }
    if (mode === "server-request") {
      send({
        id: "server-owned-request",
        method: "item/tool/requestUserInput",
        params: {},
      });
      return;
    }
    if (mode === "oversized-line") {
      process.stdout.write(`${"x".repeat(1024 * 1024 + 1)}\n`);
      return;
    }
    if (mode === "timeout-initialize") return;
    if (mode === "exit-initialize") process.exit(17);
    if (mode === "no-server-version") {
      send({
        id: request.id,
        result: {
          userAgent: "codex_cli_rs",
          platformFamily: "windows",
          platformOs: "windows",
        },
      });
      return;
    }
    send({
      id: request.id,
      result: {
        userAgent: "codex_cli_rs/0.155.0-alpha.16.3",
        platformFamily: "windows",
        platformOs: "windows",
        serverInfo: { version: "0.155.0-alpha.16.3" },
      },
    });
    return;
  }

  if (request.method === "initialized") return;
  if (request.method === "account/read") {
    if (mode === "exit-account") process.exit(18);
    if (mode === "timeout-account") return;
    if (mode === "rpc-error") {
      process.stderr.write("PRIVATE_STDERR_SENTINEL C:\\local\\secret\\path\n");
      send({
        id: request.id,
        error: {
          code: -32603,
          message: "PRIVATE_PROTOCOL_SENTINEL C:\\local\\secret\\path",
        },
      });
      return;
    }
    const response = { id: request.id, result: accountResult() };
    if (mode === "out-of-order") {
      queuedRequests.push(response);
      if (queuedRequests.length === 2) {
        send(queuedRequests.pop());
        send(queuedRequests.pop());
      }
      return;
    }
    send(response);
    return;
  }

  if (request.method === "model/list") {
    const response = {
      id: request.id,
      result: modelPage(request.params ?? {}),
    };
    if (mode === "out-of-order") {
      queuedRequests.push(response);
      if (queuedRequests.length === 2) {
        send(queuedRequests.pop());
        send(queuedRequests.pop());
      }
      return;
    }
    send(response);
  }
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
  while (true) {
    const newline = input.indexOf("\n");
    if (newline < 0) break;
    const line = input.slice(0, newline).replace(/\r$/, "");
    input = input.slice(newline + 1);
    try {
      processRequest(JSON.parse(line));
    } catch {
      process.exit(19);
    }
  }
});
process.stdin.on("end", () => {
  if (mode === "version") return;
  if (mode !== "hang-on-close") process.exit(0);
});

if (mode === "hang-on-close") setInterval(() => undefined, 1_000);
