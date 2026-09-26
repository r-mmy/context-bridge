import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { getAgentPolicyPath, getConfigDirectory } from "../config/paths.js";
import {
  acquireConfigMutationLock,
  tryAcquireProjectWriterLock,
  withConfigMutationLock,
} from "../locks/file-lock.js";
import {
  ensureProjectRegistrationIdentity,
  getProject,
  normalizeProjectRootForIdentity,
  readRegistry,
  type ProjectRecord,
} from "../projects/registry.js";
import { ContextBridgeError } from "../security/errors.js";
import {
  AgentProfileSchema,
  AgentProfilesSchema,
  DEFAULT_AGENT_PROFILE,
  DEFAULT_PROFILE_NAME,
  ProfileNameSchema,
  type AgentProfile,
} from "./profiles.js";

const ProjectIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);

const ProjectAuthorizationSchema = z
  .object({
    registration_added_at: z.string().datetime(),
    root_fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    registration_id: z.string().uuid().optional(),
    enabled: z.boolean(),
    allowed_profiles: z.array(ProfileNameSchema).min(1).max(256),
    default_profile: ProfileNameSchema.optional(),
  })
  .strict()
  .refine(
    (authorization) =>
      new Set(authorization.allowed_profiles).size ===
      authorization.allowed_profiles.length,
    { message: "allowed_profiles contains duplicates" },
  );

export type ProjectAuthorization = z.infer<typeof ProjectAuthorizationSchema>;

const AgentPolicySchema = z
  .object({
    schema_version: z.literal(1),
    default_profile: ProfileNameSchema,
    profiles: AgentProfilesSchema,
    projects: z.record(ProjectIdSchema, ProjectAuthorizationSchema),
  })
  .strict()
  .superRefine((policy, context) => {
    if (!Object.hasOwn(policy.profiles, policy.default_profile)) {
      context.addIssue({
        code: "custom",
        path: ["default_profile"],
        message: "default_profile must name a configured profile",
      });
    }
    for (const [projectId, authorization] of Object.entries(policy.projects)) {
      for (const profile of authorization.allowed_profiles) {
        if (!Object.hasOwn(policy.profiles, profile)) {
          context.addIssue({
            code: "custom",
            path: ["projects", projectId, "allowed_profiles"],
            message: "allowed profiles must exist",
          });
        }
      }
      if (
        authorization.default_profile !== undefined &&
        !authorization.allowed_profiles.includes(authorization.default_profile)
      ) {
        context.addIssue({
          code: "custom",
          path: ["projects", projectId, "default_profile"],
          message: "project default must be allowed",
        });
      }
      if (
        authorization.default_profile === undefined &&
        !authorization.allowed_profiles.includes(policy.default_profile)
      ) {
        context.addIssue({
          code: "custom",
          path: ["projects", projectId, "allowed_profiles"],
          message:
            "global default must be allowed when no project default is set",
        });
      }
    }
  });

export type AgentPolicy = z.infer<typeof AgentPolicySchema>;

const DEFAULT_AGENT_POLICY: AgentPolicy = {
  schema_version: 1,
  default_profile: DEFAULT_PROFILE_NAME,
  profiles: { [DEFAULT_PROFILE_NAME]: DEFAULT_AGENT_PROFILE },
  projects: {},
};

function policyError(): ContextBridgeError {
  return new ContextBridgeError(
    "agent_policy_invalid",
    "The agent policy file is malformed or uses an unsupported schema. It was left unchanged; repair it before using agent policy commands.",
  );
}

function parsePolicy(value: unknown): AgentPolicy {
  const parsed = AgentPolicySchema.safeParse(value);
  if (!parsed.success) throw policyError();
  return parsed.data;
}

function identityFor(
  project: ProjectRecord,
): Pick<
  ProjectAuthorization,
  "registration_added_at" | "root_fingerprint" | "registration_id"
