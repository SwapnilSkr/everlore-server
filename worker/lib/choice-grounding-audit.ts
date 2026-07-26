/**
 * General choice-grounding AUDIT + repair (§9). The drop filter (groundChoices)
 * removes a choice that references something the world can't support — but dropping
 * shrinks the player's options. This layer instead REPAIRS the misunderstanding in
 * place where it can do so without preserving the false premise:
 *   - an unconfirmed supernatural being ("attack the ghost" in a grounded world)
 *     is dropped instead of rewritten; there is no generic repair that does not
 *     keep the category error alive.
 *   - an absent / wrong-perspective kin relation ("hug my sister" when there is no
 *     sister) becomes a neutral response to the moment, not a fabricated certainty.
 * A choice with no sensible repair (or whose repair would duplicate another choice)
 * is dropped. Pure string work, no model call, off the TTFT path — same as the
 * drop filter it builds on. Reuses the SHARED grounding context + classifier so it
 * reasons over exactly the same facts.
 */
import {
  type GroundableChoice,
  type GroundingOpts,
  type ChoiceGroundingIssue,
  computeGroundingContext,
  classifyChoiceGrounding,
} from './choice-grounding'

export interface ChoiceAudit<T extends GroundableChoice> {
  choice: T
  grounded: boolean
  issues: ChoiceGroundingIssue[]
  /** The grounded rewrite, when an in-place repair was possible. */
  repaired?: T
}

export interface ChoiceAuditResult<T extends GroundableChoice> {
  /** Per-choice audit detail (for logs / the anomaly detector). */
  results: ChoiceAudit<T>[]
  /** The grounded set to actually use: untouched + repaired, dropped excluded. */
  choices: T[]
  /** Choices that could not be grounded or repaired (and why). */
  dropped: { choice: T; issues: ChoiceGroundingIssue[] }[]
  /** How many choices were rewritten in place. */
  repairedCount: number
}

/**
 * Fast, location-only preflight for narrator-owned choices. It intentionally
 * does not apply kinship or supernatural checks: those require the fuller
 * post-prose context and run in [auditChoices] later. This narrowly prevents a
 * stale setting from becoming a tappable "leave the gallery" chip while the
 * rest of the post-stream tail is still running.
 */
export function repairStaleDepartureChoices<T extends GroundableChoice>(
  choices: T[],
  currentLocationName?: string | null,
): ChoiceAuditResult<T> {
  const ctx = computeGroundingContext([], undefined, [], undefined, { currentLocationName })
  const results: ChoiceAudit<T>[] = []
  const out: T[] = []
  const dropped: { choice: T; issues: ChoiceGroundingIssue[] }[] = []
  let repairedCount = 0

  for (const choice of choices || []) {
    const allIssues = classifyChoiceGrounding(`${choice?.label || ''} ${choice?.send || ''}`, ctx)
    const locationIssue = allIssues.filter((issue) => issue.type === 'location_mismatch')
    if (!locationIssue.length) {
      results.push({ choice, grounded: true, issues: [] })
      out.push(choice)
      continue
    }
    const repaired = repairChoice(choice, locationIssue)
    if (repaired) {
      results.push({ choice, grounded: false, issues: locationIssue, repaired })
      out.push(repaired)
      repairedCount++
    } else {
      results.push({ choice, grounded: false, issues: locationIssue })
      dropped.push({ choice, issues: locationIssue })
    }
  }
  return { results, choices: out, dropped, repairedCount }
}

/** Build the grounded rewrite of a choice from its FIRST (primary) issue, or null
 *  when no clean repair exists. Repairs are intentionally generic + safe — they
 *  reframe the misunderstanding rather than invent new specifics. */
function repairChoice<T extends GroundableChoice>(choice: T, issues: ChoiceGroundingIssue[]): T | null {
  const primary = issues[0]
  if (!primary) return null
  if (primary.type === 'ungrounded_being') {
    return null
  }
  if (primary.type === 'location_mismatch') {
    return {
      ...choice,
      label: 'Leave the current place',
      kind: 'act',
      send: '*I stand and leave the current place, carrying the conversation with me.*',
    }
  }
  // fabricated_kin / perspective_kin → remove the assumed relation entirely.
  return {
    ...choice,
    label: 'Respond to the moment',
    kind: 'act',
    send: '*I respond to what is actually happening, without assuming more than I know.*',
  }
}

/**
 * Audit + repair a turn's choices. Grounded choices pass through untouched;
 * ungrounded ones are repaired when possible (and not duplicate), else dropped.
 */
export function auditChoices<T extends GroundableChoice>(
  choices: T[],
  castVocab: string[],
  groundingText?: string,
  graphLabels?: string[],
  worldText?: string,
  opts?: GroundingOpts,
): ChoiceAuditResult<T> {
  const ctx = computeGroundingContext(castVocab, groundingText, graphLabels, worldText, opts)
  const results: ChoiceAudit<T>[] = []
  const out: T[] = []
  const dropped: { choice: T; issues: ChoiceGroundingIssue[] }[] = []
  let repairedCount = 0
  // Track labels already in the output so a repair can't duplicate an existing
  // choice (two fabricated-kin choices would both repair to the same prompt).
  const seenLabels = new Set<string>()
  for (const c of choices || []) {
    if (c?.label) seenLabels.add(c.label.trim().toLowerCase())
  }

  for (const c of choices || []) {
    const text = `${c?.label || ''} ${c?.send || ''}`
    const issues = classifyChoiceGrounding(text, ctx)
    if (!issues.length) {
      results.push({ choice: c, grounded: true, issues: [] })
      out.push(c)
      continue
    }
    const repaired = repairChoice(c, issues)
    const repairedKey = repaired?.label.trim().toLowerCase()
    // Accept a repair only if its label isn't already taken by another choice.
    if (repaired && repairedKey && !seenLabels.has(repairedKey)) {
      seenLabels.add(repairedKey)
      // The original label is being replaced — free it so it can't block others.
      if (c?.label) seenLabels.delete(c.label.trim().toLowerCase())
      results.push({ choice: c, grounded: false, issues, repaired })
      out.push(repaired)
      repairedCount++
    } else {
      results.push({ choice: c, grounded: false, issues })
      dropped.push({ choice: c, issues })
    }
  }
  return { results, choices: out, dropped, repairedCount }
}
