#!/bin/sh
# Read-only checks 1-5 of the copilot-troubleshoot skill (macOS).
# Prints PASS or FAIL per check with the fix hint. Writes nothing, makes no model
# calls, and does not run copilot-acp (which can write the model cache).
# Exit 0 when every check passes, 1 otherwise.
# Usage: sh check.sh [bb-setup repo path]   (default ~/src/bb-setup)

REPO="${1:-$HOME/src/bb-setup}"
CACHE="$HOME/.cache/bb-copilot-acp/models-v2.txt"
CANTRIP="$HOME/.copilot/cantrip"
LAUNCHER="$HOME/.local/bin/copilot-acp"
FAILS=0

pass() { printf 'PASS %s\n' "$1"; }
fail() { printf 'FAIL %s\n     fix: %s\n' "$1" "$2"; FAILS=$((FAILS + 1)); }

# 1. Copilot CLI binary
# Capture output and exit code without a pipeline, so a CLI that prints a line
# and then exits nonzero is a FAIL.
ver_out="$(copilot --version 2>&1)"
rc=$?
case "$ver_out" in
  *'GitHub Copilot CLI'*) recognized=1 ;;
  *) recognized=0 ;;
esac
if [ "$rc" -eq 0 ] && [ "$recognized" -eq 1 ]; then
  pass "1 copilot CLI: $(printf '%s\n' "$ver_out" | head -n 1)"
else
  fail "1 copilot --version rc=$rc, output=[$ver_out] (/opt/homebrew/bin/copilot -> $(readlink /opt/homebrew/bin/copilot 2>/dev/null || echo none))" \
    "brew reinstall --cask copilot-cli"
fi

# 2. copilot-acp launcher and deleted tracked files in the bb-setup repo
if [ -e "$LAUNCHER" ]; then
  pass "2 copilot-acp launcher resolves"
else
  fail "2 copilot-acp launcher missing or dangling ($LAUNCHER)" \
    "see SKILL.md section 2: confirm the deletion is accidental, then restore it (staged and unstaged deletions need different commands); do not run sync.sh first"
fi
if [ -d "$REPO/.git" ]; then
  # --no-optional-locks: status must not refresh or write the index.
  # The status exit code is kept; a git failure is reported, not read as clean.
  status="$(git --no-optional-locks -C "$REPO" status --short 2>&1)"
  rc=$?
  if [ "$rc" -ne 0 ]; then
    fail "2 git status failed in $REPO (rc=$rc): $status" "fix the repo before syncing"
  else
    # A D in either column: ' D' unstaged, 'D ' staged, 'AD'/'MD' etc.
    deleted="$(printf '%s\n' "$status" | awk 'substr($0, 1, 2) ~ /D/')"
    if [ -z "$deleted" ]; then
      pass "2 no deleted tracked files in $REPO (staged or unstaged)"
    else
      fail "2 deleted tracked files in $REPO (staged or unstaged)" \
        "see SKILL.md section 2: confirm each deletion is accidental, then restore it; never run sync.sh while deletions exist"
      printf '%s\n' "$deleted" | sed 's/^/     /'
    fi
  fi
else
  fail "2 $REPO is not a git repo" "clone bogxxx/bb-setup there (see the onboard-bb-machine skill)"
fi

# 3. Model catalog cache (read only; the launcher would rewrite it when stale)
if [ -f "$CACHE" ]; then
  lines="$(wc -l < "$CACHE" | tr -d ' ')"
  if [ "$lines" -ge 100 ]; then
    pass "3 model catalog cache: $lines lines"
  else
    fail "3 model catalog cache has $lines lines (expected about 180)" \
      "copilot-acp --list-models --refresh"
  fi
else
  fail "3 model catalog cache missing ($CACHE)" "copilot-acp --list-models --refresh"
fi

# 4. preToolUse hook scripts, guard self-test, and recent exit-127 failures
hooks_ok=1
for f in cantrip-agent-guard.sh archgate-stop-gate.mjs; do
  [ -f "$CANTRIP/$f" ] || hooks_ok=0
done
if [ "$hooks_ok" -eq 1 ]; then
  out="$(printf '%s' '{"toolName":"bash","toolArgs":{"command":"echo ok"}}' | sh "$CANTRIP/cantrip-agent-guard.sh" 2>&1)"
  rc=$?
  if [ "$rc" -eq 0 ] && [ -z "$out" ]; then
    pass "4 hook scripts present and guard self-test exits 0"
  else
    fail "4 guard self-test exit=$rc output=[$out]" \
      "mkdir -p $CANTRIP && cp ~/src/ai-agents-setup/copilot/hooks/cantrip-agent-guard.sh ~/src/ai-agents-setup/copilot/hooks/archgate-stop-gate.mjs $CANTRIP/"
  fi
else
  fail "4 hook scripts missing in $CANTRIP" \
    "mkdir -p $CANTRIP && cp ~/src/ai-agents-setup/copilot/hooks/cantrip-agent-guard.sh ~/src/ai-agents-setup/copilot/hooks/archgate-stop-gate.mjs $CANTRIP/"
fi
if [ -f "$CANTRIP/cantrip-agent-guard.sh" ]; then
  # Log lines start with a UTC ISO timestamp, so a string compare against the
  # guard script's UTC mtime finds only failures after the hooks were copied.
  cutoff="$(date -u -r "$CANTRIP/cantrip-agent-guard.sh" +%Y-%m-%dT%H:%M:%S)"
  recent="$(grep -l 'code 127' "$HOME"/.copilot/logs/process-*.log 2>/dev/null | while read -r log; do
    awk -v t="$cutoff" '/code 127/ && substr($0, 1, 19) >= t {print FILENAME; exit}' "$log"
  done)"
  if [ -z "$recent" ]; then
    pass "4 no exit-127 hook failures since the guard script was copied ($cutoff UTC)"
  else
    fail "4 exit-127 hook failures since the guard script was copied ($cutoff UTC)" \
      "start a new Copilot session after copying the hooks; check the agent hook paths"
    printf '%s\n' "$recent" | sed 's/^/     /'
  fi
fi

# 5. Agent model pins present in the catalog
pins_ok=1
for f in "$HOME"/.copilot/agents/*.agent.md; do
  [ -f "$f" ] || continue
  pin="$(sed -n 's/^model: *//p' "$f" | head -n 1 | tr -d ' \r')"
  [ -n "$pin" ] || continue
  if [ -f "$CACHE" ] && awk -v id="$pin" 'index($0, id " - ") == 1 {f=1} END {exit !f}' "$CACHE"; then
    :
  else
    pins_ok=0
    fail "5 pin $pin in $(basename "$f") is not in the model catalog" \
      "change the model: line in ~/src/bb-setup/copilot/agents/ to a catalog id; then sync.sh"
  fi
done
[ "$pins_ok" -eq 1 ] && pass "5 all agent model pins are in the catalog"

if [ "$FAILS" -eq 0 ]; then
  echo "all checks passed"
  exit 0
fi
echo "$FAILS check(s) failed"
exit 1
