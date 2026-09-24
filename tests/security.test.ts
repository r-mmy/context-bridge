import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readTextFile } from "../src/filesystem/read.js";
import { listFiles, searchFiles } from "../src/filesystem/walk.js";
import { ContextBridgeError } from "../src/security/errors.js";
import { resolveProjectPath } from "../src/security/paths.js";
import { makeTempDirectory, projectAt, removeTree } from "./helpers.js";

const temporary: string[] = [];

async function makeProject(): Promise<ReturnType<typeof projectAt>> {
  const root = await makeTempDirectory();
  temporary.push(root);
  return projectAt(root);
}

afterEach(async () => {
  await Promise.all(temporary.splice(0).map(removeTree));
});

describe("project path boundary", () => {
  it("accepts a normalized in-root relative path", async () => {
    const project = await makeProject();
    await mkdir(path.join(project.root, "src"), { recursive: true });
    await writeFile(path.join(project.root, "src", "main.ts"), "ok");
    const resolved = await resolveProjectPath(
      project,
      "src\\nested\\..\\main.ts",
    );
    expect(resolved.relativePath).toBe("src/main.ts");
    expect(await readFile(resolved.absolutePath, "utf8")).toBe("ok");
  });

  it("keeps sensitive ancestors protected while allowing ordinary .config projects", async () => {
    const base = await makeTempDirectory("ctxbridge-sensitive-ancestor-");
    temporary.push(base);
    const sensitiveRoot = path.join(
      base,
      ".config",
      "gcloud",
      "legacy_credentials",
      "account",
    );
    const ordinaryRoot = path.join(base, ".config", "ordinary-project");
    await mkdir(sensitiveRoot, { recursive: true });
    await mkdir(ordinaryRoot, { recursive: true });
    await writeFile(path.join(sensitiveRoot, "adc.json"), "PRIVATE_ADC_MARKER");
    await writeFile(path.join(ordinaryRoot, "main.ts"), "ordinary source");

    const sensitiveProject = projectAt(sensitiveRoot);
    await expect(
      resolveProjectPath(sensitiveProject, "adc.json"),
    ).rejects.toMatchObject({ code: "path_denied" });
    await expect(
      readTextFile(sensitiveProject, "adc.json"),
    ).rejects.toMatchObject({ code: "path_denied" });
    await expect(listFiles(sensitiveProject)).rejects.toMatchObject({
      code: "path_denied",
    });
    await expect(
      searchFiles(sensitiveProject, { query: "PRIVATE_ADC_MARKER" }),
    ).rejects.toMatchObject({ code: "path_denied" });

    const ordinaryProject = projectAt(ordinaryRoot);
    await expect(
      readTextFile(ordinaryProject, "main.ts"),
    ).resolves.toMatchObject({ text: "ordinary source" });
  });

  it.each([
    "../../outside.txt",
    "..\\..\\outside.txt",
    "C:\\secret.txt",
    "//server/share/secret.txt",
    "\\rooted.txt",
  ])("rejects unsafe path %s", async (requested) => {
    const project = await makeProject();
    await expect(resolveProjectPath(project, requested)).rejects.toBeInstanceOf(
      ContextBridgeError,
    );
  });

  it("rejects a symlink or junction that resolves outside the project", async (context) => {
    const project = await makeProject();
    const outside = await makeTempDirectory("ctxbridge-outside-");
    temporary.push(outside);
    await writeFile(path.join(outside, "data.txt"), "outside");
    const linkPath = path.join(project.root, "escape");
    try {
      await symlink(
        outside,
        linkPath,
        process.platform === "win32" ? "junction" : "dir",
      );
    } catch {
      context.skip();
      return;
    }
    await expect(
      resolveProjectPath(project, "escape/data.txt"),
    ).rejects.toMatchObject({ code: "symlink_escape" });
  });

  it("does not expose a denied secret through an in-root symlink", async (context) => {
    const project = await makeProject();
    const secretDirectory = path.join(project.root, ".aws");
    await mkdir(secretDirectory);
    await writeFile(path.join(secretDirectory, "credentials"), "SECRET_MARKER");
    try {
      await symlink(
        secretDirectory,
        path.join(project.root, "ordinary-store"),
        process.platform === "win32" ? "junction" : "dir",
      );
    } catch {
      context.skip();
      return;
    }
    await expect(
      readTextFile(project, "ordinary-store/credentials"),
    ).rejects.toMatchObject({ code: "path_denied" });
    await expect(
      resolveProjectPath(project, "ordinary-store/credentials"),
    ).rejects.toMatchObject({ code: "path_denied" });
  });

  it("rejects Windows alternate data streams before file access", async (context) => {
    if (process.platform !== "win32") {
      context.skip();
      return;
    }
    const project = await makeProject();
    const envPath = path.join(project.root, ".env");
    await writeFile(envPath, "TOKEN=main-stream\n");
    await writeFile(path.join(project.root, "ordinary.txt"), "ordinary\n");
    try {
      await writeFile(`${envPath}:secret`, "TOKEN=ADS_SECRET_MARKER\n");
    } catch {
      context.skip();
      return;
    }

    await expect(readTextFile(project, ".env:secret")).rejects.toMatchObject({
      code: "invalid_path",
    });
    await expect(
      listFiles(project, { path: ".env:secret" }),
    ).rejects.toMatchObject({ code: "invalid_path" });
    await expect(
      searchFiles(project, { query: "TOKEN", path: ".env:secret" }),
    ).rejects.toMatchObject({ code: "invalid_path" });
    await expect(
      resolveProjectPath(project, "ordinary.txt"),
    ).resolves.toBeDefined();
    await expect(readTextFile(project, "ordinary.txt")).resolves.toMatchObject({
      text: "ordinary",
    });
  });
});

