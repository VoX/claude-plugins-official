import { test, expect, describe } from 'bun:test'
import {
  safeSlice, formatSendResult, assertEmbedUrl, chunk, buildEmbedFromArgs, composePresence, withContextPrefix,
  resolveColorInput, validatePermissionNames, kindToChannelType, channelTypeToKind,
  buildServerSpec, computeSpecDiff, renderSpecDiff, overwriteEditMap, grantGroup, removeGroup, makeTtlCache,
  normalizeLookupQuery, clampLookupLimit, lookupNameMatches, lookupRank,
  grantDm, removeDm,
  type RawGuildState, type ServerSpec } from './lib'

describe('safeSlice', () => {
  test('returns input unchanged when shorter than limit', () => {
    expect(safeSlice('hello', 10)).toBe('hello')
  })

  test('returns input unchanged when exactly at limit', () => {
    expect(safeSlice('hello', 5)).toBe('hello')
  })

  test('truncates plain ASCII at codepoint limit', () => {
    expect(safeSlice('abcdef', 3)).toBe('abc')
  })

  test('preserves multi-codepoint emoji (no lone surrogate)', () => {
    // 🦝 is U+1F99D — two UTF-16 code units. Slice at 4 in code units would
    // strand a lone surrogate; safeSlice slices at 4 codepoints instead.
    const out = safeSlice('abc🦝def', 4)
    expect(out).toBe('abc🦝')
    // No lone surrogate: every char in [0xd800,0xdfff] must be paired.
    for (let i = 0; i < out.length; i++) {
      const code = out.charCodeAt(i)
      if (code >= 0xd800 && code <= 0xdbff) {
        const next = out.charCodeAt(i + 1)
        expect(next >= 0xdc00 && next <= 0xdfff).toBe(true)
        i++
      } else {
        expect(code >= 0xdc00 && code <= 0xdfff).toBe(false)
      }
    }
  })

  test('handles trailing-emoji-with-200-cap regression (the ulant case)', () => {
    // Build a 209-codepoint string with a non-BMP emoji that would land mid-pair
    // under raw `.slice(0, 200)` (UTF-16 code units). safeSlice picks the
    // codepoint after the emoji, keeping it intact.
    const str = 'm '.repeat(99) + '🦝 trailing'
    const out = safeSlice(str, 200)
    // 200 codepoints: 198 ('m ' × 99) + 🦝 + ' '
    expect(out).toBe('m '.repeat(99) + '🦝 ')
    expect(Array.from(out).length).toBe(200)
    // Round-trip JSON: a lone surrogate would corrupt the parse.
    expect(() => JSON.parse(JSON.stringify(out))).not.toThrow()
  })

  test('empty string is passthrough', () => {
    expect(safeSlice('', 10)).toBe('')
  })

  test('zero limit returns empty string', () => {
    expect(safeSlice('abc', 0)).toBe('')
  })

  test('JSON round-trip survives many adjacent emoji', () => {
    const out = safeSlice('🦝🫡🐧🦊🦝🫡🐧🦊', 5)
    expect(out).toBe('🦝🫡🐧🦊🦝')
    expect(() => JSON.parse(JSON.stringify(out))).not.toThrow()
  })
})

describe('formatSendResult', () => {
  test('single id uses singular phrasing', () => {
    expect(formatSendResult(['123'])).toBe('sent (id: 123)')
  })

  test('multiple ids include count and join', () => {
    expect(formatSendResult(['1', '2', '3'])).toBe('sent 3 parts (ids: 1, 2, 3)')
  })
})

describe('assertEmbedUrl', () => {
  test('accepts http URLs', () => {
    expect(() => assertEmbedUrl('url', 'http://example.com')).not.toThrow()
  })

  test('accepts https URLs', () => {
    expect(() => assertEmbedUrl('url', 'https://example.com/path?x=1')).not.toThrow()
  })

  test('accepts case-insensitive scheme', () => {
    expect(() => assertEmbedUrl('url', 'HTTPS://example.com')).not.toThrow()
  })

  test('rejects javascript: scheme', () => {
    expect(() => assertEmbedUrl('url', 'javascript:alert(1)')).toThrow(/must be an http\(s\) URL/)
  })

  test('rejects data: scheme', () => {
    expect(() => assertEmbedUrl('url', 'data:text/html,<script>alert(1)</script>')).toThrow(/must be an http\(s\) URL/)
  })

  test('rejects file: scheme', () => {
    expect(() => assertEmbedUrl('url', 'file:///etc/passwd')).toThrow(/must be an http\(s\) URL/)
  })

  test('rejects schemeless URL', () => {
    expect(() => assertEmbedUrl('url', 'example.com')).toThrow(/must be an http\(s\) URL/)
  })

  test('rejects empty string', () => {
    expect(() => assertEmbedUrl('url', '')).toThrow(/must be an http\(s\) URL/)
  })

  test('error message JSON-quotes the bad value', () => {
    try {
      assertEmbedUrl('url', 'javascript:alert(1)')
      throw new Error('expected throw')
    } catch (e: any) {
      expect(e.message).toContain('"javascript:alert(1)"')
    }
  })

  test('error message includes the field name', () => {
    expect(() => assertEmbedUrl('thumbnail_url', 'bad'))
      .toThrow(/^thumbnail_url /)
  })
})

