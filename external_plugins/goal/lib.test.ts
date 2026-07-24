import { test, expect, describe as suite } from 'bun:test'
import {
  decideStop,
  newGoal,
  describe,
  parseVerdict,
  buildJudgePrompt,
  clampMaxIterations,
  clampDeadlineMinutes,
  ITERATION_CEILING,
  DEADLINE_CEILING_MINUTES,
  DEFAULT_MAX_ITERATIONS,
  type GoalState,
} from './lib'

const T0 = 1_700_000_000_000

function goal(over: Partial<GoalState> = {}): GoalState {
  return { ...newGoal('ship the thing', {}, T0), ...over }
}

suite('decideStop', () => {
  test('no goal -> the stop is allowed', () => {
    expect(decideStop(null, T0).action).toBe('allow')
  })

  test('active goal -> the stop is blocked and the iteration advances', () => {
    const d = decideStop(goal(), T0 + 1000)
    expect(d.action).toBe('block')
    if (d.action !== 'block') throw new Error('unreachable')
    expect(d.nextIterations).toBe(1)
    expect(d.reason).toContain('ship the thing')
  })

  test('the block text tells the agent both escape routes', () => {
    const d = decideStop(goal(), T0)
    if (d.action !== 'block') throw new Error('expected block')
    expect(d.reason).toContain('complete_goal')
    expect(d.reason).toContain('abandon_goal')
  })

  test('iteration cap releases instead of blocking forever', () => {
    const d = decideStop(goal({ iterations: 12, maxIterations: 12 }), T0)
    expect(d.action).toBe('release')
    if (d.action !== 'release') throw new Error('unreachable')
    expect(d.outcome).toBe('max_iterations')
  })

  test('deadline releases instead of blocking forever', () => {
    const g = goal({ deadlineAt: T0 + 60_000 })
    expect(decideStop(g, T0 + 59_000).action).toBe('block')
    const d = decideStop(g, T0 + 61_000)
    expect(d.action).toBe('release')
    if (d.action !== 'release') throw new Error('unreachable')
    expect(d.outcome).toBe('deadline')
  })

  test('kill switch releases even with iterations and time left', () => {
    const d = decideStop(goal(), T0, true)
    expect(d.action).toBe('release')
    if (d.action !== 'release') throw new Error('unreachable')
    expect(d.outcome).toBe('killed')
  })

  // The teeth: every escape hatch must beat "keep working". If this ordering ever inverts, an
  // unattended bot loops until something else kills it.
  test('release conditions win over blocking, even when all fire at once', () => {
    const g = goal({ iterations: 99, maxIterations: 12, deadlineAt: T0 - 1 })
    expect(decideStop(g, T0, true).action).toBe('release')
    expect(decideStop(g, T0, false).action).toBe('release')
  })

  test('release messages never imply the goal succeeded', () => {
    for (const g of [goal({ iterations: 12, maxIterations: 12 }), goal({ deadlineAt: T0 - 1 })]) {
      const d = decideStop(g, T0)
      if (d.action !== 'release') throw new Error('expected release')
      expect(d.message).toContain('NOT met')
    }
  })

  test('a goal mid-verification does not also get blocked (no double counting)', () => {
    expect(decideStop(goal({ verifying: true }), T0).action).toBe('allow')
  })
})

suite('spokeThisTurn (channel-bot spam guard)', () => {
  test('having said nothing, the block does not nag about silence', () => {
    const d = decideStop(goal({ spokeThisTurn: 0 }), T0)
    if (d.action !== 'block') throw new Error('expected block')
    expect(d.reason).not.toContain('ALREADY SENT')
  })

  // The teeth: without this, a blocked stop after a reply produces a SECOND reply, and one user
  // request turns into up to max_iterations messages at the human.
  test('having already replied, the block orders silence', () => {
    const d = decideStop(goal({ spokeThisTurn: 1 }), T0)
    if (d.action !== 'block') throw new Error('expected block')
    expect(d.reason).toContain('ALREADY SENT 1 message')
    expect(d.reason).toMatch(/SILENTLY|Do NOT send another/)
  })

  test('the count is reported so repeated spam is visible', () => {
    const d = decideStop(goal({ spokeThisTurn: 4 }), T0)
    if (d.action !== 'block') throw new Error('expected block')
    expect(d.reason).toContain('ALREADY SENT 4 message')
  })

  test('a blocked stop is explicitly NOT a new turn', () => {
    const d = decideStop(goal({ spokeThisTurn: 2 }), T0)
    if (d.action !== 'block') throw new Error('expected block')
    expect(d.reason).toContain('not a new turn')
  })

  test('undefined (pre-existing state files) is treated as not-yet-spoken', () => {
    const g = goal(); delete (g as any).spokeThisTurn
    const d = decideStop(g, T0)
    if (d.action !== 'block') throw new Error('expected block')
    expect(d.reason).not.toContain('ALREADY SENT')
  })
})

