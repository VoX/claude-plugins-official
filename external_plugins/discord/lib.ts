// Pure helpers used by server.ts. Kept in their own file so they can be
// unit-tested without booting the full MCP server (which connects to
// Discord on import).

import { ChannelType, EmbedBuilder, PermissionFlagsBits, PermissionsBitField, resolveColor, type ColorResolvable, type PermissionResolvable } from 'discord.js'

// JS string `.slice(0, N)` operates on UTF-16 code units. Multi-codepoint
// emoji (any character outside the BMP — e.g. 🦝, 🫡, 🐧) take TWO code
// units; cutting between them strands a lone high surrogate that JSON
// encodes as `\ud83e` and Anthropic's parser rejects with HTTP 400 — which
// poisons every subsequent reply on session resume. `Array.from(str)`
// iterates by codepoint, so slicing the resulting array preserves emoji
// integrity. (Doesn't handle ZWJ-glued sequences like 👨‍👩‍👧‍👦 as a
// single grapheme — those split into component emoji — but no encoding
// error, just a visual artifact in a 200-char snippet preview.)
export function safeSlice(str: string, n: number): string {
  // Fast path: most strings (titles, footers, single-line snippets) are
  // already under the cap, so skip the codepoint walk entirely.
  if (str.length <= n) return str
  return Array.from(str).slice(0, n).join('')
}

export function formatSendResult(ids: string[]): string {
  return ids.length === 1
    ? `sent (id: ${ids[0]})`
    : `sent ${ids.length} parts (ids: ${ids.join(', ')})`
}

// Allowlist URL schemes for embed url/thumbnail_url/image_url to keep
// `javascript:` / `data:` / unknown protocols out of attacker-controlled
// embed fields. Discord clients refuse to render most non-http(s), but
// the API accepts them and `setURL` (title link) is not proxied.
export function assertEmbedUrl(field: string, value: string): void {
  if (!/^https?:\/\//i.test(value)) {
    throw new Error(`${field} must be an http(s) URL (got: ${JSON.stringify(safeSlice(value, 80))})`)
  }
}

// Build an EmbedBuilder from a tool-call args object. Shared by `send_embed`
// (post a new embed) and `edit_embed` (replace an existing embed in-place).
// Validation throws (invalid url scheme, oversized fields list, malformed
// color, bad timestamp) so callers don't have to repeat the checks.
export function buildEmbedFromArgs(args: Record<string, unknown>): EmbedBuilder {
  const title = args.title as string | undefined
  const description = args.description as string | undefined
  const url = args.url as string | undefined
  const thumbnail_url = args.thumbnail_url as string | undefined
  const image_url = args.image_url as string | undefined
  const footer = args.footer as string | undefined
  const color = args.color as string | undefined
  const author = args.author as { name?: unknown; url?: unknown; icon_url?: unknown } | undefined
  const timestamp = args.timestamp as string | boolean | undefined

  if (url) assertEmbedUrl('url', url)
  if (thumbnail_url) assertEmbedUrl('thumbnail_url', thumbnail_url)
  if (image_url) assertEmbedUrl('image_url', image_url)

  const embed = new EmbedBuilder()
  if (title) embed.setTitle(safeSlice(title, 256))
  if (description) embed.setDescription(safeSlice(description, 4096))
  if (url) embed.setURL(url)
  if (thumbnail_url) embed.setThumbnail(thumbnail_url)
  if (image_url) embed.setImage(image_url)
  if (footer) embed.setFooter({ text: safeSlice(footer, 2048) })
  if (author && typeof author.name === 'string') {
    if (typeof author.url === 'string') assertEmbedUrl('author.url', author.url)
    if (typeof author.icon_url === 'string') assertEmbedUrl('author.icon_url', author.icon_url)
    embed.setAuthor({
      name: safeSlice(author.name, 256),
      ...(typeof author.url === 'string' ? { url: author.url } : {}),
      ...(typeof author.icon_url === 'string' ? { iconURL: author.icon_url } : {}),
    })
  }
  if (timestamp === true) {
    embed.setTimestamp(new Date())
  } else if (typeof timestamp === 'string') {
    const t = Date.parse(timestamp)
    if (isNaN(t)) throw new Error(`invalid timestamp: ${timestamp} (use ISO-8601 or boolean true for now)`)
    embed.setTimestamp(new Date(t))
  }
  if (color) {
    embed.setColor(resolveColorInput(color))
  }
  if (Array.isArray(args.fields)) {
    const raw = args.fields as Array<{ name?: unknown; value?: unknown; inline?: unknown }>
    if (raw.length > 25) throw new Error(`Discord allows max 25 embed fields (got ${raw.length})`)
    const fields = raw.map((f, i) => {
      if (typeof f.name !== 'string' || typeof f.value !== 'string') {
        throw new Error(`field[${i}] missing name or value`)
      }
      return {
        name: safeSlice(f.name, 256),
        value: safeSlice(f.value, 1024),
        inline: f.inline === true,
      }
    })
    embed.addFields(fields)
  }
  return embed
}

