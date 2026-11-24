// The RPC methods between the page and the server, and between the server and
// the host entry that scans and cleans each machine.
import {
  defineRpcContract,
  type ExperimentalHostSignals,
} from "@get-bb/plugin-sdk";
import { z } from "zod";
import type { Machine, Node, Snapshot } from "./shared";

const result = z.object({ freed: z.number(), failed: z.array(z.string()) });
const hostId = z.string().min(1).max(200);
const path = z.string().max(4096);
const pathList = z.array(path).min(1).max(1000);
const target = z.enum(["bb", "dev", "trash"]);
const folderOutput = z
  .object({ path: z.string(), node: z.custom<Node>() })
  .nullable();

export const rpcContract = defineRpcContract({
  storageMachines: {
    input: z.null(),
    output: z.custom<{ machines: Machine[]; primaryId: string | null }>(),
  },
  storageSnapshot: {
    input: z.object({ hostId }).strict(),
    /** Null with an error when the machine can't be reached. */
    output: z.custom<{ snapshot: Snapshot | null; error: string | null }>(),
  },
  storageFolder: {
    input: z.object({ hostId, path }).strict(),
    output: folderOutput,
  },
  storageRescan: { input: z.object({ hostId }).strict(), output: z.null() },
  storageOpenFullDiskAccess: {
    input: z.object({ hostId }).strict(),
    output: z.null(),
  },
  storageDelete: {
    input: z.object({ hostId, paths: pathList }).strict(),
    output: result,
  },
  storageClean: {
    input: z.object({ hostId, target }).strict(),
    output: result,
  },
});

/** A thread as the host needs it: [id, title, project, archivedAt ms or null]. */
const thread = z.tuple([
  z.string().max(200),
  z.string().max(2000),
  z.string().max(2000),
  z.number().nullable(),
]);
export type ThreadRow = z.infer<typeof thread>;

/** What BB knows that the machine doesn't: its threads, and the workspaces live threads use. */
const known = {
  threads: z.array(thread).max(200_000),
  inUse: z.array(path).max(200_000),
};

export const hostContract = defineRpcContract({
  probe: {
    input: z.object({}).strict(),
    output: z
      .object({
        platform: z.string(),
        home: z.string(),
        bbData: z.string().nullable(),
        drive: z.string().nullable(),
      })
      .strict(),
    experimental_retryable: true,
  },
  snapshot: {
    input: z.object(known).strict(),
    output: z.custom<Snapshot>(),
  },
  folder: {
    input: z.object({ ...known, path }).strict(),
    output: folderOutput,
    experimental_retryable: true,
  },
  /** Starts a scan; with `wait`, answers when it ends. */
  rescan: {
    input: z.object({ wait: z.boolean() }).strict(),
    output: z.object({ ok: z.boolean(), error: z.string().nullable() }).strict(),
  },
  openFullDiskAccess: { input: z.object({}).strict(), output: z.null() },
  delete: {
    input: z.object({ ...known, paths: pathList }).strict(),
    output: result,
  },
  /** Thread ids of the thread storage and worktree folders in the scan. */
  bbThreadIds: {
    input: z.object({}).strict(),
    output: z.object({ ids: z.array(z.string()) }).strict(),
    experimental_retryable: true,
  },
  clean: {
    input: z
      .object({
        ...known,
        target,
        /** Threads BB reported not found, whose folders may go. */
        gone: z.array(z.string().max(200)).max(200_000),
        bbThreads: z.boolean(),
        bbWorktrees: z.boolean(),
        /** Only what is at least this many days old; everything when null. */
        staleDays: z.number().int().min(1).max(3650).nullable(),
      })
      .strict(),
    output: result,
  },
});

export const hostSignals = {
  /** The machine's scan or its state changed; the page should read it again. */
  changed: { payload: z.object({ reason: z.string().max(200) }).strict() },
} satisfies ExperimentalHostSignals;
