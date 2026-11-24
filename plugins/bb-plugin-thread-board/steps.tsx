// Hover preview for a thread link, and the small chip the card and the sidebar share.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { experimental_useSidebarThreads, useSdk, useSettings } from "@get-bb/plugin-sdk/app";
import { board, COLUMNS, threadPreview, type BoardThread, type PreviewAgent, type PreviewYou, type Tag, type ThreadPreview } from "./board";
import { useMediaQuery } from "@/components/ui/hooks/use-media-query";
import { usePortalScopeProps } from "@/lib/portal-scope";
import { cn } from "@/lib/utils";

export function chipClass(tag: Tag): string {
  if (tag === "review") {
    return "bg-gradient-to-r from-orange-500/20 to-amber-400/30 text-amber-800 dark:text-amber-200";
  }
  if (tag === "snoozed" || tag === "pinned") return "bg-muted text-muted-foreground";
  return "bg-orange-500/10 text-orange-600 dark:text-orange-400";
}

export function Chip({ tag }: { tag: Tag }) {
  if (!tag) return null;
  return (
    <span className={cn("shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium leading-none", chipClass(tag))}>
      {tag}
    </span>
  );
}

type CacheEntry = {
  controller: AbortController;
  promise: Promise<ThreadPreview>;
  users: number;
};

const previewCache = new Map<string, CacheEntry>();

function previewKey(threadId: string, pending: boolean, indicator: string) {
  return `${threadId}\0${pending ? "1" : "0"}\0${indicator}`;
}

function retainPreview(key: string, load: (signal: AbortSignal) => Promise<ThreadPreview>) {
  let entry = previewCache.get(key);
  if (!entry) {
    const controller = new AbortController();
    entry = { controller, promise: load(controller.signal), users: 0 };
    previewCache.set(key, entry);
  }
  const current = entry;
  current.users += 1;
  return {
    promise: current.promise,
    release() {
      current.users -= 1;
      if (current.users <= 0) {
        current.controller.abort();
        if (previewCache.get(key) === current) previewCache.delete(key);
      }
    },
  };
}

function clearPreviewCache(threadId: string) {
  for (const [key, entry] of previewCache) {
    if (key === threadId || key.startsWith(`${threadId}\0`)) {
      previewCache.delete(key);
      if (entry.users <= 0) entry.controller.abort();
    }
  }
}

function isAbort(err: unknown): boolean {
  return typeof err === "object" && err !== null && "name" in err && err.name === "AbortError";
}

function Check({ completed }: { completed: boolean }) {
  return (
    <svg
      viewBox="0 0 16 16"
      className={cn("mt-0.5 size-3.5 shrink-0", completed ? "text-emerald-500" : "text-muted-foreground/50")}
      aria-hidden="true"
    >
      <path fill="currentColor" d="M6.3 11.3 3.1 8.1l1.1-1.1 2.1 2.1 4.6-4.6 1.1 1.1z" />
    </svg>
  );
}

function AgentBlock({ agent }: { agent: PreviewAgent }) {
  return (
    <div className="space-y-1">
      <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">agent</div>
      <div className="flex items-start gap-1.5 text-xs text-foreground">
        <Check completed={agent.completed} />
        <span className="min-w-0 flex-1 truncate">{agent.text}</span>
      </div>
    </div>
  );
}