// Resolve a color string to a discord.js color number. resolveColor's
// named-color lookup is case-sensitive (`Blurple`, not `blurple`).
// Auto-capitalize purely-alpha input so callers don't have to think about
// it. Hex starts with `#` or a digit, both no-op under capitalize. Shared
// by embed building and role-spec color handling.
export function resolveColorInput(color: string): number {
  const normalized = /^[a-z]+$/i.test(color)
    ? color.charAt(0).toUpperCase() + color.slice(1).toLowerCase()
    : color
  try {
    return resolveColor(normalized as ColorResolvable)
  } catch {
    throw new Error(`invalid color: ${color} (use hex like #5865f2 or a discord.js Colors name like 'Blurple')`)
  }
}

// Shared JSON-Schema property block for embed fields. Used by both the
// `send_embed` and `edit_embed` tool definitions so the field surface stays
// in lockstep — adding a new embed field only edits one place.
export const EMBED_SCHEMA_PROPS = {
  title: { type: 'string', description: 'Embed title (truncated to 256 codepoints).' },
  description: { type: 'string', description: 'Embed body (truncated to 4096 codepoints; markdown supported).' },
  color: { type: 'string', description: 'Color: hex like "#5865f2" / "5865f2", or a discord.js Colors name (Blurple, Green, Red, Yellow, Fuchsia, Orange, LuminousVividPink, Greyple, White, etc., or "Random"). Lowercase names are auto-capitalized.' },
  fields: {
    type: 'array',
    items: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        value: { type: 'string' },
        inline: { type: 'boolean' },
      },
      required: ['name', 'value'],
    },
    description: 'Up to 25 fields. name truncated to 256, value to 1024. inline=true displays side-by-side (3 per row max).',
  },
  thumbnail_url: { type: 'string', description: 'Image URL — small, top-right of the embed. Must be http(s).' },
  image_url: { type: 'string', description: 'Image URL — full-width, below the description. Must be http(s).' },
  footer: { type: 'string', description: 'Footer text (truncated to 2048 codepoints).' },
  url: { type: 'string', description: 'URL the title links to. Must be http(s).' },
  author: {
    type: 'object',
    description: 'Optional author block at the top of the embed (above the title).',
    properties: {
      name: { type: 'string', description: 'Author display name (truncated to 256 codepoints). Required if author is set.' },
      url: { type: 'string', description: 'Optional URL for the author name to link to. Must be http(s).' },
      icon_url: { type: 'string', description: 'Optional small avatar URL shown next to the author name. Must be http(s).' },
    },
  },
  timestamp: {
    description: 'Optional timestamp shown at the bottom of the embed. Pass `true` for "now", or an ISO-8601 string for a specific moment.',
  },
} as const

// Splits long text at the closest whitespace boundary under `limit` so a
// single reply can ship across multiple Discord messages without breaking
// mid-mention or mid-word. Prefers paragraph breaks > line breaks > word
// breaks > hard cut at limit.
export function chunk(text: string, limit: number): string[] {
  if (text.length <= limit) return [text]
  const out: string[] = []
  let rest = text
  while (rest.length > limit) {
    const para = rest.lastIndexOf('\n\n', limit)
    const line = rest.lastIndexOf('\n', limit)
    const space = rest.lastIndexOf(' ', limit)
    const cut = para > 0 ? para : line > 0 ? line : space > 0 ? space : limit
    out.push(rest.slice(0, cut))
    rest = rest.slice(cut).replace(/^\s+/, '')
  }
  if (rest) out.push(rest)
  return out
}

// ── Presence aggregation (pure; composes the per-turn action sequence) ──────────
export const PRESENCE_IDLE = '💤 idle…'
// Match the sentinel by its EMOJI marker, not the word — so a Bash classifier label like
// "⚙️ run idle…" (a command named "idle") isn't mistaken for the rest/working sentinel.
export const isIdle = (t: string) => t.includes('💤')
export const isWorking = (t: string) => t.includes('🐾')

