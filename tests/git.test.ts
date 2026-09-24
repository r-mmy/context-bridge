import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  getGitDiff,
  getGitLog,
  getGitShow,
  getGitStatus,
} from "../src/git/service.js";
import { readTextFile } from "../src/filesystem/read.js";
import { listFiles, searchFiles } from "../src/filesystem/walk.js";
import { isGitRepository } from "../src/git/run.js";
import { ContextBridgeError } from "../src/security/errors.js";
import { makeTempDirectory, git, projectAt, removeTree } from "./helpers.js";

const temporary: string[] = [];

async function makeGitProject(): ReturnType<typeof projectAt> {
  const root = await makeTempDirectory("ctxbridge-git-");
  temporary.push(root);
  git(root, ["init", "-q"]);
  git(root, ["config", "core.autocrlf", "false"]);
  git(root, ["config", "user.name", "Context Bridge Tests"]);
  git(root, ["config", "user.email", "ctxbridge-tests@example.invalid"]);
  await writeFile(path.join(root, "safe.txt"), "initial safe content\n");
  await writeFile(path.join(root, ".env"), "TOKEN=INITIAL_SECRET_MARKER\n");
  await writeFile(path.join(root, ".gitattributes"), "*.txt text\n");
  git(root, ["add", "--", "safe.txt", ".env", ".gitattributes"]);
  git(root, ["commit", "-q", "-m", "initial project state"]);
  return await projectAt(root);
}

async function makeNestedGitProject(): Promise<{
  project: Awaited<ReturnType<typeof projectAt>>;
  repositoryRoot: string;
}> {
  const repositoryRoot = await makeTempDirectory("ctxbridge-parent-git-");
  temporary.push(repositoryRoot);
  const allowedRoot = path.join(repositoryRoot, "allowed");
  await mkdir(allowedRoot);
  git(repositoryRoot, ["init", "-q"]);
  git(repositoryRoot, ["config", "core.autocrlf", "false"]);
  git(repositoryRoot, ["config", "user.name", "Context Bridge Tests"]);
  git(repositoryRoot, [
    "config",
    "user.email",
    "ctxbridge-tests@example.invalid",
  ]);
  await writeFile(
    path.join(allowedRoot, "safe.txt"),
    "initial allowed content\n",
  );
  await writeFile(
    path.join(repositoryRoot, "sibling-secret.txt"),
    "INITIAL_OUTSIDE_SECRET_MARKER\n",
  );
  git(repositoryRoot, ["add", "--", "allowed", "sibling-secret.txt"]);
  git(repositoryRoot, ["commit", "-q", "-m", "initial nested project state"]);
  return { project: await projectAt(allowedRoot), repositoryRoot };
}

afterEach(async () => {
  await Promise.all(temporary.splice(0).map(removeTree));
});

