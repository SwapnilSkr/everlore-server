/**
 * One day of marketing-site traffic, kept forever.
 *
 * Both sources it draws from forget: Cloudflare answers seven days and stops,
 * and our own raw events expire after 180. Neither is a place to keep a year of
 * history, so each day is folded into a single row here and never expires — a
 * few hundred bytes a day buys month-over-month numbers that stay true.
 *
 * It holds counts and nothing else. There is no session id, no address, no
 * account: by the time a day lands here it is already a statistic.
 */
export type WebTrafficDailyDoc = {
  /** The day itself, `YYYY-MM-DD` in UTC, which is also the primary key. */
  _id: string
  day: string
  /** Cloudflare's beacon. Absent for days rolled up after their window closed. */
  cloudflare?: {
    page_views: number
    visits: number
    referrers: Array<{ label: string; views: number }>
    countries: Array<{ label: string; views: number }>
    paths: Array<{ label: string; views: number }>
    devices: Array<{ label: string; views: number }>
  }
  /** Our own beacon: distinct sessions and per-event counts for the day. */
  ours: {
    sessions: number
    reached_play: number
    by_name: Record<string, { events: number; sessions: number }>
  }
  updated_at: Date
}
