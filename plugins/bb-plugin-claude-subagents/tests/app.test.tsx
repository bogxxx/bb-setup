// @vitest-environment jsdom
import { fireEvent, screen } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentRow, DisplayStatus, ListSubagentsResult, SubagentDetailResult } from "../src/contract";
import { SubagentsCardSection } from "../src/ui/InChatSubagents";
import { resetSelectedFamilies } from "../src/ui/selection";
import { SubagentsTab } from "../src/ui/SubagentsTab";

function row(description: string, familyId: string, status: DisplayStatus = "finished"): AgentRow {
  return {
    familyId,
    sessionId: "11111111-1111-4111-8111-111111111111",
    description,
    taskType: "local_agent",
    status,
    bbStatus: "completed",
    taskStatus: "completed",
    agentType: "worker",
    model: { requested: "haiku", resolved: "claude-haiku-5-5" },
    usage: { totalTokens: 10, toolUses: 1, durationMs: 1000 },
    runCount: 2,
    startedAt: 1,
    updatedAt: 2,
    error: null,
    stale: false,
  };
}

function list(agents: AgentRow[]): ListSubagentsResult {
  return {
    state: "ok",
    notice: null,
    agents,
    truncated: false,
    counts: {
      in_progress: 0,
      finished: agents.length,
      failed: 0,
      interrupted: 0,
    },
    lastSeq: 1,
  };
}

const detail: SubagentDetailResult = {
  agent: row("First agent", "first-agent"),
  models: {
    requestedAlias: "haiku",
    requested: ["claude-haiku-5-5"],
    resolved: [{ model: "claude-haiku-5-5", calls: 1 }],
    effort: "medium",
    advisor: null,
  },
  usage: { apiCalls: 1, input: 1, output: 2, cacheCreate: 3, cacheRead: 4, thinking: 5 },
  thinking: {
    state: "summarized",
    blocks: 1,
    redactedBlocks: 0,
    emptyBlocks: 0,
    note: "Thinking is summarized (1 block).",
  },
  transcript: {
    source: "jsonl",
    path: null,
    sizeBytes: 1,
    modifiedAtMs: 1,
    lagging: false,
    malformedLines: 0,
    notice: null,
  },
  items: [{ kind: "assistant", index: 0, ts: 1, text: "hello from the agent", truncated: false, model: "claude-haiku-5-5" }],
  page: { total: 1, start: 0, hasEarlier: false, before: null },
  finalSummary: null,
};

describe("Subagents tab", () => {
  it("shows the empty state", async () => {
    await loadPluginApp(() => import("../app"));
    const slot = renderSlot({ component: SubagentsTab }, { threadId: "thr_empty" }, {
      rpc: { listSubagents: () => list([]) },
    });
    expect(await slot.findByText("No Claude subagents on this thread yet.")).toBeTruthy();
    slot.unmount();
  });

  it("renders a row and opens the detail thinking note", async () => {
    await loadPluginApp(() => import("../app"));
    const slot = renderSlot(
      { component: SubagentsTab },
      { threadId: "thr_rows" },
      {
        rpc: {
          listSubagents: () => list([row("First agent", "first-agent"), row("Second agent", "second-agent")]),
          subagentDetail: () => detail,
        },
      },
    );
    expect(await slot.findByText("First agent")).toBeTruthy();
    expect(slot.getByText("Second agent")).toBeTruthy();
    expect(slot.getAllByText(/2 runs/).length).toBeGreaterThan(0);
    fireEvent.click(slot.getByRole("button", { name: /First agent/ }));
    expect(await slot.findByText("Thinking is summarized (1 block).")).toBeTruthy();
    slot.unmount();
  });
});

function rect(top: number, bottom: number): DOMRect {
  return {
    x: 0,
    y: top,
    top,
    left: 0,
    right: 800,
    bottom,
    width: 800,
    height: bottom - top,
    toJSON() {
      return {};
    },
  };
}