describe('buildEmbedFromArgs', () => {
  test('empty args returns empty embed (no throw)', () => {
    expect(() => buildEmbedFromArgs({})).not.toThrow()
  })

  test('basic embed sets fields via discord.js EmbedBuilder', () => {
    const e = buildEmbedFromArgs({ title: 'hi', description: 'body' })
    const json = e.toJSON()
    expect(json.title).toBe('hi')
    expect(json.description).toBe('body')
  })

  test('rejects javascript: url', () => {
    expect(() => buildEmbedFromArgs({ url: 'javascript:alert(1)' }))
      .toThrow(/url must be an http\(s\) URL/)
  })

  test('rejects javascript: thumbnail_url', () => {
    expect(() => buildEmbedFromArgs({ thumbnail_url: 'javascript:alert(1)' }))
      .toThrow(/thumbnail_url must be an http\(s\) URL/)
  })

  test('rejects more than 25 fields', () => {
    const fields = Array.from({ length: 26 }, (_, i) => ({ name: `f${i}`, value: `v${i}` }))
    expect(() => buildEmbedFromArgs({ fields }))
      .toThrow(/max 25 embed fields \(got 26\)/)
  })

  test('rejects field missing name or value', () => {
    expect(() => buildEmbedFromArgs({ fields: [{ name: 'ok', value: 'ok' }, { name: 'bad' }] }))
      .toThrow(/field\[1\] missing name or value/)
  })

  test('rejects invalid color', () => {
    expect(() => buildEmbedFromArgs({ color: 'not-a-color' }))
      .toThrow(/invalid color/)
  })

  test('accepts named color (case-insensitive)', () => {
    expect(() => buildEmbedFromArgs({ color: 'blurple' })).not.toThrow()
    expect(() => buildEmbedFromArgs({ color: 'BLURPLE' })).not.toThrow()
    expect(() => buildEmbedFromArgs({ color: 'Blurple' })).not.toThrow()
  })

  test('accepts hex color with and without hash', () => {
    expect(() => buildEmbedFromArgs({ color: '#5865f2' })).not.toThrow()
    expect(() => buildEmbedFromArgs({ color: '5865f2' })).not.toThrow()
  })

  test('rejects invalid timestamp', () => {
    expect(() => buildEmbedFromArgs({ timestamp: 'not-a-date' }))
      .toThrow(/invalid timestamp/)
  })

  test('accepts timestamp:true (now)', () => {
    expect(() => buildEmbedFromArgs({ timestamp: true })).not.toThrow()
  })

  test('accepts ISO-8601 timestamp', () => {
    expect(() => buildEmbedFromArgs({ timestamp: '2026-04-28T00:00:00Z' })).not.toThrow()
  })

  test('truncates oversized title via safeSlice', () => {
    const longTitle = 'x'.repeat(1000)
    const e = buildEmbedFromArgs({ title: longTitle })
    expect(e.toJSON().title!.length).toBe(256)
  })
})

describe('chunk', () => {
  test('short text returns single chunk', () => {
    expect(chunk('hello world', 100)).toEqual(['hello world'])
  })

  test('cuts at paragraph boundary when available', () => {
    const text = 'line 1\nline 2\n\nline 3 is in para two'
    const out = chunk(text, 16)
    expect(out[0]).toBe('line 1\nline 2')
    expect(out[1]).toBe('line 3 is in')
    // Only assert essentials — third chunk content depends on cut algo
    expect(out.length).toBeGreaterThan(1)
  })

  test('cuts at line boundary when no paragraph break', () => {
    const out = chunk('hello\nworld how are you', 11)
    expect(out[0]).toBe('hello')
    expect(out[1]).toBe('world how')
    expect(out[2]).toBe('are you')
  })

  test('cuts at space boundary when no line break', () => {
    const out = chunk('the quick brown fox', 10)
    expect(out[0]).toBe('the quick')
    expect(out[1]).toBe('brown fox')
  })

  test('hard-cuts at limit when no whitespace exists', () => {
    const out = chunk('aaaaaaaaaa', 4)
    expect(out).toEqual(['aaaa', 'aaaa', 'aa'])
  })

  test('strips leading whitespace from continuation chunks', () => {
    const out = chunk('hello world', 5)
    expect(out[1]).toBe('world')
    expect(out[1].startsWith(' ')).toBe(false)
  })
})

describe('withContextPrefix', () => {
  test('prefixes the context size onto a status', () => {
    expect(withContextPrefix('565k', '💤 idle…')).toBe('565k - 💤 idle…')
    expect(withContextPrefix('242k', '🐾 working…')).toBe('242k - 🐾 working…')
  })
  test('empty context leaves the status unchanged (unknown / turn 1)', () => {
    expect(withContextPrefix('', '💤 idle…')).toBe('💤 idle…')
  })
  test('empty status stays empty (a clear stays a clear, no stray prefix)', () => {
    expect(withContextPrefix('565k', '')).toBe('')
    expect(withContextPrefix('', '')).toBe('')
  })
})

describe('composePresence', () => {
  test('aggregates distinct actions in first-occurrence order, drops working', () => {
    expect(composePresence('🐾 working…\n📖 reading…\n✏️ editing…\n')).toBe('📖 reading ✏️ editing…')
  })
  test('working shown only when it is the sole entry', () => {
    expect(composePresence('🐾 working…\n')).toBe('🐾 working…')
  })
  test('dedupes repeated actions', () => {
    expect(composePresence('🐾 working…\n📖 reading…\n📖 reading…\n✏️ editing…\n')).toBe('📖 reading ✏️ editing…')
  })
  test('keeps first-occurrence order when an action repeats later', () => {
    expect(composePresence('🐾 working…\n📖 reading…\n✏️ editing…\n📖 reading…\n')).toBe('📖 reading ✏️ editing…')
  })
  test('full chain of distinct actions', () => {
    expect(composePresence('🐾 working…\n📖 reading…\n✏️ editing…\n💾 committing…\n⬆️ pushing…\n'))
      .toBe('📖 reading ✏️ editing 💾 committing ⬆️ pushing…')
  })
  test('idle is unique', () => {
    expect(composePresence('💤 idle…\n')).toBe('💤 idle…')
  })
  test('idle overrides any accumulated actions (terminal)', () => {
    expect(composePresence('🐾 working…\n📖 reading…\n💤 idle…\n')).toBe('💤 idle…')
  })
  test('empty / absent -> empty (resting, no text)', () => {
    expect(composePresence('')).toBe('')
    expect(composePresence('\n\n')).toBe('')
  })
  test('idle rests only when it is the LAST line (terminal)', () => {
    expect(composePresence('🐾 working…\n📖 reading…\n💤 idle…\n')).toBe('💤 idle…')
  })
  test('a tool append AFTER idle (race) shows the work, not idle', () => {
    // Stop hook wrote idle, then an in-flight tool appended — work continued.
    expect(composePresence('🐾 working…\n📖 reading…\n💤 idle…\n✏️ editing…\n')).toBe('📖 reading ✏️ editing…')
  })
  test('drops a stray mid-sequence idle, keeps all actions', () => {
    expect(composePresence('📖 reading…\n💤 idle…\n⚙️ running…\n')).toBe('📖 reading ⚙️ running…')
  })
  test('the live-poison shape (idle first, work after) recovers to active', () => {
    expect(composePresence('💤 idle…\n🤝 delegating…\n📖 reading…\n📖 reading…\n')).toBe('🤝 delegating 📖 reading…')
  })
  test('a "run <name>" label whose name is idle/working is NOT a sentinel (emoji-matched)', () => {
    expect(composePresence('🐾 working…\n⚙️ run idle…\n')).toBe('⚙️ run idle…')
    expect(composePresence('🐾 working…\n⚙️ run working…\n')).toBe('⚙️ run working…')
  })
})

