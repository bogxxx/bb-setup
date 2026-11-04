#!/usr/bin/env bash
# macOS / Linux counterpart of sync.ps1 (and of the link part of install.ps1).
#
# Links the live folders and files to this repo, exports the plugin list and
# settings when the bb server runs on this machine, then commits and pushes.
# Safe to run again; the first run on a new Mac is the install.
#
#   scripts/sync.sh                    # commit with a default message
#   scripts/sync.sh -m "Add X plugin"  # your message
#   scripts/sync.sh --no-push          # capture and commit only
#   scripts/sync.sh --dry-run          # capture only, show git status
#   scripts/sync.sh --plugins          # force plugin export (default: only if the bb server is local)
#   scripts/sync.sh --no-plugins       # skip plugin export
#
# Git auth: pushes and pulls with the `bogxxx` gh account's token, passed to git
# for that one command. The active gh account is never switched, because the
# Copilot integration in bb depends on it. Override with BB_SETUP_GH_USER.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BB_DIR="$HOME/.bb"
CLAUDE_DIR="$HOME/.claude"
GH_USER="${BB_SETUP_GH_USER:-bogxxx}"

MESSAGE="Sync BB setup"; PUSH=1; DRY=0; PLUGINS=auto
while [ $# -gt 0 ]; do
  case "$1" in
    -m|--message) MESSAGE="$2"; shift 2 ;;
    --no-push) PUSH=0; shift ;;
    --dry-run) DRY=1; shift ;;
    --plugins) PLUGINS=1; shift ;;
    --no-plugins) PLUGINS=0; shift ;;
    -h|--help) sed -n '2,19p' "$0"; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done

# Live path -> repo path. On macOS both folders and files are symlinked, so
# editing either side changes the same file. copilot-acp.cmd is Windows-only.
LINKS=(
  "$BB_DIR/skills/provider-orchestration|$REPO/skills/provider-orchestration"
  "$CLAUDE_DIR/agents|$REPO/claude/agents"
  "$BB_DIR/AGENTS.md|$REPO/bb/AGENTS.md"
  "$CLAUDE_DIR/CLAUDE.md|$REPO/claude/CLAUDE.md"
)

# `bb` on PATH can fail silently when the CLI lost its executable bit; fall back to node.
bb() {
  if [ -n "${BB_CLI:-}" ] && [ -f "$BB_CLI" ] && [ ! -x "$BB_CLI" ]; then node "$BB_CLI" "$@"; else command bb "$@"; fi
}

# Run git with the token of $GH_USER without touching gh's active account.
git_auth() {
  local token
  token="$(gh auth token --user "$GH_USER" 2>/dev/null || true)"
  if [ -z "$token" ]; then git -C "$REPO" "$@"; return; fi
  GIT_SETUP_TOKEN="$token" git -C "$REPO" -c credential.helper= \
    -c 'credential.helper=!f() { echo username=x-access-token; echo "password=$GIT_SETUP_TOKEN"; }; f' "$@"
}

ensure_link() {
  local live="$1" target="$2"
  if [ -L "$live" ] && [ "$(readlink "$live")" = "$target" ]; then return; fi
  if [ -e "$live" ] || [ -L "$live" ]; then
    # Keep local edits: a regular file that is newer than the repo copy wins.
    if [ -f "$live" ] && [ ! -L "$live" ] && [ -f "$target" ] && ! cmp -s "$live" "$target" && [ "$live" -nt "$target" ]; then
      cp "$live" "$target"; echo "  copied $live -> $target"
    fi
    local bak="$live.bak-$(date +%Y%m%d%H%M%S)"
    mv "$live" "$bak"; echo "  moved existing $live to $bak"
  fi
  mkdir -p "$(dirname "$live")"
  ln -s "$target" "$live"; echo "  linked $live -> $target"
}

echo "Pull:"
if [ -z "$(git -C "$REPO" status --porcelain)" ]; then
  git_auth pull -q --rebase && echo "  up to date"
else
  echo "  skipped: working tree has changes"
fi

