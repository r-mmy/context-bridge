# Security policy

## Report a vulnerability

Open the repository's [Security Advisories page](https://github.com/r-mmy/context-bridge/security/advisories) and select **Report a vulnerability** to send a private report to the maintainers. Private vulnerability reporting is enabled for this repository. Do not open a public issue or pull request with vulnerability details. Do not include real credentials or unrelated private project contents in a report. See GitHub's [private vulnerability reporting guide](https://docs.github.com/en/code-security/how-tos/report-and-fix-vulnerabilities/report-privately) for details.

Context Bridge v0.1 is a local, read-only project inspection service.

## Access boundary

- A client can address only a project ID already present in the local registry. MCP inputs never accept a root directory.
- Every requested path is interpreted relative to the registered root. Absolute paths, NULs, and traversal that escapes the root are rejected.
- The registered root and existing targets are canonicalized. Symlinks and Windows junctions are accepted only when their resolved targets remain inside the canonical root. Missing Git paths are checked against their nearest existing canonical ancestor.
- Registration is rejected when the canonical root is inside a location matched by the built-in sensitive-path policy, including `.ssh` and identified credential stores. Existing registry entries at such roots are unavailable and MCP errors do not include their paths. A generic `.config` ancestor alone is allowed.
- Git worktree discovery and both Git metadata directories are canonicalized and must remain inside the discovered worktree. This rejects external `.git` pointers and linked worktrees whose shared Git metadata is outside that worktree. When a project is nested inside a larger worktree, Git pathspecs are scoped to the derived project prefix and returned paths are translated back to project-relative form.
- Project roots are revalidated for each tool call. Removing a registration revokes access on the next call.
- File and Git results share the same ignore and secret policy. Git is invoked only through fixed argument arrays with shell execution disabled. MCP-facing Git subprocesses disable all Git transport protocols and lazy fetching, reset credential helpers, and disable external diff/text conversion, global Git configuration, fsmonitor, pagers, and configured clean/smudge/process filters. Missing objects in partial/promisor clones fail locally instead of being fetched.
- The MCP server has no write, shell, arbitrary Git, commit, or agent-execution tool. `project add`, `project remove`, and `init` update only the user registry.
- HTTP listens on `127.0.0.1` only. Host and Origin validation reject non-local browser origins and DNS-rebinding hostnames. Requests without an Origin header are accepted for native MCP clients.

## Ignore behavior

- Ignore rules are evaluated from the project root toward the requested path. At each directory level, `.gitignore` rules run first and `.contextbridgeignore` rules run after them; a Context Bridge rule can therefore override a Git rule at that level. Deeper directory rules run later and override earlier ancestor decisions. Within each file, the last matching rule wins, including a later rule that re-ignores a previously re-included path.
- Root and nested `.gitignore` files are honored. Root and nested `.contextbridgeignore` files use gitignore-style patterns; negations can re-include normal ignored files, including files inside an ignored directory when a nested rule permits them. Walkers may inspect ignored directories under the normal work budget to find nested rules, but only paths visible under the complete rule chain are returned.
- Ignore files are read only after their canonical locations are confirmed inside the registered root. They must be regular UTF-8 files no larger than 256 KiB; escaped symlinks, malformed text, and oversized files fail safely.
- Built-in denied paths cannot be re-included. Hidden paths are omitted from search and from `files_list` unless `include_hidden` is true. `.git`, `node_modules`, and `.pnpm-store` are always excluded.

## Built-in sensitive-file denylist

The following paths are denied from listing, search, reading, and Git content results:

- `.env` and `.env.*`, except `.env.example`, `.env.sample`, and `.env.template`.
- `.ssh` directories and their descendants.
- SSH private-key names `id_rsa`, `id_ed25519`, `id_ecdsa`, `id_dsa`, and `identity`.
- Files ending in `.pem`, `.key`, `.der`, `.asc`, `.snk`, `.p12`, `.pfx`, `.ppk`, `.jks`, or `.keystore`.
- `.netrc`, `.npmrc`, `.pypirc`, generic `credential*`, `credentials*`, `secret*`, `secrets*`, and `token*` files, `client_secret*`, and `service-account*` or `service_account*` files.
- AWS `.aws/credentials` files; Azure CLI access-token, Azure profile, and MSAL token-cache files; Google `application_default_credentials.json`, `credentials.db`, `access_tokens.db`, and `legacy_credentials` stores.

These defaults are intentionally conservative; for example, a `.pem` certificate is denied along with a private key. `.env.example`, `.env.sample`, and `.env.template` remain readable.
On Windows, paths containing NTFS alternate data stream syntax (`:` inside a project-relative path segment) are rejected. Alternate data streams are unsupported.

## Resource limits

File reads, search results, and Git patches default to 256 KiB and can never exceed 1 MiB. Text is truncated only at valid UTF-8 boundaries. File reads are limited to 400 lines by default and 2,000 lines maximum. Search bounds query length, context, result count, per-file scan size, total scan size, scanned directory entries (2,048 per call), search depth (64 levels), and regular-expression runtime. Listings bound depth, returned entries, and scanned directory entries (2,048 per call). Directory results follow filesystem iteration order; limits are protective bounds, not stable pagination guarantees. Git operations have process output and runtime limits.

## Known limits

Containment checks canonicalize targets immediately before access, but Node's portable filesystem APIs do not provide a single cross-platform operation that is immune to an adversarial process swapping directories between validation and open. This tool is intended for local development directories, not as a sandbox against malware running as the same user. The HTTP service is loopback-only and does not authenticate other local processes.
