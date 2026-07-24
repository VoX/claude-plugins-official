/**
 * State that the MCP server and the Stop hook both touch. They are separate processes, so a
 * file on disk is the only thing they share -- the same approach the scheduler plugin uses for
 * jobs.json. Writes are atomic (write temp + rename) because the hook can fire while a tool
 * call is mid-write.
 */

import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync, unlinkSync, appendFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import type { GoalState, GoalOutcome } from './lib'

/** Respect CLAUDE_CONFIG_DIR for per-instance setups (claude-discord-service), else ~/.claude. */
export function stateDir(): string {
  const base = process.env.GOAL_STATE_DIR
    ?? join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'goal')
  return base
}

export const statePath = () => join(stateDir(), 'state.json')
/** Touch this file to release any active goal on the next stop. */
export const killPath = () => join(stateDir(), 'KILL')
export const logPath = () => join(stateDir(), 'history.jsonl')

function ensureDir() {
  try { mkdirSync(stateDir(), { recursive: true }) } catch { /* already there */ }
}

export function readState(): GoalState | null {
  try {
    const raw = readFileSync(statePath(), 'utf8')
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed.condition !== 'string') return null
    return parsed as GoalState
  } catch {
    return null   // missing or corrupt reads as "no goal" -- never as a stuck goal
  }
}

export function writeState(state: GoalState | null): void {
  ensureDir()
  const p = statePath()
  if (state === null) {
    try { unlinkSync(p) } catch { /* already gone */ }
    return
  }
  const tmp = `${p}.tmp`
  writeFileSync(tmp, JSON.stringify(state, null, 2))
  renameSync(tmp, p)
}

export function isKilled(): boolean {
  return existsSync(killPath())
}

export function clearKill(): void {
  try { unlinkSync(killPath()) } catch { /* fine */ }
}

/** Append-only record of finished goals, so "did that goal actually get met" is answerable later. */
export function recordOutcome(state: GoalState, outcome: GoalOutcome, detail: string): void {
  ensureDir()
  try {
    appendFileSync(
      logPath(),
      JSON.stringify({
        condition: state.condition,
        outcome,
        detail,
        iterations: state.iterations,
        setAt: state.setAt,
        endedAt: Date.now(),
        durationMs: Date.now() - state.setAt,
      }) + '\n',
    )
  } catch { /* logging must never break the hook */ }
}
