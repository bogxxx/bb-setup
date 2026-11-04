import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useRealtime, useRealtimeConnectionState, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../../server";
import type { ChatItem, DetailFilter, ListSubagentsResult, SubagentDetailResult } from "../contract";

export type ListSnapshot = {
  list: ListSubagentsResult | null;
  error: string | null;
  loadedAt: number;
};

const emptySnapshot: ListSnapshot = { list: null, error: null, loadedAt: 0 };
const snapshots = new Map<string, ListSnapshot>();
const listListeners = new Map<string, Set<() => void>>();

type ListRuntime = {
  subscribers: number;
  generation: number;
  timer?: number;
  call?: () => Promise<ListSubagentsResult>;
  reconnectGate?: string;
  didConnect: boolean;
};

const runtimes = new Map<string, ListRuntime>();

function runtimeFor(threadId: string): ListRuntime {
  let runtime = runtimes.get(threadId);
  if (!runtime) {
    runtime = { subscribers: 0, generation: 0, didConnect: false };
    runtimes.set(threadId, runtime);
  }
  return runtime;
}

function subscribeList(threadId: string, listener: () => void) {
  let set = listListeners.get(threadId);
  if (!set) {
    set = new Set();
    listListeners.set(threadId, set);
  }
  set.add(listener);
  return () => set.delete(listener);
}

function publishList(threadId: string, snapshot: ListSnapshot) {
  snapshots.set(threadId, snapshot);
  listListeners.get(threadId)?.forEach((listener) => listener());
}

async function runLoad(threadId: string) {
  const runtime = runtimeFor(threadId);
  const call = runtime.call;
  if (!call) return;
  const generation = ++runtime.generation;
  try {
    const list = await call();
    if (runtime.generation !== generation) return;
    publishList(threadId, { list, error: null, loadedAt: Date.now() });
  } catch (error) {
    if (runtime.generation !== generation) return;
    publishList(threadId, {
      list: snapshots.get(threadId)?.list ?? null,
      error: messageOf(error),
      loadedAt: Date.now(),
    });
  }
}

export function reloadSubagentList(threadId: string) {
  void runLoad(threadId);
}

export function useSharedSubagentList(threadId: string, enabled: boolean): ListSnapshot {
  const rpc = useRpc<typeof rpcContract>();
  const connection = useRealtimeConnectionState();
  const rpcRef = useRef(rpc);
  rpcRef.current = rpc;
  const snapshot = useSyncExternalStore(
    (listener) => subscribeList(threadId, listener),
    () => snapshots.get(threadId) ?? emptySnapshot,
    () => emptySnapshot,
  );

  useEffect(() => {
    if (!enabled) return;
    const runtime = runtimeFor(threadId);
    runtime.subscribers += 1;
    runtime.call = () => rpcRef.current.call("listSubagents", { threadId });
    if (runtime.subscribers === 1) void runLoad(threadId);
    return () => {
      runtime.subscribers -= 1;
      if (runtime.subscribers <= 0) {
        runtime.subscribers = 0;
        window.clearTimeout(runtime.timer);
        runtime.generation += 1;
      }
    };
  }, [enabled, threadId]);

  useRealtime("thread-events", (payload) => {
    if (!enabled) return;
    const data = payload && typeof payload === "object" ? (payload as { threadId?: unknown }) : null;
    if (!data || data.threadId !== threadId) return;
    const runtime = runtimeFor(threadId);
    window.clearTimeout(runtime.timer);
    runtime.timer = window.setTimeout(() => {
      if (runtime.subscribers > 0) void runLoad(threadId);
    }, 750);
  });

  useEffect(() => {
    if (!enabled) return;
    const runtime = runtimeFor(threadId);
    if (runtime.reconnectGate === connection) return;
    runtime.reconnectGate = connection;
    if (connection !== "connected") return;
    if (!runtime.didConnect) {
      runtime.didConnect = true;
      return;
    }
    void runLoad(threadId);
  }, [connection, enabled, threadId]);

  return snapshot;
}

