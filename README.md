# Context Bridge

Context Bridge is a read-only MCP server and CLI for sharing approved local development projects with AI assistants. It lets MCP-compatible clients inspect files and Git history from the same live filesystem without granting a general shell or arbitrary filesystem access.

## v0.1 trust model

Only project roots registered by the user are available. MCP clients address them by project ID and use project-relative paths. The server has no file-writing, arbitrary command, commit, or agent-execution tools. It has no telemetry or cloud dependency. The CLI writes only the local project registry when you initialize or change registrations.

File and Git results use the same path containment, ignore, and sensitive-file rules. Git stays inside the registered root even when that root is nested in a larger worktree. MCP-facing Git reads disable transport protocols and lazy fetching; a partial clone with a missing local object can return an error. `.gitignore` is honored by default; `.contextbridgeignore` can add patterns or re-include ordinary ignored files. Ignore files are contained and size-limited. The built-in secret denylist cannot be overridden, and Windows alternate data streams are unsupported. See [SECURITY.md](SECURITY.md) for exact limits and known constraints.

## Requirements

- Node.js 20 or newer
- pnpm
- Git for Git tools; file tools also work for non-Git directories
- Optional: [ripgrep](https://github.com/BurntSushi/ripgrep) for faster searches of an individual file; directory searches use a bounded native walk

## Develop locally

```sh
pnpm install
pnpm build
pnpm lint
pnpm format:check
pnpm typecheck
pnpm test
```

The checkout exposes the CLI through pnpm scripts:

```sh
pnpm ctxbridge --help
pnpm ctxbridge init
pnpm ctxbridge project add .
pnpm ctxbridge project list
pnpm ctxbridge doctor
```

To start a server from the checkout:

```sh
pnpm ctxbridge mcp --stdio
pnpm ctxbridge mcp --http --port 7331
```

The HTTP endpoint binds only to `127.0.0.1` and serves `/mcp`. It validates Host and Origin headers. It does not accept a bearer token in v0.1.

## Register a project

```sh
ctxbridge init
ctxbridge project add C:\\code\\my-project
ctxbridge project list
ctxbridge project show my-project
ctxbridge project remove my-project
```

If `project add` has no path, it registers the current directory. IDs are generated from the folder name, made unique with a numeric suffix when needed, and stay stable after registration. The registry is stored under the operating system's per-user config directory. Only the CLI displays the saved absolute root; MCP responses do not.

`ctxbridge doctor` checks the Node version, Git availability, registry, and registered roots. Removing a project removes its registry entry only.

## Connect an MCP client

For a local process client, configure the command and arguments:

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

If running directly from this checkout, replace `ctxbridge` with the absolute path to Node and pass the built `dist/cli/main.js` path followed by `mcp --stdio` as arguments. See [Codex MCP setup](docs/codex-mcp-setup.md).

ChatGPT cannot launch a local process directly. The recommended connection uses Secure MCP Tunnel to launch Context Bridge over stdio; local Streamable HTTP remains available for tunnel configurations that require HTTP. See [ChatGPT setup](docs/chatgpt-secure-mcp-tunnel.md).

## Architecture

The one-package codebase separates CLI and registry management from project resolution, security policy, filesystem reads, Git reads, MCP tool definitions, and transport startup. Both transports use the same MCP server factory and tools. The portable files under `plugin/` contain the stdio MCP configuration and the project-context skill; the core server remains usable by any MCP-compatible client.

Read [architecture](docs/architecture.md), [security model](docs/security-model.md), and [contributing](CONTRIBUTING.md) before changing the access boundary.
