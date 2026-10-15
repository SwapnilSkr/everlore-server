import { mediaRevision } from './attribution'
import { getRedisClient } from '../../config/redis'
import { detectSpokenLines } from './detection'
import { publicSpokenLines } from './policy'
import { mediaEnabled } from './config'
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
