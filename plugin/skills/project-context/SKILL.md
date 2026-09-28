---
name: project-context
description: Inspect locally registered projects with Context Bridge and use its controlled Codex task tools only when the user explicitly requests workspace changes.
---

# Project context

1. Call `projects_list`, then `project_get` for the intended project. Never guess a project ID or filesystem root.
2. Call `git_status` before assuming repository state. Search narrowly with `files_search`; read only relevant paths with `file_read`. Use `git_diff`, `git_log`, or `git_show` for the specific review needed. Never claim to have inspected content a tool did not return.
3. The file and Git tools are read-only. Call `task_start` only after the user clearly requests a change and the project is locally authorized. A successful start means accepted, not complete. Poll `task_get` until terminal or `waiting_for_input`.
4. For a blocking question, show the actual question and options to the user. Do not choose or invent an answer. Call `task_answer` only with the user's explicit answer, then keep polling the same task: it resumes the same active turn. Secret questions fail closed and require local action.
5. Use `task_continue` for a requested follow-up on the same Codex thread. It revalidates project registration and authorization. Do not assume a thread is grouped under a matching Codex Desktop sidebar project.
6. `task_cancel` interrupts work but does not roll back edits. After cancellation, interruption, or completion, independently inspect `git_status` and `git_diff`. Do not claim the agent committed or pushed; Context Bridge provides no direct commit/push tool, and its execution rules do not guarantee that a model process can never attempt Git mutation.
7. Interpret usage carefully: `total_tokens` is authoritative cumulative usage; cached input is a subset of input and reasoning output a subset of output. Do not add subsets again. Per-turn deltas have a quality marker; `model_request_count` is unavailable/null and usage does not imply cost or quota.
