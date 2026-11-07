import { callLLM } from '../../ai/client'
import type { WorldTemplateDoc } from '../../models/world-template.model'
import { HttpError } from '../../utils/http-error'

export interface GroupTextLine {
  path: string
  text: string
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

export const textGateEffects = {
  call: callLLM,
  /** Injected for audits; production sleeps for real. */
  wait: (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms)),
}

const GATE_RETRY_WAIT_MS = 1500

/** Fail closed: a check that could not read a verdict rejects every line. */
function failClosed(lines: GroupTextLine[]): GroupTextVerdict {
  return { ok: false, paths: lines.map((line) => line.path) }
}

function transportStatus(error: unknown): number | null {
  const status = Number((error as { status?: unknown } | undefined)?.status)
  return Number.isFinite(status) && status > 0 ? status : null
}

function parseVerdict(raw: string, lines: GroupTextLine[]): GroupTextVerdict {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return failClosed(lines)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return failClosed(lines)
  const report = parsed as { verdict?: unknown; rejected?: unknown }
  if (report.verdict !== 'allow' && report.verdict !== 'reject') return failClosed(lines)
  if (!Array.isArray(report.rejected) || !report.rejected.every((handle) => typeof handle === 'number')) {
    return failClosed(lines)
  }
  const handles = report.rejected as number[]
  if (!handles.every((handle) => Number.isInteger(handle) && handle >= 1 && handle <= lines.length)) {
    return failClosed(lines)
  }
  if (report.verdict === 'reject' && handles.length === 0) return failClosed(lines)
  if (report.verdict === 'allow') return handles.length === 0 ? { ok: true } : failClosed(lines)
  const rejected = new Set(handles)
  return { ok: false, paths: lines.filter((_, index) => rejected.has(index + 1)).map((line) => line.path) }
}

/**
 * One moderation call for every line a player wrote in a group. The model sees
 * short numbered handles, never the template paths: a path names internals and
 * would tell the model where the words sit instead of what they say.
 */
export async function checkGroupText(lines: GroupTextLine[]): Promise<GroupTextVerdict> {
  if (lines.length === 0) return { ok: true }
  let answer: string | undefined
  for (let attempt = 0; answer === undefined; attempt++) {
    try {
      answer = await textGateEffects.call({
        model: groupTextGateModel(),
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
              lines: lines.map((line, index) => ({ handle: index + 1, text: line.text })),
            }),
          },
        ],
      })
    } catch (error) {
      const status = transportStatus(error)
      // A rate limit or a 5xx is transport, never a verdict: ask once more.
      if (attempt === 0 && (status === 429 || (status !== null && status >= 500))) {
        await textGateEffects.wait(GATE_RETRY_WAIT_MS)
        continue
      }
      throw new HttpError(503, 'Try again in a moment.')
    }
  }
  return parseVerdict(answer, lines)
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
