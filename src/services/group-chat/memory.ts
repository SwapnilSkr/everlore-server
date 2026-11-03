import { ObjectId } from 'mongodb'
import { randomUUID } from 'node:crypto'
import { getRedisClient } from '../../config/redis'
import { mongoColl } from '../../config/mongo'
import type { WorldEventDoc } from '../../models/world-event.model'
import type { MemoryDoc } from '../../models/memory.model'
import type { GroupMember, NamedLine } from './types'

export const GROUP_MEMORY_CADENCE = 5
export const GROUP_SUMMARY_CADENCE = 12
export const GROUP_MEMORY_BATCH_LIMIT = 27 // 25 new events plus the two-event overlap.
export const GROUP_MEMORY_TEXT_BUDGET = 12_000
export const GROUP_ADULT_MEMORY_LINES = 4
export const GROUP_ADULT_SCENE_LINES = 6
export const GROUP_ADULT_DIRECT_LINES = 6
const GROUP_RAISED_WORD_MAX_ATOMS = 3
export type GroupWatermark = 'curated_through_sequence' | 'summarized_through_sequence'
export interface GroupMemoryMessage extends NamedLine { number: number; eventId: ObjectId; adult: boolean }
export interface GroupMemoryBatch { player: string; messages: GroupMemoryMessage[]; events: WorldEventDoc[]; through: number; thread?: string }

/** Undefined is the group thread; malformed stored audiences fail closed. */
export function validGroupThread(thread: unknown): thread is string | undefined {
  return thread === undefined || (typeof thread === 'string' && ObjectId.isValid(thread))
}

export function groupThreadFilter(thread?: string) {
  if (!validGroupThread(thread)) throw new Error('Invalid group thread')
  return { 'data.dm_with': thread ?? { $exists: false } }
}

export function deriveGroupAudience(events: WorldEventDoc[]): { valid: boolean; privateTo?: string } {
  if (!events.length || events.some(event => !validGroupThread(event.data.dm_with))) return { valid: false }
  const direct = new Set(events.flatMap(event => event.data.dm_with === undefined ? [] : [event.data.dm_with]))
  if (direct.size > 1) return { valid: false }
  const privateTo = [...direct][0]
  return { valid: true, ...(privateTo === undefined ? {} : { privateTo }) }
}

export function groupMessages(events: WorldEventDoc[], player: string, members: GroupMember[], thread?: string): NamedLine[] {
  return events.filter(event => validGroupThread(thread) && event.data.dm_with === thread).flatMap(event => [
    ...(event.data.player_input ? [{ name: player, text: event.data.player_input }] : []),
    ...(event.data.lines || []).flatMap(line => {
      const member = members.find(member => member.id === line.character_id)
      return member ? [{ name: member.name, text: line.text }] : []
    }),
  ])
}

function groupWatermarkPath(watermark: GroupWatermark, thread?: string) {
  if (!validGroupThread(thread)) throw new Error('Invalid group thread')
  return thread === undefined ? watermark : `direct_threads.${thread}.${watermark}`
}

/** Jobs carry an immutable triggering event, never a transcript that could outlive reset. */
export async function loadGroupBatch(instanceId: ObjectId, eventId: ObjectId, watermark: GroupWatermark) {
  const instance = await mongoColl.worldInstances().findOne({ _id: instanceId })
  const trigger = await mongoColl.events().findOne({ _id: eventId, instance_id: instanceId })
  if (!instance?.group_state || !instance.group_context || !trigger || !validGroupThread(trigger.data.dm_with)) return null
  const thread = trigger.data.dm_with
  const through = (thread === undefined ? instance.group_state[watermark] : instance.group_state.direct_threads?.[thread]?.[watermark]) ?? 1
  const memory = watermark === 'curated_through_sequence'
  const filter = { instance_id: instanceId, ...groupThreadFilter(thread), 'data.model_used': { $ne: 'seed' } }
  const overlap = memory ? await mongoColl.events().find({ ...filter, sequence: { $gte: 2, $lte: through } })
    .sort({ sequence: -1 }).limit(2).toArray() : []
  const fresh = await mongoColl.events().find({ ...filter, sequence: { $gt: through, $lte: trigger.sequence } })
    .sort({ sequence: 1 }).limit(memory ? GROUP_MEMORY_BATCH_LIMIT - overlap.length : GROUP_SUMMARY_CADENCE).toArray()
  if (fresh.length < (memory ? GROUP_MEMORY_CADENCE : GROUP_SUMMARY_CADENCE)) return null
  const events = [...overlap.reverse(), ...fresh]
  return { instance, events, through: events.at(-1)!.sequence, ...(thread === undefined ? {} : { thread }) }
}

