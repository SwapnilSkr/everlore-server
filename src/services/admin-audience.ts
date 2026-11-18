import { ObjectId } from 'mongodb'
import { mongoColl } from '../config/mongo'
import { idString } from '../utils/mongo-id'
import { ACCOUNTS_HIDDEN, accountScope, type AccountFilter } from './reviewer-accounts'
import { signInOf, type SignIn } from './admin-insights-players'
import {
  countryOfUser,
  dayExpressionOn,
  events,
  insightDays,
  personGender,
  sessionScope,
  storyTurnMatch,
  windowStart,
  type CountrySource,
  type PersonGender,
} from './admin-insights'

/**
 * `GET /admin/audience` (`everlore-docs/phases/admin-insights.md`, "Contract,
 * part 2").
 *
 * The population is the accounts with an app session that started in the window:
 * someone who never opened the app is not an audience. Guests are included, and
 * review, team and test accounts follow the operator's choice as everywhere else.
 *
 * Every read is bounded: `app_sessions` by `started_at` (its
 * `idx_app_sessions_started` index), and the per-player engagement reads by the
 * ids of the population just read.
 */

const appSessions = () => mongoColl.appSessions()
const users = () => mongoColl.users()
const worldInstances = () => mongoColl.worldInstances()
const worldTemplates = () => mongoColl.worldTemplates()

export type EngagementGender = 'male' | 'female' | 'nonbinary' | 'unset'

type GenderKey = PersonGender | 'unset'

type AudienceUser = {
  _id: ObjectId
  username?: string
  guest?: boolean
  providers?: string[]
  country?: string
  country_hint?: { code?: string; source?: 'locale' | 'phone' }
  preferences?: { gender?: string; interests?: string[]; nsfw_enabled?: boolean }
}

/**
 * The accounts with a session that started in the window.
 *
 * `app_sessions` answers `user_id` for every signed-in session; a session with no
 * account belongs to a guest install, which has no `users` row and so is not part
 * of the population the contract describes.
 */
async function population(from: Date, scope: Record<string, unknown>[]): Promise<ObjectId[]> {
  const match: Record<string, unknown> = { started_at: { $gte: from }, user_id: { $exists: true } }
  const filter = scope.length > 0 ? { $and: [match, ...scope] } : match
  const ids = await appSessions().distinct('user_id', filter)
  return ids.filter((id): id is ObjectId => id instanceof ObjectId)
}

/** Each player's latest session in the window, for the device and version counts. */
type LatestSession = { app_version?: string; device?: { model?: string; os_version?: string; form?: string } }

async function latestSessions(playerIds: ObjectId[], from: Date, now: Date) {
  if (playerIds.length === 0) return new Map<string, LatestSession>()
  const rows = await appSessions().aggregate<{
    _id: ObjectId
    app_version?: string
    device?: LatestSession['device']
  }>([
    { $match: { user_id: { $in: playerIds }, started_at: { $gte: from, $lte: now } } },
    // `user_id, started_at` is the sessions index, so this is one ordered read.
    { $sort: { started_at: -1 } },
    { $group: { _id: '$user_id', app_version: { $first: '$app_version' }, device: { $first: '$device' } } },
  ]).toArray()
  return new Map(rows.map((row) => [idString(row._id), { app_version: row.app_version, device: row.device }]))
}

/** Where a player's signup day sits relative to `now`, in whole UTC days. */
function daysSince(date: Date, now: Date): number {
  const day = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  return Math.round((today - day) / 86_400_000)
}

type ReturnCohort = { eligible: number; returned: number }

/**
 * The day-1 and day-7 return cohorts of one gender.
 *
 * `return_d1`: eligible if the signup UTC day is before today; returned if an app
 * session started on the next UTC day. `return_d7`: eligible if signup + 7 is
 * today or earlier; returned if a session started on any of signup + 7 through
 * signup + 13, counting only days up to today.
 *
 * `sessionsByPlayerDay` holds `playerId → Set<YYYY-MM-DD>` of session starts, so
 * the test is a set lookup per account rather than a query per cohort.
 */
function returnCohorts(
  signups: Array<{ id: ObjectId; created_at: Date }>,
  sessionsByPlayerDay: Map<string, Set<string>>,
  now: Date,
): { d1: ReturnCohort; d7: ReturnCohort } {
  const d1 = { eligible: 0, returned: 0 }
  const d7 = { eligible: 0, returned: 0 }
  for (const player of signups) {
    const since = daysSince(player.created_at, now)
    const days = sessionsByPlayerDay.get(idString(player.id))
    const signupDay = player.created_at.toISOString().slice(0, 10)
    const startOfSignup = new Date(`${signupDay}T00:00:00.000Z`).getTime()
    const at = (offset: number) => new Date(startOfSignup + offset * 86_400_000).toISOString().slice(0, 10)

    if (since >= 1) {
      d1.eligible++
      if (days?.has(at(1))) d1.returned++
    }
    if (since >= 7) {
      d7.eligible++
      // Days signup + 7 .. signup + 13, but never a day after today.
      for (let offset = 7; offset <= 13 && offset <= since; offset++) {
        if (days?.has(at(offset))) { d7.returned++; break }
      }
    }
  }
  return { d1, d7 }
}

