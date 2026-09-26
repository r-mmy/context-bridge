import { spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { access, stat } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { getAgentPolicyPath, getRegistryPath } from "../config/paths.js";
import {
  validateProfileCapabilities,
  type AgentAdapter,
  type AgentBackendInfo,
  type AgentModel,
} from "../agents/adapter.js";
import {
  AgentAdapterError,
  type AgentAdapterErrorCode,
} from "../agents/errors.js";
import {
  addAgentProfile,
  disableProjectAuthorization,
  enableProjectAuthorization,
  getProjectPolicyStatus,
  readAgentPolicy,
  removeAgentProfile,
  sameProjectRegistration,
  setGlobalDefaultProfile,
  setProjectAllowedProfiles,
  type ProjectPolicyStatus,
} from "../agents/policy.js";
import {
  AgentProfileSchema,
  ProfileNameSchema,
  type AgentProfile,
} from "../agents/profiles.js";
import {
  addProject,
  ensureRegistry,
  getProject,
  readRegistry,
  removeProject,
} from "../projects/registry.js";
import { ContextBridgeError } from "../security/errors.js";
import { isGitRepository } from "../git/run.js";
import { getCodexAgentAdapter } from "../agents/codex/adapter.js";
import { startHttpServer } from "../transports/http.js";
import { startStdioServer } from "../transports/stdio.js";

const VERSION = "0.1.0";

const HELP = `Context Bridge v${VERSION}
Read-only access to explicitly registered local projects through MCP.
Local agent commands manage authorization only; M1 does not execute projects.

Usage:
  ctxbridge init
  ctxbridge project add [path]
  ctxbridge project list
  ctxbridge project show <id>
  ctxbridge project remove <id>
  ctxbridge agent enable|disable|status <project-id>
  ctxbridge agent profile list
  ctxbridge agent profile add <name> --model <model-id> --effort <effort>
  ctxbridge agent profile remove <name>
  ctxbridge agent profile default <name>
  ctxbridge agent policy show <project-id>
  ctxbridge agent policy set <project-id> --allow-profile <name>... [--default-profile <name>]
  ctxbridge doctor
  ctxbridge mcp --stdio
  ctxbridge mcp --http [--port 7331]
  ctxbridge --version
  ctxbridge --help
`;

export interface CliIO {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  cwd: string;
  confirm?: (prompt: string) => Promise<boolean>;
}

export interface CliDependencies {
  /** Internal seam for deterministic doctor tests; not user- or MCP-configurable. */
  createAgentAdapter?: () => AgentAdapter;
}

function defaultIO(): CliIO {
  const canConfirm = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  return {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
    cwd: process.cwd(),
    ...(canConfirm
      ? {
          confirm: async (prompt: string) => {
            const readline = createInterface({
              input: process.stdin,
              output: process.stdout,
            });
            try {
              return (await readline.question(prompt)) === "enable";
            } catch {
              return false;
            } finally {
              readline.close();
            }
          },
        }
      : {}),
  };
}

const AGENT_ENABLE_WARNING = `SECURITY WARNING: Enabling agent authorization is stronger than read-only Context Bridge access.
Codex will eventually receive direct read/write access to this project and may modify its files. Context Bridge's sensitive-file denylist will not mediate Codex's own reads. Execution will rely on the Codex/OS sandbox as an additional boundary, not as a guarantee. M1 records authorization only; it does not start Codex or execute project work.
`;

function requireProjectId(value: string | undefined): string {
  if (
    !value ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value) ||
    value.length > 64
  ) {
    throw new ContextBridgeError("usage", "Provide a valid project ID.");
  }
  return value;
}

function requireProfileName(value: string | undefined): string {
  const parsed = ProfileNameSchema.safeParse(value);
  if (!parsed.success) {
    throw new ContextBridgeError("usage", "Provide a valid profile name.");
  }
  return parsed.data;
}

function formatProjectPolicy(status: ProjectPolicyStatus): string {
  const authorization = status.authorization;
  const storedState = authorization
    ? authorization.enabled
      ? "enabled"
      : "disabled"
    : "none";
  const projectDefault =
    authorization?.default_profile ?? status.policy.default_profile;
  const allowed = authorization?.allowed_profiles.join(", ") ?? "none";
  return [
    `Authorization: ${status.enabled ? "enabled" : "disabled"}`,
    `Stored authorization: ${storedState}`,
    `Registration identity: ${status.registration_state.replaceAll("_", " ")}`,
    `Global default profile: ${status.policy.default_profile}`,
    `Project default profile: ${projectDefault}`,
    `Allowed profiles: ${allowed}`,
    "",
  ].join("\n");
}

