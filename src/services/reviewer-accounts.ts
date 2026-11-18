import type { ObjectId } from 'mongodb'
import { env } from '../config/env'
import { mongoColl } from '../config/mongo'
import { normalizePhone } from '../providers/auth.provider'
import { HttpError } from '../utils/http-error'
import { log } from '../utils/logger'

/**
 * Accounts that exist only for Google Play's review and pre-launch testing, and
 * — since part 2b — the team's own accounts.
 *
 * Both keep every feature (a reviewer must be able to use the app, and the team
 * tests with its own logins), but neither is a player, and the console's player
 * numbers must not include them. Two structural rules catch reviewers, and
 * nothing here is a word list:
 *
 *  - `review_phone`: the account's phone is the review credential's number.
 *  - `number_name`: the display name is shaped like a phone number. Reviewers
 *    type the number from the review instructions into the name field.
 *
 * Internal accounts are flagged by their own module (`internal-accounts.ts`) and
 * join the scope through `internal: true`, so every `reviewers=exclude|include|
 * only` filter covers both with one read. The parameter keeps its name; the
 * console calls it "Test and team accounts".
 *
 * A reviewer flag is sticky: nothing in this module ever removes it. A flag is
 * written as `reviewer: true`; an unflagged account has no key at all, never
 * `false`.
 */

export type ReviewerReason = 'review_phone' | 'number_name'
export type ReviewersMode = 'exclude' | 'include' | 'only'
export type ReviewerScope = { userIds: ObjectId[]; installIds: string[] }

/**
 * The three kinds of non-player account, from fields that already exist.
 *
 *  - `review`: `reviewer: true` (Google Play's review logins).
 *  - `team`: `internal: true`, any reason but `test_phone` (owner, official, manual).
 *  - `test`: `internal: true` with `internal_reason: 'test_phone'`.
 *
 * An account is in exactly one kind, and review wins when both flags are set:
 * Google provisioned it as a reviewer, whatever a rule tagged it with later.
 */
export const ACCOUNT_KINDS = ['review', 'team', 'test'] as const
export type AccountKind = (typeof ACCOUNT_KINDS)[number]

/**
 * Which kinds the operator asked to see, and whether the read should contain
 * **only** those. Empty and `only: false` is the default: no non-player account
 * is a player, so all three are left out of every player number.
 */
export type AccountFilter = { show: Set<AccountKind>; only: boolean }

export const ACCOUNTS_HIDDEN: AccountFilter = { show: new Set(), only: false }
/** Every kind shown: the old `reviewers=include`. */
export const ACCOUNTS_SHOWN: AccountFilter = { show: new Set(ACCOUNT_KINDS), only: false }
/** Every kind and nothing else: the old `reviewers=only`. */
export const ACCOUNTS_ONLY: AccountFilter = { show: new Set(ACCOUNT_KINDS), only: true }

/**
 * The accounts a read covers: the ids to leave out (the default), or with
 * `only`, the ids to keep. `kindByUser`/`kindByInstall` let a row say which kind
 * it is, so the console can tag it.
 */
export type AccountScope = { userIds: ObjectId[]; installIds: string[]; only: boolean }

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

/** Which kind of non-player account this row is, or null for a player. */
export function accountKind(row: {
  reviewer?: unknown
  internal?: unknown
  internal_reason?: unknown
}): AccountKind | null {
  if (row.reviewer === true) return 'review'
  if (row.internal === true) return row.internal_reason === 'test_phone' ? 'test' : 'team'
  return null
}

/**
 * The `users` match for one kind. The three are mutually exclusive here, so a
 * row with both flags is a review account and never also a team one.
 */
function kindMatch(kind: AccountKind): Record<string, unknown> {
  if (kind === 'review') return { reviewer: true }
  if (kind === 'test') {
    return { internal: true, reviewer: { $ne: true }, internal_reason: 'test_phone' }
  }
  // A team account is internal with any other reason — including none at all.
  return { internal: true, reviewer: { $ne: true }, internal_reason: { $ne: 'test_phone' } }
}

/** The `users` match for a set of kinds; `null` when the set is empty. */
export function accountKindMatch(kinds: Iterable<AccountKind>): Record<string, unknown> | null {
  const clauses = [...kinds].map(kindMatch)
  if (clauses.length === 0) return null
  return clauses.length === 1 ? clauses[0] : { $or: clauses }
}

