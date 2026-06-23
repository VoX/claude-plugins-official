# Auto-presence: aggregated custom status (+ optional typing)

Drives the bot's Discord **custom status** (the text under its name) and, optionally, the **typing
indicator** — automatically, from Claude Code's turn lifecycle. The hooks ship WITH this plugin
(`hooks/hooks.json`) and **auto-register when the plugin is enabled** — no `settings.json` editing.

## Enable
Two independent flags, both default **off**. Set them in the bot env (`channels/discord/.env` or the
service environment):
```
DISCORD_PRESENCE_ACTIVITY=1   # the custom-status text
DISCORD_PRESENCE_TYPING=1     # the typing indicator
```
The bundled hook scripts **no-op when both flags are off**, so they're harmless until you opt in.

## How it works — aggregated per-turn status
The status shows the **distinct actions that fired this turn, in the order they happened**, e.g.
`📖 reading ✏️ editing 💾 committing ⬆️ pushing…`. The hooks append to a per-turn **sequence file**
(`channels/discord/.presence-activity`); the plugin polls it ~1s, composes the aggregate, and sets the
custom status.

- `--start "🐾 working…"` (UserPromptSubmit) resets the sequence each turn.
- each PreToolUse **appends** its action: 📖 reading (Read/WebFetch), 🔍 searching (Grep/Glob/WebSearch),
  ✏️ editing (Edit/Write/MultiEdit/NotebookEdit), ⬆️ pushing / 💾 committing / ⚙️ running (Bash, classified),
  🤝 delegating (Task/Agent subagent), 💬 replying (Discord reply/embed/voice), 🔄 compacting (PreCompact).
- composition: **distinct** (deduped), **first-occurrence order**, space-joined with one trailing "…".
  "🐾 working…" is dropped unless it's the only thing that fired. "💤 idle…" is unique (never combined).
- Stop → `--idle`. The plugin **flushes the final aggregate, then settles to idle** after a short
  linger, so even a quick turn shows what it did. (Only top-level Stop idles — SubagentStop does not,
  so spawning a subagent can't wipe the aggregate mid-turn.)

Dot + typing: green/online while active, yellow/idle when resting; typing (if enabled) starts on a real
Discord inbound and stops when the turn idles. Presence writes are throttled (~5/20s Discord limit;
discord.js queues so no disconnect). A ~2 min backstop + startup-clear cover a missed Stop.

## Files
- `hooks/hooks.json` — the auto-registered hooks (reference scripts via `${CLAUDE_PLUGIN_ROOT}`).
- `presence/presence-status.sh` — sequence writer (`--start` / append / `--idle`), self-gated, atomic.
- `presence/presence-bash.sh` — Bash classifier (git push/commit → pushing/committing…).