function parseProfileAdd(args: string[]): {
  name: string;
  profile: AgentProfile;
} {
  const name = requireProfileName(args[0]);
  let model: string | undefined;
  let effort: string | undefined;
  for (let index = 1; index < args.length; index += 1) {
    const option = args[index];
    const value = args[index + 1];
    if (option !== "--model" && option !== "--effort") {
      throw new ContextBridgeError(
        "usage",
        `Unknown profile option "${option}".`,
      );
    }
    if (!value || value.startsWith("--")) {
      throw new ContextBridgeError("usage", `${option} requires a value.`);
    }
    if (option === "--model") {
      if (model !== undefined)
        throw new ContextBridgeError("usage", "--model may be specified once.");
      model = value;
    } else {
      if (effort !== undefined)
        throw new ContextBridgeError(
          "usage",
          "--effort may be specified once.",
        );
      effort = value;
    }
    index += 1;
  }
  const profile = AgentProfileSchema.safeParse({
    model_id: model,
    reasoning_effort: effort,
  });
  if (!profile.success) {
    throw new ContextBridgeError(
      "invalid_profile",
      "Provide a valid model ID and reasoning-effort identifier. M1 does not verify Codex model support.",
    );
  }
  return { name, profile: profile.data };
}

function parsePolicySet(args: string[]): {
  projectId: string;
  allowedProfiles: string[];
  defaultProfile?: string;
} {
  const projectId = requireProjectId(args[0]);
  const allowedProfiles: string[] = [];
  let defaultProfile: string | undefined;
  let sawAllowFlag = false;
  for (let index = 1; index < args.length;) {
    const option = args[index];
    if (option === "--allow-profile") {
      sawAllowFlag = true;
      index += 1;
      let values = 0;
      while (index < args.length && !args[index]?.startsWith("--")) {
        const profile = requireProfileName(args[index]);
        if (allowedProfiles.includes(profile)) {
          throw new ContextBridgeError(
            "usage",
            `Profile "${profile}" was listed more than once.`,
          );
        }
        allowedProfiles.push(profile);
        values += 1;
        index += 1;
      }
      if (values === 0) {
        throw new ContextBridgeError(
          "usage",
          "--allow-profile requires at least one profile name.",
        );
      }
      continue;
    }
    if (option === "--default-profile") {
      if (defaultProfile !== undefined) {
        throw new ContextBridgeError(
          "usage",
          "--default-profile may be specified once.",
        );
      }
      defaultProfile = requireProfileName(args[index + 1]);
      index += 2;
      continue;
    }
    throw new ContextBridgeError("usage", `Unknown policy option "${option}".`);
  }
  if (!sawAllowFlag || allowedProfiles.length === 0) {
    throw new ContextBridgeError(
      "usage",
      "policy set requires --allow-profile followed by one or more profile names.",
    );
  }
  return {
    projectId,
    allowedProfiles,
    ...(defaultProfile ? { defaultProfile } : {}),
  };
}

async function gitAvailable(): Promise<boolean> {
  return await new Promise((resolve) => {
    const child = spawn("git", ["--version"], {
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "ignore", "ignore"],
    });
    child.once("error", () => resolve(false));
    child.once("close", (code) => resolve(code === 0));
  });
}

async function commandInit(io: CliIO): Promise<void> {
  const registryPath = await ensureRegistry();
  await readRegistry();
  io.stdout(`Context Bridge is initialized. Registry: ${registryPath}\n`);
}

