// The host entry: runs on each BB machine as the person BB runs as. It scans
// and cleans that machine's disk; the server passes what only BB knows.
import { homedir } from "node:os";
import type { ExperimentalHostRpcContext } from "@get-bb/plugin-sdk";
import {
  experimental_defineHostEntry,
  experimental_sanitizeInheritedChildProcessEnv,
} from "@get-bb/plugin-sdk/host";
import { hostContract, hostSignals } from "./contract";
import { bbDataOf, createMachine, type MachineApi } from "./machine";
import { platformOf } from "./platform";

let machine: MachineApi | null = null;
/** The latest call's signal sender; signals may go after their call ends. */
let emit: (reason: string) => void = () => undefined;

type Paths = { dataDir: string; tempDir: string };

function machineFor(paths: Paths) {
  machine ??= createMachine({
    platform: platformOf(process.platform),
    home: homedir(),
    bbData: bbDataOf(paths.dataDir),
    dataDir: paths.dataDir,
    tempDir: paths.tempDir,
    env: experimental_sanitizeInheritedChildProcessEnv({ env: process.env }),
    emit: (reason) => emit(reason),
    log: (message) => console.warn(`[storage-cleaner] ${message}`),
  });
  return machine;
}

type Context = ExperimentalHostRpcContext<typeof hostSignals>;
/** A lease from this call's context, which keeps the worker alive past it. */
const leaseOf = (context: Context) => () => {
  try {
    return context.experimental_retainWorker();
  } catch {
    return { dispose: async () => undefined };
  }
};

function enter(context: Context) {
  emit = (reason) =>
    void context.experimental_emitSignal("changed", { reason }).catch(() => undefined);
  return machineFor(context.experimental_paths);
}

export default experimental_defineHostEntry({
  contract: hostContract,
  experimental_signals: hostSignals,
  handlers: {
    probe: (_input, context) => enter(context).probe(),
    snapshot: (input, context) =>
      enter(context).snapshot(input, leaseOf(context)),
    folder: ({ path, ...known }, context) => enter(context).folder(known, path),
    rescan: ({ wait }, context) =>
      enter(context).rescan(wait, leaseOf(context)),
    openFullDiskAccess: (_input, context) => enter(context).openFullDiskAccess(),
    delete: ({ paths, ...known }, context) => enter(context).delete(known, paths),
    bbThreadIds: (_input, context) => enter(context).bbThreadIds(),
    clean: ({ threads, inUse, ...input }, context) =>
      enter(context).clean({ threads, inUse }, input),
  },
});
