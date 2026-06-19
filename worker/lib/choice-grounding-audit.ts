/**
 * General choice-grounding AUDIT + repair (§9). The drop filter (groundChoices)
 * removes a choice that references something the world can't support — but dropping
 * shrinks the player's options. This layer instead REPAIRS the misunderstanding in
 * place wherever it can, treating an ungrounded choice as a category error to be
 * reframed, not deleted:
 *   - an unconfirmed supernatural being ("attack the ghost" in a grounded world)
 *     becomes "investigate the presence" — curiosity, not a reified metaphor.
 *   - an absent / wrong-perspective kin relation ("hug my sister" when there is no
 *     sister) becomes "ask about the connection" — an investigation, not a
 *     fabricated certainty.
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

/** Build the grounded rewrite of a choice from its FIRST (primary) issue, or null
 *  when no clean repair exists. Repairs are intentionally generic + safe — they
 *  reframe the misunderstanding rather than invent new specifics. */
function repairChoice<T extends GroundableChoice>(choice: T, issues: ChoiceGroundingIssue[]): T | null {
  const primary = issues[0]
  if (!primary) return null
  if (primary.type === 'ungrounded_being') {
    return {
      ...choice,
      label: 'Investigate the presence',
      kind: 'act',
      send: '*I look closer, trying to make sense of what I am seeing.*',
    }
  }
  // fabricated_kin / perspective_kin → reframe the assumed relation as a question.
  return {
    ...choice,
    label: 'Ask about the connection',
    kind: 'say',
    send: 'How do we know each other?',
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
