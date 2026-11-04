import { ObjectId } from 'mongodb'
import { mongoColl } from '../../config/mongo'
import type { WorldInstanceDoc } from '../../models/world-instance.model'
import { HttpError } from '../../utils/http-error'
import { parseObjectId } from '../../utils/mongo-id'
import { loadGroupMembers } from './instance'
import { groupLineShown, groupAdultAllowed, lastVisibleMessage } from './chats'

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

export async function listGroupThreads(instanceId: string, playerId: string, now = new Date()) {
  const instance = await mongoColl.worldInstances().findOne({ _id: parseObjectId(instanceId), player_id: parseObjectId(playerId) })
  if (!instance?.group_state) throw new HttpError(404, 'That chat could not be found.')
  const members = await loadGroupMembers(instance)
  const adultAllowed = await groupAdultAllowed(instance.player_id)
  const events = await mongoColl.events().find({ instance_id: instance._id, player_id: instance.player_id,
    'data.dm_with': { $in: members.map(member => member.id) } }).sort({ sequence: 1 }).toArray()
  const names = new Map(members.map(member => [member.id, member.name]))
  const threads = new Map<string, { memberId: string; lastLine: string; lastAt: Date; messageCount: number }>()
  for (const event of events) {
    const memberId = event.data.dm_with!
    // A line still ahead of the clock is not the player's yet: it must not
    // become the thread's preview, nor inflate its count. An adult turn while
    // the toggle is off is silent the same way.
    const lines = (event.data.lines || []).filter(line =>
      line.text && groupLineShown(line, now) && names.has(line.character_id || ''))
    const last = lastVisibleMessage(event, names, now, adultAllowed)
    const thread = threads.get(memberId) || { memberId, lastLine: '', lastAt: event.created_at, messageCount: 0 }
    threads.set(memberId, {
      memberId,
      lastLine: last?.text ?? thread.lastLine,
      // With no line to show, the newest event's time stands, so an all-adult
      // thread still sorts and opens by when it last happened.
      lastAt: last?.at ?? (thread.lastLine ? thread.lastAt : event.created_at),
      messageCount: thread.messageCount + lines.length + (event.data.player_input ? 1 : 0),
    })
  }
  return [...threads.values()]
}