describe("shared ignore and secret filtering", () => {
  it("honors gitignore, contextbridge negation, and the non-overridable denylist", async () => {
    const project = await makeProject();
    await writeFile(
      path.join(project.root, ".gitignore"),
      "ignored.txt\n*.tmp\n",
    );
    await writeFile(
      path.join(project.root, ".contextbridgeignore"),
      "!ignored.txt\nprivate.txt\n!.env\n",
    );
    await writeFile(path.join(project.root, "ignored.txt"), "re-included");
    await writeFile(path.join(project.root, "hidden.tmp"), "ignored by Git");
    await writeFile(path.join(project.root, "private.txt"), "private");
    await writeFile(path.join(project.root, ".env"), "token=SECRET_MARKER");
    await writeFile(
      path.join(project.root, ".env.example"),
      "TOKEN=replace-me",
    );

    await expect(
      resolveProjectPath(project, "ignored.txt"),
    ).resolves.toBeDefined();
    await expect(
      resolveProjectPath(project, "hidden.tmp"),
    ).rejects.toMatchObject({ code: "path_ignored" });
    await expect(
      resolveProjectPath(project, "private.txt"),
    ).rejects.toMatchObject({ code: "path_ignored" });
    await expect(resolveProjectPath(project, ".env")).rejects.toMatchObject({
      code: "path_denied",
    });
    await expect(readTextFile(project, ".env.example")).resolves.toMatchObject({
      text: "TOKEN=replace-me",
    });
  });

  it("applies the full ignore chain so nested Context Bridge rules can override Git rules", async () => {
    const project = await makeProject();
    const nested = path.join(project.root, "nested");
    const ignoredDirectory = path.join(project.root, "ignored-dir");
    await mkdir(nested);
    await mkdir(ignoredDirectory);
    await writeFile(
      path.join(project.root, ".gitignore"),
      "*.tmp\nignored-dir/\n",
    );
    await writeFile(
      path.join(project.root, ".contextbridgeignore"),
      "!root-keep.tmp\n",
    );
    await writeFile(path.join(nested, ".gitignore"), "*.log\n");
    await writeFile(
      path.join(nested, ".contextbridgeignore"),
      "!nested-keep.tmp\n!keep.log\n!reignored.log\nreignored.log\n",
    );
    await writeFile(
      path.join(ignoredDirectory, ".contextbridgeignore"),
      "!keep.tmp\n!reignored.tmp\nreignored.tmp\n",
    );
    const fixtures: Record<string, string> = {
      "root-keep.tmp": "ROOT_KEEP_MARKER",
      "root-hide.tmp": "ROOT_HIDE_MARKER",
      "nested/nested-keep.tmp": "NESTED_KEEP_MARKER",
      "nested/keep.log": "NESTED_GIT_OVERRIDE_MARKER",
      "nested/reignored.log": "NESTED_REIGNORE_MARKER",
      "ignored-dir/keep.tmp": "IGNORED_DIR_KEEP_MARKER",
      "ignored-dir/reignored.tmp": "IGNORED_DIR_REIGNORE_MARKER",
    };
    await Promise.all(
      Object.entries(fixtures).map(([relative, contents]) =>
        writeFile(path.join(project.root, ...relative.split("/")), contents),
      ),
    );

    for (const visible of [
      "root-keep.tmp",
      "nested/nested-keep.tmp",
      "nested/keep.log",
      "ignored-dir/keep.tmp",
    ])
      await expect(resolveProjectPath(project, visible)).resolves.toBeDefined();
    for (const ignored of [
      "root-hide.tmp",
      "nested/reignored.log",
      "ignored-dir/reignored.tmp",
    ])
      await expect(resolveProjectPath(project, ignored)).rejects.toMatchObject({
        code: "path_ignored",
      });

    const listing = await listFiles(project, { depth: 8 });
    for (const visible of [
      "root-keep.tmp",
      "nested/nested-keep.tmp",
      "nested/keep.log",
      "ignored-dir/keep.tmp",
    ])
      expect(listing.entries.map((entry) => entry.path)).toContain(visible);
    expect(listing.entries.map((entry) => entry.path)).not.toContain(
      "ignored-dir",
    );
    const nestedListing = await listFiles(project, {
      path: "ignored-dir",
      depth: 2,
    });
    expect(nestedListing.entries.map((entry) => entry.path)).toContain(
      "ignored-dir/keep.tmp",
    );

    const search = await searchFiles(project, {
      query: "MARKER",
      maxResults: 100,
    });
    const resultPaths = search.results.map((result) => result.path);
    for (const visible of [
      "root-keep.tmp",
      "nested/nested-keep.tmp",
      "nested/keep.log",
      "ignored-dir/keep.tmp",
    ])
      expect(resultPaths).toContain(visible);
    expect(resultPaths).not.toContain("nested/reignored.log");
    await expect(
      searchFiles(project, { query: "MARKER", path: "ignored-dir" }),
    ).resolves.toMatchObject({
      results: [expect.objectContaining({ path: "ignored-dir/keep.tmp" })],
    });
    await expect(
      readTextFile(project, "ignored-dir/keep.tmp"),
    ).resolves.toMatchObject({ text: "IGNORED_DIR_KEEP_MARKER" });
  });

  it("rejects ignore-rule directories that resolve outside the project", async (context) => {
    const project = await makeProject();
    const outside = await makeTempDirectory("ctxbridge-ignore-outside-");
    temporary.push(outside);
    await writeFile(path.join(outside, ".gitignore"), "ignored.txt\n");
    try {
      await symlink(
        outside,
        path.join(project.root, "linked-rules"),
        process.platform === "win32" ? "junction" : "dir",
      );
    } catch {
      context.skip();
      return;
    }

    await expect(
      resolveProjectPath(project, "linked-rules/ignored.txt"),
    ).rejects.toMatchObject({ code: "symlink_escape" });
  });

  it("fails safely on oversized and malformed ignore files", async () => {
    const project = await makeProject();
    await writeFile(
      path.join(project.root, ".contextbridgeignore"),
      "x".repeat(256 * 1024 + 1),
    );
    await expect(
      resolveProjectPath(project, "ordinary.txt"),
    ).rejects.toMatchObject({ code: "ignore_file_too_large" });

    await writeFile(
      path.join(project.root, ".contextbridgeignore"),
      Buffer.from([0xff]),
    );
    await expect(
      resolveProjectPath(project, "ordinary.txt"),
    ).rejects.toMatchObject({ code: "invalid_ignore_file" });
  });

  it("stops listing and search after the directory scan budget", async () => {
    const project = await makeProject();
    for (let index = 0; index < 2050; index += 1) {
      await writeFile(
        path.join(project.root, `.hidden-${index.toString().padStart(4, "0")}`),
        "",
      );
    }

    await expect(listFiles(project, { maxEntries: 5 })).resolves.toMatchObject({
      entries: [],
      truncated: true,
    });
    await expect(
      searchFiles(project, { query: "never-present" }),
    ).resolves.toMatchObject({ results: [], truncated: true });
  });

  it("denies common cloud credential stores and private-key extensions", async () => {
    const project = await makeProject();
    const deniedPaths = [
      ".aws/credentials",
      ".azure/accessTokens.json",
      ".config/gcloud/credentials.db",
      ".config/gcloud/legacy_credentials/user/adc.json",
      "service_account.json",
      "private.der",
    ];
    for (const relative of deniedPaths) {
      const absolute = path.join(project.root, ...relative.split("/"));
      await mkdir(path.dirname(absolute), { recursive: true });
      await writeFile(absolute, "sensitive");
      await expect(resolveProjectPath(project, relative)).rejects.toMatchObject(
        {
          code: "path_denied",
        },
      );
    }
  });

  it("omits hidden entries by default and includes them only when requested", async () => {
    const project = await makeProject();
    await writeFile(path.join(project.root, ".hidden.txt"), "hidden");
    await writeFile(path.join(project.root, "visible.txt"), "visible");
    await expect(listFiles(project)).resolves.toMatchObject({
      entries: [{ path: "visible.txt" }],
    });
    const inclusive = await listFiles(project, { includeHidden: true });
    expect(inclusive.entries.map((entry) => entry.path).sort()).toEqual([
      ".hidden.txt",
      "visible.txt",
    ]);
  });

  it("bounds huge reads and rejects binary content", async () => {
    const project = await makeProject();
    await writeFile(
      path.join(project.root, "large.txt"),
      "x".repeat(5 * 1024 * 1024),
    );
    const read = await readTextFile(project, "large.txt");
    expect(Buffer.byteLength(read.text, "utf8")).toBeLessThanOrEqual(
      256 * 1024,
    );
    expect(read.truncated).toBe(true);
    const binary = Buffer.alloc(16 * 1024, 0x61);
    binary[12_000] = 0;
    await writeFile(path.join(project.root, "late-binary.bin"), binary);
    await expect(
      readTextFile(project, "late-binary.bin"),
    ).rejects.toMatchObject({ code: "binary_file" });
  });

  it("truncates file and search text only at UTF-8 boundaries", async () => {
    const project = await makeProject();
    const text = "Aé漢😀Z";
    await writeFile(path.join(project.root, "unicode.txt"), text);
    const expectedPrefix = (maxBytes: number) => {
      let result = "";
      for (const character of text) {
        if (Buffer.byteLength(result + character, "utf8") > maxBytes) break;
        result += character;
      }
      return result;
    };

    for (
      let maxBytes = 1;
      maxBytes <= Buffer.byteLength(text, "utf8");
      maxBytes += 1
    ) {
      const result = await readTextFile(project, "unicode.txt", { maxBytes });
      expect(result.text).toBe(expectedPrefix(maxBytes));
      expect(result.text).not.toContain("\uFFFD");
      expect(Buffer.byteLength(result.text, "utf8")).toBeLessThanOrEqual(
        maxBytes,
      );
    }

    await writeFile(
      path.join(project.root, "search-unicode.txt"),
      `needle ${text}\n`,
    );
    const search = await searchFiles(project, {
      query: "needle",
      path: "search-unicode.txt",
      maxBytes: 4096,
    });
    expect(JSON.stringify(search.results)).toContain(text);
    expect(JSON.stringify(search.results)).not.toContain("\uFFFD");
    expect(
      Buffer.byteLength(JSON.stringify(search.results), "utf8"),
    ).toBeLessThanOrEqual(4096);
  });

  it("uses the native bounded search fallback for literal and regex queries", async () => {
    const project = await makeProject();
    await writeFile(
      path.join(project.root, "source.ts"),
      "first\nneedle42 here\nlast\n",
    );
    const oldPath = process.env.PATH;
    process.env.PATH = "";
    try {
      await expect(
        searchFiles(project, { query: "needle", contextLines: 1 }),
      ).resolves.toMatchObject({
        results: [
          {
            path: "source.ts",
            matches: [
              {
                line: 2,
                text: "needle42 here",
                context: [
                  { line: 1, text: "first" },
                  { line: 3, text: "last" },
                ],
              },
            ],
          },
        ],
      });
      await expect(
        searchFiles(project, { query: "needle\\d+", mode: "regex" }),
      ).resolves.toMatchObject({
        results: [{ path: "source.ts", matches: [{ line: 2 }] }],
      });
    } finally {
      if (oldPath === undefined) delete process.env.PATH;
      else process.env.PATH = oldPath;
    }
  });

  it("honors the configurable search-result byte cap", async () => {
    const project = await makeProject();
    await writeFile(
      path.join(project.root, "search.txt"),
      `needle${"x".repeat(2048)}\n`,
    );
    await expect(
      searchFiles(project, { query: "needle", maxBytes: 512 }),
    ).resolves.toMatchObject({ results: [], truncated: true });
    const expanded = await searchFiles(project, {
      query: "needle",
      maxBytes: 4096,
    });
    expect(expanded.results[0]?.matches[0]?.text).toContain("needle");
    expect(
      Buffer.byteLength(JSON.stringify(expanded.results), "utf8"),
    ).toBeLessThanOrEqual(4096);
    expect(expanded.truncated).toBe(false);
  });
});
