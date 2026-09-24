import { lstat, opendir, realpath, stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import picomatch from "picomatch";
import type { ProjectRecord } from "../projects/registry.js";
import { ContextBridgeError } from "../security/errors.js";
import {
  isHiddenPath,
  isProjectPathVisible,
  resolveProjectPath,
  type ResolvedPath,
} from "../security/paths.js";
import { clampOutputBytes, readSearchText } from "./read.js";

export interface ListedEntry {
  path: string;
  type: "file" | "directory";
  size: number | null;
}

export interface SearchMatch {
  line: number;
  text: string;
  context: Array<{ line: number; text: string }>;
}

export interface SearchHit {
  path: string;
  matches: SearchMatch[];
}

const DEFAULT_MAX_ENTRIES = 200;
const MAX_ENTRIES = 1000;
const MAX_SEARCH_RESULTS = 1000;
const MAX_SEARCH_SCAN_BYTES = 32 * 1024 * 1024;
const MAX_SCANNED_DIRECTORY_ENTRIES = 2048;
const MAX_SEARCH_FILES = 2048;
const MAX_SEARCH_DEPTH = 64;
const RG_OUTPUT_LIMIT = 8 * 1024 * 1024;
const SKIPPABLE_PATH_ERRORS = new Set([
  "path_denied",
  "path_ignored",
  "symlink_escape",
  "path_escape",
  "absolute_path",
  "path_missing",
]);

function isSkippablePathError(error: unknown): boolean {
  return (
    error instanceof ContextBridgeError && SKIPPABLE_PATH_ERRORS.has(error.code)
  );
}

interface WalkPath {
  resolved: ResolvedPath;
  visible: boolean;
}

async function resolveWalkBase(
  project: ProjectRecord,
  supplied: string | undefined,
): Promise<WalkPath> {
  try {
    return {
      resolved: await resolveProjectPath(project, supplied, {
        isDirectory: true,
      }),
      visible: true,
    };
  } catch (error) {
    if (!(error instanceof ContextBridgeError) || error.code !== "path_ignored")
      throw error;
    const resolved = await resolveProjectPath(project, supplied, {
      isDirectory: true,
      skipIgnoreRules: true,
    });
    const details = await stat(resolved.absolutePath);
    if (!details.isDirectory()) throw error;
    return { resolved, visible: false };
  }
}

async function resolveWalkCandidate(
  project: ProjectRecord,
  relativePath: string,
  isDirectory: boolean,
): Promise<WalkPath | undefined> {
  try {
    return {
      resolved: await resolveProjectPath(project, relativePath, {
        isDirectory,
      }),
      visible: true,
    };
  } catch (error) {
    if (
      error instanceof ContextBridgeError &&
      error.code === "path_ignored" &&
      isDirectory
    ) {
      try {
        return {
          resolved: await resolveProjectPath(project, relativePath, {
            isDirectory: true,
            skipIgnoreRules: true,
          }),
          visible: false,
        };
      } catch (fallbackError) {
        if (isSkippablePathError(fallbackError)) return undefined;
        throw fallbackError;
      }
    }
    if (isSkippablePathError(error)) return undefined;
    throw error;
  }
}

function validateRange(
  value: number,
  name: string,
  min: number,
  max: number,
): number {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new ContextBridgeError(
      "invalid_limit",
      `${name} must be between ${min} and ${max}.`,
    );
  }
  return value;
}

