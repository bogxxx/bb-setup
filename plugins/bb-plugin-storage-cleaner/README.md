# Storage Cleaner

Storage Cleaner shows what fills the disk of each of your BB machines, Mac,
Linux, or Windows, and cleans what BB and your tools leave behind: the storage
of archived threads, worktrees no thread uses anymore, developer caches, and
the Trash. It lives on its page in **Settings → Storage Cleaner**, and the
same view can sit in BB's sidebar.

This is a copy of [Yurii Rebryk's Storage Cleaner](https://github.com/rebryk/bb-plugins/tree/main/storage-cleaner),
which scans the Mac the BB server runs on, made to scan every machine and to
work on Linux and Windows too. Its macOS behavior is unchanged.

```text
[● oracle server] [● MacBook] [● Old AkerBP VM] [○ predator]

Configuration
Nightly scan                                                        [on]
Clean stale archived threads                                       [off]

Storage
31.5 GB free of 494.4 GB                                        [Rescan]
[■■■■■■■■ BB ■■■■■■ Dev ■ Apps ■■■■ Your files ■■■ System ░░░ free ]
Give BB Full Disk Access to see everything        [Open System Settings]

> ● BB & agents  Clean: archived threads, leftover worktrees  175 GB [Clean]
> ● Dev caches   Clean: DerivedData, caches, builds, logs     128 GB [Clean]
  ● Trash        Clean: everything in the Trash                  —  [Clean]
> ● Apps         14 apps                                       26 GB
> ● Your files   Projects, scratch, documents                  75 GB
> ● System       macOS, swap, unreadable folders               56 GB

↑ … / .bb / thread-storage / thr_tnnpv2qb9b                  25.1 GB
[ treemap of the folder ]
Contents · Largest files · File types · Stale
[ ] Name                                         Modified       Size
[ ] fast-full4-88-batch10k-lr3e4-cos75            today        8.2 GB
```

## Use

Open **Settings → Storage Cleaner**. To keep it in the sidebar, choose
**More → Customize rail** and check **Storage**.

- **Pick a machine.** The buttons at the top are BB's machines: the server's
  own first, then every machine you enrolled. The page remembers the last one
  you picked. A machine that is offline says so; its last scan shows again
  when it connects.

- **Scan.** **Rescan** measures the disk again; it takes a few minutes.
  **Nightly scan** does it every day at 00:00 UTC.
- **See where space goes.** The bar splits the disk into BB & agents, Dev
  caches, Apps, Trash, Your files, System, and free space; hovering a part
  shows its size. Each category row unfolds into its biggest items, five at
  first, and **Show all** lets the list scroll on.
- **See everything.** Without Full Disk Access, macOS keeps Mail, Photos,
  Messages, the Trash, and browser profiles from the scan, and a notice under
  the bar asks for it. **Open System Settings** opens the Full Disk Access list
  on the Mac BB runs on: turn on **bb**, then reopen BB. Storage Cleaner then
  scans again on its own.
- **Clean a category.** Every **Clean** asks first and lists what it deletes:
  - **BB & agents**: the storage of every archived or deleted thread, every
    worktree whose thread is archived or deleted, uncommitted changes
    included, and Claude Code worktrees idle for 3 days with no uncommitted
    changes. Live threads, worktrees a live thread works in, and agent data
    stay.
  - **Dev caches**: what is inside Xcode DerivedData, `~/Library/Logs`, and the
    package caches of uv, npm, pnpm, Yarn, Bun, pip, Cargo, Go, Gradle,
    SwiftPM, CocoaPods, Playwright, Puppeteer, and Homebrew, plus build folders
    such as `build`, `.next`, and `__pycache__` that git ignores. Hugging Face
    models, simulators, `node_modules`, and `.venv` folders stay.
  - **Trash**: everything in the Trash.
- **Explore.** The treemap shows the current folder; hover a tile for its size
  and click a folder to open it. The path above it keeps its end and folds the
  start into "…". Below, **Contents**, **Largest files**, **File types**, and
  **Stale** (folders over 500 MB unchanged for 60 days) list files and folders
  with when they changed and their size.
- **Delete.** Check rows and click **Delete**, or use a row's trash button.
  Deleting is permanent. Top-level and system folders, your home folder's own
  folders, iCloud Drive and other synced folders, keychains, and BB's data other
  than thread storage and worktrees can't be deleted.
- **Clean every night.** At 00:00 UTC,
  **Clean stale archived threads** deletes the storage of threads archived 7
  or more days ago, **Clean leftover worktrees** the worktrees whose thread is
  archived or deleted, **Clean stale dev caches** what nothing touched for 7
  days, and **Clean Trash** the Trash. All start off. Each scans first, even
  with **Nightly scan** off, and none runs when that scan fails.

Sizes count APFS clones and hard links once: a file cloned into three places
counts a third in each. A row's delete says how much it frees for sure, the
part no other file shares.

## How it works

- The plugin has a host entry, which BB runs on every machine. The server
  lists BB's persistent machines and routes each call of the page to the one
  it shows, with BB's threads: which are live, which archived and when, and
  which workspaces live threads use. The machine keeps its latest scan,
  gzipped, in its own plugin data folder, and answers with the page's
  categories and folders. A scan runs in the background and tells the server
  when it starts and ends, so the page reads the machine again.
- On a Mac, the machine runs a scanner with `python3` at low priority. It lists each
  folder with one `getattrlistbulk(2)` call, which also returns each file's
  private size and clone count, and splits the tree across one process per
  CPU. It skips other volumes and folders macOS doesn't let BB read.
- On Linux and Windows, the machine runs a Node scanner, with the Node that
  runs BB, at low priority. It writes the same tree. On Linux it enters every
  file system mounted from a local disk, so a separate `/var` or `/home`
  counts, and skips images, boot partitions, containers, and network mounts.
  On Windows it scans the system drive, and every path is spelled from it:
  `C:\Users\me` is `/Users/me` to the page, and the page shows it the
  Windows way again. Windows paths match without case.
- Deleting through the page updates the machine's scan, so sizes change at
  once without a rescan.
- BB & agents reads BB's threads through `bb.sdk.threads`, and each machine
  finds BB's data folder on it from its own plugin data folder,
  `<data>/plugins/storage-cleaner/host-data`. Before a clean, the server asks
  the machine for the thread ids of its thread storage and worktree folders.
  A folder whose thread is missing from BB's list is deleted only after
  `bb.sdk.threads.get` reports the thread not found. A worktree folder stays while any live thread's workspace is inside
  it, and for an hour after its thread is archived, while BB removes it
  itself. Removing a worktree runs `git worktree remove` for it. Claude Code
  worktrees in a project's `.claude/worktrees` count as leftover after 3 idle
  days and go only without uncommitted changes.
- Build folders go only inside a project's git repository, not one at the home
  folder, and only when `git check-ignore` says git ignores them.
- BB has Full Disk Access when it can open macOS's privacy database,
  `/Library/Application Support/com.apple.TCC/TCC.db`. The page checks this
  each time it loads. When BB first has access after a scan made without
  access, Storage Cleaner scans again.
- On a Mac, the Trash is emptied directly when BB has Full Disk Access, and
  through Finder otherwise. On Linux, what is in the Trash's `files`, `info`
  and `expunged` folders goes, and the folders stay. On Windows,
  `Clear-RecycleBin` empties the user's Recycle Bin on every drive. System counts what macOS keeps from the scan as not
  readable. With Full Disk Access, only folders macOS keeps to itself, such as
  the Spotlight index, stay unread.
- A schedule wakes every hour and does the nightly work in the hour that starts
  at 00:00 UTC, on every connected machine at once.
- The page is a `settingsSection` slot on the plugin's settings page and a
  `navPanel` page, both the same view. A BB update may move thread storage or
  worktrees within BB's data folder, or change these slots.

## Install

Needs BB 0.50.0 or later. Every machine needs nothing more on Linux and
Windows; a Mac needs `python3`, which the Xcode Command Line Tools provide,
and Full Disk Access for BB in System Settings → Privacy & Security so the
scan sees everything. **Open System Settings** on the page opens that list on
the Mac.

```sh
bb plugin install ~/src/bb-setup/plugins/bb-plugin-storage-cleaner
```

## Limits

- Windows: only the system drive is scanned. Node can't read a file's
  allocated size on Windows, so sizes there are file lengths: compressed
  files count at their full length, and OneDrive files that are only online
  count as if downloaded.
- Linux: folders only root can read count as Not readable.
- The cleanup settings apply to every machine.

## Development

```sh
npm ci
npm test
npm run typecheck
npm run build
bb plugin reload storage-cleaner
```

## Credits

Storage Cleaner is by [Yurii Rebryk](https://github.com/rebryk), one of the
[San Francisco Plugins](https://github.com/rebryk/bb-plugins). This copy adds
machines other than the server, Linux, and Windows.
