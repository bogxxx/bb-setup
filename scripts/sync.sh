#!/usr/bin/env bash
# macOS / Linux counterpart of sync.ps1 (and of the link part of install.ps1).
#
# Links the live folders and files to this repo, exports the plugin list and
# settings of the bb server the CLI is connected to, then commits and pushes.
# Safe to run again; the first run on a new Mac is the install.
#
#   scripts/sync.sh                    # commit with a default message
#   scripts/sync.sh -m "Add X plugin"  # your message
#   scripts/sync.sh --no-push          # capture and commit only
#   scripts/sync.sh --dry-run          # print the bb/*.json diffs; write nothing to the repo, commit nothing
#   scripts/sync.sh --no-plugins       # skip the plugin export
#
# A bb command that fails or prints nothing stops the script before anything is
# committed, so bb/plugins.json and bb/plugin-settings.json are never written degraded.
#
# Git auth: pushes and pulls with the `bogxxx` gh account's token, passed to git
# for that one command. The active gh account is never switched, because the
# Copilot integration in bb depends on it. Override with BB_SETUP_GH_USER.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BB_DIR="$HOME/.bb"
CLAUDE_DIR="$HOME/.claude"
GH_USER="${BB_SETUP_GH_USER:-bogxxx}"

MESSAGE="Sync BB setup"; PUSH=1; DRY=0; PLUGINS=1
while [ $# -gt 0 ]; do
  case "$1" in
    -m|--message) MESSAGE="$2"; shift 2 ;;
    --no-push) PUSH=0; shift ;;
    --dry-run) DRY=1; shift ;;
    --no-plugins) PLUGINS=0; shift ;;
    -h|--help) sed -n '2,/^set -/p' "$0" | sed '$d'; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done

# Live path -> repo path. On macOS both folders and files are symlinked, so
# editing either side changes the same file. copilot-acp.cmd is Windows-only.
# ~/.local/bin is on the bb daemon's PATH, so the bare "bb" and "copilot-acp"
# resolve there. bb/bin/bb runs a non-executable BB_CLI under node.
LINKS=(
  "$CLAUDE_DIR/agents|$REPO/claude/agents"
  "$BB_DIR/AGENTS.md|$REPO/bb/AGENTS.md"
  "$CLAUDE_DIR/CLAUDE.md|$REPO/claude/CLAUDE.md"
  "$HOME/.local/bin/bb|$REPO/bb/bin/bb"
  "$HOME/.local/bin/copilot-acp|$REPO/bb/bin/copilot-acp"
  "$HOME/.copilot/agents/orchestrator.agent.md|$REPO/copilot/agents/orchestrator.agent.md"
  "$HOME/.copilot/agents/explorer.agent.md|$REPO/copilot/agents/explorer.agent.md"
  "$HOME/.copilot/agents/planner.agent.md|$REPO/copilot/agents/planner.agent.md"
  "$HOME/.copilot/agents/worker.agent.md|$REPO/copilot/agents/worker.agent.md"
  "$HOME/.copilot/agents/reviewer.agent.md|$REPO/copilot/agents/reviewer.agent.md"
  "$HOME/.copilot/agents/interviewer.agent.md|$REPO/copilot/agents/interviewer.agent.md"
  "$HOME/.cursor/agents/cantrip-goal.md|$REPO/cursor/agents/cantrip-goal.md"
  "$HOME/.cursor/agents/cantrip-explore.md|$REPO/cursor/agents/cantrip-explore.md"
  "$HOME/.cursor/agents/cantrip-plan.md|$REPO/cursor/agents/cantrip-plan.md"
  "$HOME/.cursor/agents/cantrip-implement.md|$REPO/cursor/agents/cantrip-implement.md"
  "$HOME/.cursor/agents/cantrip-review.md|$REPO/cursor/agents/cantrip-review.md"
  "$HOME/.cursor/agents/cantrip-interview.md|$REPO/cursor/agents/cantrip-interview.md"
)
# Every skill folder in the repo is linked, so new skills reach every machine.
for d in "$REPO"/skills/*/; do
  [ -f "${d}SKILL.md" ] && LINKS+=("$BB_DIR/skills/$(basename "$d")|${d%/}")
done

# Runs the bb CLI at BB_CLI. bb on PATH can fail silently in agent sandboxes, so a
# BB_CLI entry point that is not executable runs under node.
bb() {
  if [ -n "${BB_CLI:-}" ] && [ -f "$BB_CLI" ]; then
    if [ -x "$BB_CLI" ]; then "$BB_CLI" "$@"; else node "$BB_CLI" "$@"; fi
  else
    command bb "$@"
  fi
}

# Run git with the token of $GH_USER without touching gh's active account.
git_auth() {
  local token
  token="$(gh auth token --user "$GH_USER" 2>/dev/null || true)"
  if [ -z "$token" ]; then git -C "$REPO" "$@"; return; fi
  GIT_SETUP_TOKEN="$token" git -C "$REPO" -c credential.helper= \
    -c 'credential.helper=!f() { echo username=x-access-token; echo "password=$GIT_SETUP_TOKEN"; }; f' "$@"
}

# host-daemon/dist/bb ships mode 644, and a later bb-app install drops +x again.
# bb/bin/bb still runs that file under node. A repair failure must not stop the sync.
repair_exec() {
  local path="$1"
  if [ -f "$path" ] && [ ! -x "$path" ]; then
    chmod +x "$path" || true
    echo "  chmod +x $path"
  fi
  return 0
}

ensure_link() {
  local live="$1" target="$2"
  if [ -L "$live" ] && [ "$(readlink "$live")" = "$target" ]; then return; fi
  if [ -e "$live" ] || [ -L "$live" ]; then
    # Keep local edits: a regular file that is newer than the repo copy wins.
    # A file the repo does not track yet is seeded from the live copy before it is linked.
    if [ -f "$live" ] && [ ! -L "$live" ] && { [ ! -e "$target" ] || { ! cmp -s "$live" "$target" && [ "$live" -nt "$target" ]; }; }; then
      mkdir -p "$(dirname "$target")"; cp "$live" "$target"; echo "  copied $live -> $target"
    fi
    local bak="$live.bak-$(date +%Y%m%d%H%M%S)"
    mv "$live" "$bak"; echo "  moved existing $live to $bak"
  fi
  mkdir -p "$(dirname "$live")"
  ln -s "$target" "$live"; echo "  linked $live -> $target"
}

if [ "$DRY" = 0 ]; then
  echo "Pull:"
  if [ -z "$(git -C "$REPO" status --porcelain)" ]; then
    git_auth pull -q --rebase && echo "  up to date"
  else
    echo "  skipped: working tree has changes"
  fi

  echo "Links:"
  for pair in "${LINKS[@]}"; do ensure_link "${pair%%|*}" "${pair#*|}"; done

  echo "Repairs:"
  if [ -n "${BB_CLI:-}" ]; then repair_exec "$BB_CLI" || true; fi
  for cli in "$HOME"/.bb-machines/*/npm/lib/node_modules/bb-app/host-daemon/dist/bb; do
    repair_exec "$cli" || true
  done
