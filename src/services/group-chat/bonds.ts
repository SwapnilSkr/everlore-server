import { groupPlayerLine, groupLineText, GROUP_ACTION_RULE } from './actions'
import { ObjectId } from 'mongodb'
import { mongoColl } from '../../config/mongo'
import { relationshipBaseline } from '../../utils/relationship-baseline'
import { HttpError } from '../../utils/http-error'
import { log } from '../../utils/logger'
import type { RelationshipMeters } from '../../models/character-profile.model'
import type { GroupBondChangeDoc } from '../../models/group-bond-change.model'
import type { WorldInstanceDoc } from '../../models/world-instance.model'
import { groupEventsLive, withGroupMemoryLease, type GroupMemoryBatch } from './memory'
import { loadGroupMembers } from './instance'
import type { GroupMember } from './types'

const meters = ['trust', 'affection', 'fear', 'rivalry'] as const
const bondStore = () => mongoColl.groupBondChanges()

/** All inserts and folds share a lease, including sets outside the story. */
async function bondWrite<T>(instance: WorldInstanceDoc, work: () => Promise<T>) {
  return withGroupMemoryLease(String(instance._id), 'bonds', work)
}

/** The sole group relationship writer: sets override only the meters named. */
async function foldGroupBonds(instance: WorldInstanceDoc) {
  const rows = await bondStore().find({ instance_id: instance._id }).sort({ created_at: 1, _id: 1 }).toArray()
  for (const member of await loadGroupMembers(instance)) {
    let value = relationshipBaseline(member.group.start_bond)
    for (const row of rows.filter(row => String(row.character_id) === member.id)) {
      for (const meter of meters) {
        if (row.reason === 'player_set' && row.set?.[meter] !== undefined) value[meter] = row.set[meter]!
        if (row.reason === 'chat' && row.deltas?.[meter] !== undefined) {
          const delta = Math.max(-10, Math.min(10, Math.round(row.deltas[meter]!)))
          value[meter] = Math.max(0, Math.min(100, value[meter] + delta))
        }
      }
    }
    await mongoColl.characters().updateOne({ _id: new ObjectId(member.id), instance_id: instance._id }, { $set: { relationship: value } })
  }
}

export async function seedGroupBonds(instance: WorldInstanceDoc) {
  await bondWrite(instance, () => foldGroupBonds(instance))
}

// The lease makes these dates strictly increasing even when two writes share a millisecond.
async function insertionTime(instance: WorldInstanceDoc): Promise<Date> {
  const last = await bondStore().findOne({ instance_id: instance._id }, { sort: { created_at: -1 } })
  return new Date(Math.max(Date.now(), last ? +last.created_at + 1 : 0))
}

export function buildGroupBondRequest(group: GroupMemoryBatch, members: GroupMember[], model: string) {
  return {
    purpose: 'group_bonds', model, temperature: 0, maxTokens: 1200,
    responseFormat: { type: 'json_schema', json_schema: { name: 'group_bonds', strict: true } },
    responseSchema: {
      type: 'object', additionalProperties: false, required: ['changes'], properties: { changes: {
        type: 'array', items: { type: 'object', additionalProperties: false,
          required: ['name', 'meter', 'delta', 'evidence', 'line'], properties: {
            name: { type: 'string' }, meter: { type: 'string', enum: meters }, delta: { type: 'integer' },
            evidence: { type: 'string' }, line: { type: 'integer', minimum: 1 },
          } },
      } },
    },
    messages: [
      { role: 'system' as const, content: 'You judge changes in each member’s bond toward the player. Most batches change nothing. Return a change only when feeling toward the player really shifts: a secret shared or kept, a promise, a confession, a betrayal, real hurt, sex. Plans, jokes, banter, flirting in passing, food, where someone is and friendly chat change nothing, however warm they sound. Use trust, affection, fear or rivalry and a delta: usually 1 to 3, 4 to 6 for a strong moment, up to 10 only for something life-changing, negative when it falls. Give an exact quote from one numbered line and its line number. That line must be the player’s or that member’s own words. At most one change per member per meter. Return {"changes":[]} when nothing changed.' },
      { role: 'user' as const, content: `Player: ${group.player}\nMembers: ${members.map(member => member.name).join(', ')}${group.messages.some(line => line.player_action) ? `\n${GROUP_ACTION_RULE}` : ''}\nNumbered lines:\n${group.messages.map(line => `${line.number}. ${JSON.stringify({ speaker: line.name, text: line.player_action ? groupLineText(groupPlayerLine(line.name, line.text, true)) : line.text })}`).join('\n')}` },
    ],
  }
}

