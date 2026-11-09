# bb-plugin-role-picker

A BB plugin that keeps a todo list. It shows every surface a plugin can own:

- `server.ts` — the backend: a todo store in `bb.storage.kv`, RPC methods
  for the page, a `bb role-picker` CLI command, a setting, and a realtime signal
  that keeps every open page current.
- `app.tsx` — the frontend: an **Example todos** page in the left sidebar
  (`app.slots.navPanel`) built from the vendored components.
- `skills/example-todos/SKILL.md` — a skill that tells agents how to keep the list
  with `bb role-picker`. BB imports it into agent threads automatically.
- `PLUGIN_OVERVIEW.md` — the store listing text: a longer version of
  `bb.description` that the plugin detail page shows under it. See
  [Store listing](#store-listing).

Try it: install the plugin, open **Example todos** in the sidebar, then run
`bb role-picker add "Ship it"` in a terminal. The page updates at once.

## Spawn from the terminal: `bb plugin run role-picker spawn`

Where the `spawn` tool is not loaded (GitHub Copilot), `bb plugin run role-picker spawn <explore|contribute|plan|review> --assignment-file <path> [--worker <thr_id>]` spawns the same agent. Write the assignment to a file first with a quoted heredoc (bash) or a single-quoted here-string (PowerShell), so the text needs no shell quoting:

```bash
cat > "$BB_THREAD_STORAGE/plan-a.md" <<'EOF'
Plan the change. Findings: ...
EOF
bb plugin run role-picker spawn plan --assignment-file "$BB_THREAD_STORAGE/plan-a.md"
```

`--assignment <text>` takes one line. Do not use `--assignment "$(cat <<'EOF' ...)"`: bash 3.2 breaks on apostrophes in the text.

## Ask the user: `bb roles ask`

`bb roles ask` (also `bb plugin run role-picker ask`) opens a question card in
the calling thread and blocks until the user answers, cancels, or 30 minutes
pass. It exists for GitHub Copilot, which has no question tool in bb: it does
not load BB plugin tools such as `AskUserQuestion`, and its own `ask_user` is
not offered over ACP. Input is the `AskUserQuestion` schema as one line of JSON
piped on stdin (`--questions-stdin`; the bb CLI passes it as `--questions`, so
no shell quoting touches it), inline (`--questions '<json>'`), or a file on the
thread's machine (`--questions-file <path>`). Agents use stdin: a quoted heredoc
in bash, a single-quoted here-string in PowerShell:

```bash
bb plugin run role-picker ask --questions-stdin <<'EOF'
{"questions":[{"question":"Which database?","header":"Database","options":[{"label":"Postgres","description":"Already in the stack"},{"label":"SQLite","description":"No server"}]}]}
EOF
```

```powershell
@'
{"questions":[{"question":"Which database?","header":"Database","options":[{"label":"Postgres","description":"Already in the stack"},{"label":"SQLite","description":"No server"}]}]}
'@ | bb plugin run role-picker ask --questions-stdin
```

It prints `{"answers":[{"question","header","selected":[...],"freeText"?}]}`
and exits 0; exits 1 on invalid input (every problem on stderr) or outside a bb
thread; exits 2 when there is no answer (the card was dismissed, timed out, or could not be shown). The backend is the
`ask` command in `server.ts` (pure parts in `lib/ask.ts`); the card is the
`ask` `pendingInteraction` in `app.tsx`, which renders the vendored
`@bb/question-form` component (`components/ui/question-form*.ts*`).

## UI components

`components/ui/` is vendored source you own (the shadcn model): edit the
files freely — they never update out from under you. Add more from the BB
component registry (the full shadcn set, version-matched to your BB install
via the pinned ref in `components.json`):

```
npx shadcn add @bb/select @bb/table
```

Run `npm install` once before `bb plugin build` — the vendored components'
npm deps bundle into your dist. React, and BB-shimmed packages like the
radix portal primitives and `sonner` (`import { toast } from "sonner"`
reaches BB's own toaster), are provided by the BB app at runtime and never
bundled. Every shimmed package is declared in `devDependencies` at the
host's version so those imports typecheck; keep them there (never in
`dependencies`, which would bundle a second copy), and `bb plugin types`
repins declared packages alongside the SDK; unused packages may be removed. Ship `dist/` (npm tarball or committed for
git installs) so people installing your plugin never need npm.

## Manifest

`package.json` is the plugin manifest. Notable fields:

- `bb.server` — backend entry (required).
- `bb.app` — frontend entry. Delete it, `app.tsx`, `components/`,
  `hooks/`, and `lib/` for a headless plugin.
- `bb.skills` — skill roots; omitted here, so BB reads `skills/`. Each
  directory with a `SKILL.md` is one skill, named after the directory.
- `bb.name` and `bb.description` — required human-facing identity.
- `bb.branding` — required; declare `icon` as a BB icon name or a
  plugin-relative compact SVG, or declare `logo.light` (with optional
  `logo.dark`). Logo assets must be relative `.svg`, `.png`, or
  `.webp` files.
- `engines.bb` — supported bb app version range.
- `engines.bbPluginSdk` — the lowest plugin SDK you need (scaffold:
  `>=0.6.104`). BB reads this as a floor, not a ceiling: a later
  SDK in the same major still loads your plugin.
- `dependencies` — every package your source imports that BB does not provide.
  `bb plugin build` inlines them into `dist/`, and git installs resolve this
  list alone, so a build-required package here rather than in
  `devDependencies` is what keeps your plugin installable. `devDependencies`
  is for types and tooling only (BB shims React, the portal primitives, and
  `@get-bb/plugin-sdk` at runtime — never bundle them).

Run `bb plugin build` before publishing git/npm installs. It writes
`dist/server.js` + `server.meta.json` and `app.js` / `app.css` /
`app.meta.json`. Each `*.meta.json` stamps SDK major/version,
`artifactFormatVersion`, `pluginId`, `pluginVersion`, and
`builtWith` so managed installs can verify the artifacts. `app.meta.json`
also lists `runtimeSlots`, the shimmed host modules the bundle imports.

## Store listing

Two texts describe the plugin in the store. `bb.description` in package.json
is the one-sentence hook on every browse card and the lead paragraph on the
detail page; keep it under about 140 characters. `PLUGIN_OVERVIEW.md` is the
same claim at length, shown in an Overview section under that paragraph.
Rewrite the scaffold's copy for your plugin, and update it whenever
`bb.description` changes, so the two never disagree.

The submission to the public BB Community marketplace requires the file. Keep
it under 4000 characters (aim for 700 to 1800) and use headings, paragraphs,
emphasis, code, blockquotes, lists, thematic breaks, and absolute https links
only — raw HTML, images, tables, footnotes, and task lists are rejected. Do
not open with a `#` title or repeat `bb.description` verbatim; the page
shows both directly above.

## Install

From this directory (`bb plugin new` already ran the install; a fresh clone
needs it):

```
npm install
bb plugin install .
```

After editing sources, reload:

```
bb plugin reload role-picker
```

Or let `bb plugin dev` rebuild and reload on every save.

## Configure

```
bb plugin config role-picker
bb plugin config role-picker set showDone false
bb plugin reload role-picker
```

## Types & API reference

The plugin API ships as the npm package `@get-bb/plugin-sdk`, pinned to an
exact version in `devDependencies` (`0.6.104` — the SDK of the BB
that scaffolded this plugin). After `npm install`, the full surface is on disk
at:

```
node_modules/@get-bb/plugin-sdk/bundled-types/bb-plugin-sdk.d.ts      # backend
node_modules/@get-bb/plugin-sdk/bundled-types/bb-plugin-sdk-app.d.ts  # frontend
```

Your editor and `tsc` resolve `@get-bb/plugin-sdk` there through ordinary node
resolution — no path mapping. These are readable declarations: open them for an
exact signature.

The SDK surface grows with every BB release, so the pin has to track the BB you
actually run:

```
bb plugin types          # sync this plugin's SDK surface to the running BB
bb plugin types --check  # CI: fail when it does not match
```

Ask BB to write plugins for you: the `bb-plugin-authoring` skill documents
the whole surface with examples.

Confused by the API, or need something the types don't explain? Clone the BB
repo and read the source: <https://github.com/get-bb/bb>.
