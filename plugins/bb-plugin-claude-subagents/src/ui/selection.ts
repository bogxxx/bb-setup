import { useCallback, useSyncExternalStore } from "react";

const selections = new Map<string, string>();
const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function publish() {
  for (const listener of listeners) listener();
}

export function useSelectedFamily(threadId: string) {
  const familyId = useSyncExternalStore(
    subscribe,
    () => selections.get(threadId) ?? null,
    () => null,
  );
  const setFamilyId = useCallback(
    (next: string | null) => {
      const current = selections.get(threadId) ?? null;
      if (current === next) return;
      if (next === null) selections.delete(threadId);
      else selections.set(threadId, next);
      publish();
    },
    [threadId],
  );
  return [familyId, setFamilyId] as const;
}

export function resetSelectedFamilies() {
  selections.clear();
  publish();
}
