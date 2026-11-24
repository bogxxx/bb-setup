# bb-plugin-thread-board

A board of threads under the New thread message box. Three columns, in this order:

- **needs you** — question, send failed, failed, or unread
- **done** — finished within `doneDays` (default 3), plus every pinned thread
- **running** — starting, active, or stopping, or queued, planning, in a workflow, or running background work

Cards are grouped by project. The project open on the homepage is the first group; the other groups follow the newest card. Each group header is a letter tile (the project's first letter) and the project name. A card opens its thread. Right-click opens BB's thread menu.

The board reads the live sidebar thread list, including snoozed threads that list hides. It does not list archived threads.

## Snoozed threads

A snoozed thread stays on the board while it still matters:

- A question or a failed send always counts, even after `doneDays`.
- An unread or failed snoozed thread counts only when it was updated within `doneDays`. Older ones are left off.
- A snoozed thread that is still working stays in **running**.
- A snoozed thread that has finished inside the window sits in **done** with a **snoozed** chip.

## Children

A child gets its own card only when it asks a question or a send to it failed. Other children, including snoozed ones, do not get a card. A running child counts toward its top-level thread, which stays in **running** while any descendant is busy. An unread child does not get a card.

## Chips

Needs-you chips are orange: `question`, `send failed`, `failed`, `unread`.

Running chips are `queued`, `plan`, `workflow`, and `agents`. **review** is warm orange-to-amber in every column. It is used only when the card's own thread is a reviewer child (`parentThreadId` set and title `review`) in **needs you**, or when a **running** card would have said `agents` and a busy descendant is a reviewer. A top-level thread titled review is not a reviewer.

Done chips are muted: `snoozed` when the thread is hidden, otherwise `pinned` when it is pinned. A plain done card has no chip.

## Hover preview

On a pointer that can hover, resting on a thread link (a board card or a sidebar row) for about 400ms opens a preview: the title, the chip, the latest assistant message, and, when the thread is waiting, what it needs from you. An approval that can be allowed once has an Approve button. The preview loads with `threads.timeline` (`segmentLimit` `"2"`, `deferContent` `"true"`, `includeNestedRows` `"true"`) and, when the thread has a pending interaction, `threads.interactions.list`. It shows "Loading…", "Couldn't load preview", or "No summary yet". Leaving, Escape, or scrolling closes it. Coarse pointers skip it. Hovering a chat message does not open it.

## Sidebar metadata

The plugin registers a thread-row metadata item (`board-meta`) that draws how long ago the thread changed, a small project badge, and the chip when it has one. That content is on the metadata line under the title. BB draws the line only after Organize → Rows → Metadata is on (`showRowMetadata`, default off). This plugin does not turn that setting on. The command, if you want it, is:

```
bb thread-list prefs set showRowMetadata true
```

## Settings

`showBoard` (default true) hides the homepage section when false. `doneDays` (default 3) is how many days a finished thread stays in done, and how long a snoozed unread or failed thread still counts as needing you.

```
bb plugin config thread-board
bb plugin config thread-board set doneDays 7
bb plugin reload thread-board
```

## Install

From this directory:

```
npm install
bb plugin install .
```

After editing sources:

```
bb plugin reload thread-board
```

`bb plugin build` writes `dist/`. `npm test` runs the board rules. `npm run typecheck` typechecks the page.
