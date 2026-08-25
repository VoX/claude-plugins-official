# Auto-presence: live custom status (+ optional typing)

Drives the bot's Discord **custom status** (the text under its name) and, optionally, the **typing
indicator** — automatically, from Claude Code's turn lifecycle. The hooks ship WITH this plugin
(`hooks/hooks.json`) and **auto-register when the plugin is enabled** — no `settings.json` editing.

## Enable
Two independent flags, both default **off**. Set them in the **service/systemd environment** (e.g. the
unit's `EnvironmentFile`/`.bot.env`) — NOT only in `channels/discord/.env`. The plugin loads that `.env`
for itself, but the hooks run as separate processes and only see the inherited service environment; if
the flags live solely in `channels/discord/.env` the watcher arms but the hooks never write, so no status
appears.
```
DISCORD_PRESENCE_ACTIVITY=1   # the custom-status text
DISCORD_PRESENCE_TYPING=1     # the typing indicator
```
The bundled hook scripts **no-op when both flags are off**, so they're harmless until you opt in.

## How it works — live current-action status
The status shows what the bot is doing **now**, advancing as it works, e.g. `📖 reading…` →
`✏️ editing…` → `⬆️ pushing…`. Hooks append actions to a per-turn **sequence file**; the plugin polls
it (~250ms) and publishes the distinct actions appended *since the last publish* (a high-water mark
advances — it is NOT a whole-turn aggregate). When several actions land between publishes (a burst),
they're shown together (e.g. `📖 reading ✏️ editing…`); otherwise each shows on its own ~1s after it fires.

- `--start "🐾 working…"` (UserPromptSubmit) resets the sequence each turn.
- `--idle` also fires on **SubagentStop**, **TeammateIdle** and **SessionEnd**, not just Stop.
  TeammateIdle is the load-bearing one and was found by TESTING: SubagentStop alone did NOT settle the
  status after a background `Agent` finished (spawned one, idle count stayed put). The harness groups
  `["Stop","TeammateIdle","TaskCreated","TaskCompleted"]` together and SubagentStop is NOT in that group —
  a backgrounded agent surfaces as a TEAMMATE, so SubagentStop covers the synchronous path only. A subagent's tool calls append
  work to the same sequence, but nothing used to settle it when the subagent finished — so after a delegated
  turn the dot sat green claiming it was still running bash. Safe with parallel subagents because a
  non-trailing idle is dropped the moment another appends work. **PostCompact** restores `🐾 working…`, which
  `🔄 compacting…` otherwise outlived.
- each PreToolUse **appends** its action: 📖 reading (Read/WebFetch), 🔍 searching (Grep/Glob/WebSearch),
  ✏️ editing (Edit/Write/MultiEdit/NotebookEdit), `>_ bash` (Bash),
  🤝 delegating (Task/Agent subagent), 💬 replying (**Discord OR Slack** reply/embed/voice/react),
  🛠️ configuring (apply_server_spec), 🔄 compacting (PreCompact).
- a **reaction counts as replying** (VoX, 2026-08-25). An emoji is a response — often the whole response,
  since reacting instead of replying is the cheaper correct move when a message needs acknowledging but not
  answering — and a turn that answers purely by reacting should not look idle.
- **Slack counts too.** The line reports what the BOT is doing, not what it is doing on Discord — it already
  labels Read/Bash/Edit work that has nothing to do with either channel — so a turn answered entirely in
  Slack should not read as idle. (Same both-channels matcher the goal plugin already uses.)
- deliberately unmatched: `fetch_messages`, `typing`, `lookup`, `get_server_spec` (read-only or instant),
  and `edit_message` — that one MUTATES, so "read-only" was the wrong reason; the real one is that an
  interim progress edit is not a response.
- **MATCHER SEMANTICS, easy to get wrong.** A matcher made only of `[A-Za-z0-9_|, -]` is parsed as an
  EXACT-NAME LIST, not a regex — so `"Bash"` does NOT also catch `BashOutput`, and `"Task|Agent"` does NOT
  catch `TaskCreate`/`ListAgents`. It becomes a regex only once it contains other punctuation, and that
  regex is tested UNANCHORED. So a "fix" written as a bare substring like `reply` matches NOTHING, and one
  written as a loose regex can over-match. The mcp matchers here are anchored with `^…$` for that reason.
- Bash is a FLAT `>_ bash…` — it does not say which command ran. It used to: a classifier resolved the
  rightmost chain segment and mapped it to an activity verb (cat → 📖 reading, npm → 🔧 building,
  `./deploy.sh` → `⚙️ run deploy.sh…`, and so on). VoX removed it on 2026-08-25 — the extracted name
  wasn't useful enough to justify ~95 lines of shell parsing plus its own test suite, so the Bash matcher
  is now the same one-line fixed label as every other matcher.
- composition: **distinct** (deduped), first-occurrence order, space-joined with one trailing "…".
  "🐾 working…" shows only if it's the only thing that fired. Sentinels match by emoji (🐾/💤), so a
  command literally named "idle"/"working" isn't mistaken for one.
- Stop → `--idle` (appended). The final action(s) publish, then the dot settles to idle.

Dot + typing: green/online while active, yellow/idle when resting; typing (if enabled) starts on a real
Discord inbound and stops when the turn idles. Publishes go through a **sliding-window rate limiter** —
≤5 updates per 20s (a conservative self-limit; Discord's documented gateway cap is 120 events/60s and the
presence-specific threshold is undocumented — excess presence updates are silently dropped, which is why
self-limiting is load-bearing: a dropped final publish would freeze a stale status), so a busy turn
batches rather than getting dropped.
No staleness backstop: a long single operation holds its status (idle comes only from the Stop hook); a
missed Stop is recovered by the next turn's `--start` or the on-restart startup-clear.

## Requirements (esp. for deploying to other bots)
- The plugin must be **enabled** (hooks auto-register from `hooks/hooks.json`); a bare dev-load won't
  register them.
- `bash`. `jq` is optional and only powers the context-size prefix (`325k - …`); every label works without it.
- The hooks resolve the state dir as `DISCORD_STATE_DIR` ?? `$CLAUDE_CONFIG_DIR/channels/discord` (??
  `~/.claude/...`) — the SAME precedence the plugin uses, so set whichever the plugin uses and export it
  into the hook environment.

## Files
- `hooks/hooks.json` — the auto-registered hooks (reference scripts via `${CLAUDE_PLUGIN_ROOT}`).
- `presence/presence-status.sh` — sequence writer (`--start` / append / `--idle`), self-gated, atomic.
(Bash has no script of its own any more — see above.)
