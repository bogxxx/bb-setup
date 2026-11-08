---
name: claude-subagents
description: Read Claude Code background agents on a thread from the Subagents side panel, the thread action, or bb claude-subagents. Use when asked for a subagent's status, model usage, chat, or thinking.
---

# Claude subagents

The plugin shows Claude Code background agents for one thread. It lists `local_agent` and `local_subagent` runs only. One agent is one `familyId`, even when that agent was resumed and has several runs. The row status, usage, and error come from the latest run.

## Side panel

The side panel New tab menu lists Subagents on every thread. Open it to list Claude Code background agents for the focused thread. On a thread that is not Claude Code, the panel says this thread is not a Claude Code thread. The list shows description, status (In progress, Finished, Failed, Interrupted), agent type, requested alias or resolved model, the latest run's token count, tool uses, and duration, and a run count when there is more than one. In progress stays In progress when the thread is idle and the agent has had no event for 10 minutes; the row then adds "no update for N min".

Open a row for the model block, transcript usage, thinking note, and chat. Usage on the detail is the sum of the transcript, with each API call counted once. The list's token count is labeled latest run and is not that sum. Thinking text is labeled Summarized or Redacted. Filter with All, Chat, or Thinking, and use Load earlier for older items.

The list refreshes when the thread emits events, after a short pause. An open in-progress agent refreshes on those events and about every 5 seconds while its tab is visible, then once more when it leaves In progress. Reconnecting refreshes the list and the open detail.

## In the thread

Claude Code threads with at least one background agent show a Subagents section on the thread context card, beside the transcript. Still working is listed before Finished. Failed and Interrupted get headings only when those agents exist. Each row shows the description and status. Choosing a row replaces that pane's transcript with the agent's model line, usage, thinking, and chat. Back restores the thread chat. The composer, the context card, the sidebar, and other panes stay in place.

When the pane shows the context banner instead of the card, the same list is on that banner and is not repeated on the card. Choosing a row replaces the transcript the same way. The open chat belongs to that thread: switching threads does not leave it on screen.

## Thread action

The thread menu has Subagents on every thread. It opens the same panel. If the side panel cannot open it, the action focuses the thread and tries once more. If that also fails, it asks you to open the thread and choose Subagents.

## CLI

`bb claude-subagents list --thread <thr_id> [--json]`

`bb claude-subagents show <familyId> --thread <thr_id> [--json]`

`--thread` defaults to the current thread. `--json` prints the same objects the panel uses. `show` returns the newest page of the transcript (40 items) plus the full usage totals.

## Limits

- Any host. On the primary host the server uses `CLAUDE_CONFIG_DIR` or its home `.claude` directory. On another host it reads `<home>/.claude`, where `<home>` comes from the environment path: `/Users/<name>`, `/home/<name>`, `/root`, or `C:\Users\<name>`. A project outside those folders returns `unsupported_host`. `CLAUDE_CONFIG_DIR` is never applied to another host, and there is no setting to point at another Claude config directory. The session directory is looked up under `projects` if the encoded working directory does not match.
- `bb.sdk.files.read` reads the whole transcript. Parses are cached by sha256. The panel does not poll the file; it refreshes only on thread events, the in-progress timer, and reconnect.
- Text and thinking are clipped at 4000 characters, tool input at 300, tool results at 500, and the fallback summary at 8000. Agent type, model alias, model names, tool names, and tool ids are clipped at 200 characters. Detail keeps at most 32 distinct requested models, resolved models, efforts, and advisors. The list keeps at most 200 agents. Event history is read 100 events at a time, the largest page the thread event list accepts, and stops after 40 pages.
- The Temp `.output` file is not the transcript. It is used only when the jsonl is missing or empty, the path is that agent's task output, and the file is non-empty. Otherwise the latest run's summary is shown. A newer run does not reuse an older run's summary, error, or output file.
- `finished` in the agent meta file is not a status. `pickedEffortModel` is not the requested model. The requested alias is `meta.model`. Resolved models and token totals come from the transcript, deduplicated by message id.
- A missing or unreadable transcript does not fail the detail call. The notice explains it, and the summary is still shown.
