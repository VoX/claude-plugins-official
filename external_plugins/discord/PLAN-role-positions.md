# Plan v3.1: role ordering in the server-spec tools

Status: PROPOSED. v3 folds in two plan reviews and **three new measurements (M9–M11)** taken to
settle questions the reviews showed v2 had reasoned past rather than measured.

The through-line of every revision so far is one failure: *a real number, from a real source,
answering a different question.* v1 read a rank as a raw. v2's M1 read a degenerate all-tied
guild as a general rule. v3's M9 run **printed its own verdict line backwards** — the rows under
it said 6 of 6 roles kept their position and the summary said "DENSE RENUMBER", because the
contiguity check it used passes both when nothing moved and when everything did. That is the
same shape a fourth time, caught only because the raw rows were printed next to the verdict.
§2 is therefore output, and §2.0 says what the output does not cover.

## 1. The request

Put `Owner` above `Moderator` on LSS, and generally: let the tools read and change role
hierarchy, and refuse legibly when they cannot. Two tool defects blocked it and misled me twice
— `get_server_spec` exported discord.js's `Role.position` (a computed rank, which cannot express
a tie) through a field documented as apply-ready, and `apply_server_spec` never diffed position
on modify, answering "already matches, 0 changes" to a reorder it never compared.

## 2. MEASURED FACTS (LSS guild `1526285091645689856`, 2026-08-27, live REST v10)

| # | Fact | Evidence |
|---|---|---|
| **M1** | A partial `PATCH` moved the named role and shifted roles at/above it up by one; roles below were untouched. **Holds only for that starting state** — see M9, which contradicts the shift half on a different one. | on a `5/4/3/2/1` guild, body `[{probe,2}]` → probe@2, Moderator 2→3, Bot 3→4, Owner 4→5, tinyclaw 5→6, Lodestone stayed @1 |
| **M1a** | **M1's first reading was WRONG and is retracted.** The first probe ran on an all-tied guild where every role sat at raw 1, so an insert at the bottom shifted everything and looked like a dense renumber. n=1 on a degenerate guild. | E2 vs E4 |
| **M1b** | **Deleting a role leaves a GAP.** Discord does not re-densify on delete. | after deleting probe@2: `6/5/4/3/_/1`, and again in M9 |
| **M2** | **The response is the full role list**, not an ack. | 7 roles returned from a 1-role request |
| **M3** | **`POST /roles` ignores `position` entirely.** Confirmed at the type level too: `RESTPostAPIGuildRoleJSONBody` has no `position` field. | asked `position: 3`, role landed at raw **1** |
| **M4** | New roles land at raw 1 — **tying with whatever already sits there.** | M9's probe landed at raw 1 beside `Lodestone`@1 |
| **M5** | A role tied on RAW with the bot, ranking BELOW it by the snowflake tie-break, is movable. **Demoted:** this rules out the hypothesis that Discord's gate is a strict raw `>` (which would have refused any tied role). It does **not** show the gate matches `editable`'s rank comparison — see M1's ordering for that. | E2 |
| **M6** | **The bot's OWN managed role, sitting at the ceiling, moved down one slot.** Nothing broader. A *foreign* managed role, and any managed role strictly below the ceiling, are **untested**. Moving your own role down is close to the most-permitted operation that exists. | E3 |
| **M7** | Writing positions **permanently un-ties** a tied guild. | before/after |
| **M8** | **The hierarchy gate is on BOTH ends.** A role safely below the bot cannot be moved above it. Probe at raw 1, bot at raw 6, target 7 → **`50013`**. | E5 |
| **M9** | **A partial write does NOT renumber the roles it omits — and does NOT honour the position it was given.** Body `[{probe, 3}]` on `6/5/4/3/_/1`: all **6** pre-existing roles kept their exact raw, and the probe landed at **2**, the free gap, *not* the 3 it asked for. | m9.cjs, full before/after table |
| **M10** | **A COMPLETE ordering with distinct positions is honoured VERBATIM, and re-applying it is a true no-op.** Sent all 6 roles `0..5`; response matched position for position; the identical body sent again changed nothing. | m10.cjs |
| **M11** | **A complete ordering containing a GAP is densified.** Asked `0,2,3,4,5,6`; got `0,1,2,3,4,5`. Discord normalises a complete body to contiguous-from-zero. | m10.cjs |
| **M12** | **With the bot NOT the top role, a complete body that NAMES a role above it is accepted.** VoX dragged `tinyclaw` below `Owner`; a verbatim re-assert of the current order → **200**. | m12.cjs |
| **M13** | **…and it still works when it actually moves things.** Same shape, but swapping two roles below the bot while naming `Owner` unchanged → **200**, the swap applied. This is the exact shipping case. | m13.cjs |
| **M14** | **Moving the role above the bot in that same body → `50013`.** So the rule is precisely "name anything, move only what is below you", and freezing is load-bearing rather than caution. | m13.cjs |

