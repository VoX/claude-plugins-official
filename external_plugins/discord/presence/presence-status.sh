#!/usr/bin/env bash
# Per-turn sequence-file writer for the vox-plugins discord presence aggregator.
#   presence-status.sh --start "🐾 working…"   reset the sequence at turn start (UserPromptSubmit)
#   presence-status.sh "📖 reading…"            append an action (PreToolUse)
#   presence-status.sh --idle                   end the turn (Stop) → idle
# No-op unless a presence effect is enabled (plugin hooks are always-on). Appends are a single
# atomic O_APPEND write so parallel tool hooks can't clobber each other's lines; --start
# atomically replaces the whole file (tmp+mv); --idle appends (so a final action isn't lost).
set -u
[ "${DISCORD_PRESENCE_ACTIVITY:-}" = "1" ] || [ "${DISCORD_PRESENCE_TYPING:-}" = "1" ] || exit 0
dir="${DISCORD_STATE_DIR:-${CLAUDE_CONFIG_DIR:-$HOME/.claude}/channels/discord}"
f="$dir/.presence-activity"
mkdir -p "$dir"
case "${1:-}" in
  --start) tmp="$f.tmp.$$"; printf '%s\n' "${2:-🐾 working…}" > "$tmp"; mv -f "$tmp" "$f" ;;
  --idle)  printf '%s\n' "💤 idle…" >> "$f" ;;   # APPEND so the final actions survive (composePresence rests on a TRAILING idle)
  *)       printf '%s\n' "${1:-}" >> "$f" ;;
esac
