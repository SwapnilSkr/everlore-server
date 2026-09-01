/**
 * Projection ANOMALY detector (§12). Pure, deterministic checks that compare a
 * turn's PROSE against what the projection actually recorded, surfacing places
 * where extraction probably drifted. It never blocks a turn — the processor runs
 * it fire-and-forget on the post-stream tail and persists the rows for a debug/
 * admin surface. Reuses the same detectors the live path uses (presence tiers,
 * kinship ontology, choice grounding) so the audit and the pipeline can't diverge.
 */
import { classifyPresenceCodexGaps } from './presence-gap-detector'
import { SURFACE_KIN_TERMS, isFigurativeKinship } from '../../src/utils/kinship-ontology'
import type { ChoiceGroundingIssue } from './choice-grounding'

export interface AnomalyFinding {
  type:
    | 'prose_person_untracked'
    | 'kinship_phrase_no_edge'
    | 'choice_ungrounded'
    | 'location_phrase_no_anchor'
    | 'card_without_prose_anchor'
  severity: 'info' | 'warn' | 'error'
  details: string
}

export interface AnomalyInput {
  prose: string
  /** Names recorded present this turn (post-fold). */
  presentNames: string[]
  /** Normalized names that already have a codex card. */
  codexNames: string[]
  /** Normalized names a stub was ensured for this turn. */
  stubNames: string[]
  /** Did this turn produce ANY relation assertion (LLM ∪ deterministic)? */
  hadRelationAssertion: boolean
  /** Choices that could not be grounded or repaired (from the choice audit). */
  droppedChoices?: { issues: ChoiceGroundingIssue[] }[]
  /** The resolved current-place name, or null when none. */
  locationAnchorName?: string | null
  /** The place the scene witness reported for this turn, if any. */
  witnessLocationName?: string | null
  /** Canonical names of codex cards MINTED this turn (new this turn). */
  newCardNames?: string[]
}

function norm(s: string): string {
  return s.toLowerCase().trim().replace(/[^a-z0-9\s'-]+/g, '').replace(/\s+/g, ' ')
}

const POSSESSIVE_KIN = new RegExp(
  `\\b(?:my|your|his|her|their|our)\\s+(?:${[...SURFACE_KIN_TERMS].sort((a, b) => b.length - a.length).join('|')})\\b`,
  'i',
)
// NOTE: a regex over "in the <noun>" used to stand in for "the prose names a
// place". It fired on "in the mud", "in the saddle", "in the cold air" — an
// anomaly feed nobody could read. The real anomaly is narrower and exact: the
// WITNESS named a place this turn and the projection anchored nothing.

/**
 * Run all checks for one turn. Bounded; returns the findings (possibly empty).
 */
export function detectProjectionAnomalies(input: AnomalyInput): AnomalyFinding[] {
  const findings: AnomalyFinding[] = []
  const prose = String(input.prose || '')

  // 1. A CONFIRMED person in the prose that the projection didn't track anywhere.
  const tracked = {
    present: input.presentNames,
    codex: input.codexNames,
    stubs: input.stubNames,
  }
  const confirmedUntracked = classifyPresenceCodexGaps(prose, tracked).filter((m) => m.tier === 'confirmed')
  for (const m of confirmedUntracked.slice(0, 5)) {
    findings.push({
      type: 'prose_person_untracked',
      severity: 'warn',
      details: `"${m.display}" acts/speaks in the prose (${m.evidence}) but isn't in presence/codex/stubs`,
    })
  }

  // 2. A kinship phrase in the prose but the turn recorded no relation assertion.
  if (!input.hadRelationAssertion && POSSESSIVE_KIN.test(prose) && !isFigurativeKinship(prose)) {
    const m = prose.match(POSSESSIVE_KIN)
    findings.push({
      type: 'kinship_phrase_no_edge',
      severity: 'info',
      details: `prose states a kin tie (${m?.[0] ?? 'kin phrase'}) but no relation assertion was produced`,
    })
  }

  // 3. Choices that couldn't be grounded OR repaired.
  for (const d of input.droppedChoices || []) {
    findings.push({
      type: 'choice_ungrounded',
      severity: 'warn',
      details: `choice dropped (unrepairable): ${d.issues.map((i) => `${i.type}:${i.term}`).join(', ')}`,
    })
  }

  // 4. The witness named a place this turn and nothing anchored to it. This is
  // a genuine extraction/projection mismatch — unlike a prose phrase, a witness
  // label is an actual claim that a place was identified.
  const witnessPlace = String(input.witnessLocationName || '').trim()
  if (!input.locationAnchorName && witnessPlace) {
    findings.push({
      type: 'location_phrase_no_anchor',
      severity: 'warn',
      details: `the scene witness identified "${witnessPlace}" but no location anchor resolved`,
    })
  }

  // 5. A codex card minted this turn whose name never appears in the prose.
  const proseNorm = ` ${norm(prose)} `
  for (const name of input.newCardNames || []) {
    const n = norm(name)
    if (n && n.length >= 3 && !proseNorm.includes(` ${n} `)) {
      findings.push({
        type: 'card_without_prose_anchor',
        severity: 'info',
        details: `card "${name}" minted but its name isn't in this turn's prose`,
      })
    }
  }

  return findings
}
