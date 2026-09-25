import { access, mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getAgentPolicyPath } from "../src/config/paths.js";
import { readAgentPolicy } from "../src/agents/policy.js";
import { runCli, type CliIO } from "../src/cli/commands.js";
import { readRegistry, writeRegistry } from "../src/projects/registry.js";
import { git } from "./helpers.js";

const roots: string[] = [];
const oldAppData = process.env.APPDATA;
const oldXdg = process.env.XDG_CONFIG_HOME;
const oldHome = process.env.HOME;

interface TestIO extends CliIO {
  output: string[];
  errors: string[];
}

function testIO(cwd: string, confirm?: CliIO["confirm"]): TestIO {
  const output: string[] = [];
  const errors: string[] = [];
  return {
    cwd,
    stdout: (text) => output.push(text),
    stderr: (text) => errors.push(text),
    ...(confirm ? { confirm } : {}),
    output,
    errors,
  };
}

async function setupConfig(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "ctxbridge-agent-cli-"));
  roots.push(root);
  process.env.APPDATA = path.join(root, "appdata");
  process.env.XDG_CONFIG_HOME = path.join(root, "xdg");
  process.env.HOME = root;
  return root;
}

async function registerProject(
  root: string,
  name: string,
  withGit = true,
): Promise<{ id: string; projectRoot: string }> {
  const projectRoot = path.join(root, name);
  await mkdir(projectRoot, { recursive: true });
  if (withGit) git(projectRoot, ["init", "--quiet"]);
  const io = testIO(root);
  expect(await runCli(["project", "add", projectRoot], io)).toBe(0);
  return { id: name, projectRoot };
}

