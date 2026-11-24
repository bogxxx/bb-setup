// Types and constants the server and the page share. No runtime imports, so
// the page's bundle stays free of server code.
export type GroupId = "bb" | "dev" | "apps" | "trash" | "files" | "system";

/** The operating systems Storage Cleaner knows. */
export type Platform = "darwin" | "linux" | "win32";

/** One BB machine the page can show. */
export interface Machine {
  id: string;
  name: string;
  connected: boolean;
  /** The machine the BB server runs on. */
  primary: boolean;
}

export interface Group {
  id: GroupId;
  label: string;
  bytes: number;
}

/** One row of an unfolded category list. */
export interface Item {
  path: string;
  name: string;
  meta: string;
  size: number;
  frees: number;
  deletable: boolean;
}

/** A kind of developer cache; Clean empties those with `inClean`. */
export interface Cache {
  id: string;
  label: string;
  size: number;
  frees: number;
  count: number;
  inClean: boolean;
  /** The one folder behind the row, when deleting it by hand makes sense. */
  path: string | null;
}

export interface FileType {
  label: string;
  size: number;
  count: number;
  exts: [string, number][];
}

/** A file or folder found by Largest files or Stale. */
export interface Entry {
  path: string;
  size: number;
  frees: number;
  modified: number;
  folder: boolean;
  deletable: boolean;
}

export interface Snapshot {
  /** The machine's operating system. */
  platform: Platform;
  /** The home folder, as the scan's paths spell it. */
  home: string;
  /** What the explorer calls the scanned disk: "Macintosh HD", "/", "C:". */
  rootLabel: string;
  /** Windows' drive letter, "C:", that the scan's paths start from; null elsewhere. */
  drive: string | null;
  scanning: boolean;
  error: string | null;
  /** Whether BB has Full Disk Access, without which macOS hides Mail and more. */
  fullDiskAccess: boolean;
  scannedAt: number | null;
  total: number;
  free: number;
  groups: Group[];
  /** Null when BB can't read the Trash. */
  trash: number | null;
  bb: { archived: Item[]; worktrees: Item[]; live: Item[]; agents: Item[] };
  dev: Cache[];
  apps: Item[];
  files: Item[];
  system: Item[];
  types: FileType[];
  largest: Entry[];
  stale: Entry[];
}

/** Node flags: the folded "smaller items" row, and a path never deleted. */
export const FOLDED = 1;
export const PROTECTED = 2;

/** [name, size, frees, modified, group, children (0 for a file), flags, label?] */
export type Node = [
  string,
  number,
  number,
  number,
  GroupId,
  Node[] | 0,
  number,
  string?,
];

export const CHANGED = "storage-changed";

/** A path as the machine's own OS writes it: C:\\Users\\me on Windows. */
export function nativePath(snapshot: Pick<Snapshot, "drive">, path: string) {
  return snapshot.drive ? snapshot.drive + path.replaceAll("/", "\\") : path;
}

/** What a deletion freed, and the paths it couldn't delete. */
export interface Outcome {
  freed: number;
  failed: string[];
}
