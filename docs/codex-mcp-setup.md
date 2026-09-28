# Connect Codex Desktop

Context Bridge runs as a local stdio MCP server. After building and installing the CLI as described in the [README](../README.md), add this entry to Codex's user or project MCP configuration using its supported `mcpServers` format:

```json
{
  "mcpServers": {
    "context-bridge": {
      "command": "ctxbridge",
      "args": ["mcp", "--stdio"]
    }
  }
}
```

Restart or reload Codex's MCP servers, then call `projects_list` and select a project with `project_get`. The stdio server exposes nine read-only inspection tools and six task tools. Inspection alone is available to registered projects; task execution still requires a local interactive `ctxbridge agent enable <project-id>` confirmation for each project.

The task tools launch Context Bridge's own managed, pinned Codex App Server process for the selected project. That managed thread is separate from the Codex model and conversation driving the outer Desktop session. It does not create unlimited or recursive agent behavior. See [README](../README.md) for the task workflow, cancellation, recovery, user-input relay, and telemetry. See [SECURITY.md](../SECURITY.md) for the trust boundaries.

To run the server from a source checkout during development, execute `pnpm exec tsx src/cli/main.ts mcp --stdio` from that checkout. For regular Codex MCP configuration, use the globally installed `ctxbridge` command shown above.

## Local HTTP alternative

For a client that needs Streamable HTTP, run:

```sh
ctxbridge mcp --http --port 7331
```

It listens on `127.0.0.1:7331/mcp` and validates Host and Origin. HTTP exposes only the nine read-only inspection tools; it does not register any task tools.
