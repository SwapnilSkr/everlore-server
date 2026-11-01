import assert from 'node:assert/strict'
import { readFile, readdir, rm } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { mock } from 'bun:test'
import { ObjectId } from 'mongodb'
import type { Job } from 'bullmq'
import { rollSpeakers, advanceSilence, pickAddressed, rollBystanders } from '../src/services/group-chat/roll'
import { parseLines, filterLines, timeLines, emptyLineCounts, trimReply } from '../src/services/group-chat/lines'
import { buildGroupStatic, buildGroupDynamic, buildAddressedStatic } from '../src/services/group-chat/prompt'
import { writeGroupReply } from '../src/services/group-chat/reply'
import { validateGroup } from '../src/services/group-chat/validation'
import { publicGroupData } from '../src/services/group-chat/public'
import { members, groupTemplate, owenReply } from './group-chat-fixtures'
import type { GroupTurnJob } from '../worker/processors/group-turn.processor'
import type { WorldInstanceDoc } from '../src/models/world-instance.model'
import type { WorldTemplateDoc } from '../src/models/world-template.model'

let passed = 0
async function check(label: string, fn: () => unknown) {
  if (process.env.GROUP_AUDIT_ONLY && !label.startsWith(process.env.GROUP_AUDIT_ONLY)) return
  try { await fn() } catch (error) { throw new Error(`FAIL ${label}`, { cause: error }) }
  passed++; console.log(`PASS ${label}`)
}
const ids = members.map(member => member.id)
const names = members.map(member => member.name)
const zero = Object.fromEntries(ids.map(id => [id, 0]))
const never = () => 0.999999
const template = groupTemplate()
const playerName = 'Test Player'
const opts = { members, speakers: ids, origin: 'player' as const, previous: [], openings: template.opening_lines!, blocked: () => false }

await check('roll formula, silence growth and saturation', () => {
  assert.equal(rollSpeakers(members, zero, 'player', '', never).chances[ids[0]], 0.3)
  assert(Math.abs(rollSpeakers(members, { [ids[0]]: 3 }, 'player', '', never).chances[ids[0]] - 0.66) < 1e-12)
  assert.equal(rollSpeakers(members, { [ids[0]]: 100 }, 'player', '', never).chances[ids[0]], 1)
})
await check('tags always included; case-insensitive whole names; plain-name +0.5; tag has no bonus', () => {
  const roll = rollSpeakers(members, zero, 'player', `@${names[3].toLowerCase()} ${names[1]}`, never)
  assert(roll.picked.includes(ids[3])); assert.deepEqual(roll.tags, [ids[3]])
  assert.equal(roll.chances[ids[1]], 0.8); assert.equal(roll.chances[ids[3]], 0.3)
  assert.equal(rollSpeakers(members, zero, 'player', `x${names[0]} ${names[1]}suffix @${names[2]}more`, never).chances[ids[0]], 0.3)
  assert.deepEqual(rollSpeakers(members, zero, 'player', `x@${names[0]} @${names[1]}suffix`, never).tags, [])
})
await check('player minimum one and unprompted/catchup minimum two; highest chance and stable tie', () => {
  assert.deepEqual(rollSpeakers(members, zero, 'player', '', never).picked, [ids[0]])
  assert.deepEqual(rollSpeakers(members, { [ids[2]]: 4 }, 'player', '', never).picked, [ids[2]])
  for (const origin of ['unprompted', 'catchup'] as const) assert.equal(rollSpeakers(members, zero, origin, '', never).picked.length, 2)
})
await check('no member is barred across seeded rolls; silence resets only on actual speech', () => {
  let seed = 91
  const seen = new Set<string>()
  for (let i = 0; i < 500; i++) for (const id of rollSpeakers(members, zero, 'player', '', () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32)).picked) seen.add(id)
  assert.deepEqual([...seen].sort(), [...ids].sort())
  assert.deepEqual(advanceSilence(members, zero, [ids[0]]), Object.fromEntries(ids.map((id, i) => [id, i ? 1 : 0])))
})
await check('parser prefixes, continuation; player and unknown dropped with their continuations', () => {
  const counts = emptyLineCounts()
  const lines = parseLines(`${names[0]}: first\ncontinued\n**${names[1]}:** second\n${playerName}: forbidden\nleaked player continuation\nUnknown Writer: forbidden\nunknown continuation\n**${names[2]}**: third`, members, playerName, counts)
  assert.deepEqual(lines, [{ name: names[0], text: 'first continued' }, { name: names[1], text: 'second' }, { name: names[2], text: 'third' }])
  assert.equal(counts.player, 1); assert.equal(counts.unknown, 3)
})
await check('off-list speakers dropped', () => {
  const counts = emptyLineCounts()
  assert.equal(filterLines([{ name: names[1], text: 'off list' }], { ...opts, speakers: [ids[0]] }, counts).length, 0)
  assert.equal(counts.off_list, 1)
})
await check('two per person, four per catchup after merge', () => {
  const input = members.flatMap(member => [0, 1, 2].map(index => ({ name: member.name, text: `line ${index}` })))
  const counts = emptyLineCounts()
  assert.equal(filterLines(input, opts, counts).length, 8); assert.equal(counts.over_cap, 4)
  assert.equal(filterLines(input, { ...opts, origin: 'catchup' }, emptyLineCounts()).length, 4)
})
await check('duplicates from last five and opening dropped; old sixth line allowed; normalized case and whitespace', () => {
  const previous = Array.from({ length: 6 }, (_, i) => ({ name: names[0], text: `prior ${i}` }))
  const counts = emptyLineCounts()
  const lines = filterLines([{ name: names[0], text: '  PRIOR   5 ' }, { name: names[0], text: 'prior 1' }, ...template.opening_lines!, { name: names[0], text: 'prior 0' }], { ...opts, previous }, counts)
  assert.deepEqual(lines, [{ name: names[0], text: 'prior 0' }]); assert.equal(counts.duplicate, 3)
})
await check('generated unsafe lines dropped', () => {
  const counts = emptyLineCounts()
  assert.equal(filterLines([{ name: names[0], text: 'flagged' }], { ...opts, blocked: () => true }, counts).length, 0)
  assert.equal(counts.unsafe, 1)
})
await check('reveal spacing 1.5–4 seconds from now; catchup times strictly inside gap', () => {
  const now = new Date('2026-11-01T12:00:00Z'), start = new Date('2026-11-01T03:00:00Z')
  const input = ids.map((id, i) => ({ name: names[i], text: `message ${i}` }))
  for (const rng of [() => 0, never]) {
    const lines = timeLines(input, members, now, undefined, rng)
    assert.equal(+lines[0].shown_at, +now)
    for (let i = 1; i < lines.length; i++) assert(+lines[i].shown_at - +lines[i - 1].shown_at >= 1500 && +lines[i].shown_at - +lines[i - 1].shown_at <= 4000)
  }
  const catchup = timeLines(input, members, now, start)
  assert(catchup.every((line, i) => +line.shown_at > +(i ? catchup[i - 1].shown_at : start) && +line.shown_at < +now))
})
await check('static prompt identical across calls; other saves isolated; no choice tail or scene-state instructions', () => {
  const first = buildGroupStatic({ ...template, members, player: playerName })
  const other = buildGroupStatic({ ...template, global_lore: 'Other save private lore', members, player: 'Other Player' })
  assert.equal(first, buildGroupStatic({ ...template, members, player: playerName })); assert(!first.includes('Other save private lore')); assert.notEqual(first, other)
  assert(!/CHOICES_JSON|SCENE STATE|state_mutations|you ARE this entity|present_characters/.test(first))
  for (const text of [template.seed_prompt, 'You write this group chat', 'Messages are short, as texts are', template.global_lore, ...members.map(member => member.group.wants)]) assert(first.includes(text))
  const dynamic = buildGroupDynamic({ memories: ['Save memory'], summaries: ['Save summary'], history: Array.from({ length: 31 }, (_, i) => ({ name: names[0], text: `history-${i}` })), now: new Date('2026-11-01T23:50Z'), offsetMinutes: 90, speakers: [names[1]], situation: 'Situation marker' })
  assert(dynamic.includes('Monday') && dynamic.includes('01:20')); assert(!dynamic.includes('history-0\n')); assert(dynamic.includes('history-30')); assert(dynamic.includes('Save memory') && dynamic.includes('Save summary') && dynamic.endsWith('Situation marker'))
})
await check('tag repair merged; empty primary retries then falls back; complete failure throws', async () => {
  let calls: Array<[string[], boolean]> = []
  const input = { ...opts, player: playerName, tags: [ids[1]], write: async (speakers: string[], fallback: boolean) => { calls.push([speakers, fallback]); return { content: `${calls.length === 1 ? names[0] : names[1]}: reply ${calls.length}`, model: 'fake' } } }
  const repaired = await writeGroupReply(input)
  assert.equal(repaired.lines.length, 2); assert.deepEqual(calls[1][0], [ids[1]]); assert.equal(calls[1][1], false)
  calls = []
  const recovered = await writeGroupReply({ ...input, tags: [], write: async (speakers, fallback) => { calls.push([speakers, fallback]); return { content: fallback ? `${names[0]}: recovered` : '', model: 'fake' } } })
  assert.equal(recovered.lines.length, 1); assert.equal(calls.length, 3); assert.equal(calls[2][1], true)
  await assert.rejects(writeGroupReply({ ...input, write: async () => ({ content: '', model: 'fake' }) }), /could not finish/)
})
await check('group validation rejects unsafe adults, stats, sentience, invalid cast, traits, topics and openings', () => {
  validateGroup(template)
  for (const patch of [
    { is_sentient: true }, { base_stats_template: { score: { default: 0, min: 0, max: 1, description: 'score' } } },
    { seed_cast: template.seed_cast!.slice(0, 3) },
    { seed_cast: template.seed_cast!.map((member, i) => i ? member : { ...member, name: template.seed_cast![1].name.toLowerCase() }) },
    ...[{ age: 17 }, { talkativeness: -0.1 }, { talkativeness: 1.1 }, { speech: ' ' }, { wants: ' ' }].map(patch => ({ seed_cast: template.seed_cast!.map((member, i) => i ? member : { ...member, group: { ...member.group!, ...patch } }) })),
    { topics: [] }, { opening_lines: [{ name: 'Unknown Writer', text: 'bad' }] },
  ]) assert.throws(() => validateGroup({ ...template, ...patch }))
})

await check('addressed pick uses first tag, then first named, then first roll with structural boundaries', () => {
  assert.equal(pickAddressed(members, `@${names[3]} then @${names[0]}`, ids), ids[3])
  assert.equal(pickAddressed(members, `${names[3]}, ${names[0]}`, ids), ids[3])
  assert.equal(pickAddressed(members, `${names[0]} @${names[2]}`, ids), ids[2])
  assert.equal(pickAddressed(members, `x@${names[3]} ${names[0]}suffix`, [ids[1]]), ids[1])
  assert.equal(pickAddressed(members, `@${names[2].toLowerCase()}`, ids), ids[2])
})
await check('adult bystander roll skips half, selects first other roll, and always includes other tags', () => {
  assert.deepEqual(rollBystanders(ids, [], ids[0], () => 0.499), [])
  assert.deepEqual(rollBystanders(ids, [], ids[0], () => 0.5), [ids[1]])
  assert.deepEqual(rollBystanders([ids[0]], [], ids[0], never), [])
  assert.deepEqual(rollBystanders(ids, [ids[0], ids[2], ids[3]], ids[0], () => 0), [ids[2], ids[3]])
})
await check('adult line checks strip paired and unpaired directions before blank, repeat and voice checks; caps gate', () => {
  const counts = emptyLineCounts()
  const raw = `${names[0]}: *laughs* Fresh words
${names[0]}: *only action*
${names[0]}: *unclosed leading
${names[0]}: unclosed trailing*
${names[0]}: *laughs*  AUTHORED   TEXT 0
${names[0]}: *sighs* Prior line
${names[0]}: second
${names[0]}: third
${names[0]}: fourth
${names[1]}: other one
${names[1]}: other two
${names[1]}: other three`
  const result = filterLines(parseLines(raw, members, playerName, counts), { ...opts, addressed: ids[0], previous: [{ name: names[0], text: 'prior line' }] }, counts)
  assert.deepEqual(result.map(line => line.text), ['Fresh words', 'second', 'third', 'other one', 'other two'])
  assert.equal(counts.stage_directions, 6); assert.equal(counts.empty, 3)
  assert.equal(counts.copied_example, 1); assert.equal(counts.duplicate, 1); assert.equal(counts.over_cap, 2)
  assert.equal(filterLines([{ name: names[0], text: 'first' }, { name: names[0], text: 'second' }], { ...opts, oneMessage: true }, emptyLineCounts()).length, 1)
})
await check('repeated openers compare two normalized words against only that member last three lines', () => {
  const previous = [
    { name: names[0], text: 'Old opening outside the window.' },
    { name: names[0], text: 'First phrase from three lines ago.' },
    { name: names[1], text: 'Other member says this.' },
    { name: names[0], text: 'Second phrase from two lines ago.' },
    { name: names[0], text: 'Third phrase from the last line.' },
  ]
  const counts = emptyLineCounts()
  const options = { ...opts, previous, addressed: ids[0], repeatedOpener: true }
  for (const text of ['FIRST,   phrase is changed.', 'Second PHRASE has new words.', '*waves* “third”—phrase still repeats.']) {
    assert.deepEqual(filterLines([{ name: names[0], text }], options, counts), [])
  }
  assert.equal(counts.repeated_opener, 3)
  for (const text of ['Old opening is allowed now.', 'Other member has a different speaker.', 'First different second word.', 'First']) {
    assert.equal(filterLines([{ name: names[0], text }], options, counts).length, 1)
  }
  assert.equal(filterLines([{ name: names[1], text: 'First phrase from someone else.' }], options, counts).length, 1)
  assert.equal(filterLines([{ name: names[0], text: 'First phrase on a normal turn.' }], { ...options, repeatedOpener: false }, counts).length, 1)
  assert.equal(counts.repeated_opener, 3)
  const fresh = filterLines([{ name: names[0], text: 'Fresh start in this reply.' }, { name: names[0], text: 'Fresh start repeated within the reply.' }], options, counts)
  assert.deepEqual(fresh.map(line => line.text), ['Fresh start in this reply.'])
  assert.equal(counts.repeated_opener, 4)
  assert.equal(filterLines([{ name: names[1], text: 'Other member says it differently.' }], options, counts).length, 1)
  assert.equal(filterLines([{ name: names[0], text: 'YES' }], { ...options, previous: [{ name: names[0], text: 'yes' }] }, emptyLineCounts()).length, 0) // Exact repeats still gate.
  assert.equal(filterLines([{ name: names[0], text: 'YES!' }], { ...options, previous: [{ name: names[0], text: 'yes' }] }, counts).length, 1)
})
await check('adult validation requires authored intimacy and 1–8 voice lines and rejects unknown shapes even when optional', () => {
  const patch = (group: unknown, capable = true) => ({ ...template, is_nsfw_capable: capable, seed_cast: template.seed_cast!.map((member, index) => index ? member : { ...member, group }) }) as WorldTemplateDoc
  const base = members[0].group
  for (const intimacy of [undefined, null, '', ' ', 42, []]) assert.throws(() => validateGroup(patch({ ...base, intimacy })))
  for (const voice of [undefined, null, '', [], [' '], [1], ['two\nlines'], Array(9).fill('text')]) assert.throws(() => validateGroup(patch({ ...base, voice })))
  assert.throws(() => validateGroup(patch({ ...base, unknown: 'field' })))
  assert.throws(() => validateGroup(patch({ ...base, voice: {} }, false)))
  const { intimacy, voice, ...optional } = base
  validateGroup(patch(optional, false))
  validateGroup(patch({ ...base, voice: Array(8).fill('text') }))
})
await check('addressed prompt is authored per person with player gender sentence and unchanged boundaries', async () => {
  const prompt = buildAddressedStatic({ ...template, members, player: playerName }, members[2])
  for (const text of ['one to three', members[2].group.intimacy!, ...members[2].group.voice!, `${playerName}'s gender isn't stated, so don't assume it.`, 'answers what was actually said', 'turns it down', 'Say something new']) assert(prompt.includes(text))
  for (const other of members.filter(member => member.id !== ids[2])) assert(!prompt.includes(other.group.wants) && !prompt.includes(other.group.intimacy!))
  const { NARRATIVE_BOUNDARIES } = await import('../src/utils/prompt-builder')
  assert(prompt.includes(NARRATIVE_BOUNDARIES.trim()))
  assert(!buildGroupStatic({ ...template, members, player: playerName }).includes(members[2].group.intimacy!))
})

