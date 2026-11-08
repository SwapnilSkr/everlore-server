import { createHash } from 'node:crypto'
import { callLLM } from '../../ai/client'
import { getRedisClient } from '../../config/redis'
import type { WorldTemplateDoc } from '../../models/world-template.model'
import { HttpError } from '../../utils/http-error'
import { EmptyLLMResponseError } from '../../utils/llm-response'

export interface GroupTextLine {
  path: string
  text: string
}

/** Whose lines these are, and any exact text already known to have passed. */
export interface GroupTextMemory {
  playerId: string
  alreadyPassed?: Iterable<string>
}

export type GroupTextVerdict = { ok: true } | { ok: false; paths: string[] }

/** The gate's own model, never the media moderation model: that one refused every
 * consenting explicit adult line in the live run (phase doc §7a), so it can't judge these. */
export const groupTextGateModel = () => process.env.GROUP_TEXT_GATE_MODEL || 'deepseek/deepseek-v4.1-flash-1017'

const GATE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['verdict', 'rejected'],
  properties: {
    verdict: { type: 'string', enum: ['allow', 'reject'] },
    rejected: { type: 'array', items: { type: 'number' } },
  },
} as const

/**
 * The lines are the normal case, not the exception: these groups are adult, and
 * explicit sex between consenting adults must pass. Stated as a bare list of
 * things to reject, a gate reads a plain line as suspicious (the selfie gate
 * refused a person in an ordinary jumper), so the allowed case comes first.
 */
export const GROUP_TEXT_GATE_PROMPT = [
  'These lines are written for a fictional adult group chat. Explicit sex between consenting adults is allowed, including crude and graphic language, and is never a reason to reject.',
  "Reject a line only if: it describes sexual or romantic content with anyone under 18 or anyone described as a child or adolescent; it describes sex without consent, or a person who can't consent; or it names or clearly describes a real, identifiable person.",
  "A line that only states someone's adult age, or an age of 18 or over, is allowed.",
  'Judge every numbered line on its own. Return only JSON: verdict "allow" when every line passes, otherwise "reject" with the handles of every rejected line in rejected.',
].join(' ')

/** One day: an unchanged line is a line this player already had judged. */
const GATE_MEMORY_SECONDS = 86_400

export const textGateEffects = {
  call: callLLM,
  /** Injected for audits; production sleeps for real. */
  wait: (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms)),
  /** Which of these exact lines this player was already passed. One read for all. */
  async recall(keys: string[]): Promise<boolean[]> {
    if (keys.length === 0) return []
    const values = await getRedisClient().mget(keys)
    return values.map((value) => value !== null)
  },
  /** One write for all. The key is a hash, so the store never holds a player's words. */
  async remember(keys: string[]): Promise<void> {
    if (keys.length === 0) return
    const pipeline = getRedisClient().pipeline()
    for (const key of keys) pipeline.set(key, '1', 'EX', GATE_MEMORY_SECONDS)
    await pipeline.exec()
  },
}

const GATE_RETRY_WAIT_MS = 1500

/** The memory key is the hash of what was judged: player, model, prompt and the
 * exact line. No player text is stored and one changed character is a new key. */
function gateMemoryKey(playerId: string, model: string, text: string): string {
  const hash = createHash('sha256').update(`${model}\0${GROUP_TEXT_GATE_PROMPT}\0${text}`).digest('hex')
  return `group_gate_ok:${playerId}:${hash}`
}

/** Fail closed: a check that could not read a verdict rejects every line. */
function failClosed(lines: GroupTextLine[]): GroupTextVerdict {
  return { ok: false, paths: lines.map((line) => line.path) }
}

/** A failed write never changes the verdict already reached: the next save asks again. */
async function rememberQuietly(keys: string[]): Promise<void> {
  if (keys.length === 0) return
  try {
    await textGateEffects.remember(keys)
  } catch {
    // Redis is a shortcut for the next save, never part of this one.
  }
}

function transportStatus(error: unknown): number | null {
  const status = Number((error as { status?: unknown } | undefined)?.status)
  return Number.isFinite(status) && status > 0 ? status : null
}

/** A verdict, and whether it came from the model's answer or a failed read. Only
 * a real one may be remembered: a fail-closed result is not the gate's judgment. */
interface ParsedVerdict {
  verdict: GroupTextVerdict
  real: boolean
}

function parseVerdict(raw: string, lines: GroupTextLine[]): ParsedVerdict {
  const failed = (): ParsedVerdict => ({ verdict: failClosed(lines), real: false })
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return failed()
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return failed()
  const report = parsed as { verdict?: unknown; rejected?: unknown }
  if (report.verdict !== 'allow' && report.verdict !== 'reject') return failed()
  if (!Array.isArray(report.rejected) || !report.rejected.every((handle) => typeof handle === 'number')) {
    return failed()
  }
  const handles = report.rejected as number[]
  if (!handles.every((handle) => Number.isInteger(handle) && handle >= 1 && handle <= lines.length)) {
    return failed()
  }
  if (report.verdict === 'reject' && handles.length === 0) return failed()
  if (report.verdict === 'allow') return handles.length === 0 ? { verdict: { ok: true }, real: true } : failed()
  const rejected = new Set(handles)
  return {
    verdict: { ok: false, paths: lines.filter((_, index) => rejected.has(index + 1)).map((line) => line.path) },
    real: true,
  }
}

