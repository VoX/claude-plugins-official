#!/usr/bin/env bash
# Write the Discord custom-status text for the vox-plugins discord presence watcher.
#   presence-status.sh "🐾 working…"     set the status text
#   presence-status.sh --clear           clear it (Stop hook)
# Atomic (tmp+mv) so the plugin's 1s poll never sees a torn write.
set -u
dir="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/channels/discord"
f="$dir/.presence-activity"
mkdir -p "$dir"
tmp="$f.tmp.$$"
if [ "${1:-}" = "--clear" ]; then : > "$tmp"; else printf '%s' "${1:-}" > "$tmp"; fi
mv -f "$tmp" "$f"
