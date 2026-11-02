import { ObjectId } from 'mongodb'
import { mongoColl } from '../../config/mongo'
import type { WorldInstanceDoc } from '../../models/world-instance.model'
import { HttpError } from '../../utils/http-error'
import { parseObjectId } from '../../utils/mongo-id'
import { loadGroupMembers } from './instance'

/** All entry points validate against this save's cast, never the global cast. */
export async function resolveGroupThread(instance: WorldInstanceDoc, value: unknown): Promise<string | undefined> {
  if (value === undefined) return undefined
  if (!instance.group_state || typeof value !== 'string' || !ObjectId.isValid(value)) {
    throw new HttpError(400, 'That person is not in this chat.')
  }
  const thread = new ObjectId(value).toHexString()
  if (!(await loadGroupMembers(instance)).some(member => member.id === thread)) {
    throw new HttpError(400, 'That person is not in this chat.')
  }
  return thread
}

export async function listGroupThreads(instanceId: string, playerId: string) {
  const instance = await mongoColl.worldInstances().findOne({ _id: parseObjectId(instanceId), player_id: parseObjectId(playerId) })
  if (!instance?.group_state) throw new HttpError(404, 'That chat could not be found.')
  const members = await loadGroupMembers(instance)
  const events = await mongoColl.events().find({ instance_id: instance._id, player_id: instance.player_id,
    'data.dm_with': { $in: members.map(member => member.id) } }).sort({ sequence: 1 }).toArray()
  const threads = new Map<string, { memberId: string; lastLine: string; lastAt: Date; messageCount: number }>()
  for (const event of events) {
    const memberId = event.data.dm_with!
    const lines = event.data.lines || []
    const last = lines.at(-1)
    threads.set(memberId, { memberId, lastLine: last?.text || event.data.player_input,
      lastAt: last?.shown_at || event.created_at,
      messageCount: (threads.get(memberId)?.messageCount || 0) + lines.length + (event.data.player_input ? 1 : 0) })
  }
  return [...threads.values()]
}
