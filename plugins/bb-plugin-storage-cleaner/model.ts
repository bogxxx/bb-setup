// Turns a scan into what the page shows: groups, the lists under each
// category, the explorer's folders. Pure functions over the scan tree.
import { ago } from "./format";
import type { PathMap } from "./platform";
import {
  FOLDED,
  PROTECTED,
  type Cache,
  type Entry,
  type FileType,
  type GroupId,
  type Item,
  type Node,
  type Platform,
  type Snapshot,
} from "./shared";

export interface ScanNode {
  n: string;
  s: number;
  u: number;
  a: number;
  f: number;
  m: number;
  k?: ScanNode[];
  /** Folded small children: [s, u, a, files]. */
  o?: [number, number, number, number];
  /** 1 when the folder couldn't be read. */
  x?: number;
  /** 1 for a file. */
  t?: 1;
  g?: GroupId;
}

export interface Scan {
  root: string;
  scannedAt: number;
  tree: ScanNode;
  exts: Record<string, [number, number]>;
  /** [allocated, share, private, path, mtime] */
  topFiles: [number, number, number, string, number][];
  /** Bytes in use on the volume when the scan ran. */
  used?: number;
  /** Whether BB had Full Disk Access when the scan ran. */
  fullDiskAccess?: boolean;
}

export interface ThreadInfo {
  title: string;
  project: string;
  archivedAt: number | null;
}

export interface Disk {
  total: number;
  free: number;
  /** Bytes in use on the scanned volume. */
  used: number;
  volumes: { label: string; bytes: number }[];
}

export interface Context {
  /** The machine's OS; macOS when unset. */
  platform?: Platform;
  /** Windows' drive letter, "C:", that scan paths start from. */
  drive?: string | null;
  /**
   * The scan's own spelling of a path, for file systems that ignore case:
   * Windows' AppData/Local/pip/Cache may be cache on disk.
   */
  fixCase?: (path: string) => string;
  /** Scan paths to and from the OS's own; the same paths when unset. */
  pathMap?: PathMap;
  home: string;
  /** BB's data folder: thread storage and worktrees live in it. */
  bbData: string;
  threads: Map<string, ThreadInfo>;
  /** Asks BB directly whether a thread missing from the list still exists. */
  exists?: (threadId: string) => Promise<boolean>;
  /** Workspaces of live threads. */
  inUse?: string[];
  disk: Disk;
  /** Unix seconds. */
  now: number;
}

export const DAY = 86400;
const GROUPS: [GroupId, string][] = [
  ["bb", "BB & agents"],
  ["dev", "Dev caches"],
  ["apps", "Apps"],
  ["trash", "Trash"],
  ["files", "Your files"],
  ["system", "System"],
];
const words = (text: string) => new Set(text.split(" "));
const BUILD_NAMES = words(
  "build .build .next .turbo .nuxt .parcel-cache __pycache__ .pytest_cache .mypy_cache .ruff_cache DerivedData .gradle Pods .svelte-kit .expo",
);
const VENV_NAMES = words(".venv venv");
const isDevName = (name: string) =>
  name === "node_modules" || BUILD_NAMES.has(name) || VENV_NAMES.has(name);
const KEEP_IN_HOME = words(
  "Library .bb .bb-machines .config .ssh .Trash Applications Documents Desktop Downloads Movies Music Pictures Public",
);
const KEEP_IN_HOME_LINUX = words(
  ".bb .bb-machines .config .local .ssh .gnupg .pki .mozilla Desktop Documents Downloads Music Pictures Public Templates Videos",
);
const KEEP_IN_HOME_WINDOWS = new Set([
  "appdata",
  ".bb",
  ".bb-machines",
  ".config",
  ".ssh",
  ".gnupg",
  "desktop",
  "documents",
  "downloads",
  "music",
  "pictures",
  "videos",
  "favorites",
  "links",
  "contacts",
  "saved games",
  "searches",
  "3d objects",
]);
/** Top-level folders of / that are the OS's own on Linux. */
const LINUX_SYSTEM = words(
  "proc sys dev run boot etc usr bin sbin lib lib32 lib64 libx32 snap srv root lost+found",
);
/** Folders of /var that are the OS's own on Linux. */
const LINUX_VAR = words(
  "lib log spool run lock mail db backups empty account crash adm kerberos nis preserve yp opt local games",
);
/** Top-level folders of C:\ that are Windows' own, in lower case. */
const WINDOWS_SYSTEM = new Set([
  "windows",
  "program files",
  "program files (x86)",
  "programdata",
  "$recycle.bin",
  "system volume information",
  "recovery",
  "boot",
  "perflogs",
  "documents and settings",
  "config.msi",
  "msocache",
  "$winreagent",
  "$windows.~bt",
  "$windows.~ws",
  "$sysreset",
]);
/** Language toolchains in the home folder, which hold installs, not your files. */
const TOOLCHAINS = [
  ".bun",
  ".cargo",
  ".rustup",
  ".nvm",
  ".pyenv",
  ".volta",
  ".deno",
  ".dotnet",
  ".sdkman",
  "go",
  ".vscode-server",
  ".cursor-server",
];
const isOneDrive = (name: string) => /^onedrive( - .+)?$/i.test(name);

const osOf = (ctx: Pick<Context, "platform">): Platform =>
  ctx.platform ?? "darwin";
const fixer = (ctx: Pick<Context, "fixCase">) =>
  ctx.fixCase ?? ((path: string) => path);

/** What the explorer calls the scanned disk. */
export function rootLabel(ctx: Pick<Context, "platform" | "drive">) {
  const os = osOf(ctx);
  return os === "darwin" ? "Macintosh HD" : os === "win32" ? (ctx.drive ?? "C:") : "/";
}

