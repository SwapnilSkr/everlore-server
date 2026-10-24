import { ObjectId } from 'mongodb'
import { mongoColl } from '../../config/mongo'
import { log } from '../../utils/logger'
import { classifyError, isGroupClass } from './classify'
import { fingerprintError, topFrameOf } from './fingerprint'
import { upsertErrorGroup } from './groups.service'
import { normalizeError, normalizeEvent, type ItemContext } from './schema'
import type {
  AppErrorClass,
  AppErrorDoc,
  AppEventDoc,
  AppInstallDoc,
  AppSessionDoc,
  NormalizedError,
  NormalizedEvent,
  ScreenStep,
  TelemetryBatch,
} from './types'

/**
 * Ingestion for the app's own events and errors (§4.1–§4.5, §6).
 *
 * The shape of this module follows from two facts:
 *
 *   1. **The client is untrusted and its clock is unreliable.** Everything that
 *      arrives is normalized by `schema.ts` before a single field is written, and
 *      the stored document is assembled here field by field — an extra key in the
 *      payload has no way through.
 *   2. **A batch is not a unit of success.** One bad event inside a hundred does
 *      not fail the hundred, and a resent batch inserts nothing twice: the
 *      event/error id is the idempotency key, and a duplicate is quietly not kept.
 *
 * A dropped item is never explained to the caller (§4.1). The response is a count.
 */

/** §4.4: without a token, a batch may not exceed this many events. */
export const MAX_UNAUTHENTICATED_EVENTS = 20

/** §6: the session keeps the last 100 screen steps, so a long session stays bounded. */
const MAX_SCREEN_STEPS = 100

/**
 * Lifecycle events are what a session *is*, not something the player did. They
 * are counted as events and kept out of the action count, so "actions" in the
 * console means presses rather than arrivals.
 */
const NON_ACTION_EVENTS: ReadonlySet<string> = new Set(['first_open', 'session_start', 'screen_view'])

const events = () => mongoColl.appEvents()
const errors = () => mongoColl.appErrors()
const sessions = () => mongoColl.appSessions()
const installs = () => mongoColl.appInstalls()
const counters = () => mongoColl.appErrorCounters()

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** E11000: the id was already stored, i.e. a resent item. Not a failure. */
function isDuplicateKey(error: unknown): boolean {
  return !!error && typeof error === 'object' && (error as { code?: unknown }).code === 11000
}

/** The JWT carries a hex string; the rows link with the same ObjectId as every other collection. */
function toUserId(userId: string | null): ObjectId | undefined {
  if (!userId || !ObjectId.isValid(userId)) return undefined
  return new ObjectId(userId)
}

function utcDay(at: Date): string {
  return at.toISOString().slice(0, 10)
}

async function insertEvents(
  batch: TelemetryBatch,
  list: NormalizedEvent[],
  now: Date,
  userId: ObjectId | undefined,
): Promise<NormalizedEvent[]> {
  const accepted: NormalizedEvent[] = []
  for (const event of list) {
    const doc: AppEventDoc = {
      event_id: event.event_id,
      install_id: batch.install_id,
      ...(userId ? { user_id: userId } : {}),
      session_id: batch.session_id,
      name: event.name,
      ...(event.screen ? { screen: event.screen } : {}),
      ...(event.duration_ms !== undefined ? { duration_ms: event.duration_ms } : {}),
      ...(event.props ? { props: event.props } : {}),
      seq: event.seq,
      at: event.at,
      received_at: now,
      app_version: batch.app.version,
      build: batch.app.build,
      device: batch.device,
    }
    try {
      await events().insertOne(doc)
      accepted.push(event)
    } catch (error) {
      if (!isDuplicateKey(error)) {
        log.error('telemetry: event insert failed', { name: event.name, error: errorMessage(error) })
      }
    }
  }
  return accepted
}

async function insertErrorSample(
  batch: TelemetryBatch,
  error: NormalizedError,
  cls: AppErrorClass,
  fingerprint: string,
  now: Date,
  userId: ObjectId | undefined,
): Promise<boolean> {
  const doc: AppErrorDoc = {
    error_id: error.error_id,
    install_id: batch.install_id,
    ...(userId ? { user_id: userId } : {}),
    session_id: batch.session_id,
    fingerprint,
    class: cls,
    source: error.source,
    fatal: error.fatal,
    type: error.type,
    ...(error.message ? { message: error.message } : {}),
    frames: error.frames,
    ...(error.screen ? { screen: error.screen } : {}),
    ...(error.http ? { http: error.http } : {}),
    breadcrumbs: error.breadcrumbs,
    at: error.at,
    received_at: now,
    app_version: batch.app.version,
    build: batch.app.build,
    device: batch.device,
  }
  try {
    await errors().insertOne(doc)
    return true
  } catch (error_) {
    if (!isDuplicateKey(error_)) {
      log.error('telemetry: error sample insert failed', { type: error.type, error: errorMessage(error_) })
    }
    return false
  }
}

