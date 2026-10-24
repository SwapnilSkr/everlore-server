/**
 * Projection ANOMALY detector (§12). Pure, deterministic checks that compare a
 * turn's PROSE against what the projection actually recorded, surfacing places
 * where extraction probably drifted. It never blocks a turn — the processor runs
 * it fire-and-forget on the post-stream tail and persists the rows for a debug/
 * admin surface. Reuses the same detectors the live path uses (presence tiers,
 * kinship ontology, choice grounding) so the audit and the pipeline can't diverge.
 */
import { classifyPresenceCodexGaps } from './presence-gap-detector'
import { SURFACE_KIN_TERMS, isFigurativeKinship, surfaceToKind } from '../../src/utils/kinship-ontology'
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
  /**
   * Extra surfaces that count as ALREADY tracked — the distinctive tokens of
   * everyone in the scene or on a card ("Neva" for "Neva Vale").
   *
   * Without these the detector compares on whole normalized names, so the prose's
   * ordinary short form of a character who is standing in the room AND has a card
   * was reported as an untracked stranger on nearly every turn. That is pure noise
   * in a log whose entire value is that it only fires on real misses.
   */
  excludeNames?: string[]
  /**
   * Relation groups the save's relationship graph ALREADY holds for the
   * player/protagonist side (see {@link kinRelationGroup}). A possessive kin
   * phrase naming one of these is not a miss — the tie was recorded turns ago.
   *
   * Omitted when the read wasn't made or failed: the check then behaves exactly
   * as it always has (logs), never silently suppresses.
   */
  knownKinRelations?: string[]
}

function norm(s: string): string {
  return s.toLowerCase().trim().replace(/[^a-z0-9\s'-]+/g, '').replace(/\s+/g, ' ')
}

/**
 * The relation GROUP a kin term or a graph edge belongs to: structural kind +
 * gender + modifier, read straight from the kinship ontology (SURFACE_TERMS).
 * "dad" and "father" share `parent_of|m|`, while "mother" (`parent_of|f|`) and
 * "stepfather" (`parent_of|m|step`) stay distinct — the same synonym collapse the
 * choice guard relies on, without a second hand-maintained word list.
 *
 * `biological` is the writer's default for an unmarked tie (applyRelationAssertions
 * stamps it on every edge), so it sorts with "no modifier": a prose "father" and
 * its stored edge must land in ONE group.
 */
export function kinRelationGroup(
  kind: string | null | undefined,
  gender?: string | null,
  modifier?: string | null,
): string | null {
  if (!kind) return null
  const mod = !modifier || modifier === 'biological' ? '' : modifier
  return `${kind}|${gender || ''}|${mod}`
}

const KIN_WORDS = [...SURFACE_KIN_TERMS].sort((a, b) => b.length - a.length).join('|')
// Capture group 1 is the kin word itself, so EVERY match can be normalised to its
// relation group — not just the first phrase the prose happens to contain.
const POSSESSIVE_KIN_SOURCE = `\\b(?:my|your|his|her|their|our)\\s+(${KIN_WORDS})\\b`

/** Every distinct possessive kin phrase in the prose, with its relation group. */
function possessiveKinMatches(prose: string): { phrase: string; term: string; group: string | null }[] {
  const out: { phrase: string; term: string; group: string | null }[] = []
  const seen = new Set<string>()
  for (const m of prose.matchAll(new RegExp(POSSESSIVE_KIN_SOURCE, 'gi'))) {
    const term = String(m[1] || '').toLowerCase()
    const mapped = surfaceToKind(term)
    const group = kinRelationGroup(mapped?.kind, mapped?.gender, mapped?.modifier)
    const key = group || term
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ phrase: m[0], term, group })
  }
  return out
}

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
    exclude: input.excludeNames || [],
  }
  const confirmedUntracked = classifyPresenceCodexGaps(prose, tracked).filter((m) => m.tier === 'confirmed')
  for (const m of confirmedUntracked.slice(0, 5)) {
    findings.push({
      type: 'prose_person_untracked',
      severity: 'warn',
      details: `"${m.display}" acts/speaks in the prose (${m.evidence}) but isn't in presence/codex/stubs`,
    })
  }

  // 2. A kinship phrase in the prose that the relationship graph does NOT hold.
  // A phrase naming a tie recorded turns ago ("your father" when a father edge
  // landed three turns back) is not an extraction miss — it was the miss when the
  // tie was ABSENT. With the save's known groups supplied, only unknown ties
  // count. Without them the check logs, exactly as before.
  const kinMatches = possessiveKinMatches(prose)
  if (!input.hadRelationAssertion && kinMatches.length > 0 && !isFigurativeKinship(prose)) {
    if (input.knownKinRelations === undefined) {
      findings.push({
        type: 'kinship_phrase_no_edge',
        severity: 'info',
        details: `prose states a kin tie (${kinMatches[0].phrase}) but no relation assertion was produced`,
      })
    } else {
      const known = new Set(input.knownKinRelations)
      const unknown = kinMatches.filter((m) => !m.group || !known.has(m.group))
      if (unknown.length > 0) {
        findings.push({
          type: 'kinship_phrase_no_edge',
          severity: 'info',
          details: `prose states a kin tie (${unknown.map((m) => m.term).join(', ')}) the relationship graph doesn't hold`,
        })
      }
    }
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
