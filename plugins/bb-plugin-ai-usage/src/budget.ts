// The time one extras call may take. The call runs blocking child processes
// (spawnSync) and network requests inside the host worker, so each step asks
// for its time here: the step's own limit, or what is left of the budget. A
// step that cannot start in the time left is skipped, so the call settles
// inside the budget the server waits for.

/** The budget of one extras call; the server waits 30 s, so this stays under it. */
export const EXTRAS_BUDGET_MS = 25_000;

/** Less than this left is not enough to start a step. */
const MIN_STEP_MS = 500;

let endsAt = Number.POSITIVE_INFINITY;

/** Starts a budget of `ms` for the call that runs next. Calls run one at a time (see measureUsage). */
export function startBudget(ms: number): void {
  endsAt = Date.now() + ms;
}

/** The limit for one step: its own limit, or the time left; null when too little is left to start it. */
export function stepLimit(ms: number): number | null {
  const left = endsAt - Date.now();
  if (left < MIN_STEP_MS) return null;
  return Math.min(ms, left);
}
