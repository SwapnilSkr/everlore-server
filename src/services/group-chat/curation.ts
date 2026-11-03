import { mongoColl } from '../../config/mongo'
import type { MemoryDoc } from '../../models/memory.model'
import { allowedGroupMemories, deriveGroupAudience, type GroupMemoryBatch } from './memory'
import { contentWords } from './lines'
import type { ObjectId } from 'mongodb'

const strings = { type: 'array', items: { type: 'string' } }
const nullableText = { type: ['string', 'null'] }

const atomProperties = {
  text: { type: 'string' },
  type: { type: 'string', enum: ['relationship', 'promise', 'lore', 'observation', 'emotion', 'secret'] },
  importance: { type: 'integer', minimum: 1, maximum: 5 },
  is_nsfw: { type: 'boolean' },
  subjects: strings,
  objects: strings,
  emotional_valence: nullableText,
  emotional_cause: nullableText,
  emotional_effect: nullableText,
  relationship_delta: nullableText,
  unresolved_thread: { type: 'boolean' },
  retrieval_terms: strings,
  source_messages: { type: 'array', minItems: 1, items: { type: 'integer', minimum: 1 } },
}

// Strict structured output requires every property and forbids additional keys at every object level.
export const GROUP_CURATION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['memories', 'entities', 'closed_threads'],
  properties: {
    memories: {
      type: 'array',
      items: { type: 'object', additionalProperties: false, required: Object.keys(atomProperties), properties: atomProperties },
    },
    entities: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['name', 'kind'],
        properties: {
          name: { type: 'string' },
          kind: { type: 'string', enum: ['character', 'location', 'faction', 'item', 'quest', 'other'] },
        },
      },
    },
    closed_threads: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['thread_id', 'source_messages'],
        properties: { thread_id: { type: 'string' }, source_messages: atomProperties.source_messages },
      },
    },
  },
}

export const normalizeGroupMemoryText = (text: string) => text.replace(/\s+/g, ' ').trim().toLowerCase()

export const groupMemoryTextKey = (text: string, privateTo?: string) => JSON.stringify([privateTo ?? '', normalizeGroupMemoryText(text)])

/** Proven live: on adult turns the writer makes things up in passing ("nobody else knows"),
 * and stored as facts those fed later prompts. What it says about sex stays memory, as does
 * everything the player says; its everyday claims on those turns aren't facts. */
export function dropAdultWriterClaims<T extends { is_nsfw?: unknown; source_messages: number[] }>(group: Pick<GroupMemoryBatch, 'player' | 'messages'>, atoms: T[]) {
  const claim = (atom: T) => atom.is_nsfw !== true && atom.source_messages.every(number => {
    const message = group.messages[number - 1]
    return message.adult && message.name !== group.player
  })
  return { memories: atoms.filter(atom => !claim(atom)), adultClaims: atoms.filter(claim).length }
}

// Over five saved runs this fired only on the one wrong fact; true facts stayed below it.
const REFILED_SHARE = 0.5

/** Proven live: the player's "my cousin" was stored as the character's cousin, so asked
 * later she denied knowing, and a rule in the curator's prompt didn't hold. A fact about a character that's
 * worded from the player's line, more than from that character's own, is kept in the
 * player's own words: what was said can't name the wrong person. */
export function refileSpokenFacts<T extends { text: string; is_nsfw?: unknown; subjects: string[]; objects: string[]; source_messages: number[] }>(group: Pick<GroupMemoryBatch, 'player' | 'messages'>, atoms: T[]) {
  const player = group.player.toLowerCase()
  const seen = new Set<string>()
  let refiled = 0
  const memories = atoms.flatMap(atom => {
    const people = new Set(atom.subjects.map(name => name.toLowerCase()))
    const about = group.messages.filter(message => message.name.toLowerCase() !== player && people.has(message.name.toLowerCase()))
    if (people.has(player) || people.has('player') || !about.length) return [atom]
    const events = new Set(atom.source_messages.map(number => String(group.messages[number - 1].eventId)))
    const same = group.messages.filter(message => events.has(String(message.eventId)))
    const names = new Set([...people].flatMap(name => [...contentWords(name)]))
    const words = [...contentWords(atom.text)].filter(word => !names.has(word))
    const share = (text: string) => { const held = contentWords(text); return words.length ? words.filter(word => held.has(word)).length / words.length : 0 }
    const best = (lines: typeof same) => Math.max(0, ...lines.map(line => share(line.text)))
    const spoken = same.filter(message => message.name.toLowerCase() === player).sort((a, b) => share(b.text) - share(a.text))[0]
    if (!spoken || share(spoken.text) < REFILED_SHARE || share(spoken.text) <= best(same.filter(message => people.has(message.name.toLowerCase())))) return [atom]
    refiled++
    const text = `${group.player} said: ${spoken.text}`.slice(0, 600)
    if (seen.has(text)) return []
    seen.add(text)
    return [{ ...atom, text, is_nsfw: spoken.adult, subjects: ['player'], objects: atom.subjects, source_messages: [spoken.number] }]
  })
  return { memories, refiled }
}

