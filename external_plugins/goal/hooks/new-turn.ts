#!/usr/bin/env bun
/**
 * UserPromptSubmit hook. A real new turn from the user resets the "have I already spoken"
 * counter, so the model is free to reply once again.
 *
 * The distinction that matters: a BLOCKED STOP is not a new turn. Only an actual user prompt
 * clears the counter -- otherwise the silence rule would lift itself on the first iteration and
 * the spam it exists to prevent comes right back.
 */

import { readState, writeState } from '../state'

try {
  const state = readState()
  if (state && (state.spokeThisTurn ?? 0) !== 0) writeState({ ...state, spokeThisTurn: 0 })
} catch {
  // Never block a user prompt over bookkeeping.
}
process.exit(0)
