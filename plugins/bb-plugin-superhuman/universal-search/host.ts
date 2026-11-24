export const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/** Read only the DOM node's React ancestors, with a bounded, checked walk. */
function* ancestors(element: HTMLElement): Generator<Record<string, unknown>> {
  const key = Object.getOwnPropertyNames(element).find((key) =>
    key.startsWith("__reactFiber$"),
  );
  let fiber: unknown = key && Reflect.get(element, key);
  for (let depth = 0; depth < 128 && object(fiber); depth++) {
    if (object(fiber.memoizedProps)) yield fiber.memoizedProps;
    fiber = fiber.return;
  }
}

export function commandRow(element: HTMLElement) {
  for (const props of ancestors(element)) {
    const entry = props.entry;
    if (!object(entry) || !object(entry.action)) continue;
    const action = entry.action;
    if (typeof action.id !== "string" || typeof action.title !== "string"
      || typeof action.group !== "string" || typeof props.onSelect !== "function") return null;
    return {
      id: action.id,
      title: action.title,
      group: action.group,
      select: props.onSelect as () => void,
    };
  }
  return null;
}

export function searchCache(anchor: HTMLElement): (() => Promise<void>) | null {
  for (const props of ancestors(anchor)) {
    const client = props.client ?? props.value;
    if (!object(client) || typeof client.getQueryCache !== "function"
      || typeof client.invalidateQueries !== "function") continue;
    const cache = client.getQueryCache();
    if (!object(cache) || typeof cache.find !== "function"
      || !cache.find({ queryKey: ["systemConfig"], exact: true })) continue;
    const invalidate = client.invalidateQueries.bind(client);
    // Settles once BB has the refetched results.
    return () => Promise.resolve(invalidate({ queryKey: ["threadSearch"] })).then(() => {}, () => {});
  }
  return null;
}
