/**
 * Cursor drift — the re-derivation path for the location cursor.
 *
 * The cursor used to be a variable that could only ever be ASSIGNED, on a turn
 * a move was detected. Nothing could un-assign it, so one bad read or one missed
 * read was permanent: a War Room that survived the player walking out of it, a
 * root cellar that survived eleven turns in the hall. No extractor is accurate
 * enough to make a permanently-wrong variable safe — the fix is that being wrong
 * has to be recoverable.
 *
 * Every turn produces a SCENE ANCHOR: what this passage says, verified by the
 * citation stack, whether or not anything moved. When the anchor contradicts the
 * cursor about the SAME place on two consecutive turns, the cursor re-derives
 * itself — with no move ever having been detected, which is exactly the case the
 * old design had no way to represent.
 *
 * Two independent verified citations is a bar a passing mention cannot clear,
 * and any agreeing turn clears the counter, so a single stray read cannot
 * accumulate toward a repair on its own.
 */

export interface DriftState {
  name: string
  count: number
  since_sequence: number
}

export interface DriftDecision {
  /** Carry this onto the instance; null clears it. */
  next: DriftState | null
  /** Non-null when the cursor should re-anchor here this turn. */
  repair: string | null
  count: number
}

export const DRIFT_REPAIR_THRESHOLD = 2

export function decideCursorDrift(params: {
  /** The verified place this passage puts the viewpoint at, if any. */
  sceneAnchor: string | null
  /** Where the map currently thinks they are. */
  cursorName: string | null
  prior: DriftState | null | undefined
  sequence: number
  /** Injected so this module owns no name-matching policy of its own. */
  compatible: (a: string | null, b: string | null) => boolean
}): DriftDecision {
  const { sceneAnchor, cursorName, prior, sequence, compatible } = params
  if (!sceneAnchor || compatible(sceneAnchor, cursorName)) {
    return { next: null, repair: null, count: 0 }
  }
  const continues = !!prior?.name && compatible(sceneAnchor, prior.name)
  const count = continues ? (prior?.count || 0) + 1 : 1
  if (count >= DRIFT_REPAIR_THRESHOLD) {
    return { next: null, repair: sceneAnchor, count }
  }
  return { next: { name: sceneAnchor, count, since_sequence: sequence }, repair: null, count }
}

/**
 * Party decay — the re-derivation path for travelling companions.
 *
 * Membership used to end only on an explicit parting phrase, which free prose
 * rarely produces, so a companion enrolled once rode along for the rest of the
 * run regardless of the narration. Absence now decays it: on a scene break, a
 * companion the endpoint judge does not place with the player and the prose does
 * not show acting has missed that scene. Any single appearance resets the count,
 * so a quiet companion is never at risk.
 */
export const PARTY_DECAY_THRESHOLD = 2

export function decidePartyDecay(params: {
  seenThisScene: boolean
  priorMisses: number
}): { misses: number; drop: boolean } {
  const misses = params.seenThisScene ? 0 : params.priorMisses + 1
  return { misses, drop: misses >= PARTY_DECAY_THRESHOLD }
}