describe('resolveColorInput', () => {
  test('resolves hex with and without hash', () => {
    expect(resolveColorInput('#5865f2')).toBe(0x5865f2)
    expect(resolveColorInput('5865f2')).toBe(0x5865f2)
  })

  test('resolves named colors case-insensitively', () => {
    expect(resolveColorInput('blurple')).toBe(resolveColorInput('Blurple'))
    expect(resolveColorInput('BLURPLE')).toBe(resolveColorInput('Blurple'))
  })

  test('throws on garbage', () => {
    expect(() => resolveColorInput('not-a-color')).toThrow(/invalid color/)
  })
})

describe('validatePermissionNames', () => {
  test('valid names pass through', () => {
    expect(validatePermissionNames(['ViewChannel', 'SendMessages', 'BanMembers'], 'test'))
      .toEqual(['ViewChannel', 'SendMessages', 'BanMembers'])
  })

  test('unknown name throws with the name and context in the message', () => {
    expect(() => validatePermissionNames(['ViewChannel', 'NotAPerm'], 'role "Mod"'))
      .toThrow(/role "Mod".*NotAPerm/)
  })

  test('prototype-chain keys are rejected (Object.hasOwn, not `in`)', () => {
    expect(() => validatePermissionNames(['constructor'], 'test')).toThrow(/unknown permission/)
  })
})

describe('channel kind mapping', () => {
  test('round-trips every supported kind', () => {
    for (const kind of ['text', 'voice', 'announcement', 'forum', 'stage']) {
      expect(channelTypeToKind(kindToChannelType(kind))).toBe(kind)
    }
  })

  test('unknown kind throws', () => {
    expect(() => kindToChannelType('carrier-pigeon')).toThrow(/unknown channel kind/)
  })

  test('unsupported channel types map to null', () => {
    expect(channelTypeToKind(4)).toBe(null)   // GuildCategory — not a leaf kind
    expect(channelTypeToKind(14)).toBe(null)  // GuildDirectory
  })
})

// Shared fixture: a small guild with one category, two channels, a couple of
// roles (one managed), and overwrites on the category + text channel.
function fixtureState(): RawGuildState {
  return {
    guildId: 'g1',
    everyonePermissions: ['ViewChannel', 'SendMessages'],
    roles: [
      { id: 'r1', name: 'Mod', hexColor: '#5865f2', hoist: true, mentionable: false, permissions: ['KickMembers', 'ViewChannel'], position: 2, managed: false },
      { id: 'r2', name: 'Member', hexColor: '#000000', hoist: false, mentionable: true, permissions: ['ViewChannel'], position: 1, managed: false },
      { id: 'r3', name: 'SomeBot', hexColor: '#000000', hoist: false, mentionable: false, permissions: ['Administrator'], position: 3, managed: true },
    ],
    channels: [
      { id: 'c1', name: 'Staff', type: 4, parentId: null, position: 0, topic: null, rateLimitPerUser: null, nsfw: false,
        overwrites: [{ id: 'g1', type: 'role', allow: [], deny: ['ViewChannel'] }] },
      { id: 'c2', name: 'mod-log', type: 0, parentId: 'c1', position: 0, topic: 'mod actions', rateLimitPerUser: 30, nsfw: false,
        overwrites: [{ id: 'r1', type: 'role', allow: ['ViewChannel'], deny: [] }, { id: 'u9', type: 'member', allow: [], deny: [] }] },
      { id: 'c3', name: 'lobby', type: 0, parentId: null, position: 1, topic: null, rateLimitPerUser: 0, nsfw: false, overwrites: [] },
    ],
  }
}

describe('buildServerSpec', () => {
  const spec = buildServerSpec(fixtureState())

  test('serializes @everyone permissions sorted', () => {
    expect(spec.everyone_permissions).toEqual(['SendMessages', 'ViewChannel'])
  })

  test('excludes managed roles, sorts by position (highest first)', () => {
    expect(spec.roles!.map(r => r.name)).toEqual(['Mod', 'Member'])
  })

  test('serializes role fields, omitting defaults', () => {
    const mod = spec.roles![0]!
    expect(mod).toEqual({ name: 'Mod', id: 'r1', color: '#5865f2', hoist: true, permissions: ['KickMembers', 'ViewChannel'], position: 2 })
    const member = spec.roles![1]!
    expect(member.color).toBeUndefined()   // #000000 = no color
    expect(member.hoist).toBeUndefined()
    expect(member.mentionable).toBe(true)
  })

  test('emits the Discord snowflake as id on roles, categories, and channels', () => {
    expect(spec.roles!.map(r => r.id)).toEqual(['r1', 'r2'])
    expect(spec.categories![0]!.id).toBe('c1')
    expect(spec.categories![0]!.channels![0]!.id).toBe('c2')
    expect(spec.channels![0]!.id).toBe('c3')
  })

  test('nests channels under their category, keeps top-level channels separate', () => {
    expect(spec.categories!.map(c => c.name)).toEqual(['Staff'])
    expect(spec.categories![0]!.channels!.map(c => c.name)).toEqual(['mod-log'])
    expect(spec.channels!.map(c => c.name)).toEqual(['lobby'])
  })

  test('maps overwrite targets to @everyone / role:<Name>, keeps member snowflakes', () => {
    expect(spec.categories![0]!.overwrites).toEqual([{ id: '@everyone', type: 'role', deny: ['ViewChannel'] }])
    const modLog = spec.categories![0]!.channels![0]!
    expect(modLog.overwrites).toEqual([{ id: 'role:Mod', type: 'role', allow: ['ViewChannel'] }])
  })

  test('drops empty overwrites and empty overwrite lists', () => {
    // u9's all-empty overwrite vanished above; lobby has none at all
    expect(spec.channels![0]!.overwrites).toBeUndefined()
  })

  test('keeps raw snowflake for ambiguous duplicate role names', () => {
    const state = fixtureState()
    state.roles.push({ id: 'r4', name: 'Mod', hexColor: '#000000', hoist: false, mentionable: false, permissions: [], position: 0, managed: false })
    const s = buildServerSpec(state)
    const modLog = s.categories![0]!.channels![0]!
    expect(modLog.overwrites![0]!.id).toBe('r1')
  })

  test('serializes channel topic/slowmode, omits zero-values', () => {
    const modLog = spec.categories![0]!.channels![0]!
    expect(modLog.topic).toBe('mod actions')
    expect(modLog.slowmode).toBe(30)
    expect(spec.channels![0]!.slowmode).toBeUndefined()
  })
})

