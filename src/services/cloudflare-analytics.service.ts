import { env } from '../config/env'
import { log } from '../utils/logger'

/**
 * Cloudflare Web Analytics, read on the console's behalf.
 *
 * The marketing site's page views live in Cloudflare rather than our database:
 * their beacon is the thing that survives being loaded from a CDN by a browser
 * we never see. This pulls those numbers back so both halves of the picture —
 * their page views, our interactions — can be read on one screen instead of two.
 *
 * The API token is read-only (Account Analytics: Read) and stays on the server.
 * It is deliberately never handed to the console: a browser holding a token that
 * can read an entire Cloudflare account is a worse trade than one more hop.
 */
const ENDPOINT = 'https://api.cloudflare.com/client/v4/graphql'

/** RUM aggregates are minutes behind live, so a short cache costs nothing and
 *  keeps a refreshed panel from spending the account's query budget. */
const CACHE_TTL_MS = 60_000

/**
 * How far back the RUM dataset will actually answer.
 *
 * Ask for thirty days and Cloudflare returns an empty result with no error —
 * indistinguishable from "nobody visited" unless you already know. Measured,
 * not documented: 7 days answers, 8 comes back empty. The caller is told which
 * window it really got so the console can say so rather than render zeros.
 */
const MAX_DAYS = 7
const cache = new Map<number, { at: number; value: CloudflareTraffic }>()

export type TrafficRow = { label: string; views: number }

export type CloudflareTraffic = {
  configured: boolean
  /** The window actually queried, which may be shorter than the one asked for. */
  days: number
  /** True when the request was trimmed to what the dataset can answer. */
  capped: boolean
  page_views: number
  visits: number
  daily: Array<{ day: string; views: number; visits: number }>
  referrers: TrafficRow[]
  countries: TrafficRow[]
  paths: TrafficRow[]
  devices: TrafficRow[]
  /** Set when the numbers could not be fetched; the panel says so rather than showing zeros. */
  error?: string
}

function empty(days: number, patch: Partial<CloudflareTraffic> = {}): CloudflareTraffic {
  return {
    configured: false,
    days,
    capped: false,
    page_views: 0,
    visits: 0,
    daily: [],
    referrers: [],
    countries: [],
    paths: [],
    devices: [],
    ...patch,
  }
}

type Group = {
  count?: number
  sum?: { visits?: number }
  dimensions?: Record<string, string>
}

function rows(groups: Group[] | undefined, key: string): TrafficRow[] {
  return (groups || [])
    .map((g) => ({ label: g.dimensions?.[key] || 'unknown', views: g.count || 0 }))
    .filter((r) => r.views > 0)
}

export const cloudflareAnalyticsService = {
  configured() {
    return Boolean(
      env.CLOUDFLARE_API_TOKEN && env.CLOUDFLARE_ACCOUNT_ID && env.CLOUDFLARE_RUM_SITE_TAG,
    )
  },

  async traffic(requested: number): Promise<CloudflareTraffic> {
    const days = Math.min(requested, MAX_DAYS)
    const capped = days < requested
    if (!this.configured()) return empty(days, { capped })

    // Keyed by the clamped window, so a 30-day request reuses the 7-day answer.
    // `capped` belongs to the request rather than the data, so it is stamped on
    // the way out — otherwise the first caller's flag is served to everyone.
    const hit = cache.get(days)
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return { ...hit.value, capped }

    const end = new Date()
    const start = new Date(end.getTime() - days * 24 * 60 * 60 * 1000)
    const filter = `{datetime_geq: "${start.toISOString()}", datetime_lt: "${end.toISOString()}", siteTag: "${env.CLOUDFLARE_RUM_SITE_TAG}"}`

    // One request, six aggregations. Cloudflare bills a query, not a field.
    const query = `query {
      viewer {
        accounts(filter: {accountTag: "${env.CLOUDFLARE_ACCOUNT_ID}"}) {
          totals: rumPageloadEventsAdaptiveGroups(filter: ${filter}, limit: 1) { count sum { visits } }
          daily: rumPageloadEventsAdaptiveGroups(filter: ${filter}, limit: 400, orderBy: [date_ASC]) { count sum { visits } dimensions { date } }
          referrers: rumPageloadEventsAdaptiveGroups(filter: ${filter}, limit: 8, orderBy: [count_DESC]) { count dimensions { refererHost } }
          countries: rumPageloadEventsAdaptiveGroups(filter: ${filter}, limit: 8, orderBy: [count_DESC]) { count dimensions { countryName } }
          paths: rumPageloadEventsAdaptiveGroups(filter: ${filter}, limit: 8, orderBy: [count_DESC]) { count dimensions { requestPath } }
          devices: rumPageloadEventsAdaptiveGroups(filter: ${filter}, limit: 8, orderBy: [count_DESC]) { count dimensions { deviceType } }
        }
      }
    }`

    try {
      const response = await fetch(ENDPOINT, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ query }),
        signal: AbortSignal.timeout(12_000),
      })

      const body = (await response.json()) as {
        data?: { viewer?: { accounts?: Array<Record<string, Group[]>> } }
        errors?: Array<{ message?: string }>
      }

      if (!response.ok || body.errors?.length) {
        const message = body.errors?.[0]?.message || `HTTP ${response.status}`
        log.error('cloudflare analytics query failed', { message })
        return empty(days, { configured: true, capped, error: message })
      }

      const account = body.data?.viewer?.accounts?.[0]
      const totals = account?.totals?.[0]

      const value: CloudflareTraffic = {
        configured: true,
        days,
        capped,
        page_views: totals?.count || 0,
        visits: totals?.sum?.visits || 0,
        daily: (account?.daily || []).map((g) => ({
          day: g.dimensions?.date || '',
          views: g.count || 0,
          visits: g.sum?.visits || 0,
        })),
        referrers: rows(account?.referrers, 'refererHost'),
        countries: rows(account?.countries, 'countryName'),
        paths: rows(account?.paths, 'requestPath'),
        devices: rows(account?.devices, 'deviceType'),
      }

      cache.set(days, { at: Date.now(), value })
      return { ...value, capped }
    } catch (error) {
      // A third party being slow or down must not take the console's own
      // numbers with it — the caller renders what it has and says the rest
      // is missing.
      const message = error instanceof Error ? error.message : String(error)
      log.error('cloudflare analytics request failed', { error: message })
      return empty(days, { configured: true, capped, error: message })
    }
  },
}