### 2.0 What these measurements do NOT establish

Stated up front because reading more from evidence than it carries is the failure that produced
v1, v2's M1, and M9's own verdict line.

- ~~The complete-ordering strategy is measured only where the bot is the TOP role.~~ **Now
  measured (M12–M14), and it was very nearly shipped on a guess.** Every earlier row was taken on
  LSS, the one guild where this bot is top — so no test body ever contained a role above the
  ceiling. Checking how often that would come up found the opposite of an edge case: **Wheat has 47
  roles above this bot, Cow Tools 14, hills 2. LSS is the only one where it is top.** The
  "untested edge" was the normal case on three servers out of four. It was not self-testable
  (lowering the bot is a one-way door — a bot cannot raise its own role), so VoX moved the role by
  hand for two minutes. Answer: a complete body may NAME anything and must MOVE only what is below
  the ceiling.
- **M5** is one role whose snowflake ranked it below the bot. The raw-tie case with the ordering
  reversed is untested.
- **M6** is the bot's own role at the ceiling. Another bot's is untested.
- **Every measurement was taken with `Administrator` held** (LSS grants it, plus ManageGuild /
  ManageRoles / ManageChannels / ManageWebhooks / Kick / Ban / MentionEveryone). Behaviour under
  `ManageRoles` alone is untested. Note M8 is evidence *against* the folk claim that Administrator
  bypasses the hierarchy gate: it refused with Administrator held.
- **Partial-write placement has no model.** M1 saw a shift; M9 saw a gap-fill and no shift; the
  requested position was honoured in one and not the other. §3.2 never sends a partial body, so
  this stays unresolved on purpose rather than being guessed at.
- **LSS is not the guild §2's early rows measured, and that is my own doing** — the original
  "Owner above Moderator" request was fulfilled between E5 and M9. A reviewer read the changed
  order as third-party drift. It was not; no one else has touched it.

### 2.1 Reviewer disagreements these settle

- **The snowflake tie-break, attributed correctly.** v2 credited M5. M5 is the weaker evidence.
  The real proof is **M1's resulting order**: after that write the hierarchy read
  `Moderator > Lodestone > Owner > Bot`, which is *exactly* oldest-snowflake-first
  (Moderator 2026-07-13, Lodestone 08-26, Owner 08-27 18:47:51.560, Bot 08-27 18:47:51.625), and
  `tinyclaw` predates all four, making it five-for-five. `Role.js:230-239` computes the identical
  order — smaller id ranks higher — and `discordSort` (`Util.js:319`) agrees independently.
  **Discord's server materialised the ordering discord.js computes.** Five roles, not one.
- **`role.editable` vs a raw `>=` comparison.** Use the **rank** comparison (raw, ties by
  snowflake), not a bare `>=` on raw, which M5 shows would refuse a legal move. Rank-writable is a
  strict subset of raw-writable, so the gate **errs conservative** — that, not "it matches
  Discord", is why it is safe.
- **Managed roles.** v2 said M6 proves they are repositionable. M6 proves the bot's own is, at the
  ceiling — a role §3.3 **freezes anyway**. So M6 supports nothing the design relies on. §3.3 is
  rewritten so no foreign managed role is ever asked to move.
- **Create-with-position.** `roles.create({position})` is not a unit bug, it is a hidden second
  write: `RoleManager.js:227` does `if (position) return this.setPosition(...)`. M3 shows REST has
  no position field at all. Same fix either way (never pass it). Bonus defect: `if (position)` is
  falsy-checked, so `position: 0` is silently dropped.

### 2.2 What a write actually costs — restated in the right unit

I have now given VoX two different blast-radius numbers and both were wrong, so this is stated in
the unit a human actually sees.

