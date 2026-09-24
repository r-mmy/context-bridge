# Context Bridge

**Read-only local project context for ChatGPT, Codex, and other MCP-compatible assistants.**

Context Bridge lets an assistant inspect files and Git history from projects you explicitly register. Use it when you want an assistant to review your working tree without giving it a general shell or access to the rest of your filesystem. In v0.1, MCP tools cannot modify project files or run arbitrary shell commands. Context Bridge itself has no telemetry or hosted backend.

[![CI](https://github.com/r-mmy/context-bridge/actions/workflows/ci.yml/badge.svg?branch=master)](https://github.com/r-mmy/context-bridge/actions/workflows/ci.yml) [![License](https://img.shields.io/github/license/r-mmy/context-bridge)](LICENSE)

- [Quick start](#quick-start)
- [How it works](#how-it-works)
- [Connect Codex](docs/codex-mcp-setup.md) · [Connect ChatGPT through Secure MCP Tunnel](docs/chatgpt-secure-mcp-tunnel.md)
- [Security policy](SECURITY.md) · [Security model](docs/security-model.md)

## What v0.1 provides

- Explicit project registration; MCP tools select a project by ID and use project-relative paths.
- Bounded file listing, search, and text reads.
- Git repository status, diffs, logs, and show results.
- Shared `.gitignore`, `.contextbridgeignore`, and built-in sensitive-path filtering for file and Git results.
- Local stdio MCP for Codex and other clients, plus loopback-only Streamable HTTP.
- A ChatGPT workflow through Secure MCP Tunnel. The tunnel is an external connection service; Context Bridge itself does not provide a cloud backend.
- A read-only MCP tool surface with no telemetry, file-write tools, arbitrary shell, or agent-task dispatch.

## Quick start

Install Node.js 20 or newer and pnpm 12.4.2, the version pinned by this repository. Git is needed for Git tools; file tools also work in non-Git directories.

Context Bridge is installed from source for v0.1.0. It is intentionally private and is not published to npm.

```sh
git clone https://github.com/r-mmy/context-bridge.git
cd context-bridge
pnpm install --frozen-lockfile
pnpm build
pnpm add -g .
ctxbridge init
ctxbridge project add /path/to/project
ctxbridge doctor
```

On Windows PowerShell, register a project with a Windows path, for example:

```powershell
ctxbridge project add C:\code\my-project
```

If `ctxbridge` is not found after installation, run `pnpm setup` to configure pnpm's global executable directory, then open a new terminal.

To register the current directory, run `ctxbridge project add` without a path. Use `ctxbridge project list` to see registered IDs. Removing a registration removes only its local registry entry.

## How it works

```text
User: "Review what changed in my project."
                 │
        ChatGPT via Secure MCP Tunnel
        or Codex via local stdio MCP
                 │
                 ▼
       Context Bridge on this computer
          ├─ projects_list / project_get
          ├─ files_list / files_search / file_read
          └─ git_status / git_diff / git_log / git_show
                 │
                 ▼
        explicitly registered project
```

The assistant uses returned context to answer you. Context Bridge v0.1 does not dispatch coding tasks to Codex or edit the project.

## Connect an assistant

- **Codex:** follow the [local MCP setup](docs/codex-mcp-setup.md).
- **ChatGPT:** follow [ChatGPT through Secure MCP Tunnel](docs/chatgpt-secure-mcp-tunnel.md). ChatGPT does not launch a local process directly.
- **Other clients:** configure the stdio command `ctxbridge` with arguments `mcp --stdio`. For clients that require HTTP, run `ctxbridge mcp --http --port 7331`; it listens on `127.0.0.1` and validates Host and Origin.

## Security and trust

Only roots registered locally by the user are available to MCP. File and Git operations share the same containment, ignore, and sensitive-file policy; absolute project paths are not returned in MCP results. The CLI writes only local registry data when you initialize or manage registrations.

Read the [security policy](SECURITY.md) for exact defaults, resource bounds, and limitations, including same-user filesystem races and loopback HTTP authentication. See the [security model](docs/security-model.md) for implementation details.

## Development and contributing

See [contributing](CONTRIBUTING.md) for setup and validation commands, and [architecture](docs/architecture.md) for the code layout. The CI matrix covers Windows, Ubuntu, and macOS on Node.js 20 and 24.