async function commandProject(args: string[], io: CliIO): Promise<void> {
  const [action, ...rest] = args;
  if (!action || action === "--help" || action === "-h") {
    io.stdout(`${HELP.split("\n").slice(4, 10).join("\n")}\n`);
    return;
  }
  if (action === "add") {
    if (rest.length > 1)
      throw new ContextBridgeError(
        "usage",
        "project add accepts at most one path.",
      );
    await ensureRegistry();
    const inputPath = rest[0] ? path.resolve(io.cwd, rest[0]) : io.cwd;
    const project = await addProject(inputPath);
    io.stdout(
      `Registered ${project.name} as ${project.id}\nPath: ${project.root}\n`,
    );
    return;
  }
  if (action === "list") {
    if (rest.length > 0)
      throw new ContextBridgeError("usage", "project list takes no arguments.");
    const registry = await readRegistry();
    io.stdout("ID\tNAME\tAVAILABILITY\n");
    if (registry.projects.length === 0) {
      io.stdout(
        "No projects registered. Use `ctxbridge project add [path]`.\n",
      );
      return;
    }
    for (const project of registry.projects) {
      let availability = "unavailable";
      try {
        await stat(project.root);
        availability = (await isGitRepository(project)) ? "git" : "not git";
      } catch {
        // Keep a missing root visible in the local CLI so it can be diagnosed.
      }
      io.stdout(`${project.id}\t${project.name}\t${availability}\n`);
    }
    return;
  }
  if (action === "show") {
    if (rest.length !== 1)
      throw new ContextBridgeError(
        "usage",
        "project show requires one project ID.",
      );
    const project = await getProject(rest[0] ?? "");
    io.stdout(
      `ID: ${project.id}\nName: ${project.name}\nPath: ${project.root}\nAdded: ${project.addedAt}\nGit repository: ${(await isGitRepository(project)) ? "yes" : "no"}\n`,
    );
    return;
  }
  if (action === "remove") {
    if (rest.length !== 1)
      throw new ContextBridgeError(
        "usage",
        "project remove requires one project ID.",
      );
    const removed = await removeProject(rest[0] ?? "");
    io.stdout(`Removed ${removed.id}. Project files were not changed.\n`);
    return;
  }
  throw new ContextBridgeError("usage", `Unknown project command "${action}".`);
}

