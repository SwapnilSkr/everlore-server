import { mongoColl } from '../config/mongo'
import { HttpError } from '../utils/http-error'
import { STORY_TURN_TYPES } from './admin-activity'
import { onboardingFacets, type OnboardingFacets } from './admin-onboarding'
import { readPlayInstalls } from './play-installs.service'

const DAY_MS = 86400_000
export function metricsDays(value?: string): number {
  if (value === undefined) return 30
  const days = Number(value)
  if (!/^\d+$/.test(value) || !Number.isInteger(days) || days < 7 || days > 180) {
    throw new HttpError(400, 'Days must be a whole number between 7 and 180.')
  }
  return days
}

export function utcDaySeries(days: number, now: Date) {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  return Array.from({ length: days }, (_, i) => ({
    date: new Date(today - (days - i - 1) * DAY_MS).toISOString().slice(0, 10),
    signups: 0, active_players: 0, story_turns: 0, new_saves: 0,
    installs: null as number | null,
  }))
}

type DayCount = { _id: string; count: number }
const dayExpression = { $dateToString: { format: '%Y-%m-%d', date: '$created_at', timezone: 'UTC' } }

export const adminMetricsService = {
  async metrics(value?: string) {
    const days = metricsDays(value)
    const now = new Date()
    const series = utcDaySeries(days, now)
    const since = new Date(series[0].date)
    const storyMatch = { type: { $in: STORY_TURN_TYPES } }
    const [users, saves, storyTotals, userWindow, newSaves, storyDaily, active, installs] = await Promise.all([
      mongoColl.users().countDocuments({}, { hint: '_id_' }),
      mongoColl.worldInstances().countDocuments({}, { hint: '_id_' }),
      mongoColl.events().aggregate<{ _id: null; players: number; turns: number }>([
        { $match: storyMatch },
        { $group: { _id: '$player_id', turns: { $sum: 1 } } },
        { $group: { _id: null, players: { $sum: 1 }, turns: { $sum: '$turns' } } },
      ], { hint: 'idx_events_type_created_player' }).toArray(),
      mongoColl.users().aggregate<OnboardingFacets & { signups: DayCount[] }>([
        { $match: { created_at: { $gte: since, $lte: now } } },
        { $facet: {
          signups: [{ $group: { _id: dayExpression, count: { $sum: 1 } } }],
          ...onboardingFacets(),
        } },
      ], { hint: 'idx_users_created' }).toArray(),
      mongoColl.worldInstances().aggregate<DayCount>([
        { $match: { created_at: { $gte: since, $lte: now } } },
        { $group: { _id: dayExpression, count: { $sum: 1 } } },
      ], { hint: 'idx_world_instances_created' }).toArray(),
      mongoColl.events().aggregate<{ _id: string; players: number; turns: number }>([
        { $match: { ...storyMatch, created_at: { $gte: since, $lte: now } } },
        { $group: { _id: { date: dayExpression, player: '$player_id' }, turns: { $sum: 1 } } },
        { $group: { _id: '$_id.date', players: { $sum: 1 }, turns: { $sum: '$turns' } } },
      ], { hint: 'idx_events_type_created_player' }).toArray(),
      mongoColl.events().aggregate<{ _id: null; dau: number; wau: number; mau: number }>([
        { $match: { ...storyMatch, created_at: { $gte: new Date(now.getTime() - 30 * DAY_MS), $lte: now } } },
        { $group: { _id: '$player_id', latest: { $max: '$created_at' } } },
        { $group: {
          _id: null,
          dau: { $sum: { $cond: [{ $gte: ['$latest', new Date(now.getTime() - DAY_MS)] }, 1, 0] } },
          wau: { $sum: { $cond: [{ $gte: ['$latest', new Date(now.getTime() - 7 * DAY_MS)] }, 1, 0] } },
          mau: { $sum: 1 },
        } },
      ], { hint: 'idx_events_type_created_player' }).toArray(),
      readPlayInstalls(),
    ])
    const onboarding = userWindow[0]
    const signupMap = new Map((onboarding?.signups ?? []).map((row) => [row._id, row.count]))
    const saveMap = new Map(newSaves.map((row) => [row._id, row.count]))
    const storyMap = new Map(storyDaily.map((row) => [row._id, row]))
    for (const day of series) {
      day.signups = signupMap.get(day.date) ?? 0
      day.new_saves = saveMap.get(day.date) ?? 0
      day.active_players = storyMap.get(day.date)?.players ?? 0
      day.story_turns = storyMap.get(day.date)?.turns ?? 0
      day.installs = installs.available ? installs.daily[day.date] ?? null : null
    }
    return {
      generated_at: now.toISOString(), days,
      totals: { users, players_ever: storyTotals[0]?.players ?? 0, saves, story_turns: storyTotals[0]?.turns ?? 0 },
      active: { dau: active[0]?.dau ?? 0, wau: active[0]?.wau ?? 0, mau: active[0]?.mau ?? 0 },
      series,
      onboarding: {
        ...(onboarding?.totals[0] ?? { new_users: 0, completed: 0, with_interests: 0 }),
        interests: onboarding?.interests ?? [], gender: onboarding?.gender ?? [], sign_in: onboarding?.sign_in ?? [],
      },
      installs: {
        available: installs.available, reason: installs.reason, last_updated: installs.last_updated,
        reason_kind: installs.reason_kind,
        total_user_installs: installs.available ? series.reduce((sum, day) => sum + (day.installs ?? 0), 0) : null,
      },
    }
  },
}