// Compose the aggregate from the per-turn sequence file: the DISTINCT actions that fired
// this turn, in first-occurrence order, space-joined with one trailing ellipsis. "working"
// is dropped unless it's the only thing that fired; '' for empty/absent. Parse/compose happens
// BEFORE sanitize (which strips the newlines the sequence relies on).
//
// idle is terminal but ORDER-AUTHORITATIVE: it only rests if it's the LAST line. A tool append
// landing after the Stop hook's idle write (a parallel-hook race) means work actually continued,
// so we show the work and ignore the stray non-trailing idle — making the reader self-correcting
// regardless of write ordering.
export function composePresence(raw: string): string {
  const lines = raw.split('\n').map(l => l.trim()).filter(Boolean)
  if (lines.length === 0) return ''
  if (isIdle(lines[lines.length - 1]!)) return PRESENCE_IDLE
  const actions = lines.filter(l => !isIdle(l))  // drop stray (non-trailing) idle lines from races
  if (actions.length === 0) return ''
  const seen = new Set<string>()
  const distinct = actions.filter(l => (seen.has(l) ? false : (seen.add(l), true)))
  let kept = distinct.filter(l => !isWorking(l))
  if (kept.length === 0) kept = distinct.filter(isWorking).slice(0, 1)  // only working fired
  if (kept.length === 0) return ''
  const strip = (l: string) => l.replace(/[…．.\s]+$/u, '')
  let body = kept.map(strip).join(' ')
  while (body.length > 120 && kept.length > 1) {       // 128-char cap: drop oldest, prefix ellipsis
    kept = kept.slice(1)
    body = '… ' + kept.map(strip).join(' ')
  }
  return body + '…'
}

// ── Server spec (pure core of get_server_spec / apply_server_spec) ──────────
// A ServerSpec is a declarative snapshot of a guild's structure: @everyone
// permissions, roles, categories with their channels, and permission
// overwrites. get_server_spec serializes a guild INTO this shape;
// apply_server_spec diffs a desired spec against the live guild and upserts.
// Everything here is pure — server.ts owns the discord.js reads/writes.

export type SpecOverwrite = {
  /** Target: '@everyone', 'role:<Name>', or a raw user/role snowflake. */
  id: string
  /** Required for raw-snowflake targets so apply doesn't depend on cache lookups. */
  type?: 'role' | 'member'
  allow?: string[]
  deny?: string[]
}

export type SpecRole = {
  name: string
  /** Hex like '#5865f2' or a discord.js Colors name. Omitted = default (no color). */
  color?: string
  hoist?: boolean
  mentionable?: boolean
  /** PermissionFlagsBits names, e.g. ['ViewChannel', 'KickMembers']. */
  permissions?: string[]
  /** Applied on create only — reordering existing roles is out of scope. */
  position?: number
}

export type SpecChannel = {
  name: string
  /** text | voice | announcement | forum | stage. Defaults to text on create. */
  kind?: string
  topic?: string
  /** rateLimitPerUser, in seconds. */
  slowmode?: number
  nsfw?: boolean
  overwrites?: SpecOverwrite[]
}

export type SpecCategory = {
  name: string
  overwrites?: SpecOverwrite[]
  channels?: SpecChannel[]
}

export type ServerSpec = {
  everyone_permissions?: string[]
  roles?: SpecRole[]
  categories?: SpecCategory[]
  /** Channels with no parent category. */
  channels?: SpecChannel[]
}

// Raw per-guild state as extracted from the discord.js caches (server.ts's
// snapshotGuild). Kept as plain data so buildServerSpec is unit-testable.
export type RawOverwrite = { id: string; type: 'role' | 'member'; allow: string[]; deny: string[] }
export type RawRole = {
  id: string; name: string; hexColor: string; hoist: boolean; mentionable: boolean
  permissions: string[]; position: number; managed: boolean
}
export type RawChannel = {
  id: string; name: string; type: number; parentId: string | null; position: number
  topic: string | null; rateLimitPerUser: number | null; nsfw: boolean
  overwrites: RawOverwrite[]
}
export type RawGuildState = {
  guildId: string
  everyonePermissions: string[]
  roles: RawRole[]        // excluding @everyone
  channels: RawChannel[]  // categories included, threads excluded
}

// Grants of any of these get a ⚠ flag in the approval diff.
export const DANGEROUS_PERMS: readonly string[] = [
  'Administrator', 'ManageGuild', 'ManageRoles', 'ManageChannels',
  'ManageWebhooks', 'KickMembers', 'BanMembers', 'MentionEveryone',
]

const KIND_TO_TYPE: Record<string, ChannelType> = {
  text: ChannelType.GuildText,
  voice: ChannelType.GuildVoice,
  announcement: ChannelType.GuildAnnouncement,
  forum: ChannelType.GuildForum,
  stage: ChannelType.GuildStageVoice,
}

export function kindToChannelType(kind: string): ChannelType {
  const t = KIND_TO_TYPE[kind]
  if (t === undefined) {
    throw new Error(`unknown channel kind "${kind}" (use ${Object.keys(KIND_TO_TYPE).join('/')})`)
  }
  return t
}

