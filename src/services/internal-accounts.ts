import { ObjectId } from 'mongodb'
import { parsePhoneNumberFromString } from 'libphonenumber-js/max'
import { mongoColl } from '../config/mongo'
import { parseObjectId } from '../utils/mongo-id'
import { HttpError } from '../utils/http-error'
import { log } from '../utils/logger'
import { resetReviewerScopeCache } from './reviewer-accounts'

/**
 * The team's own accounts, told apart from players the way review accounts are
 * (`everlore-docs/phases/admin-insights.md`, "Contract, part 2b").
 *
 * Three structural rules catch them — an owner name in the email or display
 * name, the official account's username, and the reserved +1 555 range — plus a
 * manual switch an operator can flip on any account. Nothing here is a word
 * list of player names: each rule reads a field whose value has one meaning.
 *
 * The flag is sticky in the same way the reviewer flag is: nothing removes
 * `internal` except switching it off on purpose, which also records
 * `internal_override: 'off'` so the next sweep leaves the account alone.
 *
 * This module also derives `country_hint` for players seen before country
 * capture existed: the region of the latest session's locale, or the region of
 * the stored phone number (which wins when both exist). It never touches
 * `country`.
 */

export type InternalReason = 'owner' | 'official' | 'test_phone' | 'manual'
export type InternalOverride = 'on' | 'off'
export type CountryHintSource = 'locale' | 'phone'
export type CountryHint = { code: string; source: CountryHintSource }

const users = () => mongoColl.users()
const appSessions = () => mongoColl.appSessions()

/** The owner's name as it appears in an email or a display name. */
const OWNER_TEXT = 'swapnil'

/** The official account's username, matched whole. */
const OFFICIAL_USERNAME_PATTERN = '^everlore$'

/**
 * A North American number in the 555 exchange with seven digits after it — the
 * range reserved for fiction and tests, which no real player owns. Written as a
 * pattern over the stored string so the sweep can find it in Mongo.
 */
const TEST_PHONE_PATTERN = '^\\s*\\+?[\\s\\-().]*1?[\\s\\-().]*555[\\s\\-().]*\\d{3}[\\s\\-().]*\\d{4}\\s*$'

/** The same rule as {@link internalReasonOf}'s `test_phone` test, on digits. */
const TEST_PHONE_DIGITS = /^555\d{7}$/

const ISO_COUNTRY = /^[A-Z]{2}$/

/** The sessions TTL keeps; the latest locale can never be older than this. */
const SESSION_RETENTION_DAYS = 90

/** Accounts one hint pass looks at. Bounds the job and keeps one page small. */
const HINT_BATCH = 500

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** The national digits of a stored phone, with a leading North American 1 dropped. */
function nationalDigits(phone: string): string {
  const digits = phone.replace(/\D/g, '')
  return digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits
}

/** True for a +1 555 number in the range reserved for fiction and tests. */
export function isTestPhone(phone?: string | null): boolean {
  if (typeof phone !== 'string' || !phone.trim()) return false
  return TEST_PHONE_DIGITS.test(nationalDigits(phone))
}

/**
 * The reason an account is a team account, or null for a player.
 *
 * Precedence is owner, then official, then test phone: an account that matches
 * two rules is reported under the first, which is also the order the sweep's
 * pipeline applies.
 */
export function internalReasonOf(input: {
  email?: string | null
  phone?: string | null
  username?: string | null
  preferences?: { player_name?: string | null } | null
}): InternalReason | null {
  const ownerText = (value: unknown) => typeof value === 'string' && value.toLowerCase().includes(OWNER_TEXT)
  if (ownerText(input.email) || ownerText(input.preferences?.player_name)) return 'owner'
  if (typeof input.username === 'string' && input.username.toLowerCase() === 'everlore') return 'official'
  if (isTestPhone(input.phone)) return 'test_phone'
  return null
}

/** The `owner` rule as a Mongo filter. */
function ownerQuery(): Record<string, unknown> {
  return {
    $or: [
      { email: { $regex: OWNER_TEXT, $options: 'i' } },
      { 'preferences.player_name': { $regex: OWNER_TEXT, $options: 'i' } },
    ],
  }
}

function officialQuery(): Record<string, unknown> {
  return { username: { $regex: OFFICIAL_USERNAME_PATTERN, $options: 'i' } }
}

function testPhoneQuery(): Record<string, unknown> {
  return { phone: { $regex: TEST_PHONE_PATTERN } }
}

function ownerExpression(): Record<string, unknown> {
  return {
    $or: [
      { $regexMatch: { input: { $ifNull: ['$email', ''] }, regex: OWNER_TEXT, options: 'i' } },
      { $regexMatch: { input: { $ifNull: ['$preferences.player_name', ''] }, regex: OWNER_TEXT, options: 'i' } },
    ],
  }
}

function officialExpression(): Record<string, unknown> {
  return { $regexMatch: { input: { $ifNull: ['$username', ''] }, regex: OFFICIAL_USERNAME_PATTERN, options: 'i' } }
}

