---
name: role-picker
description: Read the composer Role control before development work. Use when choosing regular work, the orchestrator, or the prompt generator on Cursor, Claude Code, or GitHub Copilot.
---

# Role picker

Call the `role_choice` tool before a development task. Follow the role it returns.

Regular means do the work in this session. Do not launch the Cursor cantrip agents or the Claude explorer, planner, and worker.

Orchestrator means spawn only. Call `spawn` with `name` set to `explore`, `contribute`, `plan`, or `review`. Those are the only four. Planning is the default: spawn `plan` before any `contribute`, and skip it only when the change is small (about one file or a few lines), unambiguous, has an obvious approach with no design choices, and needs no exploration. State the skip in one line. When in doubt, plan. `contribute` is the worker and the only one that edits. Explore may use the terminal. Do not use the Task tool. On Cursor they run the cantrip agents. Every spawned agent starts with full access in BB.

Prompt generator means interview the user and write a prompt for an Orchestrator thread. It is read-only: it asks questions with `AskUserQuestion`, may call `spawn` with `name` set to `explore` only, and shows the final prompt in chat. It does not start a thread or write a file. On Cursor it runs `cantrip-interview`; on Claude Code, `interviewer`; on Copilot, `interviewer`.

`spawn` returns the thread id as soon as the thread exists. Wait with `bb thread wait <id>`, then read the report with `bb thread output <id>`, before using it.

The provider and model menu does not list these roles. The Role control in the composer does. A running session keeps the instructions it started with until BB builds that provider session again.
