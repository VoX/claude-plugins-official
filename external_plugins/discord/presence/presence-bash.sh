#!/usr/bin/env bash
# PreToolUse[Bash] classifier → appends an ACTIVITY-VERB status to the per-turn sequence.
# Classifies the resolved command by what it DOES (reading / searching / building / testing /
# fetching / installing / pushing / committing / ops), deliberately aligning shell verbs with
# the tool-level labels — cat/head → 📖 reading, grep/find → 🔍 searching — so a turn that mixes
# the Read/Grep tools with shell equivalents dedupes to one stable line instead of a run-cmd
# firehose. "⚙️ run <cmd>…" is reserved for genuinely distinctive commands (deploy.sh, a python
# script, claude, …) where the name itself is the signal. No-op when presence is disabled;
# degrades to a generic label if jq is missing.
set -u
[ "${DISCORD_PRESENCE_ACTIVITY:-}" = "1" ] || [ "${DISCORD_PRESENCE_TYPING:-}" = "1" ] || exit 0
here="$(cd "$(dirname "$0")" && pwd)"
cmd=""
if command -v jq >/dev/null 2>&1; then cmd="$(jq -r '.tool_input.command // ""' 2>/dev/null)"; fi

# Resolve the RIGHTMOST meaningful chain segment to (command, first-arg). Split on joiners
# (&&/||/;/|/&); within a segment skip `VAR=value` assignments + wrapper prefixes (env/sudo/…)
# and treat cd/pushd/popd as no-command. `echo` is a confirmation, not work, so it's excluded
# from the pick (`cd /x && npm ci && echo done` → npm) but kept as a fallback so a bare `echo hi`
# still shows something. The first non-flag token after the command is captured as its arg — used
# to read a subcommand (git push, npm test, cargo build) WITHOUT substring-matching the raw string
# (so `grep "git push"` no longer falsely reports a push).
best_cmd=""; best_arg=""    # rightmost real command that isn't echo (preferred) + its first arg
fb_cmd=""; fb_arg=""        # rightmost real command incl echo (covers an echo-only command)
seg_cmd=""; seg_arg=""      # command + first arg resolved for the segment being scanned
seg_locked=0               # 1 = this segment's command (or cd) already determined
commit_seg() {                                 # fold the just-finished segment into best/fallback
  [ -n "$seg_cmd" ] || return 0
  fb_cmd="$seg_cmd"; fb_arg="$seg_arg"
  case "${seg_cmd##*/}" in echo) : ;; *) best_cmd="$seg_cmd"; best_arg="$seg_arg" ;; esac
}
# shellcheck disable=SC2086
set -f; set -- $cmd; set +f                    # word-split on whitespace (no glob)
for tok in "$@"; do
  case "$tok" in "&&"|"||"|";"|"|"|"&") commit_seg; seg_cmd=""; seg_arg=""; seg_locked=0; continue ;; esac  # segment end
  if [ "$seg_locked" = 1 ]; then
    [ -n "$seg_arg" ] && continue              # already have the first arg
    case "$tok" in -*) : ;; *) seg_arg="$tok" ;; esac   # first non-flag token = subcommand/arg
    continue
  fi
  case "$tok" in
    *=*) base="${tok%%=*}"; case "$base" in *[!A-Za-z0-9_]*) seg_cmd="$tok"; seg_locked=1;; *) : ;; esac ;;  # VAR=val → skip
    env|sudo|command|exec|nohup|time|nice|setsid|stdbuf|doas|builtin) : ;;                                  # wrapper → skip
    cd|pushd|popd) seg_locked=1 ;;                                                                          # dir-change → segment has no command
    -*) : ;;                                                                                                # stray flag → skip
    *) seg_cmd="$tok"; seg_locked=1 ;;
  esac
done
commit_seg                                     # final segment

c="${best_cmd:-$fb_cmd}"; a="${best_arg:-$fb_arg}"
base="${c##*/}"          # basename (drop any leading path)

if [ -z "$cmd" ]; then
  t="⚙️ running…"          # couldn't read the command (no jq) → generic
elif [ -z "$base" ]; then
  exit 0                  # cd / nothing real → leave the status unchanged
else
  case "$base" in
    git)
      case "$a" in
        push)                          t="⬆️ pushing…" ;;
        commit)                        t="💾 committing…" ;;
        clone|fetch|pull)              t="🌐 fetching…" ;;
        log|show|diff|status|blame|grep|ls-files|branch|stash) t="🔍 searching…" ;;
        *)                             t="⚙️ run git…" ;;
      esac ;;
    npm|npx|bun|yarn|pnpm)
      case "$a" in
        test|t|run-test)               t="🧪 testing…" ;;
        ci|install|i|add|update|upgrade|dedupe|prune) t="📦 installing…" ;;
        *)                             t="🔧 building…" ;;
      esac ;;
    cargo)
      case "$a" in test) t="🧪 testing…" ;; install) t="📦 installing…" ;; *) t="🔧 building…" ;; esac ;;
    make|go|tsc|gradle|mvn|webpack|vite|rollup|esbuild|gcc|g++|clang|cc)
      case "$a" in test) t="🧪 testing…" ;; *) t="🔧 building…" ;; esac ;;
    pytest|jest|vitest|bats|mocha|phpunit|rspec)  t="🧪 testing…" ;;
    curl|wget|gh|aws|ssh|scp|rsync|nc|dig|ping|http)  t="🌐 fetching…" ;;
    apt|apt-get|dnf|yum|pip|pip3|brew|gem|apk)    t="📦 installing…" ;;
    cat|head|tail|less|more|bat|sed)              t="📖 reading…" ;;
    grep|rg|ag|ack|find|fd|awk|jq|yq|diff|ls|wc|stat|file|tree|cut|sort|uniq|column|xargs|comm|nl)  t="🔍 searching…" ;;
    systemctl|service|docker|journalctl|kill|pkill|chmod|chown|ln|mkdir|rm|mv|cp)  t="🛠️ ops…" ;;
    *)  first="${base:0:24}"; t="⚙️ run ${first}…" ;;
  esac
fi
exec bash "$here/presence-status.sh" "$t"
