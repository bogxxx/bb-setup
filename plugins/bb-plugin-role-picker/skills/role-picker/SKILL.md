---
name: role-picker
description: Read the composer Role control before development work. Use when choosing regular work, the orchestrator, or the prompt generator on Cursor, Claude Code, or GitHub Copilot.
---

# Role picker

Call the `role_choice` tool before a development task. Follow the role it returns. If `role_choice` is not in your tool list, run `bb plugin run role-picker show` instead.

Regular is the default thread: it does the work in this session and may use any agents or tools it needs.

Orchestrator means spawn only. Call `spawn` with `name` set to `explore`, `contribute`, `plan`, or `review`. Those are the only four. Planning is the default: spawn `plan` before any `contribute`, and skip it only when the change is small (about one file or a few lines), unambiguous, has an obvious approach with no design choices, and needs no exploration. State the skip in one line. When in doubt, plan. `plan` designs and does not diagnose: root causes, CI or job logs, reproductions, and mapping unfamiliar code go to `explore` first, and `plan` gets the findings. `contribute` is the worker and the only one that edits. Explore may use the terminal. The orchestrator may also use the Task tool (in-session subagents) for short, bounded delegation; use `spawn` for work that should be its own bb thread, and always for review. On Cursor they run the cantrip agents. Every spawned agent starts with full access in BB.

GitHub Copilot does not load BB plugin tools: it rejects bb's stdio tool bridge (`bb-bridge`), so `spawn` and `role_choice` never appear there. Use the terminal equivalent, which behaves identically: `bb plugin run role-picker spawn <explore|contribute|plan|review> --assignment-file <path> [--worker <thr_id>]` (or `--assignment <text>`). Use this `bb plugin run` form rather than the `bb roles` shorthand: on Windows the shorthand can crash at exit (libuv assertion, non-zero exit code) even after the command succeeded, which invites a duplicate spawn. Never stop and report that `spawn` is missing.

Prompt generator means interview the user and write a prompt for an Orchestrator thread. It is read-only: it asks questions with `AskUserQuestion` (on GitHub Copilot, with `bb roles ask`; see below), may call `spawn` with `name` set to `explore` only, and shows the final prompt in chat. It does not start a thread or write a file. On Cursor it runs `cantrip-interview`; on Claude Code, `interviewer`; on Copilot, `interviewer`.

`spawn` returns the thread id as soon as the thread exists, and bb wakes the orchestrator with a `[bb system]` message when that thread ends its turn. The orchestrator ends its turn instead of polling, then reads the report with `bb thread output <id>` before using it. Polling is expensive: a wake-up after the prompt cache expired (5 minutes on Anthropic) re-sends the whole conversation at cache-write price. When an agent must block inside a turn (the reviewer, the prompt generator), it uses `bb thread wait <id> --timeout 4m` and repeats it.

The provider and model menu does not list these roles. The Role control in the composer does. A running session keeps the instructions it started with until BB builds that provider session again.

## Asking the user from the terminal: `bb plugin run role-picker ask`

GitHub Copilot has no question tool in bb: `AskUserQuestion` is a BB plugin tool, and Copilot's own `ask_user` is not offered to bb. `bb plugin run role-picker ask` (shorthand `bb roles ask`) opens the same question card in the thread and blocks until the user answers, cancels, or 30 minutes pass.

Pipe the JSON on stdin with `--questions-stdin`, so no shell quoting touches it (apostrophes, `"`, `&`, `|` pass through). bash on macOS/Linux, a quoted heredoc:

```bash
bb plugin run role-picker ask --questions-stdin <<'EOF'
{"questions":[{"question":"Which database?","header":"Database","options":[{"label":"Postgres (recommended)","description":"Already in the stack"},{"label":"SQLite","description":"No server"}]}]}
EOF
```

PowerShell on Windows, a single-quoted here-string (`@'` ends its line, `'@` starts its line):

```powershell
@'
{"questions":[{"question":"Which database?","header":"Database","options":[{"label":"Postgres (recommended)","description":"Already in the stack"},{"label":"SQLite","description":"No server"}]}]}
'@ | bb plugin run role-picker ask --questions-stdin
```

- Input: the `AskUserQuestion` schema. 1-10 questions; each has `question`, `header` (at most 12 characters), 2-4 `options` of `{label, description, preview?}` with unique labels, and optional `multiSelect` (default false). The card always offers a free-text answer.
- Exactly one input source: `--questions-stdin` (one non-empty line of JSON, at most 16 KiB), `--questions '<json>'` (inline; an apostrophe breaks it in bash, and Windows PowerShell strips its `"` and cmd.exe breaks on `& | < > ^`, so avoid it), or `--questions-file <path>` (a file on the thread's machine; not for read-only roles).
- Output, exit 0: `{"answers":[{"question","header","selected":["<label>",...],"freeText"?}]}` on stdout, one entry per question in order.
- Exit 1: invalid input or no bb thread (`BB_THREAD_ID` unset); stderr lists every problem. Fix the JSON and run it again.
- Exit 2: no answer. The user dismissed the card, it timed out or was interrupted, or it could not be shown; stderr says why. Ask the question in chat instead and end the turn.
- Run it in a shell that waits: for Copilot, bash (macOS/Linux) or powershell (Windows) in sync mode with a long `initial_wait` (600), then `read_bash` or `read_powershell` until it finishes.
- If the answers JSON was printed, use it whatever the exit code. Use `bb plugin run role-picker ask` on Windows: the `bb roles` shorthand can crash at exit there with a non-zero code after it worked.
- Windows PowerShell 5.1 pipes ASCII to native commands by default, so non-ASCII text arrives as `?`; set `$OutputEncoding = [Text.UTF8Encoding]::new($false)` first there. PowerShell 7 pipes UTF-8.
