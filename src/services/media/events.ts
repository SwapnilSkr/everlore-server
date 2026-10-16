import { mediaRevision } from './attribution'
import { getRedisClient } from '../../config/redis'
import { mongoColl } from '../../config/mongo'
import { detectSpokenLines } from './detection'
import { publicSpokenLines } from './policy'
import { mediaEnabled } from './config'
import type { MediaAssetDoc } from '../../models/media.model'
import type { SpokenLine } from '../../models/media.model'
import type { WorldEventDoc } from '../../models/world-event.model'

export function spokenLineUpdate(prose: string, playerSpoken = '', playerInput = playerSpoken) {
  return { 'data.spoken_lines': detectSpokenLines(prose, playerSpoken), 'data.media_revision': mediaRevision(prose, playerInput) }
}
/** Contract §6: while voice is off the wire carries no lines, so the app shows nothing to tap. */
export function wireSpokenLines(lines: SpokenLine[] | undefined): SpokenLine[] | undefined {
  return mediaEnabled('voice') ? publicSpokenLines(lines || []) : undefined
}
export async function publishSpokenLines(event: WorldEventDoc): Promise<void> {
  if (!mediaEnabled('voice')) return
  await getRedisClient().publish(`user:${event.player_id}:events`, JSON.stringify({ type: 'spoken_lines', instanceId: String(event.instance_id), eventId: String(event._id), lines: publicSpokenLines(event.data.spoken_lines || []) }))
}
/** Player responses expose offsets and unvoiceable status, never attribution internals. */
export function publicMediaEvent<T extends WorldEventDoc>(event: T): T {
  if (mediaEnabled('voice')) {
    event.data.spoken_lines = publicSpokenLines(event.data.spoken_lines || detectSpokenLines(event.data.ai_response, event.data.player_spoken_input ?? event.data.player_input))
  } else delete event.data.spoken_lines
  delete event.data.voice_attribution
  delete event.data.media_revision
  for (const edit of event.edit_history || []) {
    delete edit.previous_data.spoken_lines
    delete edit.previous_data.voice_attribution
    delete edit.previous_data.media_revision
  }
  return event
}

/** Contract §6 "A turn's media rides on the turn": the turn's own pictures
 *  and films, oldest first. Only these keys reach the player. */
export interface TurnMediaItem {
  media_id: string
  kind: 'picture' | 'video'
  status: 'ready' | 'queued'
  url?: string
  poster_url?: string
  line_id?: string
  duration_ms?: number
}

function toTurnMedia(row: MediaAssetDoc): TurnMediaItem | null {
  // Voice, portraits and passing faces never ride on a turn; failed and
  // unseen rows never appear. The kind/status filter below already scopes
  // this, so an unexpected kind here is a structural refusal, not a default.
  if (row.kind !== 'picture' && row.kind !== 'video') return null
  if (row.status !== 'ready' && row.status !== 'queued' && row.status !== 'processing') return null
  const item: TurnMediaItem = {
    media_id: row._id.toHexString(),
    kind: row.kind,
    // Queued covers queued and processing, so a reload still shows "Taking shape…".
    status: row.status === 'ready' ? 'ready' : 'queued',
  }
  if (row.url) item.url = row.url
  if (row.poster_url) item.poster_url = row.poster_url
  // Pictures and dialogue-free cuts are turn markers with an empty line_id:
  // only a line film names its line.
  if (row.line_id) item.line_id = row.line_id
  if (typeof row.duration_ms === 'number') item.duration_ms = row.duration_ms
  return item
}

/** Attach each event's own media in one batched `media_assets` query, never
 *  one per event. Only the event's own player's rows attach: a row from
 *  another player is another player's picture and never appears. Rows hidden
 *  from Keepsakes still ride on their turn. Every event gets `data.media`,
 *  empty when the turn has no pictures or films yet. */
export async function withTurnMedia<T extends WorldEventDoc>(events: T[]): Promise<T[]> {
  if (!events.length) return events
  const ids = events.map((event) => event._id)
  const seen = new Set<string>()
  const pids = []
  for (const event of events) {
    const hex = event.player_id.toHexString()
    if (!seen.has(hex)) {
      seen.add(hex)
      pids.push(event.player_id)
    }
  }
  // instance_id leads the {instance_id, event_id} index; without it this scans.
  const iids = [...new Map(events.map((event) => [event.instance_id.toHexString(), event.instance_id])).values()]
  const rows = await mongoColl.mediaAssets().find({
    instance_id: { $in: iids },
    event_id: { $in: ids },
    player_id: { $in: pids },
    kind: { $in: ['picture', 'video'] },
    status: { $in: ['queued', 'processing', 'ready'] },
  }).sort({ created_at: 1, _id: 1 }).toArray() as MediaAssetDoc[]
  const byEvent = new Map<string, MediaAssetDoc[]>()
  for (const row of rows) {
    if (!row.event_id) continue
    const key = row.event_id.toHexString()
    const list = byEvent.get(key)
    if (list) list.push(row)
    else byEvent.set(key, [row])
  }
  for (const event of events) {
    const items: TurnMediaItem[] = []
    for (const row of byEvent.get(event._id.toHexString()) || []) {
      if (!row.player_id.equals(event.player_id)) continue
      const item = toTurnMedia(row)
      if (item) items.push(item)
    }
    // EventDataDoc carries no media field (model file outside this task's
    // paths), so the turn field is set through a narrow local type, never any.
    ;(event.data as unknown as { media?: TurnMediaItem[] }).media = items
  }
  return events
}