const AGENT_DIRS: Record<Platform, string[]> = {
  darwin: [
    ".claude",
    "Library/Application Support/Claude",
    ".codex",
    ".aside",
    "Library/Application Support/Aside",
    ".chrome-cdp",
    ".agents",
    ".copilot",
    ".cursor",
    ".gemini",
  ],
  linux: [
    ".claude",
    ".config/Claude",
    ".codex",
    ".aside",
    ".chrome-cdp",
    ".agents",
    ".copilot",
    ".cursor",
    ".gemini",
  ],
  win32: [
    ".claude",
    "AppData/Roaming/Claude",
    ".codex",
    ".aside",
    ".chrome-cdp",
    ".agents",
    ".copilot",
    ".cursor",
    ".gemini",
  ],
};

/** Folders the explorer and every list are built around. */
export function paths(
  ctx: Pick<Context, "home" | "bbData" | "platform" | "fixCase">,
) {
  const H = ctx.home;
  const B = ctx.bbData;
  const os = osOf(ctx);
  const fix = fixer(ctx);
  return {
    threadStorage: fix(`${B}/thread-storage`),
    worktrees: fix(`${B}/plugins/environment-git-worktree/host-data/worktrees`),
    gitWorktreePlugin: fix(`${B}/plugins/environment-git-worktree`),
    workspaces: fix(`${B}/plugins/environment-personal-workspace`),
    trash: fix(
      os === "darwin"
        ? `${H}/.Trash`
        : os === "linux"
          ? `${H}/.local/share/Trash`
          : "/$Recycle.Bin",
    ),
    agents: AGENT_DIRS[os].map((p) => fix(`${H}/${p}`)),
    /** Where BB keeps a data folder per server an enrolled machine connects to. */
    machines: fix(`${H}/.bb-machines`),
    /** Apps' own data, which searches for projects skip. */
    library: fix(
      os === "darwin"
        ? `${H}/Library`
        : os === "win32"
          ? `${H}/AppData`
          : `${H}/.local/share`,
    ),
  };
}

/** The developer caches, in the order the list shows them. */
export function cacheKinds(ctx: Pick<Context, "home" | "platform" | "fixCase">) {
  const H = ctx.home;
  const os = osOf(ctx);
  const fix = fixer(ctx);
  const kind = (id: string, label: string, inClean: boolean, list = "") => ({
    id,
    label,
    inClean,
    paths: list ? list.split(" ").map((p) => fix(p.replace("~", H))) : [],
  });
  if (os === "linux")
    return [
      kind("uv", "uv cache", true, "~/.cache/uv"),
      kind("npm", "npm cache", true, "~/.npm/_cacache ~/.npm/_npx"),
      kind(
        "pnpm",
        "pnpm store",
        true,
        "~/.local/share/pnpm/store ~/.pnpm-store ~/.cache/pnpm",
      ),
      kind(
        "packages",
        "Other package caches",
        true,
        "~/.cache/pip ~/.cache/yarn ~/.yarn/berry/cache ~/.bun/install/cache ~/.cargo/registry ~/go/pkg/mod ~/.cache/go-build ~/.gradle/caches ~/.m2/repository ~/.nuget/packages ~/.cache/puppeteer ~/.cache/ms-playwright ~/.cache/node-gyp ~/.cache/Homebrew ~/.cache/deno",
      ),
      kind("build", "Build folders", true),
      kind("huggingface", "Hugging Face models", false, "~/.cache/huggingface"),
      kind(
        "models",
        "Other model caches",
        false,
        "~/.cache/torch ~/.ollama ~/.lmstudio ~/.cache/whisper ~/.cache/lm-studio",
      ),
      kind("appCaches", "App caches", false, "~/.cache"),
      kind("nodeModules", "node_modules", false),
      kind("venvs", "Python virtualenvs", false),
      kind("tmp", "Temporary files", false, "/tmp /var/tmp"),
    ];
  if (os === "win32")
    return [
      kind("uv", "uv cache", true, "~/AppData/Local/uv/cache"),
      kind(
        "npm",
        "npm cache",
        true,
        "~/AppData/Local/npm-cache/_cacache ~/AppData/Local/npm-cache/_npx",
      ),
      kind(
        "pnpm",
        "pnpm store",
        true,
        "~/AppData/Local/pnpm/store ~/AppData/Local/pnpm-cache ~/.pnpm-store",
      ),
      kind(
        "packages",
        "Other package caches",
        true,
        "~/AppData/Local/pip/Cache ~/AppData/Local/Yarn/Cache ~/AppData/Local/node-gyp/Cache ~/AppData/Local/ms-playwright ~/AppData/Local/go-build ~/AppData/Local/NuGet/v3-cache ~/AppData/Local/NuGet/Cache ~/AppData/Local/deno ~/.bun/install/cache ~/.cargo/registry ~/go/pkg/mod ~/.gradle/caches ~/.m2/repository ~/.nuget/packages ~/.cache/puppeteer",
      ),
      kind("logs", "Crash dumps", true, "~/AppData/Local/CrashDumps"),
      kind("build", "Build folders", true),
      kind("huggingface", "Hugging Face models", false, "~/.cache/huggingface"),
      kind(
        "models",
        "Other model caches",
        false,
        "~/.cache/torch ~/.ollama ~/.lmstudio ~/.cache/whisper ~/.cache/lm-studio",
      ),
      kind("nodeModules", "node_modules", false),
      kind("venvs", "Python virtualenvs", false),
      kind("tmp", "Temporary files", false, "~/AppData/Local/Temp /Windows/Temp"),
    ];
  const C = `${H}/Library/Caches`;
  return [
    kind(
      "derived",
      "Xcode DerivedData",
      true,
      "~/Library/Developer/Xcode/DerivedData",
    ),
    kind("uv", "uv cache", true, "~/.cache/uv"),
    kind("npm", "npm cache", true, "~/.npm/_cacache ~/.npm/_npx"),
    kind(
      "pnpm",
      "pnpm store",
      true,
      "~/Library/pnpm/store ~/.pnpm-store ~/.local/share/pnpm/store",
    ),
    kind(
      "packages",
      "Other package caches",
      true,
      `${C}/pip ${C}/org.swift.swiftpm ${C}/CocoaPods ${C}/ms-playwright ${C}/Homebrew ${C}/Yarn ${C}/pnpm ${C}/node-gyp ~/.cache/pip ~/.cache/yarn ~/.bun/install/cache ~/.cargo/registry ~/go/pkg/mod ~/.gradle/caches ~/.cache/puppeteer ~/.cache/ms-playwright`,
    ),
    kind("logs", "Logs", true, "~/Library/Logs"),
    kind("build", "Build folders", true),
    kind(
      "simulators",
      "iOS simulators",
      false,
      "~/Library/Developer/CoreSimulator /Library/Developer/CoreSimulator /System/Library/AssetsV2/com_apple_MobileAsset_iOSSimulatorRuntime",
    ),
    kind("huggingface", "Hugging Face models", false, "~/.cache/huggingface"),
    kind(
      "models",
      "Other model caches",
      false,
      "~/.cache/torch ~/.ollama ~/.lmstudio ~/.cache/whisper ~/.cache/lm-studio",
    ),
    kind("appCaches", "App caches", false, C),
    kind("nodeModules", "node_modules", false),
    kind("venvs", "Python virtualenvs", false),
    kind("tmp", "Temporary files", false, "/private/tmp"),
  ];
}

