# Changelog

Newest version first. Versions up to 0.1.1 are Yurii Rebryk's, from
[rebryk/bb-plugins](https://github.com/rebryk/bb-plugins/tree/main/storage-cleaner);
0.2.0 on are this copy's.

## 0.2.0 (2026-11-24)

- Every BB machine: the page has a button per machine, and each one scans and
  cleans its own disk through a host entry. BB passes it the threads it knows,
  and a folder of a thread BB no longer lists goes only after BB reports the
  thread not found. The nightly scan and cleanups run on every connected
  machine.
- Linux: a Node scanner that covers every local disk, Linux's caches and
  system folders, the freedesktop.org Trash, and apps in /opt, snaps, and
  Flatpak.
- Windows: the same scanner on the system drive, the caches in AppData, crash
  dumps, the Recycle Bin through PowerShell, apps in Program Files, and paths
  matched without case. Deletion keeps Windows' folders, NTUSER.DAT, AppData's
  Microsoft folders, OneDrive's top folders, and keys.
- ~/.bb-machines, where BB keeps its data on enrolled machines, counts as BB &
  agents and can only lose thread storage and worktrees, on macOS too. BB data
  of another connection there, such as an older enrollment, is listed with its
  size and never cleaned.
- ~/.copilot, ~/.cursor and ~/.gemini count as agent data on every OS.

## 0.1.1 (2026-10-13)

- Without Full Disk Access, a notice asks for it, and **Open System Settings**
  opens the Full Disk Access list in System Settings. Once BB has access,
  Storage Cleaner scans again on its own, so Mail, Photos, Messages, the Trash,
  and browser profiles get their sizes.

## 0.1.0 (2026-10-12)

- First release: **Settings → Storage Cleaner** shows the free space, the disk
  split into categories, and an explorer with a treemap, and cleans the storage
  of archived threads, leftover worktrees, dev caches, and the Trash, by hand
  or every night after a scan at 00:00 UTC.