export async function listFiles(
  project: ProjectRecord,
  options: {
    path?: string;
    depth?: number;
    maxEntries?: number;
    includeHidden?: boolean;
  } = {},
): Promise<{ entries: ListedEntry[]; truncated: boolean }> {
  const depth = validateRange(options.depth ?? 1, "depth", 1, 8);
  const maxEntries = validateRange(
    options.maxEntries ?? DEFAULT_MAX_ENTRIES,
    "max_entries",
    1,
    MAX_ENTRIES,
  );
  const baseWalkPath = await resolveWalkBase(project, options.path);
  const base = baseWalkPath.resolved;
  const baseInfo = await stat(base.absolutePath);
  if (!baseInfo.isDirectory())
    throw new ContextBridgeError(
      "not_a_directory",
      "The requested path is not a directory.",
    );
  const entries: ListedEntry[] = [];
  const seenDirectories = new Set<string>([await realpath(base.absolutePath)]);
  let truncated = false;
  let resultBytes = 0;
  let scannedEntries = 0;

  const visit = async (
    directory: string,
    relativeDirectory: string,
    currentDepth: number,
  ): Promise<void> => {
    if (currentDepth > depth || truncated) return;
    let children;
    try {
      children = await opendir(directory);
    } catch {
      return;
    }
    for await (const child of children) {
      scannedEntries += 1;
      if (scannedEntries > MAX_SCANNED_DIRECTORY_ENTRIES) {
        truncated = true;
        return;
      }
      const relative = relativeDirectory
        ? `${relativeDirectory}/${child.name}`
        : child.name;
      if (!options.includeHidden && isHiddenPath(relative)) continue;
      const candidate = await resolveWalkCandidate(
        project,
        relative,
        child.isDirectory() || child.isSymbolicLink(),
      );
      if (!candidate) continue;
      const { resolved } = candidate;
      let details;
      try {
        details = await stat(resolved.absolutePath);
      } catch {
        continue;
      }
      const type = details.isDirectory()
        ? "directory"
        : details.isFile()
          ? "file"
          : undefined;
      if (!type || (!candidate.visible && type !== "directory")) continue;
      if (candidate.visible) {
        if (entries.length >= maxEntries) {
          truncated = true;
          return;
        }
        const entry: ListedEntry = {
          path: relative,
          type,
          size: type === "file" ? details.size : null,
        };
        const entryBytes = Buffer.byteLength(JSON.stringify(entry), "utf8");
        if (resultBytes + entryBytes > 256 * 1024) {
          truncated = true;
          return;
        }
        entries.push(entry);
        resultBytes += entryBytes;
      }
      if (type !== "directory" || currentDepth >= depth) continue;
      if (child.isSymbolicLink()) {
        const canonical = await realpath(resolved.absolutePath);
        if (seenDirectories.has(canonical)) continue;
        seenDirectories.add(canonical);
      }
      await visit(resolved.absolutePath, relative, currentDepth + 1);
      if (truncated) return;
    }
  };

  await visit(base.absolutePath, base.relativePath, 1);
  return { entries, truncated };
}

async function collectFiles(
  project: ProjectRecord,
  startPath: string,
  globMatcher: ((value: string) => boolean) | undefined,
  options: { includeHidden?: boolean } = {},
): Promise<{ files: string[]; truncated: boolean }> {
  const baseWalkPath = await resolveWalkBase(project, startPath);
  const base = baseWalkPath.resolved;
  const details = await stat(base.absolutePath);
  if (details.isFile())
    return {
      files:
        baseWalkPath.visible && (!globMatcher || globMatcher(base.relativePath))
          ? [base.relativePath]
          : [],
      truncated: false,
    };
  if (!details.isDirectory())
    throw new ContextBridgeError(
      "not_searchable",
      "The requested path is not searchable.",
    );
  const files: string[] = [];
  const seenDirectories = new Set<string>([await realpath(base.absolutePath)]);
  let scannedEntries = 0;
  let truncated = false;
  const visit = async (
    directory: string,
    relativeDirectory: string,
    depth: number,
  ): Promise<void> => {
    if (files.length >= MAX_SEARCH_FILES) {
      truncated = true;
      return;
    }
    if (depth > MAX_SEARCH_DEPTH) {
      truncated = true;
      return;
    }
    let children;
    try {
      children = await opendir(directory);
    } catch {
      return;
    }
    for await (const child of children) {
      scannedEntries += 1;
      if (scannedEntries > MAX_SCANNED_DIRECTORY_ENTRIES) {
        truncated = true;
        return;
      }
      if (files.length >= MAX_SEARCH_FILES) {
        truncated = true;
        return;
      }
      const relative = relativeDirectory
        ? `${relativeDirectory}/${child.name}`
        : child.name;
      if (!options.includeHidden && isHiddenPath(relative)) continue;
      const walkPath = await resolveWalkCandidate(
        project,
        relative,
        child.isDirectory() || child.isSymbolicLink(),
      );
      if (!walkPath) continue;
      const { resolved: candidate } = walkPath;
      let childInfo;
      try {
        childInfo = await stat(candidate.absolutePath);
      } catch {
        continue;
      }
      if (childInfo.isDirectory()) {
        if (child.isSymbolicLink()) {
          const canonical = await realpath(candidate.absolutePath);
          if (seenDirectories.has(canonical)) continue;
          seenDirectories.add(canonical);
        }
        await visit(candidate.absolutePath, relative, depth + 1);
        if (truncated) return;
      } else if (
        walkPath.visible &&
        childInfo.isFile() &&
        (!globMatcher || globMatcher(relative))
      ) {
        files.push(relative);
        if (files.length >= MAX_SEARCH_FILES) {
          truncated = true;
          return;
        }
      }
    }
  };
  await visit(base.absolutePath, base.relativePath, 1);
  return { files, truncated };
}

