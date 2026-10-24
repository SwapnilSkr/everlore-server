import { mongoColl } from '../../config/mongo'
import { env } from '../../config/env'
import { callLLM } from '../../ai/client'
import { log } from '../../utils/logger'
import { versionEntries } from './groups.service'
import type { AppErrorClass, AppErrorGroupDoc, TriageState } from './types'

/**
 * §4.7 — one plain sentence per new error group, from a cheap model, capped.
 *
 * Three rules shape this module:
 *
 *   1. **Once per group, never per event.** The job id is the fingerprint, so a
 *      burst of samples collapses into one call, and a group that already has a
 *      note is only re-run when the admin asks for it.
 *   2. **The caps are spend limits, not a promise.** Each call is counted in
 *      `app_triage_calls` before the next one is allowed, and a group over a cap
 *      says so instead of quietly calling again.
 *   3. **The note never changes anything else.** It writes `triage` and nothing
 *      more: not the status, not the class, not who can see the group. A bad
 *      answer is `failed`, not a retry loop.
 *
 * The prompt carries no user ids and nothing the player typed beyond the already
 * scrubbed title (§4.3), so the model cannot be handed a story.
 */

/** §4.7: the classes worth an explanation. The counter classes get their plain
 * category from code and are never triaged. */
export const TRIAGE_CLASSES: ReadonlySet<AppErrorClass> = new Set(['crash', 'handled_bug', 'server_5xx'])

const OWNERS = ['app-ui', 'app-logic', 'server', 'integration', 'platform'] as const
const CONFIDENCES = ['low', 'medium', 'high'] as const
type Owner = (typeof OWNERS)[number]
type Confidence = (typeof CONFIDENCES)[number]

const MAX_CAUSE_CHARS = 300
const MAX_FRAMES = 15
const MAX_BREADCRUMBS = 10

/**
 * Cost estimate for the cap.
 *
 * `callLLM` returns text, not usage, so the ledger records an estimate from the
 * characters we sent and got back: `google/gemini-2.5-flash-lite` on OpenRouter
 * is $0.10 per million input tokens and $0.40 per million output, and a token is
 * taken as four characters. A typical group (~1.5k in, ~200 out) lands at
 * ≈ $0.00023, which is the same order as §4.7's ≈ $0.0003.
 */
const USD_PER_INPUT_TOKEN = 0.1 / 1_000_000
const USD_PER_OUTPUT_TOKEN = 0.4 / 1_000_000
const CHARS_PER_TOKEN = 4

export function estimateCostUsd(inputChars: number, outputChars: number): number {
  return (inputChars / CHARS_PER_TOKEN) * USD_PER_INPUT_TOKEN +
    (outputChars / CHARS_PER_TOKEN) * USD_PER_OUTPUT_TOKEN
}

export type TriageInput = {
  cls: AppErrorClass
  type: string
  title: string
  frames: string[]
  breadcrumbs: string[]
  appVersion: string | null
  device: string
}

const SYSTEM_PROMPT = [
  'You explain app crashes to the owner of a small mobile story app.',
  'The owner is not an engineer: use plain words, and name the app screen only if it helps.',
  'Write ONE sentence of at most 300 characters saying the most likely cause.',
  'Do not blame the user, do not suggest asking the user for more information, and do not guess at a fix that needs facts you were not given.',
  'Answer with JSON only, with the keys likely_cause (string), suggested_owner (one of app-ui, app-logic, server, integration, platform) and confidence (one of low, medium, high).',
].join(' ')

export function triagePrompt(input: TriageInput): { system: string; user: string } {
  return {
    system: SYSTEM_PROMPT,
    user: [
      `Class: ${input.cls}`,
      `Exception: ${input.type}`,
      `Title: ${input.title}`,
      `App version: ${input.appVersion ?? 'unknown'}`,
      `Device: ${input.device}`,
      input.frames.length > 0 ? `Frames (top ${input.frames.length}):\n${input.frames.join('\n')}` : 'Frames: none',
      input.breadcrumbs.length > 0
        ? `Last ${input.breadcrumbs.length} steps:\n${input.breadcrumbs.join('\n')}`
        : 'Steps: none',
    ].join('\n'),
  }
}