// null = a type the spec doesn't model (directory, media, …) — serializer skips it.
export function channelTypeToKind(type: number): string | null {
  for (const [kind, t] of Object.entries(KIND_TO_TYPE)) if (t === type) return kind
  return null
}

// Throws on any name that isn't a PermissionFlagsBits key. Object.hasOwn, not
// `in` — `in` walks the prototype chain and would accept 'constructor'.
// PermissionsBitField's constructor resolves eagerly as a second net.
export function validatePermissionNames(names: string[], where: string): string[] {
  const unknown = names.filter(n => typeof n !== 'string' || !Object.hasOwn(PermissionFlagsBits, n))
  if (unknown.length > 0) {
    throw new Error(`${where}: unknown permission name(s): ${unknown.join(', ')} (use PermissionFlagsBits names like ViewChannel, SendMessages, ManageRoles)`)
  }
  new PermissionsBitField(names as PermissionResolvable)
  return names
}

function sameSet(a: string[] | undefined, b: string[] | undefined): boolean {
  const setA = new Set(a ?? [])
  const setB = new Set(b ?? [])
  if (setA.size !== setB.size) return false
  for (const x of setA) if (!setB.has(x)) return false
  return true
}

function findDup(items: string[]): string | null {
  const seen = new Set<string>()
  for (const x of items) {
    if (seen.has(x)) return x
    seen.add(x)
  }
  return null
}

// Newly-granted dangerous permissions: present in after, absent from before.
function dangerousGrants(before: string[] | undefined, after: string[] | undefined): string[] {
  const prev = new Set(before ?? [])
  return (after ?? []).filter(p => !prev.has(p) && DANGEROUS_PERMS.includes(p))
}

// Serialize raw guild state into the spec shape. Deterministic: roles sorted
// by position (highest first, like the Discord UI), channels by position,
// permission arrays sorted. Managed roles (bot/integration roles) are
// excluded — they can't be created or freely edited. Role-targeted overwrites
// are emitted as '@everyone' / 'role:<Name>' (portable across guilds) when
// the name is unambiguous, raw snowflakes otherwise.
export function buildServerSpec(state: RawGuildState): ServerSpec {
  const nameCounts = new Map<string, number>()
  for (const r of state.roles) nameCounts.set(r.name, (nameCounts.get(r.name) ?? 0) + 1)
  const roleTarget = new Map<string, string>([[state.guildId, '@everyone']])
  for (const r of state.roles) {
    if (nameCounts.get(r.name) === 1) roleTarget.set(r.id, `role:${r.name}`)
  }

  const specOverwrites = (raw: RawOverwrite[]): SpecOverwrite[] | undefined => {
    const out: SpecOverwrite[] = []
    for (const o of raw) {
      if (o.allow.length === 0 && o.deny.length === 0) continue // no-op overwrite
      const id = o.type === 'role' ? roleTarget.get(o.id) ?? o.id : o.id
      const entry: SpecOverwrite = { id, type: o.type }
      if (o.allow.length > 0) entry.allow = [...o.allow].sort()
      if (o.deny.length > 0) entry.deny = [...o.deny].sort()
      out.push(entry)
    }
    return out.length > 0 ? out.sort((a, b) => a.id.localeCompare(b.id)) : undefined
  }

  const specChannel = (c: RawChannel): SpecChannel => {
    const ch: SpecChannel = { name: c.name, kind: channelTypeToKind(c.type)! }
    if (c.topic) ch.topic = c.topic
    if (c.rateLimitPerUser) ch.slowmode = c.rateLimitPerUser
    if (c.nsfw) ch.nsfw = true
    const ows = specOverwrites(c.overwrites)
    if (ows) ch.overwrites = ows
    return ch
  }

  const byPosition = (a: RawChannel, b: RawChannel) => a.position - b.position || a.id.localeCompare(b.id)
  const childrenOf = (parentId: string | null): SpecChannel[] =>
    state.channels
      .filter(c => c.parentId === parentId && c.type !== ChannelType.GuildCategory && channelTypeToKind(c.type) !== null)
      .sort(byPosition)
      .map(specChannel)

  const roles: SpecRole[] = [...state.roles]
    .filter(r => !r.managed)
    .sort((a, b) => b.position - a.position || a.id.localeCompare(b.id))
    .map(r => {
      const role: SpecRole = { name: r.name }
      if (r.hexColor && r.hexColor !== '#000000') role.color = r.hexColor
      if (r.hoist) role.hoist = true
      if (r.mentionable) role.mentionable = true
      role.permissions = [...r.permissions].sort()
      role.position = r.position
      return role
    })

  const categories: SpecCategory[] = state.channels
    .filter(c => c.type === ChannelType.GuildCategory)
    .sort(byPosition)
    .map(cat => {
      const out: SpecCategory = { name: cat.name }
      const ows = specOverwrites(cat.overwrites)
      if (ows) out.overwrites = ows
      out.channels = childrenOf(cat.id)
      return out
    })

  const spec: ServerSpec = {
    everyone_permissions: [...state.everyonePermissions].sort(),
    roles,
    categories,
  }
  const topLevel = childrenOf(null)
  if (topLevel.length > 0) spec.channels = topLevel
  return spec
}

