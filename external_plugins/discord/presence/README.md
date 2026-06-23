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
- each PreToolUse **appends** its action: 📖 reading (Read/WebFetch), 🔍 searching (Grep/Glob/WebSearch),
  ✏️ editing (Edit/Write/MultiEdit/NotebookEdit), ⚙️ run <cmd> / ⬆️ pushing / 💾 committing (Bash, classified),
  🤝 delegating (Task/Agent subagent), 💬 replying (Discord reply/embed/voice), 🔄 compacting (PreCompact).
- the Bash classifier names the command: `npm ci` → `⚙️ run npm…`; on a chain it names the **rightmost**
  segment (the actual work), skipping `VAR=…`/`sudo`/`env` prefixes and `cd` setup — `cd /x && npm ci` →
  `run npm`, `make && ./deploy.sh` → `run deploy.sh`. A bare `cd` writes nothing.
- composition: **distinct** (deduped), first-occurrence order, space-joined with one trailing "…".
  "🐾 working…" shows only if it's the only thing that fired. Sentinels match by emoji (🐾/💤), so a
  command literally named "idle"/"working" isn't mistaken for one.
- Stop → `--idle` (appended). The final action(s) publish, then the dot settles to idle.

Dot + typing: green/online while active, yellow/idle when resting; typing (if enabled) starts on a real
Discord inbound and stops when the turn idles. Publishes go through a **sliding-window rate limiter** —
≤5 updates per 20s (Discord's exact presence limit), so a busy turn batches rather than getting dropped.
No staleness backstop: a long single operation holds its status (idle comes only from the Stop hook); a
missed Stop is recovered by the next turn's `--start` or the on-restart startup-clear.

## Requirements (esp. for deploying to other bots)
- The plugin must be **enabled** (hooks auto-register from `hooks/hooks.json`); a bare dev-load won't
  register them.
- `bash` + `jq` (without `jq` the Bash label degrades to `⚙️ running…`; everything else still works).
- The hooks resolve the state dir as `DISCORD_STATE_DIR` ?? `$CLAUDE_CONFIG_DIR/channels/discord` (??
  `~/.claude/...`) — the SAME precedence the plugin uses, so set whichever the plugin uses and export it
  into the hook environment.

## Files
- `hooks/hooks.json` — the auto-registered hooks (reference scripts via `${CLAUDE_PLUGIN_ROOT}`).
- `presence/presence-status.sh` — sequence writer (`--start` / append / `--idle`), self-gated, atomic.
- `presence/presence-bash.sh` — Bash classifier (`run <cmd>`, git push/commit → pushing/committing…).
