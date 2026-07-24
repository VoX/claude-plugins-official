#!/usr/bin/env bun
/**
 * Goal channel for Claude Code.
 *
 * Lets the agent set itself a goal and then keeps it working until that goal is met. The
 * enforcement is a Stop hook (hooks/stop-goal.ts); this server owns the state the hook reads
 * and the tools the agent drives it with.
 *
 * Completion model is "approach (c)": the agent self-reports via complete_goal WITH evidence,
 * and only that final claim is verified by a separate judge process. Cheaper than judging
 * every stop, and unlike pure self-reporting the agent doesn't get to simply declare victory.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { spawnSync } from 'child_process'
import {
  decideStop, newGoal, describe, parseVerdict, buildJudgePrompt,
  clampMaxIterations, clampDeadlineMinutes, ITERATION_CEILING, DEADLINE_CEILING_MINUTES,
} from './lib'
import { readState, writeState, isKilled, clearKill, recordOutcome, statePath, killPath } from './state'

// Same opt-in gate the other vox-plugins use: inert unless our service sets it, so a plain
// `claude` session doesn't silently acquire a Stop hook that refuses to let it exit.
if (process.env.VOX_PLUGINS_ENABLED !== '1') {
  const idle = new Server({ name: 'goal', version: '0.1.0' }, { capabilities: { tools: {} } })
  idle.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }))
  await idle.connect(new StdioServerTransport())
  await new Promise<never>(() => {})
}

const text = (s: string) => ({ content: [{ type: 'text' as const, text: s }] })

/**
 * Run the verifier. Deliberately hostile to recursion:
 *   GOAL_JUDGE=1        -> the Stop hook no-ops inside this child
 *   --strict-mcp-config -> the child loads NO mcp servers (including this one)
 *   disableAllHooks     -> belt and braces on the hook side
 */
function verify(condition: string, evidence: string): { met: boolean; reason: string } {
  const model = process.env.GOAL_VERIFY_MODEL || 'claude-sonnet-5'
  // The judge is a full `claude -p` with file access, so on a real claim it goes and READS things —
  // git refs, the changed files, the deployed copy. That thoroughness is the point (it caught nothing
  // wrong here, but it independently re-derived every claim), and it is also slow. 120s timed out a
  // legitimate verification live on 2026-07-24. Default 5 min, overridable.
  const timeoutMs = Number(process.env.GOAL_VERIFY_TIMEOUT_MS) || 300_000
  try {
    const res = spawnSync(
      'claude',
      ['-p', buildJudgePrompt(condition, evidence),
       '--model', model,
       '--strict-mcp-config',
       '--settings', JSON.stringify({ disableAllHooks: true })],
      {
        encoding: 'utf8',
        timeout: timeoutMs,
        env: { ...process.env, GOAL_JUDGE: '1', VOX_PLUGINS_ENABLED: '0' },
      },
    )
    if (res.error) {
      const timedOut = /ETIMEDOUT/i.test(res.error.message)
      return { met: false, reason: timedOut
        ? `the verifier TIMED OUT after ${Math.round(timeoutMs / 1000)}s — this is NOT a judgement on your evidence. `
          + `Do not rewrite it; retry, or raise GOAL_VERIFY_TIMEOUT_MS. Long evidence makes the judge read more files and take longer.`
        : `verifier failed to run: ${res.error.message}` }
    }
    if (res.status !== 0) return { met: false, reason: `verifier exited ${res.status}: ${(res.stderr || '').slice(0, 300)}` }
    return parseVerdict(res.stdout || '')
  } catch (err) {
    // Fail CLOSED on verification (unlike the hook, which fails open): if we can't check the
    // claim, we don't get to call the goal met.
    return { met: false, reason: `verifier error: ${err instanceof Error ? err.message : String(err)}` }
  }
}

