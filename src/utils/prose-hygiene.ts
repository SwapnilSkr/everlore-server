import { callLLM } from '../ai/client'

export type ProseHygieneSeverity = 'warning' | 'error'

export interface ProseHygieneIssue {
  code: string
  severity: ProseHygieneSeverity
  message: string
  detail?: string
}

interface ProseHygieneInput {
  narrative: string
  characterNames?: string[]
}

const REPAIRABLE_CODES = new Set([
  'dialogue_quotes_present',
  'double_asterisk_markers',
  'unbalanced_italics',
  'plain_narration_outside_markers',
  'consecutive_name_sentence_starts',
  'repeated_character_name',
  'many_codex_names_mentioned',
])

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function narrationMarkerCount(text: string): number {
  let count = 0
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '*') continue
    if (text[i - 1] === '*') continue
    const isDouble = text[i + 1] === '*'
    const isTripleOrMore = isDouble && text[i + 2] === '*'
    if (isTripleOrMore) continue
    count++
    if (isDouble) i++
  }
  return count
}

function sentenceStarts(text: string): string[] {
  return text
    .replace(/\n+/g, ' ')
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean)
}

function countOccurrences(text: string, needle: string): number {
  const re = new RegExp(`\\b${escapeRegExp(needle)}\\b`, 'gi')
  return text.match(re)?.length || 0
}

function plainSegmentsOutsideNarration(text: string): string[] {
  const segments: string[] = []
  let cursor = 0
  const markerRe = /\*\*[\s\S]+?\*\*|\*[\s\S]+?\*/g
  let match: RegExpExecArray | null
  while ((match = markerRe.exec(text)) !== null) {
    segments.push(text.slice(cursor, match.index))
    cursor = match.index + match[0].length
  }
  segments.push(text.slice(cursor))
  return segments.map((s) => s.trim()).filter(Boolean)
}

function plainSegmentLooksLikeNarration(segment: string, names: string[]): boolean {
  const compact = segment.replace(/\s+/g, ' ').trim()
  if (!compact) return false

  const sentences = compact
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean)

  const actionStart = new RegExp(
    `^(?:${[
      'he',
      'she',
      'they',
      'his',
      'her',
      'their',
      'the\\s+[a-z][\\w-]*',
      'a\\s+[a-z][\\w-]*',
      'an\\s+[a-z][\\w-]*',
      'the\\s+fire',
      'the\\s+room',
      'the\\s+air',
      'the\\s+silence',
      'the\\s+hearth',
      'her\\s+eyes',
      'his\\s+eyes',
      'their\\s+eyes',
    ].join('|')})\\b`,
    'i',
  )
  const actionVerb = /\b(?:lets?|let|turns?|tilts?|cocks?|steps?|moves?|leans?|looks?|watches?|smiles?|laughs?|frowns?|pauses?|hesitates?|reaches?|takes?|sets?|drops?|raises?|lowers?|flickers?|glows?|crackles?|burns?|dances?|hangs?|answers?|tightens?|softens?|shifts?|draws?|breathes?|whispers?|murmurs?|says?)\b/i
  const narrationNoun = /\b(?:silence|hearth|fire|flame|flames|embers?|room|air|shadow|eyes?|voice|tone|smile|hand|hands|palms?|pause|moment|warmth|light|darkness)\b/i
  const nameStart = names.some((name) => new RegExp(`^${escapeRegExp(name)}\\b`, 'i').test(compact))

  return sentences.some((sentence) => {
    if (sentence.length < 18) return false
    const looksLikeAction = actionStart.test(sentence) || nameStart
    return looksLikeAction && (actionVerb.test(sentence) || narrationNoun.test(sentence))
  })
}

function issueScore(issues: ProseHygieneIssue[]): number {
  return issues.reduce((sum, issue) => {
    if (issue.severity === 'error') return sum + 5
    if (issue.code === 'repeated_character_name') return sum + 3
    if (issue.code === 'consecutive_name_sentence_starts') return sum + 3
    if (issue.code === 'unbalanced_italics') return sum + 3
    if (issue.code === 'plain_narration_outside_markers') return sum + 3
    if (issue.code === 'double_asterisk_markers') return sum + 2
    return sum + 1
  }, 0)
}

function normalizedNames(names: string[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of names) {
    const name = String(raw || '').trim()
    if (name.length < 2) continue
    const key = name.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(name)
  }
  return out
}

