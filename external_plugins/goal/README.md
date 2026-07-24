# goal

Set yourself a goal and keep working until it's met.

A port of the mechanism behind Claude Code's own `/goal`: an active goal registers a **Stop hook**,
and every time the agent tries to end its turn the hook refuses and hands the goal back, which puts
it straight back to work. The goal ends when it's completed, abandoned, or a cap fires.

## Why a Stop hook

`/goal` works this way internally — it registers a Stop hook whose prompt is the goal condition,
tracks `{condition, setAt, iterations, tokensAtStart}`, blocks stops while the condition is unmet,
and has an "impossible" escape so a goal that can't be met fails loudly instead of grinding. This
plugin reproduces that shape with the pieces a plugin actually gets: `hooks/hooks.json` for the
hook, an MCP server for the tools, and a JSON file on disk so the two processes share state.

## Tools

| Tool | What it does |
| --- | --- |
| `set_goal(condition, max_iterations?, deadline_minutes?)` | Opens a goal. Stops are blocked from here on. |
| `goal_status()` | Active goal, iterations burned, time left. |
| `complete_goal(evidence)` | Claims completion. **Verified** — see below. |
| `abandon_goal(reason)` | The "impossible" escape. Ends the goal, unmet, on the record. |

## How completion is judged

Self-reporting alone would let the agent declare victory, which is the exact failure the feature
exists to prevent. Judging every single stop with a model call is a tax on every turn. So:
**the agent self-reports with evidence, and only that final claim is verified.**

`complete_goal` shells out to a separate `claude -p` judge that is told to be strict and to reject
evidence that is vague, asserts success without showing it, or describes intent rather than result.
Reject → the goal stays open and the verdict comes back as context. The judge runs with
`GOAL_JUDGE=1`, `--strict-mcp-config` and `disableAllHooks`, so it cannot recurse into this plugin.

Verification **fails closed**: if the judge can't be run, the goal is not met.

## Safety

A blocking Stop hook with nobody watching is how an agent wedges itself, so every escape hatch
beats "keep working":

- **Iteration cap** — default 12, hard ceiling 50.
- **Wall-clock deadline** — default 30 min, hard ceiling 240.
- **Kill switch** — `touch $CLAUDE_CONFIG_DIR/goal/KILL` releases the goal on the next stop.
- **Fails open** — a corrupt, unreadable or broken state file lets the stop through. A broken goal
  plugin must never be able to trap a session.
- **Opt-in** — inert unless `VOX_PLUGINS_ENABLED=1`, so a plain `claude` session never silently
  acquires a hook that refuses to let it exit.

Released goals are reported as **NOT met**, so a timed-out goal can't read as a finished one.
Every finished goal is appended to `goal/history.jsonl`.

## Layout

```
goal/
  .claude-plugin/plugin.json
  .mcp.json              MCP server spawn
  server.ts              the four tools + the verifier
  lib.ts                 all decision logic, pure
  lib.test.ts            21 tests
  state.ts               atomic state IO shared with the hook
  hooks/hooks.json       registers the Stop hook
  hooks/stop-goal.ts     the hook itself
```

State lives in `$CLAUDE_CONFIG_DIR/goal/` (or `$GOAL_STATE_DIR`).

## Test

```sh
bun test
```
