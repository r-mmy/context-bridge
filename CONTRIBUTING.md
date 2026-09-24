# Contributing

Context Bridge is a small TypeScript package. Keep filesystem policy, Git access, registry state, MCP tool schemas, CLI parsing, and transport startup in their existing layers. Do not add write tools, arbitrary process execution, telemetry, cloud dependencies, or project-root arguments to MCP tools.

## Setup

Use Node.js 20 or newer and pnpm 12.4.2, the version pinned by this repository:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm lint
pnpm format:check
pnpm typecheck
pnpm test
```

## Change requirements

- Add or update security tests for path, ignore, Git, output-limit, or registration changes.
- Preserve the project-relative MCP response contract; never include a local absolute root in tool results or tool errors.
- Invoke Git with argument arrays and keep its command set read-only. Do not enable shell execution, external diff drivers, textconv, or Git filters.
- Update `SECURITY.md` and `docs/security-model.md` when defaults or limitations change.
- Run the full validation set above before submitting. The GitHub Actions matrix covers Windows, Linux, and macOS.

## Project metadata

The package is private with a provisional name until maintainers choose an available publication name. Do not publish it or create external services as part of a code contribution.