echo "Links:"
for pair in "${LINKS[@]}"; do ensure_link "${pair%%|*}" "${pair#*|}"; done

if [ "$PLUGINS" = auto ]; then
  # Plugins and settings live on the bb server. Only export them when that server
  # is this machine; otherwise the Windows host owns plugins.json.
  data_dir="$(bb status 2>/dev/null | sed -n 's/^Data dir: //p')"
  case "$data_dir" in /*) PLUGINS=1 ;; *) PLUGINS=0 ;; esac
  [ "$PLUGINS" = 0 ] && echo "Plugins: skipped, bb server is not local (${data_dir:-unknown})"
fi

if [ "$PLUGINS" = 1 ]; then
  echo "Plugins:"
  tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
  bb plugin list --json > "$tmp/plugins.json"
  node -e '
    const fs = require("fs");
    const { plugins } = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const ids = plugins.filter(p => p.hasSettings).map(p => p.id).sort();
    fs.writeFileSync(process.argv[2], ids.map(id => id + "\n").join(""));
  ' "$tmp/plugins.json" "$tmp/settings-ids"
  while read -r id; do
    [ -n "$id" ] && bb plugin config "$id" --json > "$tmp/config-$id.json" < /dev/null
  done < "$tmp/settings-ids"
  node -e '
    const fs = require("fs"), path = require("path"), cp = require("child_process");
    const [tmp, repo, home] = process.argv.slice(1);
    const { plugins } = JSON.parse(fs.readFileSync(path.join(tmp, "plugins.json"), "utf8"));
    const installed = [], builtinsEnabled = {};
    for (const p of [...plugins].sort((a, b) => a.id.localeCompare(b.id))) {
      if (p.source.startsWith("builtin:")) { builtinsEnabled[p.id] = !!p.enabled; continue; }
      const e = { id: p.id, source: p.source, enabled: !!p.enabled };
      if (p.source.startsWith("path:")) {
        const dir = p.source.slice(5);
        if (dir.startsWith(repo + "/")) e.source = "repo:" + dir.slice(repo.length + 1);
        else {
          let origin = "";
          try { origin = cp.execFileSync("git", ["-C", dir, "remote", "get-url", "origin"], { stdio: ["ignore", "pipe", "ignore"] }).toString().trim(); } catch {}
          if (origin) { e.clone = origin; e.path = dir.replace(home, "~"); }
          else console.error(`warning: ${p.id} is a local path outside the repo with no git remote: ${dir}`);
        }
      }
      installed.push(e);
    }
    fs.writeFileSync(path.join(repo, "bb/plugins.json"), JSON.stringify({ installed, builtinsEnabled }, null, 2) + "\n");
    const settings = {};
    for (const p of plugins.filter(p => p.hasSettings).sort((a, b) => a.id.localeCompare(b.id))) {
      const cfg = JSON.parse(fs.readFileSync(path.join(tmp, `config-${p.id}.json`), "utf8"));
      const changed = {};
      for (const [key, schema] of Object.entries(cfg.schema || {})) {
        if (schema.secret) continue;
        const value = (cfg.values || {})[key];
        if (value === null || value === undefined) continue;
        if (schema.default !== undefined && schema.default !== null ? String(value) === String(schema.default) : String(value) === "") continue;
        changed[key] = value;
      }
      if (Object.keys(changed).length) settings[p.id] = changed;
    }
    fs.writeFileSync(path.join(repo, "bb/plugin-settings.json"), JSON.stringify(settings, null, 2) + "\n");
    console.log(`  ${installed.length} installed plugins, ${Object.keys(settings).length} with custom settings`);
  ' "$tmp" "$REPO" "$HOME"
fi

cd "$REPO"
git add -A
if [ "$DRY" = 1 ]; then git status --short; exit 0; fi
if [ -z "$(git status --porcelain)" ]; then echo "No changes."; exit 0; fi
git commit -q -m "$MESSAGE"
echo "Committed: $MESSAGE"
if [ "$PUSH" = 1 ]; then git_auth push -q && echo "Pushed."; fi
