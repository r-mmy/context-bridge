import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  AgentAdapter,
  AgentBackendInfo,
  AgentModel,
} from "../../src/agents/adapter.js";
import { AgentAdapterError } from "../../src/agents/errors.js";
import {
  addAgentProfile,
  enableProjectAuthorization,
  setProjectAllowedProfiles,
} from "../../src/agents/policy.js";
import { runCli, type CliIO } from "../../src/cli/commands.js";
import { getProject } from "../../src/projects/registry.js";
import { git } from "../helpers.js";

const roots: string[] = [];
const previousEnvironment = {
  appData: process.env.APPDATA,
  xdg: process.env.XDG_CONFIG_HOME,
  home: process.env.HOME,
};

interface TestIO extends CliIO {
  output: string[];
  errors: string[];
}

function testIO(cwd: string): TestIO {
  const output: string[] = [];
  const errors: string[] = [];
  return {
    cwd,
    stdout: (text) => output.push(text),
    stderr: (text) => errors.push(text),
    output,
    errors,
  };
}

async function setup(): Promise<{ root: string; projectRoot: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "ctxbridge-doctor-"));
  roots.push(root);
  process.env.APPDATA = path.join(root, "appdata");
  process.env.XDG_CONFIG_HOME = path.join(root, "xdg");
  process.env.HOME = root;
  const projectRoot = path.join(root, "enabled-project");
  await mkdir(projectRoot, { recursive: true });
  git(projectRoot, ["init", "--quiet"]);
  return { root, projectRoot };
}

function fakeAdapter(
  options: {
    authenticated?: boolean;
    models?: AgentModel[];
    startError?: AgentAdapterError;
    modelError?: AgentAdapterError;
  } = {},
): AgentAdapter & { started: boolean; closed: boolean } {
  const state = { started: false, closed: false };
  return {
    get started() {
      return state.started;
    },
    get closed() {
      return state.closed;
    },
    async start(): Promise<AgentBackendInfo> {
      state.started = true;
      if (options.startError) throw options.startError;
      return {
        provider: "codex",
        connected: true,
        experimentalApi: true,
        version: "0.155.0-alpha.16.3",
      };
    },
    async checkAuthentication() {
      return options.authenticated ?? true;
    },
    async requireAuthentication() {
      if (!(options.authenticated ?? true)) {
        throw new AgentAdapterError("codex_unauthenticated");
      }
    },
    async listModels() {
      if (options.modelError) throw options.modelError;
      return (
        options.models ?? [
          { id: "gpt-6-luna", reasoningEfforts: ["low", "max"] },
        ]
      );
    },
    async validateProfile() {},
    async close() {
      state.closed = true;
    },
  };
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
  if (previousEnvironment.appData === undefined) delete process.env.APPDATA;
  else process.env.APPDATA = previousEnvironment.appData;
  if (previousEnvironment.xdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = previousEnvironment.xdg;
  if (previousEnvironment.home === undefined) delete process.env.HOME;
  else process.env.HOME = previousEnvironment.home;
});

describe.sequential("doctor App Server diagnostics", () => {
  it("does not construct or require Codex while execution is disabled", async () => {
    const { root } = await setup();
    let constructed = false;
    const io = testIO(root);
    expect(
      await runCli(["doctor"], io, {
        createAgentAdapter: () => {
          constructed = true;
          throw new Error("must not be called");
        },
      }),
    ).toBe(0);
    expect(constructed).toBe(false);
    expect(io.output.join("")).toContain(
      "Codex App Server: not checked (agent execution not enabled)",
    );
  });

  it("validates the default and enabled project profiles without printing account or model-list data", async () => {
    const { root, projectRoot } = await setup();
    const add = testIO(root);
    expect(await runCli(["project", "add", projectRoot], add)).toBe(0);
    const project = await getProject("enabled-project");
    await enableProjectAuthorization(project);
    await addAgentProfile("unsupported-profile", {
      model_id: "unavailable-private-model",
      reasoning_effort: "max",
    });
    await setProjectAllowedProfiles(
      project,
      ["luna-max", "unsupported-profile"],
      "luna-max",
    );

    const adapter = fakeAdapter();
    const io = testIO(root);
    expect(
      await runCli(["doctor"], io, { createAgentAdapter: () => adapter }),
    ).toBe(0);
    const output = io.output.join("");
    expect(output).toContain("Codex executable: found");
    expect(output).toContain("App Server handshake: compatible");
    expect(output).toContain("Codex version: 0.155.0-alpha.16.3");
    expect(output).toContain("Local Codex authentication: available");
    expect(output).toContain("Agent default profile luna-max: valid");
    expect(output).toContain("Enabled project profiles: 1 valid; 1 invalid");
    expect(output).not.toContain("unavailable-private-model");
    expect(output).not.toContain("private-account-identity");
    expect(adapter.started).toBe(true);
    expect(adapter.closed).toBe(true);
  });

  it("reports a missing executable as a local diagnostic and closes the adapter", async () => {
    const { root, projectRoot } = await setup();
    expect(await runCli(["project", "add", projectRoot], testIO(root))).toBe(0);
    await enableProjectAuthorization(await getProject("enabled-project"));
    const adapter = fakeAdapter({
      startError: new AgentAdapterError("codex_not_found"),
    });
    const io = testIO(root);
    expect(
      await runCli(["doctor"], io, { createAgentAdapter: () => adapter }),
    ).toBe(0);
    const output = io.output.join("");
    expect(output).toContain("Codex executable: missing");
    expect(output).toContain("App Server handshake: not available");
    expect(output).toContain("Agent default profile: unavailable");
    expect(output).not.toContain("private path");
    expect(adapter.closed).toBe(true);
  });

  it("reports model discovery failure without exposing provider errors", async () => {
    const { root, projectRoot } = await setup();
    expect(await runCli(["project", "add", projectRoot], testIO(root))).toBe(0);
    await enableProjectAuthorization(await getProject("enabled-project"));
    const adapter = fakeAdapter({
      modelError: new AgentAdapterError("app_server_protocol_error"),
    });
    const io = testIO(root);
    expect(
      await runCli(["doctor"], io, { createAgentAdapter: () => adapter }),
    ).toBe(0);
    expect(io.output.join("")).toContain("Codex model discovery: unavailable");
    expect(io.output.join("")).toContain(
      "Enabled project profiles: unavailable",
    );
    expect(io.errors).toEqual([]);
    expect(adapter.closed).toBe(true);
  });
});
