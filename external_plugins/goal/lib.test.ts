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
