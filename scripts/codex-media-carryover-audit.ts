import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { mock } from 'bun:test'
import { ObjectId } from 'mongodb'
import { mongoColl } from '../src/config/mongo'
import type { CharacterProfileDoc } from '../src/models/character-profile.model'
import { characterCodexService, foldDelta, newFoldState, type CharacterCodexDelta } from '../src/services/character-codex.service'
import { snapshotCodexMedia, restoreCodexMedia } from '../src/services/codex-media-carryover'
import { projectionCheckpointService } from '../src/services/projection-checkpoint.service'
import { storageService } from '../src/services/storage.service'

// This process has no database, queue, Redis, storage or paid-provider access.
const redis = { del: async () => 0, publish: async () => 0 }
mock.module('../src/config/redis', () => ({
  getRedisClient: () => redis,
  getRedisSubscriber: () => { throw new Error('Unexpected Redis subscriber') },
  getQueueRedisClient: () => { throw new Error('Unexpected queue connection') },
}))
globalThis.fetch = Object.assign(async () => { throw new Error('Unexpected network access') }, {
  preconnect: () => { throw new Error('Unexpected network preconnect') },
})
const { memoryService, rebuildCodexAndRelationsAfterReplay } = await import('../src/services/memory.service')
const { entityGraphService } = await import('../src/services/entity-graph.service')
const { kinshipGraphService } = await import('../src/services/kinship-graph.service')
Object.assign(entityGraphService, {
  syncCodexEntities: async () => new Map(), syncRelationshipEdges: async () => {}, repairAfterRewind: async () => {},
})
Object.assign(kinshipGraphService, { rebuildFromLedger: async () => {}, applyLedgerSince: async () => {} })