/** Strip a fenced block; models still wrap JSON even when asked not to. */
function unfence(raw: string): string {
  const match = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw)
  return (match ? match[1] : raw).trim()
}

export function parseTriageAnswer(raw: string): {
  likely_cause: string
  suggested_owner: Owner
  confidence: Confidence
} | null {
  let body: unknown
  try {
    body = JSON.parse(unfence(raw))
  } catch {
    return null
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null

  const answer = body as Record<string, unknown>
  const cause = typeof answer.likely_cause === 'string' ? answer.likely_cause.trim() : ''
  if (cause.length === 0 || cause.length > MAX_CAUSE_CHARS) return null
  if (!OWNERS.includes(answer.suggested_owner as Owner)) return null
  if (!CONFIDENCES.includes(answer.confidence as Confidence)) return null

  return {
    likely_cause: cause,
    suggested_owner: answer.suggested_owner as Owner,
    confidence: answer.confidence as Confidence,
  }
}

/**
 * The console's `triage_state` when the group itself does not say. A group with
 * no `triage` key has not been attempted yet; a counter class never will be.
 */
export function deriveTriageState(group: Pick<AppErrorGroupDoc, 'class' | 'triage'>): TriageState {
  if (group.triage?.state) return group.triage.state
  return TRIAGE_CLASSES.has(group.class) ? 'pending' : 'not_applicable'
}

const TRIAGE_SCHEMA = {
  type: 'object',
  properties: {
    likely_cause: { type: 'string' },
    suggested_owner: { type: 'string', enum: [...OWNERS] },
    confidence: { type: 'string', enum: [...CONFIDENCES] },
  },
  required: ['likely_cause', 'suggested_owner', 'confidence'],
  additionalProperties: false,
}

function newestVersion(versions?: Record<string, number>): string | null {
  const entries = versionEntries(versions)
  return entries.length > 0 ? entries[0].version : null
}

async function inputFor(group: AppErrorGroupDoc): Promise<TriageInput> {
  const sample = await mongoColl.appErrors().findOne({ fingerprint: group._id }, { sort: { at: -1 } })

  const frames = (sample?.frames ?? [])
    .slice(0, MAX_FRAMES)
    .map((frame) => `${frame.file}#${frame.symbol}${frame.line !== undefined ? `:${frame.line}` : ''}`)
  if (frames.length === 0 && group.top_frame) frames.push(group.top_frame)

  return {
    cls: group.class,
    type: group.type,
    title: group.title,
    frames,
    breadcrumbs: (sample?.breadcrumbs ?? [])
      .slice(-MAX_BREADCRUMBS)
      .map((crumb) => `${crumb.kind}:${crumb.name}`),
    appVersion: sample?.app_version ?? newestVersion(group.versions),
    device: sample ? `${sample.device.form}, Android ${sample.device.os_version ?? 'unknown'}` : 'unknown device',
  }
}

/**
 * §4.7: a Redis hiccup must not fail the ingest that produced the group.
 *
 * The queue module is imported lazily so that importing the ingest does not drag
 * BullMQ (and a Redis connection) in behind it — the pure telemetry audit runs
 * with neither.
 */
export async function enqueueTriage(fingerprint: string, jobId = fingerprint): Promise<void> {
  const { getMaintenanceQueue, QUEUE_RETENTION } = await import('../../queues')
  await getMaintenanceQueue().add('triage-error-group', {
    task: 'triage_error_group',
    fingerprint,
  }, {
    jobId,
    priority: 50,
    removeOnComplete: QUEUE_RETENTION.maintenance.removeOnComplete,
    removeOnFail: QUEUE_RETENTION.maintenance.removeOnFail,
  })
}

export const triageService = {
  /**
   * Called by the ingest when a group is created. Enqueues only: the state, the
   * cap check and the call all belong to the job, so a hundred samples of a new
   * crash cost exactly one queue write.
   */
  async onGroupCreated(fingerprint: string, cls: AppErrorClass): Promise<void> {
    if (!TRIAGE_CLASSES.has(cls)) return
    try {
      if (!env.ERROR_TRIAGE_ENABLED) return
      await enqueueTriage(fingerprint)
    } catch (error) {
      log.warn('telemetry: triage could not be queued', {
        fingerprint,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  },

  /**
   * `ok` while both caps have room. Counted from the ledger, which is written
   * immediately before each call, so the next job sees this one.
   */
  async capStatus(now: Date = new Date()): Promise<'ok' | 'daily' | 'monthly'> {
    const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))

    const [callsToday, monthRows] = await Promise.all([
      mongoColl.appTriageCalls().countDocuments({ at: { $gte: dayStart } }),
      mongoColl.appTriageCalls().find({ at: { $gte: monthStart } }, { projection: { cost_usd: 1 } }).toArray(),
    ])

    if (callsToday >= env.ERROR_TRIAGE_DAILY_CAP) return 'daily'
    const spent = monthRows.reduce((sum, row) => sum + (row.cost_usd || 0), 0)
    if (spent >= env.ERROR_TRIAGE_MONTHLY_USD_CAP) return 'monthly'
    return 'ok'
  },

  /**
   * The maintenance job. Returns the state it left on the group; a group that is
   * not triaged still gets a state, so the console can say why.
   */
  async run(fingerprint: string): Promise<TriageState> {
    const groups = mongoColl.appErrorGroups()
    const group = await groups.findOne({ _id: fingerprint })
    if (!group) return 'not_applicable'

    const setState = async (state: TriageState): Promise<TriageState> => {
      await groups.updateOne({ _id: fingerprint }, { $set: { 'triage.state': state } })
      return state
    }

    if (!TRIAGE_CLASSES.has(group.class)) return setState('not_applicable')
    // §4.5a: an ignored group keeps counting and is never triaged.
    if (group.status === 'ignored') return setState('not_applicable')
    if (!env.ERROR_TRIAGE_ENABLED) return setState('off')

    if ((await this.capStatus()) !== 'ok') return setState('capped')

    const input = await inputFor(group)
    const prompt = triagePrompt(input)
    try {
      const content = await callLLM({
        model: env.AUTHORING_MODEL,
        messages: [
          { role: 'system', content: prompt.system },
          { role: 'user', content: prompt.user },
        ],
        temperature: 0.2,
        maxTokens: 400,
        responseSchema: TRIAGE_SCHEMA,
        purpose: 'error_triage',
      })

      // The call happened and cost money whatever the answer looks like, so the
      // ledger is written before the answer is judged: a model that returns
      // nonsense must not be able to spend the cap twice.
      const cost = estimateCostUsd(prompt.system.length + prompt.user.length, content.length)
      const at = new Date()
      await mongoColl.appTriageCalls().insertOne({ at, fingerprint, cost_usd: cost })

      const answer = parseTriageAnswer(content)
      if (!answer) return setState('failed')

      await groups.updateOne({ _id: fingerprint }, {
        $set: {
          triage: {
            state: 'done',
            likely_cause: answer.likely_cause,
            suggested_owner: answer.suggested_owner,
            confidence: answer.confidence,
            model: env.AUTHORING_MODEL,
            at,
            cost_usd: cost,
          },
        },
      })
      return 'done'
    } catch (error) {
      log.warn('telemetry: triage call failed', {
        fingerprint,
        error: error instanceof Error ? error.message : String(error),
      })
      return setState('failed')
    }
  },
}
