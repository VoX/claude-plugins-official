# Auto-presence: custom status (+ optional typing)

Drives the bot's Discord **custom status** (the text under its name, e.g. `🐾 working…`) and, optionally,
the **typing indicator** — automatically, from Claude Code's turn lifecycle. The hooks ship WITH this
plugin (`hooks/hooks.json`) and **auto-register when the plugin is enabled** — no `settings.json` editing.

## Enable
Two independent flags, both default **off**. Set them in the bot env (`channels/discord/.env` or the
service environment):
```
DISCORD_PRESENCE_ACTIVITY=1   # the custom-status text
DISCORD_PRESENCE_TYPING=1     # the typing indicator
```
The bundled hook scripts **no-op when both flags are off**, so they're harmless until you opt in.

## How it works
PreToolUse sets the active state; PostToolUse resets to working — so the status tracks live. Hooks write
`channels/discord/.presence-activity` atomically:
- 🐾 working… — turn start + between tools (thinking)
- 📖 reading… — Read / WebFetch
- 🔍 searching… — Grep / Glob / WebSearch
- ✏️ editing… — Edit / Write / MultiEdit / NotebookEdit
- ⬆️ pushing… / 💾 committing… / ⚙️ running… — Bash (classified by command)
- 🔄 compacting… — context compaction (PreCompact)
- cleared on Stop / SubagentStop

The plugin polls that file ~1s and applies it: **ACTIVITY** → the custom status; **TYPING** → typing on the
active Discord channel (started on a real inbound, cleared on the Stop file-clear — so cron/CLI turns never
type). Reliable: the Stop hook clears at turn-end even with no reply (the bug that disabled the old
auto-typing); a ~2 min backstop + startup-clear cover a missed Stop.

## Files
- `hooks/hooks.json` — the auto-registered hooks (reference scripts via `${CLAUDE_PLUGIN_ROOT}`).
- `presence/presence-status.sh` — atomic status writer (self-gated on the flags).
- `presence/presence-bash.sh` — Bash classifier (git push/commit → pushing/committing…).
