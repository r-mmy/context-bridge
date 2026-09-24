---
name: project-context
description: Use Context Bridge to inspect a project that the user registered locally.
---

# Project context

Use these steps when Context Bridge is available:

1. Call `projects_list` to discover registered project IDs, then `project_get` for the project you need. Never guess or provide a filesystem root.
2. Call `git_status` before assuming what repository state the user has.
3. Search narrowly with `files_search` before reading large parts of a repository. Retrieve only relevant files and line ranges with `file_read`.
4. When reviewing recent implementation work, use `git_diff` to inspect the current changes. Use `git_log` or `git_show` only for the specific history needed.
5. Never claim to have inspected files, lines, diffs, or commits that were not actually returned by Context Bridge.

Context Bridge v0.1 is read-only. Its tools do not modify project files or run arbitrary commands.
