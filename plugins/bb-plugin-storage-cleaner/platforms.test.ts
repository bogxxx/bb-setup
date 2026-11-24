// Linux and Windows: the model's rules, and the paths between the scan and
// the OS. macOS keeps its own tests in model.test.ts.
import { describe, expect, it } from "vitest";
import {
  assignGroups,
  bbItems,
  cacheFolders,
  folder,
  isProtected,
  matchCase,
  snapshot,
  type Context,
  type Scan,
  type ScanNode,
} from "./model";
import { pathMap } from "./platform";
import { nativePath } from "./shared";

const NOW = 1_800_000_000;

function dir(n: string, k: ScanNode[], m = NOW): ScanNode {
  const sum = (key: "s" | "u" | "a" | "f") => k.reduce((t, c) => t + c[key], 0);
  return { n, s: sum("s"), u: sum("u"), a: sum("a"), f: sum("f"), m, k };
}

function file(n: string, s: number, m = NOW): ScanNode {
  return { n, s, u: s, a: s, f: 1, m, t: 1 };
}

const scanOf = (tree: ScanNode): Scan => ({
  root: "/",
  scannedAt: NOW,
  tree,
  exts: {},
  topFiles: [],
  used: tree.s,
  fullDiskAccess: true,
});

describe("path map", () => {
  const win = pathMap("win32", "c:");
  it("spells Windows paths both ways from the system drive", () => {
    expect(win.drive).toBe("C:");
    expect(win.toNative("/")).toBe("C:\\");
    expect(win.toNative("/Users/me/AppData")).toBe("C:\\Users\\me\\AppData");
    expect(win.toScan("C:\\Users\\me\\")).toBe("/Users/me");
    expect(win.toScan("c:/Users/me/repo")).toBe("/Users/me/repo");
    expect(win.toScan("C:")).toBe("/");
  });
  it("leaves other drives and relative paths out", () => {
    expect(win.toScan("D:\\data")).toBeNull();
    expect(win.toScan("Users\\me")).toBeNull();
  });
  it("keeps POSIX paths as they are", () => {
    const linux = pathMap("linux");
    expect(linux.toNative("/home/me")).toBe("/home/me");
    expect(linux.toScan("/home/me/")).toBe("/home/me");
    expect(linux.toScan("C:\\x")).toBeNull();
  });
  it("shows the page a Windows path the way Windows writes it", () => {
    expect(nativePath({ drive: "C:" }, "/Users/me/x.zip")).toBe(
      "C:\\Users\\me\\x.zip",
    );
    expect(nativePath({ drive: null }, "/home/me/x.zip")).toBe("/home/me/x.zip");
  });
});