/** Session-start days per account, over the window, keyed by player id. */
async function sessionDaysByPlayer(playerIds: ObjectId[], from: Date, now: Date) {
  const out = new Map<string, Set<string>>()
  if (playerIds.length === 0) return out
  const rows = await appSessions().aggregate<{ _id: { player: ObjectId; day: string } }>([
    { $match: { user_id: { $in: playerIds }, started_at: { $gte: from, $lte: now } } },
    { $group: { _id: { player: '$user_id', day: dayExpressionOn('started_at') } } },
  ]).toArray()
  for (const row of rows) {
    const key = idString(row._id.player)
    const days = out.get(key) ?? new Set<string>()
    days.add(row._id.day)
    out.set(key, days)
  }
  return out
}

/** The genres of the worlds the population played in the window, per player. */
async function genresByPlayer(
  playerIds: ObjectId[],
  from: Date,
  now: Date,
  scope: Record<string, unknown>[],
): Promise<Map<string, Set<string>>> {
  const out = new Map<string, Set<string>>()
  if (playerIds.length === 0) return out
  const match: Record<string, unknown> = { player_id: { $in: playerIds }, 'meta.last_active_at': { $gte: from, $lte: now } }
  const saves = await worldInstances()
    .find(scope.length > 0 ? { $and: [match, ...scope] } : match, { projection: { player_id: 1, template_id: 1, group_template_id: 1 } })
    .toArray()
  if (saves.length === 0) return out
  const templateIds = [...new Map(saves
    .map((save) => save.group_template_id ?? save.template_id)
    .filter((id): id is ObjectId => id instanceof ObjectId)
    .map((id) => [idString(id), id])).values()]
  const templates = await worldTemplates()
    .find({ _id: { $in: templateIds } }, { projection: { genre: 1 } })
    .toArray()
  const genreByTemplate = new Map(templates.map((row) => [idString(row._id), row.genre]))
  for (const save of saves) {
    const templateId = save.group_template_id ?? save.template_id
    if (!templateId) continue
    // A world with no genre is left out, per the contract.
    const genre = genreByTemplate.get(idString(templateId))
    if (!genre) continue
    const key = idString(save.player_id)
    const genres = out.get(key) ?? new Set<string>()
    genres.add(String(genre))
    out.set(key, genres)
  }
  return out
}

function ranked(counts: Map<string, number>, field: 'key' | 'code' | 'model' | 'version', limit?: number) {
  const rows = [...counts.entries()]
    .map(([key, players]) => ({ [field]: key, players }))
    .sort((left, right) => right.players - left.players || String(left[field]).localeCompare(String(right[field])))
  return limit === undefined ? rows : rows.slice(0, limit)
}

