import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/commands.js";

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

describe.sequential("CLI", () => {
  it("supports help, version, init, default-current-directory registration, show, list, and remove", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "ctxbridge-cli-"));
    roots.push(root);
    process.env.APPDATA = path.join(root, "appdata");
    process.env.XDG_CONFIG_HOME = path.join(root, "xdg");
    const output: string[] = [];
    const errors: string[] = [];
    const io = {
      stdout: (text: string) => output.push(text),
      stderr: (text: string) => errors.push(text),
      cwd: path.join(root, "demo-project"),
    };
    await mkdir(io.cwd);

    expect(await runCli(["--help"], io)).toBe(0);
    expect(output.join("")).toContain("ctxbridge project add [path]");
    output.length = 0;
    expect(await runCli(["--version"], io)).toBe(0);
    expect(output.join("").trim()).toBe("0.1.0");
    output.length = 0;
    expect(await runCli(["init"], io)).toBe(0);
    expect(output.join("")).toContain("initialized");
    output.length = 0;
    expect(await runCli(["project", "add"], io)).toBe(0);
    expect(output.join("")).toContain("demo-project");
    output.length = 0;
    expect(await runCli(["project", "list"], io)).toBe(0);
    expect(output.join("")).toContain("ID\tNAME\tAVAILABILITY\n");
    expect(output.join("")).toContain("demo-project");
    expect(output.join("")).not.toContain(io.cwd);
    output.length = 0;
    expect(await runCli(["project", "show", "demo-project"], io)).toBe(0);
    expect(output.join("")).toContain(io.cwd);
    output.length = 0;
    expect(await runCli(["project", "remove", "demo-project"], io)).toBe(0);
    expect(output.join("")).toContain("Project files were not changed");
    output.length = 0;
    expect(await runCli(["project", "list"], io)).toBe(0);
    expect(output.join("")).toContain("ID\tNAME\tAVAILABILITY\n");
    expect(errors).toEqual([]);
  });

  it("rejects invalid MCP transport and port arguments", async () => {
    const output: string[] = [];
    const errors: string[] = [];
    const io = {
      stdout: (text: string) => output.push(text),
      stderr: (text: string) => errors.push(text),
      cwd: process.cwd(),
    };
    expect(await runCli(["mcp"], io)).toBe(1);
    expect(await runCli(["mcp", "--http", "--port", "0"], io)).toBe(1);
    expect(errors.join("")).toContain("Choose an MCP transport");
    expect(errors.join("")).toContain("port must be between");
  });

  it("gives a clear local error without echoing a sensitive root path", async () => {
    const base = await mkdtemp(
      path.join(os.tmpdir(), "ctxbridge-cli-sensitive-"),
    );
    roots.push(base);
    process.env.APPDATA = path.join(base, "appdata");
    process.env.XDG_CONFIG_HOME = path.join(base, "xdg");
    const sensitiveRoot = path.join(
      base,
      ".config",
      "gcloud",
      "legacy_credentials",
      "account",
    );
    await mkdir(sensitiveRoot, { recursive: true });
    const errors: string[] = [];
    const io = {
      stdout: () => undefined,
      stderr: (text: string) => errors.push(text),
      cwd: base,
    };

    expect(await runCli(["project", "add", sensitiveRoot], io)).toBe(1);
    expect(errors.join("")).toContain(
      "protected by Context Bridge's built-in sensitive-path policy",
    );
    expect(errors.join("")).not.toContain(sensitiveRoot);
  });
});
