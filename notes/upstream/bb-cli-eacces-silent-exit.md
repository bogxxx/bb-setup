# bb CLI exits 0 silently when BB_CLI is not executable (macOS/Linux)

## Repro

bb-app 0.48.1. `host-daemon/dist/bb` is installed with mode 644. With `BB_CLI` set to that path, `bb status` prints nothing and exits 0.

Direct exec of that file is permission denied (exit 126). `node "$BB_CLI" status` prints a normal status. Unsetting `BB_CLI` also prints a normal status, because that path runs the file under `node`.

## Root cause

`resolveBundledCliLaunch` in `dist/bb.js` (around 17442–17449 in the 0.48.1 install) spawns `BB_CLI` directly on macOS and Linux. Spawn of a mode 644 file emits `error` `EACCES` and no `exit`. `waitForProcessExit` (around 15633–15644) only listens for `exit`, and `observe` (around 3185–3188) swallows the `error` event. The event loop then drains and Node exits 0.

When `BB_CLI` is unset, the launcher runs `node` on `host-daemon/dist/bb`. On Windows, an extensionless `BB_CLI` is also run under `node`. The macOS and Linux branch does not.

`host-daemon/dist/bb` is not a `package.json` `bin` entry (`dist/bb.js` is, and that file is mode 755). Nothing in this repo writes the 644 file. A later `bb-app` auto-update replaces it.

## Suggested fix

- Run a non-executable `BB_CLI` under `node`, as Windows and the unset-`BB_CLI` path already do.
- Map a spawn `error` to a non-zero exit, so `EACCES` cannot look like success.
- Ship `dist/bb` with mode 755.
