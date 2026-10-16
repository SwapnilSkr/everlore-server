import { ObjectId, MongoServerError } from 'mongodb'
import { mongoColl } from '../src/config/mongo'
import { mediaEffects } from '../src/services/media/service'
import { visualEffects } from '../src/services/media/visual'
import { safetyEffects } from '../src/services/media/safety'
import { directorEffects } from '../src/services/media/director'
import { attributionEffects, mediaRevision } from '../src/services/media/attribution'
import { detectSpokenLines } from '../src/services/media/detection'
import type { CharacterProfileDoc } from '../src/models/character-profile.model'

// Deliberately small Mongo double, with actual unique-slot and cache-key constraints.
type Row = Record<string, unknown>
const get = (row: Row, path: string): unknown => path.split('.').reduce<unknown>((v, k) => v && typeof v === 'object' ? (v as Row)[k] : undefined, row)
const same = (a: unknown, b: unknown) => a instanceof ObjectId && b instanceof ObjectId ? a.equals(b) : a === b
function matches(row: Row, filter: Row): boolean {
  return Object.entries(filter).every(([path, expected]) => {
    const actual = get(row, path)
    if (expected && typeof expected === 'object' && !(expected instanceof ObjectId) && !(expected instanceof Date)) {
      if (!Object.keys(expected).some((key) => key.startsWith('$'))) return JSON.stringify(actual) === JSON.stringify(expected)
      return Object.entries(expected).every(([op, value]) => {
        if (op === '$exists') return (actual !== undefined) === value
        if (op === '$ne') return !same(actual, value)
        if (op === '$in') return (value as unknown[]).some((v) => same(actual, v))
        if (op === '$lt') return (actual as Date) < (value as Date)
        throw new Error(`Unsupported fixture operator ${op}`)
      })
    }
    return same(actual, expected)
  })
}
function set(row: Row, path: string, value: unknown, unset = false) {
  const keys = path.split('.'), key = keys.pop()!
  let parent = row
  for (const k of keys) parent = (parent[k] ||= {}) as Row
  if (unset) delete parent[key]; else parent[key] = value
}
export class MemoryCollection {
  rows: Row[] = []
  inserts = 0
  constructor(readonly name: string) {}
  async insertOne(row: Row) {
    const conflict = this.rows.some((r) => same(r._id, row._id)
      || (this.name === 'mediaAssets' && r.cache_key === row.cache_key)
      || (this.name === 'mediaUsage' && row.slot !== undefined && r.slot === row.slot && r.kind === row.kind && r.day === row.day && same(r.player_id, row.player_id)))
    if (conflict) throw new MongoServerError({ code: 11000, message: 'duplicate fixture key' })
    this.rows.push(structuredCloneRow(row)); this.inserts++
    return { insertedId: row._id }
  }
  async findOne(filter: Row) { return structuredCloneRow(this.rows.find((row) => matches(row, filter)) || null) }
  find(filter: Row = {}) {
    const cursor = {
      sort: (_sort: Row) => cursor,
      project: (_projection: Row) => cursor,
      limit: (_n: number) => cursor,
      toArray: async () => this.rows.filter((r) => matches(r, filter)).map(structuredCloneRow),
    }
    return cursor
  }
  async countDocuments(filter: Row) { return this.rows.filter((r) => matches(r, filter)).length }
  async updateOne(filter: Row, update: Row) {
    const row = this.rows.find((r) => matches(r, filter))
    if (!row) return { matchedCount: 0, modifiedCount: 0 }
    this.apply(row, update)
    return { matchedCount: 1, modifiedCount: 1 }
  }
  async updateMany(filter: Row, update: Row) {
    for (const row of this.rows.filter((r) => matches(r, filter))) this.apply(row, update)
  }
  async findOneAndUpdate(filter: Row, update: Row) {
    const row = this.rows.find((r) => matches(r, filter))
    if (!row) return null
    this.apply(row, update)
    return structuredCloneRow(row)
  }
  async deleteOne(filter: Row) {
    const index = this.rows.findIndex((r) => matches(r, filter))
    if (index >= 0) this.rows.splice(index, 1)
    return { deletedCount: index >= 0 ? 1 : 0 }
  }
  async deleteMany(filter: Row) { this.rows = this.rows.filter((r) => !matches(r, filter)) }
  private apply(row: Row, update: Row) {
    for (const [key, value] of Object.entries((update.$set || {}) as Row)) set(row, key, value)
    for (const key of Object.keys((update.$unset || {}) as Row)) set(row, key, undefined, true)
  }
}
function structuredCloneRow<T>(value: T): T {
  if (value instanceof ObjectId || value instanceof Date || !value || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(structuredCloneRow) as T
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, structuredCloneRow(v)])) as T
}
export function fixture() {
  const names = ['worldInstances', 'worldTemplates', 'events', 'users', 'characters', 'mediaAssets', 'mediaUsage', 'mediaRejections', 'personas'] as const
  const db = Object.fromEntries(names.map((name) => [name, new MemoryCollection(name)])) as Record<typeof names[number], MemoryCollection>
  for (const name of names) Object.assign(mongoColl, { [name]: () => db[name] })
  const player = new ObjectId(), instance = new ObjectId(), event = new ObjectId(), template = new ObjectId(), character = new ObjectId()
  const prose = '“Come with me.”'
  const revision = mediaRevision(prose, '')
  const card: CharacterProfileDoc = { _id: character, instance_id: instance, player_id: player, canonical_name: 'Speaker', name_normalized: 'speaker', aliases: ['Alias'], immutable_facts: [], mutable_state: [], disposition_to_player: '', hidden_thought: '', first_seen_sequence: 1, last_seen_sequence: 1, mention_count: 1, created_at: new Date(), updated_at: new Date() }
  db.characters.rows = [card as unknown as Row]
  db.worldInstances.rows = [{ _id: instance, player_id: player, template_id: template }]
  db.worldTemplates.rows = [{ _id: template, is_sentient: false }]
  db.users.rows = [{ _id: player, preferences: { nsfw_enabled: false } }]
  db.events.rows = [{ _id: event, player_id: player, instance_id: instance, data: { ai_response: prose, player_input: '', media_revision: revision, spoken_lines: detectSpokenLines(prose) } }]
  process.env.MEDIA_ENABLED = 'true'; process.env.MEDIA_VOICE_ENABLED = 'true'; process.env.MEDIA_DAILY_VOICE = '2'
  let calls = 0
  attributionEffects.call = async () => { calls++; await Bun.sleep(5); return JSON.stringify({ lines: [{ line_id: 'l0', is_speech: true, speaker_name: 'Alias', spoken_text: 'Come with me.', tags: [] }] }) }
  mediaEffects.cast = async () => ({ model: 'elevenlabs/eleven-v4-turbo', voice_id: 'george' })
  mediaEffects.enqueue = async () => {}
  mediaEffects.publish = async () => {}
  mediaEffects.cost = async () => undefined
  // Visual-media effects reset to loud stubs: a check that forgets to stub a
  // paid-shaped call fails instead of reaching the network.
  const unstubbed = (name: string) => { throw new Error(`unstubbed visual effect: ${name}`) }
  visualEffects.image = async () => unstubbed('image')
  visualEffects.submit = async () => unstubbed('submit')
  visualEffects.wait = async () => unstubbed('wait')
  visualEffects.fetch = async () => unstubbed('fetch')
  visualEffects.fill = async () => unstubbed('fill')
  visualEffects.upload = async () => unstubbed('upload')
  visualEffects.download = async () => unstubbed('download')
  visualEffects.enqueue = async () => undefined as never
  safetyEffects.call = async () => unstubbed('call')
  safetyEffects.judge = async () => unstubbed('judge')
  directorEffects.call = async () => unstubbed('director')
  return { db, player, instance, event, template, character, card, prose, revision, calls: () => calls }
}
