import { describe, expect, it } from "vitest";
import { applyEvents, createRoster, latestRun, projectRoster, type BackgroundEvent } from "../src/events";

const NOW = 1_700_000_000_000;
const SESSION = "11111111-1111-4111-8111-111111111111";

function event(seq: number, item: Partial<BackgroundEvent["item"]> & { id: string }, createdAt = NOW + seq): BackgroundEvent {
  return {
    seq,
    createdAt,
    type: item.status === "pending" ? "item/backgroundTask/progress" : "item/backgroundTask/completed",
    providerThreadId: SESSION,
    item: {
      description: "Agent",
      taskType: "local_agent",
      status: "completed",
      taskStatus: "completed",
      skipTranscript: false,
      ...item,
      type: "backgroundTask",
    },
  };
}

describe("background events", () => {
  it("keeps one row per family and takes status from the latest run", () => {
    const roster = createRoster();
    applyEvents(roster, [
      event(1, { id: "run-1", familyId: "familyone", status: "interrupted", taskStatus: "stopped", description: "Old", usage: { totalTokens: 3, toolUses: 1, durationMs: 10 } }),
      event(4, { id: "run-2", familyId: "familyone", status: "completed", taskStatus: "completed", description: "New", usage: { totalTokens: 30, toolUses: 4, durationMs: 50 } }),
      event(2, { id: "bash-1", familyId: "bashagent", taskType: "local_bash", description: "shell" }),
      event(3, { id: "flow-1", familyId: "flowagent", taskType: "local_workflow", description: "flow" }),
    ]);
    const rows = projectRoster(roster, { threadStatus: "idle", now: NOW + 10 });
    expect(rows.map((row) => row.familyId)).toEqual(["familyone"]);
    expect(rows[0]).toMatchObject({
      status: "finished",
      bbStatus: "completed",
      taskStatus: "completed",
      description: "New",
      runCount: 2,
      usage: { totalTokens: 30, toolUses: 4, durationMs: 50 },
      stale: false,
    });
    expect(roster.lastSeq).toBe(4);
  });

  it("merges a later page after afterSeq without dropping the first run", () => {
    const roster = createRoster();
    applyEvents(roster, [event(2, { id: "run-1", familyId: "familyone", status: "interrupted", taskStatus: "stopped" })]);
    expect(roster.lastSeq).toBe(2);
    applyEvents(roster, [event(5, { id: "run-2", familyId: "familyone", status: "completed", description: "Resumed", usage: { totalTokens: 8, toolUses: 1, durationMs: 4 } })]);
    const [row] = projectRoster(roster, { threadStatus: "idle", now: NOW });
    expect(row?.status).toBe("finished");
    expect(row?.runCount).toBe(2);
    expect(row?.description).toBe("Resumed");
    expect(row?.usage?.totalTokens).toBe(8);
    expect(roster.lastSeq).toBe(5);
  });

  it("marks an in-progress agent stale when the thread is idle and quiet", () => {
    const roster = createRoster();
    const started = NOW - 11 * 60 * 1000;
    applyEvents(roster, [event(1, { id: "run-1", familyId: "familyone", status: "pending", taskStatus: "paused" }, started)]);
    expect(projectRoster(roster, { threadStatus: "idle", now: NOW })[0]?.stale).toBe(true);
    expect(projectRoster(roster, { threadStatus: "active", now: NOW })[0]?.stale).toBe(false);
    expect(projectRoster(roster, { threadStatus: "idle", now: NOW })[0]?.status).toBe("in_progress");

    const fresh = createRoster();
    applyEvents(fresh, [event(1, { id: "run-1", familyId: "familyone", status: "pending", taskStatus: "running" }, NOW - 1000)]);
    expect(projectRoster(fresh, { threadStatus: "idle", now: NOW })[0]?.stale).toBe(false);
  });

  it("does not show an older run's outcome on a newer in-progress run", () => {
    const roster = createRoster();
    applyEvents(roster, [
      event(1, {
        id: "run-1",
        familyId: "familyone",
        status: "interrupted",
        taskStatus: "stopped",
        error: "old failure",
        summary: "old summary",
        outputFile: "C:\\temp\\claude\\hash\\session\\tasks\\familyone.output",
      }),
      event(2, { id: "run-2", familyId: "familyone", status: "pending", taskStatus: "running" }),
    ]);
    const [row] = projectRoster(roster, { threadStatus: "active", now: NOW });
    expect(row).toMatchObject({ status: "in_progress", error: null, runCount: 2 });
    expect(latestRun(roster.agents.get("familyone")!)).toMatchObject({
      itemId: "run-2",
      summary: null,
      error: null,
      outputFile: null,
    });

    const failed = createRoster();
    applyEvents(failed, [
      event(1, { id: "run-1", familyId: "familyone", status: "failed", taskStatus: "failed", error: "latest failure" }),
    ]);
    expect(projectRoster(failed, { threadStatus: "idle", now: NOW })[0]?.error).toBe("latest failure");
  });
});