/** Source attribution is structural; a real quote from someone else's line cannot move a bond. */
export function acceptedBondChanges(raw: unknown, group: GroupMemoryBatch, members: GroupMember[]) {
  const accepted = new Map<string, { member: GroupMember; deltas: Partial<RelationshipMeters>; evidence: string[]; adult: boolean; sequence: number }>()
  const changes = raw && typeof raw === 'object' && 'changes' in raw ? raw.changes : undefined
  for (const change of Array.isArray(changes) ? changes : []) {
    if (!change || typeof change !== 'object') continue
    const member = members.find(member => member.name === change.name && (group.thread === undefined || group.thread === member.id))
    const line = Number.isInteger(change.line) ? group.messages.find(line => line.number === change.line) : undefined
    if (!member || !meters.includes(change.meter) || !Number.isFinite(change.delta) || !line ||
      typeof change.evidence !== 'string' || !change.evidence.trim() || !line.text.includes(change.evidence) ||
      (line.name !== group.player && line.name !== member.name)) continue
    const event = group.events.find(event => event._id.equals(line.eventId))
    if (!event || event.data.dm_with !== group.thread) continue
    const entry = accepted.get(member.id) ?? { member, deltas: {}, evidence: [], adult: false, sequence: event.sequence }
    const meter = change.meter as keyof RelationshipMeters
    if (entry.deltas[meter] !== undefined) continue
    entry.deltas[meter] = Math.max(-10, Math.min(10, Math.round(change.delta)))
    entry.evidence.push(change.evidence)
    entry.adult ||= line.adult
    entry.sequence = Math.max(entry.sequence, event.sequence)
    accepted.set(member.id, entry)
  }
  return [...accepted.values()]
}

/** This runs after memory persistence. No model failure can undo curation. */
export async function curateGroupBonds(instance: WorldInstanceDoc, group: GroupMemoryBatch, members: GroupMember[]) {
  try {
    const { callLLM, AI_MODELS } = await import('../../ai')
    const response = await callLLM(buildGroupBondRequest(group, members.filter(member => !group.thread || member.id === group.thread), AI_MODELS.memoryCuration))
    if (!response.trim()) { log.info('group.bond_call_empty', { instanceId: String(instance._id) }); return }
    const changes = acceptedBondChanges(JSON.parse(response), group, members)
    if (!changes.length) { log.info('group.bond_call_empty', { instanceId: String(instance._id) }); return }
    await bondWrite(instance, async () => {
      if (!await groupEventsLive(group.events) || !await mongoColl.worldInstances().findOne({ _id: instance._id })) return
      for (const change of changes) {
        const characterId = new ObjectId(change.member.id)
        if (!await mongoColl.characters().findOne({ _id: characterId, instance_id: instance._id })) continue
        const key = { instance_id: instance._id, character_id: characterId, reason: 'chat' as const,
          batch_end_sequence: group.through, thread: group.thread ?? { $exists: false } }
        const row: GroupBondChangeDoc = { _id: new ObjectId(), instance_id: instance._id, player_id: instance.player_id,
          character_id: characterId, reason: 'chat', sequence: change.sequence, batch_end_sequence: group.through,
          ...(group.thread === undefined ? {} : { thread: group.thread }), adult: change.adult,
          deltas: change.deltas, evidence: change.evidence.join('\n'), created_at: await insertionTime(instance) }
        await bondStore().updateOne(key, { $setOnInsert: row }, { upsert: true })
        if (!await groupEventsLive(group.events)) await bondStore().deleteMany({ _id: row._id })
      }
      await foldGroupBonds(instance)
    })
  } catch { log.warn('group.bond_call_failed', { instanceId: String(instance._id) }) }
}

