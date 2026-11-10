import type { ObjectId } from 'mongodb'
import { mongoColl } from '../../config/mongo'
import type { CharacterProfileDoc } from '../../models/character-profile.model'
import type { WorldInstanceDoc } from '../../models/world-instance.model'
import type { WorldTemplateDoc } from '../../models/world-template.model'
import { idString, parseObjectId } from '../../utils/mongo-id'
import { groupFaces, groupPendingFrom } from './public'
import { refreshGroupTimezone } from './ideas'

/** The Chats list reads a small window of the room and the direct threads'
 *  messages, so one row never costs a whole room history. */
export const GROUP_CHATS_LIMIT = 50
export const GROUP_CHAT_EVENT_WINDOW = 12

export interface GroupChatMessage {
  from: 'member' | 'player'
  name?: string
  text: string
  at: Date
}

export interface GroupChatMemberRow {
  id: string
  name: string
  role?: string
  portrait_url?: string
  portrait_thumb_url?: string
}

export interface GroupChatThreadRow {
  member_id: string
  last?: GroupChatMessage
  message_count: number
}

export interface GroupChatRow {
  instance_id: string
  template_id: string
  title?: string
  image_url?: string
  image_thumb_url?: string
  members: GroupChatMemberRow[]
  last?: GroupChatMessage
  pending_from: string[]
  threads: GroupChatThreadRow[]
}

/** The part of an event a list row needs. A full event is assignable. */
export interface GroupChatEventView {
  sequence: number
  created_at: Date
  /** `intimate` marks an adult turn, whose words a preview may not repeat. */
  type?: string
  data: {
    dm_with?: string
    player_input?: string
    lines?: Array<{ character_id?: string; text?: string; shown_at?: Date }>
  }
}

/** A line is the player's once its reveal time has passed. Anything still ahead
 *  is not shown yet, so no list may name it. */
export function groupLineShown(line: { shown_at?: Date }, now: Date): boolean {
  return !line.shown_at || new Date(line.shown_at).getTime() <= now.getTime()
}

/** An adult turn is silent while the toggle is off, the player's own words
 *  included. A preview and a thread's count share this test, so a hidden
 *  turn cannot leave an empty row or admit that it exists. */
function groupEventShown(event: GroupChatEventView, adultAllowed: boolean): boolean {
  if (!adultAllowed && event.type === 'intimate') return false
  return true
}

/** The newest message of one event that the player has already been shown,
 *  falling back to the player's own words when no reply is visible yet. */
export function lastVisibleMessage(
  event: GroupChatEventView,
  names: Map<string, string>,
  now: Date,
  adultAllowed: boolean,
): GroupChatMessage | undefined {
  if (!groupEventShown(event, adultAllowed)) return undefined
  const lines = (event.data.lines || []).filter(line =>
    line.text && groupLineShown(line, now) && names.has(line.character_id || ''))
  const line = lines.at(-1)
  if (line) {
    return {
      from: 'member',
      name: names.get(line.character_id || '')!,
      text: line.text!,
      at: line.shown_at ? new Date(line.shown_at) : event.created_at,
    }
  }
  if (event.data.player_input) {
    return { from: 'player', text: event.data.player_input, at: event.created_at }
  }
  return undefined
}

export interface GroupChatSource {
  instance: Pick<WorldInstanceDoc, '_id' | 'template_id' | 'group_state' | 'seed_cast_snapshot'>
  template?: Pick<WorldTemplateDoc, 'title' | 'image_url' | 'image_thumb_url' | 'seed_cast'> | null
  cards: CharacterProfileDoc[]
  /** A recent window is enough: the last shown line is always in it. */
  mainEvents: GroupChatEventView[]
  threadEvents: GroupChatEventView[]
  /** Whether this player may be shown adult words. Read once per request, so
   *  the pure row builder never asks the database itself. */
  adultAllowed: boolean
}

