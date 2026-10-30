import { GENRES } from '../../utils/genre'
import { scrubMessage } from './scrub'
import type {
  AppInfo,
  DeviceInfo,
  ErrorSource,
  NormalizedBreadcrumb,
  NormalizedError,
  NormalizedEvent,
  NormalizedFrame,
  TelemetryBatch,
} from './types'

/**
 * The contract, as code (§3 and §4.1 of `everlore-docs/phases/analytics.md`).
 *
 * Everything here is pure and synchronous: it takes untrusted JSON and either
 * returns a normalized item or `null`. Nothing in this file talks to Mongo, so
 * the audit can call it directly, and nothing here can be talked around — the
 * stored document is built field by field from these results, so a key that is
 * not in the schema below has no route into the database at all.
 *
 * Two rules govern what happens to a bad item, and they differ on purpose:
 *   - a malformed field on an **item** (an event, an error) drops the item;
 *   - a malformed **element inside a bounded array** (a frame, a breadcrumb)
 *     drops only that element, because one bad stack frame is not a reason to
 *     lose the crash it came from.
 */

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
/** §3: structural, not a list — a route that declares no name reports `unnamed`. */
const SCREEN_NAME = /^[a-z][a-z0-9_-]{1,39}$/
const WORLD_ID = /^[0-9a-fA-F]{24}$/
const APP_VERSION = /^\d+\.\d+\.\d+$/
const LOCALE = /^[a-z]{2,3}(-[A-Z]{2})?$/
/** §4.1 bounds this one by length only, unlike `model` ("35", "17.2.1"). */
const OS_VERSION_MAX = 8
const DEVICE_MODEL = /^[\w .-]{1,40}$/
const ERROR_TYPE = /^[\w.<>$]{1,80}$/
const FRAME_FILE = /^(?:package|dart):[\w./:-]+$/
const FRAME_SYMBOL = /^[\w.<>$:/ -]{1,120}$/
const PRODUCT = /^[\w.-]{1,64}$/
/** Route templates keep `:param` placeholders; the app substitutes ids before sending. */
const HTTP_ROUTE = /^\/[A-Za-z0-9_\-/:.{}]*$/

const MAX_EVENTS = 100
const MAX_ERRORS = 10
const MAX_FRAMES = 30
const MAX_BREADCRUMBS = 20
const MAX_DURATION_MS = 6 * 60 * 60 * 1000
const OLDEST_AT_MS = 7 * 24 * 60 * 60 * 1000
const FUTURE_AT_MS = 10 * 60 * 1000

const SOURCES: readonly ErrorSource[] = ['flutter', 'platform', 'zone', 'handled']
const BREADCRUMB_KINDS = ['screen', 'action', 'http', 'lifecycle'] as const

type PropRule =
  | { kind: 'enum'; values: readonly string[] }
  | { kind: 'bool' }
  | { kind: 'int'; min: number; max: number }
  | { kind: 'screen' }
  | { kind: 'world_id' }
  | { kind: 'genre' }
  | { kind: 'product' }

type PropDef = { rule: PropRule; required?: boolean }

const oneOf = (...values: string[]): PropRule => ({ kind: 'enum', values })
const int = (min: number, max: number): PropRule => ({ kind: 'int', min, max })

/**
 * §3, one entry per event name. An asterisk in the doc means `required`.
 *
 * This table is the whole vocabulary: a name that is not a key here is dropped,
 * and a prop key that is not listed under its name is dropped. There is no
 * pass-through and no free-text prop anywhere, which is what makes "search text,
 * chat text, persona names, world titles are never sent" a property of the code
 * rather than a promise from the client.
 */
