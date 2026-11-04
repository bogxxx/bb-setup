import type { DisplayStatus } from "../status";

const labels: Record<DisplayStatus, string> = {
  in_progress: "In progress",
  finished: "Finished",
  failed: "Failed",
  interrupted: "Interrupted",
};

export function statusLabel(status: DisplayStatus): string {
  return labels[status];
}

export function formatCount(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

export function formatDuration(durationMs: number): string {
  if (durationMs < 1000) return `${Math.round(durationMs)} ms`;
  const seconds = durationMs / 1000;
  if (seconds < 60) return `${seconds >= 10 ? Math.round(seconds) : seconds.toFixed(1)} s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  if (minutes < 60) return `${minutes}m ${rest}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

export function staleText(updatedAt: number, now: number): string {
  const minutes = Math.max(1, Math.floor((now - updatedAt) / 60000));
  return `no update for ${minutes} min`;
}