function YouBlock({
  you,
  resolving,
  error,
  onApprove,
}: {
  you: PreviewYou;
  resolving: boolean;
  error: string | null;
  onApprove: () => void;
}) {
  return (
    <div className="space-y-1">
      <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">you</div>
      <div className="flex items-center gap-1.5 text-xs text-foreground">
        <span className="size-1.5 shrink-0 rounded-full bg-amber-600" />
        <span className="min-w-0 flex-1 truncate">{you.text}</span>
        {you.approve && (
          <button
            type="button"
            disabled={resolving}
            onClick={onApprove}
            className="shrink-0 cursor-pointer rounded-full border border-border px-2 py-0.5 text-[11px] leading-none text-foreground hover:bg-state-hover disabled:cursor-default disabled:opacity-50"
          >
            Approve
          </button>
        )}
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}

export function ThreadPreviewCard({ thread, tag }: { thread: BoardThread; tag: Tag }) {
  const sdk = useSdk();
  const sdkRef = useRef(sdk);
  sdkRef.current = sdk;
  const [preview, setPreview] = useState<ThreadPreview | null>(null);
  const [error, setError] = useState(false);
  const [youHidden, setYouHidden] = useState(false);
  const [resolving, setResolving] = useState(false);
  const [approveError, setApproveError] = useState<string | null>(null);

  useEffect(() => {
    setYouHidden(false);
    setApproveError(null);
  }, [thread.id]);

  useEffect(() => {
    let live = true;
    const waiting = thread.hasPendingInteraction || thread.indicator === "waiting-for-input";
    const key = previewKey(thread.id, thread.hasPendingInteraction, thread.indicator);
    const { promise, release } = retainPreview(key, async (signal) => {
      const timeline = await sdkRef.current.threads.timeline({
        threadId: thread.id,
        segmentLimit: "2",
        deferContent: "true",
        includeNestedRows: "true",
        signal,
      });
      const interactions = thread.hasPendingInteraction
        ? await sdkRef.current.threads.interactions.list({ threadId: thread.id, signal })
        : undefined;
      return threadPreview(timeline.rows, { waiting, interactions });
    });
    promise.then(
      (next) => {
        if (!live) return;
        setPreview(next);
        setError(false);
      },
      (err: unknown) => {
        if (!live || isAbort(err)) return;
        setError(true);
      },
    );
    return () => {
      live = false;
      release();
    };
  }, [thread.id, thread.hasPendingInteraction, thread.indicator]);

  const you = youHidden ? null : (preview?.you ?? null);
  const approve = async () => {
    if (!you?.approve || resolving) return;
    const target = you.approve;
    setResolving(true);
    setApproveError(null);
    try {
      await sdkRef.current.threads.interactions.resolve({
        threadId: thread.id,
        interactionId: target.interactionId,
        resolution: { decision: "allow_once", grantedPermissions: target.grantedPermissions },
      });
      clearPreviewCache(thread.id);
      setYouHidden(true);
    } catch (err: unknown) {
      if (!isAbort(err)) setApproveError("Couldn't approve");
    } finally {
      setResolving(false);
    }
  };

  return (
    <div className="space-y-2">
      <div className="flex items-start gap-2">
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{thread.displayTitle}</span>
        <Chip tag={tag} />
      </div>
      {error ? (
        <p className="text-xs text-muted-foreground">Couldn't load preview</p>
      ) : preview === null ? (
        <p className="text-xs text-muted-foreground">Loading…</p>
      ) : !preview.agent && !you ? (
        <p className="text-xs text-muted-foreground">No summary yet</p>
      ) : (
        <div className="space-y-2">
          {preview.agent && <AgentBlock agent={preview.agent} />}
          {you && <YouBlock you={you} resolving={resolving} error={approveError} onApprove={() => void approve()} />}
        </div>
      )}
    </div>
  );
}

function useNow() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}

function pathnameOf(href: string): string | null {
  const origin = typeof window === "undefined" ? "http://localhost" : window.location.origin;
  try {
    const path = new URL(href, origin).pathname;
    return path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
  } catch {
    return null;
  }
}

/** Board cards use `/threads/<id>`. Sidebar rows in another project use `/projects/<project>/threads/<id>`. */
function threadIdOf(pathname: string): string | null {
  return /\/threads\/(thr_[a-z0-9]+)$/i.exec(pathname)?.[1] ?? null;
}

function entryFor(map: Map<string, PreviewEntry>, pathname: string): PreviewEntry | null {
  const direct = map.get(pathname);
  if (direct) return direct;
  const id = threadIdOf(pathname);
  if (!id) return null;
  for (const [path, entry] of map) {
    if (entry.thread.id === id || threadIdOf(path) === id) return entry;
  }
  return null;
}

type PreviewEntry = { thread: BoardThread; tag: Tag };
type OpenPreview = { anchor: HTMLAnchorElement; pathname: string };

function placePreview(anchor: DOMRect, width: number, height: number, viewportWidth: number, viewportHeight: number) {
  const margin = 8;
  const gap = 8;
  const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), Math.max(min, max));
  const maxLeft = viewportWidth - margin - width;
  const maxTop = viewportHeight - margin - height;
  const right = anchor.right + gap;
  if (anchor.width < viewportWidth * 0.6 && right + width <= viewportWidth - margin) {
    return { left: right, top: clamp(anchor.top, margin, maxTop) };
  }
  const spaceAbove = anchor.top - margin;
  const spaceBelow = viewportHeight - margin - anchor.bottom;
  const top = spaceAbove >= height + gap || spaceAbove >= spaceBelow ? anchor.top - gap - height : anchor.bottom + gap;
  return { left: clamp(anchor.left, margin, maxLeft), top: clamp(top, margin, maxTop) };
}

