import { test, expect, describe } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Spawn the real PreToolUse[Bash] classifier with a given command on stdin and return the label
// it appended to the per-turn sequence file (or '' if it wrote nothing). This exercises the whole
// segment-parse → verb-bucket path end to end, including the git-subcommand fix (4c).
const SCRIPT = join(import.meta.dir, 'presence-bash.sh')

function classify(command: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'presence-'))
  try {
    Bun.spawnSync(['bash', SCRIPT], {
      stdin: new TextEncoder().encode(JSON.stringify({ tool_input: { command } })),
      env: { ...process.env, DISCORD_PRESENCE_ACTIVITY: '1', DISCORD_STATE_DIR: dir },
    })
    const f = join(dir, '.presence-activity')
    if (!existsSync(f)) return ''
    const lines = readFileSync(f, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean)
    return lines[lines.length - 1] ?? ''
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('presence-bash classifier', () => {
  test('git push → pushing', () => expect(classify('git push origin master')).toContain('pushing'))
  test('git commit → committing', () => expect(classify('git commit -m "x"')).toContain('committing'))
  test('git log → searching (inspect, not run git)', () => expect(classify('git log --oneline -5')).toContain('searching'))
  test('git clone → fetching', () => expect(classify('git clone https://x')).toContain('fetching'))

  // 4c regression: a substring "git push" inside a read-only command must NOT report a push.
  test('grep "git push" → searching, NOT pushing', () => {
    const out = classify('grep -rn "git push" .')
    expect(out).toContain('searching')
    expect(out).not.toContain('pushing')
  })
  test('echo "git commit" → not committing', () => {
    expect(classify('echo "did you git commit?"')).not.toContain('committing')
  })

  test('cat → reading', () => expect(classify('cat file.txt')).toContain('reading'))
  test('sed -n range → reading', () => expect(classify("sed -n '1,20p' file")).toContain('reading'))
  test('grep → searching', () => expect(classify('grep -i foo bar.js')).toContain('searching'))
  test('rightmost segment wins (head && grep → searching)', () =>
    expect(classify('head -5 a.txt && grep foo b.txt')).toContain('searching'))

  test('npm ci → installing', () => expect(classify('cd /x && npm ci')).toContain('installing'))
  test('npm test → testing', () => expect(classify('npm test')).toContain('testing'))
  test('npm run build → building', () => expect(classify('npm run build')).toContain('building'))
  test('make → building', () => expect(classify('make')).toContain('building'))
  test('cargo test → testing', () => expect(classify('cargo test')).toContain('testing'))
  test('pytest → testing', () => expect(classify('pytest -q')).toContain('testing'))
  test('curl → fetching', () => expect(classify('curl -s https://example.com')).toContain('fetching'))
  test('pip install → installing', () => expect(classify('pip install requests')).toContain('installing'))
  test('systemctl → ops', () => expect(classify('sudo systemctl restart x')).toContain('ops'))

  // Distinctive commands keep their name — the residual "run <cmd>" is now a signal, not noise.
  test('a shell script → run <name>', () => {
    const out = classify('./deploy.sh --prod')
    expect(out).toContain('run')
    expect(out).toContain('deploy.sh')
  })
  test('a python script → run python3', () => expect(classify('python3 build.py')).toContain('python3'))

  // echo is skipped in favor of the real work on a chain…
  test('cd /x && npm ci && echo done → installing (echo skipped)', () =>
    expect(classify('cd /x && npm ci && echo done')).toContain('installing'))
  // …but a bare cd writes nothing (status held).
  test('bare cd → no write', () => expect(classify('cd /home/ec2-user')).toBe(''))
})