/** One Chats row. Pure: events and members in, row out, `now` passed in. */
export function buildGroupChatRow(source: GroupChatSource, now: Date): GroupChatRow {
  const faces = groupFaces(source.template)
  const cards = new Map(source.cards.map(card => [card.canonical_name.trim().toLowerCase(), card]))
  const members = (source.instance.seed_cast_snapshot || []).flatMap(member => {
    const card = cards.get(member.name.trim().toLowerCase())
    if (!card) return []
    const face = faces.get(member.name.trim().toLowerCase())
    return [{
      id: idString(card._id),
      name: member.name,
      ...(member.role ? { role: member.role } : {}),
      ...(face ? { portrait_url: face.url } : {}),
      ...(face?.thumb ? { portrait_thumb_url: face.thumb } : {}),
    }]
  })
  const names = new Map(members.map(member => [member.id, member.name]))

  // `last` is the room only: a direct message belongs to its own thread row.
  const last = ordered(source.mainEvents.filter(event => event.data.dm_with === undefined))
    .reduce<GroupChatMessage | undefined>((found, event) => lastVisibleMessage(event, names, now, source.adultAllowed) ?? found, undefined)

  const threads = new Map<string, GroupChatThreadRow>()
  for (const event of ordered(source.threadEvents)) {
    const thread = event.data.dm_with
    if (!thread || !names.has(thread)) continue
    if (!groupEventShown(event, source.adultAllowed)) continue
    const row = threads.get(thread) ?? { member_id: thread, message_count: 0 }
    row.message_count += (event.data.lines || []).filter(line =>
      line.text && groupLineShown(line, now) && names.has(line.character_id || '')).length
    if (event.data.player_input) row.message_count += 1
    const message = lastVisibleMessage(event, names, now, source.adultAllowed)
    if (message) row.last = message
    threads.set(thread, row)
  }

  return {
    instance_id: idString(source.instance._id),
    template_id: idString(source.instance.template_id),
    ...(source.template?.title ? { title: source.template.title } : {}),
    ...(source.template?.image_url ? { image_url: source.template.image_url } : {}),
    ...(source.template?.image_thumb_url ? { image_thumb_url: source.template.image_thumb_url } : {}),
    members,
    ...(last ? { last } : {}),
    pending_from: groupPendingFrom(source.instance.group_state, now),
    threads: [...threads.values()]
      .filter(thread => thread.message_count > 0)
      .map(thread => ({ member_id: thread.member_id, ...(thread.last ? { last: thread.last } : {}), message_count: thread.message_count })),
  }
}

function ordered(events: GroupChatEventView[]) {
  return [...events].sort((left, right) => left.sequence - right.sequence)
}

const worldInstances = () => mongoColl.worldInstances()
const worldTemplates = () => mongoColl.worldTemplates()
const characters = () => mongoColl.characters()
const events = () => mongoColl.events()
const users = () => mongoColl.users()

/** The player's mature toggle, read once per request. A missing preference
 *  counts as off, the same test the actions list uses. */
export async function groupAdultAllowed(playerId: ObjectId): Promise<boolean> {
  const player = await users().findOne({ _id: playerId }, { projection: { 'preferences.nsfw_enabled': 1 } })
  return player?.preferences?.nsfw_enabled === true
}

/** One request builds the whole Chats tab: the player's group saves, newest
 *  activity first. Queries: three fixed reads (saves, templates, cards) plus
 *  two event reads per chat — the room's recent window and its direct threads. */
export async function listGroupChats(playerId: string, now = new Date()): Promise<{ chats: GroupChatRow[] }> {
  const instances = await worldInstances().find(
    { player_id: parseObjectId(playerId), 'meta.is_archived': { $ne: true }, group_state: { $exists: true } },
    { projection: {
      _id: 1, template_id: 1, seed_cast_snapshot: 1,
      'group_state.pending_direct': 1, 'meta.last_active_at': 1,
    } },
  ).sort({ 'meta.last_active_at': -1, _id: -1 }).limit(GROUP_CHATS_LIMIT).toArray()
  if (!instances.length) return { chats: [] }
  // The list is the read before opening anything, so the zone the status is
  // picked from is freshened from the newest device here. A failed refresh must
  // not cost the player the list.
  await refreshGroupTimezone(playerId, now).catch(() => undefined)
  const adultAllowed = await groupAdultAllowed(parseObjectId(playerId))

  const templateIds = [...new Map(instances.map(instance => [instance.template_id.toHexString(), instance.template_id])).values()]
  const [templates, cards] = await Promise.all([
    worldTemplates().find({ _id: { $in: templateIds } }, {
      projection: { _id: 1, title: 1, image_url: 1, image_thumb_url: 1, seed_cast: 1 },
    }).toArray(),
    characters().find({ instance_id: { $in: instances.map(instance => instance._id) } }, {
      projection: { _id: 1, instance_id: 1, canonical_name: 1 },
    }).toArray(),
  ])
  const templateById = new Map(templates.map(template => [idString(template._id), template]))
  const cardsByInstance = new Map<string, CharacterProfileDoc[]>()
  for (const card of cards) {
    const key = idString(card.instance_id)
    const list = cardsByInstance.get(key) ?? []
    list.push(card)
    cardsByInstance.set(key, list)
  }

  const chats: GroupChatRow[] = []
  for (const instance of instances) {
    const [mainEvents, threadEvents] = await Promise.all([
      events().find({ instance_id: instance._id, 'data.dm_with': { $exists: false } }, {
        projection: { sequence: 1, created_at: 1, type: 1, 'data.player_input': 1, 'data.lines': 1 },
      }).sort({ sequence: -1 }).limit(GROUP_CHAT_EVENT_WINDOW).toArray(),
      events().find({ instance_id: instance._id, 'data.dm_with': { $exists: true } }, {
        projection: { sequence: 1, created_at: 1, type: 1, 'data.dm_with': 1, 'data.player_input': 1, 'data.lines': 1 },
      }).sort({ sequence: 1 }).toArray(),
    ])
    chats.push(buildGroupChatRow({
      instance,
      template: templateById.get(idString(instance.template_id)) ?? null,
      cards: cardsByInstance.get(idString(instance._id)) || [],
      mainEvents,
      threadEvents,
      adultAllowed,
    }, now))
  }
  return { chats }
}