export type FieldChange = { field: string; before?: unknown; after: unknown }
/** Converging boolean map for permissionOverwrites.edit — see overwriteEditMap. */
export type OverwriteEdit = { id: string; type?: 'role' | 'member'; set: Record<string, boolean | null> }
export type SpecDiffEntry = {
  kind: 'everyone' | 'role' | 'category' | 'channel'
  op: 'create' | 'modify'
  name: string
  /** channels only: parent category name (null = top-level). */
  category?: string | null
  changes: FieldChange[]
  /** modify only: per-target overwrite edit maps for the applier. */
  overwriteEdits?: OverwriteEdit[]
  /** Human-readable ⚠ lines for dangerous grants. */
  dangerous: string[]
}
export type SpecDiff = { entries: SpecDiffEntry[]; untouched: string[] }

// The boolean map permissionOverwrites.edit takes, built to CONVERGE on the
// desired overwrite: desired allow → true, desired deny → false, and any perm
// currently set on the overwrite but absent from the spec → null (unset).
// Without the nulls a re-apply would never reach an empty diff.
export function overwriteEditMap(
  current: { allow?: string[]; deny?: string[] } | undefined,
  desired: { allow?: string[]; deny?: string[] },
): Record<string, boolean | null> {
  const set: Record<string, boolean | null> = {}
  for (const p of current?.allow ?? []) set[p] = null
  for (const p of current?.deny ?? []) set[p] = null
  for (const p of desired.allow ?? []) set[p] = true
  for (const p of desired.deny ?? []) set[p] = false
  return set
}

function fmtOverwrite(o: { allow?: string[]; deny?: string[] }): string {
  const parts: string[] = []
  if (o.allow?.length) parts.push(`allow [${[...o.allow].sort().join(', ')}]`)
  if (o.deny?.length) parts.push(`deny [${[...o.deny].sort().join(', ')}]`)
  return parts.join(' ') || '(empty)'
}

function validateSpecOverwrites(ows: SpecOverwrite[], where: string): void {
  for (const o of ows) {
    if (!o.id || typeof o.id !== 'string') {
      throw new Error(`${where}: every overwrite needs an id ('@everyone', 'role:<Name>', or a snowflake)`)
    }
    if (o.allow) validatePermissionNames(o.allow, `${where} overwrite ${o.id} allow`)
    if (o.deny) validatePermissionNames(o.deny, `${where} overwrite ${o.id} deny`)
    if (o.id !== '@everyone' && !o.id.startsWith('role:') && o.type !== 'role' && o.type !== 'member') {
      throw new Error(`${where}: overwrite ${o.id} is a raw snowflake — set type: 'role' or 'member'`)
    }
  }
  const dup = findDup(ows.map(o => o.id))
  if (dup) throw new Error(`${where}: duplicate overwrite target ${dup}`)
}

// Diff desired overwrites against current ones, appending display changes,
// applier edit-maps, and ⚠ flags. Current overwrites not named in the spec
// are left alone (additive semantics, same as everything else).
function diffOverwrites(
  current: SpecOverwrite[] | undefined,
  desired: SpecOverwrite[] | undefined,
  where: string,
  changes: FieldChange[],
  edits: OverwriteEdit[],
  dangerous: string[],
): void {
  if (!desired) return
  validateSpecOverwrites(desired, where)
  const curById = new Map((current ?? []).map(o => [o.id, o]))
  for (const want of desired) {
    const cur = curById.get(want.id)
    if (cur && sameSet(cur.allow, want.allow) && sameSet(cur.deny, want.deny)) continue
    changes.push({
      field: `overwrite ${want.id}`,
      ...(cur ? { before: fmtOverwrite(cur) } : {}),
      after: fmtOverwrite(want),
    })
    edits.push({ id: want.id, type: want.type, set: overwriteEditMap(cur, want) })
    for (const p of dangerousGrants(cur?.allow, want.allow)) {
      dangerous.push(`grants ${p} via overwrite ${want.id} on ${where}`)
    }
  }
}

