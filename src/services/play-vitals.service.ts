import { env } from '../config/env'
import { HttpError } from '../utils/http-error'
import { googlePlayAccessToken } from './google-play.service'

/**
 * §5 — native crashes and ANRs, read from Google Play's own Android vitals.
 *
 * A crash in native code, an out-of-memory kill or an ANR ends the process
 * before Dart can report it, so first-party error capture cannot see it. Play
 * collects all three on every device that allows it, and the Developer Reporting
 * API hands them back a day or so later.
 *
 * The shape and the caching deliberately mirror `play-installs.service.ts`: the
 * same `reason_kind` vocabulary the installs card already shows, six hours on
 * success and fifteen on failure, one in-flight request, and never a word of an
 * upstream body in anything the console reads.
 *
 * API reference:
 *   - vitals.crashrate.query   — POST apps/{app}/crashRateMetricSet:query
 *   - vitals.anrrate.query     — POST apps/{app}/anrRateMetricSet:query
 *   - vitals.errors.issues.search — GET apps/{app}/errorIssues:search
 *   https://developers.google.com/play/developer/reporting/reference/rest/v1beta1/vitals.crashrate/query
 */

export type VitalsReason = 'forbidden' | 'not_configured' | 'no_data' | 'error'

export type VitalsRate = {
  date: string
  version_code: number
  crash_rate: number
  anr_rate: number
  users: number
}

export type VitalsIssue = {
  id: string
  type: string
  cause: string
  location: string
  reports: number
  users: number
  last_seen: string | null
  versions: number[]
}

export type VitalsReport = {
  available: boolean
  reason_kind: VitalsReason | null
  reason: string | null
  last_updated: string | null
  rates: VitalsRate[]
  issues: VitalsIssue[]
}

const SUCCESS_CACHE_MS = 6 * 60 * 60_000
const FAILURE_CACHE_MS = 15 * 60_000
const SCOPE = 'https://www.googleapis.com/auth/playdeveloperreporting'
const BASE = 'https://playdeveloperreporting.googleapis.com/v1beta1'
/** Play's own data lags about a day; a month is enough for a trend. */
const RATE_DAYS = 28

const REASONS: Record<VitalsReason, string> = {
  forbidden: "Play hasn't given the server's account access to app quality reports yet.",
  not_configured: "The server isn't set up to read Play reports.",
  no_data: "Play hasn't published crash or ANR figures for this app yet. They usually appear a day or two after launch.",
  error: "Play's app quality reports couldn't be read just now.",
}

class VitalsError extends Error {
  constructor(readonly kind: VitalsReason) {
    super(REASONS[kind])
  }
}

export function emptyVitals(kind: VitalsReason): VitalsReport {
  return {
    available: false,
    reason_kind: kind,
    reason: REASONS[kind],
    last_updated: null,
    rates: [],
    issues: [],
  }
}

/** `YYYY-MM-DD` → the `DateTime` a DAILY timeline wants (no hours: the day *is* the period). */
function dayTime(day: string) {
  const [year, month, date] = day.split('-').map(Number)
  return { year, month, day: date }
}

function utcDay(when: Date): string {
  return when.toISOString().slice(0, 10)
}

/**
 * The metric-set query body (§5: user-perceived crash and ANR rate, by version).
 *
 * Two details of the API matter here:
 *   - DAILY is the only period whose day boundaries match a calendar day, and its
 *     only supported timezone is `America/Los_Angeles` — so the timezone is left
 *     to the metric set's default rather than named, which is what the docs say
 *     the omission means.
 *   - `distinctUsers` is the normalisation value for the rates; the API warns it
 *     must not be summed further, which is why it is reported per day and version
 *     and never totalled.
 */
export function rateQuery(start: string, end: string, metrics: string[]) {
  return {
    timelineSpec: {
      aggregationPeriod: 'DAILY',
      startTime: dayTime(start),
      endTime: dayTime(end),
    },
    dimensions: ['versionCode'],
    metrics,
    pageSize: 1000,
  }
}

function decimal(value: unknown): number | null {
  if (value === null || value === undefined) return null
  // `google.type.Decimal` arrives as { value: "0.004" }; tolerate a bare number too.
  const raw = typeof value === 'object' ? (value as { value?: unknown }).value : value
  const parsed = Number(raw)
  return Number.isFinite(parsed) ? parsed : null
}

