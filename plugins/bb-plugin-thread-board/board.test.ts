import { describe, expect, it } from "vitest";
import { ago, board, threadPreview, type BoardThread } from "./board";

const NOW = 1_800_000_000_000;
const MIN = 60_000;
const DAY = 86_400_000;
let n = 0;
function t(change: Partial<BoardThread> = {}): BoardThread {
  n++;
  return {
    id: `thr_${n}`,
    projectId: "p1",
    parentThreadId: null,
    displayTitle: `Thread ${n}`,
    originPluginId: null,
    providerId: "claude-code",
    status: "idle",
    queuedWork: "none",
    hasPendingInteraction: false,
    indicator: "none",
    isUnread: false,
    isHidden: false,
    isArchived: false,
    isPinned: false,
    activity: { workflows: 0, backgroundAgents: 0, backgroundCommands: 0, planMode: 0 },
    updatedAt: NOW - 10 * MIN,
    href: `/threads/thr_${n}`,
    ...change,
  };
}
const ids = (groups: { cards: { thread: BoardThread }[] }[]) =>
  groups.flatMap((g) => g.cards.map((c) => c.thread.displayTitle));

describe("board", () => {
  it("puts threads that need you, run, or finished lately in their columns", () => {
    const threads = [
      t({ displayTitle: "asks", hasPendingInteraction: true }),
      t({ displayTitle: "unread", isUnread: true, indicator: "unread-success" }),
      t({ displayTitle: "failed", isUnread: true, indicator: "unread-error" }),
      t({ displayTitle: "busy", status: "active" }),
      t({ displayTitle: "done" }),
      t({ displayTitle: "old", updatedAt: NOW - 5 * DAY }),
      t({ displayTitle: "snoozed", isHidden: true }),
      t({ displayTitle: "archived", isArchived: true }),
    ];
    const b = board(threads, NOW);
    expect(ids(b.needs).sort()).toEqual(["asks", "failed", "unread"]);
    expect(b.needs.flatMap((g) => g.cards.map((c) => c.tag)).sort()).toEqual(["failed", "question", "unread"]);
    expect(ids(b.running)).toEqual(["busy"]);
    const snoozed = b.done.flatMap((g) => g.cards).find((c) => c.thread.displayTitle === "snoozed");
    expect(snoozed?.tag).toBe("snoozed");
    expect(ids(b.done)).toEqual(["done", "snoozed"]);
    expect([...ids(b.needs), ...ids(b.running), ...ids(b.done)]).not.toContain("archived");
  });

  it("runs a parent while a child runs, and shows a child that needs you on its own card", () => {
    const parent = t({ displayTitle: "orchestrator", updatedAt: NOW - 4 * DAY });
    const kid = t({ displayTitle: "worker", parentThreadId: parent.id, status: "active" });
    const asking = t({ displayTitle: "reviewer", parentThreadId: parent.id, hasPendingInteraction: true });
    const unreadKid = t({ displayTitle: "finished review", parentThreadId: parent.id, isUnread: true, indicator: "unread-success" });
    const failedKid = t({ displayTitle: "quota error", parentThreadId: parent.id, isUnread: true, indicator: "unread-error" });
    const b = board([parent, kid, asking, unreadKid, failedKid], NOW);
    expect(ids(b.running)).toEqual(["orchestrator"]);
    expect(b.running[0].cards[0].busyChildren).toBe(1);
    expect(ids(b.needs)).toEqual(["reviewer"]);
    expect(ids(b.done)).toEqual([]);
  });

  it("groups each column by project, the most recent card first", () => {
    const b = board(
      [
        t({ displayTitle: "a1", projectId: "a", updatedAt: NOW - 30 * MIN }),
        t({ displayTitle: "b1", projectId: "b", updatedAt: NOW - 5 * MIN }),
        t({ displayTitle: "a2", projectId: "a", updatedAt: NOW - MIN }),
      ],
      NOW,
    );
    expect(b.done.map((g) => [g.projectId, g.cards.map((c) => c.thread.displayTitle)])).toEqual([
      ["a", ["a2", "a1"]],
      ["b", ["b1"]],
    ]);
  });

  it("keeps done to the chosen days, and pinned threads always", () => {
    const b = board([t({ displayTitle: "pinned", isPinned: true, updatedAt: NOW - 30 * DAY }), t({ displayTitle: "week", updatedAt: NOW - 6 * DAY })], NOW, 7);
    expect(ids(b.done).sort()).toEqual(["pinned", "week"]);
  });

  it("drops a stale hidden unread and keeps an old hidden question", () => {
    const b = board(
      [
        t({ displayTitle: "stale unread", isHidden: true, isUnread: true, indicator: "unread-success", updatedAt: NOW - 5 * DAY }),
        t({ displayTitle: "old question", isHidden: true, hasPendingInteraction: true, updatedAt: NOW - 5 * DAY }),
      ],
      NOW,
    );
    expect([...ids(b.needs), ...ids(b.done), ...ids(b.running)]).not.toContain("stale unread");
    expect(ids(b.needs)).toEqual(["old question"]);
    expect(b.needs[0]?.cards[0]?.tag).toBe("question");
  });

  it("counts a hidden running child on its parent and gives an unread hidden child no card", () => {
    const parent = t({ displayTitle: "visible parent", updatedAt: NOW - 4 * DAY });
    const active = t({ displayTitle: "hidden worker", parentThreadId: parent.id, status: "active", isHidden: true });
    const unread = t({
      displayTitle: "hidden unread child",
      parentThreadId: parent.id,
      isHidden: true,
      isUnread: true,
      indicator: "unread-success",
    });
    const b = board([parent, active, unread], NOW);
    expect(ids(b.running)).toEqual(["visible parent"]);
    expect(b.running[0]?.cards[0]?.tag).toBe("agents");
    expect([...ids(b.needs), ...ids(b.done), ...ids(b.running)]).not.toContain("hidden worker");
    expect([...ids(b.needs), ...ids(b.done), ...ids(b.running)]).not.toContain("hidden unread child");
  });

  it("tags reviewer children as review and never a top-level thread titled review", () => {
    const withReview = t({ displayTitle: "with review", updatedAt: NOW - 4 * DAY });
    const reviewChild = t({ displayTitle: "review", parentThreadId: withReview.id, status: "active" });
    const withAgent = t({ displayTitle: "with agent", updatedAt: NOW - 4 * DAY });
    const worker = t({ displayTitle: "worker", parentThreadId: withAgent.id, status: "active" });
    const asked = t({ displayTitle: "asked parent", updatedAt: NOW - 4 * DAY });
    const asking = t({ displayTitle: "review", parentThreadId: asked.id, hasPendingInteraction: true });
    const titled = t({ displayTitle: "review", isUnread: true, indicator: "unread-success" });
    const titledIdle = t({ displayTitle: "review" });
    const titledBusy = t({ displayTitle: "review", status: "active", projectId: "other" });
    const b = board([withReview, reviewChild, withAgent, worker, asked, asking, titled, titledIdle, titledBusy], NOW);
    expect(b.running.flatMap((g) => g.cards).find((c) => c.thread.displayTitle === "with review")?.tag).toBe("review");
    expect(b.running.flatMap((g) => g.cards).find((c) => c.thread.displayTitle === "with agent")?.tag).toBe("agents");
    expect(b.needs.flatMap((g) => g.cards).find((c) => c.thread.id === asking.id)?.tag).toBe("review");
    expect(b.needs.flatMap((g) => g.cards).find((c) => c.thread.id === titled.id)?.tag).toBe("unread");
    expect(b.done.flatMap((g) => g.cards).find((c) => c.thread.id === titledIdle.id)?.tag).toBe(null);
    expect(b.running.flatMap((g) => g.cards).find((c) => c.thread.id === titledBusy.id)?.tag).toBe(null);
  });

  it("sorts firstProjectId ahead of a newer card in another project", () => {
    const b = board(
      [
        t({ displayTitle: "newer", projectId: "a", updatedAt: NOW - MIN }),
        t({ displayTitle: "older", projectId: "b", updatedAt: NOW - 30 * MIN }),
      ],
      NOW,
      3,
      "b",
    );
    expect(b.done.map((g) => g.projectId)).toEqual(["b", "a"]);
  });

  it("tags a pinned done card pinned and a plain done card with nothing", () => {
    const b = board([t({ displayTitle: "pinned", isPinned: true }), t({ displayTitle: "plain" })], NOW);
    const tags = new Map(b.done.flatMap((g) => g.cards.map((c) => [c.thread.displayTitle, c.tag])));
    expect(tags.get("pinned")).toBe("pinned");
    expect(tags.get("plain")).toBe(null);
  });
});

