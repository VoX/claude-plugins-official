#!/usr/bin/env bun
/**
 * The Stop hook. This is the whole trick: while a goal is open, refuse the stop and hand the
 * reason back to the model, which puts it straight back to work. Mirrors how Claude Code's own
 * /goal registers a blocking Stop hook.
 *
 * Output contract (verified against the hook docs embedded in the 2.1.219 binary):
 *   {"decision":"block","reason":"..."}  -> stop refused, `reason` goes into the model's context
 *   exit 0 with no decision              -> stop allowed
 *
 * This must FAIL OPEN. Any error in here and the session can never end, so every failure path
 * lets the stop through.
 */

import { decideStop } from '../lib'
import { readState, writeState, isKilled, clearKill, recordOutcome } from '../state'

function allow(systemMessage?: string): never {
  if (systemMessage) process.stdout.write(JSON.stringify({ systemMessage }))
  process.exit(0)
}

try {
  // A verifier subprocess must never re-enter this hook -- that would recurse a goal into itself.
  if (process.env.GOAL_JUDGE === '1') allow()

  const state = readState()
  if (!state) allow()

  const killed = isKilled()
  const decision = decideStop(state, Date.now(), killed)

  if (decision.action === 'allow') allow()

  if (decision.action === 'release') {
    writeState(null)
    if (killed) clearKill()
    recordOutcome(state, decision.outcome, decision.message)
    // Released goals let the stop through, but the model is told plainly that it did NOT
    // succeed -- otherwise a timed-out goal reads as a finished one.
    process.stdout.write(JSON.stringify({
      decision: 'block',
      reason: decision.message,
      systemMessage: `goal released (${decision.outcome})`,
    }))
    process.exit(0)
  }

  writeState({ ...state, iterations: decision.nextIterations })
  process.stdout.write(JSON.stringify({
    decision: 'block',
    reason: decision.reason,
    systemMessage: `goal: iteration ${decision.nextIterations}/${state.maxIterations}`,
  }))
  process.exit(0)
} catch (err) {
  // Fail open, loudly. A broken goal plugin must not be able to trap the session.
  allow(`goal hook error (stop allowed): ${err instanceof Error ? err.message : String(err)}`)
}
