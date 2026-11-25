import {
  beginLLMTrace,
  recordLLMUsage,
  settleLLMTrace,
  traceFetch,
  traceProvider,
  withTraceAttempts,
} from '../../src/ai/usage'
import { env } from '../../src/config/env'
import {
  enabledReplyLanguages,
  type ReplyLanguageEntry,
} from '../../src/utils/reply-language'

/**
 * Writing-source detection. One `POST /api/alpha/decisions` reads the player's
 * own line and reports what language it is written in and whether they asked
 * for one. It starts at pickup and is never awaited before the stream; a
 * failure changes nothing and never counts as a check. The player's text is
 * never logged.
 */

export interface ReplyLanguageCheckResult {
  written_in: string
  asks_for: string | null
}

export interface ReplyLanguageDecisionRequest {
  model: string
  provider: { only: ['typesafe/zdr'] }
  state: { player_message: string }
  questions: {
    written_in: { type: 'choice'; instructions: string; criteria: Record<string, string> }
    asks_for: { type: 'choice'; instructions: string; criteria: Record<string, string> }
  }
}

export interface ReplyLanguageHttpResponse {
  status: number
  body: unknown
}

export type ReplyLanguageTransport = (
  request: ReplyLanguageDecisionRequest,
  signal: AbortSignal,
) => Promise<ReplyLanguageHttpResponse>

