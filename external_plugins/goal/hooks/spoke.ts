#!/usr/bin/env bun
/**
 * PreToolUse hook on the channel reply tools. Records that a user-visible message went out
 * during this turn, so the Stop hook can tell the model to shut up rather than send a second one.
 *
 * The hazard (BMO, 2026-07-24): for a bot on Discord/Slack, SENDING and STOPPING are different
 * events. A blocked stop after an already-sent reply invites another reply, and a stream of them
 * if verification keeps rejecting -- the goal plugin ends up spamming the human it works for.
 *
 * Cheap and silent: with no active goal this reads one file and exits. Never blocks a tool call.
 */

import { readState, writeState } from '../state'

try {
  const state = readState()
  if (state) writeState({ ...state, spokeThisTurn: (state.spokeThisTurn ?? 0) + 1 })
} catch {
  // Never let bookkeeping break an outgoing message.
}
process.exit(0)