export const joinPath = (dir: string, name: string) =>
  dir === "/" ? `/${name}` : `${dir}/${name}`;
const kids = (node: ScanNode) => node.k ?? [];
const sum = <T>(list: T[], by: (item: T) => number) =>
  list.reduce((total, item) => total + by(item), 0);

/** The nodes from the root down to a path, or null when the scan lacks it. */
function chain(tree: ScanNode, path: string) {
  const out = [tree];
  for (const name of path.split("/").filter(Boolean)) {
    const next = kids(out[out.length - 1]).find((c) => c.n === name);
    if (!next) return null;
    out.push(next);
  }
  return out;
}

/** The node at an absolute path, or null when the scan didn't keep it. */
export function find(tree: ScanNode, path: string) {
  return chain(tree, path)?.pop() ?? null;
}

/**
 * A path spelled the way the scan has it, each name matched without case, for
 * Windows. Names the scan lacks keep their spelling.
 */
export function matchCase(tree: ScanNode, path: string) {
  const names = path.split("/").filter(Boolean);
  const out: string[] = [];
  let node: ScanNode | undefined = tree;
  for (const [i, name] of names.entries()) {
    const list: ScanNode[] = node ? kids(node) : [];
    const lower = name.toLowerCase();
    node =
      list.find((c) => c.n === name) ??
      list.find((c) => c.n.toLowerCase() === lower);
    if (!node) return "/" + [...out, ...names.slice(i)].join("/");
    out.push(node.n);
  }
  return "/" + out.join("/");
}

/** The children of the node at a path; none when the scan lacks it. */
export function kidsAt(tree: ScanNode, path: string) {
  const node = find(tree, path);
  return node ? kids(node) : [];
}

interface Rule {
  group: GroupId;
  /** Nothing inside a sticky match is reassigned. */
  sticky: boolean;
}