export async function groupEventsLive(events: WorldEventDoc[]): Promise<boolean> {
  return events.length > 0 && await mongoColl.events().countDocuments({
    instance_id: events[0].instance_id, _id: { $in: events.map(event => event._id) },
  }) === events.length
}

export async function advanceGroupWatermark(events: WorldEventDoc[], watermark: GroupWatermark) {
  if (!await groupEventsLive(events)) throw new Error('Group memory source events changed')
  const audience = deriveGroupAudience(events)
  if (!audience.valid || events.some(event => event.data.dm_with !== events[0].data.dm_with)) throw new Error('Mixed group memory batch')
  const path = groupWatermarkPath(watermark, events[0].data.dm_with)
  const instanceId = events[0].instance_id, through = events.at(-1)!.sequence
  // Patch snapshots from the coverage boundary onward so rewind restores coverage,
  // even when the background job completed several turns after that boundary.
  await mongoColl.events().updateMany({ instance_id: instanceId, sequence: { $gte: through } }, {
    $max: { [`data.group_state_after.${path}`]: through },
  })
  await mongoColl.worldInstances().updateOne({ _id: instanceId, group_state: { $exists: true } }, {
    $max: { [`group_state.${path}`]: through },
  })
}

/** Facts the player's line itself brings up, ranked by how rare the shared words are.
 * A structural test: a word most facts share says nothing about which one was raised. */
export function raisedMemories<T extends Pick<MemoryDoc, 'text' | 'importance' | 'search_terms'>>(line: string, atoms: T[], people: string[]): T[] {
  const words = (text: string) => new Set<string>(text.toLowerCase().match(/\p{L}{3,}/gu) || [])
  // Short everyday words ("what", "that") matched unrelated facts live; a short word
  // only counts when the fact capitalizes it mid-sentence, as a name.
  const named = (text: string) => new Set<string>((text.match(/(?<=\s)\p{Lu}\p{L}{2,}/gu) || []).map(name => name.toLowerCase()))
  const ignored = new Set(people.flatMap(name => [...words(name)]))
  const said = [...words(line)].filter(word => !ignored.has(word))
  const held = atoms.map(atom => ({ atom, words: words(`${atom.text} ${atom.search_terms || ''}`), named: named(atom.text) }))
  const count = new Map(said.map(word => [word, held.filter(row => row.words.has(word)).length]))
  return held.map(row => ({ atom: row.atom, score: said.reduce((sum, word) =>
    sum + (row.words.has(word) && (word.length >= 6 || row.named.has(word)) && count.get(word)! <= GROUP_RAISED_WORD_MAX_ATOMS ? 1 / count.get(word)! : 0), 0) }))
    .filter(row => row.score > 0)
    .sort((a, b) => b.score - a.score || (b.atom.importance ?? 0) - (a.atom.importance ?? 0))
    .map(row => row.atom)
}

/** Stored labels AND live provenance must agree. Unlabelled direct-sourced legacy
 * rows cannot become shared facts through retrieval or the curator's open threads. */
export async function allowedGroupMemories<T extends Pick<MemoryDoc, 'source_event_ids' | 'private_to' | 'is_nsfw'>>(
  instanceId: ObjectId, candidates: T[], thread?: string, enabled = true, exactAudience = false,
): Promise<T[]> {
  if (!validGroupThread(thread)) return []
  const sourceIds = [...new Map(candidates.flatMap(memory => memory.source_event_ids || []).map(id => [String(id), id])).values()]
  const sources = sourceIds.length ? await mongoColl.events().find({ instance_id: instanceId, _id: { $in: sourceIds } }).toArray() : []
  const sourceById = new Map(sources.map(event => [String(event._id), event]))
  return candidates.filter(memory => {
    const cited = (memory.source_event_ids || []).flatMap(id => sourceById.has(String(id)) ? [sourceById.get(String(id))!] : [])
    if (!cited.length || cited.length !== memory.source_event_ids.length) return false
    const audience = deriveGroupAudience(cited)
    return audience.valid && validGroupThread(memory.private_to) && memory.private_to === audience.privateTo &&
      (exactAudience ? memory.private_to === thread : memory.private_to === undefined || memory.private_to === thread) &&
      (enabled || (!memory.is_nsfw && cited.every(event => event.type !== 'intimate')))
  })
}