/**
 * Collect bounded, policy-eligible files for Git's untracked-file checks.
 * Git status includes dotfiles, so this walk includes hidden paths while the
 * shared resolver still excludes sensitive and permanently excluded paths.
 */
export async function collectProjectFiles(
  project: ProjectRecord,
  startPath = ".",
): Promise<{ files: string[]; truncated: boolean }> {
  return await collectFiles(project, startPath, undefined, {
    includeHidden: true,
  });
}

function contextFor(
  lines: string[],
  lineIndex: number,
  contextLines: number,
): Array<{ line: number; text: string }> {
  const start = Math.max(0, lineIndex - contextLines);
  const end = Math.min(lines.length, lineIndex + contextLines + 1);
  const context: Array<{ line: number; text: string }> = [];
  for (let index = start; index < end; index += 1) {
    if (index !== lineIndex)
      context.push({ line: index + 1, text: lines[index] ?? "" });
  }
  return context;
}

const REGEX_WORKER_SOURCE = `
  const { parentPort, workerData } = require("node:worker_threads");
  try {
    const expression = new RegExp(workerData.query, "g");
    const matches = [];
    for (let fileIndex = 0; fileIndex < workerData.files.length; fileIndex += 1) {
      const lines = workerData.files[fileIndex].lines;
      for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
        expression.lastIndex = 0;
        if (expression.test(lines[lineIndex])) {
          matches.push({ fileIndex, lineIndex });
          if (matches.length >= workerData.maxResults) break;
        }
      }
      if (matches.length >= workerData.maxResults) break;
    }
    parentPort.postMessage({ matches });
  } catch (error) {
    parentPort.postMessage({ error: String(error) });
  }
`;

async function regexMatches(
  query: string,
  files: Array<{ path: string; lines: string[] }>,
  maxResults: number,
): Promise<Array<{ fileIndex: number; lineIndex: number }>> {
  try {
    new RegExp(query);
  } catch {
    throw new ContextBridgeError(
      "invalid_regex",
      "The regular expression is invalid.",
    );
  }
  const { Worker } = await import("node:worker_threads");
  return await new Promise((resolve, reject) => {
    const worker = new Worker(REGEX_WORKER_SOURCE, {
      eval: true,
      workerData: { query, files, maxResults },
    });
    const timeout = setTimeout(() => {
      void worker.terminate();
      reject(
        new ContextBridgeError(
          "regex_timeout",
          "Regex search exceeded its time limit.",
        ),
      );
    }, 2000);
    worker.once(
      "message",
      (message: {
        matches?: Array<{ fileIndex: number; lineIndex: number }>;
        error?: string;
      }) => {
        clearTimeout(timeout);
        if (message.error)
          reject(new ContextBridgeError("invalid_regex", message.error));
        else resolve(message.matches ?? []);
      },
    );
    worker.once("error", (error: Error) => {
      clearTimeout(timeout);
      reject(error);
    });
    worker.once("exit", (code: number) => {
      clearTimeout(timeout);
      if (code !== 0)
        reject(
          new ContextBridgeError(
            "regex_worker_failed",
            "Regex search could not be completed.",
          ),
        );
    });
  });
}

interface RipgrepResult {
  results: SearchHit[];
  truncated: boolean;
}

function safeSearchEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "SystemRoot", "WINDIR", "TEMP", "TMP"]) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

