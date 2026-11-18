import type { ObjectId } from 'mongodb'
import { mongoColl } from '../../config/mongo'
import { log } from '../../utils/logger'

/**
 * Country capture on the user document.
 *
 * Two fields, two different lifetimes: `signup_country` is the player's country
 * the first time it is known, kept forever; `country` follows them around.
 * The latest value is refreshed at most once per UTC day — a player who moves
 * between networks is not worth a write on every telemetry batch — and
 * `country_day` is what makes that check a plain comparison instead of a
 * timestamp debate.
 *
 * Nothing here writes a missing country: the caller passes one only when the
 * lookup produced it, and the key is then omitted rather than set to null.
 */

export interface UserCountryFields {
  country?: string
  country_day?: string
  signup_country?: string
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export async function recordUserCountry(
  userId: ObjectId,
  country: string,
  day: string,
): Promise<void> {
  try {
    const user = (await mongoColl.users().findOne(
      { _id: userId },
      { projection: { country: 1, country_day: 1, signup_country: 1 } },
    )) as UserCountryFields | null
    if (!user) return

    const update: UserCountryFields = {}
    // At most one write a day. A player who hops networks keeps the first
    // country of the day, which is enough for the console and costs one read.
    if (user.country_day !== day) {
      update.country = country
      update.country_day = day
    }
    // Set once. No backfill: an account that has never had a country known
    // simply has no key until this feature first sees one.
    if (user.signup_country === undefined) update.signup_country = country

    if (Object.keys(update).length === 0) return
    await mongoColl.users().updateOne({ _id: userId }, { $set: update })
  } catch (error) {
    log.error('telemetry: user country update failed', { error: errorMessage(error) })
  }
}