/**
 * §4.5 — a counter class never becomes a group or a sample, only a number in
 * `app_error_counters`, laid out so the hourly rollup can fold it into a day.
 */
async function bumpCounter(cls: AppErrorClass, error: NormalizedError): Promise<void> {
  const day = utcDay(error.at)
  const parts = {
    ...(error.http?.route ? { route: error.http.route } : {}),
    ...(error.http?.status !== undefined ? { status: error.http.status } : {}),
    ...(error.screen ? { screen: error.screen } : {}),
  }

  // The id is built from the same parts, which is what keeps the key off the
  // unique index's null case: there is always an `_id`, and no optional field is
  // ever written as null.
  const id = [day, cls, parts.route, parts.status, parts.screen]
    .filter((part) => part !== undefined)
    .join('|')

  try {
    await counters().updateOne(
      { _id: id },
      { $setOnInsert: { day, class: cls, ...parts }, $inc: { count: 1 } },
      { upsert: true },
    )
  } catch (err) {
    log.error('telemetry: counter upsert failed', { class: cls, error: errorMessage(err) })
  }
}

/**
 * §4.2 — the install row is the join between a device and whoever signed in on
 * it. An install that has never signed in simply has no `user_ids` key.
 *
 * Returns true when this batch is the first to link the install to this user;
 * that is the signal to back-fill the session's earlier rows exactly once.
 */
async function upsertInstall(
  batch: TelemetryBatch,
  now: Date,
  userId: ObjectId | undefined,
): Promise<boolean> {
  const coll = installs()
  let newLink = false

  if (userId) {
    const existing = await coll.findOne(
      { _id: batch.install_id, user_ids: userId },
      { projection: { _id: 1 } },
    )
    newLink = !existing
  }

  const insert: Partial<AppInstallDoc> = {
    first_seen: now,
    first_version: batch.app.version,
    build: batch.app.build,
    device: batch.device,
  }

  await coll.updateOne(
    { _id: batch.install_id },
    {
      $setOnInsert: insert,
      $max: { last_seen: now },
      ...(userId ? { $addToSet: { user_ids: userId } } : {}),
    },
    { upsert: true },
  )

  return newLink
}

async function upsertSession(
  batch: TelemetryBatch,
  now: Date,
  userId: ObjectId | undefined,
  acceptedEvents: NormalizedEvent[],
  acceptedErrors: NormalizedError[],
): Promise<void> {
  const stamps = [...acceptedEvents.map((e) => e.at), ...acceptedErrors.map((e) => e.at)]
  const startedAt = stamps.length ? new Date(Math.min(...stamps.map((d) => d.getTime()))) : now
  const lastAt = stamps.length ? new Date(Math.max(...stamps.map((d) => d.getTime()))) : now

  const steps: ScreenStep[] = acceptedEvents
    .filter((event) => event.name === 'screen_view' && event.screen)
    .map((event) => ({
      screen: event.screen as string,
      duration_ms: event.duration_ms ?? 0,
      at: event.at,
      ...(event.props?.partial === true ? { partial: true } : {}),
    }))

  const actions = acceptedEvents.filter((event) => !NON_ACTION_EVENTS.has(event.name)).length

  await sessions().updateOne(
    { _id: batch.session_id },
    {
      $min: { started_at: startedAt },
      $max: { last_at: lastAt },
      $setOnInsert: {
        install_id: batch.install_id,
        app_version: batch.app.version,
        build: batch.app.build,
        device: batch.device,
      },
      // Counts follow what was *kept*, so a resent batch adds nothing.
      $inc: {
        'counts.events': acceptedEvents.length,
        'counts.errors': acceptedErrors.length,
        'counts.actions': actions,
      },
      ...(userId ? { $set: { user_id: userId } } : {}),
      ...(steps.length > 0
        ? { $push: { screen_path: { $each: steps, $slice: -MAX_SCREEN_STEPS } } }
        : {}),
    },
    { upsert: true },
  )
}

/**
 * §4.2 — everything the session recorded before sign-in belongs to the player who
 * signed in, so it is stamped once, when the link is made. Rows that already
 * carry a user are untouched: a shared phone must not rewrite the other account's
 * history.
 */
async function backfillSessionUser(batch: TelemetryBatch, userId: ObjectId): Promise<void> {
  await events().updateMany(
    { install_id: batch.install_id, session_id: batch.session_id, user_id: { $exists: false } },
    { $set: { user_id: userId } },
  )
  await sessions().updateOne({ _id: batch.session_id }, { $set: { user_id: userId } })
}

