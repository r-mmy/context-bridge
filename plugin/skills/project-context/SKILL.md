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

The original file and Git tools are read-only. On the stdio server, `task_start` can let Codex read or edit a project only after local agent authorization is enabled; a successful start means accepted, not completed. Use `task_get` to check progress. If it returns `pending_input`, present the question to the user and wait for their explicit answer; never choose or invent one. Call `task_answer` only with the user's answer, then keep polling that same task because it resumes the same active Codex turn. Secret questions are not relayed and require local action. `task_continue` can continue a terminal task in its same Codex thread after Context Bridge verifies the current project registration and root. `task_cancel` may leave partial edits. Review actual changes with `git_status` and `git_diff`. Codex has no network access, and baseline counts alone do not prove a file changed.