await check('interested is required boolean for capable members and validated when optional', () => {
  for (const capable of [false, true]) for (const interested of [undefined, null, 'false', 0, {}, [], false, true]) {
    const changed = { ...template, is_nsfw_capable: capable, seed_cast: template.seed_cast!.map(member => ({ ...member, group: { ...member.group!, interested } })) } as WorldTemplateDoc
    if (typeof interested === 'boolean' || (!capable && interested === undefined)) validateGroup(changed)
    else assert.throws(() => validateGroup(changed), /interested/)
  }
})
await check('sentence trimming uses structural ends, preserves emoji and limits adult messages only', () => {
  for (const end of ['.', '!', '?', '…', '🙂', '👩🏽‍💻', '🇮🇳', '1️⃣']) {
    assert.equal(trimReply(`Complete${end} unfinished`, true, false), `Complete${end}`)
    assert.equal(trimReply(`Complete${end}`, true, false), `Complete${end}`)
  }
  assert.equal(trimReply('Complete. 🙂 unfinished', true, false), 'Complete. 🙂')
  assert.equal(trimReply('Complete. 👩🏽‍💻 🇮🇳 unfinished', true, false), 'Complete. 👩🏽‍💻 🇮🇳')
  assert.equal(trimReply('version 1.2 unfinished!suffix', true, false), '')
  assert.equal(trimReply('unfinished', true, true), '')
  const long = `Short. ${'long '.repeat(70)}`.trim()
  assert.equal(trimReply(long, false, true), 'Short.')
  assert.equal(trimReply(long, false, false), long)
  assert.equal(trimReply('word '.repeat(70).trim(), false, true), 'word '.repeat(56).trim())
  assert.equal(trimReply('x'.repeat(281), false, true), 'x'.repeat(280))
  const exact = `${'x'.repeat(278)}🙂`
  assert.equal(trimReply(exact, false, true), exact)
  assert.equal(trimReply('x'.repeat(279) + ' 👩🏽‍💻 tail', false, true), 'x'.repeat(279))
  assert.equal(trimReply('Short. ' + 'x'.repeat(268) + ' end. 🙂', false, true), 'Short.')
  const counts = emptyLineCounts()
  const kept = filterLines([{ name: names[0], text: 'Complete. partial' }], { ...opts, finishReason: 'length' }, counts)
  assert.equal(kept[0].text, 'Complete.'); assert.equal(counts.trimmed, 1)
  assert.equal(filterLines([{ name: names[0], text: 'partial' }], { ...opts, finishReason: 'length' }, counts).length, 0)
  assert.equal(counts.empty, 1); assert.equal(counts.trimmed, 2)
  const multi = filterLines([{ name: names[0], text: 'Earlier text' }, { name: names[1], text: 'Last. partial' }], { ...opts, finishReason: 'length' }, emptyLineCounts())
  assert.deepEqual(multi.map(line => line.text), ['Earlier text', 'Last.'])
})
await check('writer finish reason exposed by real transport', async () => {
  const child = Bun.spawn(['bun', '--no-env-file', 'run', 'scripts/group-chat-finish-audit.ts'], { cwd: new URL('..', import.meta.url).pathname, stdout: 'pipe', stderr: 'pipe' })
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  assert.equal(code, 0, out + err)
})