export const EVENT_SCHEMA: Record<string, { props: Record<string, PropDef> }> = {
  first_open: { props: {} },
  session_start: { props: { launch: { rule: oneOf('cold', 'resume') } } },
  screen_view: {
    props: {
      screen: { rule: { kind: 'screen' }, required: true },
      duration_ms: { rule: int(0, MAX_DURATION_MS), required: true },
      partial: { rule: { kind: 'bool' } },
      from: { rule: { kind: 'screen' } },
    },
  },
  sign_in_started: { props: { method: { rule: oneOf('google', 'phone') } } },
  sign_in_completed: {
    props: { method: { rule: oneOf('google', 'phone') }, new_account: { rule: { kind: 'bool' } } },
  },
  sign_in_failed: {
    props: {
      method: { rule: oneOf('google', 'phone') },
      reason: { rule: oneOf('cancelled', 'network', 'rejected', 'unknown') },
    },
  },
  onboarding_completed: { props: { interests_count: { rule: int(0, 1000) } } },
  persona_created: { props: {} },
  world_viewed: { props: { world_id: { rule: { kind: 'world_id' }, required: true } } },
  world_started: {
    props: {
      world_id: { rule: { kind: 'world_id' }, required: true },
      kind: { rule: oneOf('gm', 'sentient', 'character') },
    },
  },
  story_opened: { props: { world_id: { rule: { kind: 'world_id' } } } },
  turn_sent: { props: { input: { rule: oneOf('typed', 'choice', 'choice_edited', 'continue') } } },
  turn_failed: { props: { reason: { rule: oneOf('network', 'ink', 'server', 'rest') } } },
  sheet_opened: {
    props: {
      sheet: {
        rule: oneOf(
          'realm_menu', 'protagonist', 'filters', 'paywall', 'chat_menu', 'timeline', 'thoughts',
          'bond_actions', 'world_actions', 'travel', 'relationships', 'advance_time', 'create_chooser',
          'world_options', 'story_options', 'keepsake_options', 'report', 'content_actions',
          'persona_editor', 'interests_editor', 'autofill', 'publish', 'story_intro',
        ),
      },
    },
  },
  explore_filtered: { props: { genre: { rule: { kind: 'genre' } } } },
  paywall_shown: { props: { source: { rule: oneOf('ink', 'media', 'profile', 'top_bar', 'story') } } },
  purchase_started: { props: { product: { rule: { kind: 'product' } } } },
  purchase_completed: { props: { product: { rule: { kind: 'product' } } } },
  media_requested: { props: { kind: { rule: oneOf('picture', 'voice', 'film', 'portrait') } } },
  world_published: { props: { visibility: { rule: oneOf('private', 'public') } } },
  review_prompt_shown: { props: {} },
  analytics_opted_out: { props: {} },
  story_action: {
    props: {
      action: {
        rule: oneOf(
          'retry', 'rewind', 'edit_reply', 'replay_reply', 'pick_variant', 'reset', 'delete', 'travel',
          'relationship_set', 'time_advanced', 'protagonist_set', 'protagonist_reused',
          'protagonist_skipped', 'character_edited', 'character_tracked', 'relation_resolved',
          'milestone_cleared', 'history_loaded', 'voice_played',
        ),
        required: true,
      },
    },
  },
  story_settings_changed: {
    props: { setting: { rule: oneOf('pov', 'mode', 'length', 'voice', 'tone', 'focus', 'persona'), required: true } },
  },
  chronicle_tab: {
    props: { tab: { rule: oneOf('recap', 'timeline', 'memories', 'calendar', 'places', 'bonds', 'threads'), required: true } },
  },
  chronicle_action: {
    props: { action: { rule: oneOf('memory_edited', 'memory_deleted', 'event_edited', 'timeline_switched'), required: true } },
  },
  keepsakes_action: {
    props: {
      action: { rule: oneOf('filtered', 'mode_changed', 'opened', 'removed'), required: true },
      filter: { rule: oneOf('all', 'pictures', 'films', 'faces') },
      mode: { rule: oneOf('feed', 'grid') },
    },
  },
  library_action: {
    props: {
      action: { rule: oneOf('story_deleted', 'world_deleted', 'world_forge_opened', 'character_creation_opened'), required: true },
      mode: { rule: oneOf('new', 'edit') },
    },
  },
  creator_action: {
    props: { action: { rule: oneOf('autofill_used', 'character_created', 'world_saved'), required: true } },
  },
  report_submitted: {
    props: { target: { rule: oneOf('world', 'message', 'character', 'keepsake', 'other'), required: true } },
  },
  account_action: {
    props: {
      action: { rule: oneOf('signed_out', 'account_deleted', 'interests_updated'), required: true },
      count: { rule: int(0, 200) },
    },
  },
  guide_arc: {
    props: {
      arc: {
        rule: oneOf(
          'arrival', 'chronicle', 'explore_genres', 'home', 'ink', 'keepsakes', 'my_worlds',
          'personas', 'realm', 'scene_settings', 'world_detail',
        ),
        required: true,
      },
      outcome: { rule: oneOf('completed', 'skipped'), required: true },
    },
  },
  reminder_prompt: {
    props: {
      answer: { rule: oneOf('yes', 'not_now', 'granted', 'denied'), required: true },
      attempt: { rule: int(1, 2), required: true },
    },
  },
  reminder_opened: {
    props: { nth: { rule: int(1, 3), required: true } },
  },
}