function testPhoneExpression(): Record<string, unknown> {
  return { $regexMatch: { input: { $ifNull: ['$phone', ''] }, regex: TEST_PHONE_PATTERN } }
}

/**
 * Every account a rule matches whose stored reason is not already the one the
 * rules would give it.
 *
 * The "reason differs" clause is what makes a second sweep a no-op: a row the
 * pipeline would only rewrite with the same value is not selected at all. An
 * account switched off by hand is never selected, and an account matching two
 * rules is selected by the first one only, so the pipeline and the filter agree
 * about precedence.
 */
export function internalSweepFilter(): Record<string, unknown> {
  const owner = ownerQuery()
  return {
    internal_override: { $ne: 'off' },
    $or: [
      { $and: [owner, { internal_reason: { $ne: 'owner' } }] },
      { $and: [officialQuery(), { $nor: [owner] }, { internal_reason: { $ne: 'official' } }] },
      { $and: [testPhoneQuery(), { $nor: [owner, officialQuery()] }, { internal_reason: { $ne: 'test_phone' } }] },
    ],
  }
}

/**
 * The sweep's write, as an update pipeline so one `updateMany` stamps the right
 * reason per row. `internal_at` keeps its first value.
 */
export function internalSweepUpdate(now: Date): Array<Record<string, unknown>> {
  return [{
    $set: {
      internal: true,
      internal_reason: {
        $cond: [
          ownerExpression(),
          'owner',
          {
            $cond: [
              officialExpression(),
              'official',
              { $cond: [testPhoneExpression(), 'test_phone', '$internal_reason'] },
            ],
          },
        ],
      },
      internal_at: { $ifNull: ['$internal_at', now] },
    },
  }]
}

/** The region of a locale such as `en-GB`, or null when it names none. */
export function localeRegion(locale?: string | null): string | null {
  if (typeof locale !== 'string') return null
  const match = /^[a-z]{2,3}[-_]([A-Za-z]{2})$/.exec(locale.trim())
  if (!match) return null
  const code = match[1].toUpperCase()
  return ISO_COUNTRY.test(code) ? code : null
}

/**
 * The region of a stored phone number, by its calling code — including the
 * area code for +1, so a Canadian number is not called American. Offline:
 * `libphonenumber-js` reads its own bundled metadata.
 *
 * A number whose region cannot be determined (a fictional 555 number, a
 * malformed value) answers null; nothing is guessed.
 */
export function phoneRegion(phone?: string | null): string | null {
  if (typeof phone !== 'string' || !phone.trim()) return null
  try {
    const parsed = parsePhoneNumberFromString(phone.trim())
    const code = parsed?.country
    return typeof code === 'string' && ISO_COUNTRY.test(code) ? code : null
  } catch {
    return null
  }
}

/** The hint a player's two signals give: phone first, then the latest locale. */
export function countryHintOf(input: { locale?: string | null; phone?: string | null }): CountryHint | null {
  const phone = phoneRegion(input.phone)
  if (phone) return { code: phone, source: 'phone' }
  const locale = localeRegion(input.locale)
  if (locale) return { code: locale, source: 'locale' }
  return null
}

function sameHint(left?: CountryHint | null, right?: CountryHint | null): boolean {
  return (left?.code ?? null) === (right?.code ?? null) && (left?.source ?? null) === (right?.source ?? null)
}

function utcDay(at: Date): string {
  return at.toISOString().slice(0, 10)
}

type HintRow = {
  _id: ObjectId
  phone?: string
  country_hint?: CountryHint
  country_hint_day?: string
}

/**
 * Each player's latest session locale, for the accounts a hint pass is about.
 * `(user_id, started_at)` is the sessions index, so this is one ordered read.
 */
async function latestLocales(ids: ObjectId[], now: Date): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map()
  const from = new Date(now.getTime() - SESSION_RETENTION_DAYS * 86_400_000)
  const rows = await appSessions().aggregate<{ _id: ObjectId; locale?: string }>([
    { $match: { user_id: { $in: ids }, started_at: { $gte: from } } },
    { $sort: { started_at: -1 } },
    { $group: { _id: '$user_id', locale: { $first: '$device.locale' } } },
  ]).toArray()
  return new Map(rows.filter((row) => typeof row.locale === 'string').map((row) => [String(row._id), row.locale!]))
}

/**
 * The hint an account's signals would write, and whether that differs from what
 * is stored.
 *
 * A fresh read that finds no signal never removes a stored hint: the hint is a
 * fallback for players seen before capture, and losing a phone number is not a
 * reason to erase where they were. Only a hint that exists and differs counts.
 */
function hintFor(row: HintRow, locales: Map<string, string>): { hint: CountryHint | null; changed: boolean } {
  const hint = countryHintOf({ locale: locales.get(String(row._id)), phone: row.phone })
  return { hint, changed: hint !== null && !sameHint(hint, row.country_hint) }
}

export type CountryHintReport = { checked: number; changed: number; rows: Array<{ id: string; code: string | null; source: CountryHintSource | null }> }

