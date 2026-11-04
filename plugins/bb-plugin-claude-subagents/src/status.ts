export type DisplayStatus = "in_progress" | "finished" | "failed" | "interrupted";
export type BbStatus = "pending" | "completed" | "failed" | "interrupted";
export type TaskStatus = "completed" | "failed" | "killed" | "paused" | "pending" | "running" | "stopped";

const displayByBbStatus: Record<BbStatus, DisplayStatus> = {
  pending: "in_progress",
  completed: "finished",
  failed: "failed",
  interrupted: "interrupted",
};

export function displayStatus(bbStatus: string, _taskStatus?: string): DisplayStatus | null {
  if (Object.prototype.hasOwnProperty.call(displayByBbStatus, bbStatus)) {
    return displayByBbStatus[bbStatus as BbStatus];
  }
  return null;
}

const taskStatuses = new Set<TaskStatus>([
  "completed",
  "failed",
  "killed",
  "paused",
  "pending",
  "running",
  "stopped",
]);

export function asTaskStatus(value: string | undefined): TaskStatus {
  if (value && taskStatuses.has(value as TaskStatus)) return value as TaskStatus;
  return "pending";
}

export function asBbStatus(value: string | undefined): BbStatus | null {
  if (value === "pending" || value === "completed" || value === "failed" || value === "interrupted") {
    return value;
  }
  return null;
}
