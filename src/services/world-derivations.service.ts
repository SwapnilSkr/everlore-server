/**
 * A model answer that depends only on a world's authored text, computed once.
 *
 * Both derivations a new save needs before it can answer — the world calendar
 * and the place its opening line stands in — read only the template's own
 * words. Every save of that world was therefore paying for the same two model
 * calls again (measured 2.7–4.3 s + 1.1–1.6 s on the create path). The answer
 * is stored here under a key built from the exact text sent to the model, so
 * editing a world produces a new key on its own and nothing needs invalidating.
 *
 * The cache is an optimisation, never a dependency: a failed read or write is
 * logged and the world still opens with a freshly computed answer.
 */
import { createHash } from 'node:crypto'
import { mongoColl } from '../config/mongo'
import type { WorldDerivationKind } from '../models/world-derivation.model'
import { log } from '../utils/logger'
import { CALENDAR_DERIVE_PROMPT_VERSION } from './time.service'
import { OPENING_PLACE_PROMPT_VERSION } from './opening-place.service'
import { OPENING_LANGUAGE_PROMPT_VERSION } from './opening-language.service'

/**
 * The prompt version for a kind. Each constant sits next to its own prompt
 * (`time.service.ts`, `opening-place.service.ts`, `opening-language.service.ts`)
 * and must be bumped there when that prompt changes; this reads them lazily so
 * the two services may import this module freely without an initialisation
 * cycle.
 */
function promptVersion(kind: WorldDerivationKind): number {
  if (kind === 'calendar') return CALENDAR_DERIVE_PROMPT_VERSION
  if (kind === 'opening_place') return OPENING_PLACE_PROMPT_VERSION
  return OPENING_LANGUAGE_PROMPT_VERSION
}

/** `${kind}:${version}:${sha256(input)}` — the stored `_id`, so lookups need no index. */
export function derivationKey(kind: WorldDerivationKind, input: string): string {
  const digest = createHash('sha256').update(input, 'utf8').digest('hex')
  return `${kind}:${promptVersion(kind)}:${digest}`
}

/**
 * Read by key; on a hit return the stored value with no model call. On a miss
 * run `compute` and store only when it says the answer is cacheable (the model
 * answered and the answer parsed). Junk and failures are not stored, so the
 * next save retries instead of pinning a bad answer.
 *
 * Concurrent misses for one key may both compute; the upsert makes the second
 * write a no-op and both callers get an answer.
 */
export async function cachedDerivation<T>(
  kind: WorldDerivationKind,
  input: string,
  compute: () => Promise<{ value: T; cacheable: boolean }>,
): Promise<T> {
  const key = derivationKey(kind, input)
  try {
    const hit = await mongoColl.worldDerivations().findOne({ _id: key })
    if (hit) return hit.value as T
  } catch (err) {
    log.warn('world_derivation.read_failed', { kind, error: (err as Error).message })
  }

  const { value, cacheable } = await compute()
  if (!cacheable) return value

  try {
    await mongoColl.worldDerivations().updateOne(
      { _id: key },
      { $setOnInsert: { _id: key, kind, value, created_at: new Date() } },
      { upsert: true },
    )
  } catch (err) {
    log.warn('world_derivation.store_failed', { kind, error: (err as Error).message })
  }
  return value
}