export const EVENT_NAMES: readonly string[] = Object.keys(EVENT_SCHEMA)

/**
 * Lifecycle events are what a session *is*, not something the player did. They
 * are counted as events and kept out of the action count, so "actions" in the
 * console means presses rather than arrivals — and the daily rollup uses the same
 * set, so a session's action count and the day's agree.
 */
export const NON_ACTION_EVENTS: ReadonlySet<string> = new Set(['first_open', 'session_start', 'screen_view'])

export function isScreenName(value: unknown): value is string {
  return typeof value === 'string' && SCREEN_NAME.test(value)
}

export function isEventName(value: unknown): value is string {
  return typeof value === 'string' && Object.hasOwn(EVENT_SCHEMA, value)
}

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_V4.test(value)
}

/**
 * §3 says the genre is "a label from the server's genre list". The key is
 * accepted too and normalized to its label: a client built from the key list
 * would otherwise lose the whole event, and either value is authored by us —
 * neither can carry anything the player typed.
 */
function genreLabel(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const match = GENRES.find((g) => g.label === value) ?? GENRES.find((g) => g.key === value)
  return match?.label
}

function coerceProp(rule: PropRule, value: unknown): string | number | boolean | undefined {
  switch (rule.kind) {
    case 'enum':
      return typeof value === 'string' && rule.values.includes(value) ? value : undefined
    case 'bool':
      return typeof value === 'boolean' ? value : undefined
    case 'int':
      return typeof value === 'number' && Number.isInteger(value) && value >= rule.min && value <= rule.max
        ? value
        : undefined
    case 'screen':
      return isScreenName(value) ? value : undefined
    case 'world_id':
      return typeof value === 'string' && WORLD_ID.test(value) ? value : undefined
    case 'product':
      return typeof value === 'string' && PRODUCT.test(value) ? value : undefined
    case 'genre':
      return genreLabel(value)
  }
}

export type ItemContext = {
  installId: string
  sessionId: string
  app: AppInfo
  device: DeviceInfo
  /** The server's clock at receipt; bounds `at` against clock jumps and replays. */
  now: Date
}

