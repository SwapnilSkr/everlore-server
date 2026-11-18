import type { ObjectId } from 'mongodb'
import { mongoColl } from '../config/mongo'
import { HttpError } from '../utils/http-error'
import { idString } from '../utils/mongo-id'
import { DAY_MS, dayExpressionOn, mondayOf, mondaySeries } from './admin-insights'
import { ACCOUNTS_HIDDEN, accountScope, type AccountFilter } from './reviewer-accounts'

/**
 * `GET /admin/overview/retention` (`everlore-docs/phases/admin-insights.md`,
 * "Contract, part 2").
 *
 * Cohorts are signup weeks starting Monday UTC; `active[k]` counts the cohort's
 * players with an app session in week k, with k = 0 the signup week. A week that
 * has not begun yet is `null`, so the console leaves the cell blank instead of
 * drawing a zero.
 *
 * The read is bounded twice over: `users` by `created_at` (its `idx_users_created`
 * index) and `app_sessions` by `started_at` for exactly those cohort ids
 * (`idx_app_sessions_user_started`). `app_sessions` expires after 90 days, which
 * is why the contract caps this at 12 weeks.
 */

const MIN_WEEKS = 4
const MAX_WEEKS = 12
const DEFAULT_WEEKS = 8
const WEEK_MS = 7 * DAY_MS

export function retentionWeeks(value?: string): number {
  if (value === undefined || value === '') return DEFAULT_WEEKS
  const weeks = Number(value)
  if (!/^\d+$/.test(value) || !Number.isInteger(weeks) || weeks < MIN_WEEKS || weeks > MAX_WEEKS) {
    throw new HttpError(400, `Weeks must be a whole number between ${MIN_WEEKS} and ${MAX_WEEKS}.`)
  }
  return weeks
}

type CohortUser = { _id: ObjectId; created_at: Date }

/** Whether any stored session-start day falls in `[start, end)`. */
function hasDayInRange(days: Set<string>, start: number, end: number): boolean {
  for (const day of days) {
    const at = Date.parse(`${day}T00:00:00.000Z`)
    if (at >= start && at < end) return true
  }
  return false
}

export const retentionInsights = {
  async retention(weeksValue?: string, now = new Date(), accounts: AccountFilter = ACCOUNTS_HIDDEN) {
    const weeks = retentionWeeks(weeksValue)
    const mondays = mondaySeries(weeks, now)
    const from = new Date(`${mondays[0]}T00:00:00.000Z`)
    // Midnight UTC of today: a week beginning after it has not been reached.
    const todayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())

    // Non-player accounts are out of both the signups and the activity they
    // would otherwise contribute, unless the operator asked to see them.
    const { userIds, only } = await accountScope(accounts)
    const accountMatch = only
      ? { _id: { $in: userIds } }
      : userIds.length > 0 ? { _id: { $nin: userIds } } : {}
    const cohortUsers = await mongoColl.users()
      .find(
        { created_at: { $gte: from, $lte: now }, ...accountMatch },
        { projection: { _id: 1, created_at: 1 } },
      )
      .toArray() as unknown as CohortUser[]
    const playerIds = cohortUsers.map((user) => user._id)

    // One read for every cohort's sessions: the (player, day) pairs that were
    // active. Windowed by `started_at` and matched on the cohort ids, so it never
    // reads a session this page does not need.
    const sessionRows = playerIds.length === 0 ? [] : await mongoColl.appSessions().aggregate<{
      _id: { player: ObjectId; day: string }
    }>([
      { $match: { user_id: { $in: playerIds }, started_at: { $gte: from, $lte: now } } },
      { $group: { _id: { player: '$user_id', day: dayExpressionOn('started_at') } } },
    ]).toArray()

    const activeByPlayer = new Map<string, Set<string>>()
    for (const row of sessionRows) {
      const key = idString(row._id.player)
      const days = activeByPlayer.get(key) ?? new Set<string>()
      days.add(row._id.day)
      activeByPlayer.set(key, days)
    }

    const byMonday = new Map<string, CohortUser[]>()
    for (const user of cohortUsers) {
      const week = mondayOf(user.created_at)
      const list = byMonday.get(week) ?? []
      list.push(user)
      byMonday.set(week, list)
    }

    const cohorts = mondays.map((week) => {
      const users = byMonday.get(week) ?? []
      const weekStart = new Date(`${week}T00:00:00.000Z`).getTime()
      const active: Array<number | null> = []
      for (let k = 0; k < weeks; k++) {
        const start = weekStart + k * WEEK_MS
        if (start > todayStart) {
          active.push(null)
          continue
        }
        const end = Math.min(start + WEEK_MS, todayStart + DAY_MS)
        let count = 0
        for (const user of users) {
          const days = activeByPlayer.get(idString(user._id))
          if (days && hasDayInRange(days, start, end)) count++
        }
        active.push(count)
      }
      return { week, signups: users.length, active }
    })

    return { weeks, cohorts }
  },
}
