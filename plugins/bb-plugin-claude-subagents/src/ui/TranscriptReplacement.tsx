import { useLayoutEffect, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";

const threadWindowSelector = "[data-thread-window]";
const viewportSelector = "[data-page-scroll-viewport]";
const footerSelector = "[data-scroll-footer]";
const threadMark = "data-bb-claude-subagents-thread";

export function useThreadWindowMark(anchorRef: RefObject<HTMLElement | null>, threadId: string) {
  useLayoutEffect(() => {
    const windowEl = anchorRef.current?.closest(threadWindowSelector);
    if (!(windowEl instanceof HTMLElement)) return;
    const previous = windowEl.getAttribute(threadMark);
    windowEl.setAttribute(threadMark, threadId);
    return () => {
      if (windowEl.getAttribute(threadMark) !== threadId) return;
      if (previous === null) windowEl.removeAttribute(threadMark);
      else windowEl.setAttribute(threadMark, previous);
    };
  }, [anchorRef, threadId]);
}

export function TranscriptReplacement({
  anchorRef,
  threadId,
  active,
  children,
}: {
  anchorRef: RefObject<HTMLElement | null>;
  threadId: string;
  active: boolean;
  children: ReactNode;
}) {
  const [host, setHost] = useState<HTMLElement | null>(null);

  useLayoutEffect(() => {
    if (!active) return;
    const grid = findTranscriptGrid(anchorRef.current, threadId);
    if (!grid) return;
    const layer = document.createElement("div");
    layer.dataset.claudeSubagentsChat = threadId;
    layer.style.position = "absolute";
    layer.style.zIndex = "25";
    layer.style.display = "flex";
    layer.style.flexDirection = "column";
    layer.style.minWidth = "0";
    layer.style.minHeight = "0";
    layer.style.overflow = "hidden";
    layer.style.background = "var(--background)";
    layer.style.pointerEvents = "auto";
    const previousPosition = grid.style.position;
    if (getComputedStyle(grid).position === "static") grid.style.position = "relative";
    const place = () => {
      const windowEl = grid.closest(threadWindowSelector);
      const footer = windowEl?.querySelector(footerSelector);
      const gridRect = grid.getBoundingClientRect();
      let bottom = 0;
      if (footer instanceof HTMLElement && gridRect.height > 0) {
        bottom = Math.max(0, gridRect.bottom - footer.getBoundingClientRect().top);
      }
      layer.style.top = "0px";
      layer.style.right = "0px";
      layer.style.left = "0px";
      layer.style.bottom = `${bottom}px`;
    };
    place();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(place);
    observer?.observe(grid);
    const footer = grid.closest(threadWindowSelector)?.querySelector(footerSelector);
    if (footer instanceof HTMLElement) observer?.observe(footer);
    grid.appendChild(layer);
    setHost(layer);
    return () => {
      observer?.disconnect();
      layer.remove();
      grid.style.position = previousPosition;
      setHost(null);
    };
  }, [active, anchorRef, threadId]);

  if (!host) return null;
  return createPortal(children, host);
}

function escapeAttribute(value: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") return CSS.escape(value);
  return value.replace(/["\\]/g, "\\$&");
}

function findTranscriptGrid(anchor: HTMLElement | null, threadId: string): HTMLElement | null {
  const candidates: HTMLElement[] = [];
  const direct = anchor?.closest(threadWindowSelector);
  if (direct instanceof HTMLElement) candidates.push(direct);
  const marked = document.querySelector(`${threadWindowSelector}[${threadMark}="${escapeAttribute(threadId)}"]`);
  if (marked instanceof HTMLElement) candidates.push(marked);
  const focused = document.querySelector(`[data-split-pane-id][data-focused="true"] ${threadWindowSelector}`);
  if (focused instanceof HTMLElement) candidates.push(focused);
  for (const windowEl of candidates) {
    const mark = windowEl.getAttribute(threadMark);
    if (mark && mark !== threadId) continue;
    const viewport = windowEl.querySelector(viewportSelector);
    const grid = viewport?.parentElement;
    if (viewport instanceof HTMLElement && grid instanceof HTMLElement) return grid;
  }
  return null;
}