type Row = Record<string, unknown>
const equal = (a: unknown, b: unknown) => a instanceof ObjectId && b instanceof ObjectId ? a.equals(b) : a === b
const get = (row: Row, path: string): unknown => path.split('.').reduce<unknown>((v, k) => v && typeof v === 'object' ? (v as Row)[k] : undefined, row)
function clone<T>(value: T): T {
  if (!value || typeof value !== 'object' || value instanceof ObjectId || value instanceof Date) return value
  if (Array.isArray(value)) return value.map(clone) as T
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, clone(v)])) as T
}
function matches(row: Row, filter: Row): boolean {
  return Object.entries(filter).every(([key, expected]) => {
    const actual = get(row, key)
    if (expected && typeof expected === 'object' && !(expected instanceof ObjectId)) {
      return Object.entries(expected).every(([op, v]) => {
        if (op === '$ne') return !equal(actual, v)
        if (op === '$in') return (v as unknown[]).some((x) => equal(actual, x))
        if (op === '$exists') return (actual !== undefined) === v
        if (op === '$gte') return Number(actual) >= Number(v)
        if (op === '$gt') return Number(actual) > Number(v)
        if (op === '$lte') return Number(actual) <= Number(v)
        if (op === '$lt') return Number(actual) < Number(v)
        throw new Error(`Unsupported fixture operator ${op}`)
      })
    }
    return equal(actual, expected)
  })
}
class Collection {
  rows: Row[] = []
  constructor(readonly name: string) {}
  find(filter: Row = {}) {
    let rows = this.rows.filter((row) => matches(row, filter))
    const cursor = {
      sort: (order: Record<string, number>) => {
        rows.sort((a, b) => {
          for (const [key, direction] of Object.entries(order)) {
            const av = get(a, key), bv = get(b, key)
            if (equal(av, bv)) continue
            return (Number(av) < Number(bv) ? -1 : 1) * direction
          }
          return 0
        })
        return cursor
      },
      limit: (n: number) => { rows = rows.slice(0, n); return cursor },
      project: () => cursor,
      toArray: async () => clone(rows),
    }
    return cursor
  }
  async findOne(filter: Row) { return clone(this.rows.find((row) => matches(row, filter)) ?? null) }
  async insertMany(rows: Row[]) { for (const row of rows) { this.validate(row); this.rows.push(clone(row)) } }
  async deleteMany(filter: Row) { this.rows = this.rows.filter((row) => !matches(row, filter)) }
  async updateOne(filter: Row, update: { $set?: Row }) {
    const row = this.rows.find((row) => matches(row, filter))
    if (!row) return
    assert.ok(update.$set, 'Fixture only accepts $set updates')
    this.validate({ ...row, ...update.$set }, row)
    for (const [path, value] of Object.entries(update.$set)) {
      const keys = path.split('.'), key = keys.pop()!
      let target = row
      for (const part of keys) target = (target[part] ||= {}) as Row
      target[key] = clone(value)
    }
  }
  async updateMany(filter: Row, update: { $set?: Row }) {
    for (const row of this.rows.filter((row) => matches(row, filter))) await this.updateOne({ _id: row._id }, update)
  }
  validate(row: Row, current?: Row) {
    if (this.name === 'mediaAssets') {
      assert.notEqual(row.cache_key, null)
      assert.ok(!this.rows.some((other) => other !== current && other.cache_key === row.cache_key), 'unique portrait cache key')
    }
    for (const key of ['portrait', 'voice', 'voice_traits', 'character_id', 'identity_scope']) assert.notEqual(row[key], null, `omit absent ${key}`)
  }
}
const asRow = (value: object): Row => value as Row
function fixture() {
  const names = ['characters', 'mediaAssets', 'mediaUsage', 'mediaRejections', 'events', 'worldInstances', 'worldTemplates', 'memories', 'sceneSummaries', 'chapterSummaries', 'arcSummaries', 'entities', 'projectionCheckpoints', 'projectionCheckpointChunks', 'entityEdges'] as const
  const db = Object.fromEntries(names.map((name) => [name, new Collection(name)])) as Record<typeof names[number], Collection>
  for (const name of names) Object.assign(mongoColl, { [name]: () => db[name] })
  const iid = new ObjectId(), pid = new ObjectId(), tid = new ObjectId(), checkpointId = new ObjectId()
  const now = new Date('2026-10-16T00:00:00Z')
  const deltas: CharacterCodexDelta[] = [{ name: 'Fixture Person', aliases: ['Fixture Alias'], appearance: 'A lasting scar.' }]
  function folded(ds = deltas, sequence = 1) {
    const state = newFoldState([])
    for (const delta of ds) foldDelta(state, delta, sequence, { iid, pid, now })
    return [...state.created]
  }
  const old = folded()[0]
  old.portrait = { asset_key: 'fixture/portrait.jpg', source: 'generated', appearance_version: 3, painted_at: now, art_style: 'anime' }
  old.voice = { model: 'fixture-model', voice_id: 'fixture-voice' }
  old.voice_traits = { timbre: 'warm' }
  old.mutable_state = ['This removed fact must not survive.']
  db.characters.rows = [asRow(old)]
  function portraitRow(card = old, key = card.portrait?.asset_key) {
    return { _id: new ObjectId(), instance_id: iid, kind: 'portrait', character_id: card._id,
      cache_key: `portrait:${card._id}:v3:anime:fixture-model`, ...(key ? { asset_key: key } : {}) }
  }
  db.mediaAssets.rows = [portraitRow()]
  const template = { _id: tid, is_sentient: false, base_stats_template: {}, flag_definitions: {} }
  const instance = { _id: iid, player_id: pid, template_id: tid, meta: { total_memories: 0 } }
  db.worldTemplates.rows = [template]; db.worldInstances.rows = [instance]
  const event = { _id: new ObjectId(), instance_id: iid, player_id: pid, sequence: 1, type: 'narration', scene_tag: 'dialogue',
    time_anchor: { timeline_id: 'fixture-timeline' }, data: { codex_deltas: deltas, ai_response: 'Fixture prose.' } }
  db.events.rows = [event]
  const deleted: string[] = []
  storageService.deleteStrict = async (key) => { deleted.push(key) }
  const snapshot = () => snapshotCodexMedia(iid)
  function checkpoint(cards = folded()) {
    db.projectionCheckpoints.rows = [{ _id: checkpointId, instance_id: iid, sequence: 1, kind: 'world_projection', status: 'active' }]
    db.projectionCheckpointChunks.rows = [{ _id: new ObjectId(), checkpoint_id: checkpointId, kind: 'characters', index: 0, docs: cards }]
  }
  async function replay() {
    return rebuildCodexAndRelationsAfterReplay({ event, playerId: String(pid), instance, template, narrative: '', deltas: [], forceExactRebuild: true })
  }
  function preserved() {
    const card = db.characters.rows.find((c) => c.canonical_name === old.canonical_name)!
    assert.ok(card, 'surviving card exists')
    assert.ok(!equal(card._id, old._id), 'rebuild minted/restored a different id')
    assert.deepEqual(card.portrait, old.portrait, 'portrait reattached, including style/date/version')
    assert.deepEqual(card.voice, old.voice, 'voice reattached')
    assert.deepEqual(card.voice_traits, old.voice_traits, 'voice traits reattached')
    const asset = db.mediaAssets.rows.find((a) => a.kind === 'portrait')!
    assert.ok(equal(asset.character_id, card._id), 'portrait character_id re-keyed')
    assert.equal(asset.cache_key, `portrait:${card._id}:v3:anime:fixture-model`, 'portrait cache_key re-keyed')
    assert.deepEqual(card.mutable_state, [], 'removed story fact stays removed')
    assert.deepEqual(deleted, [], 'survivor portrait never deleted')
  }
  return { db, iid, pid, old, event, folded, portraitRow, deleted, snapshot, checkpoint, replay, preserved, checkpointId }
}

