# ChatGPT through Secure MCP Tunnel

The recommended ChatGPT setup runs Context Bridge locally over stdio and lets
Secure MCP Tunnel provide the private connection to ChatGPT:

```text
ChatGPT
  → Secure MCP Tunnel
  → tunnel-client
  → ctxbridge mcp --stdio
  → Context Bridge
```

1. Use Node.js 20 or newer and pnpm 12.4.2 (the version pinned by this
   repository). From a cloned Context Bridge checkout, install it from source
   and register the projects you want available:

   ```sh
   pnpm install --frozen-lockfile
   pnpm build
   pnpm add -g .
   ctxbridge init
   ctxbridge project add /path/to/project
   ctxbridge doctor
   ```

   On Windows PowerShell, a project path can look like
   `C:\code\my-project`.

2. Configure the tunnel client to launch the local stdio server with command
   `ctxbridge` and arguments `mcp --stdio`. Follow the tunnel provider's current
   setup and authorization instructions; the tunnel client handles the
   connection from ChatGPT to this local process.
3. Start or connect the tunnel client as its provider directs. In ChatGPT,
   enable the connected private MCP server and confirm access by listing
   registered projects.

The tunnel provider's command-line options and configuration format can
change, so this guide describes the local Context Bridge command without
prescribing provider-specific tunnel configuration.

## Local HTTP alternative

Use Streamable HTTP when a client or tunnel configuration needs an HTTP MCP
endpoint:

```sh
ctxbridge mcp --http --port 7331
```

The endpoint listens on `127.0.0.1:7331/mcp` and validates Host and Origin.
Configure a private tunnel to connect to that loopback endpoint only when the
tunnel provider supports it. Do not expose the local HTTP port publicly or
configure a public unauthenticated relay. Context Bridge v0.1 has no bearer
token; the local endpoint remains accessible to other programs running as the
same user.