**A complete write renumbers every raw in the guild** (M10 moved four roles nobody named:
Moderator 3→2, Bot 4→3, Owner 5→4, tinyclaw 6→5) **while changing nobody's rank.** Raw numbers are
Discord's bookkeeping and are normalised whatever we do (M11). Rank is the hierarchy — who
outranks whom, what a human sees in the role list, what governs permissions.

So the approval prompt reports **rank changes** — and specifically the **crossings**, not the
index shifts. Inserting one role between two others shifts every role below it by one, so counting
changed indices reports a one-role move as "4 roles change rank". The live acceptance run said
exactly that before this was fixed. It now reads *"VSS Maintainer moves above Admin Bot, op,
Lodestone"*: who now outranks whom, which is the thing a human can check. Raw renumbering is
mentioned in one line as a side effect and never counted as a change. An approval that overstates
its blast radius trains the reader to ignore it, which is the same failure as understating it.

## 3. Design

### 3.1 Order is expressed RELATIONALLY

`{ name: "Owner", above: "Moderator" }` / `below`. Array order is rejected because it **cannot
express a tie either** — on a tied guild the exported array order is snowflake age, an artifact,
and making it authoritative would enshrine registration order as hierarchy. Relational statements
have no unit, so they cannot be given in the wrong one (the failure that caused all of this); they
survive a partial spec, matching `apply_server_spec`'s additive contract; and they are what VoX
actually said: *"owner comes before bot and bot comes above moderator"*.

`position` stays in the export as **read-only information**, documented as raw, tie-capable, and
not an instruction. **Corrected from v2:** v2 made supplying it a hard error, which breaks the
round-trip promised in four places (`server.ts:1786`, `:1799`, `:1806`, `README.md:104`) — feeding
an export straight back would fail. Instead:

- `position` **equal to** the live raw is accepted and ignored → a faithful round-trip stays a no-op.
- `position` **differing** from the live raw is a hard validation error naming `above`/`below` →
  which is exactly the case where the user edited it meaning to reorder, and exactly when that
  message is useful.

`above`/`below` accept `string | string[]`, because a single field cannot express "above X and
above Y". A constraint naming `@everyone` is unsatisfiable and **refuses**.

### 3.2 Write ONE COMPLETE ordering — now measured, not argued

v2 justified this on idempotence and called partial writes "well-defined (M1)". **They are not.**
M9 sent one entry asking for position 3 and got position 2. A partial body is *advisory*: what it
does depends on the gaps in the guild it lands on, and M1 and M9 disagree about the shift. There is
no model of it here and none is needed, because we never send one.

A **complete** ordering is honoured verbatim and is a genuine fixpoint (M10). That is the whole
argument, and it is now output rather than reasoning.

**v2's corollary — "must not try to densify; gaps are normal" — is DELETED. M11 refutes it:**
Discord densifies a complete body regardless of what we ask for. The planner therefore does not
get to preserve gaps, and must not report densification as a change it made.

Cycles and contradictions are refusals, not best-effort.