async function searchWithRipgrep(
  project: ProjectRecord,
  options: {
    query: string;
    path: string;
    glob?: string;
    mode: "literal" | "regex";
    contextLines: number;
    maxResults: number;
    maxBytes: number;
  },
): Promise<RipgrepResult | undefined> {
  const base = await resolveProjectPath(project, options.path, {
    isDirectory: true,
  });
  const args = [
    "--json",
    "--no-ignore",
    "--color=never",
    "--context",
    String(options.contextLines),
    "--max-count",
    String(options.maxResults),
    "--max-columns",
    "16384",
    "--max-columns-preview",
    "--max-filesize",
    "1M",
    "--glob",
    "!.git/**",
    "--glob",
    "!**/.git/**",
    "--glob",
    "!node_modules/**",
    "--glob",
    "!**/node_modules/**",
    "--glob",
    "!.pnpm-store/**",
    "--glob",
    "!**/.pnpm-store/**",
  ];
  if (options.mode === "literal") args.push("--fixed-strings");
  if (options.glob) args.push("--glob", options.glob);
  args.push("--", options.query, base.absolutePath);

  const started = await new Promise<boolean>((resolve) => {
    const child = spawn("rg", ["--version"], {
      cwd: project.root,
      env: safeSearchEnvironment(),
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "ignore", "ignore"],
    });
    child.once("error", () => resolve(false));
    child.once("close", (code) => resolve(code === 0));
  });
  if (!started) return undefined;

  const result = await new Promise<{
    code: number | null;
    output: Buffer;
    truncated: boolean;
  }>((resolve, reject) => {
    const child = spawn("rg", args, {
      cwd: project.root,
      env: safeSearchEnvironment(),
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let hitLimit = false;
    const timeout = setTimeout(() => {
      hitLimit = true;
      child.kill("SIGTERM");
    }, 15_000);
    child.stdout.on("data", (chunk: Buffer) => {
      const remaining = RG_OUTPUT_LIMIT - bytes;
      if (remaining > 0) {
        const kept = chunk.subarray(0, remaining);
        chunks.push(kept);
        bytes += kept.length;
      }
      if (chunk.length > remaining) {
        hitLimit = true;
        child.kill("SIGTERM");
      }
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        resolve({ code: null, output: Buffer.alloc(0), truncated: false });
      else reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      resolve({ code, output: Buffer.concat(chunks), truncated: hitLimit });
    });
  });
  if (
    result.code === null ||
    (result.code !== 0 && result.code !== 1 && !result.truncated)
  )
    return undefined;
  let truncated = result.truncated;

  const files = new Map<
    string,
    { lines: Map<number, string>; matches: Set<number> }
  >();
  let matchCount = 0;
  for (const rawLine of result.output.toString("utf8").split(/\r?\n/)) {
    if (!rawLine) continue;
    let event: {
      type?: string;
      data?: {
        path?: { text?: string };
        lines?: { text?: string };
        line_number?: number;
      };
    };
    try {
      event = JSON.parse(rawLine) as typeof event;
    } catch {
      truncated = true;
      continue;
    }
    if (
      (event.type !== "match" && event.type !== "context") ||
      !event.data?.path?.text ||
      !event.data.lines?.text
    )
      continue;
    const pathText = event.data.path.text;
    const absolute = path.isAbsolute(pathText)
      ? pathText
      : path.resolve(project.root, pathText);
    const relative = path
      .relative(project.root, absolute)
      .split(path.sep)
      .join("/");
    if (
      !relative ||
      relative.startsWith("../") ||
      path.isAbsolute(relative) ||
      isHiddenPath(relative)
    )
      continue;
    if (!(await isProjectPathVisible(project, relative))) continue;
    const lineNumber = event.data.line_number;
    if (!lineNumber || lineNumber < 1) continue;
    let file = files.get(relative);
    if (!file) {
      file = { lines: new Map<number, string>(), matches: new Set<number>() };
      files.set(relative, file);
    }
    const lineText = event.data.lines.text.replace(/\r?\n$/, "");
    file.lines.set(lineNumber, lineText);
    if (event.type === "match") {
      if (matchCount >= options.maxResults) {
        truncated = true;
        continue;
      }
      file.matches.add(lineNumber);
      matchCount += 1;
    }
  }

  const results: SearchHit[] = [];
  let outputBytes = 0;
  for (const [relative, file] of files) {
    const matches: SearchMatch[] = [];
    for (const line of [...file.matches].sort((a, b) => a - b)) {
      const context: Array<{ line: number; text: string }> = [];
      for (const [contextLine, text] of file.lines) {
        if (
          contextLine !== line &&
          Math.abs(contextLine - line) <= options.contextLines
        )
          context.push({ line: contextLine, text });
      }
      context.sort((a, b) => a.line - b.line);
      matches.push({ line, text: file.lines.get(line) ?? "", context });
    }
    if (!matches.length) continue;
    const result = { path: relative, matches };
    const bytes = Buffer.byteLength(JSON.stringify(result), "utf8");
    if (outputBytes + bytes > options.maxBytes) {
      truncated = true;
      break;
    }
    outputBytes += bytes;
    results.push(result);
  }
  return { results, truncated };
}

export async function searchFiles(
  project: ProjectRecord,
  options: {
    query: string;
    path?: string;
    glob?: string;
    mode?: "literal" | "regex";
    contextLines?: number;
    maxResults?: number;
    maxBytes?: number;
  },
): Promise<{ results: SearchHit[]; truncated: boolean }> {
  if (
    options.query.length < 1 ||
    options.query.length > 256 ||
    options.query.includes("\0")
  ) {
    throw new ContextBridgeError(
      "invalid_query",
      "query must contain between 1 and 256 characters.",
    );
  }
  const contextLines = validateRange(
    options.contextLines ?? 0,
    "context_lines",
    0,
    10,
  );
  const maxResults = validateRange(
    options.maxResults ?? 100,
    "max_results",
    1,
    MAX_SEARCH_RESULTS,
  );
  const maxBytes = clampOutputBytes(options.maxBytes);
  let matcher: ((value: string) => boolean) | undefined;
  if (options.glob) {
    if (options.glob.length > 256 || options.glob.includes("\0"))
      throw new ContextBridgeError(
        "invalid_glob",
        "glob must be at most 256 characters.",
      );
    try {
      matcher = picomatch(options.glob, { dot: false });
    } catch {
      throw new ContextBridgeError(
        "invalid_glob",
        "The glob pattern is invalid.",
      );
    }
  }
  const requestedWalkPath = await resolveWalkBase(project, options.path ?? ".");
  const requestedPath = requestedWalkPath.resolved;
  const requestedDetails = await stat(requestedPath.absolutePath);
  if (
    requestedWalkPath.visible &&
    requestedDetails.isFile() &&
    (!matcher || matcher(requestedPath.relativePath))
  ) {
    const ripgrep = await searchWithRipgrep(project, {
      query: options.query,
      path: requestedPath.relativePath,
      ...(options.glob === undefined ? {} : { glob: options.glob }),
      mode: options.mode ?? "literal",
      contextLines,
      maxResults,
      maxBytes,
    });
    if (ripgrep) return ripgrep;
  }
  const collected = await collectFiles(project, options.path ?? ".", matcher);
  const files = collected.files;
  const loaded: Array<{ path: string; lines: string[]; truncated: boolean }> =
    [];
  let scannedBytes = 0;
  let truncated = collected.truncated;
  for (const file of files) {
    if (scannedBytes >= MAX_SEARCH_SCAN_BYTES) {
      truncated = true;
      break;
    }
    const content = await readSearchText(
      project,
      file,
      Math.min(1024 * 1024, MAX_SEARCH_SCAN_BYTES - scannedBytes),
    );
    const byteLength = Buffer.byteLength(content.lines.join("\n"), "utf8");
    scannedBytes += byteLength;
    if (content.truncated) truncated = true;
    loaded.push({
      path: file,
      lines: content.lines,
      truncated: content.truncated,
    });
  }

  let matched: Array<{ fileIndex: number; lineIndex: number }> = [];
  if ((options.mode ?? "literal") === "regex") {
    matched = await regexMatches(options.query, loaded, maxResults);
  } else {
    for (let fileIndex = 0; fileIndex < loaded.length; fileIndex += 1) {
      const file = loaded[fileIndex];
      if (!file) continue;
      for (let lineIndex = 0; lineIndex < file.lines.length; lineIndex += 1) {
        if (file.lines[lineIndex]?.includes(options.query)) {
          matched.push({ fileIndex, lineIndex });
          if (matched.length >= maxResults) break;
        }
      }
      if (matched.length >= maxResults) break;
    }
  }

  const resultsByPath = new Map<string, SearchHit>();
  for (const item of matched) {
    const file = loaded[item.fileIndex];
    if (!file) continue;
    let hit = resultsByPath.get(file.path);
    if (!hit) {
      hit = { path: file.path, matches: [] };
      resultsByPath.set(file.path, hit);
    }
    const lineText = file.lines[item.lineIndex] ?? "";
    hit.matches.push({
      line: item.lineIndex + 1,
      text: lineText,
      context: contextFor(file.lines, item.lineIndex, contextLines),
    });
  }
  let outputBytes = 0;
  const results: SearchHit[] = [];
  for (const result of resultsByPath.values()) {
    const bytes = Buffer.byteLength(JSON.stringify(result), "utf8");
    if (outputBytes + bytes > maxBytes) {
      truncated = true;
      break;
    }
    outputBytes += bytes;
    results.push(result);
  }
  if (matched.length >= maxResults || loaded.some((file) => file.truncated))
    truncated = true;
  return { results, truncated };
}

export async function isRegularFile(
  project: ProjectRecord,
  relativePath: string,
): Promise<boolean> {
  const resolved = await resolveProjectPath(project, relativePath);
  return (await lstat(resolved.absolutePath)).isFile();
}