export interface ReplyLanguageCheckDeps {
  enabledCodes?: readonly string[]
  model?: string
  /** Injected in audits so the detector never touches the network. */
  transport?: ReplyLanguageTransport
  /** The turn-level cancellation signal. */
  signal?: AbortSignal
  /** Test seam; production uses `DECISION_TIMEOUT_MS`. */
  timeoutMs?: number
  /** Test seams for the prompt wait. */
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

const DECISIONS_URL = 'https://openrouter.ai/api/alpha/decisions'
const MAX_INPUT_CHARS = 2000
/** Anything slower than this is a failure, exactly like a non-200. */
export const DECISION_TIMEOUT_MS = 2000
/** A choice below this probability is not a choice. */
export const MIN_DECISION_PROBABILITY = 0.9
/** The only turn that may wait for the answer; counted from where prep ended. */
export const REPLY_LANGUAGE_WAIT_MS = 700
/** Typed turns during which the player's own language decides the save's. */
const SETTLING_CHECKS = 3

const WRITTEN_IN_INSTRUCTIONS =
  "Which language is the player's own message written in? It is one turn of an interactive story. Names of people and places do not decide the language. A short line or a greeting counts as the language it is written in when that is clear, spelled casually or without accents. Names alone, sounds (hmm, lol) and words that are equally normal in two of these languages are other."
const ASKS_FOR_INSTRUCTIONS =
  'Which language is the player explicitly asking the story to be told in?'
const WRITTEN_IN_EN = 'Written in English, including English with a foreign name or word in it.'
const WRITTEN_IN_OTHER =
  'Another language, only a name or a sound, or a word equally normal in two of these languages.'
const ASKS_FOR_NONE =
  'Does not ask for a language. Mentioning a language, or a character speaking one, is not asking.'

/**
 * The exact decision request. Criteria are built from the enabled registry
 * names, so adding a language adds its criteria without editing a prompt.
 */
export function buildReplyLanguageRequest(
  text: string,
  entries: ReplyLanguageEntry[],
  model: string = env.MODEL_REPLY_LANGUAGE,
): ReplyLanguageDecisionRequest {
  const writtenCriteria: Record<string, string> = {}
  const asksCriteria: Record<string, string> = {}
  for (const entry of entries) {
    writtenCriteria[entry.code] = `Written in ${entry.name}.`
    asksCriteria[entry.code] = `Asks for ${entry.name}.`
  }
  writtenCriteria.en = WRITTEN_IN_EN
  writtenCriteria.other = WRITTEN_IN_OTHER
  asksCriteria.en = 'Asks for English.'
  asksCriteria.none = ASKS_FOR_NONE
  return {
    model,
    provider: { only: ['typesafe/zdr'] },
    state: { player_message: String(text || '').trim().slice(0, MAX_INPUT_CHARS) },
    questions: {
      written_in: {
        type: 'choice',
        instructions: WRITTEN_IN_INSTRUCTIONS,
        criteria: writtenCriteria,
      },
      asks_for: {
        type: 'choice',
        instructions: ASKS_FOR_INSTRUCTIONS,
        criteria: asksCriteria,
      },
    },
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/**
 * A choice counts only when it is allowed and its probability is a finite
 * number at or above the floor. Everything else is "other" / no request.
 */
function countedChoice(answer: unknown, allowed: ReadonlySet<string>): string | null {
  if (!isRecord(answer)) return null
  const choice = answer.choice
  if (typeof choice !== 'string' || !allowed.has(choice)) return null
  const probabilities = answer.probabilities
  if (!isRecord(probabilities)) return null
  const probability = probabilities[choice]
  if (typeof probability !== 'number' || !Number.isFinite(probability)) return null
  return probability >= MIN_DECISION_PROBABILITY ? choice : null
}

/**
 * A response with no `answers`, or missing either question, is unexpected and
 * null. A present question whose choice is unknown or uncertain is not a
 * failure: it reads as "other" for written_in and no request for asks_for.
 */
export function parseReplyLanguageDecision(
  raw: unknown,
  entries: ReplyLanguageEntry[],
): ReplyLanguageCheckResult | null {
  if (!isRecord(raw)) return null
  const answers = raw.answers
  if (!isRecord(answers)) return null
  if (!isRecord(answers.written_in) || !isRecord(answers.asks_for)) return null

  const codes = entries.map((entry) => entry.code)
  const writtenAllowed = new Set([...codes, 'en', 'other'])
  const asksAllowed = new Set([...codes, 'en'])
  return {
    written_in: countedChoice(answers.written_in, writtenAllowed) ?? 'other',
    asks_for: countedChoice(answers.asks_for, asksAllowed),
  }
}

/**
 * Writing-source decision. An explicit request always counts. The language they
 * wrote in counts while the save is settling and on an English save; later, one
 * line in another language doesn't turn a story around.
 */
export function decideReplyLanguage(input: {
  result: ReplyLanguageCheckResult
  checks: number
  replyLanguage?: string
}): { code?: string } | null {
  const { result, checks, replyLanguage } = input
  const counts = checks < SETTLING_CHECKS || !replyLanguage
  const wanted =
    result.asks_for ?? (counts && result.written_in !== 'other' ? result.written_in : null)
  if (!wanted) return null
  const code = wanted === 'en' ? undefined : wanted
  return code === replyLanguage ? null : { ...(code ? { code } : {}) }
}

/** Collapses case, whitespace and punctuation so a tapped chip matches its text. */
export function normalizeReplyText(value: string): string {
  return String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '')
}

function hasNonAsciiLetter(text: string): boolean {
  const nonAscii = String(text || '').replace(/[\x00-\x7F]/g, '')
  return /\p{L}/u.test(nonAscii)
}

export interface ReplyLanguageStartCheckInput {
  enabledCodes?: readonly string[]
  /** A typed turn: not a continue and not a world action. */
  isTyped: boolean
  source?: string
  checks?: number
  /** The save's effective code, if it has one. */
  replyLanguage?: string
  text: string
}

/**
 * The pickup gate: everything here is known before the packet loads. A tapped
 * chip can only be told apart afterwards, so its result is discarded then.
 */
export function shouldStartReplyLanguageCheck(input: ReplyLanguageStartCheckInput): boolean {
  const enabledCodes =
    input.enabledCodes ?? enabledReplyLanguages().map((entry) => entry.code)
  if (enabledCodes.length === 0) return false
  if (!input.isTyped) return false
  if (input.source === 'player') return false

  const text = String(input.text || '')
  if (!text.trim()) return false

  const checks = Number(input.checks) || 0
  if (checks < SETTLING_CHECKS) return true
  // Past the first checks an English save is read again only when the text holds
  // a letter outside ASCII. A non-English one always is, so a player can still
  // ask for another language.
  return !!input.replyLanguage || hasNonAsciiLetter(text)
}

/** The packet-time half of the gate: the same text the offered chip sends. */
export function matchesOfferedChip(
  text: string,
  offered?: Array<{ send?: string; label?: string }>,
): boolean {
  const normalized = normalizeReplyText(text)
  if (!normalized) return false
  for (const offer of offered || []) {
    for (const candidate of [offer.send, offer.label]) {
      if (candidate && normalizeReplyText(candidate) === normalized) return true
    }
  }
  return false
}

/**
 * The prompt wait is zero unless this is the save's first typed turn and the
 * answer is not already in, and it never runs past the prep-end deadline.
 */
export function replyLanguageWaitMs(input: {
  checks: number
  settled: boolean
  discarded: boolean
  prepEndedAt: number
  now: number
}): number {
  if (input.settled || input.discarded || (Number(input.checks) || 0) !== 0) return 0
  return Math.max(0, input.prepEndedAt + REPLY_LANGUAGE_WAIT_MS - input.now)
}

function decisionTokenUsage(raw: unknown): {
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
} {
  const usage = isRecord(raw) ? raw : {}
  const prompt = Number(usage.prompt_tokens ?? usage.input_tokens) || 0
  const completion = Number(usage.completion_tokens ?? usage.output_tokens) || 0
  const total = Number(usage.total_tokens) || prompt + completion
  return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: total }
}

/**
 * The real call. It records through the same usage and trace path as the
 * intent router, but never puts the player's text in a message: the trace
 * stores an empty request.
 */
async function decisionTransport(
  request: ReplyLanguageDecisionRequest,
  signal: AbortSignal,
): Promise<ReplyLanguageHttpResponse> {
  const trace = beginLLMTrace({
    model: request.model,
    purpose: 'reply_language_check',
    streamed: false,
    messages: [],
    params: request as unknown as Record<string, unknown>,
  })
  let usage: unknown
  try {
    const response = await withTraceAttempts(trace, () =>
      traceFetch(DECISIONS_URL, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(request),
        signal,
      }),
    )
    const body: unknown = await response.json().catch(() => null)
    usage = isRecord(body) ? body.usage : undefined
    traceProvider(trace, body)
    if (trace && isRecord(usage) && typeof usage.cost === 'number') {
      trace.call.cost_usd = usage.cost
    }
    if (response.status !== 200) {
      throw Object.assign(new Error(`Reply language decision HTTP ${response.status}`), {
        status: response.status,
      })
    }
    settleLLMTrace(trace)
    return { status: response.status, body }
  } catch (error) {
    settleLLMTrace(trace, error, signal.aborted)
    throw error
  } finally {
    const tokens = decisionTokenUsage(usage)
    if (trace) Object.assign(trace.call, tokens)
    recordLLMUsage({ purpose: 'reply_language_check', model: request.model, streamed: false, ...tokens })
  }
}