/** Tag every node with its group: the innermost rule on its path wins. */
export function assignGroups(scan: Scan, ctx: Context) {
  const H = ctx.home;
  const p = paths(ctx);
  const byPath = new Map<string, Rule>();
  const add = (group: GroupId, sticky: boolean, list: string[]) => {
    for (const path of list)
      if (!byPath.has(path)) byPath.set(path, { group, sticky });
  };
  const os = osOf(ctx);
  const fix = fixer(ctx);
  add("bb", true, [p.threadStorage, p.gitWorktreePlugin, p.workspaces]);
  add("bb", false, [ctx.bbData, ...p.agents, p.machines]);
  add("trash", true, [p.trash]);
  if (os === "darwin") {
    add("dev", true, [
      ...cacheKinds(ctx).flatMap((k) => k.paths),
      `${H}/Library/Developer`,
      "/Library/Developer",
      "/Library/Caches",
      "/private/var/folders",
      `${H}/.cache`,
      `${H}/.npm`,
    ]);
    add("apps", true, [
      "/Applications",
      `${H}/Applications`,
      "/opt/homebrew",
      "/usr/local",
    ]);
    add("files", true, [
      `${H}/Library/Mobile Documents`,
      `${H}/Library/CloudStorage`,
    ]);
    add("apps", false, [`${H}/Library`]);
  } else if (os === "linux") {
    add("dev", true, [
      ...cacheKinds(ctx)
        .filter((k) => k.id !== "tmp")
        .flatMap((k) => k.paths),
      `${H}/.cache`,
      `${H}/.npm`,
      "/var/cache",
    ]);
    // Temporary folders hold dev scratch, but whatever else lands in them
    // keeps its own group.
    add("dev", false, ["/tmp", "/var/tmp"]);
    add("apps", true, [
      "/opt",
      "/snap",
      "/var/lib/snapd",
      "/var/lib/flatpak",
      "/usr/local",
      "/home/linuxbrew",
      `${H}/.local/share/flatpak`,
      `${H}/Applications`,
    ]);
    // The OS's own folders stay System, whatever their names look like.
    add("system", true, [
      "/usr/bin",
      "/usr/sbin",
      "/usr/lib",
      "/usr/lib32",
      "/usr/lib64",
      "/usr/libexec",
      "/usr/include",
      "/usr/share",
      "/usr/src",
      "/etc",
      "/boot",
      "/var/lib",
      "/var/log",
    ]);
    add("apps", false, [
      `${H}/.local`,
      `${H}/.config`,
      ...TOOLCHAINS.map((name) => `${H}/${name}`),
    ]);
  } else {
    add(
      "dev",
      true,
      [
        ...cacheKinds(ctx).flatMap((k) => k.paths),
        `${H}/.cache`,
        `${H}/AppData/Local/Temp`,
        "/Windows/Temp",
      ].map(fix),
    );
    add(
      "apps",
      true,
      [
        "/Program Files",
        "/Program Files (x86)",
        `${H}/AppData/Local/Programs`,
        `${H}/scoop`,
        "/ProgramData/chocolatey",
      ].map(fix),
    );
    add(
      "apps",
      false,
      [
        `${H}/AppData`,
        "/ProgramData",
        ...TOOLCHAINS.map((name) => `${H}/${name}`),
      ].map(fix),
    );
  }
  add("files", false, [H]);
  const visit = (node: ScanNode, path: string, rule: Rule) => {
    node.g = rule.group;
    for (const child of kids(node)) {
      const at = joinPath(path, child.n);
      if (child.t || rule.sticky) {
        if (child.t) child.g = rule.group;
        else visit(child, at, rule);
        continue;
      }
      const match =
        byPath.get(at) ??
        (at.endsWith("/.claude/worktrees")
          ? ({ group: "bb", sticky: true } as Rule)
          : undefined) ??
        (isDevName(child.n)
          ? ({ group: "dev", sticky: true } as Rule)
          : undefined) ??
        (child.n === ".git"
          ? ({ group: "files", sticky: true } as Rule)
          : undefined) ??
        // Linuxbrew lives wherever its .linuxbrew folder is.
        (os === "linux" && child.n === ".linuxbrew"
          ? ({ group: "apps", sticky: true } as Rule)
          : undefined) ??
        // OneDrive syncs every device; its folders are your files.
        (os === "win32" && path === H && isOneDrive(child.n)
          ? ({ group: "files", sticky: true } as Rule)
          : undefined);
      visit(child, at, match ?? rule);
    }
  };
  visit(scan.tree, "/", { group: "system", sticky: false });
}

/** Bytes inside a node, split by group. */
function totals(
  node: ScanNode,
  out: Record<GroupId, number> = {
    bb: 0,
    dev: 0,
    apps: 0,
    trash: 0,
    files: 0,
    system: 0,
  },
) {
  const group = node.g ?? "system";
  out[group] += node.t ? node.s : (node.o?.[0] ?? 0);
  for (const child of kids(node)) totals(child, out);
  return out;
}

/** Folders with a matching name, not looking inside a match. */
function collectNamed(
  scan: Scan,
  start: string,
  skip: string[],
  names: (name: string) => boolean,
) {
  const out: { path: string; node: ScanNode }[] = [];
  const walk = (node: ScanNode, path: string) => {
    for (const child of kids(node)) {
      const at = joinPath(path, child.n);
      if (
        child.t ||
        at.includes("/.claude/worktrees/") ||
        skip.some((s) => at === s || at.startsWith(`${s}/`))
      )
        continue;
      if (names(child.n)) out.push({ path: at, node: child });
      else if (child.n !== ".git") walk(child, at);
    }
  };
  const root = find(scan.tree, start);
  if (root) walk(root, start);
  return out;
}

/** Build folders, node_modules and virtualenvs in the home folder's projects. */
function devFolders(scan: Scan, ctx: Context) {
  const H = ctx.home;
  const p = paths(ctx);
  const fix = fixer(ctx);
  const found = collectNamed(
    scan,
    H,
    [ctx.bbData, p.library, fix(`${H}/.cache`), fix(`${H}/.npm`), p.trash],
    isDevName,
  );
  // ~/.gradle and ~/.expo hold settings and logins, not builds.
  const inProject = (f: { path: string }) =>
    f.path.slice(0, f.path.lastIndexOf("/")) !== H;
  return {
    build: found.filter((f) => BUILD_NAMES.has(f.node.n) && inProject(f)),
    nodeModules: found.filter((f) => f.node.n === "node_modules"),
    venvs: found.filter((f) => VENV_NAMES.has(f.node.n)),
  } as Record<string, { path: string; node: ScanNode }[]>;
}

/** An absolute path without empty, "." or ".." parts, or null. */
export function canonical(path: string) {
  const parts = path.split("/").filter(Boolean);
  if (!path.startsWith("/") || parts.some((p) => p === "." || p === ".."))
    return null;
  return "/" + parts.join("/");
}

