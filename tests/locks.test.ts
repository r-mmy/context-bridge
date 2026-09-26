import { spawn, type ChildProcess } from "node:child_process";
import { access, mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { readAgentPolicy } from "../src/agents/policy.js";
import {
  getConfigMutationLockPath,
  getProjectWriterLockPath,
} from "../src/locks/paths.js";
import { readRegistry } from "../src/projects/registry.js";

interface ChildEvent {
  event: string;
  code?: string;
  id?: string;
  name?: string;
}

interface TestChild {
  process: ChildProcess;
  waitFor(event: string, timeoutMs?: number): Promise<ChildEvent>;
  release(): void;
  waitForExit(): Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>;
  kill(): Promise<void>;
}

const fixturePath = fileURLToPath(
  new URL("./fixtures/lock-child.mjs", import.meta.url),
);
const repositoryRoot = path.resolve(path.dirname(fixturePath), "../..");
const children: TestChild[] = [];
const temporaryRoots: string[] = [];
const oldAppData = process.env.APPDATA;
const oldXdg = process.env.XDG_CONFIG_HOME;
const oldHome = process.env.HOME;

function startChild(...args: string[]): TestChild {
  const childProcess = spawn(
    process.execPath,
    ["--import", "tsx", fixturePath, ...args],
    {
      cwd: repositoryRoot,
      stdio: ["pipe", "pipe", "ignore"],
      windowsHide: true,
    },
  );
  let pendingText = "";
  const events: ChildEvent[] = [];
  const waiters = new Map<string, ((event: ChildEvent) => void)[]>();
  let exited = false;
  const exitPromise = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve) => {
    childProcess.once("exit", (code, signal) => {
      exited = true;
      resolve({ code, signal });
    });
  });

  childProcess.stdout?.on("data", (chunk: Buffer) => {
    pendingText += chunk.toString("utf8");
    while (pendingText.includes("\n")) {
      const newline = pendingText.indexOf("\n");
      const line = pendingText.slice(0, newline);
      pendingText = pendingText.slice(newline + 1);
      const event = JSON.parse(line) as ChildEvent;
      const listeners = waiters.get(event.event);
      if (listeners?.length) listeners.shift()?.(event);
      else events.push(event);
    }
  });

  const child: TestChild = {
    process: childProcess,
    waitFor(eventName, timeoutMs = 10_000) {
      const index = events.findIndex((event) => event.event === eventName);
      if (index >= 0) return Promise.resolve(events.splice(index, 1)[0]!);
      return new Promise((resolve, reject) => {
        const listener = (event: ChildEvent): void => {
          clearTimeout(timer);
          resolve(event);
        };
        const listeners = waiters.get(eventName) ?? [];
        listeners.push(listener);
        waiters.set(eventName, listeners);
        const timer = setTimeout(() => {
          const current = waiters.get(eventName) ?? [];
          const listenerIndex = current.indexOf(listener);
          if (listenerIndex >= 0) current.splice(listenerIndex, 1);
          reject(new Error(`Timed out waiting for child event ${eventName}.`));
        }, timeoutMs);
        if (exited) {
          clearTimeout(timer);
          reject(new Error(`Child exited before event ${eventName}.`));
        }
      });
    },
    release() {
      if (!exited) childProcess.stdin?.write("release\n");
    },
    waitForExit: () => exitPromise,
    async kill() {
      if (!exited) childProcess.kill("SIGKILL");
      await exitPromise;
    },
  };
  children.push(child);
  return child;
}

async function useTemporaryConfig(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "ctxbridge-lock-tests-"));
  temporaryRoots.push(root);
  process.env.APPDATA = path.join(root, "appdata");
  process.env.XDG_CONFIG_HOME = path.join(root, "xdg");
  process.env.HOME = root;
  return root;
}