async function commandAgent(
  args: string[],
  io: CliIO,
  createAgentAdapter: () => AgentAdapter,
): Promise<void> {
  const [area, action, ...rest] = args;
  if (area === "enable" || area === "disable" || area === "status") {
    if (!action || rest.length !== 0) {
      throw new ContextBridgeError(
        "usage",
        `agent ${area} requires exactly one project ID.`,
      );
    }
    const projectId = requireProjectId(action);
    if (area === "status") {
      const status = await getProjectPolicyStatus(projectId);
      if (
        status.registration_state === "not_registered" &&
        !status.authorization
      ) {
        throw new ContextBridgeError(
          "project_not_found",
          `No registered project or stored agent policy has ID "${projectId}".`,
        );
      }
      io.stdout(`Project: ${projectId}\n${formatProjectPolicy(status)}`);
      return;
    }

    if (area === "enable") {
      const project = await getProject(projectId);
      if (!(await isGitRepository(project))) {
        throw new ContextBridgeError(
          "project_not_git",
          "Agent authorization can be enabled only for a registered Git repository.",
        );
      }
      const initialPolicy = await readAgentPolicy();
      io.stdout(AGENT_ENABLE_WARNING);
      if (!io.confirm) {
        throw new ContextBridgeError(
          "confirmation_required",
          "Enabling agent authorization requires an interactive terminal; no policy was changed.",
        );
      }
      let confirmed: boolean;
      try {
        confirmed = await io.confirm('Type "enable" to confirm: ');
      } catch {
        confirmed = false;
      }
      if (!confirmed) {
        throw new ContextBridgeError(
          "confirmation_declined",
          "Confirmation was declined or unavailable; no policy was changed.",
        );
      }
      const currentProject = await getProject(projectId);
      if (!sameProjectRegistration(project, currentProject)) {
        throw new ContextBridgeError(
          "project_registration_changed",
          "The project registration changed during confirmation; no policy was changed.",
        );
      }
      if (!(await isGitRepository(currentProject))) {
        throw new ContextBridgeError(
          "project_not_git",
          "The project is no longer an accessible Git repository; no policy was changed.",
        );
      }
      const authorization = await enableProjectAuthorization(
        currentProject,
        initialPolicy.default_profile,
      );
      io.stdout(
        `Agent authorization enabled for ${projectId}. Allowed profiles: ${authorization.allowed_profiles.join(", ")}.\n`,
      );
      return;
    }

    const registry = await readRegistry();
    const project = registry.projects.find((entry) => entry.id === projectId);
    if (!project) {
      throw new ContextBridgeError(
        "project_not_found",
        `No registered project has ID "${projectId}".`,
      );
    }
    const changed = await disableProjectAuthorization(project);
    io.stdout(
      changed
        ? `Agent authorization disabled for ${projectId}.\n`
        : `Agent authorization is already disabled or does not match the current registration for ${projectId}.\n`,
    );
    return;
  }

  if (area === "profile") {
    if (action === "list") {
      if (rest.length !== 0) {
        throw new ContextBridgeError(
          "usage",
          "agent profile list takes no arguments.",
        );
      }
      const policy = await readAgentPolicy();
      io.stdout("NAME\tMODEL ID\tEFFORT\n");
      for (const [name, profile] of Object.entries(policy.profiles).sort(
        ([left], [right]) => left.localeCompare(right),
      )) {
        io.stdout(
          `${name}\t${profile.model_id}\t${profile.reasoning_effort}${name === policy.default_profile ? " (default)" : ""}\n`,
        );
      }
      io.stdout(
        "Profile additions validate model and effort against the local Codex App Server. Doctor checks configured profiles when agent execution is enabled.\n",
      );
      return;
    }
    if (action === "add") {
      const { name, profile } = parseProfileAdd(rest);
      const currentPolicy = await readAgentPolicy();
      if (Object.hasOwn(currentPolicy.profiles, name)) {
        throw new ContextBridgeError(
          "profile_exists",
          `Agent profile "${name}" already exists.`,
        );
      }
      const adapter = createAgentAdapter();
      try {
        await adapter.start();
        await adapter.requireAuthentication();
        await adapter.validateProfile(profile);
        await addAgentProfile(name, profile);
      } finally {
        await adapter.close().catch(() => undefined);
      }
      io.stdout(`Added agent profile ${name}.\n`);
      return;
    }
    if (action === "remove") {
      if (rest.length !== 1) {
        throw new ContextBridgeError(
          "usage",
          "agent profile remove requires one name.",
        );
      }
      const name = requireProfileName(rest[0]);
      await removeAgentProfile(name);
      io.stdout(`Removed agent profile ${name}.\n`);
      return;
    }
    if (action === "default") {
      if (rest.length !== 1) {
        throw new ContextBridgeError(
          "usage",
          "agent profile default requires one name.",
        );
      }
      const name = requireProfileName(rest[0]);
      await setGlobalDefaultProfile(name);
      io.stdout(`Global default profile is now ${name}.\n`);
      return;
    }
    throw new ContextBridgeError(
      "usage",
      `Unknown agent profile command "${action ?? ""}".`,
    );
  }

  if (area === "policy") {
    if (action === "show") {
      if (rest.length !== 1) {
        throw new ContextBridgeError(
          "usage",
          "agent policy show requires one project ID.",
        );
      }
      const projectId = requireProjectId(rest[0]);
      const status = await getProjectPolicyStatus(projectId);
      if (
        status.registration_state === "not_registered" &&
        !status.authorization
      ) {
        throw new ContextBridgeError(
          "project_not_found",
          `No registered project or stored agent policy has ID "${projectId}".`,
        );
      }
      io.stdout(`Project: ${projectId}\n${formatProjectPolicy(status)}`);
      return;
    }
    if (action === "set") {
      const parsed = parsePolicySet(rest);
      const project = await getProject(parsed.projectId);
      const authorization = await setProjectAllowedProfiles(
        project,
        parsed.allowedProfiles,
        parsed.defaultProfile,
      );
      io.stdout(
        `Updated agent policy for ${parsed.projectId}. Default: ${authorization.default_profile ?? "global"}; allowed: ${authorization.allowed_profiles.join(", ")}.\n`,
      );
      return;
    }
    throw new ContextBridgeError(
      "usage",
      `Unknown agent policy command "${action ?? ""}".`,
    );
  }

  throw new ContextBridgeError(
    "usage",
    `Unknown agent command "${area ?? ""}".`,
  );
}