describe("Linux", () => {
  const H = "/home/me";
  const B = `${H}/.bb-machines/bb.example`;
  const ctx = (threads: Context["threads"] = new Map()): Context => ({
    platform: "linux",
    home: H,
    bbData: B,
    threads,
    disk: { total: 200e9, free: 50e9, used: 150e9, volumes: [] },
    now: NOW,
  });

  it.each([
    "/",
    "/home",
    H,
    "/usr/lib/x86_64-linux-gnu",
    "/etc/nginx/sites",
    "/proc/1/status",
    "/var/lib/docker/overlay2",
    "/var/log/journal/x",
    "/opt/google",
    `${H}/.config/Code`,
    `${H}/.local/share`,
    `${H}/.local/share/keyrings/login.keyring`,
    `${H}/.local/share/Trash/files`,
    `${H}/.ssh/id_ed25519`,
    `${H}/Documents`,
    `${H}/.bb-machines`,
    `${H}/.bb-machines/other.example/thread-storage/thr_a`,
    `${B}/bb.db`,
    `${H}/x/../y`,
  ])("keeps %s", (path) => expect(isProtected(path, ctx())).toBe(true));

  it.each([
    `${H}/.cache/pip/http`,
    `${H}/.config/Code/Cache`,
    `${H}/Projects/app/node_modules`,
    `${H}/.local/share/Trash/files/old.iso`,
    `${B}/thread-storage/thr_a`,
    `${B}/plugins/environment-git-worktree/host-data/worktrees/thr_a-1`,
    "/var/oled/linuxbrew/.linuxbrew/Cellar/node/20.0.0",
    "/tmp/build/x",
    "/opt/google/chrome",
  ])("allows %s", (path) => expect(isProtected(path, ctx())).toBe(false));

  const tree = dir("", [
    dir("home", [
      dir("me", [
        dir(".cache", [
          dir("pip", [file("wheel.whl", 3e9)]),
          dir("huggingface", [file("model.safetensors", 8e9)]),
          dir("chromium", [file("cache.bin", 2e9)]),
        ]),
        dir(".local", [
          dir("share", [
            dir("Trash", [
              dir("files", [file("old.iso", 4e9)]),
              dir("info", [file("old.iso.trashinfo", 1e3)]),
            ]),
            dir("flatpak", [dir("app", [dir("org.gimp.GIMP", [file("g", 5e8)])])]),
          ]),
        ]),
        dir(".bb-machines", [
          dir("bb.example", [
            dir("thread-storage", [dir("thr_old", [file("log", 1e9)])]),
          ]),
          dir("old.example", [
            dir("plugins", [dir("environment-git-worktree", [file("w", 2e9)])]),
          ]),
        ]),
        dir("Projects", [dir("app", [dir("node_modules", [file("x", 7e8)])])]),
      ]),
    ]),
    dir("opt", [dir("google", [file("chrome", 6e8)])]),
    dir("var", [
      dir("oled", [
        dir("linuxbrew", [dir(".linuxbrew", [dir("Cellar", [file("node", 9e8)])])]),
      ]),
    ]),
    dir("usr", [dir("lib", [file("libc.so", 3e9)])]),
  ]);
  const scan = scanOf(tree);
  const threads = new Map([
    ["thr_old", { title: "Old", project: "p", archivedAt: (NOW - 9 * 86400) * 1000 }],
  ]);
  const c = ctx(threads);
  assignGroups(scan, c);
  const shot = snapshot(scan, c, {
    scanning: false,
    error: null,
    fullDiskAccess: true,
  });

  it("puts each folder in its group", () => {
    const bytes = Object.fromEntries(shot.groups.map((g) => [g.id, g.bytes]));
    expect(bytes.dev).toBe(3e9 + 8e9 + 2e9 + 7e8);
    expect(bytes.trash).toBe(4e9 + 1e3);
    expect(bytes.bb).toBe(1e9 + 2e9);
    expect(bytes.apps).toBe(5e8 + 6e8 + 9e8);
    expect(bytes.system).toBe(3e9);
  });

  it("lists the caches Clean empties, and the ones it leaves", () => {
    const dev = Object.fromEntries(shot.dev.map((d) => [d.id, d]));
    expect(dev.packages.size).toBe(3e9);
    expect(dev.packages.inClean).toBe(true);
    expect(dev.huggingface.inClean).toBe(false);
    // App caches: what in ~/.cache no other row claims.
    expect(dev.appCaches.size).toBe(2e9);
    expect(dev.nodeModules.size).toBe(7e8);
  });

  it("lists apps without offering to delete them", () => {
    expect(shot.apps.map((a) => [a.name, a.deletable])).toEqual([
      ["google", false],
      ["org.gimp.GIMP", false],
    ]);
  });

  it("files thread storage under the machine's BB data", () => {
    expect(bbItems(scan, c).archived.map((i) => i.name)).toEqual(["Old"]);
  });

  it("lists another connection's BB data without offering to delete it", () => {
    const other = bbItems(scan, c).agents.find((i) => i.meta === "another BB connection");
    expect(other).toMatchObject({
      name: "~/.bb-machines/old.example",
      size: 2e9,
      deletable: false,
    });
    expect(isProtected(`${H}/.bb-machines/old.example/plugins/environment-git-worktree`, c)).toBe(true);
  });

  it("names the disk and the system rows the Linux way", () => {
    expect(shot.platform).toBe("linux");
    expect(shot.rootLabel).toBe("/");
    expect(shot.drive).toBeNull();
    expect(shot.home).toBe(H);
    expect(shot.system.map((s) => s.name)).toEqual(["Linux system files"]);
    expect(folder(scan, "/", c)?.[0]).toBe("/");
  });
});