/**
 * One attempt, 2 s at most, aborted by the turn or the caller. Never throws:
 * any unexpected shape, status or timing is null.
 */
export async function checkReplyLanguage(
  text: string,
  deps: ReplyLanguageCheckDeps = {},
): Promise<ReplyLanguageCheckResult | null> {
  const entries = enabledReplyLanguages(deps.enabledCodes)
  if (entries.length === 0) return null
  const trimmed = String(text || '').trim()
  if (!trimmed) return null

  const request = buildReplyLanguageRequest(trimmed, entries, deps.model)
  const controller = new AbortController()
  const abortFromCaller = () => controller.abort()
  if (deps.signal) {
    if (deps.signal.aborted) controller.abort()
    else deps.signal.addEventListener('abort', abortFromCaller, { once: true })
  }
  const timeoutMs = deps.timeoutMs ?? DECISION_TIMEOUT_MS
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      controller.abort()
      resolve(null)
    }, timeoutMs)
  })
  const aborted = new Promise<null>((resolve) => {
    if (!deps.signal) return
    if (deps.signal.aborted) {
      controller.abort()
      resolve(null)
      return
    }
    deps.signal.addEventListener('abort', () => {
      controller.abort()
      resolve(null)
    }, { once: true })
  })

  try {
    const transport = deps.transport ?? decisionTransport
    const response = await Promise.race([transport(request, controller.signal), timeout, aborted])
    if (!response || response.status !== 200) return null
    return parseReplyLanguageDecision(response.body, entries)
  } catch {
    return null
  } finally {
    if (timer) clearTimeout(timer)
    if (deps.signal) deps.signal.removeEventListener('abort', abortFromCaller)
  }
}

