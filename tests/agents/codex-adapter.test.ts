import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  ChildProcessWithoutNullStreams,
  SpawnOptions,
} from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentProfile } from "../../src/agents/profiles.js";
import { AgentAdapterError } from "../../src/agents/errors.js";
import { CodexAgentAdapter } from "../../src/agents/codex/adapter.js";
import { buildCodexChildEnvironment } from "../../src/agents/codex/app-server.js";

const fixturePath = fileURLToPath(
  new URL("../fixtures/fake-app-server.mjs", import.meta.url),
);
const temporaryDirectories: string[] = [];

interface TraceEntry {
  method?: string;
  params?: Record<string, unknown>;
  kind?: string;
  hasOpenAiKey?: boolean;
  hasCodexKey?: boolean;
  hasTunnelSecret?: boolean;
  hasContextBridgeSecret?: boolean;
}

interface SpawnRecord {
  executable: string;
  args: string[];
  shell: SpawnOptions["shell"];
  stdio: SpawnOptions["stdio"];
  env: NodeJS.ProcessEnv;
}

async function readTrace(tracePath: string): Promise<TraceEntry[]> {
  const content = await readFile(tracePath, "utf8").catch(() => "");
  return content
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as TraceEntry);
}

async function createHarness(
  mode: string | ((launchIndex: number) => string) = "normal",
  overrides: {
    requestTimeoutMs?: number;
    shutdownTimeoutMs?: number;
    throwOnSpawn?: NodeJS.ErrnoException;
  } = {},
) {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "ctxbridge-app-server-"),
  );
  temporaryDirectories.push(directory);
  const tracePath = path.join(directory, "trace.jsonl");
  const launches: SpawnRecord[] = [];
  const children: ChildProcessWithoutNullStreams[] = [];
  const sourceEnvironment: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? "",
    CODEX_HOME: undefined,
    SYSTEMROOT: process.env.SYSTEMROOT ?? "C:\\Windows",
    TEMP: process.env.TEMP ?? os.tmpdir(),
    TMP: process.env.TMP ?? os.tmpdir(),
    HOME: process.env.HOME ?? directory,
    TMPDIR: process.env.TMPDIR ?? os.tmpdir(),
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    OPENAI_API_KEY: "fake-openai-secret-for-test",
    CODEX_API_KEY: "fake-codex-secret-for-test",
    SECURE_MCP_TUNNEL_TOKEN: "fake-tunnel-secret-for-test",
    CONTEXTBRIDGE_SECRET: "fake-context-bridge-secret-for-test",
  };
  let launchIndex = 0;
  const adapter = new CodexAgentAdapter({
    environment: sourceEnvironment,
    platform: process.platform,
    homeDirectory: path.join(directory, "home"),
    ...(overrides.requestTimeoutMs === undefined
      ? {}
      : { requestTimeoutMs: overrides.requestTimeoutMs }),
    ...(overrides.shutdownTimeoutMs === undefined
      ? {}
      : { shutdownTimeoutMs: overrides.shutdownTimeoutMs }),
    spawnProcess: (executable, args, options) => {
      if (overrides.throwOnSpawn) throw overrides.throwOnSpawn;
      launches.push({
        executable,
        args: [...args],
        shell: options.shell,
        stdio: options.stdio,
        env: { ...(options.env ?? {}) },
      });
      const selectedMode =
        args[0] === "--version"
          ? "version"
          : typeof mode === "string"
            ? mode
            : mode(launchIndex);
      launchIndex += 1;
      const child = spawn(
        process.execPath,
        [fixturePath, selectedMode, tracePath],
        {
          shell: false,
          stdio: ["pipe", "pipe", "pipe"],
          env: options.env,
          windowsHide: process.platform === "win32",
        },
      ) as ChildProcessWithoutNullStreams;
      children.push(child);
      return child;
    },
  });
  return {
    adapter,
    directory,
    tracePath,
    launches,
    children,
    sourceEnvironment,
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("Codex App Server adapter", () => {
  it("uses a fixed direct spawn, one experimental handshake, and clean stdin shutdown", async () => {
    const harness = await createHarness();
    const [first, second] = await Promise.all([
      harness.adapter.start(),
      harness.adapter.start(),
    ]);
    expect(first).toEqual({
      provider: "codex",
      connected: true,
      experimentalApi: true,
      version: "0.155.0-alpha.16.3",
    });
    expect(second).toEqual(first);
    expect(harness.launches).toHaveLength(1);
    expect(harness.launches[0]).toMatchObject({
      executable: "codex",
      args: ["app-server", "--listen", "stdio://"],
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });

    await harness.adapter.close();
    const trace = await readTrace(harness.tracePath);
    const requests = trace.filter((entry) => entry.method);
    expect(requests.map((entry) => entry.method)).toEqual([
      "initialize",
      "initialized",
    ]);
    expect(requests[0]?.params).toMatchObject({
      clientInfo: { name: "context_bridge" },
      capabilities: { experimentalApi: true },
    });
    expect(harness.children[0]?.exitCode).toBe(0);
  });

  it("uses only a fixed version query when the App Server does not report its version", async () => {
    const harness = await createHarness("no-server-version");
    const info = await harness.adapter.start();
    expect(info.version).toBe("0.155.0-alpha.16.3");
    expect(harness.launches.map((launch) => launch.args)).toEqual([
      ["app-server", "--listen", "stdio://"],
      ["--version"],
    ]);
    expect(harness.launches.every((launch) => launch.shell === false)).toBe(
      true,
    );
    await harness.adapter.close();
  });

  it("passes only the platform allowlist and derives CODEX_HOME without inheriting secrets", async () => {
    const harness = await createHarness();
    await harness.adapter.start();
    const childEnvironment = harness.launches[0]?.env ?? {};
    const expectedKeys =
      process.platform === "win32"
        ? [
            "APPDATA",
            "CODEX_HOME",
            "HOME",
            "LOCALAPPDATA",
            "PATH",
            "SYSTEMROOT",
            "TEMP",
            "TMP",
            "USERPROFILE",
          ]
        : ["CODEX_HOME", "PATH", "HOME", "TMPDIR", "LANG", "LC_ALL"];
    expect(Object.keys(childEnvironment).sort()).toEqual(expectedKeys.sort());
    expect(childEnvironment.CODEX_HOME).toBe(
      path.join(harness.directory, "home", ".codex"),
    );
    expect(childEnvironment.OPENAI_API_KEY).toBeUndefined();
    expect(childEnvironment.CODEX_API_KEY).toBeUndefined();
    expect(childEnvironment.SECURE_MCP_TUNNEL_TOKEN).toBeUndefined();
    expect(childEnvironment.CONTEXTBRIDGE_SECRET).toBeUndefined();

    await harness.adapter.close();
    const environmentTrace = (await readTrace(harness.tracePath)).find(
      (entry) => entry.kind === "environment-check",
    );
    expect(environmentTrace).toMatchObject({
      hasOpenAiKey: false,
      hasCodexKey: false,
      hasTunnelSecret: false,
      hasContextBridgeSecret: false,
    });
  });

  it("keeps platform environment construction narrow on Windows and POSIX", () => {
    const source: NodeJS.ProcessEnv = {
      PATH: "safe-path",
      CODEX_HOME: undefined,
      SYSTEMROOT: "C:\\Windows",
      TEMP: "C:\\Temp",
      TMP: "C:\\Temp",
      HOME: "/home/tester",
      TMPDIR: "/tmp",
      LANG: "C.UTF-8",
      LC_ALL: "C.UTF-8",
      APPDATA: "ignored-appdata",
      OPENAI_API_KEY: "secret",
    };
    expect(
      Object.keys(
        buildCodexChildEnvironment("win32", source, "C:\\Users\\tester"),
      ).sort(),
    ).toEqual([
      "APPDATA",
      "CODEX_HOME",
      "HOME",
      "LOCALAPPDATA",
      "PATH",
      "SYSTEMROOT",
      "TEMP",
      "TMP",
      "USERPROFILE",
    ]);
    expect(
      Object.keys(
        buildCodexChildEnvironment("linux", source, "/home/tester"),
      ).sort(),
    ).toEqual(["CODEX_HOME", "HOME", "LANG", "LC_ALL", "PATH", "TMPDIR"]);
    expect(
      buildCodexChildEnvironment("darwin", source, "/Users/tester").CODEX_HOME,
    ).toBe(path.join("/Users/tester", ".codex"));
  });

  it("normalizes account and model/list without exposing account or catalog details", async () => {
    const harness = await createHarness("out-of-order");
    await harness.adapter.start();
    const [authenticated, models] = await Promise.all([
      harness.adapter.checkAuthentication(),
      harness.adapter.listModels(),
    ]);
    expect(authenticated).toBe(true);
    expect(models).toEqual([
      { id: "gpt-6-luna", reasoningEfforts: ["low", "max"] },
      { id: "gpt-6-sol", reasoningEfforts: ["high"] },
    ]);
    expect(JSON.stringify(models)).not.toContain("private-account-identity");
    expect(JSON.stringify(models)).not.toContain("Private Model Display Name");
    await harness.adapter.close();
  });

  it("reports absent local authentication without returning account details", async () => {
    const harness = await createHarness("auth-absent");
    await harness.adapter.start();
    await expect(harness.adapter.checkAuthentication()).resolves.toBe(false);
    await expect(harness.adapter.requireAuthentication()).rejects.toMatchObject(
      {
        code: "codex_unauthenticated",
        message: expect.not.stringContaining("private-account-identity"),
      },
    );
    await harness.adapter.close();
  });

  it("paginates a bounded model list and validates Luna Max without fallback", async () => {
    const harness = await createHarness("paginated-models");
    await harness.adapter.start();
    const profile: AgentProfile = {
      model_id: "gpt-6-luna",
      reasoning_effort: "max",
    };
    await expect(
      harness.adapter.validateProfile(profile),
    ).resolves.toBeUndefined();
    await expect(
      harness.adapter.validateProfile({
        model_id: "missing-model",
        reasoning_effort: "max",
      }),
    ).rejects.toMatchObject({ code: "model_unavailable" });
    await expect(
      harness.adapter.validateProfile({
        model_id: "gpt-6-luna",
        reasoning_effort: "ultra",
      }),
    ).rejects.toMatchObject({ code: "effort_unsupported" });
    await expect(
      harness.adapter.validateProfile({
        model_id: "gpt-6-sol",
        reasoning_effort: "max",
      }),
    ).rejects.toMatchObject({ code: "effort_unsupported" });
    const trace = await readTrace(harness.tracePath);
    expect(
      trace
        .filter((entry) => entry.method === "model/list")
        .map((entry) => entry.params?.cursor),
    ).toEqual([
      undefined,
      "page-2",
      undefined,
      "page-2",
      undefined,
      "page-2",
      undefined,
      "page-2",
    ]);
    await harness.adapter.close();
  });

  it.each([
    ["malformed-json", "app_server_protocol_error"],
    ["malformed-rpc", "app_server_incompatible"],
    ["malformed-initialize-shape", "app_server_incompatible"],
    ["server-request", "app_server_protocol_error"],
    ["oversized-line", "app_server_protocol_error"],
  ] as const)(
    "fails closed for %s without leaking payloads",
    async (mode, code) => {
      const harness = await createHarness(mode);
      await expect(harness.adapter.start()).rejects.toMatchObject({ code });
      await harness.adapter.close();
    },
  );

  it("maps missing executables to a sanitized error", async () => {
    const harness = await createHarness("normal", {
      throwOnSpawn: Object.assign(new Error("private path"), {
        code: "ENOENT",
      }),
    });
    await expect(harness.adapter.start()).rejects.toMatchObject({
      code: "codex_not_found",
      message: expect.not.stringContaining("private path"),
    });
    await harness.adapter.close();
  });

  it("times out and handles App Server death while a request is pending", async () => {
    const timed = await createHarness("timeout-account", {
      requestTimeoutMs: 30,
      shutdownTimeoutMs: 20,
    });
    await timed.adapter.start();
    await expect(timed.adapter.checkAuthentication()).rejects.toMatchObject({
      code: "app_server_timeout",
    });
    await timed.adapter.close();

    const dead = await createHarness("exit-account", {
      requestTimeoutMs: 500,
      shutdownTimeoutMs: 20,
    });
    await dead.adapter.start();
    await expect(dead.adapter.checkAuthentication()).rejects.toMatchObject({
      code: "app_server_exited",
    });
    await dead.adapter.close();
  });

  it("starts a fresh App Server after the previous child dies", async () => {
    const harness = await createHarness((index) =>
      index === 0 ? "exit-account" : "normal",
    );
    await harness.adapter.start();
    await expect(harness.adapter.checkAuthentication()).rejects.toMatchObject({
      code: "app_server_exited",
    });
    await expect(harness.adapter.checkAuthentication()).resolves.toBe(true);
    expect(harness.launches).toHaveLength(2);
    await harness.adapter.close();
  });

  it("bounds forced shutdown and never exposes raw stderr or protocol errors", async () => {
    const hanging = await createHarness("hang-on-close", {
      shutdownTimeoutMs: 20,
    });
    await hanging.adapter.start();
    const started = Date.now();
    await hanging.adapter.close();
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(
      hanging.children[0]?.exitCode !== null ||
        hanging.children[0]?.signalCode !== null,
    ).toBe(true);

    const rawError = await createHarness("rpc-error");
    await rawError.adapter.start();
    const caught = await rawError.adapter
      .checkAuthentication()
      .catch((error: unknown) => error);
    expect(caught).toBeInstanceOf(AgentAdapterError);
    expect(caught).toMatchObject({ code: "app_server_protocol_error" });
    expect(String(caught)).not.toContain("PRIVATE_STDERR_SENTINEL");
    expect(String(caught)).not.toContain("PRIVATE_PROTOCOL_SENTINEL");
    expect(String(caught)).not.toContain("C:\\local\\secret\\path");
    await rawError.adapter.close();
  });
});
