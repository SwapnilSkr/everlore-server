import { callLLM } from '../../src/ai/client'
import { AI_MODELS } from '../../src/ai/models'
import {
  enabledReplyLanguages,
  type ReplyLanguageEntry,
} from '../../src/utils/reply-language'

/**
 * Writing-source detection: one small structured call per typed turn decides
 * what language the player wrote in, and whether they explicitly asked the
 * story to switch. It starts with the job and is never awaited before the
 * stream; a failure changes nothing.
 */

export interface ReplyLanguageCheckResult {
  written_in: string
  asks_for: string | null
}

export interface ReplyLanguageCheckRequest {
  model: string
  messages: Array<{ role: string; content: string }>
  temperature: number
  maxTokens: number
  responseSchema: object
  responseFormat: { type: string; json_schema: { name: string; strict: boolean } }
  timeoutMs: number
  purpose: string
}

export interface ReplyLanguageCheckDeps {
  enabledCodes?: readonly string[]
  model?: string
  /** Injected in audits so the detector never touches the network. */
  call?: (request: ReplyLanguageCheckRequest) => Promise<string>
}

const MAX_INPUT_CHARS = 2000
const TIMEOUT_MS = 8000
const MAX_TOKENS = 64
/** Typed turns during which the player's own language decides the save's. */
const SETTLING_CHECKS = 3

/**
 * One ask from the player's own words: what language they wrote in, and whether
 * they explicitly asked the story to switch. Strict JSON so a stray field fails.
 */
export function buildReplyLanguageRequest(
  text: string,
  entries: ReplyLanguageEntry[],
  model: string = AI_MODELS.metadata,
): ReplyLanguageCheckRequest {
  const codes = entries.map((entry) => entry.code)
  return {
    model,
    messages: checkMessages(text, entries),
    temperature: 0,
    maxTokens: MAX_TOKENS,
    responseSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        written_in: { type: 'string', enum: [...codes, 'en', 'other'] },
        asks_for: {
          anyOf: [
            { type: 'string', enum: [...codes, 'en'] },
            { type: 'null' },
          ],
        },
      },
      required: ['written_in', 'asks_for'],
    },
    responseFormat: { type: 'json_schema', json_schema: { name: 'reply_language', strict: true } },
    timeoutMs: TIMEOUT_MS,
    purpose: 'reply_language_check',
  }
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

export interface ReplyLanguageGateInput {
  enabledCodes?: readonly string[]
  /** A typed turn: not a continue and not a world action. */
  isTyped: boolean
  source?: string
  checks?: number
  /** The save's effective code, if it has one. */
  replyLanguage?: string
  text: string
  /** `data.choices` from the newest event: what the chips offered this turn. */
  offered?: Array<{ send?: string; label?: string }>
}

/**
 * Pure gate. Checked when the turn is typed, is not one of the offered chips,
 * the source is not `player`, the count/non-ASCII rule allows it, and at least
 * one language is enabled. No word lists.
 */
export function shouldCheckReplyLanguage(input: ReplyLanguageGateInput): boolean {
  const enabledCodes = input.enabledCodes ?? enabledReplyLanguages().map((entry) => entry.code)
  if (enabledCodes.length === 0) return false
  if (!input.isTyped) return false
  if (input.source === 'player') return false

  const text = String(input.text || '')
  if (!text.trim()) return false

  const normalized = normalizeReplyText(text)
  for (const offer of input.offered || []) {
    for (const candidate of [offer.send, offer.label]) {
      if (candidate && normalizeReplyText(candidate) === normalized) return false
    }
  }

  const checks = Number(input.checks) || 0
  if (checks < SETTLING_CHECKS) return true
  // Past the first checks an English save is read again only when the text holds
  // a letter outside ASCII. A non-English one always is, so a player can still
  // ask for another language.
  return !!input.replyLanguage || hasNonAsciiLetter(text)
}

/**
 * What one result changes, or null. An explicit request always counts. The
 * language they wrote in counts while the save is settling and on an English
 * save; later, one line in another language doesn't turn a story around.
 */
export function decideReplyLanguage(input: {
  result: ReplyLanguageCheckResult
  checks: number
  replyLanguage?: string
}): { code?: string } | null {
  const { result, checks, replyLanguage } = input
  const counts = checks < SETTLING_CHECKS || !replyLanguage
  const wanted = result.asks_for ?? (counts && result.written_in !== 'other' ? result.written_in : null)
  if (!wanted) return null
  const code = wanted === 'en' ? undefined : wanted
  return code === replyLanguage ? null : { ...(code ? { code } : {}) }
}

function checkMessages(text: string, entries: ReplyLanguageEntry[]) {
  const offered = entries.map((entry) => `${entry.code} (${entry.name})`).join(', ')
  return [
    {
      role: 'system',
      content: `You read ONE player turn from an interactive story and report two things as strict JSON: {"written_in": <language>, "asks_for": <language|null>}.

- Judge the player's own words only. A character or narrator speaking, quoting or translating a line of another language inside the story is part of the fiction, NOT a request to change the language of the story.
- Names of people and places do not decide the language; a familiar-looking name is not evidence.
- written_in is the language the player's own message is written in: one of ${offered}, "en" (English), or "other".
- asks_for is the language the player is explicitly asking the story to be told in: one of ${offered} or "en". It is null when the player is not asking for a language.
- A passing mention of a language is not a request.
- Very short messages (one or two words), names alone, or mixed-language text that does not settle on one language are "other" for written_in and null for asks_for.
- Use only the allowed codes.`,
    },
    {
      role: 'user',
      content: `PLAYER MESSAGE:\n${String(text || '').slice(0, MAX_INPUT_CHARS)}`,
    },
  ]
}

function normalizeResult(
  raw: string,
  entries: ReplyLanguageEntry[],
): ReplyLanguageCheckResult | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const codes = entries.map((entry) => entry.code)
  const written = (parsed as { written_in?: unknown }).written_in
  const asks = (parsed as { asks_for?: unknown }).asks_for
  const written_in =
    typeof written === 'string' && codes.includes(written)
      ? written
      : written === 'en'
        ? 'en'
        : 'other'
  const asks_for =
    typeof asks === 'string' && (codes.includes(asks) || asks === 'en') ? asks : null
  return { written_in, asks_for }
}

/**
 * One small structured call (metadata model, temperature 0, 8 s). Never throws:
 * a provider or parse failure is null, and null never counts as a check.
 */
export async function checkReplyLanguage(
  text: string,
  deps: ReplyLanguageCheckDeps = {},
): Promise<ReplyLanguageCheckResult | null> {
  const entries = enabledReplyLanguages(deps.enabledCodes)
  if (entries.length === 0) return null
  const trimmed = String(text || '').trim()
  if (!trimmed) return null

  const request = buildReplyLanguageRequest(trimmed, entries, deps.model || AI_MODELS.metadata)

  try {
    const raw = deps.call ? await deps.call(request) : await callLLM(request)
    return normalizeResult(raw, entries)
  } catch {
    return null
  }
}