> {
  return {
    registration_added_at: project.addedAt,
    ...(project.registrationId
      ? { registration_id: project.registrationId }
      : {}),
    root_fingerprint: createHash("sha256")
      .update(normalizeProjectRootForIdentity(project.root), "utf8")
      .digest("hex"),
  };
}

export function authorizationMatchesProject(
  authorization: ProjectAuthorization,
  project: ProjectRecord,
): boolean {
  if (!project.registrationId) return false;
  const identity = identityFor(project);
  return (
    authorization.registration_id === identity.registration_id &&
    authorization.registration_added_at === identity.registration_added_at &&
    authorization.root_fingerprint === identity.root_fingerprint
  );
}

export async function readAgentPolicy(): Promise<AgentPolicy> {
  let contents: string;
  try {
    contents = await readFile(getAgentPolicyPath(), "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return structuredClone(DEFAULT_AGENT_POLICY);
    }
    throw new ContextBridgeError(
      "agent_policy_unavailable",
      "The agent policy file could not be read.",
    );
  }

  let value: unknown;
  try {
    value = JSON.parse(contents);
  } catch {
    throw policyError();
  }
  return parsePolicy(value);
}

async function persistAgentPolicy(policy: AgentPolicy): Promise<void> {
  const directory = getConfigDirectory();
  const target = getAgentPolicyPath();
  const temporary = path.join(
    directory,
    `agent-policy.${process.pid}.${randomUUID()}.tmp`,
  );

  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") await chmod(directory, 0o700);
  } catch {
    throw new ContextBridgeError(
      "agent_policy_write_failed",
      "The private agent policy directory could not be prepared.",
    );
  }

  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let temporaryCreated = false;
  try {
    handle = await open(
      temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      0o600,
    );
    temporaryCreated = true;
    await handle.writeFile(`${JSON.stringify(policy, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, target);
  } catch {
    if (handle) await handle.close().catch(() => undefined);
    if (temporaryCreated)
      await rm(temporary, { force: true }).catch(() => undefined);
    throw new ContextBridgeError(
      "agent_policy_write_failed",
      "The agent policy could not be saved; the previous policy was left unchanged.",
    );
  }
}

/**
 * Replace a complete policy snapshot. Production read-modify-write mutations
 * must use mutateAgentPolicy so their read is inside the same lock transaction.
 */
export async function writeAgentPolicy(value: unknown): Promise<void> {
  const policy = parsePolicy(value);
  await withConfigMutationLock(() => persistAgentPolicy(policy));
}

interface PolicyMutation<T> {
  value: T;
  changed?: boolean;
}

async function mutateAgentPolicy<T>(
  mutate: (
    policy: AgentPolicy,
  ) => Promise<PolicyMutation<T>> | PolicyMutation<T>,
): Promise<T> {
  return withConfigMutationLock(async () => {
    const policy = await readAgentPolicy();
    const result = await mutate(policy);
    if (result.changed !== false) await persistAgentPolicy(policy);
    return result.value;
  });
}

export interface ProjectPolicyStatus {
  policy: AgentPolicy;
  authorization?: ProjectAuthorization;
  registration_state:
    "matching" | "stale" | "not_registered" | "unavailable" | "not_authorized";
  enabled: boolean;
}

export async function getProjectPolicyStatus(
  projectId: string,
): Promise<ProjectPolicyStatus> {
  const policy = await readAgentPolicy();
  const authorization = Object.hasOwn(policy.projects, projectId)
    ? policy.projects[projectId]
    : undefined;
  const registry = await readRegistry();
  const registered = registry.projects.some(
    (project) => project.id === projectId,
  );

  if (!registered) {
    return {
      policy,
      ...(authorization ? { authorization } : {}),
      registration_state: "not_registered",
      enabled: false,
    };
  }

  let current: ProjectRecord;
  try {
    current = await getProject(projectId);
  } catch (error) {
    if (
      error instanceof ContextBridgeError &&
      [
        "project_not_found",
        "project_root_missing",
        "project_root_changed",
        "project_unavailable",
      ].includes(error.code)
    ) {
      return {
        policy,
        ...(authorization ? { authorization } : {}),
        registration_state:
          error.code === "project_not_found"
            ? "not_registered"
            : error.code === "project_root_changed"
              ? "stale"
              : "unavailable",
        enabled: false,
      };
    }
    throw error;
  }

  if (!authorization) {
    return {
      policy,
      registration_state: "not_authorized",
      enabled: false,
    };
  }

  const matches = authorizationMatchesProject(authorization, current);
  return {
    policy,
    authorization,
    registration_state: matches ? "matching" : "stale",
    enabled: matches && authorization.enabled,
  };
}

export async function enableProjectAuthorization(
  project: ProjectRecord,
  expectedGlobalDefault?: string,
): Promise<ProjectAuthorization> {
  // Legacy registrations gain their UUID in projects.json first. If the
  // process crashes before the following policy transaction, authorization
  // remains stale/off; the policy write rechecks the registration under the
  // same global lock before enabling it.
  const identifiedProject = await ensureProjectRegistrationIdentity(project);
  return mutateAgentPolicy(async (policy) => {
    const currentProject = await getProject(project.id);
    if (!sameProjectRegistration(identifiedProject, currentProject)) {
      throw new ContextBridgeError(
        "project_registration_changed",
        "The project registration changed; no authorization was written.",
      );
    }
    if (
      expectedGlobalDefault !== undefined &&
      policy.default_profile !== expectedGlobalDefault
    ) {
      throw new ContextBridgeError(
        "agent_policy_changed",
        "The global default profile changed during confirmation; no authorization was written. Review the policy and try again.",
      );
    }
    const existing = Object.hasOwn(policy.projects, project.id)
      ? policy.projects[project.id]
      : undefined;
    const authorization =
      existing && authorizationMatchesProject(existing, identifiedProject)
        ? {
            ...existing,
            enabled: true,
          }
        : {
            ...identityFor(identifiedProject),
            enabled: true,
            allowed_profiles: [policy.default_profile],
            default_profile: policy.default_profile,
          };
    policy.projects[project.id] = authorization;
    return { value: authorization };
  });
}

export function sameProjectRegistration(
  first: ProjectRecord,
  second: ProjectRecord,
): boolean {
  return (
    first.id === second.id &&
    first.addedAt === second.addedAt &&
    first.registrationId === second.registrationId &&
    identityFor(first).root_fingerprint === identityFor(second).root_fingerprint
  );
}

export async function disableProjectAuthorization(
  project: ProjectRecord,
): Promise<boolean> {
  const configLock = await acquireConfigMutationLock();
  let projectLock: Awaited<ReturnType<typeof tryAcquireProjectWriterLock>> =
    undefined;
  try {
    const policy = await readAgentPolicy();
    const registry = await readRegistry();
    const current = registry.projects.find((entry) => entry.id === project.id);
    if (!current || !sameProjectRegistration(project, current)) {
      return false;
    }
    const existing = Object.hasOwn(policy.projects, project.id)
      ? policy.projects[project.id]
      : undefined;
    if (!existing || !authorizationMatchesProject(existing, current))
      return false;
    if (!existing.enabled) return false;
    projectLock = await tryAcquireProjectWriterLock(current.root);
    if (!projectLock) {
      throw new ContextBridgeError(
        "project_busy",
        "The project has an active agent task and cannot be disabled yet.",
      );
    }
    policy.projects[project.id] = { ...existing, enabled: false };
    await persistAgentPolicy(policy);
    return true;
  } finally {
    try {
      await projectLock?.release();
    } finally {
      await configLock.release();
    }
  }
}

export async function setProjectAllowedProfiles(
  project: ProjectRecord,
  allowedProfiles: string[],
  requestedDefault?: string,
): Promise<ProjectAuthorization> {
  return mutateAgentPolicy(async (policy) => {
    const registry = await readRegistry();
    const current = registry.projects.find((entry) => entry.id === project.id);
    const existing = Object.hasOwn(policy.projects, project.id)
      ? policy.projects[project.id]
      : undefined;
    if (
      !current ||
      !sameProjectRegistration(project, current) ||
      !existing ||
      !authorizationMatchesProject(existing, current)
    ) {
      throw new ContextBridgeError(
        "project_policy_stale",
        "Enable authorization for the current project registration before changing its profiles.",
      );
    }
    if (
      allowedProfiles.length === 0 ||
      new Set(allowedProfiles).size !== allowedProfiles.length
    ) {
      throw new ContextBridgeError(
        "invalid_project_policy",
        "Allow at least one unique profile.",
      );
    }
    for (const profile of allowedProfiles) {
      if (!Object.hasOwn(policy.profiles, profile)) {
        throw new ContextBridgeError(
          "profile_not_found",
          `No agent profile named "${profile}" exists.`,
        );
      }
    }
    const defaultProfile =
      requestedDefault ??
      (existing.default_profile &&
      allowedProfiles.includes(existing.default_profile)
        ? existing.default_profile
        : allowedProfiles.includes(policy.default_profile)
          ? policy.default_profile
          : undefined);
    if (!defaultProfile || !allowedProfiles.includes(defaultProfile)) {
      throw new ContextBridgeError(
        "invalid_project_policy",
        "The project default profile must be included in --allow-profile.",
      );
    }
    const authorization: ProjectAuthorization = {
      ...existing,
      allowed_profiles: [...allowedProfiles],
      default_profile: defaultProfile,
    };
    policy.projects[project.id] = authorization;
    return { value: authorization };
  });
}

export async function addAgentProfile(
  name: string,
  profile: AgentProfile,
): Promise<void> {
  const nameResult = ProfileNameSchema.safeParse(name);
  const profileResult = AgentProfileSchema.safeParse(profile);
  if (!nameResult.success || !profileResult.success) {
    throw new ContextBridgeError(
      "invalid_profile",
      "The profile name, model ID, or reasoning effort has an invalid format.",
    );
  }
  await mutateAgentPolicy((policy) => {
    if (Object.hasOwn(policy.profiles, name)) {
      throw new ContextBridgeError(
        "profile_exists",
        `Agent profile "${name}" already exists.`,
      );
    }
    policy.profiles[name] = profileResult.data;
    return { value: undefined };
  });
}

export async function setGlobalDefaultProfile(name: string): Promise<void> {
  await mutateAgentPolicy((policy) => {
    if (!Object.hasOwn(policy.profiles, name)) {
      throw new ContextBridgeError(
        "profile_not_found",
        `No agent profile named "${name}" exists.`,
      );
    }
    for (const authorization of Object.values(policy.projects)) {
      if (
        authorization.default_profile === undefined &&
        !authorization.allowed_profiles.includes(name)
      ) {
        throw new ContextBridgeError(
          "invalid_project_policy",
          "The new global default is not allowed by a project without its own default; set that project's default first.",
        );
      }
    }
    policy.default_profile = name;
    return { value: undefined };
  });
}

export async function removeAgentProfile(name: string): Promise<void> {
  await mutateAgentPolicy((policy) => {
    if (!Object.hasOwn(policy.profiles, name)) {
      throw new ContextBridgeError(
        "profile_not_found",
        `No agent profile named "${name}" exists.`,
      );
    }
    if (policy.default_profile === name) {
      throw new ContextBridgeError(
        "profile_in_use",
        `Agent profile "${name}" is the global default and cannot be removed.`,
      );
    }
    if (
      Object.values(policy.projects).some(
        (authorization) =>
          authorization.allowed_profiles.includes(name) ||
          authorization.default_profile === name,
      )
    ) {
      throw new ContextBridgeError(
        "profile_in_use",
        `Agent profile "${name}" is referenced by a project policy and cannot be removed.`,
      );
    }
    delete policy.profiles[name];
    return { value: undefined };
  });
}