export const audienceInsights = {
  async audience(daysValue?: string, accounts: AccountFilter = ACCOUNTS_HIDDEN, now = new Date()) {
    const days = insightDays(daysValue)
    const from = windowStart(days, now)
    const scope = await sessionScope(accounts)

    const playerIds = await population(from, scope)
    const userRows = playerIds.length === 0
      ? []
      : await users().find({ _id: { $in: playerIds } }, {
        projection: {
          username: 1, guest: 1, providers: 1, country: 1, country_hint: 1,
          'preferences.gender': 1, 'preferences.interests': 1, 'preferences.nsfw_enabled': 1,
        },
      }).toArray() as unknown as AudienceUser[]

    const sessions = await latestSessions(playerIds, from, now)

    const gender: Record<GenderKey, number> = { male: 0, female: 0, nonbinary: 0, unset: 0 }
    const interests = new Map<string, number>()
    const adult = { on: 0, off: 0 }
    const signIn: Record<SignIn, number> = { google: 0, phone: 0, guest: 0, other: 0 }
    const countries = new Map<string, number>()
    const countrySources: Record<'connection' | 'phone' | 'phone_setting' | 'unknown', number> =
      { connection: 0, phone: 0, phone_setting: 0, unknown: 0 }
    let countryUnknown = 0
    const form = { phone: 0, tablet: 0, unknown: 0 }
    const models = new Map<string, number>()
    const osVersions = new Map<string, number>()
    const appVersions = new Map<string, number>()

    for (const user of userRows) {
      const key = idString(user._id)
      const playerGender = personGender(user.preferences?.gender)
      gender[playerGender ?? 'unset']++

      for (const interest of user.preferences?.interests ?? []) {
        if (typeof interest !== 'string' || !interest) continue
        interests.set(interest, (interests.get(interest) ?? 0) + 1)
      }
      if (user.preferences?.nsfw_enabled === true) adult.on++
      else adult.off++
      signIn[signInOf(user as never)]++

      // `country` from the connection, else the stored hint (part 2b); the
      // source split says how much of each list came from which signal.
      const place = countryOfUser(user)
      if (place.country) countries.set(place.country, (countries.get(place.country) ?? 0) + 1)
      else countryUnknown++
      countrySources[(place.source ?? 'unknown') as 'connection' | 'phone' | 'phone_setting' | 'unknown']++

      const latest = sessions.get(key)
      const latestForm = latest?.device?.form
      if (latestForm === 'phone' || latestForm === 'tablet') form[latestForm]++
      else form.unknown++
      const model = latest?.device?.model
      if (model) models.set(model, (models.get(model) ?? 0) + 1)
      const osVersion = latest?.device?.os_version
      if (osVersion) osVersions.set(osVersion, (osVersions.get(osVersion) ?? 0) + 1)
      const appVersion = latest?.app_version
      if (appVersion) appVersions.set(appVersion, (appVersions.get(appVersion) ?? 0) + 1)
    }

    // Engagement: the population's story turns, split by gender, and the returns
    // and genres of the accounts of that gender that signed up in the window.
    const turnRows = playerIds.length === 0 ? [] : await events().aggregate<{ _id: ObjectId; turns: number }>([
      { $match: { player_id: { $in: playerIds }, created_at: { $gte: from }, ...storyTurnMatch() } },
      { $group: { _id: '$player_id', turns: { $sum: 1 } } },
    ]).toArray()
    const turnsByPlayer = new Map(turnRows.map((row) => [idString(row._id), Number(row.turns ?? 0)]))
    const genderOf = new Map(userRows.map((user) => [idString(user._id), personGender(user.preferences?.gender)]))

    // The return cohort is "accounts created in the window", which is a wider set
    // than the audience: an account can be created after its only session. It is
    // read separately so the cohort is not narrowed by the population — but the
    // account choice still applies, as everywhere.
    const { userIds: accountIds, only } = await accountScope(accounts)
    const signupFilter: Record<string, unknown> = { created_at: { $gte: from, $lte: now } }
    // `only` keeps just the chosen kinds; otherwise they are dropped. An empty
    // set either way leaves the filter as it was.
    if (only) signupFilter._id = { $in: accountIds }
    else if (accountIds.length > 0) signupFilter._id = { $nin: accountIds }
    const signups = await users().find(
      signupFilter,
      { projection: { _id: 1, created_at: 1, 'preferences.gender': 1 } },
    ).toArray() as unknown as Array<{ _id: ObjectId; created_at: Date; preferences?: { gender?: string } }>
    const signupIds = signups.map((row) => row._id)
    const [signupSessionDays, genres] = await Promise.all([
      sessionDaysByPlayer(signupIds, from, now),
      genresByPlayer(playerIds, from, now, scope),
    ])

    const engagement = (['male', 'female', 'nonbinary', 'unset'] as const).map((key) => {
      const players = gender[key]
      let turns = 0
      for (const user of userRows) {
        if ((genderOf.get(idString(user._id)) ?? 'unset') !== key) continue
        turns += turnsByPlayer.get(idString(user._id)) ?? 0
      }
      const cohort = signups.filter((row) => (personGender(row.preferences?.gender) ?? 'unset') === key)
      const returns = returnCohorts(cohort.map((row) => ({ id: row._id, created_at: row.created_at })), signupSessionDays, now)
      const genreCounts = new Map<string, number>()
      for (const [playerId, playerGenres] of genres) {
        if ((genderOf.get(playerId) ?? 'unset') !== key) continue
        for (const genre of playerGenres) genreCounts.set(genre, (genreCounts.get(genre) ?? 0) + 1)
      }
      return {
        gender: key,
        players,
        turns,
        // 1 decimal, and 0 rather than NaN when a gender has no active player.
        turns_per_player: players > 0 ? Math.round((turns / players) * 10) / 10 : 0,
        return_d1: returns.d1,
        return_d7: returns.d7,
        genres: [...genreCounts.entries()]
          .map(([genre, count]) => ({ genre, players: count }))
          .sort((left, right) => right.players - left.players || left.genre.localeCompare(right.genre))
          .slice(0, 5),
      }
    })

    return {
      days,
      active_players: playerIds.length,
      gender,
      interests: ranked(interests, 'key'),
      adult,
      sign_in: signIn,
      // ISO country codes, most players first.
      countries: ranked(countries, 'code'),
      country_unknown: countryUnknown,
      country_sources: countrySources,
      devices: {
        form,
        models: ranked(models, 'model', 15),
        os_versions: ranked(osVersions, 'version'),
        app_versions: ranked(appVersions, 'version'),
      },
      engagement,
    }
  },
}

export type { GenderKey }
/** The contract's four engagement rows, in order. */
export const ENGAGEMENT_GENDERS = ['male', 'female', 'nonbinary', 'unset'] as const
