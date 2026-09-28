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
const pendingUserInputResponses = new Map();

if (mode === "version") {
  process.stdout.write(`codex-cli ${process.argv[5] ?? "0.157.1"}\n`, () =>
    process.exit(0),
  );
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
  if (
    typeof request?.method !== "string" &&
    pendingUserInputResponses.has(request?.id)
  ) {
    record({
      kind: "user-input-response",
      id: request.id,
      ...(request.result === undefined ? {} : { result: request.result }),
      ...(request.error === undefined ? {} : { error: request.error }),
    });
    const complete = pendingUserInputResponses.get(request.id);
    pendingUserInputResponses.delete(request.id);
    if (request.result && complete) {
      if (mode === "execution-server-request-fast") complete();
      else setTimeout(complete, 5);
    }
    return;
  }
  if (typeof request?.method !== "string") return;
  record({
    method: request.method,
    at: Date.now(),
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
        userAgent: "codex_cli_rs/0.157.1",
        platformFamily: "windows",
        platformOs: "windows",
        serverInfo: { version: "0.157.1" },
      },
    });
    return;
  }

  if (request.method === "initialized") return;
  if (request.method === "thread/name/set") {
    if (mode === "thread-name-failure") {
      send({
        id: request.id,
        error: { code: -32603, message: "PRIVATE_THREAD_NAME_ERROR" },
      });
      return;
    }
    const respond = () => send({ id: request.id, result: {} });
    if (mode === "delayed-thread-name") setTimeout(respond, 100);
    else respond();
    return;
  }
  if (request.method === "thread/unsubscribe") {
    if (mode === "unsubscribe-failure") {
      send({
        id: request.id,
        error: { code: -32603, message: "PRIVATE_UNSUBSCRIBE_ERROR" },
      });
      return;
    }
    if (mode === "no-thread-closed") {
      send({ id: request.id, result: {} });
      return;
    }
    if (mode === "unrelated-thread-closed") {
      record({
        kind: "thread-closed-sent",
        threadId: "unrelated-thread",
        at: Date.now(),
      });
      send({
        method: "thread/closed",
        params: { threadId: "unrelated-thread" },
      });
      setTimeout(() => {
        record({
          kind: "thread-closed-sent",
          threadId: request.params?.threadId,
          at: Date.now(),
        });
        send({
          method: "thread/closed",
          params: { threadId: request.params?.threadId },
        });
      }, 30);
      send({ id: request.id, result: {} });
      return;
    }
    // Deliberately notify before the RPC response to exercise lost-wakeup safety.
    record({
      kind: "thread-closed-sent",
      threadId: request.params?.threadId,
      at: Date.now(),
    });
    send({
      method: "thread/closed",
      params: { threadId: request.params?.threadId },
    });
    send({ id: request.id, result: { accepted: true } });
    return;
  }
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

  if (request.method === "thread/resume") {
    const params = request.params ?? {};
    const requestedRoots = params.runtimeWorkspaceRoots;
    const result = {
      thread: { id: params.threadId },
      model: params.model,
      modelProvider: "openai",
      serviceTier: null,
      disabledPluginIds: [],
      cwd: params.cwd,
      runtimeWorkspaceRoots: requestedRoots,
      instructionSources: [],
      approvalPolicy: params.approvalPolicy,
      approvalsReviewer: null,
      sandbox: {
        type: "workspaceWrite",
        writableRoots: requestedRoots,
        networkAccess: false,
        excludeTmpdirEnvVar: true,
        excludeSlashTmp: true,
      },
      activePermissionProfile: null,
      reasoningEffort: "max",
      collaborationMode: null,
      multiAgentMode: "explicitRequestOnly",
      initialTurnsPage: null,
      turnsBackwardsCursor: null,
      itemsBackwardsCursor: null,
    };
    record({
      kind: "thread-resume-security-check",
      exactStoredThread: typeof params.threadId === "string",
      oneRuntimeRoot: requestedRoots?.length === 1,
      cwdMatchesRoot: params.cwd === requestedRoots?.[0],
      approvalNever: params.approvalPolicy === "never",
      workspaceWrite: params.sandbox === "workspace-write",
      model: params.model,
      excludesTurns: params.excludeTurns === true,
    });
    if (mode === "resume-error") {
      send({
        id: request.id,
        error: { code: -32603, message: "PRIVATE_RESUME_ERROR" },
      });
      return;
    }
    if (mode === "resume-wrong-thread") result.thread.id = "different-thread";
    if (mode === "resume-wrong-model") result.model = "gpt-6-sol";
    if (mode === "resume-wrong-cwd") result.cwd = `${params.cwd}-wrong`;
    if (mode === "resume-missing-cwd") delete result.cwd;
    if (mode === "resume-wrong-roots") {
      result.runtimeWorkspaceRoots = [`${params.cwd}-wrong`];
    }
    if (mode === "resume-missing-roots") delete result.runtimeWorkspaceRoots;
    if (mode === "resume-wrong-approval") result.approvalPolicy = "on-request";
    if (mode === "resume-wrong-sandbox") {
      result.sandbox = { type: "dangerFullAccess" };
    }
    send({ id: request.id, result });
    return;
  }

  if (request.method === "turn/start") {
    const params = request.params ?? {};
    const policy = params.sandboxPolicy ?? {};
    const root = params.runtimeWorkspaceRoots?.[0];
    executionTurnStartCount += 1;
    const currentTurnStartCount = executionTurnStartCount;
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
      collaborationMode: params.collaborationMode?.mode,
      collaborationModel: params.collaborationMode?.settings?.model,
      collaborationEffort: params.collaborationMode?.settings?.reasoning_effort,
      defaultMode: params.collaborationMode?.mode === "default",
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
    send({
      method: "turn/started",
      params: {
        threadId: params.threadId,
        turn: { id: executionTurnId, status: "inProgress", items: [] },
      },
    });
    if (!mode.startsWith("m6-")) {
      send({
        method: "item/started",
        params: {
          threadId: params.threadId,
          turnId: executionTurnId,
          startedAtMs: Date.now(),
          item: {
            id: "private-command-item",
            type: "commandExecution",
            command: "not captured",
          },
        },
      });
    }
    const telemetryStart = Date.now();
    if (mode === "m6-parser-cases") {
      const full = {
        inputTokens: 0,
        cachedInputTokens: 0,
        cacheWriteInputTokens: 0,
        outputTokens: 0,
        reasoningOutputTokens: 0,
        totalTokens: 0,
      };
      const sendUsage = (tokenUsage, overrides = {}) =>
        send({
          method: "thread/tokenUsage/updated",
          params: {
            threadId: params.threadId,
            turnId: executionTurnId,
            tokenUsage,
            ...overrides,
          },
        });
      sendUsage({ total: full, last: full, modelContextWindow: 4096 });
      const maximum = {
        inputTokens: Number.MAX_SAFE_INTEGER,
        cachedInputTokens: Number.MAX_SAFE_INTEGER,
        outputTokens: Number.MAX_SAFE_INTEGER,
        reasoningOutputTokens: Number.MAX_SAFE_INTEGER,
        totalTokens: Number.MAX_SAFE_INTEGER,
      };
      sendUsage({ total: maximum, last: maximum });
      sendUsage(
        {
          total: { ...maximum, cacheWriteInputTokens: 0 },
          last: { ...maximum, cacheWriteInputTokens: 0 },
          modelContextWindow: null,
          privateTokenUsageField: "PRIVATE_UNKNOWN_FIELD_SENTINEL",
        },
        { privatePayload: "PRIVATE_USAGE_PAYLOAD_SENTINEL" },
      );
      for (const omitted of [
        "inputTokens",
        "cachedInputTokens",
        "outputTokens",
        "reasoningOutputTokens",
        "totalTokens",
      ]) {
        const incomplete = { ...full };
        delete incomplete[omitted];
        sendUsage({ total: incomplete, last: full });
      }
      sendUsage({ total: full, last: null });
      sendUsage({ total: full });
      for (const invalid of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
        sendUsage({
          total: { ...full, inputTokens: invalid },
          last: full,
        });
      }
      for (const modelContextWindow of [
        0,
        -1,
        1.5,
        Number.MAX_SAFE_INTEGER + 1,
        "4096",
      ]) {
        sendUsage({ total: full, last: full, modelContextWindow });
      }
      sendUsage({ total: full, last: full }, { threadId: "x".repeat(513) });
      sendUsage({ total: full, last: full }, { turnId: undefined });
      sendUsage(
        { total: full, last: full },
        { threadId: "unrelated-private-thread-id" },
      );
    } else if (mode.startsWith("m6-")) {
      const initialTotal =
        currentTurnStartCount === 1
          ? {
              inputTokens: 50,
              cachedInputTokens: 10,
              cacheWriteInputTokens: 3,
              outputTokens: 20,
              reasoningOutputTokens: 8,
              totalTokens: 70,
            }
          : {
              inputTokens: 150,
              cachedInputTokens: 20,
              cacheWriteInputTokens: 5,
              outputTokens: 30,
              reasoningOutputTokens: 15,
              totalTokens: 180,
            };
      const initialLast = {
        inputTokens: 10,
        cachedInputTokens: 1,
        outputTokens: 3,
        reasoningOutputTokens: 1,
        totalTokens: 13,
      };
      if (mode === "m6-routing") {
        const unrelatedUsage = {
          last: initialLast,
          total: {
            inputTokens: 999,
            cachedInputTokens: 999,
            cacheWriteInputTokens: 999,
            outputTokens: 999,
            reasoningOutputTokens: 999,
            totalTokens: 999,
          },
        };
        send({
          method: "thread/tokenUsage/updated",
          params: {
            threadId: params.threadId,
            turnId: "stale-private-turn-id",
            tokenUsage: unrelatedUsage,
          },
        });
        send({
          method: "thread/tokenUsage/updated",
          params: {
            threadId: "unrelated-private-thread-id",
            turnId: executionTurnId,
            tokenUsage: unrelatedUsage,
          },
        });
        send({
          method: "thread/tokenUsage/updated",
          params: {
            threadId: params.threadId,
            tokenUsage: unrelatedUsage,
          },
        });
      }
      const initialUsageNotification = {
        method: "thread/tokenUsage/updated",
        params: {
          threadId: params.threadId,
          turnId: executionTurnId,
          tokenUsage: {
            last: initialLast,
            total: initialTotal,
            modelContextWindow: currentTurnStartCount === 1 ? 258400 : 262144,
            privateTokenUsageField: "PRIVATE_UNKNOWN_FIELD_SENTINEL",
          },
          privatePayload: "PRIVATE_USAGE_PAYLOAD_SENTINEL",
        },
      };
      send(initialUsageNotification);
      if (mode === "m6-repeated-last") send(initialUsageNotification);
      if (mode === "m6-malformed-usage") {
        send({
          method: "thread/tokenUsage/updated",
          params: {
            threadId: params.threadId,
            turnId: executionTurnId,
            tokenUsage: {
              last: { ...initialLast, inputTokens: -1 },
              total: initialTotal,
              modelContextWindow: currentTurnStartCount === 1 ? 258400 : 262144,
            },
            privatePayload: "PRIVATE_USAGE_PAYLOAD_SENTINEL",
          },
        });
      }
      for (const [itemId, type] of [
        ["private-command-activity-id", "commandExecution"],
        ["private-file-activity-id", "fileChange"],
        ["private-mcp-activity-id", "mcpToolCall"],
        ["private-dynamic-activity-id", "dynamicToolCall"],
        ["private-other-activity-id", "webSearch"],
      ]) {
        send({
          method: "item/started",
          params: {
            threadId: params.threadId,
            turnId: executionTurnId,
            startedAtMs: telemetryStart,
            item: {
              id: `${itemId}-${currentTurnStartCount}`,
              type,
              command: "PRIVATE_COMMAND_SENTINEL",
              cwd: "C:\\private\\project\\root",
              arguments: { prompt: "PRIVATE_TOOL_ARGUMENT_SENTINEL" },
            },
          },
        });
      }
    }
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
      currentTurnStartCount === 2
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
      if (mode.startsWith("m6-")) {
        const finalTotal =
          mode === "m6-decreasing-usage"
            ? {
                inputTokens: 40,
                cachedInputTokens: 2,
                cacheWriteInputTokens: 0,
                outputTokens: 10,
                reasoningOutputTokens: 3,
                totalTokens: 50,
              }
            : currentTurnStartCount === 1
              ? {
                  inputTokens: 100,
                  cachedInputTokens: 10,
                  cacheWriteInputTokens: 4,
                  outputTokens: 20,
                  reasoningOutputTokens: 10,
                  totalTokens: 120,
                }
              : {
                  inputTokens: 200,
                  cachedInputTokens: 25,
                  cacheWriteInputTokens: 6,
                  outputTokens: 40,
                  reasoningOutputTokens: 18,
                  totalTokens: 240,
                };
        const finalLast = {
          inputTokens: 60,
          cachedInputTokens: 8,
          cacheWriteInputTokens: 2,
          outputTokens: 10,
          reasoningOutputTokens: 6,
          totalTokens: 70,
        };
        send({
          method: "thread/tokenUsage/updated",
          params: {
            threadId: params.threadId,
            turnId: executionTurnId,
            tokenUsage: {
              last: finalLast,
              total: finalTotal,
            },
          },
        });
        for (const [itemId, type, status] of [
          ["private-command-activity-id", "commandExecution", "completed"],
          ["private-file-activity-id", "fileChange", "completed"],
          ["private-mcp-activity-id", "mcpToolCall", "failed"],
          ["private-dynamic-activity-id", "dynamicToolCall", "completed"],
          ["private-other-activity-id", "webSearch", "completed"],
        ]) {
          send({
            method: "item/completed",
            params: {
              threadId: params.threadId,
              turnId: executionTurnId,
              completedAtMs: telemetryStart + 25,
              item: {
                id: `${itemId}-${currentTurnStartCount}`,
                type,
                status,
                command: "PRIVATE_COMMAND_SENTINEL",
                cwd: "C:\\private\\project\\root",
                arguments: { prompt: "PRIVATE_TOOL_ARGUMENT_SENTINEL" },
                output: "PRIVATE_TOOL_OUTPUT_SENTINEL",
              },
            },
          });
        }
      }
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
      record({
        kind: "turn-terminal-sent",
        threadId: params.threadId,
        turnId: executionTurnId,
        at: Date.now(),
      });
      send({
        method: "turn/completed",
        params: {
          threadId: params.threadId,
          turn: {
            id: executionTurnId,
            status:
              mode === "turn-failed" ||
              (mode === "terminal-mapping" && currentTurnStartCount === 1)
                ? "failed"
                : mode === "turn-interrupted" ||
                    (mode === "terminal-mapping" && currentTurnStartCount === 2)
                  ? "interrupted"
                  : "completed",
            items: [],
          },
        },
      });
      if (mode === "m6-post-terminal-usage") {
        setTimeout(() => {
          record({ kind: "m6-post-terminal-notification-sent" });
          send({
            method: "thread/tokenUsage/updated",
            params: {
              threadId: params.threadId,
              turnId: executionTurnId,
              tokenUsage: {
                last: {
                  inputTokens: 999,
                  cachedInputTokens: 999,
                  cacheWriteInputTokens: 999,
                  outputTokens: 999,
                  reasoningOutputTokens: 999,
                  totalTokens: 999,
                },
                total: {
                  inputTokens: 999,
                  cachedInputTokens: 999,
                  cacheWriteInputTokens: 999,
                  outputTokens: 999,
                  reasoningOutputTokens: 999,
                  totalTokens: 999,
                },
              },
            },
          });
        }, 25);
      }
    };
    const sendsInput = [
      "m6-input-telemetry",
      "execution-server-request",
      "execution-server-request-fast",
      "execution-server-request-single",
      "execution-secret-request",
      "execution-nonblocking-request",
      "execution-second-request",
      "execution-duplicate-question",
      "execution-malformed-secret",
      "execution-too-many-questions",
    ].includes(mode);
    const sendUserInput = (id, questions, isBlocking = true) => {
      pendingUserInputResponses.set(id, complete);
      send({
        id,
        method: "item/tool/requestUserInput",
        params: {
          threadId: params.threadId,
          turnId: executionTurnId,
          itemId: "private-user-input-item",
          isBlocking,
          autoResolutionMs: null,
          questions,
        },
      });
    };
    if (sendsInput) {
      const validQuestions = [
        {
          id: "choice",
          header: "Choice",
          question: "Choose a next step.",
          isOther: false,
          options: [
            { label: "Proceed", description: "Continue the same turn." },
            { label: "Wait", description: "Keep waiting." },
          ],
        },
        {
          id: "note",
          header: "Note",
          question: "Add a short note.",
          options: null,
        },
        {
          id: "choice-with-note",
          header: "Choice with note",
          question: "Choose an option and optionally add context.",
          isOther: true,
          options: [
            { label: "Proceed", description: "Continue the same turn." },
            { label: "Wait", description: "Keep waiting." },
          ],
        },
        {
          id: "__proto__",
          header: "Opaque identifier",
          question: "Preserve this question identifier exactly.",
          options: null,
        },
      ];
      const questions =
        mode === "execution-server-request-single"
          ? [validQuestions[0]]
          : mode === "execution-secret-request"
            ? [
                {
                  id: "secret-question",
                  header: "Private secret header",
                  question: "PRIVATE secret question",
                  isSecret: true,
                  options: [
                    {
                      label: "PRIVATE secret option",
                      description: "PRIVATE secret description",
                    },
                  ],
                },
              ]
            : mode === "execution-malformed-secret"
              ? [
                  {
                    id: "secret-question",
                    header: "Private secret header",
                    question: "PRIVATE malformed secret question",
                    isSecret: true,
                    options: [{ label: "PRIVATE secret option" }],
                  },
                ]
              : mode === "execution-duplicate-question"
                ? [validQuestions[0], { ...validQuestions[1], id: "choice" }]
                : mode === "execution-too-many-questions"
                  ? Array.from({ length: 11 }, (_, index) => ({
                      id: `question-${index}`,
                      header: "Question",
                      question: "Question?",
                      options: [],
                    }))
                  : validQuestions;
      sendUserInput(
        "ephemeral-private-server-request-id",
        questions,
        mode !== "execution-nonblocking-request",
      );
      if (mode === "execution-second-request") {
        sendUserInput("ephemeral-private-server-request-id-2", [
          { id: "second", header: "Second", question: "Second request?" },
        ]);
      }
    } else if (mode === "execution-unsupported-request") {
      send({
        id: "ephemeral-private-server-request-id",
        method: "item/tool/call",
        params: { threadId: params.threadId, turnId: executionTurnId },
      });
    }
    if (
      mode === "delayed-turn" ||
      mode === "delayed-interrupt" ||
      mode === "interrupt-failure" ||
      mode === "execution-uncorrelated-after-two" ||
      mode === "m6-input-telemetry" ||
      mode === "execution-server-request" ||
      mode === "execution-server-request-fast" ||
      mode === "execution-server-request-single" ||
      mode === "execution-secret-request" ||
      mode === "execution-nonblocking-request" ||
      mode === "execution-second-request" ||
      mode === "execution-duplicate-question" ||
      mode === "execution-malformed-secret" ||
      mode === "execution-too-many-questions"
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
