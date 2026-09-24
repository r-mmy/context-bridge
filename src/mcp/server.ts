import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import {
  readRegistry,
  getProject,
  type ProjectRecord,
} from "../projects/registry.js";
import { ContextBridgeError } from "../security/errors.js";
import { listFiles, searchFiles } from "../filesystem/walk.js";
import { DEFAULT_OUTPUT_BYTES, readTextFile } from "../filesystem/read.js";
import { isGitRepository } from "../git/run.js";
import {
  getGitDiff,
  getGitLog,
  getGitShow,
  getGitStatus,
} from "../git/service.js";

const PROJECT_ID = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  openWorldHint: false,
} as const;
// The MCP payload carries both JSON text content and structuredContent, so
// its encoded envelope can be larger than the 1 MiB source-data limits.
const MAX_MCP_ENVELOPE_BYTES = 16 * 1024 * 1024;

function jsonResult(value: unknown) {
  const serialized = JSON.stringify(value);
  const result = {
    content: [{ type: "text" as const, text: serialized }],
    structuredContent: value as Record<string, unknown>,
  };
  if (
    Buffer.byteLength(JSON.stringify(result), "utf8") > MAX_MCP_ENVELOPE_BYTES
  ) {
    throw new ContextBridgeError(
      "output_limit",
      "The result exceeded the 16 MiB encoded MCP response limit.",
    );
  }
  return result;
}

function toolError(error: unknown) {
  const code =
    error instanceof ContextBridgeError ? error.code : "internal_error";
  const message =
    error instanceof ContextBridgeError
      ? error.message
      : "The requested read-only operation failed.";
  return {
    isError: true,
    content: [{ type: "text" as const, text: `${code}: ${message}` }],
  };
}

async function runTool<T>(operation: () => Promise<T>) {
  try {
    return jsonResult(await operation());
  } catch (error) {
    return toolError(error);
  }
}

async function projectCapabilities(project: ProjectRecord) {
  let available = true;
  try {
    await getProject(project.id);
  } catch {
    available = false;
  }
  let gitRepository = false;
  if (available) {
    try {
      gitRepository = await isGitRepository(project);
    } catch {
      gitRepository = false;
    }
  }
  return {
    project_id: project.id,
    display_name:
      project.name.replace(/\\/g, "/").replace(/\/+$/g, "").split("/").at(-1) ||
      "Project",
    available,
    capabilities: {
      files_list: available,
      files_search: available,
      file_read: available,
      git_repository: gitRepository,
      git_status: gitRepository,
      git_diff: gitRepository,
      git_log: gitRepository,
      git_show: gitRepository,
    },
  };
}

