import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentExecutionAdapter } from "../src/agents/adapter.js";
import type { TaskRuntime } from "../src/tasks/runtime.js";
import { ensureRegistry } from "../src/projects/registry.js";
import { createContextBridgeServer } from "../src/mcp/server.js";
import { LazyTaskToolHost } from "../src/mcp/task-host.js";

const roots: string[] = [];
const originals = {
  appData: process.env.APPDATA,
  xdg: process.env.XDG_CONFIG_HOME,
  home: process.env.HOME,
};

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
  if (originals.appData === undefined) delete process.env.APPDATA;
  else process.env.APPDATA = originals.appData;
  if (originals.xdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = originals.xdg;
  if (originals.home === undefined) delete process.env.HOME;
  else process.env.HOME = originals.home;
});

describe.sequential("lazy MCP task host", () => {
  it("does not acquire runtime on construction or read-only requests and closes execution before runtime", async () => {
    const order: string[] = [];
    let runtimeStarts = 0;
    let adapterStarts = 0;
    let codexStarts = 0;
    const fakeRuntime = {
      manager: {
        listRegisteredTaskRecordsPage: async () => ({
          records: [],
          truncated: false,
        }),
      },
      isClosed: false,
      close: async () => {
        order.push("runtime");
      },
    } as unknown as TaskRuntime;
    const host = new LazyTaskToolHost({
      runtimeFactory: async () => {
        runtimeStarts += 1;
        return fakeRuntime;
      },
      adapterFactory: async () => {
        adapterStarts += 1;
        return {
          start: async () => {
            codexStarts += 1;
            throw new Error("Codex must not start for a Plan-mode rejection.");
          },
          subscribe: () => () => undefined,
          close: async () => {
            order.push("execution");
          },
        } as unknown as AgentExecutionAdapter;
      },
    });
    const server = createContextBridgeServer({ taskHost: host });
    expect(runtimeStarts).toBe(0);
    expect(adapterStarts).toBe(0);
    await server.close();
    expect(runtimeStarts).toBe(0);
    await host.listTasks({ limit: 20 });
    expect(runtimeStarts).toBe(1);
    expect(adapterStarts).toBe(0);

    await expect(
      host.startTask({
        project_id: "sample-project",
        prompt: "This mode is not available yet.",
        mode: "plan",
      }),
    ).rejects.toMatchObject({ code: "unsupported_task_mode" });
    expect(adapterStarts).toBe(1);
    expect(codexStarts).toBe(0);
    await host.close();
    expect(order).toEqual(["execution", "runtime"]);
    await host.close();
    expect(order).toEqual(["execution", "runtime"]);
  });

  it("surfaces runtime ownership contention while keeping read-only tools usable, then retries after release", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "ctxbridge-host-"));
    roots.push(base);
    if (process.platform === "win32") {
      process.env.APPDATA = path.join(base, "appdata");
    } else if (process.platform === "darwin") {
      process.env.HOME = path.join(base, "home");
      await mkdir(process.env.HOME, { recursive: true });
    } else {
      process.env.XDG_CONFIG_HOME = path.join(base, "xdg");
    }
    await ensureRegistry();

    let adapterFactoryCalls = 0;
    const hostA = new LazyTaskToolHost({
      adapterFactory: () => {
        adapterFactoryCalls += 1;
        throw new Error("Task list must not create the Codex adapter.");
      },
    });
    const hostB = new LazyTaskToolHost();
    const page = await hostA.listTasks({ limit: 1 });
    expect(page.records).toEqual([]);
    expect(adapterFactoryCalls).toBe(0);

    await expect(hostB.getTask(randomUUID())).rejects.toMatchObject({
      code: "agent_runtime_busy",
    });

    const server = createContextBridgeServer({ taskHost: hostB });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "host-b-read-only", version: "1.0.0" });
    await Promise.all([
      client.connect(clientTransport),
      server.connect(serverTransport),
    ]);
    try {
      const projects = await client.callTool({
        name: "projects_list",
        arguments: {},
      });
      expect(JSON.stringify(projects)).toContain('"projects":[]');
    } finally {
      await client.close();
      await server.close();
    }

    await hostA.close();
    const retried = await hostB.listTasks({ limit: 1 });
    expect(retried.records).toEqual([]);
    await hostB.close();
  });
});