/** Global sequence gaps between this thread's events belong to other audiences.
 * The stored row owns the audience; retrieval metadata never grants access. */
export async function groupSummarySources(instanceId: ObjectId, start: number, end: number, thread?: string) {
  if (!validGroupThread(thread) || !Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start) return []
  const events = await mongoColl.events().find({ instance_id: instanceId, ...groupThreadFilter(thread),
    sequence: { $gte: start, $lte: end } }).sort({ sequence: 1 }).toArray()
  return events[0]?.sequence === start && events.at(-1)?.sequence === end ? events : []
}

export async function groupWriterSummaries(instanceId: ObjectId, candidates: Array<{ text: string; startSequence: number; endSequence: number }>, thread?: string) {
  if (!validGroupThread(thread)) return []
  const allowed: string[] = []
  for (const summary of candidates) {
    const filter = { instance_id: instanceId, status: { $ne: 'stale' as const }, summary_text: summary.text,
      'event_range.start_sequence': summary.startSequence, 'event_range.end_sequence': summary.endSequence }
    const stored = (await Promise.all([mongoColl.sceneSummaries().find(filter).toArray(),
      mongoColl.chapterSummaries().find(filter).toArray(), mongoColl.arcSummaries().find(filter).toArray()])).flat()
    if (!stored.length || stored.some(row => !validGroupThread(row.private_to) ||
      !(row.private_to === undefined || row.private_to === thread))) continue
    const audiences = new Set(stored.map(row => row.private_to))
    if (audiences.size !== 1) continue
    const events = await groupSummarySources(instanceId, summary.startSequence, summary.endSequence, stored[0].private_to)
    if (events.length) allowed.push(summary.text)
  }
  return allowed
}

/** A plain question about a stored everyday fact, tested the way an adult prompt finds facts. */
export async function groupLineRaisesFact(input: { instanceId: ObjectId; player: string; speakers: string[]; thread?: string; line: string }) {
  const people = ['player', input.player, ...input.speakers]
  const candidates = await mongoColl.memories().find({ instance_id: input.instanceId, is_archived: false,
    $or: [{ subjects: { $in: people } }, { objects: { $in: people } }],
  }).sort({ updated_at: -1 }).limit(200).toArray()
  const allowed = await allowedGroupMemories(input.instanceId, candidates, input.thread, true)
  return raisedMemories(input.line, allowed.filter(memory => memory.explicit_fact !== true), people).length > 0
}

