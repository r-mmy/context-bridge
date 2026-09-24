import { lstat, open, readlink, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { TextDecoder } from "node:util";
import ignore from "ignore";
import type { ProjectRecord } from "../projects/registry.js";
import { ContextBridgeError } from "./errors.js";

export interface ResolvedPath {
  relativePath: string;
  absolutePath: string;
  exists: boolean;
}

const TEMPLATE_ENV_FILES = new Set([
  ".env.example",
  ".env.sample",
  ".env.template",
]);
const PRIVATE_KEY_NAMES = new Set([
  "id_rsa",
  "id_ed25519",
  "id_ecdsa",
  "id_dsa",
  "identity",
]);
const SECRET_EXACT_NAMES = new Set([
  ".netrc",
  ".npmrc",
  ".pypirc",
  "credentials",
  "credentials.json",
  "credential",
  "credential.json",
  "secrets",
  "secrets.json",
  "secret.json",
  "token.json",
  "application_default_credentials.json",
  "accesstokens.json",
  "azureprofile.json",
  "msal_token_cache.json",
  "credentials.db",
  "access_tokens.db",
  "msal_token_cache.bin",
  "msal_http_cache.bin",
]);
const PRIVATE_KEY_EXTENSIONS = new Set([
  ".pem",
  ".key",
  ".der",
  ".asc",
  ".snk",
  ".p12",
  ".pfx",
  ".ppk",
  ".jks",
  ".keystore",
]);
const ALWAYS_EXCLUDED_SEGMENTS = new Set([
  ".git",
  "node_modules",
  ".pnpm-store",
]);
const MAX_IGNORE_FILE_BYTES = 256 * 1024;

function containsPath(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  if (relative === "") return true;
  if (path.isAbsolute(relative)) return false;
  return relative !== ".." && !relative.startsWith(`..${path.sep}`);
}

function normalizeRelativePath(
  root: string,
  supplied: string,
): { relativePath: string; absolutePath: string } {
  if (supplied.includes("\0"))
    throw new ContextBridgeError(
      "invalid_path",
      "Paths cannot contain NUL characters.",
    );
  const slashPath = supplied.replace(/\\/g, "/");
  if (
    slashPath.startsWith("/") ||
    /^[a-zA-Z]:/.test(slashPath) ||
    slashPath.startsWith("~")
  ) {
    throw new ContextBridgeError(
      "absolute_path",
      "Use a path relative to the registered project root.",
    );
  }
  const parts: string[] = [];
  for (const part of slashPath.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (parts.length === 0)
        throw new ContextBridgeError(
          "path_escape",
          "The path escapes the registered project root.",
        );
      parts.pop();
      continue;
    }
    if (process.platform === "win32" && part.includes(":"))
      throw new ContextBridgeError(
        "invalid_path",
        "Windows alternate data stream paths are not supported.",
      );
    parts.push(part);
  }
  const relativePath = parts.join("/");
  const absolutePath = path.resolve(root, ...parts);
  if (!containsPath(root, absolutePath)) {
    throw new ContextBridgeError(
      "path_escape",
      "The path escapes the registered project root.",
    );
  }
  return { relativePath, absolutePath };
}

function isSensitive(relativePath: string): boolean {
  const normalizedPath =
    process.platform === "win32"
      ? relativePath.replace(/\\/g, "/")
      : relativePath;
  const parts = normalizedPath.split("/").filter(Boolean);
  const lowered = parts.map((part) => part.toLowerCase());
  for (const part of lowered) {
    if (ALWAYS_EXCLUDED_SEGMENTS.has(part)) return true;
  }
  if (lowered.includes(".ssh")) return true;
  const name = lowered.at(-1) ?? "";
  if (
    name === ".env" ||
    (name.startsWith(".env.") && !TEMPLATE_ENV_FILES.has(name))
  )
    return true;
  if (PRIVATE_KEY_NAMES.has(name)) return true;
  if (PRIVATE_KEY_EXTENSIONS.has(path.posix.extname(name))) return true;
  if (SECRET_EXACT_NAMES.has(name)) return true;
  if (
    name.startsWith("credentials.") ||
    name.startsWith("credential.") ||
    name.startsWith("secrets.") ||
    name.startsWith("secret.") ||
    name.startsWith("token.") ||
    name.startsWith("client_secret") ||
    name.startsWith("service-account") ||
    name.startsWith("service_account")
  ) {
    return true;
  }
  if (name.endsWith(".service-account.json")) return true;
  if (
    lowered.some(
      (part, index) => part === ".aws" && lowered[index + 1] === "credentials",
    )
  )
    return true;
  if (
    lowered.some(
      (part, index) =>
        part === ".config" &&
        lowered[index + 1] === "gcloud" &&
        [
          "credentials.db",
          "access_tokens.db",
          "application_default_credentials.json",
          "legacy_credentials",
        ].includes(lowered[index + 2] ?? ""),
    )
  )
    return true;
  if (
    lowered.some(
      (part, index) =>
        part === ".azure" && lowered[index + 1] === "accesstokens.json",
    )
  )
    return true;
  return false;
}