// A real processor runs below against in-memory documents and a fake writer.
// No Mongo/Redis clients, network transport, timers or paid models are started.
type Row = Record<string, unknown>
const tables = new Map<string, Row[]>()
function rows(name: string) { if (!tables.has(name)) tables.set(name, []); return tables.get(name)! }
function lookup(value: unknown, keys: string[]): unknown {
  if (!keys.length) return value
  if (Array.isArray(value)) return value.flatMap(entry => lookup(entry, keys))
  if (!value || typeof value !== 'object') return undefined
  return lookup((value as Row)[keys[0]], keys.slice(1))
}
const get = (row: Row, path: string) => lookup(row, path.split('.'))
function put(row: Row, path: string, value: unknown) {
  const keys = path.split('.'); let current = row
  for (const key of keys.slice(0, -1)) { current[key] ??= {}; current = current[key] as Row }
  current[keys.at(-1)!] = value
}
const eq = (a: unknown, b: unknown) => a instanceof ObjectId && b instanceof ObjectId ? a.equals(b) : a === b
function matches(row: Row, filter: Row): boolean {
  return Object.entries(filter).every(([key, expected]) => {
    if (key === '$and') return (expected as Row[]).every(clause => matches(row, clause))
    if (key === '$or') return (expected as Row[]).some(clause => matches(row, clause))
    const value = get(row, key)
    if (expected && typeof expected === 'object' && !(expected instanceof ObjectId) && !(expected instanceof Date)) return Object.entries(expected).every(([op, other]) => {
      if (op === '$ne') return !(Array.isArray(value) ? value.some(entry => eq(entry, other)) : eq(value, other))
      if (op === '$exists') return (value !== undefined) === other
      if (op === '$in') return (other as unknown[]).some(other => Array.isArray(value) ? value.some(entry => eq(entry, other)) : eq(value, other))
      if (op === '$lte') return Number(value) <= Number(other)
      if (op === '$lt') return Number(value) < Number(other)
      if (op === '$gte') return Number(value) >= Number(other)
      if (op === '$gt') return Number(value) > Number(other)
      throw new Error(`Unsupported audit operator ${op}`)
    })
    return Array.isArray(value) ? value.some(entry => eq(entry, expected)) : eq(value, expected)
  })
}
const clone = <T>(input: T): T => {
  if (!input || typeof input !== 'object' || input instanceof Date || input instanceof ObjectId) return input
  if (Array.isArray(input)) return input.map(clone) as T
  return Object.fromEntries(Object.entries(input).map(([key, value]) => [key, clone(value)])) as T
}
let consentReadHook: (() => void) | undefined
function collection(name: string) {
  return {
    aggregate() {
      assert.equal(name, 'worldInstances')
      return { toArray: async () => [{ rows: rows(name).map(latest => ({ latest: clone(latest) })), count: [{ total: rows(name).length }] }] }
    },
    find(filter: Row = {}, options?: { projection?: Record<string, number> }) {
      let values = rows(name).filter(row => matches(row, filter))
      const cursor = {
        sort(order: Record<string, number>) { values.sort((a, b) => { for (const [key, dir] of Object.entries(order)) { const av = get(a, key), bv = get(b, key); if (av !== bv) return (Number(av) < Number(bv) ? -1 : 1) * dir } return 0 }); return cursor },
        limit(n: number) { values = values.slice(0, n); return cursor }, skip(n: number) { values = values.slice(n); return cursor },
        project(fields: Record<string, number>) { values = values.map(value => Object.fromEntries(Object.keys(fields).filter(key => fields[key] && key in value).map(key => [key, value[key]]))); return cursor }, async toArray() {
          if (!options?.projection) return clone(values)
          return values.map(value => {
            const projected: Row = options.projection!._id === 0 ? {} : { _id: value._id }
            for (const [key, include] of Object.entries(options.projection!)) if (include && get(value, key) !== undefined) put(projected, key, clone(get(value, key)))
            return projected
          })
        },
      }
      return cursor
    },
    async findOne(filter: Row, options?: { sort?: Record<string, number>; projection?: Row }) { if (name === 'users' && options?.projection) consentReadHook?.(); let cursor = this.find(filter); if (options?.sort) cursor = cursor.sort(options.sort); return (await cursor.toArray())[0] || null },
    async countDocuments(filter: Row) { return rows(name).filter(row => matches(row, filter)).length },
    async insertOne(row: Row) { rows(name).push(clone(row)); return { insertedId: row._id } },
    async updateOne(filter: Row, update: Row, options?: { upsert?: boolean }) {
      let row = rows(name).find(row => matches(row, filter)); const existed = !!row
      if (!row && options?.upsert) { row = { ...filter }; rows(name).push(row); Object.assign(row, clone(update.$setOnInsert)) }
      if (row) {
        for (const [key, value] of Object.entries((update.$set || {}) as Row)) put(row, key, clone(value))
        for (const [key, value] of Object.entries((update.$inc || {}) as Row)) put(row, key, Number(get(row, key) || 0) + Number(value))
        for (const [key, value] of Object.entries((update.$max || {}) as Row)) if (get(row, key) === undefined || Number(get(row, key)) < Number(value)) put(row, key, value)
        for (const key of Object.keys((update.$unset || {}) as Row)) delete row[key]
      }
      return { matchedCount: existed ? 1 : 0, modifiedCount: existed ? 1 : 0 }
    },
    async updateMany(filter: Row, update: Row) {
      let modifiedCount = 0
      for (const row of rows(name).filter(row => matches(row, filter))) { await this.updateOne({ _id: row._id }, update); modifiedCount++ }
      return { modifiedCount }
    },
    async deleteMany(filter: Row) { const list = rows(name); const kept = list.filter(row => !matches(row, filter)); list.splice(0, list.length, ...kept); return { deletedCount: list.length - kept.length } },
    async deleteOne(filter: Row) { const index = rows(name).findIndex(row => matches(row, filter)); if (index >= 0) rows(name).splice(index, 1); return { deletedCount: index >= 0 ? 1 : 0 } },
  }
}
const frames: Row[] = [], outbox: Row[] = [], locks = new Map<string, string>(), queued: Row[] = []
const redis = {
  async get(key: string) { return locks.get(key) || null },
  async set(key: string, value: string, ...args: unknown[]) { if (args.includes('NX') && locks.has(key)) return null; locks.set(key, value); return 'OK' },
  async del(key: string) { locks.delete(key); return 1 },
  async publish(channel: string, text: string) { assert(channel.startsWith('user:')); frames.push(JSON.parse(text)); return 1 },
  async eval(_script: string, _keys: number, key: string, outcomeKey: string, before: string, after: string, _ttl: string, outcome: string, channel: string, frame: string) {
    if (_keys === 1) { if (locks.get(key) === outcomeKey) { locks.delete(key); return 1 }; return 0 }
    if ((locks.get(key) || '') !== before) return 0
    if (channel) await this.publish(channel, frame)
    if (after) locks.set(key, after); else locks.delete(key)
    if (outcome) locks.set(outcomeKey, outcome)
    return 1
  },
}
const unavailable = (): never => { throw new Error('Unexpected external dependency in group audit') }
globalThis.fetch = Object.assign(async () => unavailable(), { preconnect: unavailable })
const auditEnv = { NSFW_SAME_TURN_ROUTER: 'off', NSFW_SAME_TURN_ROUTER_MODEL: 'fake-router', NSFW_SAME_TURN_ROUTER_HOST: 'fixture' }
let routerRequests = 0, routerDelay = 0, routerSexual = true, routerError = false
mock.module('../src/config/env', () => ({ env: { ...auditEnv, get NSFW_SAME_TURN_ROUTER() { return auditEnv.NSFW_SAME_TURN_ROUTER }, CDN_BASE_URL: 'https://fixture.invalid', JWT_SECRET: 'audit-only', MEDIA_VOICE_ENABLED: false } }))
mock.module('../src/config/mongo', () => ({ mongoColl: new Proxy({}, { get: (_target, key) => () => collection(String(key)) }) }))
mock.module('../src/config/redis', () => ({ getRedisClient: () => redis, getQueueRedisClient: unavailable, getRedisSubscriber: unavailable }))
const routerClient = { chat: { completions: { create: async () => {
  routerRequests++
  if (routerError) throw new Error('Fixture router unavailable')
  await new Promise(resolve => setTimeout(resolve, routerDelay))
  return { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ sexual_intent: routerSexual }) } }] }
} } } }
mock.module('../src/config/openai', () => ({ getOpenRouter: () => ({ withOptions: () => routerClient }), getOpenAI: unavailable }))
const backgroundScopes: Row[] = []
mock.module('../src/services/llm-trace.service', () => ({ flushLLMTracesLater: () => {}, flushLLMTraces: async () => {}, traceStore: () => ({ calls: collection('llmCalls'), bodies: collection('llmBodies') }), runBackgroundLLMTrace: async (scope: Row, fn: () => Promise<unknown>) => { backgroundScopes.push(scope); return fn() } }))
let ragMemoryTexts = ['Remembered group fact.'], ragOpenThreads: string[] = [], ragCalls: unknown[][] = []
mock.module('../src/providers/rag.provider', () => ({ queryRag: async (...args: unknown[]) => { ragCalls.push(args); return { memoryTexts: ragMemoryTexts, openThreads: ragOpenThreads } }, querySummaries: async () => [] }))
mock.module('../src/services/post-process-outbox.service', () => ({ stagePostProcess: async (input: Row) => { outbox.push(input) }, dispatchPostProcessOutbox: async () => 0 }))
mock.module('../src/services/media/attribution', () => ({ ATTRIBUTION_RULE_VERSION: 'audit', mediaRevision: () => 'audit' }))
mock.module('../src/services/moderation.service', () => ({ moderationService: { discoveryFilter: async () => ({}) } }))
const checkLogs: Row[] = [], memoryLogs: Row[] = []
mock.module('../src/utils/logger', () => ({ log: { info: (name: string, data: Row) => { if (name === 'group.reply_checked') checkLogs.push(data); memoryLogs.push({ name, ...data }) }, warn: () => {}, error: () => {} } }))
mock.module('../src/services/time.service', () => ({ timeService: { initialAnchor: async (input: Row) => { assert.equal(input.templateId, undefined); return { real_time: new Date(), sequence: 0, timeline_id: 'main' } } } }))
mock.module('../src/services/opening-place.service', () => ({ extractOpeningPlace: unavailable }))
mock.module('../src/services/character-codex.service', () => ({ characterCodexService: { seedProtagonist: unavailable }, foldDelta: unavailable, newFoldState: unavailable, isEphemeralPersonDescriptor: unavailable, isNonPersonRole: unavailable, rankCodexForInjection: unavailable, identityKey: unavailable }))
mock.module('../src/services/kinship-graph.service', () => ({ kinshipGraphService: { seedPremiseKinship: unavailable } }))
mock.module('../src/services/template-cast.service', () => ({ materializeTemplateCast: async (input: { instanceId: string; template: WorldTemplateDoc }) => { const cast = input.template.seed_cast!; rows('characters').push(...cast.map((member, index) => ({ _id: new ObjectId((index + 1).toString(16).padStart(24, '0')), instance_id: new ObjectId(input.instanceId), canonical_name: member.name }))); return cast.length } }))
mock.module('../worker/lib/template-cast-extractor', () => ({ extractTemplateCast: unavailable }))
const vectors = new Map<string, Row>()
mock.module('../src/services/vector-store', () => ({ vectorStore: { replaceLore: unavailable, deleteScope: async () => { vectors.clear() }, fetch: async (_scope: Row, ids: string[]) => ({ records: Object.fromEntries(ids.filter(id => vectors.has(id)).map(id => [id, vectors.get(id)])) }), upsert: async (_scope: Row, values: Row[]) => { for (const value of values) vectors.set(String(value.id), value) }, deleteIds: async (_scope: Row, ids: string[]) => { for (const id of ids) vectors.delete(id) } } }))
mock.module('../src/services/entity-graph.service', () => ({ normalizeEntityName: (text: string) => text.toLowerCase(), entityGraphService: { ensurePlayerEntity: async () => ({ _id: new ObjectId() }), resolveOrCreateEntities: async () => new Map(), upsertNarrativeEdge: async () => {} } }))
mock.module('../src/constants/default-cover', () => ({ isDefaultCoverUrl: () => false, resolveTemplateImageUrl: async () => 'https://fixture.invalid/cover.webp' }))
mock.module('../src/services/media/deletion', () => ({ purgeMedia: async () => {}, purgeCardPortraits: async () => {}, purgeTemplatePortraits: async () => {} }))
mock.module('../src/services/telemetry/ingest.service', () => ({ telemetryService: { purgeUser: async () => {} } }))
mock.module('../src/services/account-references', () => ({ purgeAccountReferences: async () => {} }))
mock.module('../src/services/storage.service', () => ({ storageService: {} }))
mock.module('../src/services/billing-config.service', () => ({ resolveProfile: unavailable, effectiveBilling: async () => ({ promo: { unlimited: true, daily_turn_cap: 500 }, costs: { story_turn: 1 } }) }))
mock.module('../src/services/google-play.service', () => ({ googlePlayService: { configured: () => false } }))
mock.module('../src/services/auth.service', () => ({ authService: { getLiveAccess: async () => ({ tier: 'creator', account_status: 'active' }) }, defaultUserPreferences: () => ({}) }))
mock.module('../src/middleware/auth', () => ({ verifyWsToken: unavailable }))
mock.module('../src/middleware/rate-limit', () => ({ rateLimit: async () => ({ allowed: true }) }))
mock.module('../src/services/last-active.service', () => ({ recordLastActive: () => {} }))
mock.module('../src/queues', () => ({ getMemoryCurationQueue: unavailable, removeQueuedJobsForInstance: async () => {}, getGenerationQueue: () => ({ add: async (_name: string, data: Row, options: Row) => { queued.push(data); return { id: options.jobId } } }), getSceneSummaryQueue: () => ({ add: async (_name: string, data: Row) => { queued.push(data) } }), QUEUE_RETENTION: { sceneSummary: {}, generation: { removeOnComplete: 10, removeOnFail: 10 } } }))
let writerHook: ((request: Row) => void) | undefined
let curatorReply: unknown = { memories: [] }, curatorRequests: Row[] = [], summaryRequests: Row[] = []
let summaryHook: (() => Promise<void>) | undefined, embedHook: (() => Promise<void>) | undefined
let summaryReply: string | Error = 'A named summary.'
let curatorFactory: ((request: Row) => unknown) | undefined
let curatorHook: (() => Promise<void>) | undefined
// The stub follows the requested atom schema, so omitted citation fields cannot pass unnoticed.
function curatorResponse(request: Row, result: unknown): unknown {
  if (typeof result === 'string') {
    try { result = JSON.parse(result) } catch { return result }
  }
  if (result && typeof result === 'object' && 'closed_threads' in result) {
    const closures = get(request, 'responseSchema.properties.closed_threads.items.properties.source_messages')
    result = { ...result, closed_threads: closures ? (result as Row).closed_threads : [] }
  }
  if (get(request, 'responseSchema.properties.memories.items.properties.source_messages')) return result
  if (!result || typeof result !== 'object' || !Array.isArray((result as Row).memories)) return result
  return { ...result, memories: ((result as Row).memories as Row[]).map(({ source_messages: _citations, ...atom }) => atom) }
}
let modelReplies: Array<string | Error | { content: string; finishReason: string }> = [], writerCalls: Row[] = [], turnNumber = 0
mock.module('../src/ai', () => ({ AI_MODELS: { memoryCuration: 'fixture-curator', sceneSummary: 'fixture-summary', chapterSummary: 'fixture-chapter', arcSummary: 'fixture-arc', narrationSfw: 'fake-safe', narrationNsfw: 'fake-story-adult', groupNsfw: 'fake-adult', groupNsfwFallbacks: ['fake-adult-fallback', 'fake-adult-last'], narrationSfwFallbacks: ['fake-safe-fallback'], narrationNsfwFallbacks: ['fake-adult-fallback'] }, narrationTemperature: () => 0.62, snapshotLLMUsage: () => [],
  embed: async () => { await embedHook?.(); return [1, 0] },
  callLLM: async (request: Row) => {
    if (request.purpose !== 'memory_curation') {
      summaryRequests.push(request); await summaryHook?.()
      if (summaryReply instanceof Error) throw summaryReply
      return summaryReply
    }
    curatorRequests.push(request); await curatorHook?.()
    const result = curatorFactory ? curatorFactory(request) : curatorReply
    if (result instanceof Error) throw result
    const response = curatorResponse(request, result)
    return typeof response === 'string' ? response : JSON.stringify(response)
  },
  callLLMWithFallback: async (request: Row) => { writerCalls.push(request); writerHook?.(request); const response = modelReplies.shift(); if (response instanceof Error) throw response; if (response && typeof response === 'object') return { ...response, model: request.model }; return { content: response ?? `${names[0]}: Fresh response ${turnNumber++}`, model: request.model } }, embedQuery: unavailable, embedBatch: unavailable, callLLMStream: unavailable, callLLMStreamWithFallback: unavailable, isEmbedTimeout: () => false,
}))
const { memoryProcessor, buildMemoryCurationRequest } = await import('../worker/processors/memory.processor')
const { summaryProcessor } = await import('../worker/processors/summary.processor')
const { loadGroupBatch, groupWriterMemory, GROUP_MEMORY_TEXT_BUDGET } = await import('../src/services/group-chat/memory')
const { groupTurnProcessor } = await import('../worker/processors/group-turn.processor')
const { instanceService } = await import('../src/services/instance.service')
const { generationService } = await import('../src/services/generation.service')
const { deletionService } = await import('../src/services/deletion.service')
const { templateService } = await import('../src/services/template.service')
const { playWsService } = await import('../src/services/play-ws.service')
const { billingService } = await import('../src/services/billing.service')
const { dispatchGroupTurn } = await import('../src/services/group-chat/dispatch')
const { validateEntry } = await import('./seed-catalog')
const originalRandom = Math.random
Math.random = () => 0
const playerId = '300000000000000000000001'
let instanceId = ''
async function start(source = groupTemplate(), player = playerName) {
  tables.clear(); vectors.clear(); curatorRequests = []; summaryRequests = []; summaryReply = 'A named summary.'; curatorHook = undefined; summaryHook = undefined; embedHook = undefined; curatorFactory = undefined; ragMemoryTexts = ['Remembered group fact.']; ragOpenThreads = []; ragCalls = []; memoryLogs.length = 0; backgroundScopes.length = 0; frames.length = 0; locks.clear(); queued.length = 0; outbox.length = 0; writerCalls = []; modelReplies = []; writerHook = undefined; consentReadHook = undefined; checkLogs.length = 0; auditEnv.NSFW_SAME_TURN_ROUTER = 'off'; routerRequests = 0; routerDelay = 0; routerSexual = true; routerError = false
  rows('users').push({ _id: new ObjectId(playerId), preferences: { nsfw_enabled: false, player_name: player } })
  rows('worldTemplates').push(clone(source) as unknown as Row)
  const created = await instanceService.create(playerId, template._id.toHexString(), 'creator')
  instanceId = created.instance._id.toHexString()
  return created
}
async function turn(data: Partial<GroupTurnJob> = {}, rng?: () => number) {
  const id = crypto.randomUUID(); locks.set(`lock:gen:${playerId}:${instanceId}`, JSON.stringify({ owner: id, phase: 'running' }))
  return groupTurnProcessor({ id, data: { instanceId, playerId, userMessage: 'A player message', ...data } } as Job<GroupTurnJob>, { rng })
}
function forbidden(value: unknown) {
  if (!value || typeof value !== 'object') return
  for (const [key, entry] of Object.entries(value)) { assert(!['interested', 'intimacy', 'voice', 'wants', 'talkativeness', 'topics', 'group_state', 'group_state_after', 'group_context', 'cost', 'cost_usd'].includes(key), `leaked ${key}`); forbidden(entry) }
}
await check('group adult model defaults overrides and Euryale temperature are isolated from story narration', async () => {
  const code = `import { mock } from 'bun:test'; mock.module('./src/config/env.ts', () => ({ env: {} })); const { AI_MODELS } = await import('./src/ai/models.ts'); console.log(JSON.stringify({ model: AI_MODELS.groupNsfw, fallbacks: AI_MODELS.groupNsfwFallbacks }));`
  for (const override of [false, true]) {
    const child = Bun.spawn(['bun', '--no-env-file', '-e', code], { cwd: new URL('..', import.meta.url).pathname,
      env: { ...process.env, GROUP_NSFW_MODEL: override ? 'override-adult' : '', GROUP_NSFW_FALLBACK_MODELS: override ? ' first, second , ' : undefined }, stdout: 'pipe', stderr: 'pipe' })
    const [out, errors, result] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    assert.equal(result, 0, errors)
    assert.deepEqual(JSON.parse(out), override ? { model: 'override-adult', fallbacks: ['first', 'second'] } : {
      model: 'sao10k/l3.1-euryale-70b', fallbacks: ['cognitivecomputations/dolphin-mistral-24b-venice-edition', 'thedrummer/skyfall-36b-v2'],
    })
  }
  const { narrationTemperature } = await import('../src/ai/narration-profile')
  assert.equal(narrationTemperature('sao10k/l3.1-euryale-70b'), 0.62)
})
await check('seed adult schema accepts authored traits and rejects malformed or unknown fields', async () => {
  const { CreateTemplateBody } = await import('../src/schemas/template.schema')
  const { Value } = await import('@sinclair/typebox/value')
  const { _id, creator_id, slug, version, created_at, updated_at, is_published, visibility, review_status, ...body } = template
  assert(Value.Check(CreateTemplateBody, body))
  const groupSchema = CreateTemplateBody.properties.seed_cast.items.properties.group
  for (const patch of [{ interested: 'false' }, { interested: null }, { interested: 1 }, { intimacy: 42 }, { voice: 'wrong' }, { voice: [] }, { voice: Array(9).fill('text') }, { voice: [42] }, { extra: 'unknown' }]) {
    assert(!Value.Check(groupSchema, { ...members[0].group, ...patch }))
  }
  for (const patch of [{ intimacy: undefined }, { voice: undefined }, { voice: [' '] }]) assert.throws(() => validateEntry({ ...body, slug, cover: 'fixture.png', seed_cast: body.seed_cast!.map((member, index) => index ? member : { ...member, group: { ...member.group!, ...patch } }) }, 'bad-adult'))
})
await check('seed validation refuses bad group via actual catalog validator', () => {
  const { _id, creator_id, slug, version, created_at, updated_at, is_published, visibility, review_status, ...body } = template
  validateEntry({ ...body, slug, cover: 'fixture.png' }, 'fixture')
  assert.throws(() => validateEntry({ ...body, seed_cast: body.seed_cast!.map(member => ({ ...member, group: { ...member.group!, age: 17 } })), slug, cover: 'fixture.png' }, 'bad-group'))
})
await check('creation seeds cast, state, one opening and no model; guests refused; one existing save reused', async () => {
  const first = await start()
  assert.equal(rows('events').length, 1); assert.equal(writerCalls.length, 0); assert.equal(first.instance.group_state?.topics_used, 0)
  assert.equal((rows('events')[0].data as Row).model_used, 'seed'); assert.equal(((rows('events')[0].data as Row).lines as unknown[]).length, 1)
  assert.equal((await instanceService.create(playerId, template._id.toHexString(), 'creator')).instance._id.toHexString(), instanceId)
  rows('users')[0].guest = true
  await assert.rejects(instanceService.create(playerId, template._id.toHexString(), 'creator'), /sign in/)
})
await check('fake-model player turn writes reply, emits real safe frames and preserves location/travel/presence/choices/stats', async () => {
  await start()
  const save = rows('worldInstances')[0]
  const sentinel = { current_location: { name: 'sentinel place' }, travelling_with: [{ name: 'sentinel companion' }], world_state: { sentinel: 7 }, active_flags: { sentinel: true }, present_characters: ['sentinel presence'], choices: ['sentinel choice'] }
  Object.assign(save, clone(sentinel))
  await turn()
  assert.equal(rows('events').length, 2)
  const event = rows('events')[1]; const data = event.data as Row
  assert.equal(data.player_input, 'A player message'); assert((data.lines as unknown[]).length > 0); assert((data.ai_response as string).includes(':'))
  assert.deepEqual(data.state_mutations, {}); assert.deepEqual(data.flag_mutations, {}); assert.equal(data.choices, undefined)
  for (const [key, value] of Object.entries(sentinel)) assert.deepEqual(save[key], value)
  assert.deepEqual(frames.map(frame => frame.type), ['generation_started', 'group_lines', 'generation_complete'])
  const frame = frames[1]; forbidden(frame)
  assert.deepEqual(Object.keys(frame).sort(), ['eventId', 'instanceId', 'lines', 'type'])
  const line = (frame.lines as Row[])[0]; assert.deepEqual(Object.keys(line).sort(), ['characterId', 'name', 'shownAt', 'text'])
  assert.equal(outbox.length, 0)
})
await check('real processor tagged repair merges and empty output retries before fallback', async () => {
  await start(); modelReplies = [`${names[0]}: first response`, `${names[1]}: tagged response`]
  await turn({ userMessage: `@${names[1]} please answer` })
  assert.equal(((rows('events')[1].data as Row).lines as unknown[]).length, 2)
  assert.equal(writerCalls.length, 2); assert((writerCalls[1].messages as Row[])[1].content!.toString().includes(`Only these people write in this reply: ${names[1]}.`))
  await start(); modelReplies = ['', '', `${names[0]}: fallback response`]
  await turn(); assert.equal(writerCalls.length, 3); assert.equal(writerCalls[2].model, 'fake-safe-fallback')
})
await check('last-five duplicate history extends beyond the recent chat window', async () => {
  await start()
  const seed = rows('events')[0]
  rows('events').push({ ...clone(seed), _id: new ObjectId(), sequence: 2, data: { model_used: 'fake', lines: [{ character_id: ids[0], text: 'Earlier memorable line', shown_at: new Date() }] } })
  for (let sequence = 3; sequence < 38; sequence++) rows('events').push({ ...clone(seed), _id: new ObjectId(), sequence, data: { model_used: 'fake', lines: [{ character_id: ids[1], text: `Other speaker ${sequence}`, shown_at: new Date() }] } })
  modelReplies = [`${names[0]}: Earlier memorable line`, `${names[0]}: A new response instead`]
  await turn()
  assert.equal(writerCalls.length, 2)
  assert((rows('events').at(-1)!.data as Row).ai_response!.toString().includes('A new response instead'))
})
await check('input guard blocks before writer; generated lines screened before persistence', async () => {
  await start()
  await assert.rejects(turn({ userMessage: 'sex with a 12 year old' }), /minors/); assert.equal(writerCalls.length, 0)
  modelReplies = [`${names[0]}: sex with a 12 year old`, `${names[0]}: clean recovered line`]
  await turn(); assert.equal(writerCalls.length, 2)
  assert(!JSON.stringify(frames).includes('12 year old'))
})
await check('unprompted and catchup use group reservation, topics in order, two picks, catchup capped and spread', async () => {
  await start()
  const id = await dispatchGroupTurn({ instanceId, playerId, origin: 'unprompted' })
  assert(id); assert.equal(queued[0].origin, 'unprompted'); assert.equal(rows('inkLedger')[0].delta, 0); assert.equal(rows('inkLedger')[0].reference, 'group_turn')
  modelReplies = members.map(member => `${member.name}: an autonomous line`).join('\n').split('\u0000')
  const random = Math.random; Math.random = never
  try { await turn({ userMessage: '', origin: 'unprompted' }) } finally { Math.random = random }
  assert.equal(((rows('events')[1].data as Row).lines as unknown[]).length, 2)
  assert((writerCalls[0].messages as Row[])[1].content!.toString().includes('First topic'))
  const gapStart = new Date(Date.now() - 9 * 3600_000)
  await dispatchGroupTurn({ instanceId, playerId, origin: 'catchup', gapStart })
  modelReplies = [members.flatMap(member => [0, 1].map(i => `${member.name}: catchup fresh ${i}`)).join('\n')]
  Math.random = () => 0
  try { await turn({ userMessage: '', origin: 'catchup', gapStart: gapStart.toISOString() }) } finally { Math.random = random }
  const lines = (rows('events')[2].data as Row).lines as Array<{ shown_at: Date }>
  assert.equal(lines.length, 4); assert(lines.every(line => +line.shown_at > +gapStart && +line.shown_at < Date.now()))
  assert((writerCalls[1].messages as Row[])[1].content!.toString().includes('Second topic'))
  assert.equal((rows('worldInstances')[0].group_state as Row).topics_used, 2)
  await assert.rejects(dispatchGroupTurn({ instanceId, playerId, origin: 'catchup' }), /start time/)
})
await check('toggle off never picks adult despite recent explicit scene and Ardent mode; autonomy stays normal', async () => {
  for (const enabled of [false, true]) for (const mode of ['free_play', 'ardent']) for (const origin of ['player', 'unprompted'] as const) {
    await start(); put(rows('users')[0], 'preferences.nsfw_enabled', enabled)
    rows('worldInstances')[0].mode = mode
    rows('events').push(...[2, 3].map(sequence => ({ ...clone(rows('events')[0]), _id: new ObjectId(), sequence, type: 'intimate' })))
    await turn({ origin, userMessage: origin === 'player' ? `@${names[0]} morning` : '' }, () => 0)
    assert.equal(writerCalls[0].model, enabled && origin === 'player' ? 'fake-adult' : 'fake-safe')
  }
})
async function adultStart(source = groupTemplate()) {
  await start(source)
  put(rows('users')[0], 'preferences.nsfw_enabled', true)
  auditEnv.NSFW_SAME_TURN_ROUTER = 'on'
}
function content(call: Row, role: number) { return ((call.messages as Row[])[role].content as string) }
function lastData() { return rows('events').at(-1)!.data as Row }
function addEvent(type: string, member: number, sequence = rows('events').length + 1, model = 'fake') {
  rows('events').push({ ...clone(rows('events')[0]), _id: new ObjectId(), sequence, type,
    data: { model_used: model, player_input: '', lines: [{ character_id: ids[member], text: `Prior ${sequence}`, shown_at: new Date() }] } })
}
await check('addressed history keeps exchange and three recent others without seeds in actual writer text', async () => {
  for (const interested of [true, false]) {
    const source = groupTemplate(); source.seed_cast![2].group!.interested = interested
    await start(source); put(rows('users')[0], 'preferences.nsfw_enabled', true); auditEnv.NSFW_SAME_TURN_ROUTER = 'on'
    for (let i = 1; i <= 5; i++) rows('events').push({ ...clone(rows('events')[0]), _id: new ObjectId(), sequence: i + 1,
      data: { model_used: 'fake', player_input: `player-${i}`, lines: [
        { character_id: ids[2], text: `addressed-${i}`, shown_at: new Date() },
        { character_id: ids[0], text: `other-${i}`, shown_at: new Date() },
      ] } })
    addEvent('narration', 0, 7, 'seed')
    put(rows('events').at(-1)!, 'data.player_input', 'Seed player text')
    modelReplies = [`${names[2]}: Addressed fresh`, `${names[0]}: Bystander fresh`]
    let draw = 0
    const message = `@${names[2]} answer this`
    await turn({ userMessage: message }, () => ++draw <= members.length - 1 ? 0 : 0.75)
    const actual = content(writerCalls[0], 1).split('Recent messages:\n')[1].split('\n\nNow:')[0]
    const expected = [`${names[2]}: addressed-1`, ...[2, 3, 4, 5].flatMap(i => [
      `${playerName}: player-${i}`, `${names[2]}: addressed-${i}`, ...(i >= 3 ? [`${names[0]}: other-${i}`] : []),
    ])].join('\n')
    assert.equal(actual, expected)
    assert(content(writerCalls[0], 1).endsWith(`${playerName}: ${message}`))
    assert(content(writerCalls[0], 0).includes(members[2].group.intimacy!))
    assert(content(writerCalls[0], 0).includes(members[2].group.voice![0]))
    assert(!content(writerCalls[1], 1).includes('Prior 7'))
    assert(content(writerCalls[1], 1).includes('Addressed fresh'))
  }
  await start(); addEvent('narration', 0, 2, 'seed'); await turn()
  assert(content(writerCalls[0], 1).includes('Prior 2'), 'normal history retains seeds')
})
await check('leading player tags strip before empty repeat and copy checks while other and later tags stay', async () => {
  await start(groupTemplate(), 'Sam')
  modelReplies = [`${names[0]}: @sAm, hello\n${names[1]}: @Marco hello`]
  await turn()
  assert.deepEqual((lastData().lines as Row[]).map(line => line.text), ['hello', '@Marco hello'])
  assert(content(writerCalls[0], 0).includes('Never write a message from Sam'))
  for (const [raw, expected] of [['@SAM hello', 'hello'], ['@Sam,hello', 'hello'], ['hello @Sam, friend', 'hello @Sam, friend'], ['@Samwise hello', '@Samwise hello']]) {
    assert.equal(filterLines([{ name: names[0], text: raw }], { ...opts, player: 'Sam' }, emptyLineCounts())[0].text, expected)
  }
  const counts = emptyLineCounts()
  const kept = filterLines([
    { name: names[0], text: '@Sam, ' }, { name: names[0], text: '@Sam, Earlier line' },
    { name: names[0], text: `@Sam, ${members[0].group.voice![0]}` },
  ], { ...opts, player: 'Sam', previous: [{ name: names[0], text: 'Earlier line' }] }, counts)
  assert.deepEqual(kept, []); assert.equal(counts.empty, 1); assert.equal(counts.duplicate, 1); assert.equal(counts.copied_example, 1)
})
await check('adult carry-over downgrades uninvolved morning tags no names stale participation and autonomy', async () => {
  for (const answer of ['no', 'late', 'error', 'off']) for (const target of ['uninvolved', 'none', 'stale', 'not-interested', 'boundary', 'unprompted', 'catchup']) {
    const source = groupTemplate(); if (target === 'not-interested') source.seed_cast![0].group!.interested = false
    await start(source); put(rows('users')[0], 'preferences.nsfw_enabled', true)
    addEvent('intimate', 0); addEvent('intimate', 1); addEvent('intimate', 1)
    auditEnv.NSFW_SAME_TURN_ROUTER = answer === 'off' ? 'off' : 'on'; routerSexual = false; routerError = answer === 'error'; routerDelay = answer === 'late' ? 2200 : 0
    const origin = target === 'unprompted' || target === 'catchup' ? target : 'player'
    const member = target === 'not-interested' ? 0 : target === 'stale' ? 0 : 2
    // Put an uninterested participant in the current window as well.
    if (target === 'not-interested') addEvent('intimate', 0)
    const message = target === 'none' ? 'Morning everyone' : target === 'boundary' ? `${names[1]}suffix morning` : `@${names[member]} morning`
    modelReplies = [members.map(member => `${member.name}: Morning reply`).join('\n')]
    await turn({ origin, userMessage: origin === 'player' ? message : '' }, () => 0)
    assert.equal(writerCalls.length, 1); assert.equal(writerCalls[0].model, 'fake-safe'); assert.equal(writerCalls[0].maxTokens, 400)
    assert.equal(content(writerCalls[0], 0), get(rows('worldInstances')[0], 'group_context.static_prompt'))
    assert.equal(rows('events').at(-1)!.type, 'narration')
    assert.equal(checkLogs.at(-1)!.adult_downgrade, origin === 'player' ? 'no_involved_member' : 'autonomous')
    if (answer === 'late' && origin === 'player') await new Promise(resolve => setTimeout(resolve, 250))
  }
})
await check('adult carry-over retains involved tagged or named members and never upgrades or downgrades router yes', async () => {
  for (const answer of ['no', 'late', 'error', 'off', 'yes']) for (const named of [false, true]) {
    await start(); put(rows('users')[0], 'preferences.nsfw_enabled', true)
    addEvent('intimate', 0); addEvent('intimate', 1)
    // Ordinary events after the intimate events must not replace the intimate window.
    addEvent('narration', 2)
    auditEnv.NSFW_SAME_TURN_ROUTER = answer === 'off' ? 'off' : 'on'; routerSexual = answer === 'yes'; routerError = answer === 'error'; routerDelay = answer === 'late' ? 2200 : 0
    const member = answer === 'yes' ? 2 : 0
    modelReplies = [`${names[member]}: Involved response`]
    await turn({ userMessage: `${named ? '' : '@'}${names[member].toLowerCase()}, morning` }, () => 0)
    assert.equal(writerCalls[0].model, 'fake-adult', JSON.stringify({ answer, named, log: checkLogs.at(-1) })); assert.equal(rows('events').at(-1)!.type, 'intimate')
    assert.equal(checkLogs.at(-1)!.adult_downgrade, undefined)
    if (answer === 'late') await new Promise(resolve => setTimeout(resolve, 250))
  }
  await start(); put(rows('users')[0], 'preferences.nsfw_enabled', true)
  addEvent('intimate', 0); auditEnv.NSFW_SAME_TURN_ROUTER = 'on'; routerSexual = false
  modelReplies = [`${names[0]}: Normal response`]
  await turn({ userMessage: `@${names[0]}, morning` }, () => 0)
  assert.equal(writerCalls[0].model, 'fake-safe'); assert.equal(rows('events').at(-1)!.type, 'narration')
})
await check('copied addressed example is omitted on same actual writer retry before advancing and normal rescue', async () => {
  for (const transportFallback of [false, true]) {
    const source = groupTemplate(); source.seed_cast![0].group!.voice!.push('Another authored example')
    await adultStart(source)
    const voice = members[0].group.voice![0]
    modelReplies = [...(transportFallback ? [new Error('provider unavailable')] : []), `${names[0]}: @${playerName}, ${voice}`, `${names[0]}: Fresh retry`]
    await turn({ userMessage: `@${names[0]} answer` }, () => 0)
    const copiedAt = transportFallback ? 1 : 0
    assert.equal(writerCalls[copiedAt + 1].model, writerCalls[copiedAt].model)
    assert(content(writerCalls[copiedAt], 0).includes(voice)); assert(!content(writerCalls[copiedAt + 1], 0).includes(voice))
    assert(content(writerCalls[copiedAt + 1], 0).includes('Another authored example'))
    assert(content(writerCalls[copiedAt + 1], 0).includes(members[0].group.intimacy!))
    assert.equal(checkLogs.at(-1)!.copied_example, 1); assert.equal(lastData().ai_response, `${names[0]}: Fresh retry`)
  }
  await adultStart()
  modelReplies = [`${names[0]}: ${members[0].group.voice![0]}`, '', `${names[0]}: Backup fresh`]
  await turn({}, () => 0)
  assert.deepEqual(writerCalls.map(call => call.model), ['fake-adult', 'fake-adult', 'fake-adult-fallback'])
  assert(!content(writerCalls[2], 0).includes(members[0].group.voice![0]))
})
async function authoredGroups(): Promise<WorldTemplateDoc[]> {
  assert(process.env.GROUP_CHAT_DATA_DIR, 'GROUP_CHAT_DATA_DIR is required for authored reachability')
  const dir = process.env.GROUP_CHAT_DATA_DIR
  const files = (await readdir(dir)).filter(file => file.endsWith('.json')).sort()
  assert.equal(files.length, 3)
  const groups: WorldTemplateDoc[] = []
  for (const file of files) {
    const data = JSON.parse(await readFile(`${dir}/${file}`, 'utf8'))
    validateEntry(data, file)
    groups.push({ ...groupTemplate(), ...data })
  }
  assert.equal(groups.reduce((sum, group) => sum + group.seed_cast!.length, 0), 15)
  return groups
}
await check('authored player placeholders resolve per call for all fifteen addressed prompts', async () => {
  let checked = 0
  for (const group of await authoredGroups()) for (const member of group.seed_cast!) {
    for (const player of [playerName, 'Rae $&']) {
      await start(group, player)
      put(rows('users')[0], 'preferences.nsfw_enabled', true)
      auditEnv.NSFW_SAME_TURN_ROUTER = 'on'
      modelReplies = [`${member.name}: A fresh personal answer.`]
      await turn({ userMessage: `@${member.name} answer me` }, never)
      const system = content(writerCalls[0], 0)
      const intimacy = member.group!.intimacy!
      assert(system.includes(`How ${member.name} is about flirting and sex: ${intimacy.replaceAll('{player}', () => player)}`))
      assert(writerCalls.every(call => (call.messages as Row[]).every(message => !String(message.content).includes('{player}'))))
      if (intimacy.includes('{player}')) assert(!system.includes(intimacy), 'unresolved authored address remained')
    }
    checked++
  }
  assert.equal(checked, 15)
  const member = { ...members[0], group: { ...members[0].group, intimacy: 'Interested in {player}; asks {player} directly.' } }
  assert(buildAddressedStatic({ ...template, members, player: 'Rae $&' }, member).includes('Interested in Rae $&; asks Rae $& directly.'))
})
await check('whole Owen message retains a long complete sentence under the adult 280 limit', async () => {
  const group = (await authoredGroups()).find(group => group.seed_cast!.some(member => member.name === 'Owen'))!
  const member = group.seed_cast!.find(member => member.name === 'Owen')!
  await adultStart(group)
  assert(Array.from(owenReply.sentence).length >= 200 && Array.from(owenReply.sentence).length <= 280)
  const full = `${owenReply.sentence} ${owenReply.overflow}`
  assert(Array.from(full).length > 280)
  modelReplies = [{ content: `${member.name}: ${full}`, finishReason: 'stop' }]
  await turn({ userMessage: `@${member.name} answer me` }, never)
  assert.equal(writerCalls[0].maxTokens, 300)
  assert.equal(writerCalls[0].model, 'fake-safe')
  assert.equal((lastData().lines as Row[])[0].text, owenReply.sentence)
  assert((lastData().lines as Row[]).every(line => Array.from(String(line.text)).length <= 280))
  assert.equal(checkLogs.at(-1)!.trimmed, 1)
})
await check('adult repeated opener drops one line keeps the rest and retries only when empty', async () => {
  for (const scenario of ['remaining', 'retry', 'normal', 'bystander', 'not-interested', 'withdrawn']) {
    const source = groupTemplate()
    if (scenario === 'not-interested') source.seed_cast![0].group!.interested = false
    await adultStart(source)
    addEvent('narration', 0)
    put(rows('events').at(-1)!, 'data.lines', [{ character_id: ids[0], text: 'Familiar start was said before.', shown_at: new Date() }])
    if (scenario === 'normal') auditEnv.NSFW_SAME_TURN_ROUTER = 'off'
    if (scenario === 'withdrawn') consentReadHook = () => { put(rows('users')[0], 'preferences.nsfw_enabled', false) }
    if (scenario === 'bystander') {
      modelReplies = [`${names[1]}: Entirely fresh addressed answer.`, `${names[0]}: Familiar start from the bystander.`]
    } else {
      modelReplies = [`${names[0]}: *waves* FAMILIAR, start with different words.${scenario === 'remaining' ? `\n${names[0]}: A complete new answer survives.\n${names[0]}: Another line survives as well.` : ''}`, `${names[0]}: Completely new answer after retry.`]
    }
    await turn({ userMessage: scenario === 'bystander' ? `@${names[1]} @${names[0]}` : `@${names[0]}` }, never)
    const data = lastData().lines as Row[]
    const gated = scenario === 'remaining' || scenario === 'retry'
    assert.equal(checkLogs.at(-1)!.repeated_opener, gated ? 1 : 0, scenario)
    assert.equal(writerCalls.length, scenario === 'retry' || scenario === 'bystander' ? 2 : 1, scenario)
    if (scenario === 'remaining') assert.deepEqual(data.map(line => line.text), ['A complete new answer survives.', 'Another line survives as well.'])
    if (scenario === 'retry') {
      assert.equal(data[0].text, 'Completely new answer after retry.')
      assert.deepEqual((checkLogs.at(-1)!.writing as Row[]).map(call => call.purpose), ['addressed', 'addressed_retry'])
      assert.equal(writerCalls[1].model, 'fake-adult')
    }
    if (!gated) assert(data.some(line => String(line.text).toLowerCase().includes('familiar')))
  }
})
await check('normal writer seed history expires at two player messages including the current turn across the full chat', async () => {
  for (const origin of ['player', 'unprompted', 'catchup'] as const) for (const priorPlayers of [0, 1, 2]) {
    await start()
    for (let i = 0; i < priorPlayers; i++) {
      addEvent('narration', 1)
      put(rows('events').at(-1)!, 'data.player_input', `Earlier player message ${i}.`)
    }
    await turn({ origin, userMessage: origin === 'player' ? 'Current player message.' : '' }, never)
    const keepsSeed = priorPlayers + (origin === 'player' ? 1 : 0) < 2
    assert.equal(content(writerCalls[0], 1).includes('The authored opening.'), keepsSeed, `${origin}/${priorPlayers}`)
  }
  await start()
  put(rows('events')[0], 'data.player_input', 'Seed player text')
  addEvent('narration', 1)
  addEvent('narration', 1)
  await turn({ userMessage: 'First real player message.' }, never)
  assert(content(writerCalls[0], 1).includes('The authored opening.'), 'seed and nonplayer events do not count as player messages')
  // Player messages may have fallen outside the thirty-event prompt window.
  await start()
  for (let sequence = 2; sequence <= 36; sequence++) {
    addEvent('narration', 1, sequence)
    if (sequence <= 3) put(rows('events').at(-1)!, 'data.player_input', `Old player message ${sequence}.`)
  }
  addEvent('narration', 1, 37, 'seed')
  await turn({ origin: 'unprompted', userMessage: '' }, never)
  assert(!content(writerCalls[0], 1).includes('Prior 37'))
  for (const priorPlayers of [0, 1]) {
    await adultStart()
    if (priorPlayers) { addEvent('narration', 1); put(rows('events').at(-1)!, 'data.player_input', 'Earlier player message.') }
    modelReplies = [`${names[0]}: Fresh addressed answer.`, `${names[1]}: Fresh bystander answer.`]
    await turn({ userMessage: `@${names[0]} @${names[1]}` }, never)
    assert.equal(content(writerCalls[1], 1).includes('The authored opening.'), priorPlayers === 0)
    assert(content(writerCalls[1], 1).includes('Fresh addressed answer.'))
  }
})
await check('authored tagged reachability covers every member and interest routing through retry rescue and copied voice', async () => {
  let cases = 0
  for (const group of await authoredGroups()) for (const member of group.seed_cast!) {
    for (const scenario of ['normal', 'adult', 'empty', 'rescue', 'voice']) {
      await start(group)
      const adult = scenario !== 'normal'
      put(rows('users')[0], 'preferences.nsfw_enabled', adult)
      auditEnv.NSFW_SAME_TURN_ROUTER = adult ? 'on' : 'off'
      const fresh = `${member.name}: Fresh answer for case ${cases}.`
      const chain = member.group!.interested ? ['fake-adult', 'fake-adult-fallback', 'fake-adult-last'] : ['fake-safe', 'fake-safe-fallback']
      modelReplies = scenario === 'empty' ? ['', fresh] : scenario === 'rescue' ? [new Error('writer unavailable'), ...chain.slice(1).map(() => ''), '', '', fresh]
        : scenario === 'voice' ? [`${member.name}: ${member.group!.voice![0]}`, fresh] : [fresh]
      await turn({ userMessage: `@${member.name} answer me` }, () => 0)
      const card = rows('characters').find(card => card.canonical_name === member.name)!
      assert((lastData().lines as Row[]).some(line => line.character_id === String(card._id)), `${group.slug}/${member.name}/${scenario} never spoke`)
      assert.equal(rows('events').at(-1)!.type, adult ? 'intimate' : 'narration')
      const writing = checkLogs.at(-1)!.writing as Row[]
      const expected = adult && member.group!.interested ? 'fake-adult' : 'fake-safe'
      assert.equal(writerCalls[0].model, expected)
      if (!member.group!.interested || !adult) {
        assert(writerCalls.every(call => !String(call.model).startsWith('fake-adult')))
        assert(writing.every(call => call.writer === 'normal'))
        assert(String(lastData().model_used).startsWith('fake-safe'))
      }
      if (adult) {
        assert.equal(writerCalls[0].maxTokens, 300)
        assert(content(writerCalls[0], 0).includes(member.group!.intimacy!.replaceAll('{player}', playerName)))
        assert(content(writerCalls[0], 1).includes('Write one to three messages.'))
      }
      if (scenario === 'rescue') {
        const attempts = member.group!.interested ? [chain[0], chain[1], chain[1], chain[2]] : [chain[0], chain[0], chain[1]]
        assert.deepEqual(writerCalls.slice(0, attempts.length).map(call => call.model), attempts)
        assert(writing.some(call => call.purpose === 'addressed_fallback'))
      }
      if (scenario === 'voice') assert.equal(checkLogs.at(-1)!.copied_example, 1)
      cases++
    }
  }
  assert.equal(cases, 75)
  console.log(`authored tagged reachability: ${cases}/75 cases produced the tagged member's line`)
})
await check('authored untagged reachability picks and speaks every member over 2000 seeded processor rolls per group', async () => {
  let seed = 91
  const rng = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32)
  for (const group of await authoredGroups()) {
    const spoken = new Set<string>()
    for (let roll = 0; roll < 2000; roll++) {
      await start(group)
      modelReplies = [group.seed_cast!.map(member => `${member.name}: A fresh untagged response ${roll}.`).join('\n')]
      await turn({ userMessage: 'Anyone around?' }, rng)
      for (const line of lastData().lines as Row[]) {
        const card = rows('characters').find(card => String(card._id) === line.character_id)!
        spoken.add(String(card.canonical_name))
      }
    }
    assert.deepEqual([...spoken].sort(), group.seed_cast!.map(member => member.name).sort(), group.slug)
    console.log(`authored untagged reachability: ${group.slug}, all ${spoken.size} members spoke over 2000 seeded rolls`)
  }
})
await check('processor sentence trim gates token cutoffs normal turns adult addressed and bystanders with counters', async () => {
  await start()
  modelReplies = [{ content: `${names[0]}: Complete. unfinished`, finishReason: 'length' }]
  await turn({ userMessage: `@${names[0]}` })
  assert.equal((lastData().lines as Row[])[0].text, 'Complete.')
  assert.equal(checkLogs.at(-1)!.trimmed, 1)
  await start()
  modelReplies = [{ content: `${names[0]}: unfinished`, finishReason: 'length' }, `${names[0]}: Fresh repair.`]
  await turn({ userMessage: `@${names[0]}` })
  assert.equal((lastData().lines as Row[])[0].text, 'Fresh repair.')
  assert.equal(checkLogs.at(-1)!.trimmed, 1)
  const long = `Short. ${'long '.repeat(70)}`.trim()
  await start(); modelReplies = [`${names[0]}: ${long}`]
  await turn({ userMessage: `@${names[0]}` })
  assert.equal((lastData().lines as Row[])[0].text, long)
  await adultStart()
  modelReplies = [`${names[0]}: ${long}`, `${names[1]}: ${long}`]
  await turn({ userMessage: `@${names[0]} @${names[1]}` })
  assert.deepEqual((lastData().lines as Row[]).map(line => line.text), ['Short.', 'Short.'])
  assert.equal(checkLogs.at(-1)!.trimmed, 2)
})
await check('adult split order models histories budgets records and whole reply; normal turn stays one call', async () => {
  await adultStart()
  const staticBefore = get(rows('worldInstances')[0], 'group_context.static_prompt')
  const seed = rows('events')[0]
  for (let sequence = 2; sequence <= 16; sequence++) rows('events').push({ ...clone(seed), _id: new ObjectId(), sequence,
    data: { model_used: 'fake', player_input: '', lines: [{ character_id: ids[2], text: `history-${sequence}`, shown_at: new Date() }] } })
  modelReplies = [`${names[2]}: Addressed first\n${names[2]}: Addressed second\n${names[2]}: Addressed third`, `${names[0]}: Bystander reply\n${names[0]}: Extra dropped`]
  let rolls = 0
  await turn({ userMessage: `@${names[2]}, answer this` }, () => { rolls++; return rolls <= members.length - 1 ? 0 : 0.75 })
  assert.equal(rolls > 0, true)
  // The first non-addressed rolled speaker is selected by the injected roll.
  assert.deepEqual(writerCalls.map(call => call.model), ['fake-adult', 'fake-safe'])
  assert.deepEqual(writerCalls.map(call => call.maxTokens), [300, 60])
  assert(content(writerCalls[0], 0).includes(members[2].group.intimacy!))
  assert(!content(writerCalls[0], 0).includes(members[1].group.wants))
  assert(!content(writerCalls[0], 1).includes('history-4\n'))
  assert(content(writerCalls[0], 1).includes('history-5\n'))
  assert(!content(writerCalls[1], 1).includes('history-15\n'))
  assert(content(writerCalls[1], 1).includes('history-16\n'))
  assert(content(writerCalls[1], 1).includes('Addressed third'))
  assert.equal((lastData().lines as Row[]).length, 4)
  assert.equal(lastData().model_used, 'fake-adult')
  assert.equal(get(rows('worldInstances')[0], 'group_state.writing_calls'), 2)
  assert.deepEqual(checkLogs.at(-1)!.writing, [
    { writer: 'adult', model: 'fake-adult', purpose: 'addressed' }, { writer: 'normal', model: 'fake-safe', purpose: 'bystander' },
  ])
  assert.equal(checkLogs.at(-1)!.writing_calls, 2)
  assert.equal(get(rows('worldInstances')[0], 'group_context.static_prompt'), staticBefore)
  assert.equal((frames.find(frame => frame.type === 'group_lines')!.lines as Row[]).length, 4)
  await start(); await turn()
  assert.equal(writerCalls.length, 1); assert.equal(writerCalls[0].model, 'fake-safe'); assert.equal(writerCalls[0].maxTokens, 400)
})
await check('adult retry advances only after same writer retries filtered output; empty adult chain reaches normal writer', async () => {
  await adultStart(); modelReplies = [`${names[0]}: *only action*`, `${names[0]}: Retry fresh`]
  await turn({}, () => 0)
  assert.deepEqual(writerCalls.map(call => call.model), ['fake-adult', 'fake-adult'])
  assert.equal(lastData().model_used, 'fake-adult')
  assert.equal(checkLogs.at(-1)!.stage_directions, 1); assert.equal(checkLogs.at(-1)!.empty, 1)
  assert.equal((checkLogs.at(-1)!.writing as Row[])[1].purpose, 'addressed_retry')
  await adultStart(); modelReplies = ['', '', '', `${names[0]}: Normal rescue`]
  await turn({}, () => 0)
  assert.deepEqual(writerCalls.map(call => call.model), ['fake-adult', 'fake-adult', 'fake-adult-fallback', 'fake-safe'])
  assert(lastData().ai_response!.toString().includes('Normal rescue'))
  assert.equal(get(rows('worldInstances')[0], 'group_state.writing_calls'), 4)
  await adultStart(); put(rows('worldTemplates')[0], 'model_preferences.narration_nsfw', ' fake-adult-fallback ')
  modelReplies = ['', '', `${names[0]}: Deduplicated retry`]
  await turn({}, () => 0)
  assert.deepEqual(writerCalls.map(call => call.model), ['fake-adult-fallback', 'fake-adult-fallback', 'fake-adult-last'])
})
await check('adult template preference wins and transport fallbacks are counted with per-call consent', async () => {
  await adultStart(); put(rows('worldTemplates')[0], 'model_preferences.narration_nsfw', 'template-adult')
  modelReplies = [new Error('provider unavailable'), new Error('second unavailable'), `${names[0]}: Last writer fresh`]
  await turn({}, () => 0)
  assert.deepEqual(writerCalls.map(call => call.model), ['template-adult', 'fake-adult-fallback', 'fake-adult-last'])
  assert.equal(lastData().model_used, 'fake-adult-last')
  assert.equal(get(rows('worldInstances')[0], 'group_state.writing_calls'), 3)
  assert.equal((checkLogs.at(-1)!.writing as Row[]).length, 3)
})
await check('adult consent withdrawn before first call, retry or transport fallback never reaches adult again; noncapable stays normal', async () => {
  for (const at of ['first', 'retry', 'transport'] as const) {
    await adultStart()
    if (at === 'first') { let reads = 0; consentReadHook = () => { if (++reads === 2) put(rows('users')[0], 'preferences.nsfw_enabled', false) } }
    else writerHook = () => { put(rows('users')[0], 'preferences.nsfw_enabled', false) }
    modelReplies = at === 'first' ? [`${names[0]}: Normal from start`] : [at === 'transport' ? new Error('unavailable') : '', `${names[0]}: Normal after withdrawal`]
    await turn({}, () => 0)
    assert.deepEqual(writerCalls.map(call => call.model), at === 'first' ? ['fake-safe'] : ['fake-adult', 'fake-safe'])
    assert((checkLogs.at(-1)!.writing as Row[]).slice(at === 'first' ? 0 : 1).every(call => call.writer === 'normal'))
  }
  for (const enabled of [false, true]) {
    await adultStart(); put(rows('users')[0], 'preferences.nsfw_enabled', enabled)
    rows('worldTemplates')[0].is_nsfw_capable = false
    addEvent('intimate', 0); addEvent('intimate', 0)
    await turn({ userMessage: `@${names[0]} morning` }, () => 0); assert(writerCalls.every(call => call.model === 'fake-safe'))
  }
})
for (const interested of [true, false]) await check(`${interested ? 'interested' : 'not-interested'} addressed prompt follows fresh consent before every call`, async () => {
  for (const withdrawn of [false, true]) for (const at of ['first', 'retry', 'transport'] as const) {
    const source = clone(groupTemplate())
    source.seed_cast![0].group!.interested = interested
    await start(source)
    put(rows('users')[0], 'preferences.nsfw_enabled', true)
    auditEnv.NSFW_SAME_TURN_ROUTER = 'on'
    let reads = 0
    const readsAtCall: number[] = []
    consentReadHook = () => {
      reads++
      if (withdrawn && at === 'first' && reads === 2) put(rows('users')[0], 'preferences.nsfw_enabled', false)
    }
    writerHook = () => {
      readsAtCall.push(reads)
      if (withdrawn && at !== 'first') put(rows('users')[0], 'preferences.nsfw_enabled', false)
    }
    const answer = `${names[0]}: Fresh consent reply.`
    modelReplies = at === 'first' ? [answer] : [at === 'transport' ? new Error('429 unavailable') : '', answer]
    await turn({}, () => 0)
    assert.deepEqual(readsAtCall, at === 'first' ? [2] : [2, 3], 'each call needs a fresh read after the route read')
    assert.deepEqual(writerCalls.map(call => call.model), at === 'first'
      ? [interested && !withdrawn ? 'fake-adult' : 'fake-safe']
      : [interested ? 'fake-adult' : 'fake-safe', interested ? withdrawn ? 'fake-safe' : at === 'transport' ? 'fake-adult-fallback' : 'fake-adult' : at === 'transport' ? 'fake-safe-fallback' : 'fake-safe'])
    for (const [index, call] of writerCalls.entries()) {
      const allowed = !withdrawn || (at !== 'first' && index === 0)
      const system = content(call, 0)
      assert.equal(system.includes(`You are writing only ${names[0]}'s messages`), allowed)
      assert.equal(system.includes(`How ${names[0]} is about flirting and sex: ${members[0].group.intimacy}`), allowed)
      assert.equal(system.includes('as explicitly and crudely as'), allowed)
      if (!allowed) {
        assert.equal(system, get(rows('worldInstances')[0], 'group_context.static_prompt'))
        assert(members.every(member => !system.includes(member.group.intimacy!)))
      }
      assert.equal(call.maxTokens, allowed ? 300 : 60)
      assert(content(call, 1).includes(allowed ? 'Write one to three messages.' : 'Each writes one short message.'))
      assert.equal(content(call, 1).includes('Write one to three messages.'), allowed)
      assert(content(call, 1).includes(`${playerName}: A player message`))
    }
    assert.equal(lastData().ai_response, answer)
    assert.equal((frames.find(frame => frame.type === 'group_lines')!.lines as Row[]).length, 1)
  }
})
await check('adult optional failure preserves fresh reply and other tags get repair plus last backup attempt', async () => {
  await adultStart(); modelReplies = [`${names[0]}: Addressed survives`, new Error('429 failed bystander'), new Error('429 failed backup')]
  let draw = 0
  await turn({}, () => ++draw <= members.length ? 0 : 0.9)
  assert(lastData().ai_response!.toString().includes('Addressed survives'))
  assert.equal(writerCalls.length, 3)
  await adultStart(); modelReplies = [`${names[0]}: Another addressed reply`, new Error('optional failure')]
  draw = 0; await turn({}, () => ++draw <= members.length ? 0 : 0.9)
  assert(lastData().ai_response!.toString().includes('Another addressed reply')); assert.equal(writerCalls.length, 2)
  await adultStart(); modelReplies = [`${names[3]}: Addressed tag`, '', '', `${names[1]}: Backup tag`]
  await turn({ userMessage: `@${names[3]} then @${names[1]}` }, () => 0)
  assert.deepEqual(writerCalls.map(call => call.model), ['fake-adult', 'fake-safe', 'fake-safe', 'fake-safe-fallback'])
  assert(content(writerCalls[0], 0).includes(members[3].group.intimacy!))
  assert(content(writerCalls[1], 1).includes(`Only these people write in this reply: ${names[1]}.`))
  assert.equal((lastData().lines as Row[]).length, 2)
  assert.equal((checkLogs.at(-1)!.writing as Row[]).at(-1)!.purpose, 'tag_backup')
  await adultStart(); modelReplies = [`${names[3]}: First of three tags`, `${names[0]}: First other tag\n${names[1]}: Second other tag`]
  await turn({ userMessage: `@${names[3]} @${names[0]} @${names[1]}` }, () => 0)
  assert.equal(writerCalls.length, 2); assert.equal(writerCalls[1].maxTokens, 120); assert.equal((lastData().lines as Row[]).length, 3)
  await start(); modelReplies = [`${names[0]}: Normal reply`, '', `${names[1]}: Last chance normal tag`]
  await turn({ userMessage: `@${names[1]}` })
  assert.deepEqual(writerCalls.map(call => call.model), ['fake-safe', 'fake-safe', 'fake-safe-fallback'])
  await start(); modelReplies = [`${names[0]}: Fresh but missing tag`, '', '']
  await assert.rejects(turn({ userMessage: `@${names[1]}` }), /could not finish/)
})
await check('group router waits for player intent and late answers fall through after two seconds; autonomy never asks', async () => {
  await start(); put(rows('users')[0], 'preferences.nsfw_enabled', true)
  auditEnv.NSFW_SAME_TURN_ROUTER = 'on'; routerDelay = 20
  await turn({}, () => 0)
  assert.equal(routerRequests, 1); assert.equal(writerCalls[0].model, 'fake-adult')
  assert.equal((checkLogs.at(-1)!.routing as Row).settled, true)
  await start(); put(rows('users')[0], 'preferences.nsfw_enabled', true)
  auditEnv.NSFW_SAME_TURN_ROUTER = 'on'; routerDelay = 2200
  const began = Date.now()
  await turn({}, () => 0)
  assert(Date.now() - began >= 1950 && Date.now() - began < 2150)
  assert.equal(writerCalls[0].model, 'fake-safe')
  assert.equal((checkLogs.at(-1)!.routing as Row).fallback, 'late')
  await new Promise(resolve => setTimeout(resolve, 250))
  assert.equal((checkLogs.at(-1)!.routing as Row).fallback, 'late')
  for (const [capable, enabled] of [[true, false], [false, true]]) {
    await start(); rows('worldTemplates')[0].is_nsfw_capable = capable; put(rows('users')[0], 'preferences.nsfw_enabled', enabled)
    auditEnv.NSFW_SAME_TURN_ROUTER = 'on'; await turn(); assert.equal(routerRequests, 0); assert.equal(writerCalls[0].model, 'fake-safe')
  }
  for (const origin of ['unprompted', 'catchup'] as const) {
    await start(); put(rows('users')[0], 'preferences.nsfw_enabled', true); auditEnv.NSFW_SAME_TURN_ROUTER = 'on'
    await turn({ origin, userMessage: '' }); assert.equal(routerRequests, 0)
  }
})
await check('private adult traits absent recursively wherever player cast is returned', async () => {
  await start(); await turn()
  const payload = publicGroupData({ seed_cast: template.seed_cast, nested: { cast: members, list: [{ group: members[0].group }] } })
  forbidden(payload)
  const loaded = await generationService.loadInstance(instanceId, playerId); forbidden(loaded)
  forbidden(await instanceService.getById(instanceId, playerId))
  forbidden(await instanceService.listRealms(playerId))
  forbidden(await instanceService.list(playerId))
  for (const frame of frames) forbidden(frame)
})

