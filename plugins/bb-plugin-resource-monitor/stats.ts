import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import os from "node:os";
import { promisify } from "node:util";
import type { Sample } from "./shared";

type CpuTimes = { busy: number; total: number };
type Gpu = NonNullable<Sample["gpu"]>;

/** A program's output; `ps` command lines can pass Node's 1 MB default. */
export async function run(
  file: string,
  args: string[],
  timeout = 1500,
): Promise<string> {
  const options = { timeout, maxBuffer: 64 << 20, windowsHide: true };
  return (await promisify(execFile)(file, args, options)).stdout;
}

/** Busy and total time of all cores together. */
function cpuTimes(): CpuTimes {
  let busy = 0;
  let total = 0;
  for (const { times } of os.cpus()) {
    const all = times.user + times.nice + times.sys + times.idle + times.irq;
    busy += all - times.idle;
    total += all;
  }
  return { busy, total };
}

/** Busy share of all cores between two readings, 0–100. */
export function cpuPercent(before: CpuTimes, after: CpuTimes): number {
  const total = after.total - before.total;
  return total > 0 ? (100 * (after.busy - before.busy)) / total : 0;
}

/**
 * Memory in use the way Activity Monitor counts it: app memory, wired, and
 * compressed. Free, cached, and purgeable pages are left out.
 */
export function parseVmStat(text: string): number | null {
  const pageSize = Number(/page size of (\d+) bytes/u.exec(text)?.[1]);
  const pages = (label: string) =>
    Number(new RegExp(`${label}:\\s+(\\d+)`, "u").exec(text)?.[1] ?? NaN);
  const used =
    pages("Anonymous pages") -
    pages("Pages purgeable") +
    pages("Pages wired down") +
    pages("Pages occupied by compressor");
  return Number.isFinite(used) && pageSize > 0 ? used * pageSize : null;
}

/** Linux: everything but MemAvailable is in use. */
export function parseMemInfo(text: string): number | null {
  const kib = (label: string) =>
    Number(new RegExp(`^${label}:\\s+(\\d+) kB`, "mu").exec(text)?.[1] ?? NaN);
  const used = kib("MemTotal") - kib("MemAvailable");
  return Number.isFinite(used) ? used * 1024 : null;
}

async function usedMemory(): Promise<number> {
  try {
    if (process.platform === "darwin") {
      const used = parseVmStat(await run("/usr/bin/vm_stat", []));
      if (used !== null) return used;
    } else if (process.platform === "linux") {
      const used = parseMemInfo(await readFile("/proc/meminfo", "utf8"));
      if (used !== null) return used;
    }
  } catch {
    // Fall through to Node's figure.
  }
  return os.totalmem() - os.freemem();
}

/** macOS: the first accelerator's utilization from the IORegistry. */
export function parseIoreg(text: string): Gpu | null {
  const percent = /"Device Utilization %"=(\d+)/u.exec(text)?.[1];
  if (percent === undefined) return null;
  return {
    percent: Number(percent),
    name: /"model" = "([^"]+)"/u.exec(text)?.[1] ?? "GPU",
  };
}

/** NVIDIA: the busiest GPU from `nvidia-smi` CSV output. */
export function parseNvidiaSmi(text: string): Gpu | null {
  const gpus = text
    .trim()
    .split("\n")
    .map((line) => line.split(",").map((cell) => cell.trim()))
    .filter((cells) => cells.length === 2 && cells[0] !== "")
    .map(([name, percent]) => ({ name, percent: Number(percent) }))
    .filter((gpu) => Number.isFinite(gpu.percent));
  if (gpus.length === 0) return null;
  return gpus.reduce((busiest, gpu) =>
    gpu.percent > busiest.percent ? gpu : busiest,
  );
}

async function readGpu(): Promise<Gpu | null> {
  if (process.platform === "darwin") {
    return parseIoreg(
      await run("/usr/sbin/ioreg", ["-r", "-d", "1", "-w", "0", "-c", "IOAccelerator"]),
    );
  }
  return parseNvidiaSmi(
    await run("nvidia-smi", [
      "--query-gpu=name,utilization.gpu",
      "--format=csv,noheader,nounits",
    ]),
  );
}

/** GPU reads that may fail in a row before the sampler stops asking. */
const GPU_TRIES = 3;

/** Reads one sample per call; CPU load covers the time since the last call. */
export function createSampler() {
  const cpus = os.cpus();
  const model = cpus[0]?.model ?? "CPU";
  const coreCount = cpus.length;
  let previous = cpuTimes();
  let gpuFailures = 0;

  async function gpu(): Promise<Gpu | null> {
    if (gpuFailures >= GPU_TRIES) return null;
    try {
      const reading = await readGpu();
      gpuFailures = 0;
      return reading;
    } catch {
      gpuFailures += 1;
      return null;
    }
  }

  return async function sample(): Promise<Sample> {
    const now = cpuTimes();
    const percent = cpuPercent(previous, now);
    previous = now;
    const [usedBytes, gpuReading] = await Promise.all([usedMemory(), gpu()]);
    return {
      cpu: { percent, coreCount, model },
      memory: { usedBytes, totalBytes: os.totalmem() },
      gpu: gpuReading,
      hostname: os.hostname(),
      uptimeSeconds: os.uptime(),
    };
  };
}