const server = new Server({ name: 'goal', version: '0.1.0' }, { capabilities: { tools: {} } })

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'set_goal',
      description:
        'Set yourself a goal. Until it is completed or abandoned, the Stop hook refuses to let the ' +
        'session end and hands you back the goal each time you try to stop. Use for work you want to ' +
        'push through to a finish. Caps are enforced: it auto-releases at max_iterations, at the ' +
        'deadline, or if the kill file appears.',
      inputSchema: {
        type: 'object',
        properties: {
          condition: { type: 'string', description: 'What must be true for this to be done. Be specific and checkable — it gets verified against evidence later.' },
          max_iterations: { type: 'number', description: `How many refused stops before it gives up (default 12, hard ceiling ${ITERATION_CEILING}).` },
          deadline_minutes: { type: 'number', description: `Wall-clock budget (default 30, hard ceiling ${DEADLINE_CEILING_MINUTES}).` },
        },
        required: ['condition'],
      },
    },
    {
      name: 'goal_status',
      description: 'Report the active goal, how many iterations it has burned, and how long is left.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'complete_goal',
      description:
        'Claim the goal is done. Requires concrete evidence (commands run and their output, files ' +
        'changed, test counts). The claim is VERIFIED by a separate judge — vague evidence is ' +
        'rejected and the goal stays open, so do not call this hopefully.',
      inputSchema: {
        type: 'object',
        properties: {
          evidence: { type: 'string', description: 'Concrete, checkable proof the condition is satisfied.' },
        },
        required: ['evidence'],
      },
    },
    {
      name: 'abandon_goal',
      description:
        'Give up on the goal with a reason (the "impossible" escape). Use when the goal cannot be ' +
        'met — blocked, misjudged, or wrong — instead of burning iterations against a wall.',
      inputSchema: {
        type: 'object',
        properties: { reason: { type: 'string', description: 'Why it cannot be done.' } },
        required: ['reason'],
      },
    },
  ],
}))

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const name = req.params.name
  const args = (req.params.arguments ?? {}) as Record<string, unknown>
  const now = Date.now()

  if (name === 'set_goal') {
    const condition = String(args.condition ?? '').trim()
    if (!condition) return text('set_goal needs a condition.')
    const existing = readState()
    if (existing) return text(`A goal is already active — complete or abandon it first.\n${describe(existing, now)}`)
    clearKill()   // a stale kill file must not instantly release the new goal
    const state = newGoal(condition, {
      maxIterations: args.max_iterations as number | undefined,
      deadlineMinutes: args.deadline_minutes as number | undefined,
      sessionId: process.env.CLAUDE_SESSION_ID ?? null,
    }, now)
    writeState(state)
    return text(
      `Goal set: "${state.condition}"\n` +
      `Stops are now blocked until it is met. Caps: ${state.maxIterations} iterations, ` +
      `${Math.round((state.deadlineAt! - now) / 60000)} minutes.\n` +
      `Release early with abandon_goal, or externally: touch ${killPath()}`,
    )
  }

  if (name === 'goal_status') {
    const state = readState()
    const d = state ? decideStop(state, now, isKilled()) : null
    return text(
      describe(state, now) +
      (d && d.action === 'release' ? `\n(would release on next stop: ${d.outcome})` : '') +
      `\nstate: ${statePath()}`,
    )
  }

  if (name === 'complete_goal') {
    const state = readState()
    if (!state) return text('No active goal to complete.')
    const evidence = String(args.evidence ?? '').trim()
    if (!evidence) return text('complete_goal needs evidence. The claim is verified — an empty one will just be rejected.')

    // Mark verifying so a stop landing mid-judgement doesn't also count an iteration.
    writeState({ ...state, verifying: true })
    const verdict = verify(state.condition, evidence)

    if (verdict.met) {
      writeState(null)
      recordOutcome(state, 'met', verdict.reason)
      return text(`Goal MET after ${state.iterations} iteration(s): "${state.condition}"\nVerifier: ${verdict.reason}\nStops are unblocked.`)
    }
    writeState({ ...state, verifying: false, lastReason: verdict.reason })
    return text(
      `Goal NOT met — the verifier rejected the claim: ${verdict.reason}\n` +
      `The goal stays open. Keep working, or abandon_goal if it genuinely cannot be done.`,
    )
  }

  if (name === 'abandon_goal') {
    const state = readState()
    if (!state) return text('No active goal to abandon.')
    const reason = String(args.reason ?? '').trim() || 'no reason given'
    writeState(null)
    recordOutcome(state, 'abandoned', reason)
    return text(`Goal abandoned after ${state.iterations} iteration(s): "${state.condition}"\nReason: ${reason}\nStops are unblocked. It was NOT met — say so.`)
  }

  return text(`unknown tool: ${name}`)
})

await server.connect(new StdioServerTransport())
