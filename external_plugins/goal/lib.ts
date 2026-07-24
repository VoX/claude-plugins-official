/**
 * Pure logic for the goal plugin. Everything that decides anything lives here so it can be
 * unit-tested without a Claude session, an MCP transport, or a hook process.
 *
 * The model is a port of how Claude Code's own /goal works (read out of the 2.1.219 binary):
 * an active goal registers a Stop hook; each time the agent tries to stop, the hook either
 * BLOCKS (feeding back why the goal isn't done, so work continues) or lets the stop through.
 * Real /goal tracks iterations/duration/tokens and has an "impossible" escape so a goal that
 * can't be met fails loudly instead of grinding forever. Same shape here.
 */

export type GoalOutcome = 'met' | 'abandoned' | 'max_iterations' | 'deadline' | 'killed'

export interface GoalState {
  condition: string
  setAt: number            // epoch ms
  iterations: number       // how many stops we've blocked so far
  maxIterations: number
  deadlineAt: number | null // epoch ms, null = no wall-clock limit
  lastReason: string | null // why the last stop was refused / last verdict
  sessionId: string | null
  /** Set while complete_goal is being judged, so a concurrent Stop doesn't double-count. */
  verifying?: boolean
  /**
   * How many user-visible messages have already gone out this turn (reply/bulk_reply/send_embed/...).
   * Channel-bot specific hazard, caught by BMO 2026-07-24: for a bot on Discord/Slack, SENDING and
   * STOPPING are different events. A blocked stop after an already-sent reply invites a SECOND reply,
   * and a stream of them if the judge keeps rejecting -- i.e. the goal plugin spams the human it is
   * working for. Tracked by a PreToolUse hook, reset each new user turn.
   */
  spokeThisTurn?: number
}

/** What the Stop hook should do. `release` means the goal ends WITHOUT being met. */
export type StopDecision =
  | { action: 'allow' }
  | { action: 'block'; reason: string; nextIterations: number }
  | { action: 'release'; outcome: Exclude<GoalOutcome, 'met' | 'abandoned'>; message: string }

export const DEFAULT_MAX_ITERATIONS = 12
export const DEFAULT_DEADLINE_MINUTES = 30
/** Hard ceiling regardless of what the caller asks for -- this thing runs unattended. */
export const ITERATION_CEILING = 50
export const DEADLINE_CEILING_MINUTES = 240

export function clampMaxIterations(requested?: number | null): number {
  if (requested == null || !Number.isFinite(requested)) return DEFAULT_MAX_ITERATIONS
  return Math.max(1, Math.min(ITERATION_CEILING, Math.floor(requested)))
}

export function clampDeadlineMinutes(requested?: number | null): number {
  if (requested == null || !Number.isFinite(requested)) return DEFAULT_DEADLINE_MINUTES
  return Math.max(1, Math.min(DEADLINE_CEILING_MINUTES, Math.floor(requested)))
}

/**
 * The core rule. Given the current goal (or none) decide whether this stop is allowed.
 *
 * Ordering matters and is deliberate: every RELEASE condition is checked before we block.
 * A blocking Stop hook with no human watching is exactly how an agent wedges itself, so the
 * escape hatches always win over "keep working".
 */
export function decideStop(
  state: GoalState | null,
  now: number,
  killed = false,
): StopDecision {
  if (!state) return { action: 'allow' }

  // A goal mid-verification must not also be blocked by the hook -- complete_goal is already
  // deciding its fate, and double-counting would inflate iterations.
  if (state.verifying) return { action: 'allow' }

  if (killed) {
    return {
      action: 'release',
      outcome: 'killed',
      message: `Goal released by kill switch after ${state.iterations} iteration(s): "${state.condition}"`,
    }
  }

  if (state.deadlineAt != null && now >= state.deadlineAt) {
    const mins = Math.round((now - state.setAt) / 60000)
    return {
      action: 'release',
      outcome: 'deadline',
      message: `Goal hit its ${mins}-minute deadline after ${state.iterations} iteration(s) and was released, NOT met: "${state.condition}". Say so plainly rather than implying it succeeded.`,
    }
  }

  if (state.iterations >= state.maxIterations) {
    return {
      action: 'release',
      outcome: 'max_iterations',
      message: `Goal hit its ${state.maxIterations}-iteration cap and was released, NOT met: "${state.condition}". Report what actually got done and what is still missing.`,
    }
  }

  const next = state.iterations + 1
  const remaining = state.maxIterations - next
  const last = state.lastReason ? `\nLast verdict: ${state.lastReason}` : ''
  // See GoalState.spokeThisTurn. Without this the natural move after a blocked stop is to reply
  // again, so one request turns into up to max_iterations messages at the human.
  const spoke = state.spokeThisTurn ?? 0
  const silence = spoke > 0
    ? `\n\nYOU HAVE ALREADY SENT ${spoke} message(s) to the channel this turn. Do NOT send another ` +
      `now — keep working SILENTLY. Speak again only when the goal completes, is abandoned, or is ` +
      `released, and then send ONE message. A blocked stop is not a new turn.`
    : ''
  return {
    action: 'block',
    nextIterations: next,
    reason:
      `You set yourself this goal and it is not finished:\n\n  ${state.condition}\n` +
      last +
      silence +
      `\n\nKeep working on it. When it is genuinely done call complete_goal with concrete evidence ` +
      `(what you changed, what you ran, what the output was) — the claim gets verified, so vague ` +
      `evidence will be rejected and cost you an iteration. If it cannot be done, call abandon_goal ` +
      `with the reason instead of looping.\n` +
      `(iteration ${next}/${state.maxIterations}, ${remaining} left before it auto-releases)`,
  }
}

