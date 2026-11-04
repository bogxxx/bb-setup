import { useEffect, useRef, useState, type RefObject } from "react";
import { experimental_useThreadContextKind } from "@get-bb/plugin-sdk/app";
import type { ExperimentalThreadContextCardProps, ExperimentalThreadContextSegmentProps } from "@get-bb/plugin-sdk/app";
import type { ListSubagentsResult } from "../contract";
import { AgentDetail } from "./AgentDetail";
import { SubagentGroups, subagentCountSummary } from "./SubagentGroups";
import { useSelectedFamily } from "./selection";
import { TranscriptReplacement, useThreadWindowMark } from "./TranscriptReplacement";
import { useSharedSubagentList, useSubagentDetail } from "./useSubagents";

function readyList(list: ListSubagentsResult | null): ListSubagentsResult | null {
  if (!list || list.state !== "ok" || list.agents.length === 0) return null;
  return list;
}

export function SubagentsCardSection({ threadId }: ExperimentalThreadContextCardProps) {
  const kind = experimental_useThreadContextKind();
  const snapshot = useSharedSubagentList(threadId, kind === "card");
  if (kind !== "card") return null;
  const list = readyList(snapshot.list);
  if (!list) return null;
  return <InChatRoster threadId={threadId} list={list} portal />;
}

export function useSubagentsBannerVisible({ threadId }: { threadId: string }): boolean {
  const kind = experimental_useThreadContextKind();
  const snapshot = useSharedSubagentList(threadId, true);
  const inlineCard = useInlineCardShowing(threadId);
  if (readyList(snapshot.list) === null) return false;
  if (kind === "banner") return true;
  return !inlineCard;
}

function useInlineCardShowing(threadId: string): boolean {
  const [showing, setShowing] = useState(false);
  useEffect(() => {
    const read = () => setShowing(inlineCardShowing(threadId));
    read();
    if (typeof MutationObserver === "undefined") return;
    const observer = new MutationObserver(read);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [threadId]);
  return showing;
}

function inlineCardShowing(threadId: string): boolean {
  const windows = Array.from(document.querySelectorAll("[data-thread-window]")).filter((node): node is HTMLElement => node instanceof HTMLElement);
  if (windows.length === 0) return false;
  const marked = windows.find((node) => node.getAttribute("data-bb-claude-subagents-thread") === threadId);
  const windowEl = marked ?? (windows.length === 1 ? windows[0] : null);
  if (!windowEl) return windows.every((node) => node.querySelector("[data-thread-context-card]"));
  return windowEl.querySelector("[data-thread-context-card]") !== null;
}

export function SubagentsBannerSummary({ threadId, isExpanded, onToggle }: ExperimentalThreadContextSegmentProps) {
  const snapshot = useSharedSubagentList(threadId, true);
  const list = readyList(snapshot.list);
  const anchorRef = useRef<HTMLSpanElement>(null);
  useThreadWindowMark(anchorRef, threadId);
  const [familyId, setFamilyId] = useSelectedFamily(threadId);
  if (!list) return <span ref={anchorRef} />;
  return (
    <span ref={anchorRef} className="contents">
      <button type="button" className="px-1 text-xs text-muted-foreground" aria-expanded={isExpanded} onClick={onToggle}>
        {subagentCountSummary(list.counts)}
      </button>
      <SubagentChatPortal anchorRef={anchorRef} threadId={threadId} familyId={familyId} onBack={() => setFamilyId(null)} />
    </span>
  );
}

export function SubagentsBannerDetails({ threadId, isExpanded }: ExperimentalThreadContextSegmentProps) {
  const snapshot = useSharedSubagentList(threadId, true);
  const list = readyList(snapshot.list);
  const [familyId, setFamilyId] = useSelectedFamily(threadId);
  if (!isExpanded || !list) return null;
  return (
    <div className="max-h-72 overflow-auto">
      {list.truncated ? <p className="px-2 text-[11px] text-muted-foreground">The list is capped.</p> : null}
      <SubagentGroups agents={list.agents} counts={list.counts} selectedId={familyId} onOpen={setFamilyId} />
    </div>
  );
}

function InChatRoster({ threadId, list, portal }: { threadId: string; list: ListSubagentsResult; portal: boolean }) {
  const anchorRef = useRef<HTMLDivElement>(null);
  useThreadWindowMark(anchorRef, threadId);
  const [familyId, setFamilyId] = useSelectedFamily(threadId);
  return (
    <div ref={anchorRef}>
      {list.truncated ? <p className="px-2 text-[11px] text-muted-foreground">The list is capped.</p> : null}
      <SubagentGroups agents={list.agents} counts={list.counts} selectedId={familyId} onOpen={setFamilyId} />
      {portal ? <SubagentChatPortal anchorRef={anchorRef} threadId={threadId} familyId={familyId} onBack={() => setFamilyId(null)} /> : null}
    </div>
  );
}

function SubagentChatPortal({
  anchorRef,
  threadId,
  familyId,
  onBack,
}: {
  anchorRef: RefObject<HTMLElement | null>;
  threadId: string;
  familyId: string | null;
  onBack: () => void;
}) {
  const detailState = useSubagentDetail(threadId, familyId, true);
  return (
    <TranscriptReplacement anchorRef={anchorRef} threadId={threadId} active={familyId !== null}>
      <div className="flex h-full min-h-0 flex-col bg-background" role="region" aria-label="Subagent chat">
        {detailState.detailError ? (
          <div className="px-3 py-6">
            <button type="button" className="text-xs text-foreground underline-offset-2 hover:underline" onClick={onBack}>
              Back
            </button>
            <p className="mt-2 text-sm text-destructive">{detailState.detailError}</p>
            <button type="button" className="mt-2 text-xs text-foreground underline-offset-2 hover:underline" onClick={detailState.retry}>
              Retry
            </button>
          </div>
        ) : !detailState.detail ? (
          <div className="px-3 py-6">
            <button type="button" className="text-xs text-foreground underline-offset-2 hover:underline" onClick={onBack}>
              Back
            </button>
            <p className="mt-2 text-sm text-muted-foreground">Loading subagent…</p>
          </div>
        ) : (
          <AgentDetail
            detail={detailState.detail}
            items={detailState.items}
            filter={detailState.filter}
            onFilter={detailState.setFilter}
            onBack={onBack}
            onEarlier={detailState.earlier}
          />
        )}
      </div>
    </TranscriptReplacement>
  );
}