/** Words that can't be recovered once lost: a digit in them, or typed in capitals. A
 * bare "5" is too common in passing to count on its own. */
const exactDetails = (text: string) => (text.match(/[\p{L}\p{N}][\p{L}\p{N}'-]*/gu) || [])
  .filter(word => word.length >= 3 && (/\p{N}/u.test(word) || word === word.toUpperCase()))

/** Proven live: told a locker code, the curator kept the firing and lost the code, and
 * the character then guessed one. A player line whose exact detail no fact holds is kept
 * in the player's own words, with the same citation and audience rules as any atom. */
export function missedDetailAtoms(group: Pick<GroupMemoryBatch, 'player' | 'messages'>, atoms: Array<{ text: string }>, stored: string[]) {
  const held = [...atoms.map(atom => atom.text), ...stored].join('\n').toLowerCase()
  return group.messages.filter(message => message.name === group.player &&
    exactDetails(message.text).some(word => !held.includes(word.toLowerCase()))).map(message => ({
    text: `${group.player} said: ${message.text}`.slice(0, 600), type: 'observation', importance: 3, is_nsfw: message.adult,
    subjects: ['player'], objects: [], unresolved_thread: false, retrieval_terms: [], source_messages: [message.number],
  }))
}

/** Citation shape is checked first; this pass rejects facts spanning direct audiences. */
export function filterGroupAtomAudiences<T extends { source_messages: number[] }>(group: GroupMemoryBatch, atoms: T[]) {
  let invalidAudiences = 0
  const memories = atoms.filter(atom => {
    const cited = atom.source_messages.flatMap(number => {
      const message = group.messages[number - 1]
      const event = message && group.events.find(event => event._id.equals(message.eventId))
      return event ? [event] : []
    })
    if (cited.length !== atom.source_messages.length || !deriveGroupAudience(cited).valid) { invalidAudiences++; return false }
    return true
  })
  return { memories, invalidAudiences }
}

/** Event order, rather than message order, also rejects same-event replies and batch overlap. */
export async function closeGroupThreads(input: {
  instanceId: ObjectId
  group: GroupMemoryBatch
  threads: Array<Pick<MemoryDoc, '_id' | 'source_event_ids' | 'private_to' | 'is_nsfw'>>
  closures: unknown
}): Promise<{ closuresAccepted: number; closuresRejected: number }> {
  let closuresAccepted = 0, closuresRejected = 0
  const sources = [...new Map(input.threads.flatMap(thread => thread.source_event_ids || []).map(id => [String(id), id])).values()]
  const events = sources.length ? await mongoColl.events().find({ instance_id: input.instanceId, _id: { $in: sources } },
    { projection: { sequence: 1 } }).toArray() : []
  const sequence = new Map(events.map(event => [String(event._id), event.sequence]))
  const eligible = new Set(await allowedGroupMemories(input.instanceId, input.threads, input.group.thread, true, true))
  const accepted = new Set<string>()
  for (const raw of Array.isArray(input.closures) ? input.closures : input.closures == null ? [] : [input.closures]) {
    const closure = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
    const thread = input.threads.find((_, index) => closure.thread_id === `T${index + 1}`)
    const citations = closure.source_messages
    if (!thread || !eligible.has(thread) || accepted.has(String(thread._id)) || !thread.source_event_ids?.length ||
      thread.source_event_ids.some(id => !Number.isFinite(sequence.get(String(id)))) ||
      !Array.isArray(citations) || !citations.length || citations.some(number => {
        if (!Number.isInteger(number) || number < 1 || number > input.group.messages.length) return true
        const event = input.group.events.find(event => event._id.equals(input.group.messages[number - 1].eventId))
        return !event || event.data.dm_with !== input.group.thread || thread.source_event_ids.some(id => event.sequence <= sequence.get(String(id))!)
      })) { closuresRejected++; continue }
    const result = await mongoColl.memories().updateOne({ _id: thread._id, instance_id: input.instanceId,
      is_archived: false, unresolved_thread: true }, { $set: { unresolved_thread: false, resolved_at: new Date(), updated_at: new Date() } })
    if (result.modifiedCount) { closuresAccepted++; accepted.add(String(thread._id)) }
    else closuresRejected++
  }
  return { closuresAccepted, closuresRejected }
}
