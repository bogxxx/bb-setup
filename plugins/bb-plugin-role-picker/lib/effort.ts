// The reasoning level a spawned planner or reviewer runs at: the orchestrator's, fitted to the
// levels the target model lists in BB's catalog. Pure: the server reads the catalog and passes it in.

// Ascending effort. ultra and ultracode name the same top tier on different providers.
const EFFORT_RANK = new Map<string, number>([
  ["none", 0],
  ["low", 1],
  ["medium", 2],
  ["high", 3],
  ["xhigh", 4],
  ["max", 5],
  ["ultra", 6],
  ["ultracode", 6],
]);

export type CatalogModel = {
  id: string;
  model?: string;
  isDefault?: boolean;
  supportedReasoningEfforts?: { reasoningEffort: string }[];
};

export type EffortPin = { model?: string; reasoningLevel?: string };

/**
 * The listed level for a requested one: the request when it is listed; the other top tier for
 * ultra and ultracode; else the highest listed level below the request; else the lowest listed.
 * Listed levels with no known rank are ignored. With none left, the request passes through.
 */
export function fitLevel(requested: string, listed: string[]): string {
  const ranked = listed.filter((level) => EFFORT_RANK.has(level));
  const want = EFFORT_RANK.get(requested);
  if (ranked.length === 0 || want === undefined) return requested;
  if (ranked.includes(requested)) return requested;
  if (requested === "ultra" && ranked.includes("ultracode")) return "ultracode";
  if (requested === "ultracode" && ranked.includes("ultra")) return "ultra";
  const below = ranked.filter((level) => EFFORT_RANK.get(level)! <= want);
  const pick = (levels: string[], better: (a: number, b: number) => boolean) =>
    levels.reduce((best, level) => (better(EFFORT_RANK.get(level)!, EFFORT_RANK.get(best)!) ? level : best));
  return below.length > 0 ? pick(below, (a, b) => a > b) : pick(ranked, (a, b) => a < b);
}

/**
 * The pin with its reasoning level fitted to the catalog. An unreadable request (empty or unknown)
 * keeps the pin. Copilot ids carry the level in their name (<model>-<level>): the id is swapped to the
 * listed one, so the model is always an id the catalog lists. Other providers keep the model and fit
 * the level. A model the catalog does not list gets the request as it is. Null catalog: the same.
 */
export function fitEffort(
  pin: EffortPin,
  requested: string | null | undefined,
  catalog: CatalogModel[] | null,
  opts: { suffixed: boolean },
): EffortPin {
  if (!requested || !EFFORT_RANK.has(requested)) return pin;
  return opts.suffixed ? fitSuffixed(pin, requested, catalog) : fitListed(pin, requested, catalog);
}

function fitSuffixed(pin: EffortPin, requested: string, catalog: CatalogModel[] | null): EffortPin {
  const suffix = pin.model?.match(/^(.+)-([a-z]+)$/);
  if (!suffix || !EFFORT_RANK.has(suffix[2]!) || !catalog) return pin;
  const base = suffix[1]!;
  const available = catalog
    .filter((entry) => entry.id.startsWith(`${base}-`))
    .map((entry) => entry.id.slice(base.length + 1))
    .filter((level) => EFFORT_RANK.has(level));
  if (available.length === 0) return pin;
  const level = fitLevel(requested, available);
  return { model: `${base}-${level}`, reasoningLevel: level };
}

function fitListed(pin: EffortPin, requested: string, catalog: CatalogModel[] | null): EffortPin {
  const entry = catalog?.find((model) =>
    pin.model === undefined ? model.isDefault === true : model.id === pin.model || model.model === pin.model,
  );
  const listed = entry?.supportedReasoningEfforts?.map((effort) => effort.reasoningEffort) ?? [];
  if (listed.length === 0) return { model: pin.model, reasoningLevel: requested };
  return { model: pin.model, reasoningLevel: fitLevel(requested, listed) };
}
