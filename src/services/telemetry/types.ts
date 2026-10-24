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
  /**
   * §4.7. Written only by the triage job, never when the group is created: a
   * group with no `triage` key is one whose note has not been attempted yet, and
   * the console derives `pending` from that.
   */
  triage?: ErrorTriage
  /** §4.5a: the admin's own plain sentence, once they confirmed one. */
  explanation?: string
  /** §4.6 PATCH: a free note the admin leaves for themselves. */
  note?: string
  verified_by?: string
  verified_at?: Date
}

/** §4.6a `triage_state`. `done` carries the model's answer. */
export type TriageState = 'done' | 'pending' | 'capped' | 'failed' | 'off' | 'not_applicable'

export type ErrorTriage = {
  state: TriageState
  /** §4.7: ≤ 300 chars, plain words for a non-engineer owner. */
  likely_cause?: string
  suggested_owner?: 'app-ui' | 'app-logic' | 'server' | 'integration' | 'platform'
  confidence?: 'low' | 'medium' | 'high'
  model?: string
  at?: Date
  /** What this call is recorded as costing in `app_triage_calls`. */
  cost_usd?: number
}

/**
 * One row per model call (§4.7), the ledger the caps are counted from. Kept 90
 * days: a month is all a cap needs, and the row names a group rather than a
 * player.
 */
export type AppTriageCallDoc = {
  _id: ObjectId
  at: Date
  fingerprint: string
  cost_usd: number
}

/**
 * `app_daily` — one permanent row per UTC day (§6).
 *
 * Everything here is a count or a sum, so a day outlives the 90-day raw rows it
 * was folded from. The screen timings keep a histogram as well as the median,
 * because a window's median cannot be recovered from a list of per-day medians.
 */
export type AppDailyScreen = {
  views: number
  /** Distinct players that day; summed across days it is an upper bound. */
  players: number
  total_ms: number
  /** Whole seconds: the lower bound of the histogram bucket holding the middle view. */
  median_ms: number
  /** Sessions whose last screen this was. */
  exits: number
  next: Record<string, number>
  /** Whole-second bucket → views, so a window can merge medians exactly. */
  hist: Record<string, number>
}

export type AppDailyAction = {
  count: number
  players: number
  props: Record<string, Record<string, number>>
}

export type AppDailyDoc = {
  /** The UTC day itself, `YYYY-MM-DD`, so a roll is a single-key write. */
  _id: string
  day: string
  updated_at: Date
  /** Sessions whose last activity fell on this day; the exit-rate denominator. */
  sessions: number
  funnel: {
    /** Installs first seen this day. */
    first_opens: number
    sessions_started: number
    sign_ins: number
    /** Server truth: `users.created_at`. */
    signups: number
    opened_world: number
    first_turn: number
    /** Settles a day later; the hourly re-roll of the last three days fills it. */
    returned_d1: number
  }
  screens: Record<string, AppDailyScreen>
  actions: Record<string, AppDailyAction>
  counters: {
    offline: number
    expected_4xx: number
    image_load: number
    /** `"<route>|<status>"` → count. */
    top_4xx: Record<string, number>
  }
  errors: {
    samples: number
    players: number
    groups_new: number
    by_class: Record<string, number>
  }
  /** App version → events, which is the version filter's denominator. */
  versions: Record<string, number>
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