export function isSensitiveProjectRoot(root: string): boolean {
  // Registration can remove the identifying components from project-relative
  // paths, so apply the same denylist to each canonical root ancestor.
  let candidate = path.resolve(root);
  while (true) {
    if (isSensitive(candidate)) return true;
    const parent = path.dirname(candidate);
    if (parent === candidate) return false;
    candidate = parent;
  }
}

async function readRules(
  projectRoot: string,
  relativeDirectory: string,
  filename: string,
): Promise<string | undefined> {
  const directory = relativeDirectory
    ? path.join(projectRoot, ...relativeDirectory.split("/"))
    : projectRoot;
  let canonicalDirectory: string;
  try {
    canonicalDirectory = await realpath(directory);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      await resolveExistingAncestor(projectRoot, directory);
      return undefined;
    }
    throw error;
  }
  if (!containsPath(projectRoot, canonicalDirectory))
    throw new ContextBridgeError(
      "symlink_escape",
      "An ignore-rule directory resolves outside the registered project root.",
    );

  let canonicalFile: string;
  const rulePath = path.join(canonicalDirectory, filename);
  try {
    canonicalFile = await realpath(rulePath);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      try {
        const details = await lstat(rulePath);
        if (details.isSymbolicLink()) {
          const target = await readlink(rulePath);
          const unresolvedTarget = path.resolve(canonicalDirectory, target);
          if (!containsPath(projectRoot, unresolvedTarget))
            throw new ContextBridgeError(
              "symlink_escape",
              "An ignore-rule file resolves outside the registered project root.",
            );
          await resolveExistingAncestor(projectRoot, unresolvedTarget);
        }
      } catch (linkError) {
        if (linkError instanceof ContextBridgeError) throw linkError;
        if (
          !(linkError instanceof Error) ||
          !("code" in linkError) ||
          linkError.code !== "ENOENT"
        )
          throw linkError;
      }
      return undefined;
    }
    throw error;
  }
  if (!containsPath(projectRoot, canonicalFile))
    throw new ContextBridgeError(
      "symlink_escape",
      "An ignore-rule file resolves outside the registered project root.",
    );

  const fileDetails = await stat(canonicalFile);
  if (!fileDetails.isFile())
    throw new ContextBridgeError(
      "invalid_ignore_file",
      "Project ignore rules must be regular files.",
    );
  if (fileDetails.size > MAX_IGNORE_FILE_BYTES)
    throw new ContextBridgeError(
      "ignore_file_too_large",
      `Project ignore files cannot exceed ${MAX_IGNORE_FILE_BYTES} bytes.`,
    );

  const handle = await open(canonicalFile, "r");
  try {
    const before = await handle.stat();
    if (!before.isFile())
      throw new ContextBridgeError(
        "invalid_ignore_file",
        "Project ignore rules must be regular files.",
      );
    if (before.size > MAX_IGNORE_FILE_BYTES)
      throw new ContextBridgeError(
        "ignore_file_too_large",
        `Project ignore files cannot exceed ${MAX_IGNORE_FILE_BYTES} bytes.`,
      );
    const buffer = Buffer.alloc(
      Math.min(MAX_IGNORE_FILE_BYTES + 1, before.size + 1),
    );
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const after = await handle.stat();
    if (after.size > MAX_IGNORE_FILE_BYTES || bytesRead > MAX_IGNORE_FILE_BYTES)
      throw new ContextBridgeError(
        "ignore_file_too_large",
        `Project ignore files cannot exceed ${MAX_IGNORE_FILE_BYTES} bytes.`,
      );
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(
        buffer.subarray(0, bytesRead),
      );
    } catch {
      throw new ContextBridgeError(
        "invalid_ignore_file",
        "Project ignore files must contain valid UTF-8 text.",
      );
    }
  } finally {
    await handle.close();
  }
}