describe('computeSpecDiff', () => {
  const currentSpec = () => buildServerSpec(fixtureState())

  test('re-applying the serialized spec yields an empty diff (idempotent)', () => {
    const diff = computeSpecDiff(currentSpec(), currentSpec())
    expect(diff.entries).toEqual([])
  })

  test('empty spec changes nothing, lists everything untouched', () => {
    const diff = computeSpecDiff(currentSpec(), {})
    expect(diff.entries).toEqual([])
    expect(diff.untouched).toContain('role "Mod"')
    expect(diff.untouched).toContain('category "Staff"')
    expect(diff.untouched).toContain('channel "Staff / #mod-log"')
    expect(diff.untouched).toContain('channel "#lobby"')
    expect(diff.untouched).toContain('@everyone permissions')
  })

  test('detects role create with dangerous-perm flag', () => {
    const diff = computeSpecDiff(currentSpec(), {
      roles: [{ name: 'Admin', permissions: ['Administrator'], color: '#ff0000' }],
    })
    expect(diff.entries).toHaveLength(1)
    const e = diff.entries[0]!
    expect(e).toMatchObject({ kind: 'role', op: 'create', name: 'Admin' })
    expect(e.dangerous).toEqual(['grants Administrator to new role "Admin"'])
  })

  test('detects role modify with before→after, only for drifted fields', () => {
    const diff = computeSpecDiff(currentSpec(), {
      roles: [{ name: 'Mod', hoist: false, permissions: ['KickMembers', 'ViewChannel', 'BanMembers'] }],
    })
    expect(diff.entries).toHaveLength(1)
    const e = diff.entries[0]!
    expect(e.op).toBe('modify')
    expect(e.changes).toEqual([
      { field: 'hoist', before: true, after: false },
      { field: 'permissions', before: ['KickMembers', 'ViewChannel'], after: ['BanMembers', 'KickMembers', 'ViewChannel'] },
    ])
    expect(e.dangerous).toEqual(['grants BanMembers to role "Mod"'])
  })

  test('matching role fields produce no entry (additive, field-level)', () => {
    // Only name + one already-matching field: nothing to do.
    const diff = computeSpecDiff(currentSpec(), { roles: [{ name: 'Mod', hoist: true }] })
    expect(diff.entries).toEqual([])
  })

  test('revoking a dangerous perm is a change but NOT flagged dangerous', () => {
    const diff = computeSpecDiff(currentSpec(), { roles: [{ name: 'Mod', permissions: ['ViewChannel'] }] })
    expect(diff.entries).toHaveLength(1)
    expect(diff.entries[0]!.dangerous).toEqual([])
  })

  test('detects @everyone permission change with dangerous flag', () => {
    const diff = computeSpecDiff(currentSpec(), { everyone_permissions: ['ViewChannel', 'SendMessages', 'MentionEveryone'] })
    expect(diff.entries).toHaveLength(1)
    expect(diff.entries[0]!.kind).toBe('everyone')
    expect(diff.entries[0]!.dangerous).toEqual(['grants MentionEveryone to @everyone'])
  })

  test('detects category + channel creates, in dependency order', () => {
    const diff = computeSpecDiff(currentSpec(), {
      categories: [{ name: 'Voice Zone', channels: [{ name: 'hangout', kind: 'voice' }] }],
    })
    expect(diff.entries.map(e => `${e.kind}:${e.op}`)).toEqual(['category:create', 'channel:create'])
    expect(diff.entries[1]!).toMatchObject({ name: 'hangout', category: 'Voice Zone' })
  })

  test('detects channel field drift (topic/slowmode/nsfw)', () => {
    const diff = computeSpecDiff(currentSpec(), {
      categories: [{ name: 'Staff', channels: [{ name: 'mod-log', topic: 'new topic', slowmode: 0, nsfw: true }] }],
    })
    expect(diff.entries).toHaveLength(1)
    expect(diff.entries[0]!.changes).toEqual([
      { field: 'topic', before: 'mod actions', after: 'new topic' },
      { field: 'slowmode', before: 30, after: 0 },
      { field: 'nsfw', before: false, after: true },
    ])
  })

  test('detects overwrite drift and emits a converging edit map', () => {
    const diff = computeSpecDiff(currentSpec(), {
      categories: [{ name: 'Staff', channels: [{ name: 'mod-log', overwrites: [{ id: 'role:Mod', allow: ['ViewChannel', 'ManageMessages'] }] }] }],
    })
    expect(diff.entries).toHaveLength(1)
    const e = diff.entries[0]!
    expect(e.overwriteEdits).toEqual([
      { id: 'role:Mod', type: undefined, set: { ViewChannel: true, ManageMessages: true } },
    ])
  })

  test('overwrite edit map nulls out perms the spec no longer sets', () => {
    expect(overwriteEditMap({ allow: ['ViewChannel', 'ManageMessages'], deny: ['SendMessages'] }, { allow: ['ViewChannel'] }))
      .toEqual({ ViewChannel: true, ManageMessages: null, SendMessages: null })
  })

  test('new dangerous overwrite grant is flagged', () => {
    const diff = computeSpecDiff(currentSpec(), {
      channels: [{ name: 'lobby', overwrites: [{ id: 'role:Mod', allow: ['MentionEveryone'] }] }],
    })
    expect(diff.entries[0]!.dangerous).toEqual(['grants MentionEveryone via overwrite role:Mod on channel "#lobby"'])
  })

  test('never deletes: extra current entities land in untouched, not entries', () => {
    const diff = computeSpecDiff(currentSpec(), { roles: [{ name: 'Mod', hoist: true }] })
    expect(diff.entries).toEqual([])
    expect(diff.untouched).toContain('role "Member"')
  })

  test('throws on unknown permission name', () => {
    expect(() => computeSpecDiff(currentSpec(), { roles: [{ name: 'X', permissions: ['Yeet'] }] }))
      .toThrow(/unknown permission name/)
  })

  test('throws on unknown channel kind', () => {
    expect(() => computeSpecDiff(currentSpec(), { channels: [{ name: 'x', kind: 'podcast' }] }))
      .toThrow(/unknown channel kind/)
  })

  test('throws on channel kind mismatch with the existing channel', () => {
    expect(() => computeSpecDiff(currentSpec(), { channels: [{ name: 'lobby', kind: 'voice' }] }))
      .toThrow(/exists as text but the spec says voice/)
  })

  test('throws on @everyone in roles[]', () => {
    expect(() => computeSpecDiff(currentSpec(), { roles: [{ name: '@everyone' }] }))
      .toThrow(/everyone_permissions/)
  })

  test('throws on duplicate role names in the spec', () => {
    expect(() => computeSpecDiff(currentSpec(), { roles: [{ name: 'X' }, { name: 'X' }] }))
      .toThrow(/duplicate name "X"/)
  })

  test('throws when targeting an ambiguous duplicate role name in the guild', () => {
    const state = fixtureState()
    state.roles.push({ id: 'r4', name: 'Mod', hexColor: '#000000', hoist: false, mentionable: false, permissions: [], position: 0, managed: false })
    expect(() => computeSpecDiff(buildServerSpec(state), { roles: [{ name: 'Mod', hoist: false }] }))
      .toThrow(/ambiguous/)
  })

  test('throws on raw-snowflake overwrite without a type', () => {
    expect(() => computeSpecDiff(currentSpec(), { channels: [{ name: 'lobby', overwrites: [{ id: '12345', allow: ['ViewChannel'] }] }] }))
      .toThrow(/set type/)
  })

  test('color compared by resolved value, not string form', () => {
    // #5865f2 both ways — one uppercase, no hash: still equal, no entry.
    const diff = computeSpecDiff(currentSpec(), { roles: [{ name: 'Mod', color: '5865F2' }] })
    expect(diff.entries).toEqual([])
  })
})