**Toposort determinism (or §8's zero-writes test is vacuous):** Kahn's algorithm with an unordered
ready-set gives an arbitrary order among unconstrained roles, so a satisfied constraint set would
emit spurious writes. Use a **priority queue keyed by current rank** (raw desc, snowflake
tie-break) so unconstrained roles keep their live relative order and an already-satisfied set is a
fixpoint that emits zero writes.

### 3.3 Gate BOTH ends; frozen roles are emitted UNMOVED

Per M8 the check is two-sided, and **each reviewer had one half**: v1 and the working tree check
only the destination (E5 shows that half is necessary); plan-reviewer-1 argued it should ask where
the role currently sits, via `role.editable` (M5 shows that half is necessary too). Neither alone
is right, and `role.editable` cannot supply the destination half at all — it only knows the role's
current seat — so it is the *source* test and nothing more.

A role is **frozen** if it ranks at or above the bot's highest role. Frozen roles are still
**emitted in the body at their current position**, because M10's guarantee needs a complete body —
but they are never asked to *move*, so no foreign managed role is ever the subject of a write. A
constraint naming a frozen role is a refusal that names it.

M12–M14 confirm this is exactly right: naming a frozen role is fine, moving one is `50013`. The
applier still **reports a refusal legibly and changes nothing** rather than retrying with a partial
body whose semantics M9 shows we do not understand — but that path is now the genuinely unexpected
case rather than the routine one. §8 pins it.

### 3.4 One batched write, then read the response back

One `PATCH /guilds/{id}/roles` via `rest.patch(Routes.guildRoles(id), { body })`.

**Never any discord.js position helper — `setPosition` (singular) and `setPositions` (plural)
are both forbidden.** v2 named only the singular, and the bug it describes actually lives in the
plural: `RoleManager.setPositions` (`RoleManager.js:364-377`) awaits the PATCH, **discards the
result**, and hands the *request* array to `GuildRolesPositionUpdate.handle`, which does
`role.rawPosition = partialRole.position` (`GuildRolesPositionUpdate.js:10-13`). So a plural call
would reintroduce the exact audited bug **and pass a test that only forbids the singular** — a
check whose pass looks like its failure. M9 makes the consequence concrete: we asked 3, Discord
gave 2, and a request-side cache would have reported 3 forever.

`setPosition` is worse still and is currently *in the working tree*: `Util.setPosition`
(`Util.js:335-341`) takes the sorted role array, moves the element to **array index** `position`,
and PATCHes the **whole guild** — so `await role.setPosition(want.position!)` at `server.ts:1447`
feeds a raw value into index space and issues a full-guild renumber **per role, in a loop**, each
computed from a cache the previous iteration already poisoned.

**Adopt positions from the response body (M2), not the request.** The response is `APIRole[]`
(snake_case, `permissions` a bitfield string, `color` an int) and carries **no rank field** — so
converting it back to `RawRole` must **recompute the rank** from the full set, or the adopt path
quietly yields roles with a stale rank.

## 4. Making `server.ts` testable

`server.ts` has **zero `export`s** (`grep -c "^export " server.ts` → 0) and importing it runs a
top-level `await mcp.connect(new StdioServerTransport())` (`:2414`) and `client.login()`. So the
seam test cannot be written today.

1. Split `server.ts` → `server.ts` (bootstrap) + **`apply.ts`** exporting `applySpecDiff`, with no
   module-scope side effects.
2. `applySpecDiff` gains `deps?: { writeRolePositions(w: {id,position}[]): Promise<APIRole[]> }`,
   defaulting to the real REST call. The seam test passes a recorder.
3. Extract `planRolePositions` into `lib.ts` as a pure function — §5.

**Corrections to v2's framing.** It is not the *only* change addressing finding **J**: three
env-gated self-test blocks already exercise real internals and `process.exit()` before login
(`:4036`, `:4071`, `:4092`), and they are the fallback if the split runs long. And the split is
bigger than v2 budgeted — module-scope side effects at import include `setInterval` (`:265`,
`:1127`), `process.on` handlers (`:429`, `:432`, `:2427-2430`), `new Client` (`:442`), `new Server`
(`:1089`), `mcp.set*Handler` (`:1141`, `:1601`, `:1841`), that top-level await, many `client.on`,
`const TOKEN = process.env.DISCORD_BOT_TOKEN` with a throw when unset (`:187`), and ~20
module-level `let` globals. A reviewer nonetheless performed the cut in a scratch copy — see §10a.

## 5. `planRolePositions`

```ts
planRolePositions(
  roles: ReadonlyArray<{ id: string; name: string; rawPosition: number; managed: boolean }>,
  constraints: ReadonlyArray<{ id: string; above?: string[]; below?: string[] }>,  // IDS, not names
  ctx: { botHighestRoleId: string; everyoneRoleId: string },
): { writes: Array<{id: string; position: number}>; frozen: string[] }
  | { refusal:
        | { kind: 'frozen';       blockingRoleIds: string[]; ceiling: number }
        | { kind: 'cycle';        roleIds: string[] }
        | { kind: 'unknown-role'; names: string[] }
        | { kind: 'contradiction'; roleIds: string[] } }
```

**ids not names** (a spec that renames *and* reorders hands the planner a name absent from
`current`); **`@everyone` must be visible** so raw 0 is known reserved; **the input must not carry
the rank** at all; **discriminated union** so `{writes, refusal}` together is unrepresentable.
The refusal is *itself* a union per review — v2's flat `{reason, blockingRoleIds, ceiling}` made
`ceiling` required for a cycle refusal, and a required field with no real value gets fabricated.

**Neither existing data source can supply `roles`, and v2 missed half of that.** `buildServerSpec`
drops managed roles (`lib.ts:423`, `.filter(r => !r.managed)`), and `snapshotGuild` drops
`@everyone` (`server.ts:1243`). §3.3 needs managed roles present and §5 needs `@everyone`. So the
planner takes a **new raw read** covering both, and §5a says how it reconciles with the applier's
deliberately managed-free name maps (`server.ts:1339`, `if (r.managed) continue`).

### 5a. Name → id resolution is a first-class step

The user surface is names; the planner takes ids; and `computeSpecDiff` emits role **creates with
no `id`**, because the snowflake does not exist until `guild.roles.create` runs (`server.ts:1415`).
Nothing in v2 owned that translation — and translation is precisely where the bug class being
fixed (silent misresolution) recurs.

- Resolve `above`/`below` against a snapshot taken **after creates and renames, immediately before
  the reorder**. Documented rule: **they refer to final names.** This answers the ambiguity v2
  could not — a spec that renames `Moderator`→`Mod` *and* says `above: "Moderator"` refuses,
  because post-rename there is no `Moderator`.
- A name resolving to **zero or more than one** role is a **refusal**, never a silent skip.
- Managed roles are visible to resolution (they are in the ordering) even though the applier's own
  name maps exclude them.

## 6. Consent

- **One guild-level diff entry**, not per-role — it is one PATCH that succeeds or fails whole.
  Needs a new `SpecDiffEntry.kind` (`lib.ts:459`) plus `specEntryLabel`, header counters, dispatch.
- **In the DM body, not the attachment.** `renderSpecDiff` output is sent as a file
  (`server.ts:1553-1557`); only `header` reaches the message.
- **But the body is hard-capped**, which v2 missed: `dangerLines` is `.slice(0, 10)` with "…and N
  more" (`server.ts:1521`) and the whole header is `safeSlice(header, 1900)` (`:1556`). A full
  before→after ordering will not fit and would be **silently cut** — the same failure one layer
  along. So the body gets a **bounded summary whose size is O(1) in guild size**: the count of
  roles whose *rank* changes, plus every privilege-relevant crossing. The full table goes in the
  attachment.
- **Populate `dangerous[]`** when a reorder lifts a role above one holding `Administrator` /
  `ManageRoles`, or above the bot's own role — the same class `dangerousGrants` already flags.
- **Re-plan at apply time**, and **v2's abort condition was wrong**: "abort if the live ordering
  changed" self-aborts on *this apply's own* changes. Creates, renames and deletes all run before
  the reorder (`lib.ts:910`), so the ordering has necessarily changed versus the approved snapshot.
  Instead: re-derive the plan from the **same constraints** against a fresh snapshot, and abort
  only if a **privilege-relevant** fact changed — a new role appeared inside the affected band, a
  role crossed above an `Administrator`/`ManageRoles` holder or above the bot when it did not in
  the approved plan, or a writable role became frozen. Additionally carry a hash of
  `(id, rawPosition)` over roles this apply does **not** touch and abort if that moved, which
  catches a concurrent third-party edit without tripping on our own. Cosmetic renumbering is not a
  consent change and must not abort.

## 7. Findings not to orphan

- **C** (apply reports `✓` without verifying): §3.4's read-back — compare response to intent and
  report a mismatch rather than a tick. M9 is the case that makes this non-theoretical.
- **D / L** (create path): never send position on create; M3 means the diff must not print it either.
- **G** (empty `role.edit({})`): `server.ts:1428-1433` builds the payload from four `changed.has()`
  spreads, so a position-only modify sends `edit({})`. Falls out once position is not a role field;
  assert it with a test rather than leaving it to a side effect.
- **Ordering vs `prune`**: the reorder runs **after** deletes, or it renumbers around roles about
  to vanish.
- **`localeCompare` tie-break** (`lib.ts:424`) — **v2 was right about the fix and wrong about the
  reason.** The current sort key is `RawRole.position`, the *rank*, and ranks are unique even when
  every role is tied on raw, so the tie-break is **dead code today**. It becomes live the moment
  the key switches to `rawPosition`, and it is wrong then: the 18→19 digit snowflake boundary falls
  at 2022-07-22, so any guild with roles from both sides has mixed-length ids and `localeCompare`
  inverts their order versus BigInt. Use BigInt.

## 8. Tests

Planner (pure, `lib.ts`): tied guild resolves using the snowflake tie-break and emits a complete
ordering; a frozen role is **emitted at its current position and listed in `frozen`**, and is never
in the moved set (this replaces v2's test that cited M6 for a case M6 did not cover); a constraint
naming a frozen role refuses with that role's id; contradictory constraints refuse; a cycle refuses
with `kind: 'cycle'` and no `ceiling` field to fabricate; a satisfied constraint set emits **zero**
writes, paired with a positive case in the same test so an unconditional `[]` cannot pass; the
unconstrained-role order is a fixpoint against the live order (pins §3.2's priority queue).

Applier (`apply.ts`, injected recorder): exactly one `writeRolePositions` call; its body is the
planner's output verbatim and **complete**; the recorder asserts a **raw REST call was made** —
not merely that two method names went uncalled, since forbidding only `setPosition` lets
`setPositions` through with the bug intact (§3.4); the **response**, not the request, updates state
(M2/M9); a `50013` on the batch surfaces as a legible refusal that changes nothing (§3.3).

Existing-test repairs: give the fixture roles rank and raw values that order *differently*, so
`lib.ts:424`'s sort is pinned to the field it uses — a reviewer deleted that sort outright and all
152 tests still passed.

## 9. Docs — the full list

`SpecRole.position` (raw, informational, can tie, accepted only when it matches — §3.1); the tool
descriptions at `server.ts:1787` and `:1799` including **"Re-applying a matching spec is a no-op"**
(true under §3.1's equal-value rule, false under v2's hard error) and **"exactly the shape
apply_server_spec consumes"**; the `spec` param enumeration at `:1804`; the `bot` block (drop the
duplicate `can_place_roles_below_raw_position`, rename the rank to `highest_role_rank`, move the
`/** */` comments out of the returned object — `JSON.stringify` strips them); and **`README.md:104`
and `:163`**, the latter currently stating *"Role `position` applies on create only — existing
roles are never reordered."*

## 10. Rollout

Installs are **per-user and independent**. tinyclaw is on `0.7.7` (sha `be6ec4c`); dweller is on
`0.7.1`, six versions behind; BMO's manifest is unreadable. Nothing reaches them until the
marketplace repo is committed **and pushed**.

- **Bump `.claude-plugin/plugin.json`** `0.7.7` → `0.8.0`. Cache dirs are version-keyed, so
  shipping under an unchanged `0.7.7` overwrites that directory in place and leaves **no artifact
  to roll back to**.
- Leave `package.json`'s unrelated `"version": "0.2.11"`.
- Update tinyclaw first, verify against LSS, then announce. Do not touch other instances' installs.
- **Verify against LSS's *current* state** — it is `@everyone 0 / Lodestone 1 / Moderator 2 /
  Bot 3 / Owner 4 / tinyclaw 5`, dense and un-tied, as M10 left it.

## 10a. Implementation order

Each step leaves the suite green and is shippable alone, so risk concentrates in exactly one place.

1. **Split `apply.ts` out of `server.ts`.** Pure refactor. A reviewer did it in a scratch copy:
   contiguous 228-line cut, zero coupling to `client`/`mcp`/module state, `import('./apply.ts')`
   standalone with no login, 152 green, `bun build` clean. First, so nothing rebases over it.
   `requireGuild` stays behind (it closes over `client`); `snapshotGuild` moves cleanly.
2. **Add `tsconfig.json` + `tsc --noEmit`.** There is **no type-checking in this repo at all** —
   `bun test` runs tests and bun strips types without checking them. Every union widening below is
   unenforced until this exists, so it is a prerequisite, not a tidy-up.
3. **Delete the uncommitted `setPosition` path** (`server.ts:1437-1447`) and the create-time
   position pass-through. §3.4 forbids it and the working tree currently *adds* one, so this is a
   deletion. Fix `SpecRole.position`'s doc and `README.md:163-164` in the same commit.
4. **`planRolePositions` in `lib.ts`**, pure, with §8's planner tests. No caller yet.
5. **Widen `SpecDiffEntry.kind`/`op`** plus `specEntryLabel`, render body, header counters, and —
   caught by a reviewer through execution — convert `applySpecDiff`'s trailing bare `else` into an
   explicit `e.kind === 'channel'` guard with a real default. Today an unknown kind falls into the
   **channel** branch and reports *"vanished between diff and apply"*; five of six sites fail
   **silently**. Land with the new kind still unreachable.
6. **Wire spec → diff → apply**: `SpecRole.above/below`, §5a's resolution step, the planner's new
   raw read (§5), emission into a segment appended **after** `deletions.role` (they are last at
   `lib.ts:907-913`, so the obvious placement puts the reorder *before* every delete), and the
   applier's `deps` seam. First step that cannot be split.
7. **DM rendering + `dangerous[]`** (§6), with the O(1) body summary and the full table in the
   attachment, respecting the `.slice(0, 10)` and 1900-char caps.
8. **Bump to `0.8.0`, commit, push, update tinyclaw only, verify against LSS.** `marketplace.json`
   carries no version and defers to `plugin.json`. Nothing in the repo validates the bump — no CI,
   no hook — so it is manual and only a human will catch it if missed.

## 11. Out of scope

Channel/category ordering — channels have no position field in the spec at all, and no shared
write path exists. Same questions, separate change.

## 12. What the three implementation reviews found

All three were adversarial, ran the code rather than reading it, and between them found one
**critical** defect the whole design existed to prevent. Recorded because the pattern matters more
than the list: every one of these was a real measurement answering a slightly different question
than the one being asked, which is the same failure this document opens by naming.

- **The repair loop silently violated constraints.** Subjects were lifted out of the order and
  re-inserted in topological order, so an `above` clause naming *another subject* read
  `indexOf(...) === -1` and was **discarded**. On VoX's own request — "Owner above Bot, Bot above
  Moderator" — it produced Owner *below* Moderator and reported success. A property test over 5000
  random guilds put it at 212 silently-violated orderings, 44 of which returned "nothing to do".
  Fixed by repairing against the full order and, crucially, **verifying before returning**, with the
  topological order as a guaranteed-valid fallback. Same 5000 cases now: 3643 satisfied, 1357
  correct refusals, **zero violations, zero false refusals**.
- **A satisfiable set was refused as a contradiction** (14% of random satisfiable sets), because the
  insertion window was computed against roles that never move. Same seam, same fix.
- **`dangerousReorder` was blind to live permissions** — it read them from the *spec*, and
  `apply_server_spec` is additive, so the ordinary partial spec restates nobody's permissions and
  every role read as harmless. The owner's approval DM showed **no warning** while a role was lifted
  over an Administrator holder. It also used the absolute index delta as a proxy for "gained rank",
  which misses a role that keeps its index and still crosses another.
- **Synthetic create-ids ran backwards.** Discord assigns ascending snowflakes and the smaller id
  ranks higher, so the first role created lands above the second; the projection had them reversed.
  A spec whose two new roles constrained each other therefore looked already-satisfied, emitted no
  ordering entry, and reported success on a spec it had not satisfied.
- **The consent check compared a SET OF NAMES.** That let a role already in the approved set be
  dragged to a different rank between approval and apply — and since the body is complete, our own
  PATCH then wrote that change in as though approved. Swapping two roles' names also slipped past.
  Now compares the approved final order **by id, position for position**, with created roles the
  only wildcards.
- **`bot.roles_out_of_reach` was wrong in both directions** — a raw `>=` reported a movable
  raw-tied role as unreachable, and `!managed` hid a foreign bot's role that really is frozen. It
  now asks the planner.
- **The approval DM truncated silently** above ~50-character role names, and the cut ate both the
  "…and N more" counter and the "Full diff attached." pointer. Now budgeted by characters: measured
  at Discord's 250-role cap with 100-char names it fits in 1350 and keeps both.
- **Frozen roles were renumbered** on any guild with gaps — and gaps are the normal state after a
  delete. They now keep their exact raw. Discord densifies a complete body anyway (M11), so the
  numbers are cosmetic; what is not cosmetic is *asking* a role above the ceiling for a different
  position when the only measured fact about those is that moving one is `50013`.
- **Two tests passed for the wrong reason.** The BigInt tie-break test passed zero constraints, so
  it compared the sort against itself and stayed green with `localeCompare` substituted in. The
  50013 test threw an `Error` with a `code` property, which is not a `DiscordAPIError`, so it never
  reached the branch it named and passed on the generic path. Both are now mutation-checked.
- **Zero coverage** on the consent check, the reorder-runs-last ordering, `resolveOrderingConstraints`
  (the exact silent-misresolution class §5a exists to prevent), and `dangerousReorder`. All four
  could be deleted or inverted with the suite staying green. Now 197 tests, and every new one was
  mutation-checked: eleven separate mutations, each caught by the test that names it.

Two smaller things worth keeping: a non-numeric role id used to crash the whole diff, because
`BigInt(id)` throws; and 13 imports orphaned by the `apply.ts` split were invisible until
`noUnusedLocals` was turned on, which is now on and green.