export function createContextBridgeServer(): McpServer {
  const server = new McpServer(
    {
      name: "Context Bridge",
      version: "0.1.0",
    },
    {
      instructions:
        "Use this server only to inspect explicitly registered local projects. Discover a project with projects_list or project_get, then inspect Git status before assuming repository state. Search narrowly before reading large files, retrieve only relevant paths, and use git_diff when reviewing recent implementation work. Do not claim to have inspected code that was not returned by a tool. All tools are read-only.",
    },
  );

  server.registerTool(
    "projects_list",
    {
      description:
        "List projects the user explicitly registered with Context Bridge. Returns IDs, display names, availability, and capabilities without local filesystem paths.",
      inputSchema: z.object({}),
      annotations: READ_ONLY,
    },
    async () =>
      runTool(async () => {
        const registry = await readRegistry();
        const projects: Awaited<ReturnType<typeof projectCapabilities>>[] = [];
        let truncated = registry.projects.length > 500;
        let bytes = 0;
        for (const project of registry.projects.slice(0, 500)) {
          const metadata = await projectCapabilities(project);
          const size = Buffer.byteLength(JSON.stringify(metadata), "utf8");
          if (bytes + size > 256 * 1024) {
            truncated = true;
            break;
          }
          projects.push(metadata);
          bytes += size;
        }
        return { projects, truncated };
      }),
  );

  server.registerTool(
    "project_get",
    {
      description:
        "Get metadata and capabilities for one registered project ID. Absolute local paths are never returned.",
      inputSchema: z.object({ project_id: PROJECT_ID }),
      annotations: READ_ONLY,
    },
    async ({ project_id }) =>
      runTool(async () => {
        const registry = await readRegistry();
        const project = registry.projects.find(
          (entry) => entry.id === project_id,
        );
        if (!project)
          throw new ContextBridgeError(
            "project_not_found",
            `No registered project has ID "${project_id}".`,
          );
        return await projectCapabilities(project);
      }),
  );

  server.registerTool(
    "files_list",
    {
      description:
        "List files and directories inside a registered project. Paths are project-relative; hidden entries are omitted unless include_hidden is true.",
      inputSchema: z.object({
        project_id: PROJECT_ID,
        path: z.string().max(4096).optional(),
        depth: z.number().int().min(1).max(8).default(1),
        max_entries: z.number().int().min(1).max(1000).default(200),
        include_hidden: z.boolean().default(false),
      }),
      annotations: READ_ONLY,
    },
    async ({
      project_id,
      path: requestedPath,
      depth,
      max_entries,
      include_hidden,
    }) =>
      runTool(async () => {
        const project = await getProject(project_id);
        const result = await listFiles(project, {
          ...(requestedPath === undefined ? {} : { path: requestedPath }),
          depth,
          maxEntries: max_entries,
          includeHidden: include_hidden,
        });
        return { project_id, path: requestedPath ?? ".", ...result };
      }),
  );

  server.registerTool(
    "files_search",
    {
      description:
        "Search a registered project by literal text or regular expression. Results contain project-relative paths and line numbers. Search is bounded and excludes hidden, ignored, and denied files.",
      inputSchema: z.object({
        project_id: PROJECT_ID,
        query: z
          .string()
          .min(1)
          .max(256)
          .refine((value) => !value.includes("\0")),
        path: z.string().max(4096).optional(),
        glob: z
          .string()
          .max(256)
          .refine((value) => !value.includes("\0"))
          .optional(),
        mode: z.enum(["literal", "regex"]).default("literal"),
        context_lines: z.number().int().min(0).max(10).default(0),
        max_results: z.number().int().min(1).max(1000).default(100),
        max_bytes: z
          .number()
          .int()
          .min(1)
          .max(1024 * 1024)
          .default(DEFAULT_OUTPUT_BYTES),
      }),
      annotations: READ_ONLY,
    },
    async ({
      project_id,
      query,
      path: requestedPath,
      glob,
      mode,
      context_lines,
      max_results,
      max_bytes,
    }) =>
      runTool(async () => {
        const project = await getProject(project_id);
        return {
          project_id,
          ...(await searchFiles(project, {
            query,
            ...(requestedPath === undefined ? {} : { path: requestedPath }),
            ...(glob === undefined ? {} : { glob }),
            mode,
            contextLines: context_lines,
            maxResults: max_results,
            maxBytes: max_bytes,
          })),
        };
      }),
  );

  server.registerTool(
    "file_read",
    {
      description:
        "Read a bounded text range from one allowed project-relative file. Binary files, ignored files, secret files, and paths outside the registered root are rejected.",
      inputSchema: z.object({
        project_id: PROJECT_ID,
        path: z.string().min(1).max(4096),
        start_line: z.number().int().min(1).default(1),
        max_lines: z.number().int().min(1).max(2000).default(400),
        max_bytes: z
          .number()
          .int()
          .min(1)
          .max(1024 * 1024)
          .default(DEFAULT_OUTPUT_BYTES),
      }),
      annotations: READ_ONLY,
    },
    async ({
      project_id,
      path: requestedPath,
      start_line,
      max_lines,
      max_bytes,
    }) =>
      runTool(async () => {
        const project = await getProject(project_id);
        return {
          project_id,
          ...(await readTextFile(project, requestedPath, {
            startLine: start_line,
            maxLines: max_lines,
            maxBytes: max_bytes,
          })),
        };
      }),
  );

  server.registerTool(
    "git_status",
    {
      description:
        "Return structured status for the registered project's Git repository. Paths excluded by the Context Bridge security policy are omitted.",
      inputSchema: z.object({ project_id: PROJECT_ID }),
      annotations: READ_ONLY,
    },
    async ({ project_id }) =>
      runTool(async () => {
        const project = await getProject(project_id);
        return { project_id, ...(await getGitStatus(project)) };
      }),
  );

  server.registerTool(
    "git_diff",
    {
      description:
        "Review a bounded unified Git patch. working compares HEAD to the current tree, including eligible non-ignored untracked files; staged, unstaged, and refs select narrower comparisons. Denied file content is never returned.",
      inputSchema: z.object({
        project_id: PROJECT_ID,
        mode: z.enum(["working", "staged", "unstaged", "refs"]),
        base: z.string().max(256).optional(),
        head: z.string().max(256).optional(),
        path: z.string().max(4096).optional(),
        max_bytes: z
          .number()
          .int()
          .min(1)
          .max(1024 * 1024)
          .default(DEFAULT_OUTPUT_BYTES),
      }),
      annotations: READ_ONLY,
    },
    async ({ project_id, mode, base, head, path: requestedPath, max_bytes }) =>
      runTool(async () => {
        const project = await getProject(project_id);
        return {
          project_id,
          ...(await getGitDiff(project, {
            mode,
            ...(base === undefined ? {} : { base }),
            ...(head === undefined ? {} : { head }),
            ...(requestedPath === undefined ? {} : { path: requestedPath }),
            maxBytes: max_bytes,
          })),
        };
      }),
  );

  server.registerTool(
    "git_log",
    {
      description:
        "Read recent commit metadata from a registered Git project, optionally limited to one allowed project-relative path.",
      inputSchema: z.object({
        project_id: PROJECT_ID,
        limit: z.number().int().min(1).max(100).default(20),
        path: z.string().max(4096).optional(),
      }),
      annotations: READ_ONLY,
    },
    async ({ project_id, limit, path: requestedPath }) =>
      runTool(async () => {
        const project = await getProject(project_id);
        return {
          project_id,
          ...(await getGitLog(project, {
            limit,
            ...(requestedPath === undefined ? {} : { path: requestedPath }),
          })),
        };
      }),
  );

  server.registerTool(
    "git_show",
    {
      description:
        "Inspect one Git commit or one text file at a revision. Without path, returns commit metadata and a filtered patch; with path, returns the bounded file content. Security filters apply in both forms.",
      inputSchema: z.object({
        project_id: PROJECT_ID,
        revision: z.string().min(1).max(256),
        path: z.string().max(4096).optional(),
        max_bytes: z
          .number()
          .int()
          .min(1)
          .max(1024 * 1024)
          .default(DEFAULT_OUTPUT_BYTES),
      }),
      annotations: READ_ONLY,
    },
    async ({ project_id, revision, path: requestedPath, max_bytes }) =>
      runTool(async () => {
        const project = await getProject(project_id);
        return {
          project_id,
          ...(await getGitShow(project, {
            revision,
            ...(requestedPath === undefined ? {} : { path: requestedPath }),
            maxBytes: max_bytes,
          })),
        };
      }),
  );

  return server;
}
