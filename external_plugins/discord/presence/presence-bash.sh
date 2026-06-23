#!/usr/bin/env bash
# PreToolUse[Bash] classifier → custom-status text. Reads the hook JSON on stdin.
# No-op when presence is disabled; degrades to a generic label if jq is missing.
set -u
[ "${DISCORD_PRESENCE_ACTIVITY:-}" = "1" ] || [ "${DISCORD_PRESENCE_TYPING:-}" = "1" ] || exit 0
here="$(cd "$(dirname "$0")" && pwd)"
cmd=""
if command -v jq >/dev/null 2>&1; then cmd="$(jq -r '.tool_input.command // ""' 2>/dev/null)"; fi
case "$cmd" in
  *"git push"*)   t="⬆️ pushing…";;
  *"git commit"*) t="💾 committing…";;
  *)              t="⚙️ running…";;
esac
exec bash "$here/presence-status.sh" "$t"