/** App-wide hover card for sidebar rows and board cards. Message text is not a thread link, so it stays put. */
export function ThreadPreviewOverlay() {
  const canHover = useMediaQuery("(hover: hover)");
  const { threads } = experimental_useSidebarThreads();
  const { values } = useSettings();
  const now = useNow();
  const doneDays = typeof values?.doneDays === "number" && values.doneDays > 0 ? values.doneDays : 3;
  const byHref = useMemo(() => {
    const live = threads as unknown as BoardThread[];
    const columns = board(live, now, doneDays);
    const chips = new Map<string, Tag>();
    for (const column of COLUMNS) {
      for (const group of columns[column.id]) {
        for (const card of group.cards) {
          if (card.tag) chips.set(card.thread.id, card.tag);
        }
      }
    }
    const map = new Map<string, PreviewEntry>();
    for (const thread of live) {
      if (thread.isArchived) continue;
      const path = pathnameOf(thread.href);
      if (path) map.set(path, { thread, tag: chips.get(thread.id) ?? null });
    }
    return map;
  }, [threads, now, doneDays]);
  const mapRef = useRef(byHref);
  mapRef.current = byHref;
  const [open, setOpen] = useState<OpenPreview | null>(null);
  const openRef = useRef<OpenPreview | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number; key: string } | null>(null);
  const portalProps = usePortalScopeProps();

  useEffect(() => {
    if (!canHover) return;
    let openTimer = 0;
    let closeTimer = 0;
    let pendingAnchor: HTMLAnchorElement | null = null;
    const clearOpenTimer = () => {
      window.clearTimeout(openTimer);
      openTimer = 0;
    };
    const clearCloseTimer = () => {
      window.clearTimeout(closeTimer);
      closeTimer = 0;
    };
    const elementOf = (target: EventTarget | null) => {
      if (target instanceof Element) return target;
      if (target instanceof Node) return target.parentElement;
      return null;
    };
    const inCard = (target: EventTarget | null) => Boolean(elementOf(target)?.closest("[data-thread-preview-card]"));
    const anchorOf = (target: EventTarget | null) => {
      const anchor = elementOf(target)?.closest("a[href]");
      return anchor instanceof HTMLAnchorElement ? anchor : null;
    };
    const lookup = (anchor: HTMLAnchorElement) => {
      const path = pathnameOf(anchor.href);
      if (!path || !entryFor(mapRef.current, path)) return null;
      return path;
    };
    const closeNow = () => {
      clearOpenTimer();
      clearCloseTimer();
      pendingAnchor = null;
      openRef.current = null;
      setOpen(null);
    };
    const scheduleClose = () => {
      clearOpenTimer();
      pendingAnchor = null;
      if (closeTimer) return;
      closeTimer = window.setTimeout(() => {
        closeTimer = 0;
        openRef.current = null;
        setOpen(null);
      }, 180);
    };
    const scheduleOpen = (anchor: HTMLAnchorElement, pathname: string) => {
      clearCloseTimer();
      if (openRef.current?.anchor === anchor || pendingAnchor === anchor) return;
      clearOpenTimer();
      pendingAnchor = anchor;
      openTimer = window.setTimeout(() => {
        openTimer = 0;
        pendingAnchor = null;
        const next = { anchor, pathname };
        openRef.current = next;
        setOpen(next);
      }, 400);
    };
    const onOver = (event: PointerEvent) => {
      if (inCard(event.target)) {
        clearCloseTimer();
        return;
      }
      const anchor = anchorOf(event.target);
      if (!anchor) return;
      const pathname = lookup(anchor);
      if (!pathname) return;
      scheduleOpen(anchor, pathname);
    };
    const onOut = (event: PointerEvent) => {
      if (inCard(event.relatedTarget)) {
        clearCloseTimer();
        return;
      }
      const next = anchorOf(event.relatedTarget);
      if (next && lookup(next)) {
        clearCloseTimer();
        return;
      }
      const leftCard = inCard(event.target);
      const leftAnchor = anchorOf(event.target);
      if (leftCard || (leftAnchor && (leftAnchor === openRef.current?.anchor || leftAnchor === pendingAnchor))) scheduleClose();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeNow();
    };
    const onScroll = () => {
      if (openRef.current || pendingAnchor) closeNow();
    };
    const onClick = (event: MouseEvent) => {
      const anchor = anchorOf(event.target);
      if (anchor && lookup(anchor)) closeNow();
    };
    document.addEventListener("pointerover", onOver);
    document.addEventListener("pointerout", onOut);
    document.addEventListener("keydown", onKey);
    document.addEventListener("scroll", onScroll, true);
    document.addEventListener("click", onClick);
    return () => {
      clearOpenTimer();
      clearCloseTimer();
      document.removeEventListener("pointerover", onOver);
      document.removeEventListener("pointerout", onOut);
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("scroll", onScroll, true);
      document.removeEventListener("click", onClick);
    };
  }, [canHover]);

  const entry = open ? entryFor(byHref, open.pathname) : null;
  useLayoutEffect(() => {
    const anchor = open?.anchor;
    const node = cardRef.current;
    if (!open || !entry || !anchor || !node) return;
    const key = open.pathname;
    const apply = () => {
      const rect = anchor.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) return;
      const box = node.getBoundingClientRect();
      const next = placePreview(rect, box.width, box.height, window.innerWidth, window.innerHeight);
      setPos((prev) => (prev && prev.key === key && prev.left === next.left && prev.top === next.top ? prev : { ...next, key }));
    };
    apply();
    const observer = new ResizeObserver(apply);
    observer.observe(node);
    window.addEventListener("resize", apply);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", apply);
    };
  }, [open, entry]);

  if (!canHover || !open || !entry || typeof document === "undefined") return null;
  const placed = pos?.key === open.pathname ? pos : null;
  return createPortal(
    <div
      {...portalProps}
      ref={cardRef}
      data-thread-preview-card=""
      className="fixed z-50 w-80 rounded-lg border border-border bg-popover p-3 text-popover-foreground shadow-md outline-none"
      style={{
        top: placed?.top ?? 0,
        left: placed?.left ?? 0,
        visibility: placed ? "visible" : "hidden",
      }}
    >
      <ThreadPreviewCard key={entry.thread.id} thread={entry.thread} tag={entry.tag} />
    </div>,
    document.body,
  );
}
