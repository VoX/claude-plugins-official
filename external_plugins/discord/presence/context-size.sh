#!/usr/bin/env bash
# Compute the current context-window size (the number Claude Code's /status shows) from the session
# transcript and write it as a short prefix (e.g. "565k") to .presence-context, so the discord presence
# aggregator can show it in front of each status ("565k - 💤 idle…"). Takes the hook's transcript_path
# as $1. No-op (leaves the existing prefix untouched) on any failure: presence disabled, no jq, no
# transcript, or no usage recorded yet (turn 1).
set -u
[ "${DISCORD_PRESENCE_ACTIVITY:-}" = "1" ] || [ "${DISCORD_PRESENCE_TYPING:-}" = "1" ] || exit 0
tp="${1:-}"
command -v jq >/dev/null 2>&1 || exit 0
[ -n "$tp" ] && [ -f "$tp" ] || exit 0
dir="${DISCORD_STATE_DIR:-${CLAUDE_CONFIG_DIR:-$HOME/.claude}/channels/discord}"
out="$dir/.presence-context"
# The context size = the LAST assistant response's input context = input + cache-read + cache-creation
# tokens (the exact tokens /status counts as "used" in the window). `tac | grep -m1` grabs the last
# usage-bearing line cheaply without scanning the whole (possibly huge) transcript.
ctx="$(tac "$tp" 2>/dev/null | grep -m1 '"cache_read_input_tokens"' \
  | jq -r '(.message.usage // .usage) as $u
           | (($u.input_tokens // 0) + ($u.cache_read_input_tokens // 0) + ($u.cache_creation_input_tokens // 0))' \
      2>/dev/null)"
# 0 is REJECTED, not just non-numeric input: a Task/Agent tool-result line carries the SUBAGENT's
# usage at .toolUseResult.usage.cache_read_input_tokens -- a real nested key, so the grep above matches it,
# but it has neither .message.usage nor .usage, so the jq yields 0. Treating that as valid overwrote the
# last good prefix with "0k", the exact opposite of what this line promises.
case "$ctx" in ''|0|*[!0-9]*) exit 0 ;; esac   # empty / non-numeric → leave the last good prefix in place
k=$(( (ctx + 500) / 1000 ))                   # round to the nearest 1k
mkdir -p "$dir"
tmp="$out.tmp.$$"; printf '%sk' "$k" > "$tmp" && mv -f "$tmp" "$out"   # atomic: a concurrent plugin read never sees a half-written/empty file
