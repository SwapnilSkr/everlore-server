/**
 * Fill a world's derivations when it is written, so its first player waits for
 * neither.
 *
 * A new save needs the world calendar and the place its opening line stands in
 * before it can answer, and both answer only from the world's own text. Until
 * now they were computed on the first open, or in bulk by
 * `scripts/warm-world-derivations.ts`, so a newly created or edited world made
 * its first player pay several seconds. The write path already knows the world
 * changed; this runs the same two `cachedDerivation` calls the open path runs,
 * with the same compute functions, so the stored keys and values are exactly
 * what that open would produce.
 *
 * Fire-and-forget: the caller never waits and this never rejects. A burst of
 * edits for one template coalesces into at most one follow-up run, which reads
 * the template again so it sees the newer text.
 */
import { mongoColl } from '../config/mongo'
import type { WorldTemplateDoc } from '../models/world-template.model'
import { log } from '../utils/logger'
import { parseObjectId } from '../utils/mongo-id'
import { cachedDerivation } from './world-derivations.service'
import { calendarPremiseOf, deriveCalendarFromPremise } from './time.service'
import { extractOpeningPlace } from './opening-place.service'

/** The text each derivation needs for one world; a group has no opening place. */
export interface WorldWarmPlan {
  calendarInput: string | null
  openingInput: string | null
}

export function planForWorld(
  template: Pick<WorldTemplateDoc, 'title' | 'description' | 'seed_prompt' | 'global_lore' | 'opening_line' | 'kind'>,
): WorldWarmPlan {
  const calendarInput = calendarPremiseOf(template) || null
  const opening = template.kind === 'group' ? '' : String(template.opening_line || '').trim()
  return { calendarInput, openingInput: opening || null }
}

interface WarmFlight {
  rerun: boolean
  done: Promise<void>
}

const inFlight = new Map<string, WarmFlight>()

/**
 * Start (or join) the warm for one template. Never rejects; callers may ignore
 * the promise. A call made while a run is in flight sets one follow-up run,
 * which reads the template fresh.
 */
export function warmWorldDerivations(templateId: string): Promise<void> {
  const existing = inFlight.get(templateId)
  if (existing) {
    existing.rerun = true
    return existing.done
  }

  const flight: WarmFlight = { rerun: false, done: Promise.resolve() }
  inFlight.set(templateId, flight)
  flight.done = (async () => {
    try {
      do {
        flight.rerun = false
        await warmOnce(templateId)
      } while (flight.rerun)
    } catch (error) {
      // The read itself failed; a derivation failure is caught per kind below.
      log.warn('world_warm.failed', { templateId, kind: 'template', error: (error as Error).message })
    } finally {
      inFlight.delete(templateId)
    }
  })()
  return flight.done
}

async function warmOnce(templateId: string): Promise<void> {
  const template = await mongoColl.worldTemplates().findOne(
    { _id: parseObjectId(templateId) },
    { projection: { title: 1, description: 1, seed_prompt: 1, global_lore: 1, opening_line: 1, kind: 1 } },
  )
  if (!template) return

  const plan = planForWorld(template)
  const runs: Promise<void>[] = []
  if (plan.calendarInput) {
    const input = plan.calendarInput
    runs.push(warmOne(templateId, 'calendar', () =>
      cachedDerivation('calendar', input, async () => {
        const { spec, cacheable } = await deriveCalendarFromPremise(input)
        return { value: spec, cacheable }
      })))
  }
  if (plan.openingInput) {
    const input = plan.openingInput
    runs.push(warmOne(templateId, 'opening_place', () => extractOpeningPlace({ openingLine: input })))
  }
  await Promise.all(runs)
}

/** One derivation's failure is a warn line and nothing else. */
async function warmOne(
  templateId: string,
  kind: 'calendar' | 'opening_place',
  run: () => Promise<unknown>,
): Promise<void> {
  try {
    await run()
  } catch (error) {
    log.warn('world_warm.failed', { templateId, kind, error: (error as Error).message })
  }
}