export function useSubagentDetail(threadId: string, familyId: string | null, visible: boolean) {
  const rpc = useRpc<typeof rpcContract>();
  const connection = useRealtimeConnectionState();
  const [detail, setDetail] = useState<SubagentDetailResult | null>(null);
  const [items, setItems] = useState<ChatItem[]>([]);
  const [filter, setFilterState] = useState<DetailFilter>("all");
  const [detailError, setDetailError] = useState<string | null>(null);
  const pagedBack = useRef(false);
  const detailGen = useRef(0);
  const threadRef = useRef(threadId);
  const familyRef = useRef(familyId);
  const filterRef = useRef(filter);
  const inProgressRef = useRef(false);
  const debounceRef = useRef<number | undefined>(undefined);
  const sawConnection = useRef(false);
  const wasInProgress = useRef(false);
  const loadDetailRef = useRef<(familyId: string, mode: "replace" | "prepend", before?: number) => void>(() => {});
  threadRef.current = threadId;
  familyRef.current = familyId;
  filterRef.current = filter;
  inProgressRef.current = detail?.agent.familyId === familyId && detail.agent.status === "in_progress";

  const loadDetail = useCallback(
    (nextFamilyId: string, mode: "replace" | "prepend", before?: number) => {
      const gen = ++detailGen.current;
      const requested = threadRef.current;
      return rpc
        .call("subagentDetail", {
          threadId: requested,
          familyId: nextFamilyId,
          filter: filterRef.current,
          limit: 40,
          ...(before === undefined ? {} : { before }),
        })
        .then(
          (result) => {
            if (gen !== detailGen.current || requested !== threadRef.current || familyRef.current !== nextFamilyId) return;
            setDetail(result);
            setDetailError(null);
            setItems((current) => {
              if (mode === "replace") return result.items;
              const seen = new Set(current.map((item) => item.index));
              return [...result.items.filter((item) => !seen.has(item.index)), ...current].sort((a, b) => a.index - b.index);
            });
          },
          (error: unknown) => {
            if (gen === detailGen.current) setDetailError(messageOf(error));
          },
        );
    },
    [rpc],
  );
  loadDetailRef.current = loadDetail;

  useEffect(() => {
    setDetail(null);
    setItems([]);
    pagedBack.current = false;
  }, [threadId]);

  useEffect(() => {
    if (!familyId) {
      setDetail(null);
      setItems([]);
      pagedBack.current = false;
      return;
    }
    pagedBack.current = false;
    void loadDetail(familyId, "replace");
  }, [familyId, filter, threadId, loadDetail]);

  useRealtime("thread-events", (payload) => {
    const data = payload && typeof payload === "object" ? (payload as { threadId?: unknown }) : null;
    if (!data || data.threadId !== threadRef.current) return;
    window.clearTimeout(debounceRef.current);
    debounceRef.current = window.setTimeout(() => {
      const current = familyRef.current;
      if (current && inProgressRef.current && !pagedBack.current) void loadDetailRef.current(current, "replace");
    }, 750);
  });

  useEffect(() => () => window.clearTimeout(debounceRef.current), []);

  useEffect(() => {
    if (connection !== "connected") return;
    if (!sawConnection.current) {
      sawConnection.current = true;
      return;
    }
    const current = familyRef.current;
    if (current) {
      pagedBack.current = false;
      void loadDetailRef.current(current, "replace");
    }
  }, [connection]);

  const inProgress = Boolean(familyId && detail?.agent.status === "in_progress" && detail.agent.familyId === familyId);
  useEffect(() => {
    if (!familyId || !visible || !inProgress) {
      if (wasInProgress.current && familyId && !inProgress) {
        wasInProgress.current = false;
        void loadDetailRef.current(familyId, "replace");
        reloadSubagentList(threadRef.current);
      } else if (!inProgress) {
        wasInProgress.current = false;
      }
      return;
    }
    wasInProgress.current = true;
    const timer = window.setInterval(() => {
      if (familyRef.current && !pagedBack.current) {
        void loadDetailRef.current(familyRef.current, "replace");
        reloadSubagentList(threadRef.current);
      }
    }, 5000);
    return () => window.clearInterval(timer);
  }, [familyId, inProgress, visible]);

  return {
    detail,
    items,
    filter,
    detailError,
    setFilter: (next: DetailFilter) => {
      pagedBack.current = false;
      setFilterState(next);
    },
    retry: () => {
      if (familyId) void loadDetail(familyId, "replace");
    },
    earlier: () => {
      if (!familyId || detail?.page.before == null) return;
      pagedBack.current = true;
      void loadDetail(familyId, "prepend", detail.page.before);
    },
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error && error.message ? error.message : "Could not load subagents.";
}