export function specEntryLabel(e: SpecDiffEntry): string {
  if (e.kind === 'everyone') return '@everyone'
  if (e.kind === 'channel') return `channel "${e.category ? `${e.category} / ` : ''}#${e.name}"`
  return `${e.kind} "${e.name}"`
}

// Additive-upsert diff: `create` for spec entries missing from the guild,
// `modify` (with before→after) where a spec-set field drifts. Fields the
// spec leaves undefined are not compared; guild entities the spec doesn't
// name land in `untouched` — NOTHING is ever deleted. Re-applying a spec
// that already matches yields zero entries (idempotent). Throws (fail-fast,
// nothing applied) on unknown permission names/colors/kinds, ambiguous
// duplicate names, and channel-kind mismatches.
export function computeSpecDiff(current: ServerSpec, desired: ServerSpec): SpecDiff {
  const entries: SpecDiffEntry[] = []
  const untouched: string[] = []

  // @everyone permissions — compared as a set only when the spec sets them.
  if (desired.everyone_permissions) {
    validatePermissionNames(desired.everyone_permissions, '@everyone permissions')
    if (!sameSet(current.everyone_permissions, desired.everyone_permissions)) {
      entries.push({
        kind: 'everyone', op: 'modify', name: '@everyone',
        changes: [{
          field: 'permissions',
          before: [...(current.everyone_permissions ?? [])].sort(),
          after: [...desired.everyone_permissions].sort(),
        }],
        dangerous: dangerousGrants(current.everyone_permissions, desired.everyone_permissions)
          .map(p => `grants ${p} to @everyone`),
      })
    }
  } else if (current.everyone_permissions) {
    untouched.push('@everyone permissions')
  }

  // Roles — matched by name.
  const desiredRoles = desired.roles ?? []
  const dupRole = findDup(desiredRoles.map(r => r.name))
  if (dupRole !== null) throw new Error(`spec.roles has duplicate name "${dupRole}"`)
  const currentRolesByName = new Map<string, SpecRole[]>()
  for (const r of current.roles ?? []) {
    currentRolesByName.set(r.name, [...(currentRolesByName.get(r.name) ?? []), r])
  }
  const touchedRoles = new Set<string>()
  for (const want of desiredRoles) {
    if (!want.name || typeof want.name !== 'string') throw new Error('spec.roles: every role needs a name')
    if (want.name === '@everyone') throw new Error('set everyone_permissions for @everyone, not a roles[] entry')
    if (want.permissions) validatePermissionNames(want.permissions, `role "${want.name}" permissions`)
    if (want.color !== undefined) resolveColorInput(want.color) // validate before diffing
    touchedRoles.add(want.name)
    const have = currentRolesByName.get(want.name) ?? []
    if (have.length > 1) {
      throw new Error(`role name "${want.name}" is ambiguous — ${have.length} roles share it; rename one in Discord first`)
    }
    if (have.length === 0) {
      const changes: FieldChange[] = []
      if (want.color !== undefined) changes.push({ field: 'color', after: want.color })
      if (want.hoist !== undefined) changes.push({ field: 'hoist', after: want.hoist })
      if (want.mentionable !== undefined) changes.push({ field: 'mentionable', after: want.mentionable })
      if (want.permissions) changes.push({ field: 'permissions', after: [...want.permissions].sort() })
      if (want.position !== undefined) changes.push({ field: 'position', after: want.position })
      entries.push({
        kind: 'role', op: 'create', name: want.name, changes,
        dangerous: dangerousGrants(undefined, want.permissions).map(p => `grants ${p} to new role "${want.name}"`),
      })
    } else {
      const cur = have[0]!
      const changes: FieldChange[] = []
      if (want.color !== undefined && resolveColorInput(want.color) !== resolveColorInput(cur.color ?? '#000000')) {
        changes.push({ field: 'color', before: cur.color ?? '#000000', after: want.color })
      }
      if (want.hoist !== undefined && want.hoist !== (cur.hoist ?? false)) {
        changes.push({ field: 'hoist', before: cur.hoist ?? false, after: want.hoist })
      }
      if (want.mentionable !== undefined && want.mentionable !== (cur.mentionable ?? false)) {
        changes.push({ field: 'mentionable', before: cur.mentionable ?? false, after: want.mentionable })
      }
      if (want.permissions && !sameSet(cur.permissions, want.permissions)) {
        changes.push({ field: 'permissions', before: [...(cur.permissions ?? [])].sort(), after: [...want.permissions].sort() })
      }
      // position intentionally not diffed — create-only (see SpecRole).
      if (changes.length > 0) {
        entries.push({
          kind: 'role', op: 'modify', name: want.name, changes,
          dangerous: dangerousGrants(cur.permissions, want.permissions).map(p => `grants ${p} to role "${want.name}"`),
        })
      }
    }
  }
  for (const r of current.roles ?? []) {
    if (!touchedRoles.has(r.name)) untouched.push(`role "${r.name}"`)
  }

  // Categories — matched by name; only their own overwrites are diffed here
  // (their channels go through the unified channel pass below).
  const desiredCats = desired.categories ?? []
  const dupCat = findDup(desiredCats.map(c => c.name))
  if (dupCat !== null) throw new Error(`spec.categories has duplicate name "${dupCat}"`)
  const currentCats = current.categories ?? []
  const currentCatsByName = new Map<string, SpecCategory[]>()
  for (const c of currentCats) {
    currentCatsByName.set(c.name, [...(currentCatsByName.get(c.name) ?? []), c])
  }
  const touchedCats = new Set<string>()
  for (const want of desiredCats) {
    if (!want.name || typeof want.name !== 'string') throw new Error('spec.categories: every category needs a name')
    touchedCats.add(want.name)
    const have = currentCatsByName.get(want.name) ?? []
    if (have.length > 1) {
      throw new Error(`category name "${want.name}" is ambiguous — ${have.length} categories share it; rename one in Discord first`)
    }
    if (have.length === 0) {
      const changes: FieldChange[] = []
      const dangerous: string[] = []
      if (want.overwrites) {
        validateSpecOverwrites(want.overwrites, `category "${want.name}"`)
        for (const o of want.overwrites) {
          changes.push({ field: `overwrite ${o.id}`, after: fmtOverwrite(o) })
          for (const p of dangerousGrants(undefined, o.allow)) {
            dangerous.push(`grants ${p} via overwrite ${o.id} on category "${want.name}"`)
          }
        }
      }
      entries.push({ kind: 'category', op: 'create', name: want.name, changes, dangerous })
    } else {
      const changes: FieldChange[] = []
      const edits: OverwriteEdit[] = []
      const dangerous: string[] = []
      diffOverwrites(have[0]!.overwrites, want.overwrites, `category "${want.name}"`, changes, edits, dangerous)
      if (changes.length > 0) {
        entries.push({ kind: 'category', op: 'modify', name: want.name, changes, overwriteEdits: edits, dangerous })
      }
    }
  }
  for (const c of currentCats) {
    if (!touchedCats.has(c.name)) untouched.push(`category "${c.name}"`)
  }

  // Channels — matched by (category name, channel name). A channel "moved"
  // to a different category in the spec reads as a create there; the
  // original is left untouched (additive semantics — nothing moves or dies).
  type Placed = { cat: string | null; ch: SpecChannel }
  const chanKey = (cat: string | null, name: string) => `${cat ?? ''}\u0000${name}`
  const chanLabel = (cat: string | null, name: string) => `channel "${cat ? `${cat} / ` : ''}#${name}"`
  const desiredChans: Placed[] = [
    ...desiredCats.flatMap(cat => (cat.channels ?? []).map(ch => ({ cat: cat.name as string | null, ch }))),
    ...(desired.channels ?? []).map(ch => ({ cat: null, ch })),
  ]
  const dupChan = findDup(desiredChans.map(p => chanKey(p.cat, p.ch.name)))
  if (dupChan !== null) {
    const [cat, name] = dupChan.split('\u0000')
    throw new Error(`spec has duplicate ${chanLabel(cat || null, name!)}`)
  }
  const currentChans: Placed[] = [
    ...currentCats.flatMap(cat => (cat.channels ?? []).map(ch => ({ cat: cat.name as string | null, ch }))),
    ...(current.channels ?? []).map(ch => ({ cat: null, ch })),
  ]
  const currentChansByKey = new Map<string, SpecChannel[]>()
  for (const p of currentChans) {
    const key = chanKey(p.cat, p.ch.name)
    currentChansByKey.set(key, [...(currentChansByKey.get(key) ?? []), p.ch])
  }
  const touchedChans = new Set<string>()
  for (const { cat, ch: want } of desiredChans) {
    if (!want.name || typeof want.name !== 'string') throw new Error('spec channels: every channel needs a name')
    const kind = want.kind ?? 'text'
    kindToChannelType(kind) // validates the kind string
    const label = chanLabel(cat, want.name)
    touchedChans.add(chanKey(cat, want.name))
    const have = currentChansByKey.get(chanKey(cat, want.name)) ?? []
    if (have.length > 1) {
      throw new Error(`${label} is ambiguous — ${have.length} channels share that name in the same place; rename one in Discord first`)
    }
    if (have.length === 0) {
      const changes: FieldChange[] = [{ field: 'kind', after: kind }]
      const dangerous: string[] = []
      if (want.topic !== undefined) changes.push({ field: 'topic', after: want.topic })
      if (want.slowmode !== undefined) changes.push({ field: 'slowmode', after: want.slowmode })
      if (want.nsfw !== undefined) changes.push({ field: 'nsfw', after: want.nsfw })
      if (want.overwrites) {
        validateSpecOverwrites(want.overwrites, label)
        for (const o of want.overwrites) {
          changes.push({ field: `overwrite ${o.id}`, after: fmtOverwrite(o) })
          for (const p of dangerousGrants(undefined, o.allow)) {
            dangerous.push(`grants ${p} via overwrite ${o.id} on ${label}`)
          }
        }
      }
      entries.push({ kind: 'channel', op: 'create', name: want.name, category: cat, changes, dangerous })
    } else {
      const cur = have[0]!
      // Only enforce the type-match guard when the spec EXPLICITLY sets a kind.
      // A modify that omits kind targets the existing channel as-is (any type),
      // so editing e.g. a voice channel's topic without restating kind is fine.
      if (want.kind !== undefined && (cur.kind ?? 'text') !== want.kind) {
        throw new Error(`${label} exists as ${cur.kind ?? 'text'} but the spec says ${want.kind} — channel types can't be changed; rename or remove it manually`)
      }
      const changes: FieldChange[] = []
      const edits: OverwriteEdit[] = []
      const dangerous: string[] = []
      if (want.topic !== undefined && (cur.topic ?? '') !== want.topic) {
        changes.push({ field: 'topic', before: cur.topic ?? '', after: want.topic })
      }
      if (want.slowmode !== undefined && (cur.slowmode ?? 0) !== want.slowmode) {
        changes.push({ field: 'slowmode', before: cur.slowmode ?? 0, after: want.slowmode })
      }
      if (want.nsfw !== undefined && (cur.nsfw ?? false) !== want.nsfw) {
        changes.push({ field: 'nsfw', before: cur.nsfw ?? false, after: want.nsfw })
      }
      diffOverwrites(cur.overwrites, want.overwrites, label, changes, edits, dangerous)
      if (changes.length > 0) {
        entries.push({ kind: 'channel', op: 'modify', name: want.name, category: cat, changes, overwriteEdits: edits, dangerous })
      }
    }
  }
  for (const { cat, ch } of currentChans) {
    if (!touchedChans.has(chanKey(cat, ch.name))) untouched.push(chanLabel(cat, ch.name))
  }

  return { entries, untouched }
}

