#!/usr/bin/env bash
# PostToolUse[Bash] classifier → custom-status text. Reads the hook JSON on stdin.
# Falls back to a generic label if jq is missing (the --clear path never needs jq).
set -u
here="$(cd "$(dirname "$0")" && pwd)"
cmd=""
if command -v jq >/dev/null 2>&1; then cmd="$(jq -r '.tool_input.command // ""' 2>/dev/null)"; fi
case "$cmd" in
  *"git push"*)   t="⬆️ pushing…";;
  *"git commit"*) t="💾 committing…";;
  *)              t="⚙️ running…";;
esac
exec "$here/presence-status.sh" "$t"
