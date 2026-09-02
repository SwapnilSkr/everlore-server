import { comparable, hasExactEvidence } from './scene-endpoint-adjudicator'
import type { CitationCheck } from '../../src/models/extractor-raw.model'

/**
 * Citation stack for the scene witness's `time_elapsed` claim.
 *
 * The calendar has never had a model authority: `narratedTimeLabel` was assigned
 * from a regex over the PLAYER'S text and `parsed.time_elapsed` reached the
 * signal ledger and nothing else. That regex cannot see a skip the narrator
 * wrote and the player did not ("Two days later, the rain finally stopped"), so
 * a journey that took a week left the date unchanged.
 *
 * The witness may now advance the calendar, on the same terms as presence and
 * place: it must quote the sentence that says the time passed.
 *
 *   (a) the excerpt appears verbatim in the narration      — not fabricated
 *   (b) the excerpt carries the span the label claims      — this much time
 *
 * There is no (c). "Did time pass in the fiction" is precisely the model's
 * judgement to make; what a citation can verify is that it did not invent the
 * sentence or inflate the span. The units below are the same ones the calendar's
 * own `advanceDays` parses — arithmetic, not a reading of the fiction.
 */

const UNIT_PATTERN = '(?:minute|hour|day|night|week|fortnight|month|season|year|decade|century)s?'
const AMOUNT_PATTERN =
  '(?:\\d+|a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|couple|few|several|many|countless)'
const SPAN = new RegExp(`\\b(?:${AMOUNT_PATTERN}\\s+){0,2}${UNIT_PATTERN}\\b`, 'g')

/** Day-boundary phrases that carry a span without naming a unit. */
const IMPLICIT_SPAN = /\b(?:dawn|dusk|midnight|morning|afternoon|evening|tonight|overnight|tomorrow|later|next day|by nightfall|sunrise|sunset)\b/

function spansIn(value: string): string[] {
  const text = comparable(value)
  SPAN.lastIndex = 0
  return (text.match(SPAN) || []).map((span) => span.trim())
}

/** (b): the cited excerpt actually carries the span the label claims. */
export function excerptCarriesSpan(label: string, evidence: string): boolean {
  const excerpt = comparable(evidence)
  if (!excerpt) return false
  const claimed = spansIn(label)
  if (!claimed.length) {
    // A label with no unit ("the next morning") needs a day-boundary phrase.
    return IMPLICIT_SPAN.test(excerpt) || spansIn(evidence).length > 0
  }
  const cited = spansIn(evidence)
  if (!cited.length) return false
  // The unit must match. "three days" may not be cited by "three hours", and a
  // bare "days" may not be cited by "a moment".
  const unitOf = (span: string) => (span.match(new RegExp(UNIT_PATTERN))?.[0] || '').replace(/s$/, '')
  const claimedUnits = new Set(claimed.map(unitOf).filter(Boolean))
  return cited.some((span) => claimedUnits.has(unitOf(span)))
}

export interface TimeCitationVerdict {
  label: string
  evidence: string
  a: boolean
  b: boolean
  rejected: CitationCheck[]
}

export function evaluateTimeCitation(params: {
  label: string
  evidence: string
  source: string
}): TimeCitationVerdict {
  const a = hasExactEvidence(params.evidence, params.source)
  const b = excerptCarriesSpan(params.label, params.evidence)
  const rejected: CitationCheck[] = []
  if (!a) rejected.push('a')
  if (!b) rejected.push('b')
  return { label: params.label, evidence: params.evidence, a, b, rejected }
}

export function citationAdmitsTimeSkip(verdict: TimeCitationVerdict): boolean {
  return verdict.a && verdict.b
}