export function validateProseHygiene(input: ProseHygieneInput): ProseHygieneIssue[] {
  const narrative = String(input.narrative || '')
  const issues: ProseHygieneIssue[] = []
  const trimmed = narrative.trim()

  if (!trimmed) {
    issues.push({
      code: 'empty_narrative',
      severity: 'error',
      message: 'Narrative is empty.',
    })
    return issues
  }

  if (/^\s*```/m.test(trimmed) || /^\s*(narrative|state_mutations|flag_mutations|scene_tag|emotional_tone)\s*:/im.test(trimmed)) {
    issues.push({
      code: 'metadata_leak',
      severity: 'error',
      message: 'Response appears to contain code fences or structured metadata.',
    })
  }

  if (/^\s*[-*]\s+\S/m.test(trimmed)) {
    issues.push({
      code: 'bullet_list',
      severity: 'warning',
      message: 'Response contains bullet-list formatting.',
    })
  }

  if (/["“”]/.test(trimmed)) {
    issues.push({
      code: 'dialogue_quotes_present',
      severity: 'warning',
      message: 'Response contains quotation marks; spoken dialogue should be plain text without quote markers.',
    })
  }

  if (/\*\*[^*]+?\*\*/.test(trimmed)) {
    issues.push({
      code: 'double_asterisk_markers',
      severity: 'warning',
      message: 'Response uses double-asterisk narration markers; use single *...* markers.',
    })
  }

  if (narrationMarkerCount(trimmed) % 2 !== 0) {
    issues.push({
      code: 'unbalanced_italics',
      severity: 'warning',
      message: 'Response has unbalanced narration italics markers.',
    })
  }

  const names = normalizedNames(input.characterNames || [])
  const unmarkedNarration = plainSegmentsOutsideNarration(trimmed).find((segment) =>
    plainSegmentLooksLikeNarration(segment, names),
  )
  if (unmarkedNarration) {
    issues.push({
      code: 'plain_narration_outside_markers',
      severity: 'warning',
      message: 'Response appears to leave narration/action text outside *...* markers.',
      detail: unmarkedNarration.slice(0, 180),
    })
  }

  if (names.length > 0) {
    const starts = sentenceStarts(trimmed)
    for (const name of names) {
      const startRe = new RegExp(`^${escapeRegExp(name)}\\b`, 'i')
      for (let i = 1; i < starts.length; i++) {
        if (startRe.test(starts[i - 1]) && startRe.test(starts[i])) {
          issues.push({
            code: 'consecutive_name_sentence_starts',
            severity: 'warning',
            message: 'Consecutive sentences start with the same character name.',
            detail: name,
          })
          i = starts.length
          break
        }
      }

      const mentionCount = countOccurrences(trimmed, name)
      if (mentionCount >= 3) {
        issues.push({
          code: 'repeated_character_name',
          severity: 'warning',
          message: 'Response repeats a character name too often for one turn.',
          detail: `${name}: ${mentionCount}`,
        })
      }
    }

    const mentioned = names.filter((name) => {
      const re = new RegExp(`\\b${escapeRegExp(name)}\\b`, 'i')
      return re.test(trimmed)
    })
    if (mentioned.length >= 4) {
      issues.push({
        code: 'many_codex_names_mentioned',
        severity: 'warning',
        message: 'Response mentions many codex character names, which may indicate codex leakage.',
        detail: mentioned.slice(0, 8).join(', '),
      })
    }
  }

  return issues
}

export function normalizeNarrationMarkers(narrative: string): string {
  return String(narrative || '').replace(/\*\*([\s\S]*?)\*\*/g, (_m, inner) => `*${String(inner).trim()}*`)
}

export async function repairProseHygiene(input: ProseHygieneInput & { model: string }): Promise<{
  narrative: string
  issues: ProseHygieneIssue[]
  repaired: boolean
}> {
  const normalized = normalizeNarrationMarkers(input.narrative).trim()
  const initialIssues = validateProseHygiene({
    narrative: normalized,
    characterNames: input.characterNames,
  })
  if (!initialIssues.some((issue) => REPAIRABLE_CODES.has(issue.code))) {
    return { narrative: normalized, issues: initialIssues, repaired: normalized !== input.narrative.trim() }
  }

  const repairPrompt = `Rewrite the story prose below to fix formatting and name hygiene only.

Rules:
- Keep the same events, facts, speaker intent, emotional beat, and approximate length.
- Spoken aloud words are plain text with no quotation marks.
- All narration, action, body language, inner thought, and dialogue attribution must be inside single asterisks, like *she says softly*.
- Scene description and atmospheric prose are narration. They must also be inside single asterisks.
- Text outside asterisks must be only the exact words spoken aloud by a character.
- Do not use double asterisks.
- Use a character's name only when needed for clarity. If the character is already clear, use pronouns, role descriptors, action, or body language.
- Do not start consecutive sentences with the same character name.
- Return only the revised story prose.

Known character names to avoid overusing: ${(input.characterNames || []).filter(Boolean).join(', ') || '(none)'}

Story prose:
${normalized}`

  try {
    const repaired = normalizeNarrationMarkers((await callLLM({
      model: input.model,
      messages: [{ role: 'user', content: repairPrompt }],
      temperature: 0.2,
      maxTokens: Math.max(300, Math.ceil(normalized.length / 3)),
    })).trim())
    const repairedIssues = validateProseHygiene({
      narrative: repaired,
      characterNames: input.characterNames,
    })
    if (repaired && issueScore(repairedIssues) <= issueScore(initialIssues)) {
      return { narrative: repaired, issues: repairedIssues, repaired: repaired !== input.narrative.trim() }
    }
  } catch {
    // Fall through to the normalized original; hygiene is advisory if repair fails.
  }

  return { narrative: normalized, issues: initialIssues, repaired: normalized !== input.narrative.trim() }
}
