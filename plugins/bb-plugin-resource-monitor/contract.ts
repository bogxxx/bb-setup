// The RPC methods between the Resources page and the server, and between the
// server and the host entry that reads each machine.
import {
  defineRpcContract,
  type ExperimentalHostSignals,
} from "@get-bb/plugin-sdk";
import { z } from "zod";
import { guardInfoSchema, machinesSchema, sampleSchema } from "./shared";

export const processSchema = z.object({
  pid: z.number(),
  /** The executable's file name, as Activity Monitor shows it. */
  name: z.string(),
  /** The command line, cut to its first characters. */
  command: z.string(),
  /** Share of one core since the last reading, like Activity Monitor: 0–100 × cores. */
  cpuPercent: z.number(),
  /** Resident memory. */
  memoryBytes: z.number(),
  /** Pid 1 or below, a Windows system process, or one of BB's own: never quit. */
  protected: z.boolean(),
});

export type ProcessInfo = z.infer<typeof processSchema>;

const hostId = z.string().min(1).max(200);
const quitInput = {
  pids: z.array(z.number().int().positive()).min(1).max(5000),
  /** SIGKILL, or a forced end on Windows, instead of SIGTERM. */
  force: z.boolean(),
};
const quitOutput = z.object({
  quit: z.number(),
  failed: z.array(z.object({ pid: z.number(), reason: z.string() })),
});

export const rpcContract = defineRpcContract({
  /** Every persistent machine with its latest sample, the server's first. */
  machines: { input: z.null(), output: machinesSchema },
  /**
   * A window shows the icon or the page: sample every few seconds for the next
   * half minute. Without one, the server samples once a minute.
   */
  watch: { input: z.null(), output: z.null() },
  listProcesses: {
    input: z.object({ hostId }).strict(),
    output: z.array(processSchema),
  },
  quitProcesses: {
    input: z.object({ hostId, ...quitInput }).strict(),
    output: quitOutput,
  },
  /** Guard's setting, liveness, and full status file. Guard runs on the server. */
  guardStatus: { input: z.null(), output: guardInfoSchema },
  /**
   * Turns Pause all on or off: what BB started, except its own helpers, is
   * stopped or resumed. Answers once control.json is written, before Guard
   * acts on it.
   */
  setPauseAll: {
    input: z.object({ paused: z.boolean() }).strict(),
    output: guardInfoSchema,
  },
});

/** What the server asks the host entry on each machine. */
export const hostContract = defineRpcContract({
  sample: {
    input: z.object({}).strict(),
    output: sampleSchema,
    experimental_retryable: true,
  },
  listProcesses: {
    input: z.object({}).strict(),
    output: z.array(processSchema),
    experimental_retryable: true,
  },
  quitProcesses: {
    input: z.object(quitInput).strict(),
    output: quitOutput,
  },
});

/** None yet: the server polls. */
export const hostSignals = {} satisfies ExperimentalHostSignals;
