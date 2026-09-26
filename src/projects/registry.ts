import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import path from "node:path";
import { getConfigDirectory, getRegistryPath } from "../config/paths.js";
import { withConfigMutationLock } from "../locks/file-lock.js";
import { ContextBridgeError } from "../security/errors.js";
import { isSensitiveProjectRoot } from "../security/paths.js";

export interface ProjectRecord {
  id: string;
  name: string;
  root: string;
  addedAt: string;
  /** Unique registration instance; optional only for pre-M3A registry v1 data. */
  registrationId?: string;
}

export interface ProjectRegistry {
  version: 1;
  projects: ProjectRecord[];
}

const EMPTY_REGISTRY: ProjectRegistry = { version: 1, projects: [] };

/**
 * Match the registry's existing path identity rules: resolve lexical segments,
 * fold case on Windows, and preserve case on POSIX systems. Callers binding an
 * authorization must supply the canonical root returned by getProject().
 */
export function normalizeProjectRootForIdentity(value: string): string {
  const normalized = path.resolve(value);
  return process.platform === "win32"
    ? normalized.toLocaleLowerCase("en-US")
    : normalized;
}

function slugify(value: string): string {
  const slug = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "project";
}

function parseRegistry(text: string): ProjectRegistry {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ContextBridgeError(
      "invalid_registry",
      "The project registry is not valid JSON.",
    );
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    (parsed as { version?: unknown }).version !== 1 ||
    !Array.isArray((parsed as { projects?: unknown }).projects)
  ) {
    throw new ContextBridgeError(
      "invalid_registry",
      "The project registry has an unsupported format.",
    );
  }
  const projects: ProjectRecord[] = [];
  for (const candidate of (parsed as { projects: unknown[] }).projects) {
    if (!candidate || typeof candidate !== "object") {
      throw new ContextBridgeError(
        "invalid_registry",
        "The project registry contains an invalid entry.",
      );
    }
    const record = candidate as Partial<ProjectRecord>;
    if (
      typeof record.id !== "string" ||
      !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(record.id) ||
      typeof record.name !== "string" ||
      typeof record.root !== "string" ||
      !path.isAbsolute(record.root) ||
      typeof record.addedAt !== "string" ||
      (record.registrationId !== undefined &&
        (typeof record.registrationId !== "string" ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
            record.registrationId,
          )))
    ) {
      throw new ContextBridgeError(
        "invalid_registry",
        "The project registry contains an invalid entry.",
      );
    }
    projects.push({
      id: record.id,
      name: record.name,
      root: record.root,
      addedAt: record.addedAt,
      ...(record.registrationId
        ? { registrationId: record.registrationId }
        : {}),
    });
  }
  return { version: 1, projects };
}

export async function ensureRegistry(): Promise<string> {
  return withConfigMutationLock(async () => {
    const directory = getConfigDirectory();
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const registryPath = getRegistryPath();
    try {
      await lstat(registryPath);
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !("code" in error) ||
        error.code !== "ENOENT"
      )
        throw error;
      await persistRegistry(EMPTY_REGISTRY);
    }
    return registryPath;
  });
}

export async function readRegistry(): Promise<ProjectRegistry> {
  try {
    const text = await readFile(getRegistryPath(), "utf8");
    return parseRegistry(text);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return structuredClone(EMPTY_REGISTRY);
    }
    throw error;
  }
}