afterEach(async () => {
  await Promise.all(children.splice(0).map((child) => child.kill()));
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
  if (oldAppData === undefined) delete process.env.APPDATA;
  else process.env.APPDATA = oldAppData;
  if (oldXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = oldXdg;
  if (oldHome === undefined) delete process.env.HOME;
  else process.env.HOME = oldHome;
});

describe.sequential("native cross-process locks", () => {
  it("serializes config mutations, times out safely, and recovers after holder death", async () => {
    await useTemporaryConfig();
    const holder = startChild("config-holder");
    expect((await holder.waitFor("acquired")).event).toBe("acquired");

    const rejected = startChild("config-try");
    expect((await rejected.waitFor("busy")).event).toBe("busy");
    expect((await rejected.waitForExit()).code).toBe(0);

    const waiter = startChild("config-wait", "2000");
    expect((await waiter.waitFor("waiting")).event).toBe("waiting");
    holder.release();
    expect((await holder.waitFor("released")).event).toBe("released");
    expect((await waiter.waitFor("acquired")).event).toBe("acquired");
    waiter.release();
    expect((await waiter.waitFor("released")).event).toBe("released");
    expect((await waiter.waitForExit()).code).toBe(0);

    const timeoutHolder = startChild("config-holder");
    await timeoutHolder.waitFor("acquired");
    const timeout = startChild("config-wait", "180");
    await timeout.waitFor("waiting");
    const timeoutEvent = await timeout.waitFor("failed");
    expect(timeoutEvent.code).toBe("config_busy");
    expect((await timeout.waitForExit()).code).toBe(1);
    timeoutHolder.release();
    await timeoutHolder.waitFor("released");

    const killedHolder = startChild("config-holder");
    await killedHolder.waitFor("acquired");
    await killedHolder.kill();
    const recovery = startChild("config-try");
    expect((await recovery.waitFor("acquired")).event).toBe("acquired");
    recovery.release();
    await recovery.waitFor("released");

    await expect(access(getConfigMutationLockPath())).resolves.toBeUndefined();
  });

  it("isolates project writers by root and releases ownership on close or process death", async () => {
    const config = await useTemporaryConfig();
    const rootOne = path.join(config, "project-one");
    const rootTwo = path.join(config, "project-two");
    const holder = startChild("project-holder", rootOne);
    await holder.waitFor("acquired");

    const sameProject = startChild("project-try", rootOne);
    expect((await sameProject.waitFor("busy")).event).toBe("busy");
    expect((await sameProject.waitForExit()).code).toBe(0);

    const otherProject = startChild("project-try", rootTwo);
    expect((await otherProject.waitFor("acquired")).event).toBe("acquired");
    otherProject.release();
    await otherProject.waitFor("released");
    expect((await otherProject.waitForExit()).code).toBe(0);

    holder.release();
    await holder.waitFor("released");
    const afterRelease = startChild("project-try", rootOne);
    expect((await afterRelease.waitFor("acquired")).event).toBe("acquired");
    afterRelease.release();
    await afterRelease.waitFor("released");

    const killedHolder = startChild("project-holder", rootOne);
    await killedHolder.waitFor("acquired");
    await killedHolder.kill();
    const afterDeath = startChild("project-try", rootOne);
    expect((await afterDeath.waitFor("acquired")).event).toBe("acquired");
    afterDeath.release();
    await afterDeath.waitFor("released");

    const lockPath = getProjectWriterLockPath(rootOne);
    expect(path.basename(lockPath)).toMatch(/^project-[a-f0-9]{64}\.lock$/);
    expect(lockPath).not.toContain(rootOne);
    await expect(access(lockPath)).resolves.toBeUndefined();
  });

  it("preserves concurrent profile additions from separate Node processes", async () => {
    await useTemporaryConfig();
    const first = startChild("policy-add", "m3a-first");
    const second = startChild("policy-add", "m3a-second");
    expect((await first.waitFor("profile-added")).name).toBe("m3a-first");
    expect((await second.waitFor("profile-added")).name).toBe("m3a-second");
    expect((await first.waitForExit()).code).toBe(0);
    expect((await second.waitForExit()).code).toBe(0);

    const policy = await readAgentPolicy();
    expect(policy.profiles["m3a-first"]).toEqual({
      model_id: "gpt-6-sol",
      reasoning_effort: "high",
    });
    expect(policy.profiles["m3a-second"]).toEqual({
      model_id: "gpt-6-sol",
      reasoning_effort: "high",
    });
  });

  it("serializes concurrent registry additions without losing either registration", async () => {
    const config = await useTemporaryConfig();
    const rootOne = path.join(config, "parent-one", "demo-project");
    const rootTwo = path.join(config, "parent-two", "demo-project");
    await Promise.all([
      mkdir(rootOne, { recursive: true }),
      mkdir(rootTwo, { recursive: true }),
    ]);

    const first = startChild("registry-add", rootOne);
    const second = startChild("registry-add", rootTwo);
    const firstEvent = await first.waitFor("project-added");
    const secondEvent = await second.waitFor("project-added");
    expect(firstEvent.id).not.toBe(secondEvent.id);
    expect((await first.waitForExit()).code).toBe(0);
    expect((await second.waitForExit()).code).toBe(0);

    const registry = await readRegistry();
    expect(registry.projects).toHaveLength(2);
    expect(registry.projects.map((project) => project.id).sort()).toEqual([
      "demo-project",
      "demo-project-2",
    ]);
  });
});