export const internalAccounts = {
  /**
   * Tag every account a rule matches with the reason it matched; returns how
   * many documents changed. A second run changes nothing.
   */
  async sweep(now = new Date()): Promise<number> {
    const result = await users().updateMany(internalSweepFilter(), internalSweepUpdate(now))
    if (result.modifiedCount > 0) resetReviewerScopeCache()
    return result.modifiedCount
  },

  /**
   * Turn the team flag on or off by hand.
   *
   * On records `internal_override: 'on'` (the rule may still name a better
   * reason on a later sweep) and `manual` unless a rule already set one. Off
   * removes `internal` and `internal_reason` and records `'off'`, which the
   * sweep respects from then on. `internal_at` keeps its first value either way.
   */
  async setInternal(userId: string, internal: boolean) {
    const uid = parseObjectId(userId)
    const existing = await users().findOne(
      { _id: uid },
      { projection: { internal: 1, internal_reason: 1, internal_at: 1 } },
    )
    if (!existing) throw new HttpError(404, 'User not found')
    const now = new Date()

    if (!internal) {
      const updated = await users().findOneAndUpdate(
        { _id: uid },
        { $set: { internal_override: 'off' as InternalOverride, updated_at: now }, $unset: { internal: '', internal_reason: '' } },
        { returnDocument: 'after', projection: { password_hash: 0 } },
      )
      if (!updated) throw new HttpError(404, 'User not found')
      resetReviewerScopeCache()
      return updated
    }

    const ruleReason = existing.internal === true && existing.internal_reason && existing.internal_reason !== 'manual'
      ? existing.internal_reason as InternalReason
      : null
    const updated = await users().findOneAndUpdate(
      { _id: uid },
      {
        $set: {
          internal: true,
          internal_reason: ruleReason ?? 'manual',
          internal_override: 'on' as InternalOverride,
          internal_at: existing.internal_at instanceof Date ? existing.internal_at : now,
          updated_at: now,
        },
      },
      { returnDocument: 'after', projection: { password_hash: 0 } },
    )
    if (!updated) throw new HttpError(404, 'User not found')
    resetReviewerScopeCache()
    return updated
  },

  /**
   * Write `country_hint` for accounts not checked today, at most one small
   * update each. The hint itself is written only when it differs; the day
   * marker is what makes the pass once a day rather than once a sweep.
   */
  async hintCountries(now = new Date()): Promise<{ checked: number; changed: number }> {
    const today = utcDay(now)
    const due = await users()
      .find(
        { $or: [{ country_hint_day: { $exists: false } }, { country_hint_day: { $ne: today } }] },
        { projection: { phone: 1, country_hint: 1, country_hint_day: 1 } },
      )
      .limit(HINT_BATCH)
      .toArray() as unknown as HintRow[]
    if (due.length === 0) return { checked: 0, changed: 0 }

    const locales = await latestLocales(due.map((row) => row._id), now)
    let checked = 0
    let changed = 0
    for (const row of due) {
      const { hint, changed: differs } = hintFor(row, locales)
      try {
        await users().updateOne(
          { _id: row._id },
          differs
            ? { $set: { ...(hint ? { country_hint: hint } : {}), country_hint_day: today } }
            : { $set: { country_hint_day: today } },
        )
        checked++
        if (differs) changed++
      } catch (error) {
        log.error('internal_accounts.country_hint_failed', { error: errorMessage(error) })
      }
    }
    return { checked, changed }
  },

  /**
   * The one-off pass behind `scripts/backfill-country-hint.ts`: every account
   * with a signal, read in pages, written only when the hint differs. With
   * `apply: false` nothing is written at all.
   */
  async backfillCountryHints(opts: { apply: boolean; now?: Date }): Promise<CountryHintReport> {
    const now = opts.now ?? new Date()
    const today = utcDay(now)
    const page = 500
    const report: CountryHintReport = { checked: 0, changed: 0, rows: [] }
    let lastId: ObjectId | null = null

    for (;;) {
      const filter: Record<string, unknown> = lastId ? { _id: { $gt: lastId } } : {}
      const rows = await users()
        .find(filter, { projection: { phone: 1, country_hint: 1, country_hint_day: 1 } })
        .sort({ _id: 1 })
        .limit(page)
        .toArray() as unknown as HintRow[]
      if (rows.length === 0) break
      lastId = rows[rows.length - 1]._id

      const locales = await latestLocales(rows.map((row) => row._id), now)
      for (const row of rows) {
        report.checked++
        const { hint, changed } = hintFor(row, locales)
        if (!changed) continue
        report.changed++
        report.rows.push({ id: String(row._id), code: hint?.code ?? null, source: hint?.source ?? null })
        if (!opts.apply) continue
        try {
          await users().updateOne(
            { _id: row._id },
            { $set: { ...(hint ? { country_hint: hint } : {}), country_hint_day: today } },
          )
        } catch (error) {
          log.error('internal_accounts.country_hint_backfill_failed', { error: errorMessage(error) })
        }
      }
      if (rows.length < page) break
    }

    return report
  },
}
