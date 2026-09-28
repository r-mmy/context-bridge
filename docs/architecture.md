# Architecture

Context Bridge is one pnpm package with clear internal boundaries:

- `cli/` parses commands and presents local diagnostics.
- `config/` identifies the per-user config location; `projects/` reads and writes the explicit project registry.
- `security/` owns path normalization, canonical containment, denylist, and bounded ignore-file evaluation.
- `filesystem/` implements streamed, work-bounded listings and directory search, plus UTF-8-safe text reads.
- `git/` discovers the canonical worktree, scopes every operation to the registered root, disables transport and lazy-fetch behavior, and filters every returned path through the shared security policy.
- `mcp/` defines tool names, schemas, annotations, and model-facing descriptions.
- `transports/` starts the stdio or Streamable HTTP transport around the same MCP server factory.

The registry stores a project ID, display name, canonical local root, and registration timestamp. Its absolute paths stay on the user's machine. Tool calls look up the registry for each request so registration removal takes effect immediately.

The HTTP transport uses the SDK's per-request MCP handler through the Node adapter. It binds to loopback and validates Host and Origin before passing requests to the handler. Stdio writes protocol messages to stdout; diagnostics go to stderr.

Successful tool results include the same JSON object in both `structuredContent` and a JSON text content block. Structured clients can consume the typed result directly, while clients that only handle standard text content can still parse the complete result. This follows the MCP [backwards-compatibility guidance for structured tool results](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/specification/2026-07-28/server/tools.mdx); both copies count toward the encoded response-size limit.

## Future releases

Agent execution and orchestration are outside v0.1. The current package does not define an `AgentAdapter`, invoke Codex, or expose a generic command runner.

## v0.2 Codex task boundary

The v0.2 task subsystem is a separate, explicitly authorized stdio capability.
It launches only the managed, version-pinned Codex App Server and reasserts the
registered workspace root, workspace-write sandbox, disabled network, and
approval-never policy for each turn. The existing v0.1 inspection tools remain
read-only, and the HTTP MCP surface exposes no task operations. Agent writes
are performed directly by Codex under its runtime and operating-system
sandbox; the v0.1 path denylist does not filter Codex reads.

The 0.157.1 App Server and native Codex Desktop use project registries that did
not share project identity or state in the spike. Context Bridge therefore
keeps v0.2 App Server threads projectless and does not attempt sidebar
association. This affects Desktop grouping only; native Desktop can still
show and use the threads, including same-thread continuation.