describe('computeSpecDiff — id matching & prune', () => {
  const currentSpec = () => buildServerSpec(fixtureState())
  // The never-delete context server.ts passes: guild id (=@everyone),
  // managed role ids, the bot's own role ids.
  const pruneOpts = { prune: true, guildId: 'g1', managedRoleIds: ['r3'], botRoleIds: [] }

  test('id kept + name changed → rename op, not delete+create', () => {
    const diff = computeSpecDiff(currentSpec(), { roles: [{ id: 'r1', name: 'Moderator' }] })
    expect(diff.entries).toHaveLength(1)
    expect(diff.entries[0]!).toMatchObject({ kind: 'role', op: 'rename', id: 'r1', name: 'Moderator' })
    expect(diff.entries[0]!.changes).toEqual([{ field: 'name', before: 'Mod', after: 'Moderator' }])
  })

  test('channel rename rides alongside field drift; renames sort after updates', () => {
    const diff = computeSpecDiff(currentSpec(), {
      categories: [{ id: 'c1', name: 'Staff', channels: [{ id: 'c2', name: 'mod-logs', topic: 'new topic' }] }],
    })
    expect(diff.entries.map(e => e.op)).toEqual(['modify', 'rename'])
    expect(diff.entries[0]!).toMatchObject({ kind: 'channel', op: 'modify', id: 'c2', name: 'mod-logs' })
    expect(diff.entries[0]!.changes).toEqual([{ field: 'topic', before: 'mod actions', after: 'new topic' }])
    expect(diff.entries[1]!.changes).toEqual([{ field: 'name', before: 'mod-log', after: 'mod-logs' }])
  })

  test('id kept + parent changed → move op', () => {
    const diff = computeSpecDiff(currentSpec(), {
      categories: [{ id: 'c1', name: 'Staff', channels: [{ id: 'c3', name: 'lobby' }] }],
    })
    expect(diff.entries).toHaveLength(1)
    expect(diff.entries[0]!).toMatchObject({ kind: 'channel', op: 'move', id: 'c3', name: 'lobby', category: 'Staff' })
    expect(diff.entries[0]!.changes).toEqual([{ field: 'category', before: '(top-level)', after: 'Staff' }])
  })

  test('move to top-level (parent → null)', () => {
    const diff = computeSpecDiff(currentSpec(), { channels: [{ id: 'c2', name: 'mod-log' }] })
    expect(diff.entries).toHaveLength(1)
    expect(diff.entries[0]!).toMatchObject({ kind: 'channel', op: 'move', id: 'c2', category: null })
    expect(diff.entries[0]!.changes).toEqual([{ field: 'category', before: 'Staff', after: '(top-level)' }])
  })

  test('stale/foreign id falls back to name match — no throw, no create', () => {
    const diff = computeSpecDiff(currentSpec(), { roles: [{ id: '999999', name: 'Mod', hoist: false }] })
    expect(diff.entries).toHaveLength(1)
    expect(diff.entries[0]!).toMatchObject({ kind: 'role', op: 'modify', id: 'r1', name: 'Mod' })
    expect(diff.entries[0]!.changes).toEqual([{ field: 'hoist', before: true, after: false }])
  })

  test('stale id with no name match → create', () => {
    const diff = computeSpecDiff(currentSpec(), { roles: [{ id: '999999', name: 'Brand New' }] })
    expect(diff.entries).toHaveLength(1)
    expect(diff.entries[0]!).toMatchObject({ kind: 'role', op: 'create', name: 'Brand New' })
  })

  test('mixed spec: id entries and name entries route independently', () => {
    const diff = computeSpecDiff(currentSpec(), {
      roles: [
        { id: 'r1', name: 'Moderator' },          // id-match → rename
        { name: 'Member', mentionable: false },   // name-match → modify
        { name: 'Newbie' },                       // no match → create
      ],
    })
    expect(diff.entries.map(e => `${e.op}:${e.name}`)).toEqual(['modify:Member', 'create:Newbie', 'rename:Moderator'])
  })

  test('category rename keeps id-less children matched (identity, not name)', () => {
    // Under pure name-keying, renaming "Staff" would strand its children:
    // the spec's child sits under a category name no live channel has, so
    // it would read as a create (and its live twin as a prune-delete).
    const diff = computeSpecDiff(currentSpec(), {
      everyone_permissions: ['SendMessages', 'ViewChannel'],
      roles: [{ id: 'r1', name: 'Mod' }, { id: 'r2', name: 'Member' }],
      categories: [{ id: 'c1', name: 'Team Rooms', channels: [{ name: 'mod-log' }] }],
      channels: [{ id: 'c3', name: 'lobby' }],
    }, pruneOpts)
    expect(diff.entries).toHaveLength(1)
    expect(diff.entries[0]!).toMatchObject({ kind: 'category', op: 'rename', id: 'c1', name: 'Team Rooms' })
  })

  test('prune: unclaimed live ids become deletes, claimed survive', () => {
    const diff = computeSpecDiff(currentSpec(), {
      everyone_permissions: ['SendMessages', 'ViewChannel'],
      roles: [{ id: 'r1', name: 'Mod' }],
      categories: [{ id: 'c1', name: 'Staff', channels: [{ id: 'c2', name: 'mod-log' }] }],
    }, pruneOpts)
    expect(diff.entries.map(e => `${e.op}:${e.kind}:${e.name}`)).toEqual(['delete:channel:lobby', 'delete:role:Member'])
  })

  test('prune + id name-swap of two channels → two renames, zero deletes', () => {
    // Pure name-keying would read a swap as both channels drifting (or as
    // delete+create pairs under prune) — ids disambiguate.
    const state = fixtureState()
    state.channels.push({ id: 'c4', name: 'general', type: 0, parentId: 'c1', position: 1, topic: null, rateLimitPerUser: null, nsfw: false, overwrites: [] })
    const diff = computeSpecDiff(buildServerSpec(state), {
      everyone_permissions: ['SendMessages', 'ViewChannel'],
      roles: [{ id: 'r1', name: 'Mod' }, { id: 'r2', name: 'Member' }],
      categories: [{ id: 'c1', name: 'Staff', channels: [
        { id: 'c2', name: 'general' },   // was mod-log
        { id: 'c4', name: 'mod-log' },   // was general
      ] }],
      channels: [{ id: 'c3', name: 'lobby' }],
    }, pruneOpts)
    expect(diff.entries.map(e => e.op)).toEqual(['rename', 'rename'])
    expect(diff.entries.map(e => `${e.id}:${e.name}`).sort()).toEqual(['c2:general', 'c4:mod-log'])
  })

  test('never-delete: @everyone / managed / bot-own roles survive prune even when unclaimed', () => {
    // Hand-built current so the protected roles are present at all —
    // buildServerSpec already keeps managed roles and @everyone out of specs.
    const cur: ServerSpec = {
      roles: [
        { id: 'g1', name: 'everyone-ish' },   // id === guild id
        { id: 'rM', name: 'SomeBot' },        // managed
        { id: 'rB', name: 'BotsOwnRole' },    // held by the bot
        { id: 'rX', name: 'Doomed' },
      ],
    }
    const diff = computeSpecDiff(cur, {}, { prune: true, guildId: 'g1', managedRoleIds: ['rM'], botRoleIds: ['rB'] })
    expect(diff.entries.map(e => `${e.op}:${e.id}`)).toEqual(['delete:rX'])
    expect(diff.untouched).toContain('role "everyone-ish" (protected)')
    expect(diff.untouched).toContain('role "SomeBot" (protected)')
    expect(diff.untouched).toContain('role "BotsOwnRole" (protected)')
  })

  test('prune of an empty spec deletes channels → categories → roles', () => {
    const diff = computeSpecDiff(currentSpec(), {}, pruneOpts)
    expect(diff.entries.map(e => `${e.op}:${e.kind}:${e.name}`)).toEqual([
      'delete:channel:mod-log',
      'delete:channel:lobby',
      'delete:category:Staff',
      'delete:role:Mod',
      'delete:role:Member',
    ])
  })

  test('prune re-apply of an unchanged export is an empty diff (idempotent)', () => {
    const diff = computeSpecDiff(currentSpec(), currentSpec(), pruneOpts)
    expect(diff.entries).toEqual([])
  })

  test('prune:false still never deletes — unclaimed land in untouched (regression)', () => {
    const diff = computeSpecDiff(currentSpec(), {}, { guildId: 'g1', managedRoleIds: ['r3'], botRoleIds: [] })
    expect(diff.entries).toEqual([])
    expect(diff.untouched).toContain('role "Member"')
    expect(diff.untouched).toContain('channel "#lobby"')
  })
})