function parseShow(value?: string): AccountKind[] {
  if (value === undefined || value.trim() === '') return []
  const out: AccountKind[] = []
  for (const part of value.split(',')) {
    const name = part.trim()
    if (!name) continue
    if (!(ACCOUNT_KINDS as readonly string[]).includes(name)) {
      throw new HttpError(400, 'Show must name review, team or test accounts.')
    }
    if (!out.includes(name as AccountKind)) out.push(name as AccountKind)
  }
  return out
}

/**
 * The one parser for a player read's account choice.
 *
 * `show` is a comma list of the kinds to include, and `only` (the string `1`)
 * says the read should contain only those. The old `reviewers` parameter keeps
 * working: `include` is every kind shown, `only` is that plus `only=1`, and
 * `exclude` is the default. When both are given, `show`/`only` win, so the
 * console can move to the new pair without a transition.
 */
export function accountFilter(showValue?: string, onlyValue?: string, reviewersValue?: string): AccountFilter {
  if (showValue === undefined && onlyValue === undefined) {
    const mode = reviewersParam(reviewersValue)
    return {
      show: new Set(mode === 'exclude' ? [] : ACCOUNT_KINDS),
      only: mode === 'only',
    }
  }
  let only = false
  if (onlyValue !== undefined && onlyValue !== '') {
    if (onlyValue !== '1') throw new HttpError(400, 'Only must be 1.')
    only = true
  }
  const show = parseShow(showValue)
  if (only && show.length === 0) {
    throw new HttpError(400, 'Choose at least one kind of account to show when only those are wanted.')
  }
  return { show: new Set(show), only }
}

/** A stable cache key for a filter: the kinds plus the direction. */
export function accountScopeKey(filter: AccountFilter): string {
  const kinds = ACCOUNT_KINDS.filter((kind) => filter.show.has(kind))
  return `${kinds.join(',')}|${filter.only ? 'only' : 'hidden'}`
}

const SCOPE_TTL_MS = 60_000
let cached: { at: number; value: ReviewerScope } | null = null
let pending: Promise<ReviewerScope> | null = null
const accountScopes = new Map<string, { at: number; value: AccountScope }>()
const accountPending = new Map<string, Promise<AccountScope>>()

/** Audits need a fresh read after they change a row. */
export function resetReviewerScopeCache(): void {
  cached = null
  pending = null
  accountScopes.clear()
  accountPending.clear()
}

