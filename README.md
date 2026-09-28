# Context Bridge

Context Bridge gives MCP-compatible assistants access to explicitly registered local projects. Its file and Git tools are read-only. On stdio only, a project can also opt in to bounded Codex tasks through the locally installed, pinned Codex App Server.

The v0.2 implementation is in this private source repository. Package metadata remains `context-bridge-dev@0.1.0` and is not published. Codex App Server is experimental; Linux and macOS real authenticated execution and sandbox behavior have not been manually verified.

## What it provides

- Project-relative file listing, search, and text reads.
- Filtered Git status, diffs, logs, and show results.
- Six controlled task tools over stdio for starting, polling, continuing, answering, listing, and cancelling Codex tasks.
- Local per-project execution authorization, profile allow-lists, bounded persistence, recovery, and sanitized usage/activity summaries.

| Connection | Tools | Capability                                          |
| ---------- | ----: | --------------------------------------------------- |
| stdio      |    15 | Nine read-only inspection tools plus six task tools |
| Local HTTP |     9 | Read-only inspection only; no task tools            |

The inspection tools are `projects_list`, `project_get`, `files_list`, `files_search`, `file_read`, `git_status`, `git_diff`, `git_log`, and `git_show`. The stdio task tools are `task_start`, `task_get`, `tasks_list`, `task_continue`, `task_answer`, and `task_cancel`. Registration grants inspection only; Codex execution stays disabled until enabled locally for that project.

## Requirements and install

Use Node.js 20 or newer, pnpm 12.4.2 (the repository-pinned version), and Git. Git tools and Codex tasks require a Git project. File inspection also works for non-Git projects.

Install the built CLI globally from a source checkout:

```sh
git clone https://github.com/r-mmy/context-bridge.git
cd context-bridge
pnpm install --frozen-lockfile
pnpm build
pnpm add -g .
```

For local development without a global install, run the source CLI with `pnpm exec tsx src/cli/main.ts --help` or `pnpm exec tsx src/cli/main.ts doctor`.

## Register a project and opt in to Codex

```sh
ctxbridge init
ctxbridge project add /path/to/project
ctxbridge project list
ctxbridge project show <project-id>
ctxbridge doctor
ctxbridge agent profile list
ctxbridge agent enable <project-id>
ctxbridge agent status <project-id>
```

On Windows PowerShell, use a Windows path, such as `ctxbridge project add C:\code\my-project`. `project add` with no path registers the current directory. Removing a registration removes only its registry entry; it does not delete project files.

`agent enable` requires a local interactive confirmation and a Git repository. It warns that Codex can read and modify the authorized workspace. The first enablement allows only the global default profile. The currently configured default is `luna-max` (`gpt-6-luna`, `max`). Additional profiles must be explicitly allowed for a project with `ctxbridge agent policy set`; there is no automatic model fallback. Use `ctxbridge agent policy show <project-id>` to inspect the local policy and `ctxbridge agent disable <project-id>` to block new work.

To configure another locally supported profile, use the CLI forms shown by `ctxbridge --help`:

```text
ctxbridge agent profile add <name> --model <model-id> --effort <effort>
ctxbridge agent profile default <name>
ctxbridge agent policy set <project-id> --allow-profile <name>... [--default-profile <name>]
```

Profile additions are checked against the local Codex App Server. A project's default profile must be included in its allowed-profile list.

## Connect Codex Desktop directly

Configure the installed CLI as a local stdio MCP server. See [Codex setup](docs/codex-mcp-setup.md) for the config example. This connection exposes all 15 tools when the client supports them. Context Bridge task execution launches its own pinned Codex App Server; that managed thread is separate from the model and conversation driving the outer Codex Desktop session.

## Connect ChatGPT through Secure MCP Tunnel

ChatGPT cannot launch a local process directly. Secure MCP Tunnel connects ChatGPT to the local `ctxbridge mcp --stdio` server. See [ChatGPT and Secure MCP Tunnel setup](docs/chatgpt-secure-mcp-tunnel.md) for profile creation, persistent secret references, doctor checks, and the after-reboot steps. Keep the tunnel client running for discovery and tool calls. The stdio server behind the tunnel exposes 15 tools.

After reinstalling or updating Context Bridge, reconnect or refresh the ChatGPT MCP connection so it reads the current tool schema. Restarting the local tunnel alone may not refresh a schema cached by the client. Verify access with `projects_list`, then inspect a selected ID with `project_get`.

## A typical task

1. Inspect with `project_get`, `git_status`, and only the needed `file_read` or `git_diff` calls.
2. After the user asks for a change, call `task_start` with the project ID, a bounded prompt, and an allowed profile such as `luna-max`.
3. Poll with `task_get` until the task is terminal or waiting for input. An accepted `task_start` is not a completed task.
4. If Codex asks a blocking question, show the actual question and its options to the user. Call `task_answer` only with the answer the user provided.
5. Use `task_continue` for a follow-up on the same Codex thread. Poll again with `task_get`.
6. Independently inspect `git_status` and `git_diff` before deciding what to keep or commit.

### User input