describe('renderSpecDiff', () => {
  test('renders creates, modifies, flags, and the untouched list', () => {
    const current = buildServerSpec(fixtureState())
    const desired: ServerSpec = {
      roles: [
        { name: 'Admin', permissions: ['Administrator'] },
        { name: 'Mod', hoist: false },
      ],
    }
    const out = renderSpecDiff(computeSpecDiff(current, desired))
    expect(out).toContain('2 change(s)')
    expect(out).toContain('⚠ 1 with dangerous grants')
    expect(out).toContain('+ role "Admin" — permissions: [Administrator]')
    expect(out).toContain('~ role "Mod" — hoist: true → false')
    expect(out).toContain('⚠ grants Administrator to new role "Admin"')
    expect(out).toContain('· left untouched (not in spec):')
    expect(out).toContain('role "Member"')
  })

  test('empty diff renders the already-matching note', () => {
    const out = renderSpecDiff({ entries: [], untouched: [] })
    expect(out).toContain('0 change(s)')
    expect(out).toContain('already matches')
  })

  test('renders rename/move/DELETE lines with a per-class header breakdown', () => {
    const current = buildServerSpec(fixtureState())
    const diff = computeSpecDiff(current, {
      roles: [{ id: 'r1', name: 'Moderator' }],
      categories: [{ id: 'c1', name: 'Staff', channels: [{ id: 'c3', name: 'lobby' }] }],
    }, { prune: true, guildId: 'g1', managedRoleIds: ['r3'], botRoleIds: [] })
    const out = renderSpecDiff(diff)
    expect(out).toContain('4 change(s) — ⚠ 2 DELETIONS · 2 renames/moves')
    expect(out).toContain('~ rename role "Mod" → "Moderator"')
    expect(out).toContain('~ move channel "#lobby": "(top-level)" → "Staff"')
    expect(out).toContain('- DELETE channel "Staff / #mod-log"')
    expect(out).toContain('- DELETE role "Member"')
  })

  test('deletions over the guard threshold add the LARGE PRUNE banner', () => {
    const current = buildServerSpec(fixtureState())
    // Full wipe: 5 deletions against 3 live channels — over the 50% bound.
    const diff = computeSpecDiff(current, {}, { prune: true, guildId: 'g1', managedRoleIds: ['r3'], botRoleIds: [] })
    expect(renderSpecDiff(diff)).toContain('⚠⚠ LARGE PRUNE: 5 deletions — review carefully')
  })

  test('a small prune has no banner', () => {
    const current = buildServerSpec(fixtureState())
    // Only lobby is unclaimed: 1 deletion, 3 live channels — under both bounds.
    const diff = computeSpecDiff(current, {
      everyone_permissions: ['SendMessages', 'ViewChannel'],
      roles: [{ id: 'r1', name: 'Mod' }, { id: 'r2', name: 'Member' }],
      categories: [{ id: 'c1', name: 'Staff', channels: [{ id: 'c2', name: 'mod-log' }] }],
    }, { prune: true, guildId: 'g1', managedRoleIds: ['r3'], botRoleIds: [] })
    const out = renderSpecDiff(diff)
    expect(out).toContain('1 change(s) — ⚠ 1 DELETION')
    expect(out).not.toContain('LARGE PRUNE')
  })
})

