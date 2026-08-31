import { mongoColl } from '../config/mongo'
import { log } from '../utils/logger'
import { cloudflareAnalyticsService } from './cloudflare-analytics.service'

/**
 * A permanent daily record of the marketing site, folded from two forgetful
 * sources.
 *
 * Cloudflare answers seven days and then returns empty; our own raw events are
 * deleted after 180. Neither can tell you whether this month beat last month,
 * and by the time you want to know, the numbers are gone — so each day is
 * written down once, as counts, and kept.
 *
 * Rolling a day again overwrites it, which is what makes this safe to run on a
 * schedule and again on demand: today's row is rewritten as today happens, and
 * a day that has closed stops changing.
 */
export const webTrafficRollupService = {
  /** UTC calendar day for an instant, `YYYY-MM-DD`. */
  dayOf(when: Date = new Date()): string {
    return when.toISOString().slice(0, 10)
  },

  /**
   * Write one day.
   *
   * Cloudflare's half is skipped rather than zeroed when the day has aged out of
   * their window: a row that says "we do not know" keeps its meaning, while a
   * zero would quietly become "nobody came".
   */
  async rollupDay(day: string) {
    const start = new Date(`${day}T00:00:00Z`)
    const end = new Date(start.getTime() + 86_400_000)

    const grouped = await mongoColl
      .webEvents()
      .aggregate([
        { $match: { created_at: { $gte: start, $lt: end } } },
        { $group: { _id: { name: '$name', session: '$session' }, hits: { $sum: 1 } } },
        { $group: { _id: '$_id.name', events: { $sum: '$hits' }, sessions: { $sum: 1 } } },
      ])
      .toArray()

    const byName: Record<string, { events: number; sessions: number }> = {}
    for (const row of grouped) {
      byName[row._id as string] = { events: row.events as number, sessions: row.sessions as number }
    }

    const [sessions, reachedPlay] = await Promise.all([
      mongoColl.webEvents().distinct('session', { created_at: { $gte: start, $lt: end } }),
      mongoColl.webEvents().distinct('session', {
        created_at: { $gte: start, $lt: end },
        name: 'access_step_click',
        'props.step': 'install',
      }),
    ])

    const cf = await cloudflareAnalyticsService.day(day)

    await mongoColl.webTrafficDaily().updateOne(
      { _id: day },
      {
        $set: {
          day,
          ours: { sessions: sessions.length, reached_play: reachedPlay.length, by_name: byName },
          updated_at: new Date(),
          ...(cf
            ? {
                cloudflare: {
                  page_views: cf.page_views,
                  visits: cf.visits,
                  referrers: cf.referrers,
                  countries: cf.countries,
                  paths: cf.paths,
                  devices: cf.devices,
                },
              }
            : {}),
        },
      },
      { upsert: true },
    )

    return { day, sessions: sessions.length, cloudflare: Boolean(cf) }
  },

  /**
   * Roll today and the days just behind it.
   *
   * More than one day because both sources settle late — Cloudflare aggregates
   * behind live, and a visit at 23:59 lands in a row we may already have
   * written. Re-writing a recent day is cheap and idempotent.
   */
  async rollupRecent(days = 3) {
    const out = []
    for (let back = 0; back < days; back++) {
      const day = this.dayOf(new Date(Date.now() - back * 86_400_000))
      try {
        out.push(await this.rollupDay(day))
      } catch (error) {
        log.error('web traffic rollup failed', {
          day,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
    return out
  },

  /**
   * The stored history for a range, oldest first.
   *
   * This is the honest long view: every day since the rollup started, whatever
   * either source has since forgotten.
   */
  async series(days: number) {
    const from = this.dayOf(new Date(Date.now() - (days - 1) * 86_400_000))
    const rows = await mongoColl
      .webTrafficDaily()
      .find({ _id: { $gte: from } })
      .sort({ _id: 1 })
      .toArray()

    return rows.map((row) => ({
      day: row.day,
      page_views: row.cloudflare?.page_views ?? null,
      visits: row.cloudflare?.visits ?? null,
      sessions: row.ours?.sessions ?? 0,
      reached_play: row.ours?.reached_play ?? 0,
      events: Object.fromEntries(
        Object.entries(row.ours?.by_name || {}).map(([name, b]) => [name, b.events]),
      ),
    }))
  },

  /**
   * Totals across the stored range.
   *
   * Page views are summed only over the days that actually carry a Cloudflare
   * figure, and the count of those days is returned with it — so a month that
   * only has traffic data for its last week says so instead of quietly
   * under-reporting.
   */
  async totals(days: number) {
    const series = await this.series(days)
    const withCf = series.filter((d) => d.page_views !== null)
    return {
      from: series[0]?.day ?? null,
      to: series[series.length - 1]?.day ?? null,
      days_recorded: series.length,
      page_views: withCf.reduce((sum, d) => sum + (d.page_views || 0), 0),
      visits: withCf.reduce((sum, d) => sum + (d.visits || 0), 0),
      page_view_days: withCf.length,
      // Deliberately not called "sessions": a visitor who came back on Tuesday
      // and Thursday is two session-days and one person. The true distinct
      // count over a window comes from the raw events while they still exist;
      // this is the number that survives them.
      session_days: series.reduce((sum, d) => sum + d.sessions, 0),
      reached_play_days: series.reduce((sum, d) => sum + d.reached_play, 0),
    }
  },
}