/**
 * One moderation call for every line a player wrote in a group. The model sees
 * short numbered handles, never the template paths: a path names internals and
 * would tell the model where the words sit instead of what they say.
 *
 * A line the gate already passed for this player is not asked again: a model
 * that refuses the same untouched line seconds later would otherwise refuse the
 * player's own group.
 */
export async function checkGroupText(lines: GroupTextLine[], memory: GroupTextMemory): Promise<GroupTextVerdict> {
  const alreadyPassed = new Set(memory.alreadyPassed ?? [])
  const remaining = lines.filter((line) => !alreadyPassed.has(line.text))
  if (remaining.length === 0) return { ok: true }

  const model = groupTextGateModel()
  const keys = remaining.map((line) => gateMemoryKey(memory.playerId, model, line.text))
  // A read that fails or comes back the wrong length is not a memory: ask the lines.
  let remembered: boolean[] = remaining.map(() => false)
  try {
    const read = await textGateEffects.recall(keys)
    if (read.length === keys.length) remembered = read
  } catch {
    // Redis never decides: without it every line is asked.
  }
  const sent = remaining.filter((_, index) => !remembered[index])
  if (sent.length === 0) return { ok: true }

  let answer: string | undefined
  for (let attempt = 0; answer === undefined; attempt++) {
    try {
      answer = await textGateEffects.call({
        model,
        responseSchema: GATE_SCHEMA,
        timeoutMs: 60000,
        maxTokens: 4096,
        temperature: 0,
        purpose: 'group_text_gate',
        messages: [
          { role: 'system', content: GROUP_TEXT_GATE_PROMPT },
          {
            role: 'user',
            content: JSON.stringify({
              lines: sent.map((line, index) => ({ handle: index + 1, text: line.text })),
            }),
          },
        ],
      })
    } catch (error) {
      const status = transportStatus(error)
      // A rate limit, a 5xx or an empty answer (the model's reasoning ran past
      // its token budget) is transport, never a verdict: ask once more.
      if (attempt === 0 && (error instanceof EmptyLLMResponseError || status === 429 || (status !== null && status >= 500))) {
        await textGateEffects.wait(GATE_RETRY_WAIT_MS)
        continue
      }
      throw new HttpError(503, 'Try again in a moment.')
    }
  }

  const parsed = parseVerdict(answer, sent)
  if (parsed.real) {
    // An allow passed every line sent; a reject passed all but the lines it refused.
    // Memory is keyed by the exact text, so a refused text must never be remembered
    // through a twin at another path: a line is remembered only when its words passed.
    const refusedPaths = new Set(parsed.verdict.ok ? [] : parsed.verdict.paths)
    const refusedTexts = new Set(sent.filter((line) => refusedPaths.has(line.path)).map((line) => line.text))
    const passed = sent.filter((line) => !refusedTexts.has(line.text))
    await rememberQuietly(passed.map((line) => gateMemoryKey(memory.playerId, model, line.text)))
  }
  return parsed.verdict
}

/** Every line a player wrote in a group, labelled with the field the app edits. */
export function groupTextLines(template: Partial<WorldTemplateDoc>): GroupTextLine[] {
  const lines: GroupTextLine[] = []
  const add = (path: string, text: unknown): void => {
    if (typeof text === 'string' && text.trim()) lines.push({ path, text })
  }
  add('title', template.title)
  add('description', template.description)
  add('global_lore', template.global_lore)
  add('seed_prompt', template.seed_prompt)
  ;(template.topics ?? []).forEach((topic, index) => add(`topics.${index}`, topic))
  ;(template.opening_lines ?? []).forEach((line, index) => add(`opening_lines.${index}.text`, line.text))
  ;(template.seed_cast ?? []).forEach((member, index) => {
    const at = `seed_cast.${index}`
    add(`${at}.name`, member.name)
    add(`${at}.role`, member.role)
    add(`${at}.appearance`, member.appearance)
    add(`${at}.persona`, member.persona)
    add(`${at}.group.speech`, member.group?.speech)
    add(`${at}.group.wants`, member.group?.wants)
    add(`${at}.group.intimacy`, member.group?.intimacy)
    ;(member.group?.voice ?? []).forEach((voice, line) => add(`${at}.group.voice.${line}`, voice))
    ;(member.first_texts ?? []).forEach((text, line) => add(`${at}.first_texts.${line}`, text))
    for (const period of ['morning', 'afternoon', 'evening', 'night'] as const) {
      add(`${at}.statuses.${period}`, member.statuses?.[period])
    }
  })
  return lines
}