export async function rewindGroupBonds(instance: WorldInstanceDoc, sequence: number) {
  await bondWrite(instance, async () => {
    await bondStore().deleteMany({ instance_id: instance._id, reason: 'chat', batch_end_sequence: { $gte: sequence } })
    await foldGroupBonds(instance)
  })
}

async function ownedGroup(instanceId: string, playerId: string) {
  if (!ObjectId.isValid(instanceId) || !ObjectId.isValid(playerId)) throw new HttpError(404, 'That chat could not be found.')
  const instance = await mongoColl.worldInstances().findOne({ _id: new ObjectId(instanceId), player_id: new ObjectId(playerId) })
  const template = instance && await mongoColl.worldTemplates().findOne({ _id: instance.template_id })
  if (!instance?.group_state || template?.kind !== 'group') throw new HttpError(404, 'That chat could not be found.')
  return instance
}

export async function getGroupBonds(instanceId: string, playerId: string) {
  const instance = await ownedGroup(instanceId, playerId)
  const player = await mongoColl.users().findOne({ _id: instance.player_id })
  return Promise.all((await loadGroupMembers(instance)).map(async member => ({
    characterId: member.id, name: member.name, meters: member.relationship,
    moments: (await bondStore().find({ instance_id: instance._id, character_id: new ObjectId(member.id), reason: 'chat',
      ...(player?.preferences?.nsfw_enabled === true ? {} : { adult: false }) }).sort({ created_at: -1, _id: -1 }).limit(5).toArray())
      .map(row => ({ deltas: row.deltas, evidence: row.evidence, created_at: row.created_at })),
  })))
}

export async function setGroupBonds(instanceId: string, playerId: string, characterId: string, body: unknown) {
  const instance = await ownedGroup(instanceId, playerId)
  const member = (await loadGroupMembers(instance)).find(member => member.id === characterId)
  if (!member) throw new HttpError(400, 'That person is not in this chat.')
  if (!body || typeof body !== 'object' || Array.isArray(body) || !Object.keys(body).length ||
    Object.entries(body).some(([key, value]) => !meters.includes(key as keyof RelationshipMeters) || !Number.isInteger(value) || Number(value) < 0 || Number(value) > 100)) {
    throw new HttpError(400, 'Choose whole numbers from 0 to 100 for the bonds you want to change.')
  }
  try { return await bondWrite(instance, async () => {
    if (!await mongoColl.worldInstances().findOne({ _id: instance._id, player_id: instance.player_id })) throw new HttpError(404, 'That chat could not be found.')
    if (!await mongoColl.characters().findOne({ _id: new ObjectId(member.id), instance_id: instance._id })) throw new HttpError(400, 'That person is not in this chat.')
    const rowId = new ObjectId()
    await bondStore().insertOne({ _id: rowId, instance_id: instance._id, player_id: instance.player_id,
      character_id: new ObjectId(member.id), reason: 'player_set', sequence: instance.meta.total_events,
      batch_end_sequence: instance.meta.total_events, adult: false, set: body as Partial<RelationshipMeters>, evidence: '', created_at: await insertionTime(instance) })
    await foldGroupBonds(instance)
    const current = (await loadGroupMembers(instance)).find(value => value.id === characterId)
    if (!current || !await mongoColl.worldInstances().findOne({ _id: instance._id })) {
      await bondStore().deleteMany({ _id: rowId })
      throw new HttpError(404, 'That chat could not be found.')
    }
    return current.relationship
  }) } catch (error) {
    if (error instanceof HttpError) throw error
    throw new HttpError(409, 'The chat is still settling. Try again in a moment.')
  }
}