function metricOf(metrics: unknown, name: string): number | null {
  if (!Array.isArray(metrics)) return null
  const row = metrics.find((entry) => entry && typeof entry === 'object' && (entry as { metric?: string }).metric === name)
  if (!row) return null
  return decimal((row as { decimalValue?: unknown }).decimalValue)
}

function dimensionOf(dimensions: unknown, name: string): number | null {
  if (!Array.isArray(dimensions)) return null
  const row = dimensions.find((entry) =>
    entry && typeof entry === 'object' && (entry as { dimension?: string }).dimension === name)
  if (!row) return null
  const raw = (row as { int64Value?: unknown; stringValue?: unknown }).int64Value ??
    (row as { stringValue?: unknown }).stringValue
  const parsed = Number(raw)
  return Number.isFinite(parsed) ? parsed : null
}

/**
 * Rows → one entry per (day, version code). The two metric sets are separate
 * queries with the same shape, so they are merged here rather than in the
 * console.
 */
export function parseRateRows(payload: unknown): Array<{ date: string; version_code: number; metrics: Record<string, number> }> {
  const rows = (payload as { rows?: unknown })?.rows
  if (!Array.isArray(rows)) return []

  const out: Array<{ date: string; version_code: number; metrics: Record<string, number> }> = []
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue
    const start = (row as { startTime?: { year?: number; month?: number; day?: number } }).startTime
    if (!start?.year || !start.month || !start.day) continue
    const version = dimensionOf((row as { dimensions?: unknown }).dimensions, 'versionCode')
    if (version === null) continue

    const metrics = (row as { metrics?: unknown }).metrics
    const values: Record<string, number> = {}
    for (const name of ['crashRate', 'userPerceivedCrashRate', 'anrRate', 'userPerceivedAnrRate', 'distinctUsers']) {
      const value = metricOf(metrics, name)
      if (value !== null) values[name] = value
    }

    out.push({
      date: `${start.year}-${String(start.month).padStart(2, '0')}-${String(start.day).padStart(2, '0')}`,
      version_code: version,
      metrics: values,
    })
  }
  return out
}

export function mergeRates(
  crashRows: Array<{ date: string; version_code: number; metrics: Record<string, number> }>,
  anrRows: Array<{ date: string; version_code: number; metrics: Record<string, number> }>,
): VitalsRate[] {
  const merged = new Map<string, VitalsRate>()
  const at = (row: { date: string; version_code: number }) => `${row.date}|${row.version_code}`

  for (const row of crashRows) {
    merged.set(at(row), {
      date: row.date,
      version_code: row.version_code,
      // What Play's own Android vitals screen shows first, per §5.
      crash_rate: row.metrics.userPerceivedCrashRate ?? row.metrics.crashRate ?? 0,
      anr_rate: 0,
      users: Math.round(row.metrics.distinctUsers ?? 0),
    })
  }
  for (const row of anrRows) {
    const key = at(row)
    const entry = merged.get(key) ?? {
      date: row.date,
      version_code: row.version_code,
      crash_rate: 0,
      anr_rate: 0,
      users: 0,
    }
    entry.anr_rate = row.metrics.userPerceivedAnrRate ?? row.metrics.anrRate ?? 0
    entry.users = entry.users || Math.round(row.metrics.distinctUsers ?? 0)
    merged.set(key, entry)
  }

  return [...merged.values()].sort((left, right) =>
    right.date.localeCompare(left.date) || right.version_code - left.version_code)
}

export function parseIssues(payload: unknown): VitalsIssue[] {
  const issues = (payload as { errorIssues?: unknown })?.errorIssues
  if (!Array.isArray(issues)) return []

  const out: VitalsIssue[] = []
  for (const issue of issues) {
    if (!issue || typeof issue !== 'object') continue
    const row = issue as Record<string, unknown>
    const name = typeof row.name === 'string' ? row.name : ''
    const version = Number((row.lastAppVersion as { versionCode?: unknown } | undefined)?.versionCode)

    out.push({
      id: name.split('/').pop() ?? name,
      type: typeof row.type === 'string' ? row.type : '',
      cause: typeof row.cause === 'string' ? row.cause : '',
      location: typeof row.location === 'string' ? row.location : '',
      reports: Number(row.errorReportCount ?? 0) || 0,
      users: Number(row.distinctUsers ?? 0) || 0,
      last_seen: typeof row.lastErrorReportTime === 'string' ? row.lastErrorReportTime : null,
      versions: Number.isFinite(version) ? [version] : [],
    })
  }
  return out.sort((left, right) => right.reports - left.reports)
}

