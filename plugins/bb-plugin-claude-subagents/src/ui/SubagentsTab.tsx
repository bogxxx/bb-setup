import { useEffect, useState } from "react";
import { experimental_useTabVisible } from "@get-bb/plugin-sdk/app";
import { AgentDetail } from "./AgentDetail";
import { AgentList } from "./AgentList";
import { reloadSubagentList, useSharedSubagentList, useSubagentDetail } from "./useSubagents";

export function SubagentsTab({ threadId }: { threadId: string }) {
  const visible = experimental_useTabVisible();
  const [familyId, setFamilyId] = useState<string | null>(null);
  const listState = useSharedSubagentList(threadId, true);
  const detailState = useSubagentDetail(threadId, familyId, visible);

  useEffect(() => {
    setFamilyId(null);
  }, [threadId]);

  if (listState.error) {
    return (
      <div className="px-3 py-6">
        <p className="text-sm text-destructive">{listState.error}</p>
        <button type="button" className="mt-2 text-xs text-foreground underline-offset-2 hover:underline" onClick={() => reloadSubagentList(threadId)}>
          Retry
        </button>
      </div>
    );
  }
  if (!listState.list) return <p className="px-3 py-6 text-sm text-muted-foreground">Loading subagents…</p>;
  if (listState.list.state !== "ok") return <p className="px-3 py-6 text-sm text-muted-foreground">{listState.list.notice}</p>;

  if (familyId) {
    if (detailState.detailError) {
      return (
        <div className="px-3 py-6">
          <button type="button" className="text-xs text-foreground underline-offset-2 hover:underline" onClick={() => setFamilyId(null)}>
            Back
          </button>
          <p className="mt-2 text-sm text-destructive">{detailState.detailError}</p>
          <button type="button" className="mt-2 text-xs text-foreground underline-offset-2 hover:underline" onClick={detailState.retry}>
            Retry
          </button>
        </div>
      );
    }
    if (!detailState.detail) return <p className="px-3 py-6 text-sm text-muted-foreground">Loading subagent…</p>;
    return (
      <AgentDetail
        detail={detailState.detail}
        items={detailState.items}
        filter={detailState.filter}
        onFilter={detailState.setFilter}
        onBack={() => setFamilyId(null)}
        onEarlier={detailState.earlier}
      />
    );
  }

  return (
    <AgentList
      agents={listState.list.agents}
      counts={listState.list.counts}
      truncated={listState.list.truncated}
      now={listState.loadedAt}
      onOpen={setFamilyId}
      onRefresh={() => reloadSubagentList(threadId)}
    />
  );
}
