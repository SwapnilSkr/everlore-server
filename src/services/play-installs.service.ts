import { env } from '../config/env'
import { HttpError } from '../utils/http-error'
import { googlePlayAccessToken } from './google-play.service'

type InstallReportReason = 'forbidden' | 'no_reports' | 'not_configured' | 'error'
export type InstallReport = {
  available: boolean
  reason_kind: InstallReportReason | null
  reason: string | null
  last_updated: string | null
  daily: Record<string, number>
}
const SUCCESS_CACHE_MS = 6 * 60 * 60_000
const FAILURE_CACHE_MS = 15 * 60_000
const REASONS: Record<InstallReportReason, string> = {
  forbidden: "Play hasn't given the server's account access to install reports yet.",
  no_reports: "Play hasn't published an install report for this app yet. They usually appear a day or two after launch.",
  not_configured: "The server isn't set up to read Play reports.",
  error: "Play's install reports couldn't be read just now.",
}

class InstallReportError extends Error {
  constructor(readonly kind: InstallReportReason) {
    super(REASONS[kind])
  }
}

function csvRows(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = [], cell = '', quoted = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (c === '"') {
      if (quoted && text[i + 1] === '"') { cell += '"'; i++ }
      else if (quoted || cell === '') quoted = !quoted
      else throw new Error('Invalid CSV quote')
    } else if (!quoted && (c === ',' || c === '\n' || c === '\r')) {
      row.push(cell); cell = ''
      if (c !== ',') {
        if (row.some((value) => value !== '')) rows.push(row)
        row = []
        if (c === '\r' && text[i + 1] === '\n') i++
      }
    } else cell += c
  }
  if (quoted) throw new Error('Unclosed CSV quote')
  row.push(cell)
  if (row.some((value) => value !== '')) rows.push(row)
  return rows
}

/** Play bulk CSVs are UTF-16LE, including a BOM in the first header cell. */
export function parseInstallsCsv(bytes: Uint8Array): Record<string, number> {
  if (bytes.byteLength % 2) throw new Error('Invalid UTF-16 report')
  const rows = csvRows(new TextDecoder('utf-16le', { fatal: true }).decode(bytes).replace(/^\uFEFF/, ''))
  const header = rows.shift()?.map((cell) => cell.trim()) || []
  const dateIndex = header.indexOf('Date')
  const countIndex = header.indexOf('Daily User Installs')
  if (dateIndex < 0 || countIndex < 0 || rows.length === 0) throw new Error('Missing install report columns or rows')
  const daily: Record<string, number> = {}
  for (const row of rows) {
    const date = row[dateIndex]?.trim()
    const count = row[countIndex]?.trim()
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) ||
        new Date(date).toISOString().slice(0, 10) !== date || !count || !/^\d+$/.test(count)) {
      throw new Error('Invalid install report row')
    }
    const installs = Number(count)
    if (!Number.isSafeInteger(installs) || date in daily) throw new Error('Invalid install count or duplicate date')
    daily[date] = installs
  }
  return daily
}

/** Cache failures too; a forbidden bucket must not be retried on every console refresh. */
export function createInstallsReader(load: () => Promise<Record<string, number>>, now = Date.now) {
  let cached: { at: number; value: InstallReport } | null = null
  let pending: Promise<InstallReport> | null = null
  return async (): Promise<InstallReport> => {
    if (cached && now() - cached.at < (cached.value.available ? SUCCESS_CACHE_MS : FAILURE_CACHE_MS)) return cached.value
    if (pending) return pending
    pending = (async () => {
      let value: InstallReport
      try {
        const daily = await load()
        value = { available: true, reason_kind: null, reason: null, last_updated: new Date(now()).toISOString(), daily }
      } catch (error) {
        // Never expose upstream bodies or credential errors to the console.
        const kind = error instanceof InstallReportError ? error.kind : 'error'
        value = { available: false, reason_kind: kind, reason: REASONS[kind], last_updated: null, daily: {} }
      }
      cached = { at: now(), value }
      return value
    })()
    try { return await pending } finally { pending = null }
  }
}

export async function loadInstallReports(
  token: string,
  now = new Date(),
  request: typeof fetch = fetch,
): Promise<Record<string, number>> {
  const oldest = new Date(now.getTime() - 179 * 86400_000)
  const months = new Set<string>()
  for (let month = new Date(Date.UTC(oldest.getUTCFullYear(), oldest.getUTCMonth(), 1));
    month <= now; month.setUTCMonth(month.getUTCMonth() + 1)) {
    months.add(month.toISOString().slice(0, 7).replace('-', ''))
  }
  const bucket = `https://storage.googleapis.com/storage/v1/b/pubsite_prod_${encodeURIComponent(env.PLAY_DEVELOPER_ACCOUNT_ID)}/o`
  const prefix = `stats/installs/installs_${env.GOOGLE_PLAY_PACKAGE_NAME || 'com.everloreapp'}_`
  const headers = { Authorization: `Bearer ${token}` }
  const objects: string[] = []
  let pageToken: string | undefined
  // Discover existing reports first: a new app has no pre-launch monthly
  // objects. Guessing all seven names would turn those expected absences into
  // a permanent failure, even after the account receives permission.
  do {
    const query = new URLSearchParams({ prefix, fields: 'items(name),nextPageToken', maxResults: '1000' })
    if (pageToken) query.set('pageToken', pageToken)
    const response = await request(`${bucket}?${query}`, { headers, signal: AbortSignal.timeout(10_000) })
    if (!response.ok) throw new InstallReportError(response.status === 401 || response.status === 403 ? 'forbidden' : 'error')
    const body = await response.json() as { items?: Array<{ name: string }>; nextPageToken?: string }
    for (const { name } of body.items ?? []) {
      const month = name.slice(prefix.length, prefix.length + 6)
      if (months.has(month) && name === `${prefix}${month}_overview.csv`) objects.push(name)
    }
    pageToken = body.nextPageToken
  } while (pageToken)
  if (!objects.length) throw new InstallReportError('no_reports')
  const reports = await Promise.all(objects.map(async (object) => {
    const response = await request(`${bucket}/${encodeURIComponent(object)}?alt=media`, { headers, signal: AbortSignal.timeout(10_000) })
    if (!response.ok) throw new InstallReportError(response.status === 401 || response.status === 403 ? 'forbidden' : 'error')
    return parseInstallsCsv(new Uint8Array(await response.arrayBuffer()))
  }))
  return Object.assign({}, ...reports)
}

export async function loadReports(
  getToken: (scope: string) => Promise<string> = googlePlayAccessToken,
  now = new Date(),
  request: typeof fetch = fetch,
) {
  if (!env.PLAY_DEVELOPER_ACCOUNT_ID) throw new InstallReportError('not_configured')
  let token: string
  try {
    token = await getToken('https://www.googleapis.com/auth/devstorage.read_only')
  } catch (error) {
    if (error instanceof HttpError && error.statusCode === 503) throw new InstallReportError('not_configured')
    throw error
  }
  return loadInstallReports(token, now, request)
}

export const readPlayInstalls = createInstallsReader(loadReports)
