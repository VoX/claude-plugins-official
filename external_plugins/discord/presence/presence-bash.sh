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
    # Name the command from the RIGHTMOST meaningful chain segment. Split on joiners (&&/||/;/|/&);
    # within a segment skip `VAR=value` assignments + wrapper prefixes (env/sudo/…) and treat `cd`/
    # pushd/popd as no-command. `echo` is a confirmation, not work, so it's excluded from the pick
    # (`cd /x && npm ci && echo done` → "npm") but kept as a fallback so a bare `echo hi` still shows
    # something. A bare `cd /x` writes nothing.
    best=""        # rightmost real command that isn't echo (preferred)
    fallback=""    # rightmost real command incl echo (covers an echo-only command)
    seg_cmd=""     # command resolved for the segment currently being scanned
    seg_locked=0   # 1 = this segment's command (or cd) already determined
    commit_seg() {                                # fold the just-finished segment into best/fallback
      [ -n "$seg_cmd" ] || return 0
      fallback="$seg_cmd"
      case "${seg_cmd##*/}" in echo) : ;; *) best="$seg_cmd" ;; esac
    }
    # shellcheck disable=SC2086
    set -f; set -- $cmd; set +f                   # word-split on whitespace (no glob)
    for tok in "$@"; do
      case "$tok" in "&&"|"||"|";"|"|"|"&") commit_seg; seg_cmd=""; seg_locked=0; continue ;; esac  # segment end
      [ "$seg_locked" = 1 ] && continue
      case "$tok" in
        *=*) base="${tok%%=*}"; case "$base" in *[!A-Za-z0-9_]*) seg_cmd="$tok"; seg_locked=1;; *) : ;; esac ;;  # VAR=val → skip
        env|sudo|command|exec|nohup|time|nice|setsid|stdbuf|doas|builtin) : ;;                                  # wrapper → skip
        cd|pushd|popd) seg_locked=1 ;;                                                                          # dir-change → segment has no command
        -*) : ;;                                                                                                # stray flag → skip
        *) seg_cmd="$tok"; seg_locked=1 ;;
      esac
    done
    commit_seg                                    # final segment
    chosen="${best:-$fallback}"
    first="${chosen##*/}"   # basename (drop any leading path)
    first="${first:0:24}"   # cap length
    if [ -z "$cmd" ]; then t="⚙️ running…"            # couldn't read the command (no jq) → generic
    elif [ -n "$first" ]; then t="⚙️ run ${first}…"
    else exit 0; fi                                   # cd/echo-less nothing real → leave the status unchanged
    ;;
esac
exec bash "$here/presence-status.sh" "$t"