fi

if [ "$PLUGINS" = 1 ]; then
  echo "Plugins:"
  tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT; mkdir -p "$tmp/out"
  fail() { echo "error: $*; plugin export stopped, nothing written or committed" >&2; exit 1; }

  status="$(bb status)" || fail "bb status failed"
  data_dir="$(printf '%s\n' "$status" | sed -n 's/^Data dir: //p')"
  [ -n "$data_dir" ] || fail "bb status shows no data dir"
  # The server's data dir exists on this machine only when the server runs here. A remote
  # server's files are not readable from here, so path plugins are kept as the server reports them.
  if [ -d "$data_dir" ]; then server_local=1; server_kind=local; else server_local=0; server_kind=remote; fi
  echo "  bb server is $server_kind ($data_dir)"

  bb plugin list --json > "$tmp/plugins.json" || fail "bb plugin list failed"
  [ -s "$tmp/plugins.json" ] || fail "bb plugin list printed nothing"
  node -e '
    const fs = require("fs");
    const { plugins } = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    if (!Array.isArray(plugins) || plugins.length === 0) throw new Error("bb plugin list has no plugins array");
    const ids =(keep) => plugins.filter(keep).map(p => p.id).sort().map(id => id + "\n").join("");
    fs.writeFileSync(process.argv[2], ids(p => p.hasSettings));
    fs.writeFileSync(process.argv[3], ids(p => !p.source.startsWith("builtin:") && !p.source.startsWith("path:")));
  ' "$tmp/plugins.json" "$tmp/settings-ids" "$tmp/git-ids" || fail "could not read bb plugin list"

  while read -r id; do
    [ -n "$id" ] || continue
    bb plugin config "$id" --json > "$tmp/config-$id.json" < /dev/null || fail "bb plugin config $id failed"
    [ -s "$tmp/config-$id.json" ] || fail "bb plugin config $id printed nothing"
  done < "$tmp/settings-ids"

  # A git plugin may live in a subdirectory of its repo; bb reports the requested source and the subdirectory.
  while read -r id; do
    [ -n "$id" ] || continue
    bb plugin source "$id" > "$tmp/source-$id.txt" < /dev/null || fail "bb plugin source $id failed"
    grep -q '^  requested: ' "$tmp/source-$id.txt" || fail "bb plugin source $id reported no requested source"
  done < "$tmp/git-ids"

  node -e '
    const fs = require("fs"), path = require("path"), cp = require("child_process");
    const [tmp, repo, home, serverLocal, out] = process.argv.slice(1);
    const { plugins } = JSON.parse(fs.readFileSync(path.join(tmp, "plugins.json"), "utf8"));
    if (!Array.isArray(plugins) || plugins.length === 0) throw new Error("bb plugin list has no plugins array");
    const installed = [], builtinsEnabled = {};
    for (const p of [...plugins].sort((a, b) => a.id.localeCompare(b.id))) {
      if (p.source.startsWith("builtin:")) { builtinsEnabled[p.id] = !!p.enabled; continue; }
      const e = { id: p.id, source: p.source, enabled: !!p.enabled };
      if (p.source.startsWith("path:")) {
        const dir = p.source.slice(5);
        // Only a server on this machine has its path here to inspect; a remote path is kept as reported.
        if (serverLocal === "1" && dir.startsWith(repo + "/")) e.source = "repo:" + dir.slice(repo.length + 1);
        else if (serverLocal === "1") {
          let origin = "";
          try { origin = cp.execFileSync("git", ["-C", dir, "remote", "get-url", "origin"], { stdio: ["ignore", "pipe", "ignore"] }).toString().trim(); } catch {}
          if (origin) { e.clone = origin; e.path = dir.replace(home, "~"); }
          else console.error(`warning: ${p.id} is a local path outside the repo with no git remote, kept as ${p.source}`);
        }
      } else {
        const said = fs.readFileSync(path.join(tmp, `source-${p.id}.txt`), "utf8");
        e.source = said.match(/^\s*requested:\s*(.+?)\s*$/m)[1];
        const sub = said.match(/^\s*subdirectory:\s*(.+?)\s*$/m);
        if (sub) e.subdirectory = sub[1];
      }
      installed.push(e);
    }
    const settings = {};
    for (const p of plugins.filter(p => p.hasSettings).sort((a, b) => a.id.localeCompare(b.id))) {
      const cfg = JSON.parse(fs.readFileSync(path.join(tmp, `config-${p.id}.json`), "utf8"));
      if (!(cfg && cfg.ok === true && cfg.schema && typeof cfg.schema === "object" && cfg.values && typeof cfg.values === "object"))
        throw new Error(`bb plugin config ${p.id} has no ok/schema/values`);
      const changed = {};
      for (const [key, schema] of Object.entries(cfg.schema)) {
        if (schema.secret) continue;
        const value = cfg.values[key];
        if (value === null || value === undefined) continue;
        if (schema.default !== undefined && schema.default !== null ? String(value) === String(schema.default) : String(value) === "") continue;
        changed[key] = value;
      }
      if (Object.keys(changed).length) settings[p.id] = changed;
    }
    fs.writeFileSync(path.join(out, "plugins.json"), JSON.stringify({ installed, builtinsEnabled }, null, 2) + "\n");
    fs.writeFileSync(path.join(out, "plugin-settings.json"), JSON.stringify(settings, null, 2) + "\n");
    console.log(`  ${installed.length} installed plugins, ${Object.keys(settings).length} with custom settings`);
  ' "$tmp" "$REPO" "$HOME" "$server_local" "$tmp/out" || fail "bb plugin data did not validate"

  # Written only after every bb query and validation above succeeded.
  if [ "$DRY" = 1 ]; then
    diff -u "$REPO/bb/plugins.json" "$tmp/out/plugins.json" || true
    diff -u "$REPO/bb/plugin-settings.json" "$tmp/out/plugin-settings.json" || true
  else
    cp "$tmp/out/plugins.json" "$REPO/bb/plugins.json"
    cp "$tmp/out/plugin-settings.json" "$REPO/bb/plugin-settings.json"
  fi
fi

cd "$REPO"
if [ "$DRY" = 1 ]; then
  echo "Dry run: nothing written to the repo or committed; diffs above"
  git status --short
  exit 0
fi
# role-picker ships the agent files it spawns with; generate them from claude/agents and cursor/agents.
node "$(dirname "$0")/../plugins/bb-plugin-role-picker/scripts/gen-agents.mjs"
git add -A
if [ -z "$(git status --porcelain)" ]; then echo "No changes."; exit 0; fi
git commit -q -m "$MESSAGE"
echo "Committed: $MESSAGE"
if [ "$PUSH" = 1 ]; then git_auth push -q && echo "Pushed."; fi
