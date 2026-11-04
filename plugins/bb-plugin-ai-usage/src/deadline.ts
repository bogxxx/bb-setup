// A hard limit on a call that crosses to a machine. The host call's own timeout
// has not always answered when the machine stopped replying, so the server
// also stops waiting after the limit, whatever the transport does.

/** Rejects with `label did not answer in N seconds` when `work` has not settled after `ms`. */
export function withDeadline<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} did not answer in ${Math.round(ms / 1000)} seconds`)), ms);
  });
  return Promise.race([work, late]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}
