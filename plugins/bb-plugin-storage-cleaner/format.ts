import type { GroupId } from "./shared";

/** Group colors, from the theme so every palette works. */
export const GROUP_COLOR: Record<GroupId, string> = {
  bb: "var(--timeline-accent)",
  dev: "var(--warning)",
  apps: "var(--success)",
  trash: "var(--destructive)",
  files: "color-mix(in oklab, var(--foreground) 50%, transparent)",
  system: "color-mix(in oklab, var(--foreground) 22%, transparent)",
};

/** Decimal sizes, like Finder: 1 GB = 10^9 bytes. */
export function formatBytes(bytes: number): string {
  if (bytes >= 1e12) return `${(bytes / 1e12).toFixed(2)} TB`;
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`;
  if (bytes >= 1e3) return `${Math.round(bytes / 1e3)} KB`;
  return `${bytes} B`;
}

/** "today", "3 d ago", "2 mo ago", "1 y ago" for a unix time in seconds. */
export function ago(seconds: number, now = Date.now() / 1000): string {
  if (!seconds) return "—";
  const days = Math.floor((now - seconds) / 86400);
  if (days < 1) return "today";
  if (days < 45) return `${days} d ago`;
  if (days < 365) return `${Math.round(days / 30)} mo ago`;
  return `${Math.round(days / 365)} y ago`;
}

export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count.toLocaleString("en-US")} ${count === 1 ? one : many}`;
}
