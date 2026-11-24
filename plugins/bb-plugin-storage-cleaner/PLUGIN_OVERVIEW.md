See what fills the disk of each of your BB machines, Mac, Linux, or Windows,
and clean what BB and your tools leave behind.

## Every machine

The page has one button per BB machine: the server's own first, then every
machine you enrolled. Each machine scans and cleans its own disk through the
plugin's host entry, and BB tells it which threads are live, archived, or
gone. A machine that is offline says so and shows again when it connects.

## See where space goes

**Settings → Storage Cleaner** shows the free space and a bar that splits the
disk into BB & agents, Dev caches, Apps, Trash, Your files, System, and free
space. Each category unfolds into its biggest items: archived threads by
title, leftover worktrees, caches, apps, and folders. Below, an explorer shows
the current folder as a treemap, with Contents, Largest files, File types, and
Stale tabs. **Customize rail** can put the same view in the sidebar.

## Clean a category

Every **Clean** asks first and lists what it deletes. BB & agents deletes the
storage of archived threads and the worktrees no live thread uses. Dev caches
empties package caches and git-ignored build folders, plus Xcode DerivedData
and logs on a Mac and crash dumps on Windows. Trash empties the Trash, or the
Recycle Bin on Windows. Any file or folder can also be deleted from the
explorer, except the system's, your home folder's own, synced clouds, keys,
and BB's data other than thread storage and worktrees.

## Every night

A scan runs every day at 00:00 UTC on every connected machine, and switches
turn on cleaning threads archived 7+ days ago, leftover worktrees, dev caches
untouched for 7 days, and the Trash. A scan takes a few minutes.

## Per OS

- **macOS** scans with `python3`, counting APFS clones once, and asks for Full
  Disk Access to see Mail, Photos, and the Trash.
- **Linux** scans every local disk, such as `/` and a separate `/var` or
  `/home`, and empties the freedesktop.org Trash in `~/.local/share/Trash`.
- **Windows** scans the system drive and empties the Recycle Bin with
  PowerShell. Node can't read a file's allocated size there, so sizes are file
  lengths, and OneDrive files that are only online count at full size.

Based on Storage Cleaner by Yurii Rebryk, one of the
[San Francisco Plugins](https://github.com/rebryk/bb-plugins).
