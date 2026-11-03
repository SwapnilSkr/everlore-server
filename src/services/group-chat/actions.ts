import { mongoColl } from '../../config/mongo'
import { HttpError } from '../../utils/http-error'
import { parseObjectId } from '../../utils/mongo-id'
import type { NamedLine } from './types'

export const GROUP_ACTION_RULE = "Only what the player did is fact. If an action claims what someone else did, said or felt, that person decides for themselves. Each speaker replies as a reaction to what the player did."

/** A rendered label lets every existing transcript consumer, including summaries, share the form. */
export function groupPlayerLine(player: string, text: string, action?: true): NamedLine {
  return { name: action ? `${player} did this` : player, text, ...(action ? { player_action: true as const } : {}) }
}

export function groupSpeaker(line: NamedLine): string {
  return line.player_action ? line.name.slice(0, -' did this'.length) : line.name
}

export function groupLineText(line: NamedLine): string {
  return `${line.name}: ${line.text}`
}

export function groupPlayerFact(player: string, line: NamedLine): string {
  return line.player_action ? groupLineText(groupPlayerLine(player, line.text, true)) : `${player} said: ${line.text}`
}

export function validateGroupAction(kind: unknown, group: boolean, directWith: unknown, text: string) {
  if (kind === undefined) return
  if (kind !== 'action') throw new HttpError(400, 'That kind of message is not available.')
  if (!group) throw new HttpError(400, 'Actions are only available in group chats.')
  if (directWith !== undefined) throw new HttpError(400, 'An action is shared with everyone in the chat.')
  if (typeof text !== 'string' || !text.trim() || text.length > 4000) throw new HttpError(400, 'Write an action between 1 and 4000 characters.')
}

export async function listGroupActions(instanceId: string, playerId: string, query: { before?: unknown; limit?: unknown }) {
  const instance = await mongoColl.worldInstances().findOne({ _id: parseObjectId(instanceId), player_id: parseObjectId(playerId) })
  if (!instance?.group_state) throw new HttpError(404, 'That chat could not be found.')
  const before = query.before === undefined ? undefined : Number(query.before)
  const limit = query.limit === undefined ? 30 : Number(query.limit)
  if ((before !== undefined && (!Number.isSafeInteger(before) || before < 1)) || !Number.isInteger(limit) || limit < 1 || limit > 50) {
    throw new HttpError(400, 'Choose a valid page and between 1 and 50 actions.')
  }
  const player = await mongoColl.users().findOne({ _id: instance.player_id }, { projection: { 'preferences.nsfw_enabled': 1 } })
  const events = await mongoColl.events().find({ instance_id: instance._id, player_id: instance.player_id,
    'data.player_action': true, 'data.dm_with': { $exists: false },
    ...(before === undefined ? {} : { sequence: { $lt: before } }),
    ...(player?.preferences?.nsfw_enabled === true ? {} : { type: { $ne: 'intimate' } }),
  }).sort({ sequence: -1 }).limit(limit + 1).toArray()
  const page = events.slice(0, limit)
  return { actions: page.map(event => ({ eventId: String(event._id), sequence: event.sequence, text: event.data.player_input, at: event.created_at })),
    next: events.length > limit ? page.at(-1)!.sequence : null }
}