await check('event cadence stages memory every five and summaries every twelve; history/load leak no internals', async () => {
  await start(); put(rows('worldInstances')[0], 'group_state.writing_calls', 199)
  for (let i = 0; i < 12; i++) await turn()
  assert.deepEqual(outbox.map(row => row.kind), ['memory_curation', 'memory_curation', 'scene_summary'])
  assert.deepEqual(outbox.map(row => get(row, 'payload.eventId')), [rows('events')[5]._id, rows('events')[10]._id, rows('events')[12]._id].map(String))
  assert.equal(get(outbox[0], 'payload.playerInput'), undefined)
  const loaded = await generationService.loadInstance(instanceId, playerId)
  forbidden(loaded); assert(loaded.recentEvents.some(event => event.data.lines?.length))
  assert((await instanceService.getById(instanceId, playerId))?.group_state === undefined)
  forbidden(await instanceService.listRealms(playerId))
  const socketFrames: Row[] = []
  await playWsService.handleMessage({ send: text => { socketFrames.push(JSON.parse(text)) }, close: unavailable,
    data: { _user: { id: playerId, tier: 'creator' }, jwt: { verify: async () => false } } }, { action: 'load_instance', instance_id: instanceId })
  assert.equal(socketFrames[0].type, 'instance_loaded'); forbidden(socketFrames[0])
})
await check('group replay is refused before dispatch; zero-charge reservation is idempotent', async () => {
  await start(); await turn()
  await assert.rejects(generationService.dispatchReplay({ instanceId, playerId, eventId: (rows('events')[1]._id as ObjectId).toHexString() }), /not available/)
  await billingService.reserveGroupTurn(playerId, 'same-request'); await billingService.reserveGroupTurn(playerId, 'same-request')
  assert.equal(rows('inkLedger').length, 1); assert.equal(rows('inkLedger')[0].delta, 0)
})
await check('existing socket chat reserves a story turn and dispatches the group job', async () => {
  await start()
  const reserve = billingService.reserve
  let reservations = 0
  billingService.reserve = async (_player, action) => { assert.equal(action, 'story_turn'); reservations++; return { reservation_id: 'fixture-reservation', cost: 0, balance: null } }
  try {
    const socketFrames: Row[] = []
    await playWsService.handleMessage({ send: text => { socketFrames.push(JSON.parse(text)) }, close: unavailable,
      data: { _user: { id: playerId, tier: 'creator' }, jwt: { verify: async () => false } } }, { action: 'chat', instance_id: instanceId, payload: { message: 'Socket chat message' } })
    assert.equal(reservations, 1); assert.equal(queued.length, 1)
    assert.equal(queued[0].userMessage, 'Socket chat message'); assert.equal((queued[0].session as Row).kind, 'group')
    assert.equal(queued[0].billingReservationId, 'fixture-reservation')
    assert(!socketFrames.some(frame => frame.type === 'error'))
  } finally { billingService.reserve = reserve }
})
await check('save and account deletion clear group events and all private state', async () => {
  await start(); await turn()
  await deletionService.deleteInstance(instanceId, playerId)
  assert.equal(rows('worldInstances').length, 0); assert.equal(rows('events').length, 0)
  await start(); await turn()
  await deletionService.deleteAccount(playerId)
  assert.equal(rows('users').length, 0); assert.equal(rows('worldInstances').length, 0); assert.equal(rows('events').length, 0)
})
await check('real rewind restores group snapshot and preserves historical character ids', async () => {
  const child = Bun.spawn(['bun', '--no-env-file', 'run', 'scripts/codex-media-carryover-audit.ts'], { stdout: 'pipe', stderr: 'pipe', cwd: new URL('..', import.meta.url).pathname })
  const output = await new Response(child.stdout).text(), errors = await new Response(child.stderr).text()
  assert.equal(await child.exited, 0, output + errors)
  assert(output.includes('PASS group rewind restores silence/topic/writing snapshot'))
})
await check('existing discovery, recommendations, genre shelves and starters exclude groups; explicit kind returns them', async () => {
  await start()
  const world = { ...groupTemplate(), _id: new ObjectId(), kind: 'world', starter: true }; rows('worldTemplates').push(world as unknown as Row)
  rows('worldTemplates')[0].starter = true
  assert.equal((await templateService.listPublished(1, 20, undefined, undefined, { sort: 'new' })).templates.length, 1)
  const groups = await templateService.listPublished(1, 20, undefined, undefined, { kind: 'group', sort: 'new' })
  assert.equal(groups.templates.length, 1); assert.equal(groups.templates[0].kind, 'group')
  assert.equal((await templateService.starter(playerId))?.kind, 'world')
  assert.equal((await templateService.listByCreator(template.creator_id.toHexString())).templates.length, 1)
  const genres = await templateService.listGenres(undefined, Date.now() + 120000)
  assert.equal(genres.genres.reduce((sum, genre) => sum + genre.worlds + genre.characters, 0), 1)
})
await check('story prompt fixed fixture hashes unchanged; only group kind hands off; no authored group identities in product code', async () => {
  const story = await readFile(new URL('../worker/processors/generation.processor.ts', import.meta.url), 'utf8')
  assert(story.includes("if (dispatchedSession.kind === 'group')")); assert.equal((story.match(/return groupTurnProcessor\(job\)/g) || []).length, 1)
  const probe = Bun.spawn(['bun', '--no-env-file', 'run', 'scripts/prompt-part-hash-audit.ts'], { stdout: 'pipe', stderr: 'pipe', cwd: new URL('..', import.meta.url).pathname })
  const output = await new Response(probe.stdout).text(), errors = await new Response(probe.stderr).text()
  assert.equal(await probe.exited, 0, output + errors); assert(output.includes('pre-change messages byte for byte'))
  const originalStory = story.replace("import { groupTurnProcessor } from './group-turn.processor'\n", '').replace("  if (dispatchedSession.kind === 'group') {\n    if (!(await liveInstanceExists(parseObjectId(instanceId)))) return\n    return groupTurnProcessor(job)\n  }\n\n", '')
  assert.equal(createHash('sha256').update(originalStory).digest('hex'), '6b9d06b57d646a5e8f8770e4e3ddafe86b270868bca1e830947133a7241bd69e')
  const before = await readFile(new URL('../src/utils/prompt-builder.ts', import.meta.url), 'utf8')
  assert.equal(createHash('sha256').update(before.replace('export const NARRATIVE_BOUNDARIES', 'const NARRATIVE_BOUNDARIES')).digest('hex'), 'b680d417ece807f9a37431ffe195ae3b8f13d93a2567592f157772ec1ede8043')
  console.log(`story builder source sha256 ${createHash('sha256').update(before.replace('export const NARRATIVE_BOUNDARIES', 'const NARRATIVE_BOUNDARIES')).digest('hex')}`)
  // Data is external to this isolated checkout; the caller can supply its path.
  const dataDir = process.env.GROUP_CHAT_DATA_DIR
  if (dataDir) {
    const authored = (await readdir(dataDir)).filter(file => file.endsWith('.json'))
    const labels: string[] = []
    for (const file of authored) { const group = JSON.parse(await readFile(`${dataDir}/${file}`, 'utf8')); labels.push(group.title, group.slug, ...group.seed_cast.map((member: { name: string }) => member.name)); validateEntry(group, file) }
    async function visit(path: string) { for (const entry of await readdir(path, { withFileTypes: true })) { const next = `${path}/${entry.name}`; if (entry.isDirectory()) await visit(next); else if (entry.name.endsWith('.ts')) { const source = await readFile(next, 'utf8'); for (const label of labels) assert(!new RegExp(`(?<![A-Za-z])${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z])`).test(source), `${next} names ${label}`) } } }
    await visit(new URL('../src', import.meta.url).pathname); await visit(new URL('../worker', import.meta.url).pathname)
    console.log(`validated ${authored.length} authored groups; identity scan passed`)
  }
})