describe("read-only Git interface", () => {
  it("reports structured status while filtering denied paths", async () => {
    const project = await makeGitProject();
    await writeFile(path.join(project.root, "safe.txt"), "staged update\n");
    git(project.root, ["add", "--", "safe.txt"]);
    await writeFile(
      path.join(project.root, ".env"),
      "TOKEN=CHANGED_SECRET_MARKER\n",
    );
    await writeFile(
      path.join(project.root, "visible-untracked.txt"),
      "new file\n",
    );
    const status = await getGitStatus(project);
    expect(status.branch).toBeTruthy();
    expect(status.staged).toContain("safe.txt");
    expect(status.modified).not.toContain(".env");
    expect(status.untracked).toContain("visible-untracked.txt");
    expect(JSON.stringify(status)).not.toContain(".env");
  });

  it("re-includes ordinary Git-ignored files through Context Bridge rules", async () => {
    const project = await makeGitProject();
    await writeFile(path.join(project.root, ".gitignore"), "restored.txt\n");
    await writeFile(
      path.join(project.root, ".contextbridgeignore"),
      "!restored.txt\n",
    );
    await writeFile(
      path.join(project.root, "restored.txt"),
      "re-included untracked content\n",
    );

    const status = await getGitStatus(project);
    expect(status.untracked).toContain("restored.txt");

    const diff = await getGitDiff(project, { mode: "working" });
    expect(diff.files).toContain("restored.txt");
    expect(diff.patch).toContain("re-included untracked content");
  });

  it("keeps nested ignore negations consistent across Git status, diffs, and show", async () => {
    const project = await makeGitProject();
    const ignoredDirectory = path.join(project.root, "ignored-dir");
    await mkdir(ignoredDirectory);
    await writeFile(
      path.join(project.root, ".gitignore"),
      "*.tmp\nignored-dir/\n",
    );
    await writeFile(
      path.join(project.root, ".contextbridgeignore"),
      "!root-keep.tmp\n",
    );
    await writeFile(
      path.join(ignoredDirectory, ".contextbridgeignore"),
      "!keep.tmp\n",
    );
    await writeFile(
      path.join(project.root, "root-keep.tmp"),
      "ROOT_KEEP_GIT_MARKER\n",
    );
    await writeFile(
      path.join(ignoredDirectory, "keep.tmp"),
      "NESTED_KEEP_GIT_MARKER\n",
    );
    await writeFile(
      path.join(ignoredDirectory, "blocked.tmp"),
      "BLOCKED_GIT_MARKER\n",
    );

    const status = await getGitStatus(project);
    expect(status.untracked).toContain("root-keep.tmp");
    expect(status.untracked).toContain("ignored-dir/keep.tmp");
    expect(status.untracked).not.toContain("ignored-dir/blocked.tmp");

    const listing = await listFiles(project, { depth: 4 });
    expect(listing.entries.map((entry) => entry.path)).toContain(
      "ignored-dir/keep.tmp",
    );
    expect(listing.entries.map((entry) => entry.path)).not.toContain(
      "ignored-dir/blocked.tmp",
    );
    const search = await searchFiles(project, {
      query: "NESTED_KEEP_GIT_MARKER",
    });
    expect(search.results.map((result) => result.path)).toContain(
      "ignored-dir/keep.tmp",
    );
    await expect(
      readTextFile(project, "ignored-dir/keep.tmp"),
    ).resolves.toMatchObject({ text: "NESTED_KEEP_GIT_MARKER" });

    const diff = await getGitDiff(project, { mode: "working" });
    expect(diff.files).toContain("root-keep.tmp");
    expect(diff.files).toContain("ignored-dir/keep.tmp");
    expect(diff.files).not.toContain("ignored-dir/blocked.tmp");
    expect(diff.patch).toContain("ROOT_KEEP_GIT_MARKER");
    expect(diff.patch).toContain("NESTED_KEEP_GIT_MARKER");
    expect(diff.patch).not.toContain("BLOCKED_GIT_MARKER");

    git(project.root, ["add", "-f", "--", "ignored-dir/keep.tmp"]);
    git(project.root, ["commit", "-q", "-m", "keep nested exception"]);
    const revision = git(project.root, ["rev-parse", "HEAD"]).trim();
    await expect(
      getGitShow(project, { revision, path: "ignored-dir/keep.tmp" }),
    ).resolves.toMatchObject({ content: "NESTED_KEEP_GIT_MARKER\n" });
    await expect(
      getGitShow(project, { revision, path: "ignored-dir/blocked.tmp" }),
    ).rejects.toMatchObject({ code: "path_ignored" });
  });

  it("filters denied content from working diffs and commit/file show", async () => {
    const project = await makeGitProject();
    await writeFile(
      path.join(project.root, "safe.txt"),
      "changed safe content\n",
    );
    await writeFile(
      path.join(project.root, ".env"),
      "TOKEN=CHANGED_SECRET_MARKER\n",
    );
    await writeFile(
      path.join(project.root, "untracked.txt"),
      "new readable content\n",
    );

    const diff = await getGitDiff(project, { mode: "working" });
    expect(diff.patch).toContain("changed safe content");
    expect(diff.patch).toContain("new readable content");
    expect(diff.patch).not.toContain("CHANGED_SECRET_MARKER");
    expect(diff.files).not.toContain(".env");

    const revision = git(project.root, ["rev-parse", "HEAD"]).trim();
    const show = await getGitShow(project, { revision });
    expect(show).toHaveProperty("commit");
    expect(JSON.stringify(show)).not.toContain("INITIAL_SECRET_MARKER");
    await expect(
      getGitShow(project, { revision, path: ".env" }),
    ).rejects.toMatchObject({ code: "path_denied" });
    await expect(getGitLog(project, { limit: 5 })).resolves.toMatchObject({
      commits: [{ subject: "initial project state" }],
    });
  });

  it("includes staged and unstaged changes before the first commit", async () => {
    const root = await makeTempDirectory("ctxbridge-unborn-");
    temporary.push(root);
    git(root, ["init", "-q"]);
    git(root, ["config", "core.autocrlf", "false"]);
    await writeFile(path.join(root, "safe.txt"), "staged initial line\n");
    git(root, ["add", "--", "safe.txt"]);
    await writeFile(path.join(root, "safe.txt"), "unstaged replacement\n");
    await writeFile(path.join(root, "loose.txt"), "untracked line\n");

    const project = await projectAt(root);
    const branch = git(root, ["symbolic-ref", "--short", "HEAD"]).trim();
    const status = await getGitStatus(project);
    expect(status.branch).toBe(branch);
    expect(status.upstream).toBeNull();
    expect(status.ahead).toBeNull();
    expect(status.behind).toBeNull();
    await expect(getGitLog(project, {})).resolves.toEqual({
      commits: [],
      truncated: false,
    });

    const diff = await getGitDiff(project, { mode: "working" });
    expect(diff.patch).toContain("staged initial line");
    expect(diff.patch).toContain("unstaged replacement");
    expect(diff.patch).toContain("untracked line");
    expect(diff.files).toEqual(
      expect.arrayContaining(["safe.txt", "loose.txt"]),
    );
  });

  it("keeps untracked Git discovery bounded around excluded trees and scopes diffs first", async () => {
    const project = await makeGitProject();
    const dependencyTree = path.join(project.root, "node_modules", "fixture");
    await mkdir(dependencyTree, { recursive: true });
    await mkdir(path.join(project.root, "src"));
    await mkdir(path.join(project.root, "tests"));
    await writeFile(path.join(project.root, ".gitignore"), "node_modules/\n");
    await writeFile(
      path.join(project.root, ".env.local"),
      "DENIED_ENV_MARKER=never expose\n",
    );
    await writeFile(
      path.join(project.root, "src", "file.ts"),
      "VISIBLE_SOURCE_MARKER\n",
    );
    await writeFile(
      path.join(project.root, "tests", "file.test.ts"),
      "VISIBLE_TEST_MARKER\n",
    );
    for (let first = 0; first < 2050; first += 100) {
      await Promise.all(
        Array.from({ length: Math.min(100, 2050 - first) }, (_, offset) =>
          writeFile(
            path.join(
              dependencyTree,
              `dependency-${String(first + offset).padStart(4, "0")}.js`,
            ),
            "ignored dependency content\n",
          ),
        ),
      );
    }

    const status = await getGitStatus(project);
    expect(status.truncated).toBe(false);
    expect(status.untracked).toContain("src/file.ts");
    expect(status.untracked).toContain("tests/file.test.ts");
    expect(
      status.untracked.some((file) => file.startsWith("node_modules/")),
    ).toBe(false);
    expect(JSON.stringify(status)).not.toContain(".env.local");

    const sourceDiff = await getGitDiff(project, {
      mode: "working",
      path: "src",
    });
    expect(sourceDiff.files).toContain("src/file.ts");
    expect(sourceDiff.files).not.toContain("tests/file.test.ts");
    expect(sourceDiff.patch).toContain("VISIBLE_SOURCE_MARKER");
    expect(sourceDiff.truncated).toBe(false);

    const testsDiff = await getGitDiff(project, {
      mode: "working",
      path: "tests",
    });
    expect(testsDiff.files).toContain("tests/file.test.ts");
    expect(testsDiff.files).not.toContain("src/file.ts");
    expect(testsDiff.patch).toContain("VISIBLE_TEST_MARKER");
    expect(testsDiff.truncated).toBe(false);

    const allChanges = await getGitDiff(project, { mode: "working" });
    expect(allChanges.files).toEqual(
      expect.arrayContaining(["src/file.ts", "tests/file.test.ts"]),
    );
    expect(allChanges.patch).not.toContain("DENIED_ENV_MARKER");
    expect(allChanges.files).not.toContain(".env.local");
    const tiny = await getGitDiff(project, { mode: "working", maxBytes: 1 });
    expect(tiny.truncated).toBe(true);
    expect(Buffer.byteLength(tiny.patch, "utf8")).toBeLessThanOrEqual(1);
  });

  it("reports truncation when eligible untracked files exceed the status work and result bounds", async () => {
    const project = await makeGitProject();
    const crowdedDirectory = path.join(project.root, "many-files");
    await mkdir(crowdedDirectory);
    for (let first = 0; first < 2050; first += 100) {
      await Promise.all(
        Array.from({ length: Math.min(100, 2050 - first) }, (_, offset) =>
          writeFile(
            path.join(
              crowdedDirectory,
              `file-${String(first + offset).padStart(4, "0")}.txt`,
            ),
            "eligible untracked file\n",
          ),
        ),
      );
    }

    const status = await getGitStatus(project);
    expect(status.truncated).toBe(true);
    expect(status.untracked).toHaveLength(2000);
    expect(
      status.untracked.every((file) => file.startsWith("many-files/")),
    ).toBe(true);
  });

  it("scopes all Git operations to a registered nested project root", async () => {
    const { project, repositoryRoot } = await makeNestedGitProject();
    const baseRevision = git(repositoryRoot, ["rev-parse", "HEAD"]).trim();

    await writeFile(
      path.join(repositoryRoot, "sibling-secret.txt"),
      "SIBLING_COMMIT_SECRET_MARKER\n",
    );
    git(repositoryRoot, ["add", "--", "sibling-secret.txt"]);
    git(repositoryRoot, ["commit", "-q", "-m", "outside-only update"]);
    const siblingRevision = git(repositoryRoot, ["rev-parse", "HEAD"]).trim();

    await expect(isGitRepository(project)).resolves.toBe(true);
    const log = await getGitLog(project, { limit: 20 });
    expect(log.commits.map((commit) => commit.revision)).not.toContain(
      siblingRevision,
    );
    await expect(
      getGitLog(project, { limit: 20, path: "sibling-secret.txt" }),
    ).resolves.toMatchObject({ commits: [] });

    const siblingShow = await getGitShow(project, {
      revision: siblingRevision,
    });
    expect(siblingShow).toMatchObject({ files: [], patch: "" });
    expect(JSON.stringify(siblingShow)).not.toContain("sibling-secret.txt");
    expect(JSON.stringify(siblingShow)).not.toContain(
      "SIBLING_COMMIT_SECRET_MARKER",
    );
    await expect(
      getGitShow(project, {
        revision: siblingRevision,
        path: "sibling-secret.txt",
      }),
    ).rejects.toBeDefined();
    await expect(
      getGitDiff(project, {
        mode: "refs",
        base: baseRevision,
        head: siblingRevision,
      }),
    ).resolves.toMatchObject({ files: [], patch: "" });

    await writeFile(
      path.join(project.root, "safe.txt"),
      "STAGED_ALLOWED_MARKER\n",
    );
    await writeFile(
      path.join(repositoryRoot, "sibling-secret.txt"),
      "STAGED_OUTSIDE_SECRET_MARKER\n",
    );
    git(repositoryRoot, [
      "add",
      "--",
      "allowed/safe.txt",
      "sibling-secret.txt",
    ]);
    await writeFile(
      path.join(project.root, "safe.txt"),
      "UNSTAGED_ALLOWED_MARKER\n",
    );
    await writeFile(
      path.join(repositoryRoot, "sibling-secret.txt"),
      "UNSTAGED_OUTSIDE_SECRET_MARKER\n",
    );
    await writeFile(
      path.join(project.root, "untracked.txt"),
      "ALLOWED_UNTRACKED_MARKER\n",
    );
    await writeFile(
      path.join(repositoryRoot, "sibling-untracked.txt"),
      "OUTSIDE_UNTRACKED_MARKER\n",
    );

    const status = await getGitStatus(project);
    expect(status.staged).toContain("safe.txt");
    expect(status.modified).toContain("safe.txt");
    expect(status.untracked).toContain("untracked.txt");
    expect(JSON.stringify(status)).not.toContain("sibling-");

    const staged = await getGitDiff(project, { mode: "staged" });
    expect(staged.files).toEqual(["safe.txt"]);
    expect(staged.patch).toContain("STAGED_ALLOWED_MARKER");
    expect(staged.patch).not.toContain("STAGED_OUTSIDE_SECRET_MARKER");

    const unstaged = await getGitDiff(project, { mode: "unstaged" });
    expect(unstaged.files).toEqual(["safe.txt"]);
    expect(unstaged.patch).toContain("UNSTAGED_ALLOWED_MARKER");
    expect(unstaged.patch).not.toContain("UNSTAGED_OUTSIDE_SECRET_MARKER");

    const working = await getGitDiff(project, { mode: "working" });
    expect(working.files).toEqual(
      expect.arrayContaining(["safe.txt", "untracked.txt"]),
    );
    expect(working.patch).toContain("UNSTAGED_ALLOWED_MARKER");
    expect(working.patch).toContain("ALLOWED_UNTRACKED_MARKER");
    expect(working.patch).not.toContain("OUTSIDE");
    expect(working.patch).not.toContain("sibling-");

    git(repositoryRoot, [
      "mv",
      "sibling-secret.txt",
      "allowed/moved-from-sibling.txt",
    ]);
    const crossBoundaryRename = await getGitDiff(project, { mode: "working" });
    expect(crossBoundaryRename.files).toContain("moved-from-sibling.txt");
    expect(JSON.stringify(crossBoundaryRename)).not.toContain(
      "sibling-secret.txt",
    );
  });

  it("rejects a registered root whose Git pointer resolves to another worktree", async () => {
    const outsideRepository = await makeTempDirectory(
      "ctxbridge-external-git-",
    );
    const registeredRoot = await makeTempDirectory("ctxbridge-pointer-root-");
    temporary.push(outsideRepository, registeredRoot);
    git(outsideRepository, ["init", "-q"]);
    git(outsideRepository, ["config", "user.name", "Context Bridge Tests"]);
    git(outsideRepository, [
      "config",
      "user.email",
      "ctxbridge-tests@example.invalid",
    ]);
    await writeFile(
      path.join(outsideRepository, "outside.txt"),
      "OUTSIDE_POINTER_MARKER\n",
    );
    git(outsideRepository, ["add", "--", "outside.txt"]);
    git(outsideRepository, ["commit", "-q", "-m", "external worktree"]);
    const revision = git(outsideRepository, ["rev-parse", "HEAD"]).trim();
    await writeFile(
      path.join(registeredRoot, ".git"),
      `gitdir: ${path.join(outsideRepository, ".git").replace(/\\/g, "/")}\n`,
    );
    const project = await projectAt(registeredRoot);

    await expect(isGitRepository(project)).resolves.toBe(false);
    await expect(getGitShow(project, { revision })).rejects.toMatchObject({
      code: "git_scope_error",
    });
  });

  it("rejects alternate data stream syntax in Git path arguments on Windows", async (context) => {
    if (process.platform !== "win32") {
      context.skip();
      return;
    }
    const project = await makeGitProject();
    const revision = git(project.root, ["rev-parse", "HEAD"]).trim();

    await expect(
      getGitDiff(project, { mode: "working", path: "safe.txt:stream" }),
    ).rejects.toMatchObject({ code: "invalid_path" });
    await expect(
      getGitLog(project, { limit: 5, path: "safe.txt:stream" }),
    ).rejects.toMatchObject({ code: "invalid_path" });
    await expect(
      getGitShow(project, { revision, path: "safe.txt:stream" }),
    ).rejects.toMatchObject({ code: "invalid_path" });
  });

  it("bounds large diffs and validates revisions without executing shell text", async () => {
    const project = await makeGitProject();
    await writeFile(
      path.join(project.root, "safe.txt"),
      `${"large diff line\n".repeat(50_000)}`,
    );
    const diff = await getGitDiff(project, { mode: "working", maxBytes: 1024 });
    expect(Buffer.byteLength(diff.patch, "utf8")).toBeLessThanOrEqual(1024);
    expect(diff.truncated).toBe(true);

    const marker = path.join(
      os.tmpdir(),
      `ctxbridge-injection-${Date.now()}.txt`,
    );
    temporary.push(marker);
    const unsafe = `HEAD; ${process.platform === "win32" ? "type nul >" : "touch"} ${marker}`;
    await expect(
      getGitShow(project, { revision: unsafe }),
    ).rejects.toBeInstanceOf(ContextBridgeError);
    expect(existsSync(marker)).toBe(false);
  });

  it("keeps Git show and diff truncation on UTF-8 boundaries", async () => {
    const project = await makeGitProject();
    const content = "Aé漢😀Z";
    const pathName = "unicode.txt";
    await writeFile(path.join(project.root, pathName), content);
    git(project.root, ["add", "--", pathName]);
    git(project.root, ["commit", "-q", "-m", "add unicode fixture"]);
    const revision = git(project.root, ["rev-parse", "HEAD"]).trim();
    const expectedPrefix = (maxBytes: number) => {
      let result = "";
      for (const character of content) {
        if (Buffer.byteLength(result + character, "utf8") > maxBytes) break;
        result += character;
      }
      return result;
    };

    for (
      let maxBytes = 1;
      maxBytes <= Buffer.byteLength(content, "utf8");
      maxBytes += 1
    ) {
      const shown = await getGitShow(project, {
        revision,
        path: pathName,
        maxBytes,
      });
      expect("content" in shown ? shown.content : "").toBe(
        expectedPrefix(maxBytes),
      );
      expect(JSON.stringify(shown)).not.toContain("\uFFFD");
      if ("content" in shown)
        expect(Buffer.byteLength(shown.content, "utf8")).toBeLessThanOrEqual(
          maxBytes,
        );
    }

    await writeFile(path.join(project.root, pathName), `changed ${content}\n`);
    const complete = await getGitDiff(project, {
      mode: "working",
      maxBytes: 1024 * 1024,
    });
    const emojiPosition = complete.patch.indexOf("😀");
    expect(emojiPosition).toBeGreaterThanOrEqual(0);
    const bytesBeforeEmoji = Buffer.byteLength(
      complete.patch.slice(0, emojiPosition),
      "utf8",
    );
    for (
      let insideEmoji = 1;
      insideEmoji < Buffer.byteLength("😀", "utf8");
      insideEmoji += 1
    ) {
      const limited = await getGitDiff(project, {
        mode: "working",
        maxBytes: bytesBeforeEmoji + insideEmoji,
      });
      expect(limited.patch).not.toContain("\uFFFD");
      expect(Buffer.byteLength(limited.patch, "utf8")).toBeLessThanOrEqual(
        bytesBeforeEmoji + insideEmoji,
      );
    }

    git(project.root, ["checkout", "--", pathName]);
    const untrackedPath = "untracked-unicode.txt";
    await writeFile(
      path.join(project.root, untrackedPath),
      `untracked ${content}\n`,
    );
    const completeUntracked = await getGitDiff(project, {
      mode: "working",
      maxBytes: 1024 * 1024,
    });
    const untrackedEmojiPosition = completeUntracked.patch.indexOf("😀");
    expect(untrackedEmojiPosition).toBeGreaterThanOrEqual(0);
    const bytesBeforeUntrackedEmoji = Buffer.byteLength(
      completeUntracked.patch.slice(0, untrackedEmojiPosition),
      "utf8",
    );
    for (
      let insideEmoji = 1;
      insideEmoji < Buffer.byteLength("😀", "utf8");
      insideEmoji += 1
    ) {
      const limited = await getGitDiff(project, {
        mode: "working",
        maxBytes: bytesBeforeUntrackedEmoji + insideEmoji,
      });
      expect(limited.patch).not.toContain("\uFFFD");
      expect(Buffer.byteLength(limited.patch, "utf8")).toBeLessThanOrEqual(
        bytesBeforeUntrackedEmoji + insideEmoji,
      );
    }
  });

  it("does not run configured Git filters", async () => {
    const project = await makeGitProject();
    const marker = path.join(
      path.dirname(project.root),
      `ctxbridge-filter-${Date.now()}.txt`,
    );
    temporary.push(marker);
    await writeFile(
      path.join(project.root, ".gitattributes"),
      "*.txt filter=probe\n",
    );
    git(project.root, ["add", "--", ".gitattributes"]);
    git(project.root, ["commit", "-q", "-m", "add filter attributes"]);
    const escapedMarker = marker.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
    const command =
      process.platform === "win32"
        ? `node -e "require('fs').writeFileSync('${escapedMarker}', 'ran')"`
        : `node -e "require('fs').writeFileSync('${escapedMarker}', 'ran')"`;
    git(project.root, ["config", "--local", "filter.probe.clean", command]);
    git(project.root, ["config", "--local", "filter.probe.smudge", command]);
    await writeFile(
      path.join(project.root, "safe.txt"),
      "changed with filter attribute\n",
    );
    await getGitDiff(project, { mode: "working" });
    expect(existsSync(marker)).toBe(false);
  });

  it("does not fetch promised Git objects or invoke credential helpers", async (context) => {
    const project = await makeGitProject();
    const tempParent = await makeTempDirectory("ctxbridge-promisor-");
    temporary.push(tempParent);
    const remoteRoot = path.join(tempParent, "remote.git");
    const cloneRoot = path.join(tempParent, "partial-clone");
    const testEnvironment = {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
      GIT_AUTHOR_NAME: "Context Bridge Tests",
      GIT_AUTHOR_EMAIL: "ctxbridge-tests@example.invalid",
      GIT_COMMITTER_NAME: "Context Bridge Tests",
      GIT_COMMITTER_EMAIL: "ctxbridge-tests@example.invalid",
    };
    try {
      execFileSync("git", ["clone", "--bare", project.root, remoteRoot], {
        env: testEnvironment,
        stdio: "ignore",
        windowsHide: true,
      });
      git(remoteRoot, ["config", "uploadpack.allowFilter", "true"]);
      execFileSync(
        "git",
        [
          "-c",
          "protocol.file.allow=always",
          "clone",
          "--filter=blob:none",
          "--no-checkout",
          pathToFileURL(remoteRoot).href,
          cloneRoot,
        ],
        { env: testEnvironment, stdio: "ignore", windowsHide: true },
      );
    } catch {
      context.skip();
      return;
    }

    const revision = git(cloneRoot, ["rev-parse", "HEAD"]).trim();
    expect(
      git(cloneRoot, [
        "config",
        "--local",
        "--get",
        "remote.origin.promisor",
      ]).trim(),
    ).toBe("true");
    expect(() =>
      execFileSync(
        "git",
        ["-C", cloneRoot, "cat-file", "-e", `${revision}:safe.txt`],
        {
          env: {
            ...testEnvironment,
            GIT_NO_LAZY_FETCH: "1",
            GIT_ALLOW_PROTOCOL: "",
          },
          stdio: "ignore",
          windowsHide: true,
        },
      ),
    ).toThrow();

    let requestCount = 0;
    const server = createServer((_request, response) => {
      requestCount += 1;
      response.writeHead(401, { "www-authenticate": 'Basic realm="test"' });
      response.end();
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      throw new Error("Could not bind the local test server.");
    }
    try {
      git(cloneRoot, [
        "config",
        "--local",
        "remote.origin.url",
        `http://127.0.0.1:${address.port}/repo.git`,
      ]);
      git(cloneRoot, [
        "config",
        "--local",
        "credential.helper",
        "!node -e \"require('node:fs').writeFileSync('credential-helper-ran', 'yes')\"",
      ]);
      const packDirectory = path.join(cloneRoot, ".git", "objects", "pack");
      const packInventory = async () => {
        const names = (await readdir(packDirectory)).sort();
        return await Promise.all(
          names.map(
            async (name) =>
              [
                name,
                (await stat(path.join(packDirectory, name))).size,
              ] as const,
          ),
        );
      };
      const before = await packInventory();

      await expect(
        getGitShow(await projectAt(cloneRoot), { revision, path: "safe.txt" }),
      ).rejects.toMatchObject({ code: "git_error" });

      expect(requestCount).toBe(0);
      expect(existsSync(path.join(cloneRoot, "credential-helper-ran"))).toBe(
        false,
      );
      expect(await packInventory()).toEqual(before);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("handles non-Git projects and missing roots", async () => {
    const root = await makeTempDirectory("ctxbridge-not-git-");
    temporary.push(root);
    const project = await projectAt(root);
    await expect(isGitRepository(project)).resolves.toBe(false);
    await expect(getGitStatus(project)).rejects.toMatchObject({
      code: "git_error",
    });

    const missing = await projectAt(path.join(root, "missing"));
    await expect(getGitStatus(missing)).rejects.toBeDefined();
  });
});
