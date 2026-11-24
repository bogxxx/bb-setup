// Paths as the scan spells them, and as the machine's OS does. The scan, the
// model and the page use POSIX paths everywhere. On Windows the system drive
// is the scan's root: C:\Users\me is /Users/me in the scan.
import type { Platform } from "./shared";

export interface PathMap {
  platform: Platform;
  /** "C:" on Windows, null elsewhere. */
  drive: string | null;
  /** A scan path as the OS spells it. */
  toNative(path: string): string;
  /** A native absolute path as the scan spells it; null off the scanned drive. */
  toScan(path: string): string | null;
}

/** The OS this code runs on, as Storage Cleaner names it. */
export function platformOf(value: string): Platform {
  return value === "darwin" || value === "win32" ? value : "linux";
}

export function pathMap(platform: Platform, drive: string | null = null): PathMap {
  if (platform !== "win32") {
    return {
      platform,
      drive: null,
      toNative: (path) => path,
      toScan: (path) =>
        path.startsWith("/") ? path.replace(/(.)\/+$/, "$1") : null,
    };
  }
  const letter = (drive ?? "C:").slice(0, 1).toUpperCase();
  return {
    platform,
    drive: `${letter}:`,
    toNative: (path) =>
      `${letter}:${path === "/" ? "\\" : path.replaceAll("/", "\\")}`,
    toScan: (path) => {
      const match = /^([A-Za-z]):([\\/].*)?$/.exec(path);
      if (!match || match[1].toUpperCase() !== letter) return null;
      const rest = (match[2] ?? "/").replaceAll("\\", "/").replace(/\/+$/, "");
      return rest || "/";
    },
  };
}