suite('caps', () => {
  test('defaults apply when unspecified', () => {
    expect(clampMaxIterations(null)).toBe(DEFAULT_MAX_ITERATIONS)
    expect(clampMaxIterations(undefined)).toBe(DEFAULT_MAX_ITERATIONS)
  })

  test('caller cannot exceed the hard ceilings', () => {
    expect(clampMaxIterations(9999)).toBe(ITERATION_CEILING)
    expect(clampDeadlineMinutes(99999)).toBe(DEADLINE_CEILING_MINUTES)
  })

  test('caller cannot disable the caps with zero or negatives', () => {
    expect(clampMaxIterations(0)).toBe(1)
    expect(clampMaxIterations(-5)).toBe(1)
    expect(clampDeadlineMinutes(0)).toBe(1)
    expect(clampDeadlineMinutes(-5)).toBe(1)
  })

  test('NaN falls back to the default rather than becoming an unbounded goal', () => {
    expect(clampMaxIterations(NaN)).toBe(DEFAULT_MAX_ITERATIONS)
    expect(clampDeadlineMinutes(NaN)).toBeGreaterThan(0)
  })

  test('a new goal always carries a deadline', () => {
    expect(newGoal('x', { deadlineMinutes: null }, T0).deadlineAt).toBeGreaterThan(T0)
  })
})

suite('parseVerdict', () => {
  test('MET is accepted', () => {
    const v = parseVerdict('MET: tests pass, 1422 green')
    expect(v.met).toBe(true)
    expect(v.reason).toContain('1422')
  })

  test('NOT_MET is rejected', () => {
    expect(parseVerdict('NOT_MET: no evidence of a test run').met).toBe(false)
  })

  test('anything unparseable is treated as NOT met (fail closed)', () => {
    expect(parseVerdict('').met).toBe(false)
    expect(parseVerdict('probably fine?').met).toBe(false)
    expect(parseVerdict('the agent seems to have done it').met).toBe(false)
  })

  test('"MET" must lead -- a mention later in the text does not count', () => {
    expect(parseVerdict('NOT_MET: the goal was not MET at all').met).toBe(false)
  })

  // Regression, found LIVE on the first real goal: the judge wrote a sentence of preamble and put
  // "MET — ..." on a later line. A first-line-only check scored a genuine pass as a failure and the
  // goal stayed open. Unit tests all fed a first-line verdict, so nothing caught it.
  test('a verdict on a LATER line still counts (judge wrote a preamble)', () => {
    const real = [
      'The deployed copy has the identical real implementation, not a stub. Every checkable claim verified.',
      '',
      'MET — every checkable claim verified independently: git refs show the commit pushed.',
    ].join('\n')
    const v = parseVerdict(real)
    expect(v.met).toBe(true)
    expect(v.reason).toContain('every checkable claim verified')
  })

  test('a bolded verdict counts (**MET**)', () => {
    expect(parseVerdict('**MET** — tests pass').met).toBe(true)
    expect(parseVerdict('**NOT_MET** — no evidence').met).toBe(false)
  })

  // Fail closed: a hedging judge is not a pass, whichever order the two verdicts appear in.
  test('NOT_MET anywhere beats MET anywhere', () => {
    expect(parseVerdict('MET on the code change.\nNOT_MET on the deploy.').met).toBe(false)
    expect(parseVerdict('NOT_MET on the deploy.\nMET on the code change.').met).toBe(false)
  })

  test('prose with no verdict line at all is still NOT met', () => {
    expect(parseVerdict('It looks like the agent did the work correctly and thoroughly.').met).toBe(false)
  })

  test('NOT-MET and NOT MET spellings are caught too', () => {
    expect(parseVerdict('NOT-MET: nope').met).toBe(false)
    expect(parseVerdict('NOT MET: nope').met).toBe(false)
  })
})

suite('buildJudgePrompt', () => {
  test('carries the goal and the evidence, and tells the judge to be strict', () => {
    const p = buildJudgePrompt('make tests pass', 'ran ./test.sh, 1422 passed')
    expect(p).toContain('make tests pass')
    expect(p).toContain('1422 passed')
    expect(p).toMatch(/strict|skeptical/i)
    expect(p).toContain('MET')
  })
})

suite('describe', () => {
  test('reports no goal', () => {
    expect(describe(null, T0)).toContain('No active goal')
  })
  test('reports progress against the cap', () => {
    const s = describe(goal({ iterations: 3 }), T0 + 5000)
    expect(s).toContain('3/12')
    expect(s).toContain('ship the thing')
  })
})