describe('grantGroup / removeGroup', () => {
  test('grant creates a fresh entry with empty allowFrom', () => {
    const groups: Record<string, { requireMention: boolean; allowFrom: string[] }> = {}
    grantGroup(groups, '123', true)
    expect(groups['123']).toEqual({ requireMention: true, allowFrom: [] })
  })

  test('re-grant preserves existing allowFrom (merge, not clobber)', () => {
    const groups = { '123': { requireMention: true, allowFrom: ['42', '43'] } }
    grantGroup(groups, '123', false)
    expect(groups['123']).toEqual({ requireMention: false, allowFrom: ['42', '43'] })
  })

  test('grant is idempotent', () => {
    const groups = { '123': { requireMention: true, allowFrom: ['42'] } }
    grantGroup(groups, '123', true)
    grantGroup(groups, '123', true)
    expect(groups).toEqual({ '123': { requireMention: true, allowFrom: ['42'] } })
  })

  test('grant leaves other channels alone', () => {
    const groups = { '999': { requireMention: false, allowFrom: [] } }
    grantGroup(groups, '123', true)
    expect(groups['999']).toEqual({ requireMention: false, allowFrom: [] })
  })

  test('remove deletes the entry and reports true', () => {
    const groups = { '123': { requireMention: true, allowFrom: [] } }
    expect(removeGroup(groups, '123')).toBe(true)
    expect('123' in groups).toBe(false)
  })

  test('remove of an unknown channel reports false', () => {
    expect(removeGroup({}, '123')).toBe(false)
  })
})

describe('makeTtlCache (used by /usage now that it is open to everyone)', () => {
  test('a cold cache calls the fetcher', async () => {
    const c = makeTtlCache<number>(60_000)
    let calls = 0
    expect(await c.get(async () => { calls++; return 7 }, 1000)).toBe(7)
    expect(calls).toBe(1)
  })

  test('a second call inside the TTL does NOT re-fetch', async () => {
    const c = makeTtlCache<number>(60_000)
    let calls = 0
    const f = async () => { calls++; return calls }
    await c.get(f, 1000)
    await c.get(f, 30_000)          // 29s later, still inside 60s
    await c.get(f, 60_999)          // 59.999s later, still inside
    expect(calls).toBe(1)
  })

  test('past the TTL it re-fetches', async () => {
    const c = makeTtlCache<number>(60_000)
    let calls = 0
    const f = async () => { calls++; return calls }
    expect(await c.get(f, 1000)).toBe(1)
    expect(await c.get(f, 61_001)).toBe(2)   // 60.001s later
    expect(calls).toBe(2)
  })

  // The teeth for the stampede requirement: a value-only cache passes every test above and
  // still fires N upstream requests when N users hit /usage simultaneously on a cold cache.
  test('concurrent callers on a COLD cache share ONE in-flight request', async () => {
    const c = makeTtlCache<string>(60_000)
    let calls = 0
    let release!: (v: string) => void
    const gate = new Promise<string>((r) => { release = r })
    const f = () => { calls++; return gate }

    const all = Promise.all([c.get(f, 1000), c.get(f, 1000), c.get(f, 1000), c.get(f, 1000)])
    release('shared')
    expect(await all).toEqual(['shared', 'shared', 'shared', 'shared'])
    expect(calls).toBe(1)
  })

  test('a failed fetch is NOT cached — the next caller retries', async () => {
    const c = makeTtlCache<string>(60_000)
    let calls = 0
    const f = async () => { calls++; if (calls === 1) throw new Error('boom'); return 'ok' }
    await expect(c.get(f, 1000)).rejects.toThrow('boom')
    expect(await c.get(f, 1001)).toBe('ok')   // immediately after, inside the TTL
    expect(calls).toBe(2)
  })

  test('isFresh tracks the window, clear() drops it', async () => {
    const c = makeTtlCache<number>(60_000)
    expect(c.isFresh(1000)).toBe(false)
    await c.get(async () => 1, 1000)
    expect(c.isFresh(30_000)).toBe(true)
    expect(c.isFresh(61_001)).toBe(false)
    c.clear()
    expect(c.isFresh(30_000)).toBe(false)
  })
})

