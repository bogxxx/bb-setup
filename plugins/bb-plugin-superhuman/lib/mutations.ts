// Chat output and terminals, which change many times a second while agents
// work and hold nothing the page scripts read.
export const LIVE_OUTPUT = "[data-timeline-row-id], .xterm";

/** Whether any of the records changes the page outside the `quiet` regions. */
export function changedOutside(records: MutationRecord[], quiet: string) {
  let last: Node | undefined;
  return records.some(({ target }) => {
    // A burst of records often shares a target; one check answers for all.
    if (target === last) return false;
    last = target;
    return !(target instanceof Element && target.closest(quiet));
  });
}
