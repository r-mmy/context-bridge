import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getAgentPolicyPath, getConfigDirectory } from "../src/config/paths.js";
import {
  readAgentPolicy,
  writeAgentPolicy,
  type AgentPolicy,
} from "../src/agents/policy.js";
import { ContextBridgeError } from "../src/security/errors.js";

const roots: string[] = [];
const oldAppData = process.env.APPDATA;
const oldXdg = process.env.XDG_CONFIG_HOME;
const oldHome = process.env.HOME;

async function useTemporaryConfig(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "ctxbridge-agent-policy-"));
  roots.push(root);
  process.env.APPDATA = path.join(root, "appdata");
  process.env.XDG_CONFIG_HOME = path.join(root, "xdg");
  process.env.HOME = root;
  return root;
}

function expectPolicyError(error: unknown, code: string): void {
  expect(error).toBeInstanceOf(ContextBridgeError);
  expect((error as ContextBridgeError).code).toBe(code);
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
  if (oldAppData === undefined) delete process.env.APPDATA;
  else process.env.APPDATA = oldAppData;
  if (oldXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = oldXdg;
  if (oldHome === undefined) delete process.env.HOME;
  else process.env.HOME = oldHome;
});

describe.sequential("agent policy persistence", () => {
  it("uses Luna Max safe defaults without creating a policy file", async () => {
    await useTemporaryConfig();

    const policy = await readAgentPolicy();

    expect(policy.schema_version).toBe(1);
    expect(policy.default_profile).toBe("luna-max");
    expect(policy.profiles["luna-max"]).toEqual({
      model_id: "gpt-6-luna",
      reasoning_effort: "max",
    });
    expect(policy.projects).toEqual({});
    await expect(readFile(getAgentPolicyPath(), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("writes valid policy atomically with restrictive file permissions", async () => {
    await useTemporaryConfig();
    const initial = await readAgentPolicy();

    await writeAgentPolicy(initial);
    const updated: AgentPolicy = {
      ...initial,
      profiles: {
        ...initial.profiles,
        "sol-high": { model_id: "gpt-6-sol", reasoning_effort: "high" },
      },
    };
    await writeAgentPolicy(updated);

    expect(await readAgentPolicy()).toEqual(updated);
    if (process.platform !== "win32") {
      const details = await stat(getAgentPolicyPath());
      expect(details.mode & 0o777).toBe(0o600);
    }
  });

  it("fails closed on malformed JSON without replacing the file", async () => {
    await useTemporaryConfig();
    const policyPath = getAgentPolicyPath();
    await mkdir(path.dirname(policyPath), { recursive: true });
    await writeFile(policyPath, "{not json", "utf8");

    const error = await readAgentPolicy().catch((reason: unknown) => reason);
    expectPolicyError(error, "agent_policy_invalid");
    expect(await readFile(policyPath, "utf8")).toBe("{not json");
  });

  it("fails closed on a future schema version", async () => {
    await useTemporaryConfig();
    const policyPath = getAgentPolicyPath();
    await mkdir(path.dirname(policyPath), { recursive: true });
    await writeFile(
      policyPath,
      JSON.stringify({ schema_version: 2, default_profile: "luna-max" }),
      "utf8",
    );

    const error = await readAgentPolicy().catch((reason: unknown) => reason);
    expectPolicyError(error, "agent_policy_invalid");
  });

  it("rejects malformed profile data", async () => {
    await useTemporaryConfig();
    const policyPath = getAgentPolicyPath();
    await mkdir(path.dirname(policyPath), { recursive: true });
    await writeFile(
      policyPath,
      JSON.stringify({
        schema_version: 1,
        default_profile: "luna-max",
        profiles: { "luna-max": { model_id: "", reasoning_effort: "max" } },
        projects: {},
      }),
      "utf8",
    );

    const error = await readAgentPolicy().catch((reason: unknown) => reason);
    expectPolicyError(error, "agent_policy_invalid");
  });

  it("rejects malformed project authorization data", async () => {
    await useTemporaryConfig();
    const policyPath = getAgentPolicyPath();
    await mkdir(path.dirname(policyPath), { recursive: true });
    await writeFile(
      policyPath,
      JSON.stringify({
        schema_version: 1,
        default_profile: "luna-max",
        profiles: {
          "luna-max": { model_id: "gpt-6-luna", reasoning_effort: "max" },
        },
        projects: {
          demo: {
            registration_added_at: "not a timestamp",
            root_fingerprint: "not a fingerprint",
            enabled: true,
            allowed_profiles: ["luna-max"],
            default_profile: "missing-profile",
          },
        },
      }),
      "utf8",
    );

    const error = await readAgentPolicy().catch((reason: unknown) => reason);
    expectPolicyError(error, "agent_policy_invalid");
  });

  it("preserves the existing target and removes the temporary file on replacement failure", async () => {
    await useTemporaryConfig();
    const policy = await readAgentPolicy();
    const policyPath = getAgentPolicyPath();
    await mkdir(policyPath, { recursive: true });
    await writeFile(path.join(policyPath, "keep.txt"), "keep", "utf8");

    const error = await writeAgentPolicy(policy).catch(
      (reason: unknown) => reason,
    );
    expectPolicyError(error, "agent_policy_write_failed");

    expect(await readFile(path.join(policyPath, "keep.txt"), "utf8")).toBe(
      "keep",
    );
    const entries = await readdir(getConfigDirectory());
    expect(entries.filter((entry) => entry.endsWith(".tmp"))).toEqual([]);
  });
});
