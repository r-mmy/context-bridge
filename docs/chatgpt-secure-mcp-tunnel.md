# ChatGPT through Secure MCP Tunnel

Secure MCP Tunnel connects ChatGPT to Context Bridge's local stdio server. The local tunnel client starts `ctxbridge mcp --stdio` and maintains the connection; Context Bridge does not provide a hosted backend.

```text
ChatGPT → Secure MCP Tunnel → tunnel-client → ctxbridge mcp --stdio
```

These commands and secret-reference options were checked against tunnel-client `0.0.14+0f870e50a973fa820d4c409000059e181e8d242b`.

## Prepare Context Bridge

Install Context Bridge from a source checkout, initialize its user registry, register only projects you intend to expose, and check the local setup. The [README](../README.md) has the complete CLI flow.

```powershell
ctxbridge init
ctxbridge project add C:\code\my-project
ctxbridge project list
ctxbridge doctor
```

Project registration provides read-only inspection. For Codex tasks, enable the selected Git project locally with `ctxbridge agent enable <project-id>` in an interactive terminal and confirm the warning. The project must then appear as enabled in `ctxbridge agent status <project-id>`.

## Create a tunnel profile

Create or inspect the tunnel in [Tunnels management](https://platform.openai.com/settings/organization/tunnels), and create a runtime API key from [Runtime API keys](https://platform.openai.com/settings/organization/api-keys). Use the runtime key for the daemon; `OPENAI_ADMIN_KEY` is for tunnel administration and must not be substituted for the runtime key. ChatGPT's current [connector settings](https://chatgpt.com/#settings/Connectors) are where you create or verify the private MCP connection.

The preferred persistent Windows setup is a runtime-key file outside the repository, for example under `%LOCALAPPDATA%\ContextBridge\secrets`. Save the key there using your normal secure process and restrict the file's Windows ACL to your user account. Do not paste the key into a command, profile committed to a repository, README, or `.env` file.

Pass the file reference when creating a local stdio profile:

```powershell
$secretPath = Join-Path $env:LOCALAPPDATA 'ContextBridge\secrets\control-plane-api-key.txt'
$secretRef = 'file:' + ($secretPath -replace '\\', '/')
tunnel-client init --sample sample_mcp_stdio_local `
  --profile context-bridge `
  --tunnel-id '<TUNNEL_ID>' `
  --mcp-command 'ctxbridge mcp --stdio' `
  --control-plane-api-key-ref $secretRef
```

The installed client also accepts `file:/path/to/secret` for the runtime key through its run configuration and supports the persistent `CONTROL_PLANE_API_KEY` environment reference. To use an existing profile, keep its other settings and change only its `control_plane.api_key` reference. A `file:` reference avoids having to set an environment variable again in each new shell. Store its target outside the project and do not copy it into source control.

As an alternative, set `CONTROL_PLANE_API_KEY` as a persistent **user** environment variable in Windows Environment Variables, then open a new terminal. The profile may keep `env:CONTROL_PLANE_API_KEY`. A project `.env` file is not automatically loaded by tunnel-client. The daemon requires the runtime key; an admin key is not a substitute.

## Check and run the profile

```powershell
tunnel-client doctor --profile context-bridge --explain
tunnel-client run --profile context-bridge
```

Doctor checks that the profile loads, the tunnel ID and runtime-key reference are usable, the local MCP target is configured, and the readiness contract is present. Keep the foreground `run` process alive while ChatGPT discovers or calls tools. The client also supports managed runtime supervision; see its current `help quickstart` if you want that lifecycle instead of a foreground terminal.

## Connect ChatGPT

With the tunnel running, create or verify the private MCP connection using the current ChatGPT connector setup. Keep the tunnel up during connection discovery and every tool call. The stdio MCP server behind this tunnel exposes exactly 15 tools: the nine read-only inspection tools and six locally authorized task tools. A separate Context Bridge HTTP server remains read-only and has nine tools.

After reinstalling or updating Context Bridge, reconnect or refresh the ChatGPT MCP connection so it obtains the updated tool schema. Restarting tunnel-client alone may not refresh a schema already cached by the client. Verify the connection by calling `projects_list`, then `project_get` with one returned project ID. A project must be registered for inspection; task tools additionally require local per-project authorization.

## After reboot

Open a new terminal. If using the `file:` profile, run:

```powershell
tunnel-client doctor --profile context-bridge --explain
tunnel-client run --profile context-bridge
```

If using the environment-variable alternative, confirm the persistent user variable is available to the new process before running doctor. If doctor reports that the key reference cannot be resolved, fix the local secret reference; do not disable authentication or substitute an admin key.

## Troubleshooting

- **Missing `CONTROL_PLANE_API_KEY`:** verify that the profile uses the intended `file:` reference or `env:CONTROL_PLANE_API_KEY`, the file exists, or the persistent user variable is available in a new terminal. Do not rely on a repository `.env` file.
- **Tunnel is not running:** run doctor, then start the profile and keep it running. ChatGPT cannot reach the local stdio command while the tunnel client is stopped.
- **ChatGPT does not show updated tools:** reconnect or refresh the MCP tools after updating Context Bridge; restarting the tunnel may not clear cached schemas.
- **Project is missing:** confirm it is registered with `ctxbridge project list`; use `project_get` only with a returned ID.
- **Task tools are unavailable:** verify the tunnel is connected to `ctxbridge mcp --stdio`, then check local execution authorization with `ctxbridge agent status <project-id>`.

For project authorization and execution limits, see [SECURITY.md](../SECURITY.md). For Codex Desktop's direct local stdio configuration, see [Codex MCP setup](codex-mcp-setup.md).
