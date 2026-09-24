import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it } from "vitest";
import {
  addProject,
  ensureRegistry,
  removeProject,
  writeRegistry,
} from "../src/projects/registry.js";
import { createContextBridgeServer } from "../src/mcp/server.js";
import { createHttpServer, listenHttpServer } from "../src/transports/http.js";

const roots: string[] = [];
const oldAppData = process.env.APPDATA;
const oldXdg = process.env.XDG_CONFIG_HOME;

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
  if (oldAppData === undefined) delete process.env.APPDATA;
  else process.env.APPDATA = oldAppData;
  if (oldXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = oldXdg;
});

describe.sequential("MCP contract", () => {
  it("exposes the read-only tool set and project-relative results", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "ctxbridge-mcp-"));
    roots.push(base);
    process.env.APPDATA = path.join(base, "appdata");
    process.env.XDG_CONFIG_HOME = path.join(base, "xdg");
    await ensureRegistry();
    const projectRoot = path.join(base, "registered-project");
    await mkdir(projectRoot);
    await writeFile(path.join(projectRoot, "hello.txt"), "MCP content\n");
    await addProject(projectRoot);

    const server = createContextBridgeServer();
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const client = new Client({
      name: "context-bridge-tests",
      version: "1.0.0",
    });
    await Promise.all([
      client.connect(clientTransport),
      server.connect(serverTransport),
    ]);
    try {
      const listed = await client.listTools();
      const names = listed.tools.map((tool) => tool.name).sort();
      expect(names).toEqual([
        "file_read",
        "files_list",
        "files_search",
        "git_diff",
        "git_log",
        "git_show",
        "git_status",
        "project_get",
        "projects_list",
      ]);
      expect(
        listed.tools.every((tool) => tool.annotations?.readOnlyHint === true),
      ).toBe(true);
      expect(
        listed.tools.every(
          (tool) => tool.annotations?.destructiveHint === false,
        ),
      ).toBe(true);
      expect(
        listed.tools.every((tool) => tool.annotations?.openWorldHint === false),
      ).toBe(true);

      const projects = await client.callTool({
        name: "projects_list",
        arguments: {},
      });
      const textContent = projects.content.find((item) => item.type === "text");
      expect(textContent?.type).toBe("text");
      if (textContent?.type === "text")
        expect(JSON.parse(textContent.text)).toEqual(
          projects.structuredContent,
        );
      const projectText = JSON.stringify(projects);
      expect(projectText).toContain("registered-project");
      expect(projectText).not.toContain(projectRoot);
      const read = await client.callTool({
        name: "file_read",
        arguments: { project_id: "registered-project", path: "hello.txt" },
      });
      expect(JSON.stringify(read)).toContain("MCP content");
      expect(JSON.stringify(read)).not.toContain(projectRoot);
      const shortRead = await client.callTool({
        name: "file_read",
        arguments: {
          project_id: "registered-project",
          path: "hello.txt",
          max_bytes: 4,
        },
      });
      expect(JSON.stringify(shortRead)).toContain("MCP ");
      const escape = await client.callTool({
        name: "file_read",
        arguments: {
          project_id: "registered-project",
          path: "../../secret.txt",
        },
      });
      expect(escape.isError).toBe(true);
      await removeProject("registered-project");
      const revoked = await client.callTool({
        name: "file_read",
        arguments: { project_id: "registered-project", path: "hello.txt" },
      });
      expect(revoked.isError).toBe(true);
      expect(JSON.stringify(revoked)).toContain("project_not_found");
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("serves the same tools over loopback Streamable HTTP and rejects hostile origins", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "ctxbridge-http-"));
    roots.push(base);
    process.env.APPDATA = path.join(base, "appdata");
    process.env.XDG_CONFIG_HOME = path.join(base, "xdg");
    await ensureRegistry();
    const projectRoot = path.join(base, "registered-project");
    await mkdir(projectRoot);
    await writeFile(path.join(projectRoot, "http.txt"), "HTTP content\n");
    await addProject(projectRoot);

    const server = createHttpServer();
    const port = await listenHttpServer(server, 0);
    const endpoint = new URL(`http://127.0.0.1:${port}/mcp`);
    const client = new Client({
      name: "context-bridge-http-tests",
      version: "1.0.0",
    });
    const transport = new StreamableHTTPClientTransport(endpoint);
    try {
      const hostile = await fetch(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://attacker.example",
        },
        body: "{}",
      });
      expect(hostile.status).toBe(403);

      await client.connect(transport);
      const projects = await client.callTool({
        name: "projects_list",
        arguments: {},
      });
      expect(JSON.stringify(projects)).toContain("registered-project");
      const file = await client.callTool({
        name: "file_read",
        arguments: { project_id: "registered-project", path: "http.txt" },
      });
      expect(JSON.stringify(file)).toContain("HTTP content");
      expect(JSON.stringify(file)).not.toContain(projectRoot);
      await writeFile(
        path.join(projectRoot, "control.txt"),
        "\u0001".repeat(300_000),
      );
      const oversized = await client.callTool({
        name: "file_read",
        arguments: { project_id: "registered-project", path: "control.txt" },
      });
      expect(oversized.isError).not.toBe(true);
      expect(JSON.stringify(oversized)).toContain('"truncated":true');
    } finally {
      await client.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("keeps legacy sensitive project roots unavailable without revealing their paths", async () => {
    const base = await mkdtemp(
      path.join(os.tmpdir(), "ctxbridge-mcp-sensitive-"),
    );
    roots.push(base);
    process.env.APPDATA = path.join(base, "appdata");
    process.env.XDG_CONFIG_HOME = path.join(base, "xdg");
    await ensureRegistry();
    const projectRoot = path.join(
      base,
      ".config",
      "gcloud",
      "legacy_credentials",
      "account",
    );
    await mkdir(projectRoot, { recursive: true });
    await writeFile(path.join(projectRoot, "adc.json"), "PRIVATE_ADC_MARKER");
    await writeRegistry({
      version: 1,
      projects: [
        {
          id: "legacy-account",
          name: "account",
          root: await realpath(projectRoot),
          addedAt: new Date(0).toISOString(),
        },
      ],
    });

    const server = createContextBridgeServer();
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const client = new Client({
      name: "context-bridge-sensitive-root-tests",
      version: "1.0.0",
    });
    await Promise.all([
      client.connect(clientTransport),
      server.connect(serverTransport),
    ]);
    try {
      const projects = await client.callTool({
        name: "projects_list",
        arguments: {},
      });
      expect(JSON.stringify(projects)).toContain('"available":false');
      expect(JSON.stringify(projects)).not.toContain(projectRoot);

      const read = await client.callTool({
        name: "file_read",
        arguments: { project_id: "legacy-account", path: "adc.json" },
      });
      expect(read.isError).toBe(true);
      expect(JSON.stringify(read)).not.toContain(projectRoot);
      expect(JSON.stringify(read)).not.toContain("PRIVATE_ADC_MARKER");
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("runs as a stdio child process without writing diagnostics to the protocol stream", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "ctxbridge-stdio-"));
    roots.push(base);
    process.env.APPDATA = path.join(base, "appdata");
    process.env.XDG_CONFIG_HOME = path.join(base, "xdg");
    await ensureRegistry();
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined) env[key] = value;
    }
    const client = new Client({
      name: "context-bridge-stdio-tests",
      version: "1.0.0",
    });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["--import", "tsx", "src/cli/main.ts", "mcp", "--stdio"],
      cwd: process.cwd(),
      env,
    });
    try {
      await client.connect(transport);
      const projects = await client.callTool({
        name: "projects_list",
        arguments: {},
      });
      expect(JSON.stringify(projects)).toContain('"projects":[]');
      expect(JSON.stringify(projects)).not.toContain("internal_error");
    } finally {
      await client.close();
    }
  });
});
