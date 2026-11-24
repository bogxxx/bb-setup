# Resource Monitor

Resource Monitor shows how busy every BB machine is: the server and each
machine you enrolled, on macOS, Linux, or Windows. Its icon in the sidebar's
navigation rail is three live bars, CPU, RAM, and GPU, each at the busiest
connected machine's load. Hover the icon for a row of numbers per machine.
Click it for the **Resources** page, with a card per machine and the
processes of the one you pick, to sort, filter, and quit. On a macOS server,
**Guard** keeps BB responsive when the Mac is overloaded, and **Pause all**
stops its agents and terminals from any device.

This is a copy of [Yurii Rebryk's Resource Monitor](https://github.com/rebryk/bb-plugins/tree/main/resource-monitor),
which watches only the BB server, made to watch every machine and to list
processes on Windows too.

```text
rail      hover card
┌─────┐   ┌───────────────────┐
│ ▂█▁ │ → │  21%   74%   13%  │
└─────┘   │  ━──   ━━─   ───  │
   │      │  CPU   RAM   GPU  │
   │      └───────────────────┘
   ↓ click
Resources page
┌────────────────────────────────────────────────────┐
│    mac-studio · up 3d 4h                           │
│                                                    │
│    21%            74%            13%               │
│    ━━━─────────── ━━━━━━━━━━──── ━━────────────    │
│    CPU            RAM            GPU               │
│                                                    │
│    Guard Normal                     [Pause all]    │
│                                                    │
│    [Filter processes          ]   212 processes    │
│    Name                 PID   CPU % ▼    Memory    │
│    node                4182     104.2    1.2 GB    │
│    Chrome               911      12.0    2.4 GB    │
└────────────────────────────────────────────────────┘
```

## Use

- **See the load.** The bars fill from the bottom: CPU on the left, RAM in
  the middle, GPU on the right, each at the busiest connected machine's
  value. A bar turns amber at 85% and red at 95%.
- **See the numbers.** Hover the icon with a mouse. In place of BB's tooltip,
  a card shows a row per machine with each percentage over a thin bar, and
  for an offline machine, when BB last saw it.
- **See the details.** Click or tap the icon to open the **Resources** page.
  A card per machine, the server's first, shows its name, how long it has
  been up, and the three numbers with the CPU model and core count, the RAM in
  use, and the GPU name. Offline machines are greyed, with when BB last saw
  them.
- **See the processes.** Pick a connected machine under **Processes on**; the
  page remembers the pick. It lists that machine's processes, like Activity
  Monitor, and refreshes them every 2 seconds (5 on Windows). **CPU %** is the share of one
  core since the last reading, as in Activity Monitor and `top`, so a process
  on several cores can pass 100%. **Memory** is resident memory (RSS).
- **Sort and filter.** Click a column header to sort by it, and click it
  again to flip the order. The list starts sorted by **CPU %**, highest first.
  Type in **Filter processes** to match a name, a command line, or a PID. A
  count shows how many processes match.
- **Quit a process.** Click the circled × at the end of its row. With a
  mouse, it shows on hover; on a touch screen, it always shows. With a filter
  typed, **Quit N matching** quits every process the filter shows. A dialog asks
  first: **Quit** sends `SIGTERM`, so apps can save and close, and
  **Force Quit** sends `SIGKILL`. A toast then tells how many quit and why the
  others couldn't, for example **Not permitted** for another user's processes.
- **BB stays up.** BB's own processes, its server, app, helpers, and host
  daemon, have no quit button, and **Quit N matching** skips them. PID 1,
  launchd or init, is protected too. Agents and the programs they start can
  still be quit.

## Guard

Guard keeps BB itself responsive, the app, the server, and the connection to
your phone, whatever the agents and programs it starts do. It runs on macOS,
is on by default, and turns off with the plugin's **Guard** setting.

- **BB first.** Everything BB starts, agents and what they run, gets a lower
  priority (nice 10). On an idle Mac this changes nothing; when the CPU is
  short, BB gets it first.
- **Efficiency cores under load.** When all cores stay over 85% busy for 5
  seconds, the processes BB started that use 10% of a core or more run only
  on the efficiency cores, with throttled disk, until the CPU stays under
  60% for 20 seconds.
- **Pile-ups stop.** When BB's server or host daemon runs three or more
  copies of the same busy command, the oldest for 30 seconds or more, Guard
  stops all but the newest.
- **Pause all.** The button on the **Resources** page stops everything BB
  started, agents, what they run, and BB's terminals, from any device, until
  **Resume all**. BB's own helpers keep running, so BB stays usable.
- **See it act.** The **Resources** page shows Guard's state and its last
  actions.

Guard never touches BB's own processes or processes BB did not start, such
as your apps and macOS's own services.

## How it works

- The plugin has a host entry, which BB runs on every machine, the server's
  too. The server lists BB's persistent machines and asks each connected one
  for a reading at once, every 3 seconds while a BB window shows (open windows
  say so every 15 seconds) and once a minute otherwise. It sends all the
  readings to every open BB window over realtime. Nothing is stored. A
  machine that doesn't answer within 5 seconds keeps its last reading and
  shows as not answering; an offline machine shows when BB last saw it.
- The icon shows each bar at the busiest connected machine's value, so a
  machine near its limit shows wherever it is; the card says which.
  - **CPU**: the share of time all cores were busy since the last reading,
    from Node's `os.cpus()`.
  - **RAM**: on macOS, app memory, wired, and compressed pages from
    `vm_stat`, the way Activity Monitor counts **Memory Used**; on Linux,
    everything but `MemAvailable` in `/proc/meminfo`; elsewhere, Node's
    `os.totalmem() - os.freemem()`.
  - **GPU**: on macOS, the GPU's **Device Utilization** from `ioreg`;
    elsewhere, the busiest NVIDIA GPU from `nvidia-smi`. Without either, the
    GPU bar stays empty and the card shows a dash.
- A reading takes about 10 ms: on macOS, it runs `vm_stat` and `ioreg` once
  each. After 3 failed GPU reads in a row, it stops reading the GPU until the
  plugin reloads.
- The picked machine lists its processes only while a **Resources** page asks
  for them: every 2 seconds while the page is open and visible. On macOS, it
  runs `ps`; on Linux, it reads `/proc`; on Windows, it asks PowerShell for
  `Win32_Process`, and since that costs a good part of a core, it keeps a
  list for 5 seconds there. The `ps` or PowerShell it starts isn't listed. Each process's CPU is the change in its CPU time
  between two readings at least half a second apart. It cuts each command line
  to its first 200 characters, so the filter matches only those. It keeps a
  list for about a second, so several open windows share one reading. Nothing
  is stored.
- BB's own processes can't be quit: on a host machine, the host daemon, what
  started it up to the session manager (`systemd --user`, `launchd`,
  Explorer), their other children, and any program inside BB's app bundle or
  `bb-app` package. The agents the daemon runs can be quit. Windows' own
  processes, such as `csrss.exe` and `lsass.exe`, can't. On Windows, **Quit**
  asks a program to close with `taskkill`, and **Force Quit** ends it with
  `taskkill /F`; a console program that ignores the request says **Needs
  Force Quit**.
- While BB has no connection to the server, the bars and the card are empty
  rather than frozen at the last reading.
- The icon is a component registered with `app.experimental_icons.register()`
  and named as the icon of the plugin's `navPanel`, which puts it in the rail.
  BB draws registered icons outside any plugin context, so an always-mounted
  `experimental_appOverlay` receives the readings and shares them with the
  icon.
- The card is the plugin's own. It mutes BB's tooltip on the icon by stopping
  `pointermove` events on the rail tile before BB's handler sees them.
- A BB update may break `experimental_icons`, `experimental_appOverlay`, the
  rail's `data-nav-rail-item` attribute, or how BB opens the rail's tooltip
  and page.
- Guard is a separate process, so it keeps working when the BB server is
  slow or stuck. The server copies the scripts in `guard/` to
  `~/Library/Application Support/bb-resource-monitor/guard/` and runs them with
  BB's own Node runtime through the LaunchAgent
  `app.getbb.resource-monitor.guard`, which macOS starts at login and
  restarts after a crash. macOS may notify you that BB added a background
  item.
- Every 2 seconds, Guard reads `ps`. BB's own processes are those whose
  program lives inside BB's app bundle; the processes BB started are their
  descendants. Guard acts with `setpriority`, `taskpolicy -b` and `-B`,
  `SIGSTOP`, `SIGCONT`, `SIGTERM`, and `SIGKILL`, without administrator
  rights, and writes what it does to `status.json`, which the page reads.
- Turning the setting off makes Guard resume what it paused, move processes
  back from the efficiency cores, and remove its LaunchAgent. The server
  rewrites a `heartbeat` file every 10 seconds: without it for 10 minutes,
  Guard ignores **Pause all**, and after a day it removes itself. Lowered
  priorities stay, since only an administrator can raise them again.

## Install

Needs BB 0.50.0 or later. The host entry reaches every machine BB has
enrolled; nothing needs installing on them.

```sh
bb plugin install ~/src/bb-setup/plugins/bb-plugin-resource-monitor
```

## Development

```sh
npm ci
npm test
npm run typecheck
npm run build
bb plugin reload resource-monitor
```

## Credits

Resource Monitor is by [Yurii Rebryk](https://github.com/rebryk), one of the
[San Francisco Plugins](https://github.com/rebryk/bb-plugins). This copy adds
every BB machine and Windows processes.
