#!/usr/bin/env bash
# Write the Discord custom-status text for the vox-plugins discord presence watcher.
#   presence-status.sh "🐾 working…"     set the status text
#   presence-status.sh --clear           clear it (Stop hook)
# No-op unless a presence effect is enabled (the plugin's hooks are always-on). Atomic write.
set -u
[ "${DISCORD_PRESENCE_ACTIVITY:-}" = "1" ] || [ "${DISCORD_PRESENCE_TYPING:-}" = "1" ] || exit 0
dir="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/channels/discord"
f="$dir/.presence-activity"
mkdir -p "$dir"
tmp="$f.tmp.$$"
if [ "${1:-}" = "--clear" ]; then : > "$tmp"; else printf '%s' "${1:-}" > "$tmp"; fi
mv -f "$tmp" "$f"