describe("Windows", () => {
  const H = "/Users/Me";
  const B = `${H}/.bb-machines/bb.example`;
  // On disk the pip cache is spelled in lower case, unlike the default.
  const tree = dir("", [
    dir("Users", [
      dir("Me", [
        dir("AppData", [
          dir("Local", [
            dir("pip", [dir("cache", [file("wheel.whl", 3e9)])]),
            dir("npm-cache", [dir("_cacache", [file("index", 1e9)])]),
            dir("Temp", [file("setup.tmp", 2e9)]),
            dir("Microsoft", [dir("Credentials", [file("c", 2e6)])]),
            dir("Programs", [dir("Microsoft VS Code", [file("code.exe", 4e8)])]),
            dir("CrashDumps", [file("app.dmp", 6e8)]),
          ]),
        ]),
        dir("OneDrive - Work", [dir("Docs", [file("plan.docx", 5e8)])]),
        dir(".bb-machines", [
          dir("bb.example", [
            dir("plugins", [
              dir("environment-git-worktree", [
                dir("host-data", [
                  dir("worktrees", [dir("thr_gone-1", [file("w", 1e9)])]),
                ]),
              ]),
            ]),
          ]),
        ]),
        dir("src", [dir("app", [dir("node_modules", [file("m", 7e8)])])]),
      ]),
    ]),
    dir("Program Files", [dir("Git", [file("git.exe", 3e8)])]),
    dir("Windows", [file("explorer.exe", 9e9)]),
    dir("$Recycle.Bin", [dir("S-1-5-21-1", [file("$R1.zip", 8e8)])]),
  ]);
  const scan = scanOf(tree);
  const c: Context = {
    platform: "win32",
    drive: "C:",
    fixCase: (path) => matchCase(scan.tree, path),
    home: H,
    bbData: B,
    threads: new Map(),
    disk: { total: 500e9, free: 100e9, used: 400e9, volumes: [] },
    now: NOW,
  };
  assignGroups(scan, c);
  const shot = snapshot(scan, c, {
    scanning: false,
    error: null,
    fullDiskAccess: true,
  });

  it("matches folder names without case", () => {
    expect(matchCase(tree, "/users/me/appdata/local/PIP/Cache")).toBe(
      "/Users/Me/AppData/Local/pip/cache",
    );
    expect(matchCase(tree, "/Users/Me/Nowhere/x")).toBe("/Users/Me/Nowhere/x");
    const packages = cacheFolders(scan, c).find((f) => f.kind.id === "packages");
    expect(packages?.folders.map((f) => f.path)).toEqual([
      "/Users/Me/AppData/Local/pip/cache",
    ]);
  });

  it("puts each folder in its group", () => {
    const bytes = Object.fromEntries(shot.groups.map((g) => [g.id, g.bytes]));
    expect(bytes.dev).toBe(3e9 + 1e9 + 2e9 + 6e8 + 7e8);
    expect(bytes.trash).toBe(8e8);
    expect(bytes.apps).toBe(2e6 + 4e8 + 3e8);
    expect(bytes.files).toBe(5e8);
    expect(bytes.bb).toBe(1e9);
    expect(bytes.system).toBe(9e9);
  });

  it.each([
    "/",
    "/Windows",
    "/Windows/System32/drivers",
    "/Program Files/Git/git.exe",
    "/$Recycle.Bin/S-1-5-21-1/$R1.zip",
    "/pagefile.sys",
    "/Users",
    "/Users/Me",
    "/Users/Public/Documents/x",
    `${H}/AppData`,
    `${H}/AppData/Local`,
    `${H}/appdata/local/temp`,
    `${H}/AppData/Local/Microsoft/Credentials/c`,
    `${H}/AppData/Roaming/Microsoft/Protect/key`,
    `${H}/NTUSER.DAT`,
    `${H}/Documents`,
    `${H}/OneDrive - Work`,
    `${H}/OneDrive - Work/Docs`,
    `${H}/.ssh/id_ed25519`,
    `${B}/bb.db`,
    `${H}/.BB-MACHINES/bb.example/BB.DB`,
  ])("keeps %s", (path) => expect(isProtected(path, c)).toBe(true));

  it.each([
    `${H}/AppData/Local/pip/cache/wheel.whl`,
    `${H}/AppData/Local/Temp/setup.tmp`,
    `${H}/AppData/Local/Programs/Microsoft VS Code`,
    `${H}/OneDrive - Work/Docs/plan.docx`,
    `${H}/src/app/node_modules`,
    `${B}/plugins/environment-git-worktree/host-data/worktrees/thr_gone-1`,
    "/Projects/old",
  ])("allows %s", (path) => expect(isProtected(path, c)).toBe(false));

  it("lists apps from Program Files and AppData's Programs", () => {
    expect(shot.apps.map((a) => [a.name, a.deletable])).toEqual([
      ["Microsoft VS Code", false],
      ["Git", false],
    ]);
  });

  it("names the drive, the Recycle Bin and the system rows the Windows way", () => {
    expect(shot.platform).toBe("win32");
    expect(shot.rootLabel).toBe("C:");
    expect(shot.drive).toBe("C:");
    expect(shot.trash).toBe(8e8);
    expect(shot.system.map((s) => s.name)).toEqual(["Windows files"]);
    expect(shot.dev.find((d) => d.id === "logs")?.label).toBe("Crash dumps");
    expect(bbItems(scan, c).worktrees.map((i) => i.name)).toEqual(["thr_gone-1"]);
  });
});