async function commandDoctor(
  io: CliIO,
  createAgentAdapter: () => AgentAdapter,
): Promise<void> {
  let registryExists = true;
  try {
    await access(getRegistryPath(), constants.F_OK);
  } catch {
    registryExists = false;
  }
  const hasGit = await gitAvailable();
  io.stdout(
    `Node.js: ${process.versions.node} (${Number(process.versions.node.split(".")[0]) >= 20 ? "supported" : "requires Node 20+"})\n`,
  );
  io.stdout(`Git: ${hasGit ? "available" : "not found on PATH"}\n`);
  io.stdout(`Registry: ${registryExists ? "available" : "not initialized"}\n`);
  if (!registryExists) {
    await commandAgentDoctor(io, createAgentAdapter);
    return;
  }
  const registry = await readRegistry();
  if (registry.projects.length === 0) {
    io.stdout("Projects: none registered\n");
  } else {
    for (const project of registry.projects) {
      try {
        const checked = await getProject(project.id);
        io.stdout(
          `Project ${project.id}: available; Git ${(await isGitRepository(checked)) ? "repository" : "not a repository"}\n`,
        );
      } catch (error) {
        const message =
          error instanceof ContextBridgeError ? error.message : "unavailable";
        io.stdout(`Project ${project.id}: ${message}\n`);
      }
    }
  }
  await commandAgentDoctor(io, createAgentAdapter);
}

function agentErrorCode(error: unknown): AgentAdapterErrorCode | undefined {
  return error instanceof AgentAdapterError ? error.code : undefined;
}

async function commandAgentDoctor(
  io: CliIO,
  createAgentAdapter: () => AgentAdapter,
): Promise<void> {
  let policyFileExists = true;
  try {
    await access(getAgentPolicyPath(), constants.F_OK);
  } catch {
    policyFileExists = false;
  }

  let policy: Awaited<ReturnType<typeof readAgentPolicy>>;
  try {
    policy = await readAgentPolicy();
  } catch (error) {
    if (
      error instanceof ContextBridgeError &&
      error.code === "agent_policy_invalid"
    ) {
      io.stdout("Agent policy: invalid; agent authorization fails closed\n");
      io.stdout(
        "Codex App Server: not checked (agent authorization state unavailable)\n",
      );
      return;
    }
    if (
      error instanceof ContextBridgeError &&
      error.code === "agent_policy_unavailable"
    ) {
      io.stdout(
        "Agent policy: unavailable; agent authorization fails closed\n",
      );
      io.stdout(
        "Codex App Server: not checked (agent authorization state unavailable)\n",
      );
      return;
    }
    throw error;
  }

  io.stdout(
    `Agent policy: valid${policyFileExists ? "" : " (safe defaults; file not created)"}\n`,
  );
  io.stdout(`Agent global default: ${policy.default_profile}\n`);
  io.stdout(
    `Agent profiles: ${Object.keys(policy.profiles).length} structurally valid\n`,
  );

  let enabled = 0;
  let disabled = 0;
  let stale = 0;
  const enabledPolicies: ProjectPolicyStatus[] = [];
  for (const projectId of Object.keys(policy.projects)) {
    const status = await getProjectPolicyStatus(projectId);
    if (status.registration_state !== "matching") stale += 1;
    else if (status.enabled) {
      enabled += 1;
      enabledPolicies.push(status);
    } else disabled += 1;
  }
  io.stdout(
    `Agent authorization: ${enabled} enabled; ${disabled} disabled; ${stale} stale or mismatched\n`,
  );

  if (enabledPolicies.length === 0) {
    io.stdout("Codex App Server: not checked (agent execution not enabled)\n");
    return;
  }

  const adapter = createAgentAdapter();
  let backend: AgentBackendInfo;
  try {
    try {
      backend = await adapter.start();
    } catch (error) {
      const code = agentErrorCode(error);
      if (code === "codex_not_found") {
        io.stdout("Codex executable: missing\n");
        io.stdout("App Server handshake: not available\n");
      } else {
        const executableStatus =
          code === "app_server_start_failed" ? "could not start" : "found";
        io.stdout(`Codex executable: ${executableStatus}\n`);
        io.stdout(
          `App Server handshake: ${
            code === "app_server_incompatible" ||
            code === "app_server_protocol_error"
              ? "incompatible"
              : "unavailable"
          }\n`,
        );
      }
      io.stdout("Local Codex authentication: not checked\n");
      io.stdout("Codex model discovery: not checked\n");
      io.stdout("Agent default profile: unavailable\n");
      io.stdout("Enabled project profiles: unavailable\n");
      return;
    }

    io.stdout("Codex executable: found\n");
    io.stdout("App Server handshake: compatible\n");
    io.stdout(
      `Codex version: ${backend.version ?? "not reported by App Server"}\n`,
    );

    try {
      const authenticated = await adapter.checkAuthentication();
      io.stdout(
        `Local Codex authentication: ${authenticated ? "available" : "unavailable"}\n`,
      );
    } catch {
      io.stdout("Local Codex authentication: unavailable (check failed)\n");
    }

    let models: AgentModel[];
    try {
      models = await adapter.listModels();
      io.stdout("Codex model discovery: available\n");
    } catch {
      io.stdout("Codex model discovery: unavailable\n");
      io.stdout("Agent default profile: unavailable\n");
      io.stdout("Enabled project profiles: unavailable\n");
      return;
    }

    const defaultProfile: AgentProfile | undefined =
      policy.profiles[policy.default_profile];
    let defaultValid = false;
    try {
      if (!defaultProfile) throw new AgentAdapterError("model_unavailable");
      validateProfileCapabilities(defaultProfile, models);
      defaultValid = true;
    } catch {
      defaultValid = false;
    }
    io.stdout(
      `Agent default profile ${policy.default_profile}: ${defaultValid ? "valid" : "invalid"}\n`,
    );

    let validProjectProfiles = 0;
    let invalidProjectProfiles = 0;
    for (const status of enabledPolicies) {
      for (const profileName of status.authorization?.allowed_profiles ?? []) {
        const profile = policy.profiles[profileName];
        try {
          if (!profile) throw new AgentAdapterError("model_unavailable");
          validateProfileCapabilities(profile, models);
          validProjectProfiles += 1;
        } catch {
          invalidProjectProfiles += 1;
        }
      }
    }
    io.stdout(
      `Enabled project profiles: ${validProjectProfiles} valid; ${invalidProjectProfiles} invalid\n`,
    );
  } finally {
    await adapter.close().catch(() => undefined);
  }
}

