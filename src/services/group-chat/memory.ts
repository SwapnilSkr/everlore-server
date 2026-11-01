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
export type GroupWatermark = 'curated_through_sequence' | 'summarized_through_sequence'
export interface GroupMemoryMessage extends NamedLine { number: number; eventId: ObjectId; adult: boolean }
export interface GroupMemoryBatch { player: string; messages: GroupMemoryMessage[]; events: WorldEventDoc[]; through: number }

export function groupMessages(events: WorldEventDoc[], player: string, members: GroupMember[]): NamedLine[] {
  return events.flatMap(event => [
    ...(event.data.player_input ? [{ name: player, text: event.data.player_input }] : []),
    ...(event.data.lines || []).flatMap(line => {
      const member = members.find(member => member.id === line.character_id)
      return member ? [{ name: member.name, text: line.text }] : []
    }),
  ])
}

/** Jobs carry an immutable triggering event, never a transcript that could outlive reset. */
export async function loadGroupBatch(instanceId: ObjectId, eventId: ObjectId, watermark: GroupWatermark) {
  const instance = await mongoColl.worldInstances().findOne({ _id: instanceId })
  const trigger = await mongoColl.events().findOne({ _id: eventId, instance_id: instanceId })
  if (!instance?.group_state || !instance.group_context || !trigger) return null
  const through = instance.group_state[watermark] ?? 1 // sequence 1 is the authored opening.
  const memory = watermark === 'curated_through_sequence'
  if (trigger.sequence - through < (memory ? GROUP_MEMORY_CADENCE : GROUP_SUMMARY_CADENCE)) return null
  const events = await mongoColl.events().find({ instance_id: instanceId,
    sequence: { $gte: memory ? Math.max(2, through - 1) : through + 1, $lte: trigger.sequence },
    'data.model_used': { $ne: 'seed' },
  }).sort({ sequence: 1 }).limit(memory ? GROUP_MEMORY_BATCH_LIMIT : GROUP_SUMMARY_CADENCE).toArray()
  if (!events.length || (!memory && events.length !== GROUP_SUMMARY_CADENCE)) return null
  return { instance, events, through: events.at(-1)!.sequence }
}

export async function groupEventsLive(events: WorldEventDoc[]): Promise<boolean> {
  return events.length > 0 && await mongoColl.events().countDocuments({
    instance_id: events[0].instance_id, _id: { $in: events.map(event => event._id) },
  }) === events.length
}

export async function advanceGroupWatermark(events: WorldEventDoc[], watermark: GroupWatermark) {
  if (!await groupEventsLive(events)) throw new Error('Group memory source events changed')
  const instanceId = events[0].instance_id, through = events.at(-1)!.sequence
  // Patch snapshots from the coverage boundary onward so rewind restores coverage,
  // even when the background job completed several turns after that boundary.
  await mongoColl.events().updateMany({ instance_id: instanceId, sequence: { $gte: through } }, {
    $max: { [`data.group_state_after.${watermark}`]: through },
  })
  await mongoColl.worldInstances().updateOne({ _id: instanceId, group_state: { $exists: true } }, {
    $max: { [`group_state.${watermark}`]: through },
  })
}

/** RAG is shared with story worlds; group calls verify every returned atom against
 * Mongo, including provenance, before it enters a prompt. Unknown rows fail closed. */
export async function groupWriterMemory(input: {
  instanceId: ObjectId; player: string; speakers: string[]; enabled: boolean
  memories: string[]; openThreads: string[]
}) {
  const names = [['player', input.player], ...[...new Set(input.speakers)].map(name => [name])]
  const [pins, retrieved] = await Promise.all([
    Promise.all(names.map(aliases => mongoColl.memories().find({ instance_id: input.instanceId, is_archived: false,
      ...(input.enabled ? {} : { is_nsfw: { $ne: true } }),
      $or: [{ subjects: { $in: aliases } }, { objects: { $in: aliases } }],
    }).sort({ importance: -1, updated_at: -1 }).limit(20).toArray())),
    mongoColl.memories().find({ instance_id: input.instanceId, is_archived: false,
      text: { $in: [...input.memories, ...input.openThreads] },
    }).toArray(),
  ])
  const candidates = [...pins.flat(), ...retrieved]
  const sourceIds = [...new Map(candidates.flatMap(memory => memory.source_event_ids).map(id => [String(id), id])).values()]
  const sources = sourceIds.length ? await mongoColl.events().find({ instance_id: input.instanceId, _id: { $in: sourceIds } }).toArray() : []
  const sourceById = new Map(sources.map(event => [String(event._id), event]))
  const allowed = (memory: MemoryDoc) => memory.source_event_ids.length > 0 &&
    memory.source_event_ids.every(id => sourceById.has(String(id))) &&
    (input.enabled || (!memory.is_nsfw && memory.source_event_ids.every(id => sourceById.get(String(id))!.type !== 'intimate')))
  const seen = new Set<string>(), memories: string[] = [], openThreads: string[] = []
  let chars = 0
  const add = (memory: MemoryDoc, thread = false) => {
    const key = memory.text.replace(/\s+/g, ' ').trim().toLowerCase()
    if (!allowed(memory) || seen.has(key) || chars + memory.text.length + 1 > GROUP_MEMORY_TEXT_BUDGET) return
    seen.add(key); chars += memory.text.length + 1
    if (thread) openThreads.push(memory.text)
    else memories.push(memory.text)
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
export function groupMemoryMayMerge(left: Pick<MemoryDoc, 'subjects' | 'objects' | 'source_event_ids'>,
  right: Pick<MemoryDoc, 'subjects' | 'objects' | 'source_event_ids'>): boolean {
  const key = (values: Array<string | ObjectId>) => [...new Set(values.map(value => String(value).replace(/\s+/g, ' ').trim().toLowerCase()))].sort().join('\n')
  return left.source_event_ids.length > 0 && key(left.source_event_ids) === key(right.source_event_ids) &&
    key(left.subjects || []) === key(right.subjects || []) && key(left.objects || []) === key(right.objects || [])
}