/** §4.1: older than 7 days, or more than 10 min ahead of the server, is dropped. */
function parseAt(value: unknown, now: Date): Date | null {
  if (typeof value !== 'string') return null
  const ms = Date.parse(value)
  if (!Number.isFinite(ms)) return null
  if (ms < now.getTime() - OLDEST_AT_MS) return null
  if (ms > now.getTime() + FUTURE_AT_MS) return null
  return new Date(ms)
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function parseProps(
  name: string,
  raw: unknown,
): { ok: boolean; props?: Record<string, string | number | boolean> } {
  const def = EVENT_SCHEMA[name]
  const input = raw === undefined ? {} : asRecord(raw)
  if (!input) return { ok: false }

  const props: Record<string, string | number | boolean> = {}
  for (const [key, value] of Object.entries(input)) {
    const propDef = def.props[key]
    // An unknown key is dropped on its own; the rest of the event survives.
    if (!propDef) continue
    const coerced = coerceProp(propDef.rule, value)
    // A known key with a value outside its vocabulary is the client's bug, and
    // guessing at it would put a wrong number in the console.
    if (coerced === undefined) return { ok: false }
    props[key] = coerced
  }

  for (const [key, propDef] of Object.entries(def.props)) {
    if (propDef.required && props[key] === undefined) return { ok: false }
  }

  return { ok: true, props: Object.keys(props).length > 0 ? props : undefined }
}

export function normalizeEvent(raw: unknown, ctx: ItemContext): NormalizedEvent | null {
  const input = asRecord(raw)
  if (!input) return null

  if (!isUuid(input.id)) return null
  if (typeof input.seq !== 'number' || !Number.isSafeInteger(input.seq) || input.seq < 0) return null
  if (!isEventName(input.name)) return null

  const at = parseAt(input.at, ctx.now)
  if (!at) return null

  const { ok, props } = parseProps(input.name, input.props)
  if (!ok) return null

  const screen = props?.screen
  const duration = props?.duration_ms

  return {
    event_id: input.id,
    seq: input.seq,
    at,
    name: input.name,
    ...(typeof screen === 'string' ? { screen } : {}),
    ...(typeof duration === 'number' ? { duration_ms: duration } : {}),
    ...(props ? { props } : {}),
  }
}

function parseFrames(raw: unknown): NormalizedFrame[] {
  if (raw === undefined) return []
  if (!Array.isArray(raw)) return []

  const frames: NormalizedFrame[] = []
  for (const item of raw.slice(0, MAX_FRAMES)) {
    const frame = asRecord(item)
    if (!frame) continue
    if (typeof frame.file !== 'string' || frame.file.length > 160 || !FRAME_FILE.test(frame.file)) continue
    if (typeof frame.symbol !== 'string' || frame.symbol.length > 120 || !FRAME_SYMBOL.test(frame.symbol)) continue
    // The line is only ever displayed; a fingerprint that used it would split
    // on every unrelated edit above the throw.
    const line = typeof frame.line === 'number' && Number.isInteger(frame.line) && frame.line >= 0
      ? frame.line
      : undefined
    frames.push({ file: frame.file, symbol: frame.symbol, ...(line !== undefined ? { line } : {}) })
  }
  return frames
}

function parseBreadcrumbs(raw: unknown, now: Date): NormalizedBreadcrumb[] {
  if (!Array.isArray(raw)) return []

  const crumbs: NormalizedBreadcrumb[] = []
  for (const item of raw.slice(0, MAX_BREADCRUMBS)) {
    const crumb = asRecord(item)
    if (!crumb) continue
    const at = parseAt(crumb.at, now)
    if (!at) continue
    if (typeof crumb.kind !== 'string') continue
    if (!(BREADCRUMB_KINDS as readonly string[]).includes(crumb.kind)) continue
    // A breadcrumb names a screen or one of our own events. Nothing else can be
    // a name here, which is what keeps player text out of the trail.
    if (!isScreenName(crumb.name) && !isEventName(crumb.name)) continue
    crumbs.push({ at, kind: crumb.kind as NormalizedBreadcrumb['kind'], name: crumb.name })
  }
  return crumbs
}

function parseHttp(raw: unknown): { status: number; route: string } | null | undefined {
  if (raw === undefined) return undefined
  const http = asRecord(raw)
  if (!http) return null
  const { status, route } = http
  if (typeof status !== 'number' || !Number.isInteger(status) || status < 100 || status > 599) return null
  if (typeof route !== 'string' || route.length > 160 || !HTTP_ROUTE.test(route)) return null
  // A concrete ObjectId in a route template means an id would be stored with the
  // error. The app replaces ids before sending; this is what makes that stick.
  if (route.split('/').some((segment) => WORLD_ID.test(segment))) return null
  return { status, route }
}

export function normalizeError(raw: unknown, ctx: ItemContext): NormalizedError | null {
  const input = asRecord(raw)
  if (!input) return null

  if (!isUuid(input.id)) return null

  const at = parseAt(input.at, ctx.now)
  if (!at) return null

  if (typeof input.source !== 'string') return null
  if (!SOURCES.includes(input.source as ErrorSource)) return null

  if (input.fatal !== undefined && typeof input.fatal !== 'boolean') return null
  const fatal = input.fatal === true

  if (typeof input.type !== 'string' || !ERROR_TYPE.test(input.type)) return null

  let message: string | undefined
  if (input.message !== undefined) {
    if (typeof input.message !== 'string') return null
    const scrubbed = scrubMessage(input.message)
    if (scrubbed.length > 0) message = scrubbed
  }

  const http = parseHttp(input.http)
  if (http === null) return null

  let screen: string | undefined
  if (input.screen !== undefined) {
    if (!isScreenName(input.screen)) return null
    screen = input.screen
  }

  return {
    error_id: input.id,
    at,
    source: input.source as ErrorSource,
    fatal,
    type: input.type,
    ...(message ? { message } : {}),
    frames: parseFrames(input.frames),
    ...(screen ? { screen } : {}),
    ...(http ? { http } : {}),
    breadcrumbs: parseBreadcrumbs(input.breadcrumbs, ctx.now),
  }
}

function parseDevice(raw: unknown): DeviceInfo | null {
  const device = asRecord(raw)
  if (!device) return null
  if (device.os !== 'android' && device.os !== 'ios') return null
  if (device.form !== 'phone' && device.form !== 'tablet') return null

  // Optional device strings are dropped rather than failing the batch. A phone
  // whose model string carries a character the contract did not anticipate
  // ("SM-G991B/DS") must not turn every flush into a 400 the app can never
  // clear — and a value that fails here is never stored, so nothing is lost but
  // the detail.
  const os_version =
    typeof device.os_version === 'string' &&
    device.os_version.length > 0 &&
    device.os_version.length <= OS_VERSION_MAX
      ? device.os_version
      : undefined
  const model = typeof device.model === 'string' && DEVICE_MODEL.test(device.model)
    ? device.model
    : undefined
  const locale = typeof device.locale === 'string' && LOCALE.test(device.locale)
    ? device.locale
    : undefined

  return {
    os: device.os,
    form: device.form,
    ...(os_version ? { os_version } : {}),
    ...(model ? { model } : {}),
    ...(locale ? { locale } : {}),
  }
}

function parseApp(raw: unknown): AppInfo | null {
  const app = asRecord(raw)
  if (!app) return null
  if (typeof app.version !== 'string' || !APP_VERSION.test(app.version)) return null
  if (typeof app.build !== 'number' || !Number.isInteger(app.build) || app.build < 0) return null
  return { version: app.version, build: app.build }
}

/**
 * The envelope (§4.1). `null` means "400, this is not a batch".
 *
 * Which fields fail the whole request and which only lose a detail is a
 * deliberate split: the identity of the batch (install, session, app version)
 * has to be trustworthy for anything inside it to mean anything, while the
 * device strings are decoration on a row that is otherwise complete.
 */
export function parseEnvelope(raw: unknown): TelemetryBatch | null {
  const input = asRecord(raw)
  if (!input) return null

  if (!isUuid(input.install_id)) return null
  if (!isUuid(input.session_id)) return null

  const app = parseApp(input.app)
  if (!app) return null
  const device = parseDevice(input.device)
  if (!device) return null

  if (input.events !== undefined && !Array.isArray(input.events)) return null
  if (input.errors !== undefined && !Array.isArray(input.errors)) return null

  const events = (input.events as unknown[] | undefined) ?? []
  const errors = (input.errors as unknown[] | undefined) ?? []

  return {
    install_id: input.install_id,
    session_id: input.session_id,
    app,
    device,
    // Over the cap, the tail is dropped: §4.1 lets a violating item go and keeps
    // the rest of the batch.
    events: events.slice(0, MAX_EVENTS),
    errors: errors.slice(0, MAX_ERRORS),
  }
}

export const TELEMETRY_LIMITS = {
  maxEvents: MAX_EVENTS,
  maxErrors: MAX_ERRORS,
  maxFrames: MAX_FRAMES,
  maxBreadcrumbs: MAX_BREADCRUMBS,
  maxDurationMs: MAX_DURATION_MS,
} as const