async function persistRegistry(registry: ProjectRegistry): Promise<void> {
  const directory = getConfigDirectory();
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const target = getRegistryPath();
  const temporary = path.join(
    directory,
    `projects.${process.pid}.${randomUUID()}.tmp`,
  );
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(registry, null, 2)}\n`, "utf8");
    await handle.sync();
  } catch (error) {
    await handle.close();
    await rm(temporary, { force: true });
    throw error;
  }
  await handle.close();
  try {
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

/**
 * Replace a complete registry snapshot while holding the global config lock.
 * Production read-modify-write operations must read after acquiring that lock
 * and use the private persist helper inside one transaction instead.
 */
export async function writeRegistry(registry: ProjectRegistry): Promise<void> {
  await withConfigMutationLock(() => persistRegistry(registry));
}

export async function addProject(pathInput: string): Promise<ProjectRecord> {
  const absoluteInput = path.resolve(pathInput || process.cwd());
  let root: string;
  try {
    root = await realpath(absoluteInput);
  } catch {
    throw new ContextBridgeError(
      "project_path_missing",
      "The project path does not exist or cannot be accessed.",
    );
  }
  let details;
  try {
    details = await stat(root);
  } catch {
    throw new ContextBridgeError(
      "project_path_missing",
      "The project path does not exist or cannot be accessed.",
    );
  }
  if (!details.isDirectory()) {
    throw new ContextBridgeError(
      "project_not_directory",
      "The project path must be a directory.",
    );
  }
  if (isSensitiveProjectRoot(root))
    throw new ContextBridgeError(
      "sensitive_project_root",
      "This directory is inside a location protected by Context Bridge's built-in sensitive-path policy.",
    );

  return withConfigMutationLock(async () => {
    const registry = await readRegistry();
    const normalizedRoot = normalizeProjectRootForIdentity(root);
    if (
      registry.projects.some(
        (project) =>
          normalizeProjectRootForIdentity(project.root) === normalizedRoot,
      )
    ) {
      throw new ContextBridgeError(
        "project_already_registered",
        "This directory is already registered.",
      );
    }

    const displayName = (path.basename(root) || "Filesystem root").replace(
      /[\\/]+/g,
      "-",
    );
    const baseId = slugify(displayName);
    let id = baseId;
    let suffix = 2;
    while (registry.projects.some((project) => project.id === id)) {
      id = `${baseId}-${suffix}`;
      suffix += 1;
    }
    const project: ProjectRecord = {
      id,
      name: displayName,
      root,
      addedAt: new Date().toISOString(),
      registrationId: randomUUID(),
    };
    registry.projects.push(project);
    registry.projects.sort((left, right) => left.id.localeCompare(right.id));
    await persistRegistry(registry);
    return project;
  });
}

export async function removeProject(id: string): Promise<ProjectRecord> {
  return withConfigMutationLock(async () => {
    const registry = await readRegistry();
    const index = registry.projects.findIndex((project) => project.id === id);
    if (index < 0)
      throw new ContextBridgeError(
        "project_not_found",
        `No registered project has ID "${id}".`,
      );
    const [removed] = registry.projects.splice(index, 1);
    // Policy entries intentionally remain as stale records. This single
    // atomic registry replacement is enough: after removal the policy is not
    // registered, and a later add gets a new UUID before it can match again.
    await persistRegistry(registry);
    if (!removed)
      throw new ContextBridgeError(
        "project_not_found",
        `No registered project has ID "${id}".`,
      );
    return removed;
  });
}

export async function ensureProjectRegistrationIdentity(
  expected: ProjectRecord,
): Promise<ProjectRecord> {
  return withConfigMutationLock(async () => {
    const registry = await readRegistry();
    const index = registry.projects.findIndex(
      (project) => project.id === expected.id,
    );
    const current = registry.projects[index];
    if (
      !current ||
      current.addedAt !== expected.addedAt ||
      current.registrationId !== expected.registrationId ||
      normalizeProjectRootForIdentity(current.root) !==
        normalizeProjectRootForIdentity(expected.root)
    ) {
      throw new ContextBridgeError(
        "project_registration_changed",
        "The project registration changed; no authorization was written.",
      );
    }
    if (current.registrationId) return current;

    const identified = { ...current, registrationId: randomUUID() };
    registry.projects[index] = identified;
    await persistRegistry(registry);
    return identified;
  });
}

export async function getProject(id: string): Promise<ProjectRecord> {
  const registry = await readRegistry();
  const project = registry.projects.find((entry) => entry.id === id);
  if (!project)
    throw new ContextBridgeError(
      "project_not_found",
      `No registered project has ID "${id}".`,
    );
  let actualRoot: string;
  try {
    actualRoot = await realpath(project.root);
  } catch {
    throw new ContextBridgeError(
      "project_root_missing",
      `The registered project "${id}" is no longer accessible.`,
    );
  }
  if (
    normalizeProjectRootForIdentity(actualRoot) !==
    normalizeProjectRootForIdentity(project.root)
  ) {
    throw new ContextBridgeError(
      "project_root_changed",
      `The registered project "${id}" now resolves to a different location.`,
    );
  }
  if (isSensitiveProjectRoot(actualRoot))
    throw new ContextBridgeError(
      "project_unavailable",
      "The registered project is unavailable.",
    );
  return project;
}
