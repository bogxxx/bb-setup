**bb CLI exits 0 with no output when `BB_CLI` is not executable (bb-app 0.48.1, macOS, Node 26.13.0)**

1. `host-daemon/dist/bb` is installed with mode 0644. It is not in `package.json` `bin`, and there is no postinstall, so npm never sets `+x`. The host daemon still puts it into provider shells as `BB_CLI` (`Npe` → `runtimeShellEnv`). Every `bb-app` update resets the mode.
2. In `dist/bb.js`, `resolveBundledCliLaunch` spawns `cliOverride` directly on non-Windows platforms. `spawn` emits `error` (EACCES) and `close` (-13) but never `exit`. `observe()` consumes the error, and `waitForProcessExit` listens only for `exit`. `runLauncherEntry` runs `void entry()`, so `process.exitCode` is never set and the process exits 0 silently. The PATH lookup already rejects non-executables (`executable()`), but the `BB_CLI` re-exec does not.

Repro: `chmod 644 "$BB_CLI"; bb status; echo $?` prints nothing and exits 0.

Requested fixes:

- (a) Ship the file as 0755, or `chmodSync` it at daemon start as is done for `node-pty`'s `spawn-helper`.
- (b) Run a non-executable `BB_CLI` with `node`, as the win32 branch does.
- (c) Treat a spawn `error` as a non-zero exit with a message.

Fix (a) alone leaves the next non-executable `BB_CLI` failing silently.
