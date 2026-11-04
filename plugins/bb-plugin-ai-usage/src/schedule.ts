// Which machines get a refresh without a poll: every connected persistent machine
// after the plugin starts or a machine connects, and any connected machine that is
// still loading when the machines list is read. Refreshes start one after another,
// a fixed step apart, so one restart does not put every machine's work on at once.

export interface MachineState {
  id: string;
  connected: boolean;
  persistent: boolean;
  /** A refresh of this machine is already in flight. */
  refreshing: boolean;
}

/** The connected persistent machines with no refresh in flight, in the order given. */
export function refreshTargets(machines: MachineState[]): string[] {
  return machines.filter((m) => m.connected && m.persistent && !m.refreshing).map((m) => m.id);
}

/** When the nth refresh of a batch starts, in milliseconds from the batch's start. */
export function staggerMs(index: number, stepMs = 2_000): number {
  return Math.max(0, index) * stepMs;
}