describe('lookup query normalisation (every case here is a defect review found in the inline version)', () => {
  test('a Discord mention short-circuits to its id -- the commonest real input', () => {
    // Typing "#general" in a client sends the literal "<#123>", which used to return "no matches".
    expect(normalizeLookupQuery('<#1492558787561914542>')).toEqual({ text: '', id: '1492558787561914542' })
    expect(normalizeLookupQuery('<@!409669317299535903>')).toEqual({ text: '', id: '409669317299535903' })
    expect(normalizeLookupQuery('<@&1486191604183334964>')).toEqual({ text: '', id: '1486191604183334964' })
  })

  test('a bare snowflake is already the answer', () => {
    expect(normalizeLookupQuery('1492558787561914542').id).toBe('1492558787561914542')
  })

  test('TRIM runs before the #/@ strip', () => {
    // The bug: /^[#@]/ anchored against an untrimmed string does nothing, so " #general" searched for
    // "#general" literally and missed.
    expect(normalizeLookupQuery(' #general').text).toBe('general')
    expect(normalizeLookupQuery('  @barron  ').text).toBe('barron')
    expect(normalizeLookupQuery('##general').text).toBe('general')
  })

  test('junk types degrade to a harmless empty query rather than throwing', () => {
    for (const junk of [null, undefined, 42, {}, [], '#', '@', '   ']) {
      const r = normalizeLookupQuery(junk as unknown)
      expect(typeof r.text).toBe('string')
    }
    expect(normalizeLookupQuery('#').text).toBe('')
  })

  test('unicode is normalised on BOTH sides, so NFD and NFC agree', () => {
    const nfd = 'caf\u0065\u0301'   // cafe + combining acute
    const nfc = 'caf\u00e9'          // precomposed
    expect(lookupNameMatches(nfd, normalizeLookupQuery(nfc).text)).toBe(true)
    expect(lookupNameMatches(nfc, normalizeLookupQuery(nfd).text)).toBe(true)
  })

  test('the query is a substring, never a regex', () => {
    expect(lookupNameMatches('general', normalizeLookupQuery('.*').text)).toBe(false)
    expect(lookupNameMatches('a.b', normalizeLookupQuery('a.b').text)).toBe(true)
  })

  test('limit is clamped to a WHOLE number in range', () => {
    // 2.7 survived the old clamp and reached Discord as ?limit=2.7, which it rejects -- surfaced to the
    // caller as a misleading "member search unavailable".
    expect(clampLookupLimit(2.7)).toBe(2)
    expect(clampLookupLimit(999)).toBe(50)
    expect(clampLookupLimit(0)).toBe(10)
    expect(clampLookupLimit(-5)).toBe(10)
    // Infinity is junk, not "give me the max" -- it falls back like 'abc' and -5 do. The old inline
    // clamp returned 50 here via Math.min; treating all junk the same way is the more defensible rule.
    expect(clampLookupLimit(Infinity)).toBe(10)
    expect(clampLookupLimit('abc')).toBe(10)
    expect(clampLookupLimit(undefined)).toBe(10)
  })

  test('exact names rank above substring matches', () => {
    const q = normalizeLookupQuery('rust').text
    expect(lookupRank('rust', q)).toBe(0)
    expect(lookupRank('rustbot', q)).toBe(1)
    const names = ['rustbot', 'rust', 'trusty']
    names.sort((a, b) => lookupRank(a, q) - lookupRank(b, q) || a.localeCompare(b))
    expect(names[0]).toBe('rust')
  })
})

// ── DM access (/access user:@someone) ──
// The owner asked for /access to authorise DM conversations as well as channels (2026-08-21). The
// handler is owner-gated in server.ts; what is testable is the state transition, so that is what these
// pin. Mirrors the grantGroup/removeGroup tests above.
describe('grantDm / removeDm', () => {
  test('grant adds the user to allowFrom', () => {
    const allow: string[] = []
    expect(grantDm(allow, {}, '42')).toBe(true)
    expect(allow).toEqual(['42'])
  })

  test('re-granting is a no-op and reports it, rather than duplicating', () => {
    const allow = ['42']
    expect(grantDm(allow, {}, '42')).toBe(false)
    expect(allow).toEqual(['42'])   // not ['42','42'] -- a dupe would survive one remove
  })

  test('granting CLEARS that user pending pairing code, but leaves other people alone', () => {
    const allow: string[] = []
    const pending = { aaa: { senderId: '42' }, bbb: { senderId: '99' } }
    grantDm(allow, pending, '42')
    expect(pending).toEqual({ bbb: { senderId: '99' } })
  })

  test('remove takes them back out', () => {
    const allow = ['42', '43']
    expect(removeDm(allow, '42')).toBe(true)
    expect(allow).toEqual(['43'])
  })

  test('removing someone who never had access reports false and changes nothing', () => {
    const allow = ['43']
    expect(removeDm(allow, '42')).toBe(false)
    expect(allow).toEqual(['43'])
  })

  test('grant then remove is a round trip -- no residue in allowFrom or pending', () => {
    const allow: string[] = []
    const pending = { aaa: { senderId: '42' } }
    grantDm(allow, pending, '42')
    removeDm(allow, '42')
    expect(allow).toEqual([])
    expect(pending).toEqual({})   // the code stays cleared; revoking access does not resurrect it
  })
})
