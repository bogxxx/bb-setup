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

/**
 * The refreshes the plugin has scheduled and not yet started. A machine has at most one timer:
 * a trigger for a machine with a timer pending adds nothing. After dispose, nothing is scheduled
 * and every pending timer is cancelled.
 */
export class Refresher {
  private readonly timers = new Map<string, unknown>();
  private disposed = false;

  constructor(
    private readonly start: (id: string) => void,
    private readonly later: (fn: () => void, ms: number) => unknown = (fn, ms) => setTimeout(fn, ms),
    private readonly cancel: (timer: unknown) => void = (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
  ) {}

  /** Schedules each machine in turn, a step after the one before, unless it already has a timer. */
  schedule(ids: string[]): void {
    if (this.disposed) return;
    ids.forEach((id, index) => {
      if (this.timers.has(id)) return;
      const timer = this.later(() => {
        this.timers.delete(id);
        if (!this.disposed) this.start(id);
      }, staggerMs(index));
      this.timers.set(id, timer);
    });
  }

  /** How many refreshes are waiting to start. */
  get pending(): number {
    return this.timers.size;
  }

  dispose(): void {
    this.disposed = true;
    for (const timer of this.timers.values()) this.cancel(timer);
    this.timers.clear();
  }
}