async function loadScope(): Promise<{ scope: ReviewerScope; cached: boolean }> {
  let rows: Array<{ _id: ObjectId; install_id?: string }>
  try {
    rows = await mongoColl.users()
      // Review accounts and the team's own accounts, in one read: the filters
      // that use this scope mean "not a real player", not "flagged as a reviewer".
      .find({ $or: [{ reviewer: true }, { internal: true }] }, { projection: { _id: 1, install_id: 1 } })
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

/**
 * The accounts one filter covers, with their installs.
 *
 * The default covers every kind, i.e. every id a player number must leave out.
 * `show` narrows that set to the kinds not shown, and `only` turns it around:
 * the ids returned are then the ones to keep. One cached read per filter, a
 * minute at a time, so a console page with six panels is still one query.
 */
async function loadAccountScope(filter: AccountFilter): Promise<{ scope: AccountScope; cached: boolean }> {
  const kinds = scopeKinds(filter)
  const match = accountKindMatch(kinds)
  const empty: AccountScope = { userIds: [], installIds: [], only: filter.only }
  if (!match) return { scope: empty, cached: true }

  let rows: Array<{ _id: ObjectId; install_id?: string }>
  try {
    rows = await mongoColl.users()
      .find(match, { projection: { _id: 1, install_id: 1 } })
      .toArray()
  } catch (error) {
    // Same trade as the unfiltered scope: log at error, cache nothing, and show
    // the page rather than take it down for one call.
    log.error('accounts.scope_unavailable', {
      error: error instanceof Error ? error.message : String(error),
    })
    return { scope: empty, cached: false }
  }

  const userIds = rows.map((row) => row._id)
  const installIds = new Set<string>()
  for (const row of rows) {
    // An account's own install is the device its first sign-in came from.
    if (typeof row.install_id === 'string' && row.install_id) installIds.add(row.install_id)
  }
  if (userIds.length > 0) {
    const installs = await mongoColl.appInstalls()
      .find({ user_ids: { $in: userIds } }, { projection: { _id: 1 } })
      .toArray()
    for (const row of installs) installIds.add(String(row._id))
  }
  return { scope: { userIds, installIds: [...installIds], only: filter.only }, cached: true }
}

/**
 * The ids a read covers for `filter`. Cached per filter key; `only` says which
 * direction the caller must apply them in.
 */
export async function accountScope(filter: AccountFilter = ACCOUNTS_HIDDEN): Promise<AccountScope> {
  const key = accountScopeKey(filter)
  const hit = accountScopes.get(key)
  if (hit && Date.now() - hit.at < SCOPE_TTL_MS) return hit.value
  const running = accountPending.get(key)
  if (running) return running
  const work = loadAccountScope(filter).then((result) => {
    if (result.cached) accountScopes.set(key, { at: Date.now(), value: result.scope })
    return result.scope
  }).finally(() => { accountPending.delete(key) })
  accountPending.set(key, work)
  return work
}

/** Whether a read asked for nothing special, i.e. must equal the old default exactly. */
export function isDefaultAccountFilter(filter: AccountFilter): boolean {
  return filter.show.size === 0 && !filter.only
}

/**
 * The kinds a filter's scope covers: the shown ones with `only`, otherwise the
 * ones left out. This is the single definition both the id scope and a list's
 * own field filter are built from.
 */
export function scopeKinds(filter: AccountFilter): AccountKind[] {
  return ACCOUNT_KINDS.filter((kind) => (filter.only ? filter.show.has(kind) : !filter.show.has(kind)))
}

/**
 * The kinds a set of accounts belong to, for tagging rows in a list. One read,
 * no cache: a page of rows is bounded and its ids change with every request.
 */
export async function accountKindsByIds(ids: ObjectId[]): Promise<Map<string, AccountKind>> {
  const unique = [...new Map(ids.map((id) => [String(id), id])).values()]
  if (unique.length === 0) return new Map()
  const rows = await mongoColl.users()
    .find({ _id: { $in: unique } }, { projection: { reviewer: 1, internal: 1, internal_reason: 1 } })
    .toArray()
  const out = new Map<string, AccountKind>()
  for (const row of rows) {
    const kind = accountKind(row)
    if (kind) out.set(String(row._id), kind)
  }
  return out
}

/**
 * The kinds the accounts behind a set of installs belong to, for tagging a row
 * that carries no account. An install can name its accounts two ways: the
 * install rows' `user_ids`, and a user document's own `install_id`.
 */
export async function accountKindsForInstalls(installIds: string[]): Promise<Map<string, AccountKind>> {
  const ids = [...new Set(installIds.filter(Boolean))]
  const out = new Map<string, AccountKind>()
  if (ids.length === 0) return out
  const [own, installs] = await Promise.all([
    mongoColl.users()
      .find({ install_id: { $in: ids } }, { projection: { install_id: 1, reviewer: 1, internal: 1, internal_reason: 1 } })
      .toArray(),
    mongoColl.appInstalls()
      .find({ _id: { $in: ids }, user_ids: { $exists: true } }, { projection: { user_ids: 1 } })
      .toArray(),
  ])
  for (const row of own) {
    const kind = accountKind(row)
    if (kind && typeof row.install_id === 'string') out.set(row.install_id, kind)
  }
  const kindByUser = await accountKindsByIds(
    installs.flatMap((row) => (row.user_ids ?? []) as ObjectId[]),
  )
  for (const row of installs) {
    // A shared device takes the first kind found; the tag is decoration.
    for (const userId of (row.user_ids ?? []) as ObjectId[]) {
      const kind = kindByUser.get(String(userId))
      if (kind) { out.set(String(row._id), kind); break }
    }
  }
  return out
}

/** The `users` match for a filter's scope: everyone in the kinds with `only`, everyone outside them otherwise. */
export function accountScopeMatch(filter: AccountFilter): Record<string, unknown> {
  const clauses = scopeKinds(filter).map(kindMatch)
  if (clauses.length === 0) return filter.only ? { _id: { $in: [] } } : {}
  return filter.only ? { $or: clauses } : { $nor: clauses }
}

export const reviewerAccounts = {
  /** Flag every matching account that is not flagged yet; returns how many. */
  async sweep(): Promise<number> {
    const result = await mongoColl.users().updateMany(reviewerSweepFilter(), reviewerSweepUpdate(new Date()))
    if (result.modifiedCount > 0) resetReviewerScopeCache()
    return result.modifiedCount
  },

  /**
   * The ids to leave out of player numbers: review and team accounts, every
   * install they signed in on, and their own install. Small enough to hold in
   * memory, and cached for a minute so one console page is one read.
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