/** Paths the page never offers to delete. Expects a canonical path. */
export function isProtected(
  path: string,
  ctx: Pick<Context, "home" | "bbData" | "platform">,
) {
  if (canonical(path) !== path) return true;
  const os = osOf(ctx);
  if (os === "linux") return isProtectedLinux(path, ctx);
  if (os === "win32") return isProtectedWindows(path, ctx);
  const parts = path.split("/").filter(Boolean);
  if (parts[0] === "Applications" && parts.length === 2)
    return !parts[1].endsWith(".app");
  if (
    parts.length <= 2 ||
    words("System usr bin sbin etc dev cores Volumes").has(parts[0])
  )
    return true;
  if (parts[0] === "private" && parts[1] !== "tmp") return true;
  if (parts[0] === "Library" && parts.length <= 3) return true;
  const H = ctx.home;
  if (path === H) return true;
  if (path.startsWith(`${H}/`)) {
    // The home folder's own folders, ~/Library's top two levels, and synced
    // clouds and keychains, where a delete reaches every device or loses secrets.
    const rel = path.slice(H.length + 1).split("/");
    if (rel.length === 1 && KEEP_IN_HOME.has(rel[0])) return true;
    if (rel[0] === "Library" && rel.length <= 2) return true;
    if (
      rel[0] === "Library" &&
      ["Mobile Documents", "CloudStorage"].includes(rel[1]) &&
      rel.length <= 3
    )
      return true;
    if (rel[0] === "Library" && rel[1] === "Keychains") return true;
  }
  return inBbData(path, ctx) ?? false;
}

/**
 * BB's folders: in BB's data only thread storage and worktree folders can go,
 * and nothing of another server's data in ~/.bb-machines. Null outside both.
 */
function inBbData(
  path: string,
  ctx: Pick<Context, "home" | "bbData" | "platform">,
): boolean | null {
  if (path === ctx.bbData || path.startsWith(`${ctx.bbData}/`)) {
    const p = paths(ctx);
    return !(
      path.startsWith(`${p.threadStorage}/`) ||
      path.startsWith(`${p.worktrees}/`)
    );
  }
  const machines = `${ctx.home}/.bb-machines`;
  if (path === machines || path.startsWith(`${machines}/`)) return true;
  return null;
}

function isProtectedLinux(
  path: string,
  ctx: Pick<Context, "home" | "bbData" | "platform">,
) {
  const parts = path.split("/").filter(Boolean);
  if (parts.length <= 2 || LINUX_SYSTEM.has(parts[0])) return true;
  if (parts[0] === "var" && LINUX_VAR.has(parts[1])) return true;
  const H = ctx.home;
  if (path === H) return true;
  if (path.startsWith(`${H}/`)) {
    // The home folder's own folders, the settings and app data in ~/.config
    // and ~/.local, the Trash's own folders, and keys, where a delete loses
    // secrets.
    const rel = path.slice(H.length + 1).split("/");
    if (rel.length === 1 && KEEP_IN_HOME_LINUX.has(rel[0])) return true;
    if ((rel[0] === ".config" || rel[0] === ".local") && rel.length <= 2)
      return true;
    if (words(".ssh .gnupg .pki").has(rel[0])) return true;
    if (rel[0] === ".local" && rel[1] === "share") {
      if (rel[2] === "keyrings") return true;
      if (rel[2] === "Trash" && rel.length <= 4) return true;
    }
  }
  return inBbData(path, ctx) ?? false;
}

/** Windows ignores case, so every comparison here is in lower case. */
function isProtectedWindows(
  path: string,
  ctx: Pick<Context, "home" | "bbData" | "platform">,
) {
  const lower = path.toLowerCase();
  const parts = lower.split("/").filter(Boolean);
  // C:\ itself, its top-level folders, and files such as pagefile.sys.
  if (parts.length <= 1 || WINDOWS_SYSTEM.has(parts[0])) return true;
  if (parts[0] === "users") {
    if (parts.length <= 2) return true;
    if (["public", "default", "default user", "all users"].includes(parts[1]))
      return true;
  }
  const H = ctx.home.toLowerCase();
  if (lower === H) return true;
  if (lower.startsWith(`${H}/`)) {
    // The home folder's own folders and NTUSER.DAT, AppData's top levels,
    // Windows' credentials and keys under AppData's Microsoft folders, the
    // Temp folder itself, OneDrive, which a delete reaches on every device,
    // and keys.
    const rel = lower.slice(H.length + 1).split("/");
    if (rel.length === 1 && (KEEP_IN_HOME_WINDOWS.has(rel[0]) || rel[0].startsWith("ntuser")))
      return true;
    if (isOneDrive(rel[0]) && rel.length <= 2) return true;
    if (rel[0] === ".ssh" || rel[0] === ".gnupg") return true;
    if (rel[0] === "appdata") {
      if (rel.length <= 2) return true;
      if (rel[2] === "microsoft") return true;
      if (rel[1] === "local" && ["temp", "packages"].includes(rel[2]) && rel.length <= 3)
        return true;
    }
  }
  return (
    inBbData(lower, {
      home: H,
      bbData: ctx.bbData.toLowerCase(),
      platform: "win32",
    }) ?? false
  );
}

/** The thread a thread-storage or worktree folder belongs to. */
function threadOf(name: string, ctx: Context) {
  const id = name.replace(/-\d+$/, "");
  return id.startsWith("thr_")
    ? { id, info: ctx.threads.get(id) ?? null }
    : null;
}

function threadMeta(info: ThreadInfo | null, ctx: Context) {
  if (!info) return "deleted thread";
  const state = info.archivedAt
    ? `archived ${ago(info.archivedAt / 1000, ctx.now)}`
    : "live";
  return [info.project, state].filter(Boolean).join(" · ");
}

function item(
  path: string,
  node: ScanNode,
  name: string,
  meta: string,
  ctx: Context,
  size = node.s,
): Item {
  return {
    path,
    name,
    meta,
    size,
    frees: node.u,
    deletable: !isProtected(path, ctx),
  };
}