Context Bridge relays supported blocking `requestUserInput` questions, including selectable options and free-form answers. The client must present the real question to the user; do not choose or invent an answer. Secret questions fail closed and require local action. Stale or duplicate answers are rejected, and forwarding is at most once. Plan-mode relay has been live-observed on Windows; default-mode handling is covered by automated tests but has not been live-probed.

### Cancellation and recovery

`task_cancel` interrupts the active turn; it is not rollback, so partial workspace edits may remain. Inspect Git status and diff afterward. If Context Bridge or App Server exits while a task is active, the task recovers as interrupted. No turn or answer is automatically replayed. Explicit `task_continue` is required, and registration, authorization, and root are revalidated before continuing. The project writer is released after process loss is safely recorded.

### Usage summaries

Task telemetry can include `input_tokens`, `cached_input_tokens`, `cache_write_input_tokens`, `output_tokens`, `reasoning_output_tokens`, `total_tokens`, `model_context_window`, and `delta_quality`. It reports a latest `last` snapshot and a cumulative thread `total`; per-turn deltas are marked `authoritative_delta`, `degraded`, or `unavailable`.

`total_tokens` is authoritative. Cached input is a subset of input, and reasoning output is a subset of output; do not add subsets again. `model_request_count` is null/unavailable. Counts vary by execution. Context Bridge does not infer cost, pricing, quotas, or request counts; the public summaries are sanitized and bounded.

## Security boundaries

- Projects are unavailable for task execution until a user enables each one locally. Registration alone grants read-only inspection.
- Task tools exist only over stdio. HTTP exposes the nine inspection tools and no task tools.
- Each turn is confined to the exact registered workspace root with workspace-write sandboxing, that sole writable root, network disabled, `approvalPolicy: "never"`, and both temporary-directory exclusions enabled.
- Codex receives an allow-listed environment; Context Bridge does not intentionally pass API keys, tunnel secrets, or arbitrary environment variables.
- There is no generic shell, arbitrary command, arbitrary Git, or arbitrary App Server RPC MCP tool. Dirty worktrees are supported. Execution rules instruct Codex not to stage, commit, push, reset, clean, switch branches, or otherwise change Git history, but these model instructions are not an OS-level guarantee against Git mutations.
- The final assistant response can include workspace material Codex read. Context Bridge's inspection denylist does not filter that response.

Workspace confinement depends on the Codex runtime and OS sandbox. Linux/macOS real authenticated execution and sandbox behavior remain unverified. The managed `@openai/codex` runtime is pinned to 0.157.1, but the App Server protocol remains experimental. See [SECURITY.md](SECURITY.md) for the detailed boundaries, filtering, resource limits, and known limits.

## Codex Desktop interoperability

Context Bridge-created threads have been visible and usable in native Codex Desktop, same-thread continuation appears in that conversation, and terminal unload permits opening the thread normally afterward. In the 0.157.1 probe, the managed App Server and native Desktop did not share project identity/state. Context Bridge therefore creates projectless threads without automatic sidebar-project association. This limits UI grouping, not task continuation; visibility can be delayed.

## Troubleshooting

| Symptom                                                        | Check                                                                                                                                                                                                           |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tunnel reports `CONTROL_PLANE_API_KEY` missing after reboot    | Run the tunnel profile's doctor. Confirm its `file:` secret path exists, or that the persistent user environment variable is available in a new terminal. A repository `.env` file is not automatically loaded. |
| ChatGPT cannot list projects                                   | Start the tunnel profile, then verify with `tunnel-client doctor --profile <name> --explain`; keep the tunnel running. Reconnect/refresh the MCP tools if Context Bridge was updated.                           |
| Codex is unauthenticated or the managed runtime is unavailable | Run `ctxbridge doctor`; complete Codex's local sign-in and check the pinned runtime version reported by doctor.                                                                                                 |
| Project is registered but tasks are unavailable                | Run `ctxbridge agent status <project-id>`; enable locally in an interactive terminal. Tasks require a Git project.                                                                                              |
| Profile is rejected                                            | Check `ctxbridge agent profile list` and `ctxbridge agent policy show <project-id>`. The requested profile must be locally configured and allowed; there is no fallback.                                        |
| Another task owns the writer                                   | Poll or cancel the active task; do not bypass the project writer lock.                                                                                                                                          |
| Task became interrupted after a process exit                   | Inspect Git state, then explicitly call `task_continue` if appropriate. Context Bridge never replays the turn automatically.                                                                                    |
| Task is waiting for user input                                 | Present `pending_input` as returned, wait for the user's actual answer, then call `task_answer`.                                                                                                                |
| Thread appears outside the expected Desktop project group      | v0.2 uses projectless threads; automatic sidebar association is not supported.                                                                                                                                  |
| Linux musl install cannot load the lock binding                | Linux musl is unsupported by the current native locking dependency.                                                                                                                                             |

## Development

From the checkout, run `pnpm install --frozen-lockfile`, `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm build`. Tests run with one worker and a 30-second timeout. See [CONTRIBUTING.md](CONTRIBUTING.md), the detailed [v0.2 design and history](docs/V0.2.md), and [architecture](docs/architecture.md).

## License

Apache-2.0. See [LICENSE](LICENSE).