const checks: Array<[string, () => Promise<void>]> = []
const check = (name: string, run: () => Promise<void>) => checks.push([name, run])
check('rewind past nothing: real rewind keeps media and re-keys cache', async () => {
  const f = fixture()
  await memoryService.rewindToSequence(String(f.iid), String(f.pid), 2)
  f.preserved()
})
check('rewind past birth: object and portrait row deleted; other media survives', async () => {
  const f = fixture()
  f.db.events.rows[0].sequence = 2
  f.db.events.rows.unshift({ ...f.event, _id: new ObjectId(), sequence: 1, data: { codex_deltas: [] }, time_anchor: f.event.time_anchor })
  f.db.mediaAssets.rows.push({ ...f.portraitRow(), _id: new ObjectId(), kind: 'voice', cache_key: 'fixture-voice-cache' })
  await memoryService.rewindToSequence(String(f.iid), String(f.pid), 2)
  assert.deepEqual(f.deleted, ['fixture/portrait.jpg'], 'orphan portrait object deleted once')
  assert.equal(f.db.mediaAssets.rows.filter((a) => a.kind === 'portrait').length, 0, 'orphan portrait row deleted')
  assert.equal(f.db.mediaAssets.rows.length, 1, 'event media not owned by carry-over')
  assert.equal(f.db.characters.rows.length, 0)
})
check('legacy rewind: provenance pruning removes orphan portrait', async () => {
  const f = fixture()
  f.old.first_seen_sequence = 2
  f.db.events.rows = [{ ...f.event, data: {} }]
  await memoryService.rewindToSequence(String(f.iid), String(f.pid), 2)
  assert.deepEqual(f.deleted, ['fixture/portrait.jpg'])
  assert.equal(f.db.mediaAssets.rows.length, 0)
})
check('edit/replay: real shared projection rebuild carries media', async () => {
  const f = fixture(); await f.replay(); f.preserved()
})
check('checkpoint restore: live media wins over stale snapshot media', async () => {
  const f = fixture(), historical = f.folded()[0]
  historical.portrait = { ...f.old.portrait!, asset_key: 'fixture/deleted-historical.jpg' }
  historical.voice = { model: 'old-model', voice_id: 'old-voice' }
  f.checkpoint([historical])
  await projectionCheckpointService.restoreCodexAndKinship(f.checkpointId)
  f.preserved()
})
check('checkpoint plus suffix: suffix-born card keeps media until fold completes', async () => {
  const f = fixture(); f.checkpoint([])
  f.event.sequence = 2
  await f.replay(); f.preserved()
})
check('checkpoint rewind: surviving card keeps media through real checkpoint branch', async () => {
  const f = fixture(); f.checkpoint()
  await memoryService.rewindToSequence(String(f.iid), String(f.pid), 2)
  f.preserved()
})
check('checkpoint failure: full-ledger fallback retains original snapshot', async () => {
  const f = fixture(); f.checkpoint(); f.event.sequence = 2
  const original = projectionCheckpointService.restoreCodexAndKinship
  projectionCheckpointService.restoreCodexAndKinship = async () => {
    f.db.characters.rows = []
    throw new Error('fixture checkpoint failure after destructive write')
  }
  try { await f.replay(); f.preserved() } finally { projectionCheckpointService.restoreCodexAndKinship = original }
})
check('late checkpoint failure: fallback re-keys already moved asset rows again', async () => {
  const f = fixture(); f.checkpoint(); f.event.sequence = 2
  const original = entityGraphService.syncCodexEntities
  let attempts = 0
  entityGraphService.syncCodexEntities = async () => {
    if (++attempts === 1) throw new Error('fixture graph failure after media re-key')
    return new Map()
  }
  try { await f.replay(); f.preserved(); assert.equal(attempts, 2) }
  finally { entityGraphService.syncCodexEntities = original }
})
check('aliases: corrected canonical name resolves to its prior identity', async () => {
  const f = fixture(), snap = await f.snapshot()
  const card = f.folded([{ name: 'Fixture Alias', aliases: ['Fixture Person'] }])[0]
  f.db.characters.rows = [asRow(card)]
  await restoreCodexMedia(snap)
  assert.deepEqual(f.db.characters.rows[0].voice, f.old.voice)
  assert.deepEqual(f.deleted, [])
})
check('scoped labels: two holders never swap faces', async () => {
  const f = fixture()
  const prior = f.folded([{ name: 'the traveler', identity_scope: 'first' }, { name: 'the traveler', identity_scope: 'second' }])
  prior[0].voice = { model: 'fixture', voice_id: 'one' }; prior[1].voice = { model: 'fixture', voice_id: 'two' }
  f.db.characters.rows = prior.map(asRow); f.db.mediaAssets.rows = []
  const snap = await f.snapshot()
  const next = f.folded([{ name: 'the traveler', identity_scope: 'second' }, { name: 'the traveler', identity_scope: 'first' }])
  f.db.characters.rows = next.map(asRow)
  await restoreCodexMedia(snap)
  assert.equal((f.db.characters.rows[0].voice as { voice_id: string }).voice_id, 'two')
  assert.equal((f.db.characters.rows[1].voice as { voice_id: string }).voice_id, 'one')
})
check('rewind before name reveal: a released label retains its original face', async () => {
  const f = fixture()
  f.old.former_labels = ['the traveler']
  const snap = await f.snapshot()
  const originalHolder = f.folded([{ name: 'the traveler', identity_scope: 'original' }])[0]
  const laterHolder = f.folded([{ name: 'the traveler', identity_scope: 'later' }], 2)[0]
  f.db.characters.rows = [asRow(laterHolder), asRow(originalHolder)]
  await restoreCodexMedia(snap)
  assert.equal(f.db.characters.rows[0].voice, undefined, 'later label holder gets no borrowed voice')
  assert.deepEqual(f.db.characters.rows[1].portrait, f.old.portrait)
  assert.deepEqual(f.db.characters.rows[1].voice, f.old.voice)
  assert.deepEqual(f.deleted, [])
})
check('absent media: no null or undefined media fields are written', async () => {
  const f = fixture(); delete f.old.portrait; delete f.old.voice; delete f.old.voice_traits
  const snap = await f.snapshot(); f.db.characters.rows = f.folded().map(asRow)
  await restoreCodexMedia(snap)
  for (const key of ['portrait', 'voice', 'voice_traits']) assert.equal(Object.hasOwn(f.db.characters.rows[0], key), false)
})
check('all cache variants: legacy and failed suffixes remain byte-identical', async () => {
  const f = fixture()
  const suffixes = ['v1:legacy-model', 'v2:anime:fixture-model:failed:receipt']
  f.db.mediaAssets.rows = suffixes.map((suffix) => ({ ...f.portraitRow(), cache_key: `portrait:${f.old._id}:${suffix}` }))
  const snap = await f.snapshot(); const card = f.folded()[0]; f.db.characters.rows = [asRow(card)]
  await restoreCodexMedia(snap)
  assert.deepEqual(f.db.mediaAssets.rows.map((row) => row.cache_key), suffixes.map((suffix) => `portrait:${card._id}:${suffix}`))
})
check('orphan cleanup: all repaint rows and card-only objects are deleted', async () => {
  const f = fixture()
  f.db.mediaAssets.rows.push({ ...f.portraitRow(), _id: new ObjectId(), cache_key: 'portrait:older', asset_key: 'fixture/older.jpg' })
  const snap = await f.snapshot(); f.db.characters.rows = []
  await restoreCodexMedia(snap)
  assert.deepEqual(f.deleted.sort(), ['fixture/older.jpg', 'fixture/portrait.jpg'])
  assert.equal(f.db.mediaAssets.rows.length, 0)
  const g = fixture(); g.db.mediaAssets.rows = []
  const cardOnly = await g.snapshot(); g.db.characters.rows = []
  await restoreCodexMedia(cardOnly)
  assert.deepEqual(g.deleted, ['fixture/portrait.jpg'])
})
check('storage failure: reject and retain portrait row for cleanup', async () => {
  const f = fixture(), snap = await f.snapshot(); f.db.characters.rows = []
  storageService.deleteStrict = async () => { throw new Error('fixture storage failure') }
  await assert.rejects(restoreCodexMedia(snap), /fixture storage failure/)
  assert.equal(f.db.mediaAssets.rows.length, 1)
  storageService.deleteStrict = async (key) => { f.deleted.push(key) }
  await restoreCodexMedia(await f.snapshot())
  assert.deepEqual(f.deleted, ['fixture/portrait.jpg'], 'a later rebuild retries the orphan receipt')
  assert.equal(f.db.mediaAssets.rows.length, 0)
})
check('shared world faces: deleting a save-local cache row keeps the template object', async () => {
  const f = fixture()
  f.db.worldTemplates.rows[0].seed_cast = [{ name: f.old.canonical_name, portrait: f.old.portrait }]
  const snap = await f.snapshot(); f.db.characters.rows = []
  await restoreCodexMedia(snap)
  assert.deepEqual(f.deleted, [])
  assert.equal(f.db.mediaAssets.rows.length, 0)
  assert.equal((f.db.worldTemplates.rows[0].seed_cast as Array<{ portrait: { asset_key: string } }>)[0].portrait.asset_key, 'fixture/portrait.jpg')
})
check('checkpoint cannot resurrect media for a card with no current media', async () => {
  const f = fixture(), historical = f.folded()[0]
  historical.portrait = f.old.portrait; historical.voice = f.old.voice; historical.voice_traits = f.old.voice_traits
  f.checkpoint([historical]); f.db.characters.rows = []
  await projectionCheckpointService.restoreCodexAndKinship(f.checkpointId)
  for (const key of ['portrait', 'voice', 'voice_traits']) assert.equal(Object.hasOwn(f.db.characters.rows[0], key), false)
})