/**
 * §5 `errorIssues:search` is a GET with a flattened interval, and the interval
 * must be hour-aligned in UTC — so the hour is named and minutes are left at 0.
 * No timezone is set: the API documents that an empty one means UTC.
 */
export function issuesQuery(start: Date, end: Date): URLSearchParams {
  const query = new URLSearchParams({
    'interval.startTime.year': String(start.getUTCFullYear()),
    'interval.startTime.month': String(start.getUTCMonth() + 1),
    'interval.startTime.day': String(start.getUTCDate()),
    'interval.startTime.hours': '0',
    'interval.endTime.year': String(end.getUTCFullYear()),
    'interval.endTime.month': String(end.getUTCMonth() + 1),
    'interval.endTime.day': String(end.getUTCDate()),
    'interval.endTime.hours': '0',
    pageSize: '100',
    orderBy: 'errorReportCount desc',
    sampleErrorReportLimit: '0',
  })
  return query
}

async function postJson(request: typeof fetch, url: string, token: string, body: unknown): Promise<unknown> {
  const response = await request(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  })
  if (!response.ok) throw new VitalsError(response.status === 401 || response.status === 403 ? 'forbidden' : 'error')
  return response.json()
}

export async function loadPlayVitals(
  getToken: (scope: string) => Promise<string> = googlePlayAccessToken,
  now = new Date(),
  request: typeof fetch = fetch,
): Promise<VitalsReport> {
  if (!env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON) throw new VitalsError('not_configured')

  let token: string
  try {
    token = await getToken(SCOPE)
  } catch (error) {
    if (error instanceof HttpError && error.statusCode === 503) throw new VitalsError('not_configured')
    throw error
  }

  const packageName = encodeURIComponent(env.GOOGLE_PLAY_PACKAGE_NAME || 'com.everloreapp')
  const end = utcDay(now)
  const start = utcDay(new Date(now.getTime() - (RATE_DAYS - 1) * 86_400_000))
  const crashBody = rateQuery(start, end, ['crashRate', 'userPerceivedCrashRate', 'distinctUsers'])
  const anrBody = rateQuery(start, end, ['anrRate', 'userPerceivedAnrRate', 'distinctUsers'])

  const [crash, anr] = await Promise.all([
    postJson(request, `${BASE}/apps/${packageName}/crashRateMetricSet:query`, token, crashBody),
    postJson(request, `${BASE}/apps/${packageName}/anrRateMetricSet:query`, token, anrBody),
  ])

  let issues: VitalsIssue[] = []
  try {
    const response = await request(
      `${BASE}/apps/${packageName}/errorIssues:search?${issuesQuery(new Date(now.getTime() - 27 * 86_400_000), now)}`,
      { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) },
    )
    if (!response.ok) {
      throw new VitalsError(response.status === 401 || response.status === 403 ? 'forbidden' : 'error')
    }
    issues = parseIssues(await response.json())
  } catch (error) {
    // The rates are the headline; a failed issue search should not blank them.
    // A permission failure still is a permission failure, though.
    if (error instanceof VitalsError && error.kind === 'forbidden') throw error
  }

  const rates = mergeRates(parseRateRows(crash), parseRateRows(anr))
  // §5: at our size the rate metrics can stay empty while issue clusters appear.
  if (rates.length === 0 && issues.length === 0) throw new VitalsError('no_data')

  return {
    available: true,
    reason_kind: null,
    reason: null,
    last_updated: now.toISOString(),
    rates,
    issues,
  }
}

/** Same cache policy as the installs reader: successes 6 h, failures 15 min, one flight. */
export function createVitalsReader(load: () => Promise<VitalsReport>, now = Date.now) {
  let cached: { at: number; value: VitalsReport } | null = null
  let pending: Promise<VitalsReport> | null = null
  return async (): Promise<VitalsReport> => {
    if (cached && now() - cached.at < (cached.value.available ? SUCCESS_CACHE_MS : FAILURE_CACHE_MS)) {
      return cached.value
    }
    if (pending) return pending
    pending = (async () => {
      let value: VitalsReport
      try {
        value = await load()
      } catch (error) {
        // Never expose upstream bodies or credential errors to the console.
        value = emptyVitals(error instanceof VitalsError ? error.kind : 'error')
      }
      cached = { at: now(), value }
      return value
    })()
    try { return await pending } finally { pending = null }
  }
}

export const readPlayVitals = createVitalsReader(() => loadPlayVitals())