/** A row that only shows a size. */
const fixed = (name: string, size: number, meta = ""): Item => ({
  path: "",
  name,
  meta,
  size,
  frees: 0,
  deletable: false,
});

const bySize = <T extends { size: number }>(list: T[]) =>
  list.sort((a, b) => b.size - a.size);

/** Thread storage and worktrees, split by whether a live thread owns them. */
export function bbItems(scan: Scan, ctx: Context) {
  const p = paths(ctx);
  const archived: Item[] = [];
  const live: Item[] = [];
  for (const child of kidsAt(scan.tree, p.threadStorage)) {
    const owner = threadOf(child.n, ctx);
    if (!owner || child.t) continue;
    const row = item(
      joinPath(p.threadStorage, child.n),
      child,
      owner.info?.title || child.n,
      threadMeta(owner.info, ctx),
      ctx,
    );
    (owner.info && !owner.info.archivedAt ? live : archived).push(row);
  }
  const worktrees: Item[] = [];
  for (const child of kidsAt(scan.tree, p.worktrees)) {
    const owner = threadOf(child.n, ctx);
    if (!owner || child.t || (owner.info && !owner.info.archivedAt)) continue;
    const dir = joinPath(p.worktrees, child.n);
    // Forks and children share a worktree; skip one a live thread works in.
    if (ctx.inUse?.some((used) => used === dir || used.startsWith(`${dir}/`)))
      continue;
    // BB removes a worktree itself 5 minutes after its last thread is archived.
    if (owner.info?.archivedAt && ctx.now - owner.info.archivedAt / 1000 < 3600)
      continue;
    worktrees.push(
      item(
        dir,
        child,
        owner.info?.title || child.n,
        `worktree · ${threadMeta(owner.info, ctx)}`,
        ctx,
      ),
    );
  }
  // Worktrees Claude Code made inside projects, left alone for 3 days.
  for (const { path, node } of collectNamed(
    scan,
    ctx.home,
    [ctx.bbData, p.library],
    (n) => n === ".claude",
  )) {
    for (const child of kidsAt(node, "worktrees")) {
      if (child.t || !child.m || ctx.now - child.m < 3 * DAY) continue;
      const project = path.split("/").slice(-2, -1)[0] ?? "";
      worktrees.push(
        item(
          `${path}/worktrees/${child.n}`,
          child,
          child.n,
          `Claude Code · ${project} · idle ${ago(child.m, ctx.now)}`,
          ctx,
        ),
      );
    }
  }
  const agents: Item[] = [];
  // BB's data for other connections of this machine, such as an older
  // enrollment or another server: listed, never cleaned from here.
  const others = kidsAt(scan.tree, p.machines)
    .filter((c) => !c.t)
    .map((c) => joinPath(p.machines, c.n))
    .filter((path) => path !== ctx.bbData);
  for (const path of [...p.agents, ctx.bbData, p.workspaces, ...others]) {
    const node = find(scan.tree, path);
    if (!node) continue;
    // BB's own data, without the thread storage and worktrees listed above.
    const size =
      path === ctx.bbData
        ? node.s -
          sum(
            [p.threadStorage, p.gitWorktreePlugin, p.workspaces],
            (inner) => find(scan.tree, inner)?.s ?? 0,
          )
        : node.s;
    const name =
      path === ctx.bbData
        ? "BB data"
        : path === p.workspaces
          ? "BB personal workspaces"
          : path.replace(ctx.home, "~");
    const meta = others.includes(path) ? "another BB connection" : "";
    if (size > 50e6)
      agents.push({
        ...item(path, node, name, meta, ctx, size),
        deletable: false,
      });
  }
  return {
    archived: bySize(archived),
    worktrees: bySize(worktrees),
    live: bySize(live),
    agents: bySize(agents),
  };
}

/** Every folder a cache row stands for, and folders other rows claim from it. */
export function cacheFolders(scan: Scan, ctx: Context) {
  const named = devFolders(scan, ctx);
  const kinds = cacheKinds(ctx);
  const nodes = (list: string[]) =>
    list.flatMap((path) => {
      const node = find(scan.tree, path);
      return node && !node.t ? [{ path, node }] : [];
    });
  return kinds.map((kind) => ({
    kind,
    folders: named[kind.id] ?? nodes(kind.paths),
    // App caches: whatever in ~/Library/Caches no other row claims.
    minus:
      kind.id === "appCaches"
        ? nodes(
            kinds
              .flatMap((k) => (k === kind ? [] : k.paths))
              .filter((p) => p.startsWith(`${kind.paths[0]}/`)),
          )
        : [],
  }));
}

function devCaches(scan: Scan, ctx: Context): Cache[] {
  return cacheFolders(scan, ctx)
    .map(({ kind, folders, minus }) => {
      const single =
        folders.length === 1 &&
        !words("simulators tmp huggingface models appCaches").has(kind.id);
      return {
        id: kind.id,
        label: kind.label,
        size: sum(folders, (f) => f.node.s) - sum(minus, (f) => f.node.s),
        frees: sum(folders, (f) => f.node.u) - sum(minus, (f) => f.node.u),
        count: folders.length,
        inClean: kind.inClean,
        path:
          single && !isProtected(folders[0].path, ctx) ? folders[0].path : null,
      };
    })
    .filter((c) => c.size > 0)
    .sort((a, b) => b.size - a.size);
}