async function recordErrors(
  batch: TelemetryBatch,
  list: NormalizedError[],
  now: Date,
  userId: ObjectId | undefined,
): Promise<{ accepted: NormalizedError[] }> {
  const accepted: NormalizedError[] = []

  for (const error of list) {
    const cls = classifyError(error)

    if (!isGroupClass(cls)) {
      await bumpCounter(cls, error)
      accepted.push(error)
      continue
    }

    const fingerprint = fingerprintError(error, cls)
    const stored = await insertErrorSample(batch, error, cls, fingerprint, now, userId)
    // The sample id is the idempotency gate: a resent batch counts nothing twice.
    if (!stored) continue
    accepted.push(error)

    await upsertErrorGroup({
      fingerprint,
      cls,
      type: error.type,
      // The group's title is the first sample's scrubbed message (§4.3).
      title: error.message ?? error.type,
      topFrame: topFrameOf(error, cls),
      at: error.at,
      appVersion: batch.app.version,
    }).catch((err: unknown) => {
      log.error('telemetry: group upsert failed', { fingerprint, error: errorMessage(err) })
    })
  }

  return { accepted }
}

function normalizeEvents(
  batch: TelemetryBatch,
  ctx: ItemContext,
  userId: ObjectId | undefined,
): NormalizedEvent[] {
  // §4.4: an anonymous sender gets a smaller batch, so a script without a token
  // cannot write a hundred rows per request. Signed in, the full batch is kept.
  const raw = userId ? batch.events : batch.events.slice(0, MAX_UNAUTHENTICATED_EVENTS)
  const seen = new Set<string>()
  const out: NormalizedEvent[] = []

  for (const item of raw) {
    const event = normalizeEvent(item, ctx)
    if (!event) continue
    if (seen.has(event.event_id)) continue
    seen.add(event.event_id)
    out.push(event)
  }
  return out
}

function normalizeErrors(batch: TelemetryBatch, ctx: ItemContext): NormalizedError[] {
  const seen = new Set<string>()
  const out: NormalizedError[] = []

  for (const item of batch.errors) {
    const error = normalizeError(item, ctx)
    if (!error) continue
    if (seen.has(error.error_id)) continue
    seen.add(error.error_id)
    out.push(error)
  }
  return out
}

export const telemetryService = {
  /**
   * Store one validated batch. Returns the number of items kept.
   *
   * `userId` is the optional authenticated user (§4.1 allows no token at all);
   * when present it is stamped on this batch and linked to the install.
   */
  async ingest(batch: TelemetryBatch, userId: string | null): Promise<number> {
    const now = new Date()
    const userObjectId = toUserId(userId)
    const ctx: ItemContext = {
      installId: batch.install_id,
      sessionId: batch.session_id,
      app: batch.app,
      device: batch.device,
      now,
    }

    const normalizedEvents = normalizeEvents(batch, ctx, userObjectId)
    const normalizedErrors = normalizeErrors(batch, ctx)

    const acceptedEvents = await insertEvents(batch, normalizedEvents, now, userObjectId)
    const { accepted: acceptedErrors } = await recordErrors(batch, normalizedErrors, now, userObjectId)

    // The two rollup rows are derived from what was kept, never from what was
    // sent, so a duplicate batch cannot inflate a session or a funnel count.
    await upsertSession(batch, now, userObjectId, acceptedEvents, acceptedErrors)

    const newLink = await upsertInstall(batch, now, userObjectId)
    if (userObjectId && newLink) await backfillSessionUser(batch, userObjectId)

    return acceptedEvents.length + acceptedErrors.length
  },

  /**
   * §6 — account deletion. Error groups and counters hold counts rather than
   * people and stay; everything carrying this user is removed, and an install
   * shared with another account merely loses the id.
   */
  async purgeUser(userId: string): Promise<void> {
    const uid = toUserId(userId)
    if (!uid) return

    await Promise.all([
      events().deleteMany({ user_id: uid }),
      sessions().deleteMany({ user_id: uid }),
      errors().deleteMany({ user_id: uid }),
    ])

    // Installs are the funnel denominator, so only the ones that were linked to
    // this user and now belong to nobody are removed. An install that never
    // signed in has no personal data and is deliberately left alone.
    const linked = await installs()
      .find({ user_ids: uid }, { projection: { _id: 1 } })
      .toArray()
    const ids = linked.map((row) => row._id)
    if (ids.length === 0) return

    await installs().updateMany({ _id: { $in: ids } }, { $pull: { user_ids: uid } })
    await installs().deleteMany({ _id: { $in: ids }, user_ids: { $size: 0 } })
  },
}
