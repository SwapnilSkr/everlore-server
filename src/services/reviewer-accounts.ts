import type { ObjectId } from 'mongodb'
import { env } from '../config/env'
import { mongoColl } from '../config/mongo'
import { normalizePhone } from '../providers/auth.provider'
import { HttpError } from '../utils/http-error'
import { log } from '../utils/logger'

/**
 * Accounts that exist only for Google Play's review and pre-launch testing.
 *
 * They keep every feature — a reviewer must be able to use the app — but they
 * are not players, and the console's player numbers must not include them. Two
 * structural rules catch them, and nothing here is a word list:
 *
 *  - `review_phone`: the account's phone is the review credential's number.
 *  - `number_name`: the display name is shaped like a phone number. Reviewers
 *    type the number from the review instructions into the name field.
 *
 * The flag is sticky: nothing in this module ever removes it. A flag is written
 * as `reviewer: true`; an unflagged account has no key at all, never `false`.
 */

export type ReviewerReason = 'review_phone' | 'number_name'
export type ReviewersMode = 'exclude' | 'include' | 'only'
export type ReviewerScope = { userIds: ObjectId[]; installIds: string[] }

/** A phone number written as a name has at least this many digits. */
const MIN_NUMBER_NAME_DIGITS = 7

/** The only characters a phone number written as a name contains. */
const NUMBER_NAME_CHARS = /^[+\d\s\-.()]+$/

/**
 * The same rule as {@link reviewerReason}'s `number_name` test, as a Mongo
 * regex: only the characters above, and at least seven digits. Kept next to the
 * pure rule so the sweep and the write paths cannot disagree about a name.
 */
const NUMBER_NAME_PATTERN = `^\\s*(?=(?:\\D*\\d){${MIN_NUMBER_NAME_DIGITS}})[+\\d\\s\\-.()]+\\s*$`

function numberNameShaped(name: string): boolean {
  const trimmed = name.trim()
  if (!trimmed || !NUMBER_NAME_CHARS.test(trimmed)) return false
  return (trimmed.match(/\d/g)?.length ?? 0) >= MIN_NUMBER_NAME_DIGITS
}

/** The reason this account is a reviewer's, or null for a normal player. */
export function reviewerReason(
  input: { phone?: string | null; player_name?: string | null },
  reviewPhone?: string | null,
): ReviewerReason | null {
  // An unset review phone arms nothing: the phone test never matches.
  const target = normalizePhone(reviewPhone || '')
  if (target && input.phone && normalizePhone(input.phone) === target) return 'review_phone'
  if (typeof input.player_name === 'string' && numberNameShaped(input.player_name)) return 'number_name'
  return null
}

/** The `number_name` rule as a filter, for the sweep and the backfill script. */
export function numberNameFilter(): Record<string, unknown> {
  return { 'preferences.player_name': { $regex: NUMBER_NAME_PATTERN } }
}

/**
 * A matched phone has exactly the review number's digits in order, so a regex
 * over the stored string is the same test as {@link normalizePhone} equality.
 */
function phonePattern(reviewPhone: string): string | null {
  const digits = normalizePhone(reviewPhone).replace(/\D/g, '')
  if (!digits) return null
  return `^\\s*\\+?${[...digits].map((digit) => `\\D*${digit}`).join('')}\\D*\\s*$`
}

/** The `review_phone` rule as a filter, or null when no review phone is set. */
export function reviewerPhoneFilter(reviewPhone = env.REVIEW_DEMO_PHONE): Record<string, unknown> | null {
  const pattern = phonePattern(reviewPhone)
  return pattern ? { phone: { $regex: pattern } } : null
}

/** Every account matching either rule and not yet flagged. */
export function reviewerSweepFilter(reviewPhone = env.REVIEW_DEMO_PHONE): Record<string, unknown> {
  const phone = reviewerPhoneFilter(reviewPhone)
  return {
    reviewer: { $ne: true },
    $or: phone ? [phone, numberNameFilter()] : [numberNameFilter()],
  }
}

/**
 * The sweep's write, as an update pipeline so one `updateMany` can stamp the
 * right reason per row. `reviewer_at` keeps its first value.
 */
export function reviewerSweepUpdate(now: Date, reviewPhone = env.REVIEW_DEMO_PHONE): Array<Record<string, unknown>> {
  const pattern = phonePattern(reviewPhone)
  return [{
    $set: {
      reviewer: true,
      reviewer_reason: pattern
        ? { $cond: [{ $regexMatch: { input: { $ifNull: ['$phone', ''] }, regex: pattern } }, 'review_phone', 'number_name'] }
        : 'number_name',
      reviewer_at: { $ifNull: ['$reviewer_at', now] },
    },
  }]
}

/** `exclude` unless the console asked otherwise; anything else is a 400. */
export function reviewersParam(value?: string): ReviewersMode {
  if (value === undefined || value === '') return 'exclude'
  if (value === 'exclude' || value === 'include' || value === 'only') return value
  throw new HttpError(400, 'Reviewers must be exclude, include or only.')
}

const SCOPE_TTL_MS = 60_000
let cached: { at: number; value: ReviewerScope } | null = null
let pending: Promise<ReviewerScope> | null = null

/** Audits need a fresh read after they change a row. */
export function resetReviewerScopeCache(): void {
  cached = null
  pending = null
}

async function loadScope(): Promise<{ scope: ReviewerScope; cached: boolean }> {
  let rows: Array<{ _id: ObjectId; install_id?: string }>
  try {
    rows = await mongoColl.users()
      .find({ reviewer: true }, { projection: { _id: 1, install_id: 1 } })
      .toArray()
  } catch (error) {
    // Nothing can be excluded if the set cannot be read, but taking a console
    // page down for it would be worse than showing it unfiltered for one call.
    // Logged at error, and never cached, so the next read tries again.
    log.error('reviewers.scope_unavailable', {
      error: error instanceof Error ? error.message : String(error),
    })
    return { scope: { userIds: [], installIds: [] }, cached: false }
  }
  const userIds = rows.map((row) => row._id)
  const installIds = new Set<string>()
  for (const row of rows) {
    if (typeof row.install_id === 'string' && row.install_id) installIds.add(row.install_id)
  }
  if (userIds.length > 0) {
    const installs = await mongoColl.appInstalls()
      .find({ user_ids: { $in: userIds } }, { projection: { _id: 1 } })
      .toArray()
    for (const row of installs) installIds.add(String(row._id))
  }
  return { scope: { userIds, installIds: [...installIds] }, cached: true }
}

export const reviewerAccounts = {
  /** Flag every matching account that is not flagged yet; returns how many. */
  async sweep(): Promise<number> {
    const result = await mongoColl.users().updateMany(reviewerSweepFilter(), reviewerSweepUpdate(new Date()))
    if (result.modifiedCount > 0) resetReviewerScopeCache()
    return result.modifiedCount
  },

  /**
   * The ids to leave out of player numbers: flagged accounts, every install
   * they signed in on, and their own install. Small enough to hold in memory,
   * and cached for a minute so one console page is one read.
   */
  async scope(): Promise<ReviewerScope> {
    if (cached && Date.now() - cached.at < SCOPE_TTL_MS) return cached.value
    if (pending) return pending
    pending = loadScope().then((result) => {
      if (result.cached) cached = { at: Date.now(), value: result.scope }
      return result.scope
    }).finally(() => { pending = null })
    return pending
  },
}
