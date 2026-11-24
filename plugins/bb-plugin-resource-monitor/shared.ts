import { z } from "zod";

/** Realtime channel that carries every machine's latest sample. */
export const SAMPLE_CHANNEL = "machines";

export const sampleSchema = z.object({
  cpu: z.object({
    /** Busy share of all cores, 0–100. */
    percent: z.number(),
    coreCount: z.number(),
    model: z.string(),
  }),
  memory: z.object({
    usedBytes: z.number(),
    totalBytes: z.number(),
  }),
  /** Null when this machine reports no GPU load. */
  gpu: z.object({ percent: z.number(), name: z.string() }).nullable(),
  hostname: z.string(),
  uptimeSeconds: z.number(),
  /** True where Guard runs (BB's app on macOS). Absent from older servers. */
  guard: z.boolean().optional(),
});

export type Sample = z.infer<typeof sampleSchema>;

/** Guard's `status.json`; the guard daemon rewrites it at least every 5 s. */
export const guardStatusSchema = z.object({
  /** Epoch milliseconds. */
  updatedAt: z.number(),
  /** overload: busy processes run on the efficiency cores; paused: Pause all. */
  mode: z.enum(["normal", "overload", "paused"]),
  counts: z.object({ background: z.number(), paused: z.number() }),
  /** The last 20, oldest first; `at` in epoch milliseconds. */
  events: z.array(
    z.object({
      at: z.number(),
      message: z.string(),
      error: z.boolean().optional(),
    }),
  ),
});

export type GuardStatus = z.infer<typeof guardStatusSchema>;

/** The guardStatus and setPauseAll answer. */
export const guardInfoSchema = z.object({
  /** The plugin setting. */
  enabled: z.boolean(),
  /** A fresh status file exists. */
  running: z.boolean(),
  /** Pause all is on (control.json). */
  pauseAll: z.boolean(),
  status: guardStatusSchema.nullable(),
});

export type GuardInfo = z.infer<typeof guardInfoSchema>;

/** One BB machine and its latest sample. */
export const machineSampleSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** The machine the BB server runs on. */
  primary: z.boolean(),
  connected: z.boolean(),
  /** When BB last heard from the machine, epoch milliseconds. */
  lastSeenAt: z.number().nullable(),
  /** The latest sample; kept after a machine goes offline. */
  sample: sampleSchema.nullable(),
  /** When `sample` was read, epoch milliseconds. */
  sampledAt: z.number().nullable(),
  /** Why the latest read failed, if it did. */
  error: z.string().nullable(),
});

export type MachineSample = z.infer<typeof machineSampleSchema>;

/** What the realtime channel and the `machines` call carry. */
export const machinesSchema = z.object({ machines: z.array(machineSampleSchema) });

export type Machines = z.infer<typeof machinesSchema>;

/**
 * The rail icon's reading: each bar at the busiest connected machine's value,
 * so any machine near its limit shows. Null without a connected sample.
 */
export function busiest(machines: MachineSample[]): Sample | null {
  const live = machines.filter((m) => m.connected && m.sample);
  if (!live.length) return null;
  const samples = live.map((m) => m.sample!);
  const ram = (s: Sample) => s.memory.usedBytes / Math.max(1, s.memory.totalBytes);
  const cpu = samples.reduce((a, b) => (b.cpu.percent > a.cpu.percent ? b : a));
  const mem = samples.reduce((a, b) => (ram(b) > ram(a) ? b : a));
  const gpus = samples.filter((s) => s.gpu);
  const gpu = gpus.length
    ? gpus.reduce((a, b) => (b.gpu!.percent > a.gpu!.percent ? b : a)).gpu
    : null;
  return { ...cpu, memory: mem.memory, gpu };
}
