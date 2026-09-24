# Codex MCP setup

Context Bridge's stdio transport is the recommended local connection. Install Node.js 20+, pnpm, and Git, then install and build Context Bridge from its checkout:

```sh
pnpm install
pnpm build
pnpm add -g .
ctxbridge init
ctxbridge project add C:\code\my-project
```

If `ctxbridge` is not found after installation, run `pnpm setup` to configure
pnpm's global executable directory, then open a new terminal.

Add the MCP server to Codex's user or project MCP configuration using the supported `mcpServers` format:

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

Restart or reload Codex's MCP servers, then ask it to call `projects_list`. Select a registered ID with `project_get` before reading or searching files. The server's instructions ask clients to inspect Git status and retrieve only relevant paths.

To use the local HTTP endpoint instead, run `ctxbridge mcp --http --port 7331` and configure a client that supports Streamable HTTP at `http://127.0.0.1:7331/mcp`. It remains bound to this computer.
