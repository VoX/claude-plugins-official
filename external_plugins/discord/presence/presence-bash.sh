#!/usr/bin/env bash
# PreToolUse[Bash] classifier → appends a status to the per-turn sequence. No-op when presence
# is disabled; degrades to a generic label if jq is missing.
set -u
[ "${DISCORD_PRESENCE_ACTIVITY:-}" = "1" ] || [ "${DISCORD_PRESENCE_TYPING:-}" = "1" ] || exit 0
here="$(cd "$(dirname "$0")" && pwd)"
cmd=""
if command -v jq >/dev/null 2>&1; then cmd="$(jq -r '.tool_input.command // ""' 2>/dev/null)"; fi

case "$cmd" in
  *"git push"*)   t="⬆️ pushing…";;
  *"git commit"*) t="💾 committing…";;
  *)
    # Name the command from the RIGHTMOST chain segment (the actual work), skipping `cd`/setup.
    # Split on joiners (&&/||/;/|/&); within each segment skip `VAR=value` assignments + wrapper
    # prefixes (env/sudo/…) and treat `cd`/pushd/popd as no-command. The LAST segment that resolves
    # wins: `cd /x && npm ci` → "npm", `make && ./deploy.sh` → "deploy.sh"; a bare `cd /x` writes nothing.
    seg_cmd=""                                    # resolved command of the segment currently being scanned
    seg_locked=0                                  # 1 = this segment's command (or cd) already determined
    # shellcheck disable=SC2086
    set -f; set -- $cmd; set +f                   # word-split on whitespace (no glob)
    for tok in "$@"; do
      case "$tok" in "&&"|"||"|";"|"|"|"&") seg_cmd=""; seg_locked=0; continue ;; esac  # new segment
      [ "$seg_locked" = 1 ] && continue
      case "$tok" in
        *=*) base="${tok%%=*}"; case "$base" in *[!A-Za-z0-9_]*) seg_cmd="$tok"; seg_locked=1;; *) : ;; esac ;;  # VAR=val → skip
        env|sudo|command|exec|nohup|time|nice|setsid|stdbuf|doas|builtin) : ;;                                  # wrapper → skip
        cd|pushd|popd) seg_locked=1 ;;                                                                          # dir-change → segment has no command
        -*) : ;;                                                                                                # stray flag → skip
        *) seg_cmd="$tok"; seg_locked=1 ;;
      esac
    done
    first="${seg_cmd##*/}"   # basename (drop any leading path)
    first="${first:0:24}"    # cap length
    if [ -z "$cmd" ]; then t="⚙️ running…"            # couldn't read the command (no jq) → generic
    elif [ -n "$first" ]; then t="⚙️ run ${first}…"
    else exit 0; fi                                   # cd-only / nothing real → leave the status unchanged
    ;;
esac
exec bash "$here/presence-status.sh" "$t"