async function commandMcp(args: string[]): Promise<void> {
  let mode: "stdio" | "http" | undefined;
  let port = 7331;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--stdio") {
      if (mode)
        throw new ContextBridgeError("usage", "Choose one MCP transport.");
      mode = "stdio";
    } else if (argument === "--http") {
      if (mode)
        throw new ContextBridgeError("usage", "Choose one MCP transport.");
      mode = "http";
    } else if (argument === "--port") {
      if (mode === "stdio")
        throw new ContextBridgeError("usage", "--port applies only to --http.");
      const value = args[index + 1];
      if (!value || !/^\d+$/.test(value))
        throw new ContextBridgeError(
          "invalid_port",
          "--port requires a number between 1 and 65535.",
        );
      port = Number(value);
      index += 1;
    } else {
      throw new ContextBridgeError(
        "usage",
        `Unknown MCP option "${argument}".`,
      );
    }
  }
  if (mode === "stdio") {
    await startStdioServer();
    return;
  }
  if (mode === "http") {
    await startHttpServer(port);
    return;
  }
  throw new ContextBridgeError(
    "usage",
    "Choose an MCP transport: --stdio or --http.",
  );
}

export async function runCli(
  argv: string[],
  io: CliIO = defaultIO(),
  dependencies: CliDependencies = {},
): Promise<number> {
  const args = [...argv];
  try {
    const first = args[0];
    if (!first || first === "--help" || first === "-h") {
      io.stdout(HELP);
      return 0;
    }
    if (first === "--version" || first === "-v") {
      io.stdout(`${VERSION}\n`);
      return 0;
    }
    if (first === "init") {
      if (args.length > 1)
        throw new ContextBridgeError("usage", "init takes no arguments.");
      await commandInit(io);
      return 0;
    }
    if (first === "project") {
      await commandProject(args.slice(1), io);
      return 0;
    }
    if (first === "agent") {
      await commandAgent(
        args.slice(1),
        io,
        dependencies.createAgentAdapter ?? getCodexAgentAdapter,
      );
      return 0;
    }
    if (first === "doctor") {
      if (args.length > 1)
        throw new ContextBridgeError("usage", "doctor takes no arguments.");
      await commandDoctor(
        io,
        dependencies.createAgentAdapter ?? getCodexAgentAdapter,
      );
      return 0;
    }
    if (first === "mcp") {
      await commandMcp(args.slice(1));
      return 0;
    }
    throw new ContextBridgeError(
      "usage",
      `Unknown command "${first}". Use --help for usage.`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    io.stderr(`ctxbridge: ${message}\n`);
    return 1;
  }
}