async function isIgnored(
  projectRoot: string,
  relativePath: string,
  isDirectory: boolean,
): Promise<boolean> {
  if (!relativePath) return false;
  const components = relativePath.split("/");
  const parentCount = components.length - 1;
  const ancestors = [""];
  for (let count = 1; count <= parentCount; count += 1)
    ancestors.push(components.slice(0, count).join("/"));

  let ignored = false;
  for (const ancestor of ancestors) {
    const localPath = ancestor
      ? relativePath.slice(ancestor.length + 1)
      : relativePath;
    const gitRules = await readRules(projectRoot, ancestor, ".gitignore");
    const bridgeRules = await readRules(
      projectRoot,
      ancestor,
      ".contextbridgeignore",
    );
    const matcher = ignore();
    try {
      if (gitRules) matcher.add(gitRules);
      if (bridgeRules) matcher.add(bridgeRules);
    } catch {
      throw new ContextBridgeError(
        "invalid_ignore_file",
        "Project ignore rules contain an invalid pattern.",
      );
    }
    if (!gitRules && !bridgeRules) continue;
    const result = matcher.test(`${localPath}${isDirectory ? "/" : ""}`);
    if (result.ignored) ignored = true;
    else if (result.unignored) ignored = false;
  }
  return ignored;
}

async function resolveExistingAncestor(
  root: string,
  candidate: string,
): Promise<string> {
  let cursor = candidate;
  while (true) {
    try {
      const canonical = await realpath(cursor);
      if (!containsPath(root, canonical)) {
        throw new ContextBridgeError(
          "symlink_escape",
          "The path resolves outside the registered project root.",
        );
      }
      return canonical;
    } catch (error) {
      if (error instanceof ContextBridgeError) throw error;
      if (
        !(error instanceof Error) ||
        !("code" in error) ||
        error.code !== "ENOENT"
      )
        throw error;
      const parent = path.dirname(cursor);
      if (parent === cursor)
        throw new ContextBridgeError(
          "path_missing",
          "The requested path does not exist.",
        );
      cursor = parent;
    }
  }
}

export async function resolveProjectPath(
  project: ProjectRecord,
  supplied: string | undefined,
  options: {
    allowMissing?: boolean;
    isDirectory?: boolean;
    skipIgnoreRules?: boolean;
  } = {},
): Promise<ResolvedPath> {
  if (isSensitiveProjectRoot(project.root))
    throw new ContextBridgeError(
      "path_denied",
      "The requested path is excluded by the security policy.",
    );
  const { relativePath, absolutePath } = normalizeRelativePath(
    project.root,
    supplied ?? ".",
  );
  if (isSensitive(relativePath))
    throw new ContextBridgeError(
      "path_denied",
      "The requested path is excluded by the security policy.",
    );
  if (
    !options.skipIgnoreRules &&
    (await isIgnored(project.root, relativePath, options.isDirectory ?? false))
  ) {
    throw new ContextBridgeError(
      "path_ignored",
      "The requested path is excluded by project ignore rules.",
    );
  }
  try {
    const canonical = await realpath(absolutePath);
    if (!containsPath(project.root, canonical)) {
      throw new ContextBridgeError(
        "symlink_escape",
        "The path resolves outside the registered project root.",
      );
    }
    const canonicalRelativePath = path
      .relative(project.root, canonical)
      .split(path.sep)
      .join("/");
    if (isSensitive(canonicalRelativePath))
      throw new ContextBridgeError(
        "path_denied",
        "The requested path is excluded by the security policy.",
      );
    if (
      !options.skipIgnoreRules &&
      canonicalRelativePath !== relativePath &&
      (await isIgnored(
        project.root,
        canonicalRelativePath,
        options.isDirectory ?? false,
      ))
    ) {
      throw new ContextBridgeError(
        "path_ignored",
        "The requested path is excluded by project ignore rules.",
      );
    }
    return { relativePath, absolutePath: canonical, exists: true };
  } catch (error) {
    if (error instanceof ContextBridgeError) throw error;
    if (
      error instanceof Error &&
      "code" in error &&
      error.code === "ENOENT" &&
      options.allowMissing
    ) {
      await resolveExistingAncestor(project.root, absolutePath);
      return { relativePath, absolutePath, exists: false };
    }
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      throw new ContextBridgeError(
        "path_missing",
        "The requested path does not exist.",
      );
    }
    throw error;
  }
}

export async function isProjectPathVisible(
  project: ProjectRecord,
  relativePath: string,
): Promise<boolean> {
  try {
    await resolveProjectPath(project, relativePath, { allowMissing: true });
    return true;
  } catch (error) {
    if (
      error instanceof ContextBridgeError &&
      [
        "path_denied",
        "path_ignored",
        "symlink_escape",
        "path_escape",
        "absolute_path",
        "path_missing",
      ].includes(error.code)
    ) {
      return false;
    }
    throw error;
  }
}

export function isHiddenPath(relativePath: string): boolean {
  return relativePath
    .split("/")
    .some((part) => part.startsWith(".") && part !== "." && part !== "..");
}

export function isWithinProject(root: string, candidate: string): boolean {
  return containsPath(root, candidate);
}