const TYPES: [string, string][] = [
  ["Video", "mp4 mov mkv avi webm m4v mpg mpeg"],
  ["Audio", "wav mp3 flac m4a aac ogg opus aiff aif caf"],
  [
    "Images",
    "jpg jpeg png gif heic webp tiff tif bmp dng cr2 nef psd svg ico icns",
  ],
  [
    "Model weights & tensors",
    "safetensors gguf pt pth ckpt onnx npy npz h5 hdf5 pkl pickle tflite mlmodel pb msgpack nemo",
  ],
  [
    "Datasets & databases",
    "parquet arrow feather csv tsv jsonl ndjson sqlite sqlite3 db lmdb mdb tfrecord wal shm",
  ],
  [
    "Archives & disk images",
    "zip tar gz tgz bz2 xz zst 7z rar dmg iso img vmdk qcow2 raw sparseimage pkg whl asar",
  ],
  [
    "Libraries & binaries",
    "so dylib a o node wasm pyc class jar dll exe car metallib bin dat",
  ],
  [
    "Code & text",
    "js mjs cjs ts tsx jsx map py pyi rs go swift c cc cpp h hpp m mm java kt rb php css scss html md txt yaml yml toml xml sh json lock log",
  ],
  ["Documents", "pdf doc docx xls xlsx ppt pptx key pages numbers rtf epub"],
];

function fileTypes(scan: Scan): FileType[] {
  const kindOf = new Map(
    TYPES.flatMap(([label, exts]) =>
      exts.split(" ").map((ext) => [ext, label] as const),
    ),
  );
  const out = new Map<string, FileType>();
  for (const [ext, [size, count]] of Object.entries(scan.exts)) {
    const label =
      kindOf.get(ext) ??
      (ext === "" || ext.startsWith("@") ? "No extension" : "Other");
    const type = out.get(label) ?? { label, size: 0, count: 0, exts: [] };
    type.size += size;
    type.count += count;
    type.exts.push([ext || "(none)", size]);
    out.set(label, type);
  }
  return bySize(
    [...out.values()].map((t) => ({
      ...t,
      exts: t.exts.sort((a, b) => b[1] - a[1]).slice(0, 6),
    })),
  );
}

/** Display path of a scanner path: the scanned root becomes "/". */
function displayPath(scan: Scan, path: string) {
  if (scan.root === "/" || !path.startsWith(scan.root)) return path;
  return path.slice(scan.root.length) || "/";
}

/** Big folders nothing inside changed for 60 days, outermost only. */
function staleFolders(scan: Scan, ctx: Context): Entry[] {
  const out: Entry[] = [];
  const walk = (node: ScanNode, path: string) => {
    for (const child of kids(node)) {
      if (child.t) continue;
      const at = joinPath(path, child.n);
      if (child.s < 500e6 || !child.m || ctx.now - child.m <= 60 * DAY)
        walk(child, at);
      else
        out.push({
          path: at,
          size: child.s,
          frees: child.u,
          modified: child.m,
          folder: true,
          deletable: !isProtected(at, ctx),
        });
    }
  };
  walk(scan.tree, "/");
  return bySize(out).slice(0, 100);
}

/** macOS apps: the .app bundles in /Applications and ~/Applications. */
function macApps(scan: Scan, ctx: Context) {
  return ["/Applications", `${ctx.home}/Applications`].flatMap((dir) =>
    kidsAt(scan.tree, dir)
      .filter((child) => !child.t && child.n.endsWith(".app"))
      .map((child) =>
        item(
          joinPath(dir, child.n),
          child,
          child.n.slice(0, -4),
          `updated ${ago(child.m, ctx.now)}`,
          ctx,
        ),
      ),
  );
}

/**
 * Linux and Windows apps: the folders of the places apps install to. They
 * only show; an app goes through its package manager or uninstaller.
 */
function otherApps(scan: Scan, ctx: Context) {
  const H = ctx.home;
  const fix = fixer(ctx);
  const dirs =
    osOf(ctx) === "linux"
      ? ["/opt", "/snap", "/var/lib/flatpak/app", `${H}/.local/share/flatpak/app`]
      : [
          "/Program Files",
          "/Program Files (x86)",
          `${H}/AppData/Local/Programs`,
          `${H}/scoop/apps`,
        ].map(fix);
  const skip = new Set([
    "bin",
    "README",
    "Common Files",
    "WindowsApps",
    "Windows Defender",
    "Windows NT",
  ]);
  return dirs.flatMap((dir) =>
    kidsAt(scan.tree, dir)
      .filter((child) => !child.t && !skip.has(child.n) && child.s > 1e6)
      .map((child) => ({
        ...item(
          joinPath(dir, child.n),
          child,
          child.n,
          `updated ${ago(child.m, ctx.now)}`,
          ctx,
        ),
        deletable: false,
      })),
  );
}