function mountTranscriptFrame() {
  const pane = document.createElement("div");
  pane.dataset.splitPaneId = "pane-a";
  pane.dataset.focused = "true";
  pane.innerHTML = `<div data-thread-window><div id="transcript-grid"><div data-page-scroll-viewport><div data-scroll-footer></div></div><div data-scroll-overlay></div></div></div>`;
  document.body.appendChild(pane);
  const grid = pane.querySelector("#transcript-grid");
  const footer = pane.querySelector("[data-scroll-footer]");
  if (!(grid instanceof HTMLElement) || !(footer instanceof HTMLElement)) throw new Error("missing transcript frame");
  grid.getBoundingClientRect = () => rect(0, 600);
  footer.getBoundingClientRect = () => rect(540, 600);
  return pane;
}

describe("In-chat subagents", () => {
  afterEach(() => {
    resetSelectedFamilies();
    document.body.replaceChildren();
  });

  it("lists working agents above finished agents and returns from a chat with Back", async () => {
    const frame = mountTranscriptFrame();
    const working = row("Working agent", "working-agent", "in_progress");
    const finished = row("Finished agent", "finished-agent", "finished");
    const listed = list([working, finished]);
    listed.counts = { in_progress: 1, finished: 1, failed: 0, interrupted: 0 };
    await loadPluginApp(() => import("../app"));
    const slot = renderSlot({ component: SubagentsCardSection }, { threadId: "thr_card", projectId: "prj_card", environment: null }, {
      threadContextKind: "card",
      rpc: {
        listSubagents: () => listed,
        subagentDetail: () => ({ ...detail, agent: working }),
      },
    });

    const workingHeading = await screen.findByRole("heading", { name: "Still working" });
    const finishedHeading = screen.getByRole("heading", { name: "Finished" });
    expect(workingHeading.compareDocumentPosition(finishedHeading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Failed" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Interrupted" })).toBeNull();
    const workingButton = screen.getByRole("button", { name: /Working agent/ });
    const finishedButton = screen.getByRole("button", { name: /Finished agent/ });
    expect(workingButton.className).toContain("bg-primary/10");
    expect(finishedButton.className).not.toContain("bg-primary/10");
    expect(workingButton.compareDocumentPosition(finishedButton) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    fireEvent.click(workingButton);
    expect(await screen.findByText("Thinking is summarized (1 block).")).toBeTruthy();
    const chat = document.querySelector("[data-claude-subagents-chat]");
    expect(chat).toBeTruthy();
    expect(frame.querySelector("[data-thread-window]")?.contains(chat ?? null)).toBe(true);
    expect(chat?.closest("[data-scroll-footer]")).toBeNull();
    expect(chat?.parentElement).toBe(frame.querySelector("#transcript-grid"));
    expect((chat as HTMLElement).style.bottom).toBe("60px");

    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.queryByText("Thinking is summarized (1 block).")).toBeNull();
    expect(screen.getByRole("heading", { name: "Still working" })).toBeTruthy();
    expect(document.querySelector("[data-claude-subagents-chat]")).toBeNull();
    slot.unmount();

    const other = renderSlot({ component: SubagentsCardSection }, { threadId: "thr_other", projectId: "prj_card", environment: null }, {
      threadContextKind: "card",
      rpc: {
        listSubagents: () => list([row("Other agent", "other-agent")]),
        subagentDetail: () => detail,
      },
    });
    expect(await screen.findByRole("heading", { name: "Finished" })).toBeTruthy();
    expect(screen.queryByText("Thinking is summarized (1 block).")).toBeNull();
    other.unmount();
  });

  it("renders nothing for a thread that is not Claude Code", async () => {
    await loadPluginApp(() => import("../app"));
    const slot = renderSlot({ component: SubagentsCardSection }, { threadId: "thr_2rrby5gzn6", projectId: "prj_orch", environment: null }, {
      threadContextKind: "card",
      rpc: {
        listSubagents: () => ({ ...list([]), state: "not_claude", notice: "This thread is not a Claude Code thread." }),
      },
    });
    expect(screen.queryByRole("heading", { name: "Subagents" })).toBeNull();
    expect(screen.queryByText("Still working")).toBeNull();
    slot.unmount();
  });
});