function fmtVal(v: unknown): string {
  if (Array.isArray(v)) return `[${v.join(', ')}]`
  if (typeof v === 'string') return JSON.stringify(v)
  return String(v)
}

// Human-readable diff for the owner-approval DM: `+ create`, `~ modify`
// (before → after), inline ⚠ flags, then the `·` untouched list.
export function renderSpecDiff(diff: SpecDiff): string {
  const dangerCount = diff.entries.filter(e => e.dangerous.length > 0).length
  const lines: string[] = [
    `${diff.entries.length} change(s)${dangerCount > 0 ? ` — ⚠ ${dangerCount} with dangerous grants` : ''}`,
  ]
  for (const e of diff.entries) {
    const parts = e.changes.map(c =>
      c.before !== undefined ? `${c.field}: ${fmtVal(c.before)} → ${fmtVal(c.after)}` : `${c.field}: ${fmtVal(c.after)}`,
    )
    lines.push(`${e.op === 'create' ? '+' : '~'} ${specEntryLabel(e)}${parts.length > 0 ? ` — ${parts.join(', ')}` : ''}`)
    for (const d of e.dangerous) lines.push(`  ⚠ ${d}`)
  }
  if (diff.entries.length === 0) lines.push('(everything in the spec already matches)')
  if (diff.untouched.length > 0) lines.push(`· left untouched (not in spec): ${diff.untouched.join(', ')}`)
  return lines.join('\n')
}

// ── /access slash-command mutations (pure; operate on access.json groups) ──
export type GroupPolicyLike = { requireMention: boolean; allowFrom: string[] }

// Merge-grant: enable (or update) a guild channel, preserving any existing
// allowFrom restriction. Idempotent — re-granting just updates requireMention.
export function grantGroup(groups: Record<string, GroupPolicyLike>, channelId: string, requireMention: boolean): GroupPolicyLike {
  const merged = { ...groups[channelId], requireMention, allowFrom: groups[channelId]?.allowFrom ?? [] }
  groups[channelId] = merged
  return merged
}

// Returns false when the channel wasn't granted (nothing to remove).
export function removeGroup(groups: Record<string, GroupPolicyLike>, channelId: string): boolean {
  if (!(channelId in groups)) return false
  delete groups[channelId]
  return true
}

