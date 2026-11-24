See how busy every BB machine is, the server and each machine you enrolled,
from any page, without opening Activity Monitor, `top`, or Task Manager.

## Three live bars

The plugin's icon in the sidebar's navigation rail is three bars, CPU, RAM,
and GPU, at the busiest connected machine's load, that fill from the bottom
and move every few seconds. A bar turns amber
at 85% and red at 95%.

## The numbers on hover

Hover the icon. In place of BB's tooltip, a small card shows a row per
machine with each percentage over a thin bar, and when BB last saw the
machines that are offline.

## A page of processes

Click or tap the icon for the Resources page. A card per machine shows its
name and uptime, the CPU model and core count, the RAM in use, and the GPU
name. Below, pick a machine, macOS, Linux, or Windows: a list like Activity
Monitor's shows its processes, with name, PID,
CPU, and memory. Click a column to sort by it, and filter by name, command
line, or PID.

## Quit what you don't need

Quit one process, or every process the filter shows. A dialog asks first, and
Force Quit stops a process that won't quit. BB's own processes are never
quit.

## Guard keeps BB responsive

On macOS, everything BB starts, agents and what they run, runs at a lower
priority than BB itself, so the app and the connection to your phone stay
quick when the Mac is overloaded. Under heavy load the busy ones run only on
the efficiency cores, and copies of the same command piling up are stopped.
Pause all on the Resources page stops BB's agents, what they run, and BB's
terminals until you resume them, from any device. Guard is a small separate
process that keeps working when BB is slow; turn it off in the plugin's
settings.

## Where the numbers come from

The BB server reads its own load every 2 seconds. RAM counts what Activity
Monitor calls Memory Used on macOS, and everything but available memory on
Linux. GPU load comes from macOS itself, or from `nvidia-smi` on machines with
NVIDIA GPUs. Processes come from `ps` on macOS and `/proc` on Linux, only
while the Resources page is open. Guard reads `ps` every 2 seconds and keeps
its state in its own folder. No external account or service is required.

## More San Francisco Plugins

Resource Monitor is one of the San Francisco Plugins, a family of BB plugins.
The others:

- **Superhuman**: Superhuman-style speed for BB, with shortcuts and search in
  any keyboard layout, snoozed threads, and a phone layout.
- **Bookmarks**: save any chat message and jump back to it from the thread's
  right panel.
- **To-do**: a Notes-style to-do list on the New thread screen and in the
  right panel; snooze a to-do or start a thread from it.
- **Canvas**: images, text, and drawing in each thread, with screenshots your
  agent can read.
- **Annotate**: notes on the elements of a page in BB's Browser, sent to your
  agent with a screenshot.
- **Auto Update**: updates for the plugins you pick, installed every hour, day,
  or week.
- **Storage Cleaner**: what fills your Mac's disk, and cleanup of archived
  threads, worktrees, and caches.
- **San Francisco**: a quiet macOS-style theme after the Aside browser, with
  your pick of the eight macOS accent colors.
- **Pool Usage**: how much of each provider's capacity is in use and when it
  frees up, in the sidebar footer.

See all of them, with install steps, at
[github.com/rebryk/bb-plugins](https://github.com/rebryk/bb-plugins).

Based on Resource Monitor by Yurii Rebryk, one of the
[San Francisco Plugins](https://github.com/rebryk/bb-plugins).
