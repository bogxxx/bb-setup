// The host entry: runs on each BB machine, the server's too, and reads that
// machine's load and processes for the server.
import { setTimeout as sleep } from "node:timers/promises";
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { hostContract, hostSignals } from "./contract";
import { createProcessMonitor, protectionAnchor } from "./processes";
import { createSampler } from "./stats";

/** CPU load needs two readings this far apart at least. */
const FIRST_SPAN_MS = 500;

let sampler: { sample: ReturnType<typeof createSampler>; since: number } | null = null;
const monitor = createProcessMonitor(protectionAnchor(true), process.pid);

async function sample() {
  if (!sampler) sampler = { sample: createSampler(), since: performance.now() };
  // A fresh worker has no earlier CPU reading to measure against yet.
  const wait = sampler.since + FIRST_SPAN_MS - performance.now();
  if (wait > 0) await sleep(wait);
  return sampler.sample();
}

export default experimental_defineHostEntry({
  contract: hostContract,
  experimental_signals: hostSignals,
  handlers: {
    sample: () => sample(),
    listProcesses: () => monitor.listProcesses(),
    quitProcesses: (input) => monitor.quitProcesses(input),
  },
});