describe("threadPreview", () => {
  it("uses the latest assistant line and ignores work rows", () => {
    const rows = [
      {
        kind: "turn",
        status: "completed",
        children: [
          { kind: "conversation", role: "assistant", text: "# First draft" },
          { kind: "work", status: "completed", workKind: "tool", toolName: "bash", command: "cd /tmp && cat file" },
          { kind: "work", status: "completed", workKind: "command", toolName: "cat" },
          { kind: "conversation", role: "user", text: "go on" },
          { kind: "conversation", role: "assistant", text: "- Shipped\n\nthe change" },
        ],
      },
      {
        kind: "turn",
        status: "pending",
        children: [{ kind: "work", status: "pending", workKind: "tool", toolName: "bash" }],
      },
    ];
    expect(threadPreview(rows).agent).toEqual({ text: "Shipped the change", completed: true });
    expect(threadPreview([{ kind: "turn", status: "completed", children: [{ kind: "work", status: "completed", workKind: "tool", toolName: "bash" }] }]).agent).toBeNull();
  });

  it("marks the line completed when its turn completed or no pending turn follows", () => {
    expect(
      threadPreview([
        { kind: "conversation", role: "assistant", text: "Earlier" },
        { kind: "turn", status: "pending", children: [] },
      ]).agent,
    ).toEqual({ text: "Earlier", completed: false });
    expect(
      threadPreview([
        { kind: "turn", status: "pending", children: [{ kind: "conversation", role: "assistant", text: "Working" }] },
      ]).agent,
    ).toEqual({ text: "Working", completed: true });
  });

  it("leaves you empty when the thread is not waiting, even with old prompts", () => {
    const rows = [
      {
        kind: "turn",
        status: "completed",
        children: [
          { kind: "work", status: "completed", workKind: "approval", approvalKind: "file-edit" },
          { kind: "work", status: "completed", workKind: "question", questions: [{ prompt: "Old question" }] },
          { kind: "conversation", role: "assistant", text: "Done" },
        ],
      },
    ];
    expect(threadPreview(rows).you).toBeNull();
    expect(threadPreview(rows, { waiting: false }).you).toBeNull();
    expect(
      threadPreview(rows, {
        interactions: [{ id: "old", status: "resolved", payload: { kind: "approval", reason: "Old", availableDecisions: ["allow_once"], subject: { kind: "plan" } } }],
      }).you,
    ).toBeNull();
  });

  it("sets approve only for a pending approval that allows allow_once", () => {
    const permissions = { fileSystem: { read: ["/src"], write: ["/src"] }, network: { enabled: false } };
    const command = threadPreview([], {
      interactions: [
        { id: "old", status: "resolved", payload: { kind: "approval", reason: "Skip", availableDecisions: ["allow_once"], subject: { kind: "plan" } } },
        {
          id: "int_cmd",
          status: "pending",
          payload: {
            kind: "approval",
            reason: null,
            availableDecisions: ["allow_once", "deny"],
            subject: { kind: "command", command: "cd /tmp && cat file" },
          },
        },
      ],
    });
    expect(command.you).toEqual({ text: "Approve command", approve: { interactionId: "int_cmd", grantedPermissions: null } });

    const grant = threadPreview([], {
      waiting: true,
      interactions: [
        {
          id: "int_perm",
          status: "pending",
          payload: {
            kind: "approval",
            reason: "Needs access",
            availableDecisions: ["allow_once"],
            subject: { kind: "permission_grant", permissions, toolName: "bash" },
          },
        },
      ],
    });
    expect(grant.you).toEqual({ text: "Needs access", approve: { interactionId: "int_perm", grantedPermissions: permissions } });

    expect(
      threadPreview([], {
        waiting: true,
        interactions: [
          {
            id: "int_plan",
            status: "pending",
            payload: { kind: "approval", reason: null, availableDecisions: ["allow_once"], subject: { kind: "plan", plan: "do it" } },
          },
        ],
      }).you,
    ).toEqual({ text: "Approve plan", approve: { interactionId: "int_plan", grantedPermissions: null } });

    expect(
      threadPreview([], {
        waiting: true,
        interactions: [
          {
            id: "int_file",
            status: "pending",
            payload: { kind: "approval", reason: "  ", availableDecisions: ["allow_once"], subject: { kind: "file_change" } },
          },
        ],
      }).you?.text,
    ).toBe("Approve file edit");

    expect(
      threadPreview([], {
        waiting: true,
        interactions: [
          {
            id: "int_tool",
            status: "pending",
            payload: {
              kind: "approval",
              reason: null,
              availableDecisions: ["allow_once"],
              subject: { kind: "tool_use", tool: "bash", presentation: { title: "Run the check", label: { pending: "Check" } } },
            },
          },
        ],
      }).you?.text,
    ).toBe("Run the check");
  });

  it("does not approve a question, a plugin form, or an approval without allow_once", () => {
    expect(
      threadPreview([], {
        waiting: true,
        interactions: [{ id: "q", status: "pending", payload: { kind: "user_question", questions: [{ shortLabel: "Pick one", prompt: "Which option?" }] } }],
      }).you,
    ).toEqual({ text: "Pick one", approve: null });

    expect(
      threadPreview([], {
        interactions: [
          {
            id: "form",
            status: "pending",
            payload: { kind: "plugin", title: "Fill the form", presentation: { title: "Review the form", label: { pending: "Pending form" } } },
          },
        ],
      }).you,
    ).toEqual({ text: "Review the form", approve: null });

    expect(
      threadPreview([], {
        waiting: true,
        interactions: [
          {
            id: "no",
            status: "pending",
            payload: { kind: "approval", reason: null, availableDecisions: ["deny", "allow_for_session"], subject: { kind: "plan" } },
          },
        ],
      }).you,
    ).toEqual({ text: "Approve plan", approve: null });

    const fallback = threadPreview(
      [
        {
          kind: "turn",
          status: "pending",
          children: [
            { kind: "work", status: "completed", workKind: "question", questions: [{ prompt: "Old" }] },
            { kind: "work", status: "pending", workKind: "tool", toolName: "bash", command: "cd /tmp && cat file" },
            { kind: "work", status: "pending", workKind: "question", questions: [{ prompt: "Which file?" }] },
          ],
        },
      ],
      { waiting: true },
    );
    expect(fallback.you).toEqual({ text: "Which file?", approve: null });
    expect(fallback.agent).toBeNull();
    expect(threadPreview([{ kind: "work", status: "pending", workKind: "tool", toolName: "cat" }], { waiting: true }).you).toEqual({
      text: "Waiting for your input",
      approve: null,
    });
  });
});

it("says how long ago, as the sidebar does", () => {
  expect(ago(NOW - 20_000, NOW)).toBe("now");
  expect(ago(NOW - 9 * MIN, NOW)).toBe("9m ago");
  expect(ago(NOW - 8 * 60 * MIN, NOW)).toBe("8h ago");
  expect(ago(NOW - 3 * DAY, NOW)).toBe("3d ago");
});
