// spawnSync with SIGKILL at the timeout. agy ignores SIGTERM and waits on a futex, so a SIGTERM at the
// timeout never returns: spawnSync waits for the child to exit, and the host worker stops answering.
import { spawnSync, type SpawnSyncOptionsWithStringEncoding, type SpawnSyncReturns } from "node:child_process";

export function runSync(command: string, args: readonly string[], options: SpawnSyncOptionsWithStringEncoding): SpawnSyncReturns<string> {
  return spawnSync(command, [...args], { ...options, killSignal: "SIGKILL" });
}
