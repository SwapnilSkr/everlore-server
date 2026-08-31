import { ObjectId } from 'mongodb'
import { mongoColl } from '../config/mongo'
import { COLLECTIONS } from '../models/collections'
import { log } from '../utils/logger'

/**
 * Interaction counting for the marketing site.
 *
 * The site is a static bundle on a CDN, so the only way to know whether anyone
 * walks the Play access ladder is for the page to say so. This is that endpoint:
 * unauthenticated by necessity, and therefore written as if the internet will
 * point a script at it, because it will.
 *
 * Three rules hold the shape:
 *   1. A closed vocabulary. An event name not on this list is dropped, so the
 *      collection can never be filled with arbitrary keys.
 *   2. Nothing identifying. No address, no account, no cookie, no free text —
 *      properties are short labels chosen from the page's own controls.
 *   3. Bounded everything. Field count, string length and rate are all capped.
 */
export const WEB_EVENT_NAMES = [
  /** Landing on a page. Cloudflare counts these too; ours carry the session. */
  'page_view',
  /** Any "Get beta access" button. props: { location } */
  'cta_click',
  /** One rung of the Play ladder went out. props: { step } */
  'access_step_click',
  /** A tier card asked for an upgrade. props: { tier } */
  'tier_request_click',
  /** The request form was sent. props: { ask } */
  'request_submitted',
] as const

export type WebEventName = (typeof WEB_EVENT_NAMES)[number]

const NAMES = new Set<string>(WEB_EVENT_NAMES)
const MAX_PROPS = 4
const MAX_VALUE = 40
const MAX_PATH = 120

/** Short, printable, no separators — anything else is not one of our labels. */
function label(value: unknown, max = MAX_VALUE): string | undefined {
  if (typeof value !== 'string') return undefined
  const clean = value.trim().slice(0, max)
  return /^[\w./?=+-]{1,120}$/.test(clean) ? clean : undefined
}

export const webEventService = {
  /**
   * Store one event, or quietly decide not to.
   *
   * Never throws and never explains itself to the caller: a beacon cannot read
   * the response, and a rejection that tells a script *why* it was rejected is
   * a free tutorial on getting past the filter.
   */
  async record(raw: unknown): Promise<void> {
    if (!raw || typeof raw !== 'object') return
    const input = raw as Record<string, unknown>

    const name = label(input.name)
    if (!name || !NAMES.has(name)) return

    const session = label(input.session, 36)
    if (!session) return

    const props: Record<string, string> = {}
    if (input.props && typeof input.props === 'object') {
      for (const [key, value] of Object.entries(input.props as Record<string, unknown>)) {
        if (Object.keys(props).length >= MAX_PROPS) break
        const k = label(key, 24)
        const v = label(value)
        if (k && v) props[k] = v
      }
    }

    try {
      await mongoColl.webEvents().insertOne({
        _id: new ObjectId(),
        name,
        path: label(input.path, MAX_PATH) || '/',
        session,
        // Host only. The full referrer can carry a search query, which is
        // somebody's words rather than a fact about our own funnel.
        referrer: label(input.referrer, 80),
        utm_source: label(input.utm_source),
        props: Object.keys(props).length ? props : undefined,
        created_at: new Date(),
      })
    } catch (error) {
      // Analytics must never be able to take a request path down with it.
      log.error('web event insert failed', {
        error: error instanceof Error ? error.message : String(error),
      })
    }
  },

  /**
   * The funnel, for the admin console.
   *
   * Counts are per event name, plus the number of distinct sessions that fired
   * each one — raw clicks flatter you, sessions do not.
   */
  async summary(days = 30) {
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
    const rows = await mongoColl
      .webEvents()
      .aggregate([
        { $match: { created_at: { $gte: since } } },
        {
          $group: {
            _id: { name: '$name', session: '$session' },
            hits: { $sum: 1 },
          },
        },
        {
          $group: {
            _id: '$_id.name',
            events: { $sum: '$hits' },
            sessions: { $sum: 1 },
          },
        },
        { $project: { _id: 0, name: '$_id', events: 1, sessions: 1 } },
        { $sort: { events: -1 } },
      ])
      .toArray()

    const byName = Object.fromEntries(
      rows.map((r) => [r.name as string, { events: r.events as number, sessions: r.sessions as number }]),
    )

    // The one number worth reading on its own: of the sessions that saw the
    // page, how many actually left for Play.
    const visitors = byName.page_view?.sessions ?? 0
    const reachedPlay = await mongoColl.webEvents().distinct('session', {
      created_at: { $gte: since },
      name: 'access_step_click',
      'props.step': 'install',
    })

    return {
      days,
      collection: COLLECTIONS.web_events,
      visitors,
      reached_play: reachedPlay.length,
      by_name: byName,
    }
  },

  /** Per-day counts for one event name, oldest first. */
  async daily(name: WebEventName, days = 30) {
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
    return mongoColl
      .webEvents()
      .aggregate([
        { $match: { name, created_at: { $gte: since } } },
        {
          $group: {
            _id: { $dateToString: { format: '%Y-%m-%d', date: '$created_at' } },
            events: { $sum: 1 },
          },
        },
        { $project: { _id: 0, day: '$_id', events: 1 } },
        { $sort: { day: 1 } },
      ])
      .toArray()
  },
}