export function snapshot(
  scan: Scan | null,
  ctx: Context,
  status: { scanning: boolean; error: string | null; fullDiskAccess: boolean },
): Snapshot {
  const os = osOf(ctx);
  const base = {
    ...status,
    platform: os,
    home: ctx.home,
    rootLabel: rootLabel(ctx),
    drive: os === "win32" ? (ctx.drive ?? "C:") : null,
    total: ctx.disk.total,
    free: ctx.disk.free,
  };
  if (!scan) {
    const bb = { archived: [], worktrees: [], live: [], agents: [] };
    return {
      ...base,
      scannedAt: null,
      groups: [],
      trash: null,
      bb,
      dev: [],
      apps: [],
      files: [],
      system: [],
      types: [],
      largest: [],
      stale: [],
    };
  }
  const t = totals(scan.tree);
  const trashNode = find(scan.tree, paths(ctx).trash);
  const trash = trashNode && !trashNode.x ? trashNode.s : null;
  // Against the disk as it was at scan time, so later writes and deletes don't count.
  const unreadable = Math.max(0, (scan.used ?? ctx.disk.used) - scan.tree.s);
  const bytes = {
    ...t,
    trash: trash ?? 0,
    system: t.system + sum(ctx.disk.volumes, (v) => v.bytes) + unreadable,
  };
  const apps = os === "darwin" ? macApps(scan, ctx) : otherApps(scan, ctx);
  const files = kidsAt(scan.tree, ctx.home).flatMap((child) => {
    const own = totals(child).files;
    return own > 50e6
      ? [
          item(
            joinPath(ctx.home, child.n),
            child,
            `~/${child.n}`,
            `changed ${ago(child.m, ctx.now)}`,
            ctx,
            own,
          ),
        ]
      : [];
  });
  const system =
    os === "darwin"
      ? [
          ...ctx.disk.volumes.map((v) => fixed(v.label, v.bytes)),
          fixed(
            "Not readable",
            unreadable,
            scan.fullDiskAccess
              ? "Spotlight index, system databases; only macOS reads them"
              : "Mail, Photos, browser profiles; needs Full Disk Access",
          ),
          fixed("macOS files on the data volume", t.system),
        ]
      : os === "linux"
        ? [
            fixed(
              "Not readable",
              unreadable,
              "Folders only root reads, such as /root and /var/lib/docker",
            ),
            fixed("Linux system files", t.system),
          ]
        : [
            fixed(
              "Not readable",
              unreadable,
              "Page file, System Volume Information, other users; only Windows reads them",
            ),
            fixed("Windows files", t.system),
          ];
  return {
    ...base,
    scannedAt: scan.scannedAt,
    groups: GROUPS.map(([id, label]) => ({ id, label, bytes: bytes[id] })),
    trash,
    bb: bbItems(scan, ctx),
    dev: devCaches(scan, ctx),
    apps: bySize(apps),
    files: bySize(files),
    system: bySize(system.filter((s) => s.size > 0)),
    types: fileTypes(scan),
    largest: scan.topFiles
      .slice(0, 200)
      .flatMap(([, size, frees, raw, modified]) => {
        const path = displayPath(scan, raw);
        // A file the scanner folded away can't be found to delete.
        return find(scan.tree, path)
          ? [
              {
                path,
                size,
                frees,
                modified,
                folder: false,
                deletable: !isProtected(path, ctx),
              },
            ]
          : [];
      }),
    stale: staleFolders(scan, ctx),
  };
}

/** A folder for the explorer: three levels, the biggest children first. */
export function folder(scan: Scan, path: string, ctx: Context): Node | null {
  const node = find(scan.tree, path);
  if (!node) return null;
  const p = paths(ctx);
  const compact = (
    n: ScanNode,
    at: string,
    depth: number,
    parent: string,
  ): Node => {
    const group = n.g ?? "system";
    const list: Node[] = [];
    if (!n.t && depth > 0) {
      // Deletions shrink children in place, so sort again before folding.
      const sorted = [...kids(n)].sort((a, b) => b.s - a.s);
      const keep = sorted.filter((c, i) => i < 60 && c.s >= n.s * 0.002);
      const rest = sorted.slice(keep.length);
      list.push(
        ...keep.map((c) => compact(c, joinPath(at, c.n), depth - 1, at)),
      );
      const folded = [
        sum(rest, (c) => c.s) + (n.o?.[0] ?? 0),
        sum(rest, (c) => c.u) + (n.o?.[1] ?? 0),
        sum(rest, (c) => c.f) + (n.o?.[3] ?? 0),
      ];
      const newest = Math.max(0, ...rest.map((c) => c.m));
      if (folded[0] > 0)
        list.push([
          `${folded[2].toLocaleString("en-US")} smaller items`,
          folded[0],
          folded[1],
          newest,
          group,
          0,
          FOLDED | PROTECTED,
        ]);
    }
    const out: Node = [
      n.n || rootLabel(ctx),
      n.s,
      n.u,
      n.m,
      group,
      n.t ? 0 : list,
      isProtected(at, ctx) ? PROTECTED : 0,
    ];
    const owner =
      parent === p.threadStorage || parent === p.worktrees
        ? threadOf(n.n, ctx)
        : null;
    if (owner?.info)
      out.push(`${owner.info.title} · ${threadMeta(owner.info, ctx)}`);
    return out;
  };
  return compact(node, path, 3, path.split("/").slice(0, -1).join("/") || "/");
}

/** Drop a deleted path from the tree and take its bytes off every parent. */
export function removeFromTree(scan: Scan, path: string) {
  const nodes = chain(scan.tree, path);
  if (!nodes || nodes.length < 2) return;
  const gone = nodes.pop()!;
  const parent = nodes[nodes.length - 1];
  scan.topFiles = scan.topFiles.filter(([, , , raw]) => {
    const at = displayPath(scan, raw);
    return at !== path && !at.startsWith(`${path}/`);
  });
  parent.k = kids(parent).filter((c) => c !== gone);
  subtract(nodes, [gone.s, gone.u, gone.a, gone.f]);
}

/** Forget the small files folded into a folder after they were deleted. */
export function clearFolded(scan: Scan, path: string) {
  const nodes = chain(scan.tree, path);
  const node = nodes?.[nodes.length - 1];
  if (!nodes || !node?.o) return;
  const folded = node.o;
  delete node.o;
  subtract(nodes, folded);
}

function subtract(nodes: ScanNode[], [s, u, a, f]: number[]) {
  for (const n of nodes) {
    n.s -= s;
    n.u -= u;
    n.a -= a;
    n.f -= f;
  }
}