/** RAG is shared with story worlds; group calls verify every returned atom against Mongo. */
export async function groupWriterMemory(input: {
  instanceId: ObjectId; player: string; speakers: string[]; enabled: boolean; thread?: string
  memories: string[]; openThreads: string[]; raisedBy?: string
  /** Their messages are still in the prompt, so facts from them would only be said twice. */
  recentEvents?: ObjectId[]
}) {
  const names = [['player', input.player], ...[...new Set(input.speakers)].map(name => [name])]
  const people = names.flat()
  const [pins, retrieved, concerning] = await Promise.all([
    Promise.all(names.map(aliases => mongoColl.memories().find({ instance_id: input.instanceId, is_archived: false,
      ...(input.enabled ? {} : { is_nsfw: { $ne: true } }),
      $or: [{ subjects: { $in: aliases } }, { objects: { $in: aliases } }],
    }).sort({ importance: -1, updated_at: -1 }).limit(20).toArray())),
    mongoColl.memories().find({ instance_id: input.instanceId, is_archived: false,
      text: { $in: [...input.memories, ...input.openThreads] },
    }).toArray(),
    input.raisedBy === undefined ? [] : mongoColl.memories().find({ instance_id: input.instanceId, is_archived: false,
      $or: [{ subjects: { $in: people } }, { objects: { $in: people } }],
    }).sort({ updated_at: -1 }).limit(200).toArray(),
  ])
  const candidates = [...pins.flat(), ...retrieved, ...concerning]
  const eligible = new Set(await allowedGroupMemories(input.instanceId, candidates, input.thread, input.enabled))
  const allowed = (memory: MemoryDoc) => eligible.has(memory)
  const seen = new Set<string>(), memories: string[] = [], openThreads: string[] = []
  let chars = 0
  const add = (memory: MemoryDoc, thread = false) => {
    const key = memory.text.replace(/\s+/g, ' ').trim().toLowerCase()
    if (!allowed(memory) || seen.has(key) || chars + memory.text.length + 1 > GROUP_MEMORY_TEXT_BUDGET) return
    seen.add(key); chars += memory.text.length + 1
    if (thread) openThreads.push(memory.text)
    else memories.push(memory.text)
  }
  if (input.raisedBy !== undefined) {
    // Proven live: even eight everyday lines dull the adult writer, which fixes on
    // them. It sees only what this line raises; people who aren't in the scene keep
    // full memory, and threads lose their heading because they're just facts here.
    for (const memory of raisedMemories(input.raisedBy, concerning.filter(allowed), people)) {
      if (memories.length < GROUP_ADULT_MEMORY_LINES) add(memory)
    }
    // Proven live: told where a cousin lives, she denied knowing, because the line asking
    // shared no rare word with the fact. What the player told her in this thread comes
    // along whatever the wording; her own everyday lines stay out, as below.
    if (input.thread !== undefined) {
      const told = (memory: MemoryDoc) => memory.private_to === input.thread && memory.explicit_fact !== true &&
        (memory.subjects || []).some(name => names[0].includes(name))
      const limit = memories.length + GROUP_ADULT_DIRECT_LINES
      for (const memory of concerning.filter(allowed).filter(told).sort((a, b) => (b.importance ?? 0) - (a.importance ?? 0))) {
        if (memories.length < limit) add(memory)
      }
    }
    // The character in the scene must remember it too, once it has left the recent
    // messages. Proven live: everything said on an adult turn feeds her own dodges
    // back ("about to walk out the door to a quiz"), so only explicit facts come along.
    const recent = new Set((input.recentEvents || []).map(String))
    const inScene = (memory: MemoryDoc) => memory.explicit_fact === true && !(memory.source_event_ids || []).every(id => recent.has(String(id))) && input.speakers.some(name =>
      [...(memory.subjects || []), ...(memory.objects || [])].includes(name) || memory.text.includes(name))
    const limit = memories.length + GROUP_ADULT_SCENE_LINES
    // What she herself said or wants comes first, then the most important.
    const hers = (memory: MemoryDoc) => (memory.subjects || []).some(name => input.speakers.includes(name)) ? 1 : 0
    for (const memory of concerning.filter(allowed).filter(inScene).sort((a, b) => hers(b) - hers(a) || (b.importance ?? 0) - (a.importance ?? 0))) {
      if (memories.length < limit) add(memory)
    }
    return { memories, openThreads }
  }
  // Pins have first claim on the shared budget; five per person after safety filtering.
  for (const person of pins) for (const memory of person.filter(allowed).slice(0, 5)) add(memory, memory.unresolved_thread === true)
  for (const text of input.openThreads) for (const memory of retrieved.filter(memory => memory.text === text)) add(memory, true)
  for (const text of input.memories) for (const memory of retrieved.filter(memory => memory.text === text)) add(memory)
  return { memories, openThreads }
}

/** Different cadence jobs for one projection must not curate the same watermark concurrently. */
export async function withGroupMemoryLease<T>(instanceId: string, kind: string, work: () => Promise<T>): Promise<T> {
  const redis = getRedisClient(), key = `group:projection:${kind}:${instanceId}`, token = randomUUID()
  if (await redis.set(key, token, 'PX', 300_000, 'NX') !== 'OK') throw new Error('Group memory batch already running')
  try { return await work() } finally {
    await redis.eval("if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end", 1, key, token)
  }
}

/** Similar wording cannot merge distinct people's facts or change rewind provenance. */
export function groupMemoryMayMerge(left: Pick<MemoryDoc, 'subjects' | 'objects' | 'source_event_ids' | 'private_to'>,
  right: Pick<MemoryDoc, 'subjects' | 'objects' | 'source_event_ids' | 'private_to'>): boolean {
  const key = (values: Array<string | ObjectId>) => [...new Set(values.map(value => String(value).replace(/\s+/g, ' ').trim().toLowerCase()))].sort().join('\n')
  return left.private_to === right.private_to && left.source_event_ids.length > 0 && key(left.source_event_ids) === key(right.source_event_ids) &&
    key(left.subjects || []) === key(right.subjects || []) && key(left.objects || []) === key(right.objects || [])
}
