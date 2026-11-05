import type { WorldEventDoc } from '../../src/models/world-event.model'
import { requestAgreedSelfie, requestOwnSelfie } from '../../src/services/media/selfie'
import { HttpError } from '../../src/utils/http-error'
import { log } from '../../src/utils/logger'
import { checkGroupSelfie } from './group-selfie-check'

export const GROUP_OWN_SELFIE_CHANCE = 1 / 25

/** Invoked only after the saved reply's completion has been published. */
export async function startGroupSelfies(event: WorldEventDoc, deps: { rng?: () => number; now?: () => Date } = {}): Promise<void> {
  const lines = event.data.lines ?? []
  const playerId = String(event.player_id), instanceId = String(event.instance_id), eventId = String(event._id)
  try {
    if (event.data.origin === 'player') {
      // A failed check must not turn into an unsolicited picture on this turn.
      const position = await checkGroupSelfie(event.data.player_input, lines.map(line => line.text))
      if (position !== null) {
        if (!Number.isInteger(position) || position < 1 || position > lines.length) return
        try { await requestAgreedSelfie(playerId, instanceId, eventId, lines[position - 1]) }
        catch (error) {
          if (!(error instanceof HttpError && error.statusCode === 429)) throw error
        }
        return
      }
    }
    const line = lines.at(-1)
    if (!line || (deps.rng ?? Math.random)() >= GROUP_OWN_SELFIE_CHANCE) return
    await requestOwnSelfie(playerId, instanceId, eventId, line, (deps.now ?? (() => new Date()))())
  } catch (error) {
    log.warn('group.selfie_start_failed', { instanceId, eventId, error: String(error) })
  }
}
