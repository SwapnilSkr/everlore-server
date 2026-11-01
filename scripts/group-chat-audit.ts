import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { mock } from 'bun:test'
import { ObjectId } from 'mongodb'
import type { Job } from 'bullmq'
import { rollSpeakers, advanceSilence, pickAddressed, rollBystanders } from '../src/services/group-chat/roll'
import { parseLines, filterLines, timeLines, emptyLineCounts } from '../src/services/group-chat/lines'
import { buildGroupStatic, buildGroupDynamic, buildAddressedStatic } from '../src/services/group-chat/prompt'
import { writeGroupReply } from '../src/services/group-chat/reply'
import { validateGroup } from '../src/services/group-chat/validation'
import { publicGroupData } from '../src/services/group-chat/public'
import { members, groupTemplate } from './group-chat-fixtures'
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
      if (op === '$ne') return !eq(value, other)
      if (op === '$exists') return (value !== undefined) === other
      if (op === '$in') return (other as unknown[]).some(other => eq(value, other))
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
    find(filter: Row = {}) {
      let values = rows(name).filter(row => matches(row, filter))
      const cursor = {
        sort(order: Record<string, number>) { values.sort((a, b) => { for (const [key, dir] of Object.entries(order)) { const av = get(a, key), bv = get(b, key); if (av !== bv) return (Number(av) < Number(bv) ? -1 : 1) * dir } return 0 }); return cursor },
        limit(n: number) { values = values.slice(0, n); return cursor }, skip(n: number) { values = values.slice(n); return cursor },
        project(fields: Record<string, number>) { values = values.map(value => Object.fromEntries(Object.keys(fields).filter(key => fields[key] && key in value).map(key => [key, value[key]]))); return cursor }, async toArray() { return clone(values) },
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
        for (const key of Object.keys((update.$unset || {}) as Row)) delete row[key]
      }
      return { matchedCount: existed ? 1 : 0, modifiedCount: existed ? 1 : 0 }
    },
    async deleteMany(filter: Row) { const list = rows(name); const kept = list.filter(row => !matches(row, filter)); list.splice(0, list.length, ...kept); return { deletedCount: list.length - kept.length } },
    async deleteOne(filter: Row) { const index = rows(name).findIndex(row => matches(row, filter)); if (index >= 0) rows(name).splice(index, 1); return { deletedCount: index >= 0 ? 1 : 0 } },
  }
}
const frames: Row[] = [], outbox: Row[] = [], locks = new Map<string, string>(), queued: Row[] = []
const redis = {
  async get(key: string) { return locks.get(key) || null },
  async set(key: string, value: string) { locks.set(key, value); return 'OK' },
  async del(key: string) { locks.delete(key); return 1 },
  async publish(channel: string, text: string) { assert(channel.startsWith('user:')); frames.push(JSON.parse(text)); return 1 },
  async eval(_script: string, _keys: number, key: string, outcomeKey: string, before: string, after: string, _ttl: string, outcome: string, channel: string, frame: string) {
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
let routerRequests = 0, routerDelay = 0, routerSexual = true
mock.module('../src/config/env', () => ({ env: { ...auditEnv, get NSFW_SAME_TURN_ROUTER() { return auditEnv.NSFW_SAME_TURN_ROUTER }, CDN_BASE_URL: 'https://fixture.invalid', JWT_SECRET: 'audit-only', MEDIA_VOICE_ENABLED: false } }))
mock.module('../src/config/mongo', () => ({ mongoColl: new Proxy({}, { get: (_target, key) => () => collection(String(key)) }) }))
mock.module('../src/config/redis', () => ({ getRedisClient: () => redis, getQueueRedisClient: unavailable, getRedisSubscriber: unavailable }))
const routerClient = { chat: { completions: { create: async () => {
  routerRequests++
  await new Promise(resolve => setTimeout(resolve, routerDelay))
  return { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ sexual_intent: routerSexual }) } }] }
} } } }
mock.module('../src/config/openai', () => ({ getOpenRouter: () => ({ withOptions: () => routerClient }), getOpenAI: unavailable }))
mock.module('../src/services/llm-trace.service', () => ({ flushLLMTracesLater: () => {}, flushLLMTraces: async () => {}, traceStore: () => ({ calls: collection('llmCalls'), bodies: collection('llmBodies') }), runBackgroundLLMTrace: async (_scope: unknown, fn: () => Promise<unknown>) => fn() }))
mock.module('../src/providers/rag.provider', () => ({ queryRag: async () => ({ memoryTexts: ['Remembered group fact.'] }), querySummaries: async () => [] }))
mock.module('../src/services/post-process-outbox.service', () => ({ stagePostProcess: async (input: Row) => { outbox.push(input) }, dispatchPostProcessOutbox: async () => 0 }))
mock.module('../src/services/media/attribution', () => ({ ATTRIBUTION_RULE_VERSION: 'audit', mediaRevision: () => 'audit' }))
mock.module('../src/services/moderation.service', () => ({ moderationService: { discoveryFilter: async () => ({}) } }))
const checkLogs: Row[] = []
mock.module('../src/utils/logger', () => ({ log: { info: (name: string, data: Row) => { if (name === 'group.reply_checked') checkLogs.push(data) }, warn: () => {}, error: () => {} } }))
mock.module('../src/services/time.service', () => ({ timeService: { initialAnchor: async (input: Row) => { assert.equal(input.templateId, undefined); return { real_time: new Date(), sequence: 0, timeline_id: 'main' } } } }))
mock.module('../src/services/opening-place.service', () => ({ extractOpeningPlace: unavailable }))
mock.module('../src/services/character-codex.service', () => ({ characterCodexService: { seedProtagonist: unavailable } }))
mock.module('../src/services/kinship-graph.service', () => ({ kinshipGraphService: { seedPremiseKinship: unavailable } }))
mock.module('../src/services/template-cast.service', () => ({ materializeTemplateCast: async (input: { instanceId: string }) => { rows('characters').push(...members.map(member => ({ _id: new ObjectId(member.id), instance_id: new ObjectId(input.instanceId), canonical_name: member.name }))); return 4 } }))
mock.module('../worker/lib/template-cast-extractor', () => ({ extractTemplateCast: unavailable }))
mock.module('../src/services/vector-store', () => ({ vectorStore: { replaceLore: unavailable, deleteScope: async () => {} } }))
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
mock.module('../src/queues', () => ({ removeQueuedJobsForInstance: async () => {}, getGenerationQueue: () => ({ add: async (_name: string, data: Row, options: Row) => { queued.push(data); return { id: options.jobId } } }), QUEUE_RETENTION: { generation: { removeOnComplete: 10, removeOnFail: 10 } } }))
let writerHook: ((request: Row) => void) | undefined
let modelReplies: Array<string | Error> = [], writerCalls: Row[] = [], turnNumber = 0
mock.module('../src/ai', () => ({ AI_MODELS: { narrationSfw: 'fake-safe', narrationNsfw: 'fake-story-adult', groupNsfw: 'fake-adult', groupNsfwFallbacks: ['fake-adult-fallback', 'fake-adult-last'], narrationSfwFallbacks: ['fake-safe-fallback'], narrationNsfwFallbacks: ['fake-adult-fallback'] }, narrationTemperature: () => 0.62, snapshotLLMUsage: () => [],
  callLLMWithFallback: async (request: Row) => { writerCalls.push(request); writerHook?.(request); const response = modelReplies.shift(); if (response instanceof Error) throw response; return { content: response ?? `${names[0]}: Fresh response ${turnNumber++}`, model: request.model } }, embed: unavailable, callLLM: unavailable, embedQuery: unavailable, embedBatch: unavailable, callLLMStream: unavailable, callLLMStreamWithFallback: unavailable, isEmbedTimeout: () => false,
}))
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
async function start() {
  tables.clear(); frames.length = 0; locks.clear(); queued.length = 0; outbox.length = 0; writerCalls = []; modelReplies = []; writerHook = undefined; consentReadHook = undefined; checkLogs.length = 0; auditEnv.NSFW_SAME_TURN_ROUTER = 'off'; routerRequests = 0; routerDelay = 0
  rows('users').push({ _id: new ObjectId(playerId), preferences: { nsfw_enabled: false, player_name: playerName } })
  rows('worldTemplates').push(clone(groupTemplate()) as unknown as Row)
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
  for (const [key, entry] of Object.entries(value)) { assert(!['intimacy', 'voice', 'wants', 'talkativeness', 'topics', 'group_state', 'group_state_after', 'group_context', 'cost', 'cost_usd'].includes(key), `leaked ${key}`); forbidden(entry) }
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
  for (const patch of [{ intimacy: 42 }, { voice: 'wrong' }, { voice: [] }, { voice: Array(9).fill('text') }, { voice: [42] }, { extra: 'unknown' }]) {
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
await check('toggle off never picks adult despite recent explicit scene and Ardent mode; toggle on follows scene', async () => {
  for (const enabled of [false, true]) for (const mode of ['free_play', 'ardent']) {
    await start(); put(rows('users')[0], 'preferences.nsfw_enabled', enabled)
    rows('worldInstances')[0].mode = mode
    rows('events').push(...[2, 3].map(sequence => ({ ...clone(rows('events')[0]), _id: new ObjectId(), sequence, type: 'intimate' })))
    await turn({ origin: 'unprompted', userMessage: '' })
    assert.equal(writerCalls[0].model, enabled ? 'fake-adult' : 'fake-safe')
  }
})
async function adultStart() {
  await start()
  put(rows('users')[0], 'preferences.nsfw_enabled', true)
  rows('worldInstances')[0].mode = 'ardent'
}
function content(call: Row, role: number) { return ((call.messages as Row[])[role].content as string) }
function lastData() { return rows('events').at(-1)!.data as Row }
await check('adult split order models histories budgets records and whole reply; normal turn stays one call', async () => {
  await adultStart()
  const staticBefore = get(rows('worldInstances')[0], 'group_context.static_prompt')
  const seed = rows('events')[0]
  for (let sequence = 2; sequence <= 16; sequence++) rows('events').push({ ...clone(seed), _id: new ObjectId(), sequence,
    data: { player_input: '', lines: [{ character_id: ids[0], text: `history-${sequence}`, shown_at: new Date() }] } })
  modelReplies = [`${names[2]}: Addressed first\n${names[2]}: Addressed second\n${names[2]}: Addressed third`, `${names[0]}: Bystander reply\n${names[0]}: Extra dropped`]
  let rolls = 0
  await turn({ userMessage: `@${names[2]}, answer this` }, () => { rolls++; return rolls <= members.length - 1 ? 0 : 0.75 })
  assert.equal(rolls > 0, true)
  // The first non-addressed rolled speaker is selected by the injected roll.
  assert.deepEqual(writerCalls.map(call => call.model), ['fake-adult', 'fake-safe'])
  assert.deepEqual(writerCalls.map(call => call.maxTokens), [160, 60])
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
await check('adult retry advances writer after filtered output; empty adult chain reaches normal writer', async () => {
  await adultStart(); modelReplies = [`${names[0]}: *only action*`, `${names[0]}: Retry fresh`]
  await turn({}, () => 0)
  assert.deepEqual(writerCalls.map(call => call.model), ['fake-adult', 'fake-adult-fallback'])
  assert.equal(lastData().model_used, 'fake-adult-fallback')
  assert.equal(checkLogs.at(-1)!.stage_directions, 1); assert.equal(checkLogs.at(-1)!.empty, 1)
  assert.equal((checkLogs.at(-1)!.writing as Row[])[1].purpose, 'addressed_retry')
  await adultStart(); modelReplies = ['', '', `${names[0]}: Normal rescue`]
  await turn({}, () => 0)
  assert.deepEqual(writerCalls.map(call => call.model), ['fake-adult', 'fake-adult-fallback', 'fake-safe'])
  assert(lastData().ai_response!.toString().includes('Normal rescue'))
  assert.equal(get(rows('worldInstances')[0], 'group_state.writing_calls'), 3)
  await adultStart(); put(rows('worldTemplates')[0], 'model_preferences.narration_nsfw', ' fake-adult-fallback ')
  modelReplies = ['', `${names[0]}: Deduplicated retry`]
  await turn({}, () => 0)
  assert.deepEqual(writerCalls.map(call => call.model), ['fake-adult-fallback', 'fake-adult-last'])
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
    await turn(); assert(writerCalls.every(call => call.model === 'fake-safe'))
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

await check('twentieth writing call stages memory and summary only; history/load leak no internals', async () => {
  await start(); put(rows('worldInstances')[0], 'group_state.writing_calls', 19)
  await turn(); assert.deepEqual(outbox.map(row => row.kind), ['memory_curation', 'scene_summary'])
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
Math.random = originalRandom
console.log(`group-chat audit: ${passed}/${passed} passed (pure; fake writer; no connections or paid calls)`)