// Memory checks inspect the real queued processors, persisted atoms/vectors and writer requests.
function storedEvents() { return rows('events') as unknown as import('../src/models/world-event.model').WorldEventDoc[] }
function numbered(request = curatorRequests.at(-1)!) {
  const body = (request.messages as Array<{ content: string }>)[1].content
  return body.split('\n').flatMap(line => {
    const match = /^(\d+)\. (\{.*\})$/.exec(line)
    return match ? [{ number: Number(match[1]), ...JSON.parse(match[2]) as { speaker: string; text: string } }] : []
  })
}
function atom(text: string, subject: string, citation: number, patch: Row = {}) {
  return { text, type: 'observation', importance: 4, is_nsfw: false, subjects: [subject], objects: [],
    unresolved_thread: false, retrieval_terms: [], source_messages: [citation], ...patch }
}
function memoryJob(event = storedEvents().at(-1)!) {
  return { data: { instanceId, playerId, eventId: String(event._id), groupMemory: true, sceneTag: 'dialogue' } } as Job
}
function addEvents(count: number, speaker = members[0]) {
  const last = storedEvents().at(-1)!
  for (let i = 1; i <= count; i++) rows('events').push({ ...clone(last) as unknown as Row, _id: new ObjectId(), sequence: last.sequence + i,
    data: { player_input: `Filler ${last.sequence + i}`, ai_response: `${speaker.name}: filler ${i}`, model_used: 'fake-safe', origin: 'player',
      lines: [{ character_id: speaker.id, text: `filler ${last.sequence + i}`, shown_at: new Date() }],
      state_mutations: {}, flag_mutations: {}, group_state_after: clone(get(rows('worldInstances')[0], 'group_state')) } })
}
async function identityBatch() {
  await start(); addEvents(5)
  const events = storedEvents()
  events[2].data.lines![0].text = 'My sister is a pilot.'
  events[3].data.lines = [{ character_id: ids[1], text: 'My sister is a painter.', shown_at: new Date() }]
  events[4].data.player_input = 'My sister is getting married in June.'
  curatorFactory = request => ({ memories: numbered(request).filter(message => message.text.startsWith('My sister')).map(message =>
    atom(`${message.speaker}'s sister: ${message.text}`, message.speaker, message.number, { objects: [`${message.speaker}'s sister`] })), entities: [] })
  await memoryProcessor(memoryJob())
  return events
}
await check('memory numbered speakers preserve three sister owners and exact per-atom provenance without ids or player payloads', async () => {
  const events = await identityBatch()
  const body = (curatorRequests[0].messages as Array<{ content: string }>)[1].content
  assert(body.includes(`The human player is "${playerName}"`)); assert(body.includes('"my" belong to the speaker'))
  assert(!body.includes('GM world') && !body.includes('Player (raw input):') && !body.includes('World:'))
  for (const event of events) assert(!JSON.stringify(curatorRequests[0]).includes(String(event._id)))
  assert.deepEqual(rows('memories').map(memory => memory.subjects), [[names[0]], [names[1]], ['player']])
  assert.deepEqual(rows('memories').map(memory => memory.objects), [names[0], names[1], playerName].map(name => [`${name}'s sister`]))
  assert.deepEqual(rows('memories').map(memory => (memory.source_event_ids as ObjectId[]).map(String)), [events[2], events[3], events[4]].map(event => [String(event._id)]))
  assert.equal(vectors.size, 3); assert(!frames.some(frame => frame.type === 'memories_curated'))
  assert.equal(get(rows('worldInstances')[0], 'group_state.curated_through_sequence'), 6)
  assert(backgroundScopes.some(scope => scope.instance_id === instanceId && scope.event_id === String(events[5]._id)))
  assert.equal(curatorRequests[0].purpose, 'memory_curation')
})
await check('memory group prompt and required schema request preserve small personal facts and citations', async () => {
  await identityBatch()
  const request = curatorRequests[0]
  const system = (request.messages as Array<{ content: string }>)[0].content
  assert(system.includes('numbered conversation among several people'))
  assert(system.includes('family, work, health, plans and promises'))
  assert(system.includes('even when it looks small'))
  assert(system.includes('one fact per atom'))
  assert(!system.includes('0-3') && !system.includes('10+ turns') && !system.includes('one exchange'))
  assert(system.includes('"source_messages"'))
  const item = get(request, 'responseSchema.properties.memories.items') as Row
  assert((item.required as string[]).includes('source_messages'))
  assert.equal(get(item, 'properties.source_messages.type'), 'array')
  assert.equal(get(item, 'properties.source_messages.minItems'), 1)
  assert.equal(get(item, 'properties.source_messages.items.type'), 'integer')
  assert.equal(get(item, 'properties.source_messages.items.minimum'), 1)
  const { buildChatRequest } = await import('../src/ai/client')
  const transport = buildChatRequest(request as unknown as Parameters<typeof buildChatRequest>[0]).params
  assert.equal(transport.response_format.type, 'json_schema')
  assert.equal(transport.response_format.json_schema.strict, true)
  assert.deepEqual(transport.response_format.json_schema.schema, request.responseSchema)
  assert.equal(transport.provider.require_parameters, true)
  assert.equal(transport.model, request.model)
  const fixture = { memories: [atom('A cited fact.', playerName, 1)] }
  assert.equal((curatorResponse({ ...request, responseSchema: undefined }, fixture) as { memories: Row[] }).memories[0].source_messages, undefined)
  assert.deepEqual((curatorResponse(request, fixture) as { memories: Row[] }).memories[0].source_messages, [1])
  assert.equal((curatorResponse({ ...request, responseSchema: undefined }, JSON.stringify(fixture)) as { memories: Row[] }).memories[0].source_messages, undefined)
  // Both arrays canonicalize exact names ignoring case; relatives and other people stay distinct.
  await start(); addEvents(5)
  curatorFactory = () => ({ memories: [atom('A personal fact.', playerName.toUpperCase(), 1,
    { objects: [playerName.toLowerCase(), `${playerName}'s sister`, names[0]] })] })
  await memoryProcessor(memoryJob())
  assert.deepEqual(rows('memories')[0].subjects, ['player'])
  assert.deepEqual(rows('memories')[0].objects, ['player', `${playerName}'s sister`, names[0]])
})
await check('memory invalid citations and malformed atoms are dropped and counted; empty invalid results fail', async () => {
  await start(); addEvents(5)
  curatorFactory = request => ({ memories: [atom('A valid fact.', 'player', numbered(request)[0].number),
    ...[0, -1, 999, 1.5, '1', null].map(citation => atom('Invalid citation.', 'player', citation as number)),
    atom('Malformed atom.', 'player', 1, { importance: '5' })] })
  await memoryProcessor(memoryJob())
  assert.equal(rows('memories').length, 1)
  assert(memoryLogs.some(row => row.name === 'group.memory_batch' && row.invalidCitations === 6 && row.invalidAtoms === 1 && row.success === true))
  for (const bad of ['broken json', { memories: [] }, { memories: [atom('Bad.', 'player', 1000)] }, null, { memories: [null] }]) {
    await start(); addEvents(5); curatorReply = bad
    await assert.rejects(memoryProcessor(memoryJob()), /Group curator/)
    assert.equal(get(rows('worldInstances')[0], 'group_state.curated_through_sequence'), 1)
  }
})
await check('memory failed batches catch up from watermark with two event overlap and no duplicate atoms or vectors', async () => {
  await start(); addEvents(5); curatorReply = new Error('Stub curator failed')
  await assert.rejects(memoryProcessor(memoryJob()), /Stub curator failed/)
  assert.equal(get(rows('worldInstances')[0], 'group_state.curated_through_sequence'), 1)
  addEvents(5)
  curatorFactory = request => ({ memories: [atom('Fact at the old failed batch edge.', 'player', numbered(request).find(message => message.text === 'Filler 5')!.number),
    atom('Fact at the next overlap.', names[0], numbered(request).find(message => message.text === 'Filler 10')!.number)] })
  await memoryProcessor(memoryJob())
  assert(numbered().some(message => message.text === 'Filler 2')); assert(numbered().some(message => message.text === 'Filler 11'))
  assert.equal(get(rows('worldInstances')[0], 'group_state.curated_through_sequence'), 11)
  addEvents(5)
  curatorFactory = request => ({ memories: [atom('Fact at the next overlap.', names[0], numbered(request).find(message => message.text === 'Filler 10')!.number), atom('An alternate phrasing of the overlap fact.', names[0], numbered(request).find(message => message.text === 'Filler 10')!.number), atom('New fact.', 'player', numbered(request).at(-1)!.number)] })
  await memoryProcessor(memoryJob())
  assert.equal(numbered()[0].text, 'Filler 10'); assert(numbered().some(message => message.text === 'Filler 11'))
  assert.equal(rows('memories').length, 3); assert.equal(vectors.size, 3)
  assert(memoryLogs.some(row => row.name === 'group.memory_batch' && row.duplicates === 2 && row.success === true))
  assert.equal(get(storedEvents().at(-1)! as unknown as Row, 'data.group_state_after.curated_through_sequence'), 16)
})
async function closureBatch() {
  await start(); addEvents(5)
  curatorFactory = request => ({ memories: [atom('A lasting plain fact about the player.', 'player', 1),
    atom('The player promised to return a borrowed item.', 'player', 1, { type: 'promise', unresolved_thread: true,
      source_messages: numbered(request).filter(message => ['Filler 4', 'Filler 6'].includes(message.text)).map(message => message.number) })] })
  await memoryProcessor(memoryJob())
  const thread = clone(rows('memories')[1])
  addEvents(5)
  return thread
}
await check('memory group closure request lists only open threads and forbids copying with cited closure schema', async () => {
  const thread = await closureBatch()
  curatorFactory = request => {
    const messages = request.messages as Row[]
    const list = String(messages[1].content).split('OPEN THREADS:\n')[1].split('\n\nNumbered messages')[0]
    assert.equal(list, `T1: ${thread.text}`)
    assert(!String(messages[1].content).includes('LIVE RELATED FACTS'))
    assert(String(messages[0].content).includes('Atoms come only from the numbered messages, never from that list'))
    assert(!String(messages[0].content).includes('closed_thread_ids') && !String(messages[0].content).includes('resolved_threads'))
    assert.deepEqual(get(request, 'responseSchema.required'), ['memories', 'entities', 'closed_threads'])
    const schema = get(request, 'responseSchema.properties.closed_threads.items') as Row
    assert.equal(schema.additionalProperties, false)
    assert.deepEqual(schema.required, ['thread_id', 'source_messages'])
    assert.deepEqual(get(schema, 'properties.source_messages'), { type: 'array', minItems: 1, items: { type: 'integer', minimum: 1 } })
    const fixture = { memories: [], closed_threads: [{ thread_id: 'T1', source_messages: [1] }] }
    assert.deepEqual((curatorResponse(request, fixture) as Row).closed_threads, fixture.closed_threads)
    assert.deepEqual((curatorResponse({ ...request, responseSchema: undefined }, fixture) as Row).closed_threads, [])
    return { memories: [atom('A new independent fact.', names[1], 1)] }
  }
  await memoryProcessor(memoryJob())
  assert.equal(curatorRequests.length, 2)
})
await check('memory group closure rejects missing earlier same overlap invalid and legacy citations and counts drops', async () => {
  for (const kind of ['missing', 'empty', 'earlier', 'same', 'range', 'fraction', 'string', 'unknown', 'legacy', 'prose', 'missing-source']) {
    const thread = await closureBatch()
    if (kind === 'missing-source') (rows('memories')[1].source_event_ids as ObjectId[]).push(new ObjectId())
    curatorFactory = request => {
      const citation = (text: string) => numbered(request).find(message => message.text === text)!.number
      const closures: Row[] = [{ thread_id: kind === 'unknown' ? 'T9' : 'T1', source_messages:
        kind === 'empty' ? [] : [kind === 'earlier' ? citation('Filler 5') : kind === 'same' ? citation('Filler 6') :
          kind === 'range' ? 999 : kind === 'fraction' ? 1.5 : kind === 'string' ? '1' : citation('Filler 7')] }]
      if (kind === 'missing') delete closures[0].source_messages
      return { memories: [atom('An unrelated new fact.', names[1], 1)],
        closed_threads: ['legacy', 'prose'].includes(kind) ? [] : closures,
        closed_thread_ids: kind === 'legacy' ? ['T1'] : [], resolved_threads: kind === 'prose' ? [String(thread.text)] : [] }
    }
    await memoryProcessor(memoryJob())
    const stored = rows('memories').find(row => eq(row._id, thread._id))!
    assert.equal(stored.unresolved_thread, true, kind); assert.equal(stored.is_archived, false, kind)
    assert(vectors.has(String(thread.pinecone_id)), kind)
    const log = memoryLogs.filter(row => row.name === 'group.memory_batch').at(-1)!
    assert.equal(log.closuresAccepted, 0, kind)
    assert.equal(log.closuresRejected, ['legacy', 'prose'].includes(kind) ? 0 : 1, kind)
  }
})
await check('memory group valid closure keeps atom vector provenance and Memories but leaves Open threads', async () => {
  const thread = await closureBatch(), before = clone(vectors.get(String(thread.pinecone_id)))
  curatorFactory = request => ({ memories: [], closed_threads: [{ thread_id: 'T1',
    source_messages: [numbered(request).find(message => message.text === 'Filler 7')!.number] }] })
  await memoryProcessor(memoryJob())
  const stored = rows('memories').find(row => eq(row._id, thread._id))!
  assert.equal(rows('memories').length, 2); assert.equal(stored.unresolved_thread, false)
  assert.equal(stored.is_archived, false); assert.equal(stored.status, thread.status)
  assert(stored.resolved_at instanceof Date); assert.deepEqual(stored.source_event_ids, thread.source_event_ids)
  assert.equal(stored.pinecone_id, thread.pinecone_id); assert.deepEqual(vectors.get(String(thread.pinecone_id)), before)
  const log = memoryLogs.filter(row => row.name === 'group.memory_batch').at(-1)!
  assert.equal(log.closuresAccepted, 1); assert.equal(log.closuresRejected, 0); assert.equal(log.threadsResolved, 1)
  addEvents(30); ragMemoryTexts = [String(thread.text)]; ragOpenThreads = []
  modelReplies = [`${names[0]}: A fresh response after completion.`]
  await turn({ userMessage: `@${names[0]} remember that?` }, never)
  const body = String((writerCalls.at(-1)!.messages as Row[])[1].content)
  assert(body.split('Memories:\n')[1].split('\n\n')[0].includes(String(thread.text)))
  assert(!body.split('Open threads:\n')[1]?.split('\n\n')[0].includes(String(thread.text)))
})
await check('memory group closed rewind deletes sourced atom and vector while older fact survives', async () => {
  const thread = await closureBatch()
  curatorFactory = request => ({ memories: [], closed_threads: [{ thread_id: 'T1',
    source_messages: [numbered(request).find(message => message.text === 'Filler 7')!.number] }] })
  await memoryProcessor(memoryJob())
  assert.equal(rows('memories')[1].unresolved_thread, false)
  // Rewind itself is real; unrelated card-media and graph work has no bearing on atom provenance.
  mock.module('../src/services/codex-media-carryover', () => ({ snapshotCodexMedia: async () => ({}), restoreCodexMedia: async () => {} }))
  const { characterCodexService } = await import('../src/services/character-codex.service')
  Object.assign(characterCodexService, { applyManualIdentityRevisions: async () => {} })
  const { entityGraphService } = await import('../src/services/entity-graph.service')
  Object.assign(entityGraphService, { repairAfterRewind: async () => {} })
  const { memoryService } = await import('../src/services/memory.service')
  const older = clone(rows('memories')[0])
  rows('events')[4].time_anchor = { real_time: new Date(), sequence: 5, timeline_id: 'main' }
  await memoryService.rewindToSequence(instanceId, playerId, 6)
  assert.deepEqual(rows('memories'), [older])
  assert(!vectors.has(String(thread.pinecone_id))); assert(vectors.has(String(older.pinecone_id)))
  assert(storedEvents().every(event => event.sequence < 6))
})
await check('memory group same normalized text ignores objects subjects and events while distinct people facts remain', async () => {
  await start(); addEvents(5)
  curatorFactory = () => ({ memories: [atom('The player owns a green coat.', 'player', 1),
    atom('  THE player  owns a green coat. ', names[0], 2, { objects: ['coat'] }),
    atom(`${names[0]} owns a blue coat.`, names[0], 3), atom(`${names[1]} owns a red coat.`, names[1], 3)] })
  await memoryProcessor(memoryJob())
  assert.equal(rows('memories').length, 3); assert.equal(vectors.size, 3)
  const older = clone(rows('memories')[0])
  addEvents(5)
  curatorFactory = request => ({ memories: [atom('the player owns a green coat.', names[1], numbered(request).at(-1)!.number, { objects: ['other object'] })] })
  await memoryProcessor(memoryJob())
  assert.equal(rows('memories').length, 3); assert.equal(vectors.size, 3)
  assert.deepEqual(rows('memories')[0], older)
  assert(memoryLogs.filter(row => row.name === 'group.memory_batch').every(row => row.duplicates === 1))
  assert.deepEqual(rows('memories').slice(1).map(row => row.subjects), [[names[0]], [names[1]]])
})
await check('memory catch-up batches are bounded without skipping oldest uncurated events', async () => {
  await start(); addEvents(70)
  const batch = await loadGroupBatch(new ObjectId(instanceId), storedEvents().at(-1)!._id, 'curated_through_sequence')
  assert.equal(batch!.events.length, 27); assert.equal(batch!.events[0].sequence, 2); assert.equal(batch!.through, 28)
})
await check('memory message five and open threads reach normal addressed and bystander actual prompts for a silent member past raw window', async () => {
  await identityBatch()
  const fact = String(rows('memories')[2].text)
  rows('memories').push({ ...clone(rows('memories')[2]), _id: new ObjectId(), text: 'An appointment still awaits the player.', unresolved_thread: true })
  addEvents(40)
  assert(!storedEvents().some(event => event.data.lines?.some(line => line.character_id === ids[3])))
  ragOpenThreads = ['An appointment still awaits the player.']; ragMemoryTexts = [fact]
  modelReplies = [`${names[3]}: A fresh normal reply.`]
  await turn({ userMessage: `@${names[3]} lol ok` }, never)
  assert.equal(writerCalls.length, 1)
  let prompt = String((writerCalls[0].messages as Row[])[1].content)
  assert(prompt.includes(fact) && prompt.includes('Open threads:\nAn appointment still awaits the player.'))
  assert.equal(prompt.split(fact).length - 1, 1); assert(!prompt.split('Recent messages:')[1].includes('My sister is getting married in June.'))
  put(rows('users')[0], 'preferences.nsfw_enabled', true); auditEnv.NSFW_SAME_TURN_ROUTER = 'enforce'
  modelReplies = [`${names[3]}: Fresh addressed response.`, `${names[2]}: Fresh bystander response.`]
  writerCalls = []
  await turn({ userMessage: `@${names[3]} @${names[2]} keep going` }, never)
  assert.equal(writerCalls.length, 2)
  for (const call of writerCalls) {
    prompt = String((call.messages as Row[])[1].content)
    assert(prompt.includes(fact)); assert(prompt.includes('Open threads:\nAn appointment still awaits the player.'))
    assert(prompt.indexOf('Memories:') < prompt.indexOf('Open threads:')); assert(prompt.indexOf('Open threads:') < prompt.indexOf('Recent messages:'))
    assert.equal(prompt.split(fact).length - 1, 1)
  }
  assert.equal(curatorRequests.length, 1)
})
await check('memory query uses last three named messages plus current for player and autonomous turns with member entity ids', async () => {
  await start(); addEvents(3)
  const entities = members.map(member => ({ _id: new ObjectId(), instance_id: new ObjectId(instanceId), character_id: new ObjectId(member.id), type: 'character' }))
  rows('entities').push(...entities)
  modelReplies = [`${names[3]}: A query reply.`]
  await turn({ userMessage: `@${names[3]} ${names[2]} lol ok` }, never)
  assert.equal(ragCalls[0][2], `${names[0]}: filler 3\n${playerName}: Filler 4\n${names[0]}: filler 4\n${playerName}: @${names[3]} ${names[2]} lol ok`)
  assert((ragCalls[0][5] as string[]).includes(String(entities[3]._id))); assert((ragCalls[0][5] as string[]).includes(String(entities[2]._id)))
  // Curated entities can exist by canonical name before a card back-pointer is synced.
  delete rows('entities')[3].character_id; rows('entities')[3].name_normalized = names[3].toLowerCase()
  ragCalls = []; modelReplies = [`${names[3]}: Another query reply.`]
  await turn({ userMessage: `@${names[3]} lol ok` }, never)
  assert((ragCalls[0][5] as string[]).includes(String(entities[3]._id)))
  ragCalls = []; await turn({ origin: 'unprompted', userMessage: '' }, never)
  assert.equal(String(ragCalls[0][2]).split('\n').length, 4); assert(String(ragCalls[0][2]).includes(`${playerName} is quiet. Topic:`))
  assert((ragCalls[0][5] as string[]).length >= 2)
})
await check('memory pins include subject and object for each call speaker with five per person and a total text budget', async () => {
  await start(); addEvents(40)
  const source = storedEvents()[4]._id
  for (const [index, person] of ['player', names[3], names[2]].entries()) for (let i = 0; i < 7; i++) rows('memories').push({
    _id: new ObjectId(), instance_id: new ObjectId(instanceId), player_id: new ObjectId(playerId), text: `Pinned ${person} ${i} ` + 'x'.repeat(570),
    is_archived: false, is_nsfw: false, importance: i, updated_at: new Date(i), subjects: index === 1 ? [] : [person], objects: index === 1 ? [person] : [], source_event_ids: [source],
  })
  modelReplies = [`${names[3]}: A pin reply.\n${names[2]}: Another pin reply.`]
  await turn({ userMessage: `@${names[3]} @${names[2]}` }, never)
  const prompt = String((writerCalls[0].messages as Row[])[1].content)
  for (const person of ['player', names[3], names[2]]) { assert(prompt.includes(`Pinned ${person} 6`)); assert(prompt.includes(`Pinned ${person} 2`)); assert(!prompt.includes(`Pinned ${person} 1`)) }
  const memoryText = prompt.split('Memories:\n')[1].split('\n\n')[0]
  assert(memoryText.length <= GROUP_MEMORY_TEXT_BUDGET)
  for (const person of [names[0], names[1]]) for (let i = 0; i < 7; i++) rows('memories').push({ ...clone(rows('memories')[0]), _id: new ObjectId(),
    text: `Budget ${person} ${i} ` + 'x'.repeat(570), subjects: [person], objects: [], importance: i })
  const bounded = await groupWriterMemory({ instanceId: new ObjectId(instanceId), player: playerName, speakers: names, enabled: false, memories: [], openThreads: [] })
  assert(bounded.memories.join('\n').length <= GROUP_MEMORY_TEXT_BUDGET)
})
await check('memory adult sourced atoms and threads fail closed on fresh toggle off for all writer kinds', async () => {
  await identityBatch()
  const source = storedEvents()[3]; source.type = 'intimate'
  rows('memories')[1].is_nsfw = false // Provenance must beat a misclassified atom.
  rows('memories')[1].unresolved_thread = true
  const adultText = String(rows('memories')[1].text), safeText = String(rows('memories')[2].text)
  ragMemoryTexts = [adultText, safeText]; ragOpenThreads = [adultText]
  addEvents(40)
  modelReplies = [`${names[1]}: A safe memory reply.`]
  await turn({ userMessage: `@${names[1]}` }, never)
  assert(!String((writerCalls[0].messages as Row[])[1].content).includes(adultText))
  put(rows('users')[0], 'preferences.nsfw_enabled', true); auditEnv.NSFW_SAME_TURN_ROUTER = 'enforce'
  let seen = 0
  writerHook = () => { if (++seen === 1) put(rows('users')[0], 'preferences.nsfw_enabled', false) }
  modelReplies = [`${names[1]}: Fresh adult response.`, `${names[2]}: Fresh safe response.`]; writerCalls = []
  await turn({ userMessage: `@${names[1]} @${names[2]} keep going` }, never)
  assert.equal(writerCalls.length, 2)
  assert(String((writerCalls[0].messages as Row[])[1].content).includes(adultText))
  assert(!String((writerCalls[1].messages as Row[])[1].content).includes(adultText))
  assert(String((writerCalls[1].messages as Row[])[1].content).includes(safeText))
  put(rows('users')[0], 'preferences.nsfw_enabled', true)
  let reads = 0
  consentReadHook = () => { if (++reads === 2) put(rows('users')[0], 'preferences.nsfw_enabled', false) }
  writerHook = undefined; writerCalls = []; modelReplies = [`${names[1]}: Fresh redirected reply.`, `${names[2]}: Fresh redirected bystander.`]
  await turn({ userMessage: `@${names[1]} @${names[2]} keep going again` }, never)
  assert.equal(writerCalls.length, 2)
  for (const call of writerCalls) assert(!String((call.messages as Row[])[1].content).includes(adultText))
  // A stale curator is not allowed to lose the source's adult classification.
  await start(); addEvents(5); storedEvents()[4].type = 'intimate'
  curatorFactory = request => ({ memories: [atom('Adult source fact.', 'player', numbered(request).find(message => message.text === 'Filler 5')!.number)] })
  await memoryProcessor(memoryJob()); assert.equal(rows('memories')[0].is_nsfw, true)
})
await check('memory rewind removes message five atom and vector alone and restores both watermarks', async () => {
  const child = Bun.spawn(['bun', '--no-env-file', 'run', 'scripts/codex-media-carryover-audit.ts'], { stdout: 'pipe', stderr: 'pipe', cwd: new URL('..', import.meta.url).pathname })
  const [output, errors, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  assert.equal(code, 0, output + errors); assert(output.includes('PASS memory group rewind removes only message five atoms and vectors'))
})
await check('memory reset removes atoms and vectors and obsolete in-flight curator cannot repopulate', async () => {
  await identityBatch(); assert(rows('memories').length > 0)
  const old = memoryJob(); await deletionService.resetInstance(instanceId, playerId)
  assert.equal(rows('memories').length, 0); assert.equal(vectors.size, 0)
  await memoryProcessor(old); assert.equal(rows('memories').length, 0)
  addEvents(5); curatorFactory = request => ({ memories: [atom('Late atom.', 'player', numbered(request)[0].number)] })
  curatorHook = async () => { curatorHook = undefined; await deletionService.resetInstance(instanceId, playerId) }
  await assert.rejects(memoryProcessor(memoryJob()), /source events changed/)
  assert.equal(rows('memories').length, 0); assert.equal(vectors.size, 0)
  addEvents(5); embedHook = async () => { embedHook = undefined; await deletionService.resetInstance(instanceId, playerId) }
  await assert.rejects(memoryProcessor(memoryJob()), /source events changed/)
  assert.equal(rows('memories').length, 0); assert.equal(vectors.size, 0)
})
await check('memory group summaries render named messages nonoverlapping ranges and watermarks through existing chapter and arc path', async () => {
  await start(); addEvents(12)
  const job = () => ({ data: { instanceId, playerId, eventId: String(storedEvents().at(-1)!._id), groupSummary: true, sceneTag: 'dialogue' } }) as Job
  await summaryProcessor(job())
  const body = String((summaryRequests[0].messages as Row[])[1].content)
  assert(body.includes(`${playerName}: Filler 2`)); assert(body.includes(`${names[0]}: filler 13`)); assert(!/^(Player:|World:)/m.test(body))
  assert.equal(get(rows('worldInstances')[0], 'group_state.summarized_through_sequence'), 13)
  assert.equal(get(storedEvents().at(-1)! as unknown as Row, 'data.group_state_after.summarized_through_sequence'), 13)
  await summaryProcessor(job()); assert.equal(summaryRequests.length, 1)
  for (let block = 1; block < 8; block++) { addEvents(12); await summaryProcessor(job()) }
  assert.deepEqual(rows('sceneSummaries').map(row => row.event_range), Array.from({ length: 8 }, (_, i) => ({ start_sequence: 2 + 12 * i, end_sequence: 13 + 12 * i })))
  assert.equal(queued.at(-1)!.kind, 'chapter')
  await summaryProcessor({ data: { ...queued.at(-1)!, playerId } } as Job)
  assert.equal(rows('chapterSummaries').length, 1); assert.equal(summaryRequests.at(-1)!.purpose, 'chapter_summary')
  for (let i = 1; i < 4; i++) rows('chapterSummaries').push({ ...clone(rows('chapterSummaries')[0]), _id: new ObjectId(), chapter_index: i + 1,
    event_range: { start_sequence: 2 + 96 * i, end_sequence: 97 + 96 * i } })
  addEvents(288)
  // Rebuilding the fourth chapter exercises the same rollup and arc enqueue seam.
  const scene = rows('sceneSummaries')[0]
  for (let i = 0; i < 8; i++) rows('sceneSummaries').push({ ...clone(scene), _id: new ObjectId(), event_range: { start_sequence: 290 + 12 * i, end_sequence: 301 + 12 * i } })
  await summaryProcessor({ data: { instanceId, playerId, kind: 'chapter', chapterIndex: 4, startSequence: 290, endSequence: 385 } } as Job)
  assert.equal(queued.at(-1)!.kind, 'arc')
  await summaryProcessor({ data: { ...queued.at(-1)!, playerId } } as Job)
  assert.equal(rows('arcSummaries').length, 1); assert.equal(summaryRequests.at(-1)!.purpose, 'arc_summary')
  assert(backgroundScopes.some(scope => scope.instance_id === instanceId && scope.event_id))
  // Ordinary summaries still have the exact existing turn rendering.
  summaryRequests = []; rows('events').forEach(event => { delete (event.data as Row).lines })
  await summaryProcessor({ data: { instanceId, playerId, sceneTag: 'dialogue', startSequence: 2, endSequence: 13 } } as Job)
  assert(String((summaryRequests[0].messages as Row[])[1].content).startsWith('[Turn 2] Player: Filler 2\nWorld:'))
})
await check('memory summary failures retain watermark and next job catches up without overlap', async () => {
  await start(); addEvents(12)
  const job = () => ({ data: { instanceId, playerId, eventId: String(storedEvents().at(-1)!._id), groupSummary: true, sceneTag: 'dialogue' } }) as Job
  summaryReply = new Error('Stub summary failed')
  await assert.rejects(summaryProcessor(job()), /Stub summary failed/)
  assert.equal(get(rows('worldInstances')[0], 'group_state.summarized_through_sequence'), 1)
  summaryReply = '   '; await assert.rejects(summaryProcessor(job()), /Group summary failed/)
  assert.equal(get(rows('worldInstances')[0], 'group_state.summarized_through_sequence'), 1)
  addEvents(12); summaryReply = 'Recovered summary.'; await summaryProcessor(job())
  assert.deepEqual(rows('sceneSummaries')[0].event_range, { start_sequence: 2, end_sequence: 13 })
  await summaryProcessor(job())
  assert.deepEqual(rows('sceneSummaries')[1].event_range, { start_sequence: 14, end_sequence: 25 })
})
await check('memory group summary reset during scene chapter and arc calls leaves no summaries or vectors', async () => {
  for (const kind of ['scene', 'chapter', 'arc']) {
    await start(); addEvents(24)
    for (let i = 0; i < 2; i++) {
      rows(kind === 'chapter' ? 'sceneSummaries' : 'chapterSummaries').push({ _id: new ObjectId(), instance_id: new ObjectId(instanceId), status: 'active',
        summary_text: 'Child summary.', event_range: { start_sequence: 2 + 12 * i, end_sequence: 13 + 12 * i } })
    }
    summaryHook = async () => { summaryHook = undefined; await deletionService.resetInstance(instanceId, playerId) }
    const job = kind === 'scene' ? { groupSummary: true, eventId: String(storedEvents().at(-1)!._id), sceneTag: 'dialogue' }
      : { kind, startSequence: 2, endSequence: 25, chapterIndex: 1, arcIndex: 1 }
    await assert.rejects(summaryProcessor({ data: { instanceId, playerId, ...job } } as Job), /source events changed/)
    for (const table of ['sceneSummaries', 'chapterSummaries', 'arcSummaries']) assert.equal(rows(table).length, 0)
    assert.equal(vectors.size, 0)
    assert.equal(get(rows('worldInstances')[0], 'group_state.summarized_through_sequence'), 1)
  }
})
await check('memory concurrent curator jobs serialize one watermark and model call', async () => {
  await start(); addEvents(5)
  let release!: () => void, entered!: () => void
  const ready = new Promise<void>(resolve => { entered = resolve }), gate = new Promise<void>(resolve => { release = resolve })
  curatorFactory = request => ({ memories: [atom('Concurrent fact.', 'player', numbered(request)[0].number)] })
  curatorHook = async () => { curatorHook = undefined; entered(); await gate }
  const job = memoryJob(), running = memoryProcessor(job)
  await ready
  try { await assert.rejects(memoryProcessor(job), /already running/) } finally { release() }
  await running
  assert.equal(curatorRequests.length, 1); assert.equal(rows('memories').length, 1); assert.equal(vectors.size, 1)
})
await check('memory usage trace stores curator and summary provider costs per chat', async () => {
  const child = Bun.spawn(['bun', '--no-env-file', 'run', 'scripts/group-memory-trace-audit.ts'], { stdout: 'pipe', stderr: 'pipe', cwd: new URL('..', import.meta.url).pathname })
  const [output, errors, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  assert.equal(code, 0, output + errors); assert(output.includes('PASS memory usage trace stores curator and summary calls'))
})
await check('memory scheduled dedup protects group ownership and source events without changing normal dedup', async () => {
  const child = Bun.spawn(['bun', '--no-env-file', 'run', 'scripts/group-memory-dedup-audit.ts'], { stdout: 'pipe', stderr: 'pipe', cwd: new URL('..', import.meta.url).pathname })
  const [output, errors, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  assert.equal(code, 0, output + errors); assert(output.includes('PASS memory scheduled dedup protects group owners'))
})
await check('memory recall script scoring selftest rejects history summary and attribution false positives', async () => {
  const outputDir = `${import.meta.dir}/.recall-selftest-${process.pid}`
  try {
    const child = Bun.spawn(['bun', '--no-env-file', 'run', 'scripts/group-memory-recall.ts', '--selftest'], {
      cwd: new URL('..', import.meta.url).pathname, stdout: 'pipe', stderr: 'pipe', stdin: 'ignore',
      env: { ...process.env, OPENROUTER_API_KEY: 'offline-fixture', OPENAI_API_KEY: 'offline-fixture', JWT_SECRET: 'offline-fixture',
        GROUP_MEMORY_RECALL_OUTPUT_DIR: outputDir },
    })
    const [output, errors, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    assert.equal(code, 0, output + errors)
    assert(output.includes('recall sections, player attribution and allergy scoring'))
  } finally { await rm(outputDir, { recursive: true, force: true }) }
})
await check('memory normal curator requests retain fixed pre-change hashes for GM and sentient identities', () => {
  for (const [isSentient, expected] of [[false, 'c2a93ef57405f0982c5f7df0c2dda009db038ed0a60a076818aad2b465ce7d72'], [true, 'af20a1054a96fa8fc1341b22b1ad14bf73b828d39a5ee8e695f2a92d74f9b4aa']] as const) {
    const request = buildMemoryCurationRequest({ sceneTag: 'dialogue', roster: [{ canonical_name: 'Fixture One', aliases: ['One'], is_protagonist: true }],
      isSentient, protagonistName: 'Fixture One', playerPersonaName: 'Fixture Player', precedingAiResponse: 'Previous words.', playerInput: 'My sister arrives tomorrow.',
      playerSpokenInput: 'My sister arrives tomorrow.', playerNarrationFacts: ['The note is delivered.'], aiResponse: 'A promise is kept.', openThreads: [{ id: 'T1', text: 'Return the letter.' }] })
    assert.equal(createHash('sha256').update(JSON.stringify(request)).digest('hex'), expected)
  }
})
Math.random = originalRandom
console.log(`group-chat audit: ${passed}/${passed} passed (pure; fake writer; no connections or paid calls)`)
