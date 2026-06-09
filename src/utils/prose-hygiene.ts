import { callLLM } from '../ai/client'
import type { MessageLength } from './narrative-styles'

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
  messageLength?: MessageLength
  /** Character names that opened the immediately prior assistant turn/variant. */
  previousOpeningNames?: string[]
  /** Character names that should not open this response even if the prior turn varied. */
  avoidOpeningNames?: string[]
}

const REPAIRABLE_CODES = new Set([
  'unbalanced_dialogue_quotes',
  'unquoted_text_outside_markers',
  'double_asterisk_markers',
  'unbalanced_italics',
  'plain_narration_outside_markers',
  'consecutive_name_sentence_starts',
  'overused_opening_character_name',
  'repeated_opening_character_name',
  'repeated_character_name',
  'repeated_short_character_name',
  'repeated_full_character_name',
  'length_too_short',
  'length_too_long',
  'too_many_paragraphs',
  'too_few_paragraphs',
  'short_reply_overexpanded',
  'long_reply_underdeveloped',
  'incomplete_ending',
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

function quoteMarkerCount(text: string): number {
  return (text.match(/["“”]/g) || []).length
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

function proseWords(text: string): string[] {
  return String(text || '')
    .replace(/\*/g, ' ')
    .replace(/[“”]/g, '"')
    .replace(/["'()[\]{}]/g, ' ')
    .split(/\s+/)
    .map((w) => w.trim())
    .filter((w) => /[A-Za-z0-9]/.test(w))
}

function paragraphCount(text: string): number {
  return String(text || '')
    .trim()
    .split(/\n\s*\n+/)
    .map((p) => p.trim())
    .filter(Boolean).length || 1
}

function sentenceCount(text: string): number {
  return String(text || '')
    .replace(/\n+/g, ' ')
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => /[A-Za-z0-9]/.test(s)).length
}

function shortNameFor(name: string): string | null {
  const first = String(name || '').trim().split(/\s+/)[0]
  return first && first.length >= 3 ? first : null
}

function visibleEnding(text: string): string {
  return String(text || '')
    .trim()
    .replace(/[\s*"'”’]+$/g, '')
}

function looksIncompleteEnding(text: string): boolean {
  const end = visibleEnding(text)
  if (!end) return true
  if (/[.!?…]$/.test(end)) return false
  if (/[,;:—–-]$/.test(end)) return true
  if (/\b(?:and|but|because|then|as|while|when|if|though|although|so|or|with|without|to|from|into|toward|towards|before|after|until|unless)$/i.test(end)) {
    return true
  }
  return true
}

function startsWithName(text: string, name: string): boolean {
  const compact = String(text || '')
    .trim()
    .replace(/^[\s*_]+/, '')
  const names = [name, shortNameFor(name)].filter((n): n is string => !!n)
  return names.some((n) => {
    const re = new RegExp(`^${escapeRegExp(n)}(?:\\b|'s\\b)`, 'i')
    return re.test(compact)
  })
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

function unquotedTextOutsideNarration(segment: string): string {
  const withoutQuotedSpeech = segment
    .replace(/"[^"]*"/g, ' ')
    .replace(/“[^”]*”/g, ' ')
    .replace(/[,\s.!?;:—–-]+/g, '')
  return withoutQuotedSpeech
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
    if (issue.code === 'repeated_full_character_name') return sum + 4
    if (issue.code === 'repeated_short_character_name') return sum + 3
    if (issue.code === 'length_too_short') return sum + 3
    if (issue.code === 'length_too_long') return sum + 3
    if (issue.code === 'too_many_paragraphs') return sum + 2
    if (issue.code === 'too_few_paragraphs') return sum + 2
    if (issue.code === 'short_reply_overexpanded') return sum + 3
    if (issue.code === 'long_reply_underdeveloped') return sum + 3
    if (issue.code === 'incomplete_ending') return sum + 5
    if (issue.code === 'repeated_opening_character_name') return sum + 3
    if (issue.code === 'overused_opening_character_name') return sum + 3
    if (issue.code === 'consecutive_name_sentence_starts') return sum + 3
    if (issue.code === 'unbalanced_italics') return sum + 3
    if (issue.code === 'unbalanced_dialogue_quotes') return sum + 3
    if (issue.code === 'unquoted_text_outside_markers') return sum + 3
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

  if (quoteMarkerCount(trimmed) % 2 !== 0) {
    issues.push({
      code: 'unbalanced_dialogue_quotes',
      severity: 'warning',
      message: 'Response has unbalanced dialogue quote markers.',
    })
  }

  if (looksIncompleteEnding(trimmed)) {
    issues.push({
      code: 'incomplete_ending',
      severity: 'warning',
      message: 'Response appears to end mid-sentence or without a clean terminal beat.',
    })
  }

  const requestedLength = input.messageLength
  if (requestedLength) {
    const words = proseWords(trimmed).length
    const paragraphs = paragraphCount(trimmed)
    const sentences = sentenceCount(trimmed)
    if (requestedLength === 'short') {
      if (words > 150 || paragraphs > 1) {
        issues.push({
          code: 'short_reply_overexpanded',
          severity: 'warning',
          message: 'Short reply is too expanded for the selected length.',
          detail: `${words} words, ${paragraphs} paragraphs`,
        })
      }
      if (words < 15 || sentences < 1) {
        issues.push({
          code: 'length_too_short',
          severity: 'warning',
          message: 'Short reply is too thin to feel like a complete beat.',
          detail: `${words} words, ${sentences} sentences`,
        })
      }
    } else if (requestedLength === 'medium') {
      if (words < 80) {
        issues.push({
          code: 'length_too_short',
          severity: 'warning',
          message: 'Medium reply is shorter than the selected length.',
          detail: `${words} words`,
        })
      }
      if (words > 360) {
        issues.push({
          code: 'length_too_long',
          severity: 'warning',
          message: 'Medium reply is longer than the selected length.',
          detail: `${words} words`,
        })
      }
      if (paragraphs < 2 && words >= 100) {
        issues.push({
          code: 'too_few_paragraphs',
          severity: 'warning',
          message: 'Medium reply should be shaped into a few short paragraphs, not one dense block.',
          detail: `${words} words, ${paragraphs} paragraphs`,
        })
      }
      if (paragraphs > 4) {
        issues.push({
          code: 'too_many_paragraphs',
          severity: 'warning',
          message: 'Medium reply has too many paragraphs for a balanced turn.',
          detail: `${paragraphs} paragraphs`,
        })
      }
    } else if (requestedLength === 'long') {
      if (words < 200 || paragraphs < 3) {
        issues.push({
          code: 'long_reply_underdeveloped',
          severity: 'warning',
          message: 'Long reply is underdeveloped for the selected length.',
          detail: `${words} words, ${paragraphs} paragraphs`,
        })
      }
      if (words > 800) {
        issues.push({
          code: 'length_too_long',
          severity: 'warning',
          message: 'Long reply exceeds the selected length.',
          detail: `${words} words`,
        })
      }
      if (paragraphs > 6) {
        issues.push({
          code: 'too_many_paragraphs',
          severity: 'warning',
          message: 'Long reply has too many paragraphs.',
          detail: `${paragraphs} paragraphs`,
        })
      }
    }
  }

  const names = normalizedNames(input.characterNames || [])
  const unquotedSegment = plainSegmentsOutsideNarration(trimmed).find((segment) =>
    /[A-Za-z]/.test(unquotedTextOutsideNarration(segment)),
  )
  if (unquotedSegment) {
    issues.push({
      code: 'unquoted_text_outside_markers',
      severity: 'warning',
      message: 'Response has text outside *...* markers that is not wrapped as quoted speech.',
      detail: unquotedSegment.slice(0, 180),
    })
  }

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
    const previousOpeningNames = normalizedNames(input.previousOpeningNames || [])
    const repeatedOpening = previousOpeningNames.find((name) => startsWithName(trimmed, name))
    if (repeatedOpening) {
      issues.push({
        code: 'repeated_opening_character_name',
        severity: 'warning',
        message: 'Response opens with the same character name as the previous turn.',
        detail: repeatedOpening,
      })
    }

    const avoidOpeningNames = normalizedNames(input.avoidOpeningNames || [])
    const avoidedOpening = avoidOpeningNames.find((name) => startsWithName(trimmed, name))
    if (avoidedOpening) {
      issues.push({
        code: 'overused_opening_character_name',
        severity: 'warning',
        message: 'Response opens with a character name that should be varied for this turn.',
        detail: avoidedOpening,
      })
    }

    const anyNameOpening = names.find((name) => startsWithName(trimmed, name))
    if (anyNameOpening && !repeatedOpening && !avoidedOpening) {
      issues.push({
        code: 'overused_opening_character_name',
        severity: 'warning',
        message: 'Response opens with a known character name instead of a natural beat.',
        detail: anyNameOpening,
      })
    }

    const starts = sentenceStarts(trimmed)
    for (const name of names) {
      const startRe = new RegExp(`^${escapeRegExp(name)}(?:\\b|'s\\b)`, 'i')
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
      if (mentionCount >= 2) {
        issues.push({
          code: 'repeated_full_character_name',
          severity: 'warning',
          message: 'Response repeats a full canonical character name too often for natural prose.',
          detail: `${name}: ${mentionCount}`,
        })
      } else if (mentionCount >= 3) {
        issues.push({
          code: 'repeated_character_name',
          severity: 'warning',
          message: 'Response repeats a character name too often for one turn.',
          detail: `${name}: ${mentionCount}`,
        })
      }

      const shortName = shortNameFor(name)
      if (shortName && shortName.toLowerCase() !== name.toLowerCase()) {
        const shortMentionCount = countOccurrences(trimmed, shortName)
        if (shortMentionCount >= 3) {
          issues.push({
            code: 'repeated_short_character_name',
            severity: 'warning',
            message: 'Response repeats a short character name too often for one turn.',
            detail: `${shortName}: ${shortMentionCount}`,
          })
        }
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
  return String(narrative || '')
    .replace(/[“”]/g, '"')
    .replace(/\*\*([\s\S]*?)\*\*/g, (_m, inner) => `*${String(inner).trim()}*`)
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
    messageLength: input.messageLength,
    previousOpeningNames: input.previousOpeningNames,
    avoidOpeningNames: input.avoidOpeningNames,
  })
  if (!initialIssues.some((issue) => REPAIRABLE_CODES.has(issue.code))) {
    return { narrative: normalized, issues: initialIssues, repaired: normalized !== input.narrative.trim() }
  }

  const repairPrompt = `Rewrite the story prose below to fix formatting and name hygiene only.

Rules:
- Keep the same events, facts, speaker intent, emotional beat, and approximate length.
- Spoken aloud words must be wrapped in double quotes, like "I missed you."
- All narration, action, body language, inner thought, and dialogue attribution must be inside single asterisks, like *she says softly*.
- Scene description and atmospheric prose are narration. They must also be inside single asterisks.
- Text outside asterisks must be quoted speech only.
- Do not use double asterisks.
- Natural conversation flow is mandatory. Character-name repetition is a quality failure.
- Use a character's name only when needed for clarity: first entrance, reintroduction, direct address, multiple ambiguous actors, or explicit contrast.
- If the character is already clear, remove the name and use pronouns, role descriptors, action, body language, silence, setting, or dialogue.
- Avoid full canonical names in ordinary narration. If a name is unavoidable, prefer a short first name unless formality or disambiguation truly requires the full name.
- Do not start consecutive sentences with the same character name.
- If the previous turn opened with a character name, do not open this rewrite with that same name.
- Do not open this rewrite with any name listed as an opening to avoid; begin with pronoun, action, body language, speech, or setting instead.
- In one-on-one beats, names should be almost absent after the character is established.
- In multi-character beats, use names only to restore clarity, then return to pronouns and distinct actions.
- Finish cleanly. Do not end mid-sentence, on a dangling connector, or with unbalanced quotes/asterisks.
- Obey the selected reply length as a quality requirement:
  - short = 1 short paragraph, about 2-4 sentences; concise but complete.
  - medium = about 2-3 short paragraphs; vivid but not bloated.
  - long = about 3-5 developed paragraphs; richer sensory detail/interiority without padding.
- If adjusting length, do not add new facts, new characters, new lore, new danger, new romance escalation, or new decisions just to hit the target.
- Return only the revised story prose.

Known character names to avoid overusing: ${(input.characterNames || []).filter(Boolean).join(', ') || '(none)'}
Previous opening names to avoid repeating at the start: ${(input.previousOpeningNames || []).filter(Boolean).join(', ') || '(none)'}
Openings to avoid for this turn: ${(input.avoidOpeningNames || []).filter(Boolean).join(', ') || '(none)'}
Selected reply length: ${input.messageLength || 'medium'}

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
      messageLength: input.messageLength,
      previousOpeningNames: input.previousOpeningNames,
      avoidOpeningNames: input.avoidOpeningNames,
    })
    if (repaired && issueScore(repairedIssues) <= issueScore(initialIssues)) {
      return { narrative: repaired, issues: repairedIssues, repaired: repaired !== input.narrative.trim() }
    }
  } catch {
    // Fall through to the normalized original; hygiene is advisory if repair fails.
  }

  return { narrative: normalized, issues: initialIssues, repaired: normalized !== input.narrative.trim() }
}
