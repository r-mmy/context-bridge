import { spawnSync } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  PINNED_CODEX_VERSION,
  resolveCodexRuntime,
} from "../../src/agents/codex/runtime.js";

describe("managed Codex runtime resolution", () => {
  it("resolves the exact local package's declared launcher deterministically", async () => {
    const first = await resolveCodexRuntime();
    const second = await resolveCodexRuntime();

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      executable: process.execPath,
      version: PINNED_CODEX_VERSION,
      source: "managed",
    });
    expect(first.argsPrefix).toHaveLength(1);
    const launcher = first.argsPrefix[0]!;
    expect(path.isAbsolute(launcher)).toBe(true);
    expect(launcher).toMatch(/[\\/]bin[\\/]codex\.js$/);
    expect((await stat(launcher)).isFile()).toBe(true);
  });

  it("executes the installed managed launcher without auth or PATH-based Codex selection", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "ctxbridge-codex-version-"),
    );
    try {
      const runtime = await resolveCodexRuntime();
      expect(runtime.executable).toBe(process.execPath);

      const environment: NodeJS.ProcessEnv = {
        PATH: "",
        CODEX_HOME: path.join(directory, "codex-home"),
      };
      if (process.platform === "win32") {
        const systemRoot = process.env.SYSTEMROOT ?? process.env.SystemRoot;
        if (systemRoot) environment.SYSTEMROOT = systemRoot;
        environment.USERPROFILE = directory;
        environment.HOME = directory;
        environment.APPDATA = path.join(directory, "AppData", "Roaming");
        environment.LOCALAPPDATA = path.join(directory, "AppData", "Local");
        environment.TEMP = directory;
        environment.TMP = directory;
      } else {
        environment.HOME = directory;
        environment.XDG_CONFIG_HOME = path.join(directory, "config");
        environment.TMPDIR = directory;
      }

      const result = spawnSync(
        runtime.executable,
        [...runtime.argsPrefix, "--version"],
        {
          cwd: directory,
          env: environment,
          encoding: "buffer",
          shell: false,
          timeout: 15_000,
          maxBuffer: 16 * 1024,
          windowsHide: true,
        },
      );

      expect(result.error === undefined).toBe(true);
      expect(result.status).toBe(0);
      expect(result.stdout.byteLength).toBeLessThanOrEqual(16 * 1024);
      expect(result.stderr.byteLength).toBeLessThanOrEqual(16 * 1024);
      const output = result.stdout.toString("utf8").trim();
      expect(output).toBe(`codex-cli ${PINNED_CODEX_VERSION}`);
      const version = /^codex-cli\s+([^\s]+)$/.exec(output)?.[1];
      expect(version).toBe(PINNED_CODEX_VERSION);
      expect(version).toBe("0.157.1");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 20_000);
});