async function enableProject(id: string, cwd: string): Promise<TestIO> {
  const io = testIO(cwd, async () => true);
  expect(await runCli(["agent", "enable", id], io)).toBe(0);
  return io;
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

describe.sequential("agent M1 CLI", () => {
  it("shows Luna Max defaults and keeps new projects unauthorized", async () => {
    const root = await setupConfig();
    const { id } = await registerProject(root, "default-project");
    const help = testIO(root);
    const list = testIO(root);
    const status = testIO(root);

    expect(await runCli(["--help"], help)).toBe(0);
    expect(help.output.join("")).toContain(
      "ctxbridge agent enable|disable|status",
    );
    expect(await runCli(["agent", "profile", "list"], list)).toBe(0);
    expect(list.output.join("")).toContain(
      "luna-max\tgpt-6-luna\tmax (default)",
    );
    expect(list.output.join("")).toContain(
      "Model/effort support is not checked",
    );
    expect(await runCli(["agent", "status", id], status)).toBe(0);
    expect(status.output.join("")).toContain("Authorization: disabled");
    expect(status.output.join("")).toContain("Allowed profiles: none");
    expect((await readAgentPolicy()).projects).toEqual({});
  });

  it("requires a Git repository and a local interactive confirmation", async () => {
    const root = await setupConfig();
    const nonGit = await registerProject(root, "plain-project", false);
    const gitProject = await registerProject(root, "git-project");
    const nonGitIO = testIO(root, async () => true);
    const noTTY = testIO(root);
    const declined = testIO(root, async () => false);

    expect(await runCli(["agent", "enable", nonGit.id], nonGitIO)).toBe(1);
    expect(nonGitIO.errors.join("")).toContain("registered Git repository");
    expect(await runCli(["agent", "enable", gitProject.id], noTTY)).toBe(1);
    expect(noTTY.output.join("")).toContain("stronger than read-only");
    expect(noTTY.errors.join("")).toContain("interactive terminal");
    expect(await runCli(["agent", "enable", gitProject.id], declined)).toBe(1);
    expect(declined.errors.join("")).toContain("declined or unavailable");
    expect((await readAgentPolicy()).projects).toEqual({});
    await expect(access(getAgentPolicyPath())).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("binds confirmed enablement to registration and root without printing either", async () => {
    const root = await setupConfig();
    const { id, projectRoot } = await registerProject(root, "bound-project");
    const io = await enableProject(id, root);
    const policy = await readAgentPolicy();
    const authorization = policy.projects[id];

    expect(authorization?.enabled).toBe(true);
    expect(authorization?.allowed_profiles).toEqual(["luna-max"]);
    expect(authorization?.default_profile).toBe("luna-max");
    expect(authorization?.registration_added_at).toBe(
      (await readRegistry()).projects[0]?.addedAt,
    );
    expect(authorization?.root_fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(authorization)).not.toContain(projectRoot);
    expect(io.output.join("")).toContain(
      "Codex/OS sandbox as an additional boundary",
    );
    expect(io.output.join("")).not.toContain(projectRoot);
    expect(io.output.join("")).not.toContain(
      authorization?.root_fingerprint ?? "",
    );

    const status = testIO(root);
    expect(await runCli(["agent", "status", id], status)).toBe(0);
    expect(status.output.join("")).toContain("Authorization: enabled");
    expect(status.output.join("")).toContain("Registration identity: matching");
    expect(status.output.join("")).not.toContain(projectRoot);
    expect(status.output.join("")).not.toContain(
      authorization?.root_fingerprint ?? "",
    );
  });

  it("rejects unattended flags and leaves policy unchanged when confirmation throws", async () => {
    const root = await setupConfig();
    const { id } = await registerProject(root, "strict-project");
    const io = testIO(root, async () => {
      throw new Error("input closed");
    });

    expect(await runCli(["agent", "enable", id, "--yes"], io)).toBe(1);
    expect(io.errors.join("")).toContain("exactly one project ID");
    expect(await runCli(["agent", "enable", id], io)).toBe(1);
    expect(io.errors.join("")).toContain("declined or unavailable");
    expect((await readAgentPolicy()).projects).toEqual({});
  });

  it("supports profiles, project allowlists, references, and default validation", async () => {
    const root = await setupConfig();
    const { id } = await registerProject(root, "profile-project");
    await enableProject(id, root);

    const add = testIO(root);
    expect(
      await runCli(
        [
          "agent",
          "profile",
          "add",
          "sol-high",
          "--model",
          "gpt-6-sol",
          "--effort",
          "high",
        ],
        add,
      ),
    ).toBe(0);
    expect(await runCli(["agent", "profile", "default", "sol-high"], add)).toBe(
      0,
    );
    expect(
      await runCli(
        [
          "agent",
          "policy",
          "set",
          id,
          "--allow-profile",
          "luna-max",
          "sol-high",
          "--default-profile",
          "sol-high",
        ],
        add,
      ),
    ).toBe(0);

    const show = testIO(root);
    expect(await runCli(["agent", "policy", "show", id], show)).toBe(0);
    expect(show.output.join("")).toContain("Project default profile: sol-high");
    expect(show.output.join("")).toContain(
      "Allowed profiles: luna-max, sol-high",
    );

    const before = await readAgentPolicy();
    const invalidDefault = testIO(root);
    expect(
      await runCli(
        [
          "agent",
          "policy",
          "set",
          id,
          "--allow-profile",
          "luna-max",
          "--default-profile",
          "sol-high",
        ],
        invalidDefault,
      ),
    ).toBe(1);
    expect(invalidDefault.errors.join("")).toContain(
      "must be included in --allow-profile",
    );
    expect(await readAgentPolicy()).toEqual(before);

    expect(await runCli(["agent", "profile", "default", "luna-max"], add)).toBe(
      0,
    );
    const removeReferenced = testIO(root);
    expect(
      await runCli(
        ["agent", "profile", "remove", "sol-high"],
        removeReferenced,
      ),
    ).toBe(1);
    expect(removeReferenced.errors.join("")).toContain(
      "referenced by a project policy",
    );

    expect(
      await runCli(
        [
          "agent",
          "policy",
          "set",
          id,
          "--allow-profile",
          "luna-max",
          "--default-profile",
          "luna-max",
        ],
        add,
      ),
    ).toBe(0);
    expect(await runCli(["agent", "profile", "remove", "sol-high"], add)).toBe(
      0,
    );
    expect(await runCli(["agent", "profile", "remove", "luna-max"], add)).toBe(
      1,
    );
  });

  it("disables matching authorization and reports stale project identity", async () => {
    const root = await setupConfig();
    const { id } = await registerProject(root, "disable-project");
    await enableProject(id, root);

    const disable = testIO(root);
    expect(await runCli(["agent", "disable", id], disable)).toBe(0);
    expect(disable.output.join("")).toContain("disabled");
    const status = testIO(root);
    expect(await runCli(["agent", "status", id], status)).toBe(0);
    expect(status.output.join("")).toContain("Authorization: disabled");
    expect(status.output.join("")).toContain("Registration identity: matching");

    const registry = await readRegistry();
    const record = registry.projects.find((entry) => entry.id === id);
    expect(record).toBeDefined();
    if (!record) throw new Error("test project registration missing");
    record.addedAt = new Date(Date.now() + 60_000).toISOString();
    await writeRegistry(registry);

    const stale = testIO(root);
    expect(await runCli(["agent", "status", id], stale)).toBe(0);
    expect(stale.output.join("")).toContain("Authorization: disabled");
    expect(stale.output.join("")).toContain("Registration identity: stale");
  });

  it("invalidates authorization when the registered canonical root changes", async () => {
    const root = await setupConfig();
    const { id, projectRoot } = await registerProject(
      root,
      "root-bound-project",
    );
    await enableProject(id, root);
    const stored = (await readAgentPolicy()).projects[id];
    expect(stored).toBeDefined();

    const replacementRoot = path.join(root, "replacement-root");
    await mkdir(replacementRoot, { recursive: true });
    git(replacementRoot, ["init", "--quiet"]);
    const registry = await readRegistry();
    const project = registry.projects.find((entry) => entry.id === id);
    expect(project).toBeDefined();
    if (!project) throw new Error("test project registration missing");
    project.root = replacementRoot;
    await writeRegistry(registry);

    const status = testIO(root);
    expect(await runCli(["agent", "status", id], status)).toBe(0);
    expect(status.output.join("")).toContain("Authorization: disabled");
    expect(status.output.join("")).toContain("Registration identity: stale");
    expect(status.output.join("")).not.toContain(projectRoot);
    expect(status.output.join("")).not.toContain(replacementRoot);
    expect(status.output.join("")).not.toContain(
      stored?.root_fingerprint ?? "",
    );

    const policyUpdate = testIO(root);
    expect(
      await runCli(
        ["agent", "policy", "set", id, "--allow-profile", "luna-max"],
        policyUpdate,
      ),
    ).toBe(1);
    expect(policyUpdate.errors.join("")).toContain(
      "current project registration",
    );
  });

  it("does not restore authorization after project removal and re-registration", async () => {
    const root = await setupConfig();
    const { id, projectRoot } = await registerProject(root, "reused-project");
    await enableProject(id, root);
    const firstRegistration = (await readRegistry()).projects[0]?.addedAt;
    expect(firstRegistration).toBeDefined();

    expect(await runCli(["project", "remove", id], testIO(root))).toBe(0);
    const removedStatus = testIO(root);
    expect(await runCli(["agent", "status", id], removedStatus)).toBe(0);
    expect(removedStatus.output.join("")).toContain("not registered");

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(await runCli(["project", "add", projectRoot], testIO(root))).toBe(0);
    const secondRegistration = (await readRegistry()).projects[0]?.addedAt;
    expect(secondRegistration).toBeDefined();
    expect(secondRegistration).not.toBe(firstRegistration);

    const reRegisteredStatus = testIO(root);
    expect(await runCli(["agent", "status", id], reRegisteredStatus)).toBe(0);
    expect(reRegisteredStatus.output.join("")).toContain(
      "Authorization: disabled",
    );
    expect(reRegisteredStatus.output.join("")).toContain(
      "Registration identity: stale",
    );
  });

  it("reports M1 policy diagnostics without claiming App Server readiness", async () => {
    await setupConfig();
    const io = testIO(process.cwd());

    expect(await runCli(["doctor"], io)).toBe(0);
    const output = io.output.join("");
    expect(output).toContain(
      "Agent policy: valid (safe defaults; file not created)",
    );
    expect(output).toContain("Agent global default: luna-max");
    expect(output).toContain("1 structurally valid");
    expect(output).toContain("0 enabled; 0 disabled; 0 stale or mismatched");
    expect(output).not.toMatch(
      /App Server compatibility|authentication status|model availability|sandbox readiness/i,
    );
  });
});