export function newGoal(
  condition: string,
  opts: { maxIterations?: number | null; deadlineMinutes?: number | null; sessionId?: string | null },
  now: number,
): GoalState {
  const deadlineMinutes = clampDeadlineMinutes(opts.deadlineMinutes)
  return {
    condition: condition.trim(),
    setAt: now,
    iterations: 0,
    maxIterations: clampMaxIterations(opts.maxIterations),
    deadlineAt: now + deadlineMinutes * 60000,
    lastReason: null,
    sessionId: opts.sessionId ?? null,
    verifying: false,
  }
}

/** One-line human summary, used by goal_status and the release messages. */
export function describe(state: GoalState | null, now: number): string {
  if (!state) return 'No active goal.'
  const age = Math.round((now - state.setAt) / 1000)
  const left = state.deadlineAt != null ? Math.max(0, Math.round((state.deadlineAt - now) / 60000)) : null
  return (
    `Active goal: "${state.condition}" — iteration ${state.iterations}/${state.maxIterations}, ` +
    `${age}s elapsed` +
    (left != null ? `, ${left}min before deadline` : '') +
    (state.lastReason ? `. Last verdict: ${state.lastReason}` : '')
  )
}

/**
 * Parse the judge's answer. Approach (c): the agent self-reports completion with evidence and
 * ONLY that final claim is verified, so this has to be strict -- a judge that says anything
 * other than a clean MET is treated as not met.
 */
export function parseVerdict(raw: string): { met: boolean; reason: string } {
  const text = (raw ?? '').trim()
  if (!text) return { met: false, reason: 'verifier returned nothing' }

  // Scan EVERY line for a verdict, not just the first. Found live 2026-07-24: the judge wrote a
  // sentence of preamble and put "MET — ..." on the second line, so a first-line-only check scored
  // a genuine pass as a failure. Instructing the judge not to do that is not enough on its own --
  // it's a language model, so the parser has to tolerate it.
  //
  // Markdown is stripped first because judges like to bold the verdict (**MET**).
  const lines = text.split('\n').map((l) => l.trim().replace(/^[*_`#>\s-]+/, '')).filter(Boolean)
  const notMet = lines.some((l) => /^NOT[_\s-]?MET\b/i.test(l))
  const metLine = lines.find((l) => /^MET\b/i.test(l))

  // Fail CLOSED and rejection-first: a NOT_MET anywhere beats a MET anywhere. A judge that hedges
  // both ways is not a pass, and "NOT_MET: ... the agent claimed MET" must never read as success.
  const met = !notMet && !!metLine

  const verdictLine = notMet
    ? lines.find((l) => /^NOT[_\s-]?MET\b/i.test(l))!
    : (metLine ?? lines[0])
  const reason = verdictLine.replace(/^NOT[_\s-]?MET\b[:\s—-]*/i, '').replace(/^MET\b[:\s—-]*/i, '').trim()
  return { met, reason: reason || verdictLine || text }
}

/** The prompt handed to the verifier subprocess. Kept here so it's testable and reviewable. */
export function buildJudgePrompt(condition: string, evidence: string): string {
  return [
    'You are verifying whether an agent actually completed a goal it set for itself.',
    'Be strict and skeptical. The agent is reporting on its own work, which is the failure mode you exist to catch.',
    '',
    `GOAL: ${condition}`,
    '',
    'EVIDENCE THE AGENT PROVIDED:',
    evidence,
    '',
    'Your reply MUST BEGIN with either MET or NOT_MET as the very first characters — no preamble, no',
    'restating the question, no markdown before it. Then a short reason on the same line.',
    'Answer MET only if the evidence contains something concrete and checkable (commands run and their output,',
    'files changed, tests passing with counts). Answer NOT_MET if the evidence is vague, asserts success without',
    'showing it, describes intent rather than result, or does not actually address the goal as written.',
  ].join('\n')
}
