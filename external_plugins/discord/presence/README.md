# Auto-presence: custom status + typing

Drives the bot's Discord **custom status** (the text under its name, e.g. `🐾 working…`) and the
**typing indicator** automatically from Claude Code's turn lifecycle. Two **independent**, opt-in flags.

## How it works
Claude Code **hooks** write a one-line control file; the plugin **watches** it and applies the effects.

- Control file: `$CLAUDE_CONFIG_DIR/channels/discord/.presence-activity` (empty = cleared).
- Hooks write it atomically (`presence-status.sh`); the plugin polls it ~1s and calls `setPresence`.
- **Activity** (custom status) is fully control-file driven. **Typing** is started by the plugin on every
  delivered Discord inbound and cleared when the control file empties — so non-Discord turns (cron/CLI)
  never trigger typing.
- The **`Stop` hook clearing the file** is what makes it reliable: typing/status end at turn-end even when
  the bot doesn't reply (the bug that got the old auto-typing disabled). A ~2 min backstop self-clears if a
  `Stop` hook is ever missed.

## Enable (env)
Both default **off**. Set in `channels/discord/.env` (or real env):
```
DISCORD_PRESENCE_ACTIVITY=1   # the custom-status text
DISCORD_PRESENCE_TYPING=1     # the typing indicator
```
Independent — run either, both, or neither. With both off the watcher never starts (zero overhead).

## Wire the hooks (settings.json)
Point the commands at the scripts in this directory (absolute paths):
```json
{ "hooks": {
  "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "/ABS/presence/presence-status.sh '🐾 working…'" }] }],
  "PostToolUse": [
    { "matcher": "Edit|Write|MultiEdit|NotebookEdit", "hooks": [{ "type": "command", "command": "/ABS/presence/presence-status.sh '✏️ editing…'" }] },
    { "matcher": "Bash", "hooks": [{ "type": "command", "command": "/ABS/presence/presence-bash.sh" }] }
  ],
  "Stop": [{ "hooks": [{ "type": "command", "command": "/ABS/presence/presence-status.sh --clear" }] }],
  "SubagentStop": [{ "hooks": [{ "type": "command", "command": "/ABS/presence/presence-status.sh --clear" }] }]
}}
```
Notes:
- `presence-bash.sh` classifies the command (`git push` → pushing…, `git commit` → committing…, else
  running…); it needs `jq` (degrades to "running…" without it). The `--clear` path never needs `jq`.
- Status text is capped at 128 chars and stripped of control chars by the plugin.
- The hooks resolve the file via `$CLAUDE_CONFIG_DIR` (falls back to `~/.claude`).
