import type { WorldFactSource } from './world-authority'
import { confidenceFor } from './world-authority'

/** One classified slice of player input, tagged with its world-fact authority.
 *  `source` is always a player-authored source. */
export interface PlayerInputFragment {
  text: string
  source: Extract<WorldFactSource, 'player_correction' | 'player_narration' | 'player_claim'>
  confidence: number
  /** true when authored inside *...* narration markers (vs. spoken dialogue). */
  authored: boolean
}

export interface ParsedPlayerInput {
  raw: string
  spoken: string
  /** Every fact authored inside *...* / **...** markers. Unchanged shape: this is
   *  `corrections ∪ actionFacts` (reported-speech narration is reclassified out as
   *  a claim). Existing callers that only want "what the player narrated" use this. */
  narrationFacts: string[]
  /** Narration fragments that read as an explicit out-of-character RETCON of canon
   *  ("Actually, Mara is my sister, not my cousin"). Highest authority. */
  corrections: string[]
  /** Player-character claims — spoken dialogue, or reported speech inside narration
   *  ("I tell the guard Mara is my sister"). Medium authority; may be a lie. */
  claims: string[]
  /** Narration of an action/fact the player authored as true, that is NOT a
   *  correction and NOT reported speech ("My sister Mara grabs my arm"). */
  actionFacts: string[]
  /** Every fragment with its resolved authority source, in document order. */
  fragments: PlayerInputFragment[]
}

function uniq(values: string[], max: number): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const v of values) {
    const t = v.trim()
    if (!t) continue
    const k = t.toLowerCase()
    if (seen.has(k)) continue
    seen.add(k)
    out.push(t)
    if (out.length >= max) break
  }
  return out
}

/** Out-of-character correction/retcon cues. When a narration fragment matches one
 *  of these it is treated as a `player_correction` (the player is fixing canon),
 *  not ordinary action narration. Deterministic; no LLM, off the TTFT path. */
const CORRECTION_CUES: RegExp[] = [
  /\b(actually|correction|to correct|let me correct|retcon|i meant|i mean)\b/i,
  /\b(ignore|disregard|scratch|forget|undo)\s+(that|the\s+last|what\s+i)\b/i,
  /\bthat'?s\s+(wrong|incorrect|not\s+right)\b/i,
  /\bi\s+lied\s+about\b/i,
  // "not X but Y" / "not X, Y" / "X, not Y" retcon shapes
  /\bnot\s+.{1,40}?\b(but|;|,)\s+.{1,40}/i,
  /\b\w+,\s+not\s+\w+/i,
]

/** Reported-speech leads — narration that is really the player CHARACTER claiming
 *  something in-world ("I tell him…", "I lie that…"). Reclassified to a claim. */
const REPORTED_SPEECH = /^\s*i\s+(tell|told|say|said|whisper|whispered|explain|explained|claim|claimed|insist|insisted|lie|lied|mention|mentioned|admit|admitted|reply|replied|announce|announced)\b/i

function isCorrection(text: string): boolean {
  return CORRECTION_CUES.some((re) => re.test(text))
}

function isReportedSpeech(text: string): boolean {
  return REPORTED_SPEECH.test(text)
}

/**
 * Deterministically split + CLASSIFY player input by authority:
 * - narration inside *...* / **...** is `player_narration` by default, but is
 *   promoted to `player_correction` when it reads as a retcon, or demoted to a
 *   `player_claim` when it's reported speech ("I tell him X").
 * - spoken text outside the markers is `player_claim` (the character said it).
 *
 * Pure + cheap; runs before extraction and never blocks streaming. The richer
 * authority is consumed post-stream by the kinship/codex mergers.
 */
export function parsePlayerInput(rawInput: string): ParsedPlayerInput {
  const raw = String(rawInput || '')
  const fragments: PlayerInputFragment[] = []
  const narrationFacts: string[] = []
  const corrections: string[] = []
  const claims: string[] = []
  const actionFacts: string[] = []
  const spokenParts: string[] = []

  // Accept both *...* and **...** markers, non-greedy, multiline-safe.
  const markerRe = /\*\*([\s\S]+?)\*\*|\*([\s\S]+?)\*/g
  let cursor = 0
  let m: RegExpExecArray | null

  while ((m = markerRe.exec(raw)) !== null) {
    spokenParts.push(raw.slice(cursor, m.index))
    const fact = (m[1] ?? m[2] ?? '').trim()
    if (fact) {
      if (isCorrection(fact)) {
        corrections.push(fact)
        narrationFacts.push(fact)
        fragments.push({ text: fact, source: 'player_correction', confidence: confidenceFor('player_correction'), authored: true })
      } else if (isReportedSpeech(fact)) {
        // Reported speech authored inside narration is still an in-world CLAIM.
        claims.push(fact)
        fragments.push({ text: fact, source: 'player_claim', confidence: confidenceFor('player_claim'), authored: true })
      } else {
        actionFacts.push(fact)
        narrationFacts.push(fact)
        fragments.push({ text: fact, source: 'player_narration', confidence: confidenceFor('player_narration'), authored: true })
      }
    }
    cursor = m.index + m[0].length
  }

  spokenParts.push(raw.slice(cursor))

  const spoken = spokenParts
    .join('')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

  if (spoken) {
    // Spoken dialogue is a player-character claim. A spoken out-of-character retcon
    // ("actually, she's my sister") still counts as a correction — authority wins.
    if (isCorrection(spoken)) {
      corrections.push(spoken)
      fragments.push({ text: spoken, source: 'player_correction', confidence: confidenceFor('player_correction'), authored: false })
    } else {
      claims.push(spoken)
      fragments.push({ text: spoken, source: 'player_claim', confidence: confidenceFor('player_claim'), authored: false })
    }
  }

  return {
    raw,
    spoken,
    narrationFacts: uniq(narrationFacts, 24),
    corrections: uniq(corrections, 12),
    claims: uniq(claims, 12),
    actionFacts: uniq(actionFacts, 24),
    fragments,
  }
}
