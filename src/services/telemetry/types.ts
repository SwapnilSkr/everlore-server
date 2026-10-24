import type { ObjectId } from 'mongodb'

/**
 * Shapes for the app's telemetry (`everlore-docs/phases/analytics.md`).
 *
 * Two families live here on purpose:
 *   - the **wire** types, which describe what the app sends and are therefore
 *     untrusted (nothing in them is stored before `schema.ts` has validated it);
 *   - the **stored** types, which describe the rows. They are the record of what
 *     the server decided to keep, so a field that is absent here cannot be
 *     written by accident.
 *
 * No free text is representable anywhere except a scrubbed error `message` and
 * the numeric/label vocabulary of §3.
 */

export type DeviceOs = 'android' | 'ios'
export type DeviceForm = 'phone' | 'tablet'

/** Device identity. Every field is a closed value or a bounded code — never a name. */
export type DeviceInfo = {
  os: DeviceOs
  os_version?: string
  model?: string
  form: DeviceForm
  locale?: string
}

export type AppInfo = {
  version: string
  build: number
}

/** A validated envelope. Items inside it are still raw and are validated one by one. */
export type TelemetryBatch = {
  install_id: string
  session_id: string
  app: AppInfo
  device: DeviceInfo
  events: unknown[]
  errors: unknown[]
}

export type NormalizedFrame = {
  file: string
  symbol: string
  line?: number
}

export type NormalizedBreadcrumb = {
  at: Date
  kind: 'screen' | 'action' | 'http' | 'lifecycle'
  name: string
}

export type NormalizedEvent = {
  event_id: string
  seq: number
  at: Date
  name: string
  screen?: string
  duration_ms?: number
  props?: Record<string, string | number | boolean>
}

export type ErrorSource = 'flutter' | 'platform' | 'zone' | 'handled'

export type NormalizedError = {
  error_id: string
  at: Date
  source: ErrorSource
  fatal: boolean
  type: string
  /** Already scrubbed (`scrub.ts`) and cut to 300 chars. */
  message?: string
  frames: NormalizedFrame[]
  screen?: string
  http?: { status: number; route: string }
  breadcrumbs: NormalizedBreadcrumb[]
}

/** §4.5. The first three group; the last three are counters. */
export type AppErrorClass =
  | 'crash'
  | 'handled_bug'
  | 'server_5xx'
  | 'expected_4xx'
  | 'offline'
  | 'image_load'

export type AppEventDoc = {
  event_id: string
  install_id: string
  user_id?: ObjectId
  session_id: string
  name: string
  screen?: string
  duration_ms?: number
  props?: Record<string, string | number | boolean>
  seq: number
  at: Date
  received_at: Date
  app_version: string
  build: number
  device: DeviceInfo
}

export type ScreenStep = {
  screen: string
  duration_ms: number
  at: Date
  partial?: boolean
}

export type AppSessionDoc = {
  /** The session id itself, so a batch's session upsert is a single-key write. */
  _id: string
  install_id: string
  user_id?: ObjectId
  started_at: Date
  last_at: Date
  app_version: string
  build: number
  device: DeviceInfo
  /** Last 100 steps only; a session longer than that keeps its tail. */
  screen_path?: ScreenStep[]
  counts: { events: number; errors: number; actions: number }
}

export type AppInstallDoc = {
  /** The install id itself. Never reset by sign-out, so it survives account deletion. */
  _id: string
  first_seen: Date
  last_seen: Date
  first_version: string
  build: number
  device: DeviceInfo
  /** Omitted entirely until the install signs in. Never written as `null`. */
  user_ids?: ObjectId[]
}

export type AppErrorDoc = {
  error_id: string
  install_id: string
  user_id?: ObjectId
  session_id: string
  fingerprint: string
  class: AppErrorClass
  source: ErrorSource
  fatal: boolean
  /** Exception type; the only free-ish string, and it is a Dart identifier. */
  type: string
  /** Scrubbed message. The only place player words could ever have been. */
  message?: string
  frames: NormalizedFrame[]
  screen?: string
  http?: { status: number; route: string }
  breadcrumbs: NormalizedBreadcrumb[]
  at: Date
  received_at: Date
  app_version: string
  build: number
  device: DeviceInfo
}

export type ErrorGroupStatus = 'new' | 'confirmed' | 'ignored' | 'resolved' | 'regressed'

export type AppErrorGroupDoc = {
  /** The fingerprint. A group outlives every one of its samples. */
  _id: string
  class: AppErrorClass
  /** §4.5a plain label, from code. */
  category: string
  type: string
  /** Scrubbed message of the first sample. */
  title: string
  top_frame?: string
  status: ErrorGroupStatus
  first_seen: Date
  last_seen: Date
  count: number
  /** `{ "1_0_11": n }` — dots are not allowed in Mongo field names. */
  versions?: Record<string, number>
  /** Version the admin marked it resolved in; a newer sample regresses it. */
  resolved_in_version?: string
}

export type AppErrorCounterDoc = {
  /** `day|class|route|status|screen`, so the row has its own id and no key is ever null. */
  _id: string
  /** UTC `YYYY-MM-DD` of the error's `at`. */
  day: string
  class: AppErrorClass
  route?: string
  status?: number
  screen?: string
  count: number
}