if (process.argv.includes('--bites')) {
  const path = new URL('../src/services/codex-media-carryover.ts', import.meta.url)
  const original = readFileSync(path, 'utf8')
  const mutations = [
    ['reattach', 'if (Object.keys(media).length)', 'if (false && Object.keys(media).length)', 'portrait reattached'],
    ['re-key', '$set: { character_id: card._id, cache_key: cacheKey }', '$set: { character_id: old._id, cache_key: asset.cache_key }', 'portrait character_id re-keyed'],
    ['orphan delete', 'if (matched.has(old)) continue', 'if (true) continue', 'orphan portrait object deleted once'],
  ]
  for (const [name, before, after, expected] of mutations) {
    assert.equal(original.split(before).length, 2, `one mutation target for ${name}`)
    try {
      writeFileSync(path, original.replace(before, after))
      const child = Bun.spawn(['bun', 'run', 'audit:codex-media-carryover'], { stdout: 'pipe', stderr: 'pipe' })
      const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
      assert.notEqual(code, 0, `${name} removal must fail`)
      assert.ok((stdout + stderr).includes(expected), `${name} fails its intended assertion`)
      console.log(`BITE ${name}: exit ${code}; ${expected}`)
    } finally { writeFileSync(path, original) }
  }
  console.log('3/3 mutations rejected; helper restored byte for byte')
} else {
  let failed = 0
  for (const [name, run] of checks) {
    try { await run(); console.log(`PASS ${name}`) }
    catch (error) { failed++; console.error(`FAIL ${name}:`, error) }
  }
  console.log(`codex-media-carryover: ${checks.length - failed}/${checks.length} passed`)
  process.exitCode = failed ? 1 : 0
}