export interface StartedReplyLanguageCheck {
  readonly started: boolean
  readonly promise: Promise<ReplyLanguageCheckResult | null>
  settled(): boolean
  result(): ReplyLanguageCheckResult | null
  discarded(): boolean
  /** A tapped chip: forget the answer and its count, and abort the request. */
  discard(): void
  isOfferedChip(offered?: Array<{ send?: string; label?: string }>): boolean
  waitMs(prepEndedAt: number, now?: number): number
  /** Waits at the prompt at most once, and only on the save's first typed turn. */
  waitAtPrompt(prepEndedAt: number): Promise<void>
  cancel(): void
}

/**
 * Starts the check immediately at pickup, exactly like `startIntentRouter`, and
 * exposes only synchronous decisions. The one result counts once because the
 * caller guards application, and the wait is paid at most once per turn.
 */
export function startReplyLanguageCheck(
  input: ReplyLanguageStartCheckInput,
  deps: ReplyLanguageCheckDeps = {},
): StartedReplyLanguageCheck {
  const enabledCodes =
    deps.enabledCodes ?? enabledReplyLanguages().map((entry) => entry.code)
  const now = deps.now ?? Date.now
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const controller = new AbortController()
  const forwardAbort = () => controller.abort()
  if (deps.signal) {
    if (deps.signal.aborted) controller.abort()
    else deps.signal.addEventListener('abort', forwardAbort, { once: true })
  }

  const started = shouldStartReplyLanguageCheck({ ...input, enabledCodes })
  let settledFlag = false
  let resultValue: ReplyLanguageCheckResult | null = null
  let discardedFlag = false
  let waited = false
  const checks = Number(input.checks) || 0
  const promise = started
    ? checkReplyLanguage(input.text, {
        enabledCodes,
        model: deps.model,
        transport: deps.transport,
        timeoutMs: deps.timeoutMs,
        signal: controller.signal,
      })
        .then((result) => {
          resultValue = result
          settledFlag = true
          return result
        })
        .catch(() => {
          settledFlag = true
          return null
        })
    : Promise.resolve(null)

  return {
    started,
    promise,
    settled: () => settledFlag,
    result: () => resultValue,
    discarded: () => discardedFlag,
    discard: () => {
      discardedFlag = true
      controller.abort()
    },
    isOfferedChip: (offered) => matchesOfferedChip(input.text, offered),
    waitMs: (prepEndedAt, at = now()) =>
      started
        ? replyLanguageWaitMs({
            checks,
            settled: settledFlag,
            discarded: discardedFlag,
            prepEndedAt,
            now: at,
          })
        : 0,
    waitAtPrompt: async (prepEndedAt) => {
      if (waited || !started || discardedFlag || settledFlag || checks !== 0) return
      waited = true
      const ms = Math.max(0, prepEndedAt + REPLY_LANGUAGE_WAIT_MS - now())
      if (ms <= 0) return
      await Promise.race([promise, sleep(ms)])
    },
    cancel: () => {
      controller.abort()
      deps.signal?.removeEventListener('abort', forwardAbort)
    },
  }
}
