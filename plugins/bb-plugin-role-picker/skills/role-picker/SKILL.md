---
name: role-picker
description: Read the composer Role control before development work. Use when choosing regular work or the orchestrator on Cursor, Claude Code, or GitHub Copilot.
---

# Role picker

Call the `role_choice` tool before a development task. Follow the role it returns.

Regular means do the work in this session. Do not launch the Cursor cantrip agents or the Claude explorer, planner, and worker.

Orchestrator means spawn only. Call `spawn` with `name` set to `explore`, `contribute`, `plan`, or `review`. Those are the only four. `contribute` is the worker and the only one that edits. Explore may use the terminal. Do not use the Task tool. On Cursor they run the cantrip agents. Every spawned agent starts with full access in BB.

`spawn` returns the thread id as soon as the thread exists. Wait with `bb thread wait <id>`, then read the report with `bb thread output <id>`, before using it.

The provider and model menu does not list these roles. The Role control in the composer does. A running session keeps the instructions it started with until BB builds that provider session again.
