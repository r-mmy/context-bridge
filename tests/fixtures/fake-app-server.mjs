import { appendFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { setInterval, setTimeout } from "node:timers";

const mode = process.argv[2] ?? "normal";
const tracePath = process.argv[3];
const startupMutationRoot = process.argv[4];
let input = "";
const queuedRequests = [];
let executionTurnStartCount = 0;

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
  if (mode === "model-unavailable") {
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
    if (mode === "startup-artifact" && startupMutationRoot) {
      writeFileSync(
        path.join(startupMutationRoot, "synthetic-artifact.txt"),
        "created by the fake App Server\n",
        "utf8",
      );
    }
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
    return;
  }

  if (request.method === "thread/start") {
    const params = request.params ?? {};
    const executionThreadId = `fake-thread-${request.id}`;
    const root = params.runtimeWorkspaceRoots?.[0];
    record({
      kind: "thread-security-check",
      oneRuntimeRoot: params.runtimeWorkspaceRoots?.length === 1,
      cwdMatchesRoot: params.cwd === root,
      approvalNever: params.approvalPolicy === "never",
      workspaceWrite: params.sandbox === "workspace-write",
      noProviderFallback: params.allowProviderModelFallback === false,
      noConfigOverride: !Object.hasOwn(params, "config"),
      noAdditionalWritableRoots: true,
      model: params.model,
    });
    const response = {
      id: request.id,
      result: {
        thread: { id: executionThreadId },
        model: params.model,
        modelProvider: "openai",
        serviceTier: null,
        cwd: params.cwd,
        runtimeWorkspaceRoots: params.runtimeWorkspaceRoots,
        instructionSources: [],
        approvalPolicy: params.approvalPolicy,
        approvalsReviewer: null,
        sandbox: {
          type: "workspaceWrite",
          writableRoots: [root],
          networkAccess: false,
          excludeTmpdirEnvVar: true,
          excludeSlashTmp: true,
        },
        activePermissionProfile: null,
        reasoningEffort: "max",
        multiAgentMode: "explicitRequestOnly",
      },
    };
    if (mode === "wrong-thread-roots") {
      response.result.runtimeWorkspaceRoots = [];
    }
    send(response);
    return;
  }

  if (request.method === "turn/start") {
    const params = request.params ?? {};
    const policy = params.sandboxPolicy ?? {};
    const root = params.runtimeWorkspaceRoots?.[0];
    executionTurnStartCount += 1;
    record({
      kind: "execution-security-check",
      oneRuntimeRoot: params.runtimeWorkspaceRoots?.length === 1,
      cwdMatchesRoot: params.cwd === root,
      oneWritableRoot: policy.writableRoots?.length === 1,
      writableRootMatches: policy.writableRoots?.[0] === root,
      approvalNever: params.approvalPolicy === "never",
      networkDisabled: policy.networkAccess === false,
      excludesTemp: policy.excludeTmpdirEnvVar === true,
      excludesSlashTmp: policy.excludeSlashTmp === true,
      defaultMode: !Object.hasOwn(params, "collaborationMode"),
      oneTextInput:
        params.input?.length === 1 && params.input[0]?.type === "text",
      model: params.model,
      effort: params.effort,
    });
    const executionTurnId = `fake-turn-${request.id}`;
    if (mode === "turn-start-rejected") {
      send({
        id: request.id,
        error: {
          code: -32603,
          message: "PRIVATE_TURN_START_ERROR C:\\local\\private\\path",
        },
      });
      return;
    }
    if (mode === "turn-start-lost-response") process.exit(24);
    if (
      mode === "terminal-start-result" ||
      mode === "terminal-start-result-with-notification"
    ) {
      send({
        id: request.id,
        result: {
          turn: { id: executionTurnId, status: "completed", items: [] },
        },
      });
      if (mode === "terminal-start-result-with-notification") {
        setTimeout(() => {
          send({
            method: "turn/completed",
            params: {
              threadId: params.threadId,
              turn: { id: executionTurnId, status: "completed", items: [] },
            },
          });
        }, 1);
      }
      return;
    }
    if (mode === "server-request" || mode === "execution-server-request") {
      send({
        id: "ephemeral-private-server-request-id",
        method: "item/tool/requestUserInput",
        params: {
          threadId: params.threadId,
          turnId: executionTurnId,
          questions: [{ question: "private question text" }],
        },
      });
    }
    send({
      method: "turn/started",
      params: {
        threadId: params.threadId,
        turn: { id: executionTurnId, status: "inProgress", items: [] },
      },
    });
    send({
      method: "item/started",
      params: {
        threadId: params.threadId,
        turnId: executionTurnId,
        item: {
          id: "private-command-item",
          type: "commandExecution",
          command: "not captured",
        },
      },
    });
    if (mode === "process-death") {
      send({
        id: request.id,
        result: { turn: { id: executionTurnId, status: "inProgress" } },
      });
      setTimeout(() => process.exit(23), 10);
      return;
    }
    send({
      id: request.id,
      result: { turn: { id: executionTurnId, status: "inProgress" } },
    });
    if (
      mode === "execution-uncorrelated-after-two" &&
      executionTurnStartCount === 2
    ) {
      setTimeout(() => {
        send({
          id: "ephemeral-uncorrelated-request-id",
          method: "item/tool/requestUserInput",
          params: {
            threadId: "unknown-private-thread-id",
            turnId: "unknown-private-turn-id",
            questions: [{ question: "uncorrelated private question" }],
          },
        });
      }, 100);
    }
    const complete = () => {
      if (mode === "delayed-turn") return;
      send({
        method: "item/completed",
        params: {
          threadId: params.threadId,
          turnId: executionTurnId,
          item: {
            id: "private-final-item",
            type: "agentMessage",
            phase: "final_answer",
            text:
              mode === "huge-final"
                ? "x".repeat(70 * 1024)
                : "Changed value.txt from alpha to beta.",
          },
        },
      });
      if (mode !== "server-request" && mode !== "execution-server-request") {
        send({
          method: "turn/completed",
          params: {
            threadId: params.threadId,
            turn: {
              id: executionTurnId,
              status:
                mode === "turn-failed" ||
                (mode === "terminal-mapping" && executionTurnStartCount === 1)
                  ? "failed"
                  : mode === "turn-interrupted" ||
                      (mode === "terminal-mapping" &&
                        executionTurnStartCount === 2)
                    ? "interrupted"
                    : "completed",
              items: [],
            },
          },
        });
      }
    };
    if (
      mode === "delayed-turn" ||
      mode === "delayed-interrupt" ||
      mode === "interrupt-failure" ||
      mode === "execution-uncorrelated-after-two"
    ) {
      return;
    }
    setTimeout(complete, 5);
    return;
  }

  if (request.method === "turn/interrupt") {
    const settleInterrupt = () => {
      if (mode === "interrupt-failure") {
        send({
          id: request.id,
          error: { code: -32603, message: "private interrupt error" },
        });
        return;
      }
      send({
        method: "turn/completed",
        params: {
          threadId: request.params?.threadId,
          turn: {
            id: request.params?.turnId,
            status: "interrupted",
            items: [],
          },
        },
      });
      send({ id: request.id, result: {} });
    };
    if (mode === "delayed-interrupt") setTimeout(settleInterrupt, 100);
    else settleInterrupt();
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
