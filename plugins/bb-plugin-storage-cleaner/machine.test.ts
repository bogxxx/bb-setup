// The host side on Linux, against real files: a scan seeded on disk, then the
// snapshot, folder, delete and clean calls the server makes.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ThreadRow } from "./contract";
import { bbDataOf, createMachine, driveOf, linuxMounts, type Known } from "./machine";
import type { Scan, ScanNode } from "./model";

describe("machine paths", () => {
  it("finds BB's data folder from a plugin's host data", () => {
    expect(bbDataOf("/home/me/.bb-machines/bb.example/plugins/storage-cleaner/host-data")).toBe(
      "/home/me/.bb-machines/bb.example",
    );
    expect(bbDataOf("C:\\Users\\me\\.bb\\plugins\\storage-cleaner\\host-data")).toBe(
      "C:\\Users\\me\\.bb",
    );
    expect(bbDataOf("/somewhere/else")).toBeNull();
  });

  it("reads the drive letter of a Windows path", () => {
    expect(driveOf("d:\\Users\\me")).toBe("D:");
    expect(driveOf("/home/me")).toBe("C:");
  });

  it("scans local disks, not images, boot partitions or containers", () => {
    const mounts = [
      "/dev/mapper/root / xfs rw 0 0",
      "/dev/sda2 /boot xfs rw 0 0",
      "/dev/sda1 /boot/efi vfat rw 0 0",
      "/dev/mapper/oled /var/oled xfs rw 0 0",
      "/dev/loop0 /snap/core/1 squashfs ro 0 0",
      "/dev/sdb1 /mnt/my\\040disk ext4 rw 0 0",
      "proc /proc proc rw 0 0",
      "overlay /var/lib/docker/overlay2/x/merged overlay rw 0 0",
      "dropbox: /home/me/vault fuse.rclone rw 0 0",
    ].join("\n");
    expect(linuxMounts(mounts)).toEqual(["/", "/var/oled", "/mnt/my disk"]);
  });
});

describe("a Linux machine", () => {
  const NOW = Math.floor(Date.now() / 1000);
  let root: string;
  let home: string;
  let bbData: string;
  let dataDir: string;
  const signals: string[] = [];

  /** Writes files and returns the scan tree the scanner would. */
  function build(files: Record<string, number>): Scan {
    const tree: ScanNode = { n: "", s: 0, u: 0, a: 0, f: 0, m: NOW, k: [] };
    for (const [path, size] of Object.entries(files)) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, "x");
      let node = tree;
      const parts = path.split("/").filter(Boolean);
      parts.forEach((name, i) => {
        node.s += size;
        node.u += size;
        node.a += size;
        node.f += 1;
        const last = i === parts.length - 1;
        let next = node.k!.find((c) => c.n === name);
        if (!next) {
          next = last
            ? { n: name, s: 0, u: 0, a: 0, f: 0, m: NOW, t: 1 }
            : { n: name, s: 0, u: 0, a: 0, f: 0, m: NOW, k: [] };
          node.k!.push(next);
        }
        node = next;
      });
      node.s = node.u = node.a = size;
      node.f = 1;
    }
    return { root: "/", scannedAt: NOW, tree, exts: {}, topFiles: [], used: tree.s, fullDiskAccess: true };
  }

  const threads: ThreadRow[] = [
    ["thr_live", "Live", "p", null],
    ["thr_old", "Old", "p", (NOW - 10 * 86400) * 1000],
  ];
  const known: Known = { threads, inUse: [] };
  const lease = () => ({ dispose: async () => undefined });

  function machine() {
    return createMachine({
      platform: "linux",
      home,
      bbData,
      dataDir,
      tempDir: join(root, "tmp"),
      env: process.env,
      emit: (reason) => signals.push(reason),
      log: () => undefined,
    });
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "storage-machine-"));
    home = join(root, "home");
    bbData = join(home, ".bb-machines", "bb.example");
    dataDir = join(bbData, "plugins", "storage-cleaner", "host-data");
    signals.length = 0;
    const scan = build({
      [join(home, ".cache/pip/http/wheel")]: 3e9,
      [join(home, ".local/share/Trash/files/old.iso")]: 4e9,
      [join(home, ".local/share/Trash/info/old.iso.trashinfo")]: 1e3,
      [join(bbData, "thread-storage/thr_old/log")]: 1e9,
      [join(bbData, "thread-storage/thr_live/log")]: 2e9,
      [join(bbData, "thread-storage/thr_gone/log")]: 5e8,
      [join(bbData, "thread-storage/thr_unsure/log")]: 6e8,
      [join(home, "Projects/app/src/main.ts")]: 2e6,
    });
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, "scan.json.gz"), gzipSync(JSON.stringify(scan)));
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("shows the seeded scan, grouped, with BB's threads", async () => {
    const shot = await machine().snapshot(known, lease);
    expect(shot.platform).toBe("linux");
    expect(shot.home).toBe(home);
    const bytes = Object.fromEntries(shot.groups.map((g) => [g.id, g.bytes]));
    expect(bytes.dev).toBe(3e9);
    expect(bytes.trash).toBe(4e9 + 1e3);
    expect(bytes.bb).toBe(1e9 + 2e9 + 5e8 + 6e8);
    expect(shot.bb.live.map((i) => i.name)).toEqual(["Live"]);
    expect(shot.bb.archived.map((i) => i.name).sort()).toEqual(["Old", "thr_gone", "thr_unsure"]);
    const folder = await machine().folder(known, home);
    expect(folder?.node[0]).toBe("home");
  });

  it("deletes a scanned path and keeps a protected one", async () => {
    const m = machine();
    const wheel = join(home, ".cache/pip/http/wheel");
    const outcome = await m.delete(known, [wheel, join(home, ".cache"), "/etc/passwd"]);
    expect(existsSync(wheel)).toBe(false);
    expect(outcome.freed).toBe(3e9);
    expect(outcome.failed).toEqual(["/etc/passwd"]);
    // ~/.cache is not protected, so it goes too; /etc/passwd isn't in the scan.
    expect(existsSync(join(home, ".cache"))).toBe(false);
    expect(signals).toContain("cleaned");
    const shot = await m.snapshot(known, lease);
    expect(shot.groups.find((g) => g.id === "dev")?.bytes).toBe(0);
  });

  it("empties the Trash's files and info, and keeps those folders", async () => {
    const outcome = await machine().clean(known, {
      target: "trash",
      gone: [],
      bbThreads: false,
      bbWorktrees: false,
      staleDays: null,
    });
    const trash = join(home, ".local/share/Trash");
    expect(readdirSync(join(trash, "files"))).toEqual([]);
    expect(readdirSync(join(trash, "info"))).toEqual([]);
    expect(outcome.freed).toBe(4e9 + 1e3);
  });

  it("cleans archived threads and the ones BB reported gone, nothing else", async () => {
    const m = machine();
    expect((await m.bbThreadIds()).ids.sort()).toEqual([
      "thr_gone",
      "thr_live",
      "thr_old",
      "thr_unsure",
    ]);
    await m.clean(known, {
      target: "bb",
      gone: ["thr_gone"],
      bbThreads: true,
      bbWorktrees: true,
      staleDays: null,
    });
    const storage = join(bbData, "thread-storage");
    expect(readdirSync(storage).sort()).toEqual(["thr_live", "thr_unsure"]);
  });
});
