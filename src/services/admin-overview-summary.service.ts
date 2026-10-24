import { mongoColl } from '../config/mongo'
import { STORY_TURN_TYPES } from './admin-activity'
import { traceStore } from './llm-trace.service'

const DAY_MS = 86_400_000

/** A player counts as live when they were seen in the last ten minutes. */
const LIVE_WINDOW_MS = 10 * 60_000

/** Fixed wording until the data exists, so the console never has to invent a reason. */
const NO_CALLS_REASON = 'No model calls recorded today.'
const ERROR_RATE_REASON = "Error tracking isn't built yet."

/** Midnight UTC of the day `now` falls in — the day the summary counts. */
export function utcDayStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
}

export interface OverviewSummary {
  generated_at: string
  live_players: number
  turns_today: number
  turns_yesterday_same_time: number
  spend_today_usd: number | null
  spend_reason: string | null
  error_rate: number | null
  error_rate_reason: string | null
}

/** Today's model spend, from the per-call traces. Kept apart so the audit can fake it. */
export interface SpendWindow { usd: number; calls: number; unpriced: number }
export type SpendReader = (from: Date, to: Date) => Promise<SpendWindow>

const liveSpend: SpendReader = async (from, to) => {
  const [row] = await traceStore().calls.aggregate<SpendWindow>([
    { $match: { created_at: { $gte: from, $lte: to } } },
    { $group: {
      _id: null,
      usd: { $sum: { $ifNull: ['$cost_usd', 0] } },
      calls: { $sum: 1 },
      unpriced: { $sum: { $cond: [{ $eq: [{ $type: '$cost_usd' }, 'missing'] }, 1, 0] } },
    } },
  ]).toArray()
  return row ?? { usd: 0, calls: 0, unpriced: 0 }
}

/** No calls is shown as no figure, not $0: before the traces deploy, or with the
 *  trace writer failing, a zero would look like a free day. */
function spendFields(spend: SpendWindow): Pick<OverviewSummary, 'spend_today_usd' | 'spend_reason'> {
  if (spend.calls === 0) return { spend_today_usd: null, spend_reason: NO_CALLS_REASON }
  return {
    spend_today_usd: Math.round(spend.usd * 10_000) / 10_000,
    // Some providers don't report a price on every call; say the figure is a floor.
    spend_reason: spend.unpriced > 0 ? `${spend.unpriced} of ${spend.calls} calls had no reported price.` : null,
  }
}

export const adminOverviewSummaryService = {
  async summary(now: Date = new Date(), readSpend: SpendReader = liveSpend): Promise<OverviewSummary> {
    const todayStart = utcDayStart(now)
    const yesterdayStart = new Date(todayStart.getTime() - DAY_MS)
    // The same time of day yesterday: "today so far" compared with "yesterday by
    // now", not a whole yesterday, so a running day never looks like a drop.
    const yesterdaySameTime = new Date(now.getTime() - DAY_MS)

    const turnFilter = { type: { $in: STORY_TURN_TYPES } }
    const [livePlayers, turnsToday, turnsYesterday, spend] = await Promise.all([
      // One document per player, so counting documents counts distinct players.
      mongoColl.users().countDocuments({ last_active_at: { $gte: new Date(now.getTime() - LIVE_WINDOW_MS) } }),
      mongoColl.events().countDocuments({ ...turnFilter, created_at: { $gte: todayStart, $lte: now } }),
      mongoColl.events().countDocuments({ ...turnFilter, created_at: { $gte: yesterdayStart, $lte: yesterdaySameTime } }),
      readSpend(todayStart, now),
    ])

    return {
      generated_at: now.toISOString(),
      live_players: livePlayers,
      turns_today: turnsToday,
      turns_yesterday_same_time: turnsYesterday,
      ...spendFields(spend),
      error_rate: null,
      error_rate_reason: ERROR_RATE_REASON,
    }
  },
}
