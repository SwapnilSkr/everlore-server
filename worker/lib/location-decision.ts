import {
  detectNarratedMovement,
  hasGroundedWitnessLocationEvidence,
  isSafeWitnessLocationCandidate,
  locationNamesCompatible,
} from './movement-signal'
import { evaluateLocationCitation, citationAdmitsLocation, passageSituatesViewpoint } from './location-citation'
import { decideCursorDrift, type DriftDecision, type DriftState } from './cursor-drift'

/**
 * The location decision, as a pure function of this turn's evidence.
 *
 * It lived inline in a 3000-line processor, which meant the only way to ask
 * "did that change help?" was to play turns and squint. Both variants live here
 * so `corpus:location-ab` can replay them over identical extractor output and
 * attribute the difference to the decision logic rather than to model noise.
 */

export interface WitnessLocationClaim {
  current_location: string | null
  player_destination: string | null
  player_travel_confirmed: boolean
  viewpoint_moved: boolean
  location_evidence: string | null
  location_evidence_source: string | null
}

export interface LocationDecisionInput {
  isContinuation: boolean
  playerInput: string
  narrative: string
  cursorName: string | null
  knownPeople: string[]
  knownPlaceNames: string[]
  witness: WitnessLocationClaim
  /** A typed travel command's destination — an explicit product action. */
  actionDestination: string | null
  endpoint: {
    available: boolean
    sceneTransition: boolean
    location: { name: string; evidence: string } | null
  } | null
  priorDrift: DriftState | null
  sequence: number
}

export type LocationPath =
  | 'action'
  | 'witnessed_destination'
  | 'narrated_arrival'
  | 'judged_arrival'
  | 'drift_repair'
  | 'first_anchor'
  | 'none'

export interface LocationDecision {
  placeName: string | null
  viewpointMoved: boolean
  sceneEstablished: boolean
  sceneAnchor: string | null
  drift: DriftDecision
  path: LocationPath
  citation: { a: boolean; b: boolean; c: boolean } | null
  judgedLocation: string | null
  judgedRejectedAsNotAPlace: string | null
  transitionCorroborated: boolean
}

const NO_DRIFT: DriftDecision = { next: null, repair: null, count: 0 }

/**
 * The stack as it stood before the citation work: (a)-only evidence, a
 * narrative-sourced excerpt, and a locomotion-verb scan of the player's text as
 * the sole corroborator. No second namer, no placehood bypass, no repair path.
 */
export function decideLocationLegacy(input: LocationDecisionInput): LocationDecision {
  const { witness, cursorName } = input
  const options = { knownPeople: input.knownPeople, knownPlaces: [...input.knownPlaceNames, cursorName || ''] }
  const evidenceSource =
    witness.location_evidence_source === 'player'
      ? input.playerInput
      : witness.location_evidence_source === 'narrative'
        ? input.narrative
        : ''
  const validEvidence =
    (witness.location_evidence_source === 'player' || witness.location_evidence_source === 'narrative') &&
    hasGroundedWitnessLocationEvidence(witness.location_evidence, evidenceSource)
  const validLocation = isSafeWitnessLocationCandidate(witness.current_location, options)
  const validDestination = isSafeWitnessLocationCandidate(witness.player_destination, options)

  const actionDestination =
    input.actionDestination && isSafeWitnessLocationCandidate(input.actionDestination, options)
      ? input.actionDestination
      : null
  const witnessedDestination =
    !input.actionDestination &&
    !input.isContinuation &&
    witness.player_travel_confirmed &&
    witness.viewpoint_moved &&
    witness.location_evidence_source === 'player' &&
    validEvidence &&
    validDestination
      ? witness.player_destination
      : null
  const narratedArrival =
    !input.isContinuation &&
    !actionDestination &&
    !witnessedDestination &&
    witness.location_evidence_source === 'narrative' &&
    validEvidence &&
    validLocation &&
    detectNarratedMovement(input.playerInput) &&
    !locationNamesCompatible(witness.current_location, cursorName)
      ? witness.current_location
      : null

  const firstAnchor =
    !cursorName && witness.location_evidence_source === 'narrative' && validEvidence && validLocation
      ? witness.current_location
      : null
  const placeName = actionDestination || witnessedDestination || narratedArrival || firstAnchor
  const viewpointMoved = !!actionDestination || !!witnessedDestination || !!narratedArrival
  return {
    placeName: placeName || null,
    viewpointMoved,
    sceneEstablished: !cursorName && !viewpointMoved && !!placeName && validEvidence,
    sceneAnchor: null,
    drift: NO_DRIFT,
    path: actionDestination
      ? 'action'
      : witnessedDestination
        ? 'witnessed_destination'
        : narratedArrival
          ? 'narrated_arrival'
          : firstAnchor
            ? 'first_anchor'
            : 'none',
    citation: null,
    judgedLocation: null,
    judgedRejectedAsNotAPlace: null,
    transitionCorroborated: detectNarratedMovement(input.playerInput),
  }
}

/** The current stack: citation stack, second namer, placehood gate, drift repair. */
export function decideLocation(input: LocationDecisionInput): LocationDecision {
  const { witness, cursorName } = input
  const options = { knownPeople: input.knownPeople, knownPlaces: [...input.knownPlaceNames, cursorName || ''] }
  const evidenceSource =
    witness.location_evidence_source === 'player'
      ? input.playerInput
      : witness.location_evidence_source === 'narrative'
        ? input.narrative
        : ''
  const validEvidence =
    (witness.location_evidence_source === 'player' || witness.location_evidence_source === 'narrative') &&
    hasGroundedWitnessLocationEvidence(witness.location_evidence, evidenceSource)
  const validDestination = isSafeWitnessLocationCandidate(witness.player_destination, options)

  const citation = evaluateLocationCitation({
    place: witness.current_location || '',
    evidence: witness.location_evidence || '',
    source: evidenceSource,
    people: input.knownPeople,
  })
  const citedVerified = !!witness.current_location && citationAdmitsLocation(citation)
  const validLocationCited = isSafeWitnessLocationCandidate(witness.current_location, {
    ...options,
    proseCited: citedVerified,
  })

  const judgeTransition = input.endpoint?.available ? input.endpoint.sceneTransition : null
  const transitionCorroborated = judgeTransition === true || detectNarratedMovement(input.playerInput)

  const judgedName = input.endpoint?.location?.name || ''
  // The judge names the place; then EITHER source may corroborate it.
  //
  // Second-person and sentient narration rarely produces an explicit "you are at
  // X". The City narrates atmospherically — "She's still at the bridge", "The
  // rain's lighter here" — where the narrating entity is the city itself, so the
  // one locative sentence in the passage is owned by a third person and the
  // player's position is only implied. The judge read that correctly and named
  // the bridge; the verifier refused it for want of a viewpoint clause, and the
  // cursor sat in the bar the player had walked out of.
  //
  // The player's own text is the strongest viewpoint-locative there is: "I stop
  // under the bridge" is first person, locative and unambiguous. It is not
  // trusted alone — the judge must have named the place first, from the finished
  // prose — so this is the same two-independent-witnesses discipline as the rest
  // of the stack, with the second witness allowed to be the player.
  const judgedProven =
    !!input.endpoint?.location &&
    (citationAdmitsLocation(
      evaluateLocationCitation({
        place: judgedName,
        evidence: input.endpoint.location.evidence,
        source: input.narrative,
        people: input.knownPeople,
      }),
    ) ||
      passageSituatesViewpoint(judgedName, input.narrative, { people: input.knownPeople }) ||
      passageSituatesViewpoint(judgedName, input.playerInput, { people: input.knownPeople }))
  const judgedIsPlace = isSafeWitnessLocationCandidate(judgedName, options)
  const judgedLocation = judgedProven && judgedIsPlace ? judgedName : null

  const actionDestination =
    input.actionDestination && isSafeWitnessLocationCandidate(input.actionDestination, options)
      ? input.actionDestination
      : null
  const witnessedDestination =
    !input.actionDestination &&
    !input.isContinuation &&
    witness.player_travel_confirmed &&
    witness.viewpoint_moved &&
    witness.location_evidence_source === 'player' &&
    validEvidence &&
    validDestination
      ? witness.player_destination
      : null
  const narratedArrival =
    !input.isContinuation &&
    !actionDestination &&
    !witnessedDestination &&
    validLocationCited &&
    (citedVerified ||
      (witness.location_evidence_source === 'narrative' && validEvidence && transitionCorroborated)) &&
    !locationNamesCompatible(witness.current_location, cursorName)
      ? witness.current_location
      : null
  const judgedArrival =
    !input.isContinuation &&
    !actionDestination &&
    !witnessedDestination &&
    !narratedArrival &&
    !!judgedLocation &&
    !locationNamesCompatible(judgedLocation, cursorName)
      ? judgedLocation
      : null

  const sceneAnchor: string | null =
    judgedLocation || (citedVerified && validLocationCited ? witness.current_location || null : null)
  const drift = decideCursorDrift({
    sceneAnchor,
    cursorName,
    prior: input.priorDrift,
    sequence: input.sequence,
    compatible: locationNamesCompatible,
  })

  const firstAnchor = !cursorName
    ? validLocationCited && ((witness.location_evidence_source === 'narrative' && validEvidence) || citedVerified)
      ? witness.current_location
      : judgedLocation
    : null
  const placeName =
    actionDestination || witnessedDestination || narratedArrival || judgedArrival || drift.repair || firstAnchor
  const viewpointMoved =
    !!actionDestination || !!witnessedDestination || !!narratedArrival || !!judgedArrival || !!drift.repair
  return {
    placeName: placeName || null,
    viewpointMoved,
    sceneEstablished:
      !cursorName &&
      !viewpointMoved &&
      !!placeName &&
      ((witness.location_evidence_source === 'narrative' && validEvidence) || citedVerified || !!judgedLocation),
    sceneAnchor,
    drift,
    path: actionDestination
      ? 'action'
      : witnessedDestination
        ? 'witnessed_destination'
        : narratedArrival
          ? 'narrated_arrival'
          : judgedArrival
            ? 'judged_arrival'
            : drift.repair
              ? 'drift_repair'
              : firstAnchor
                ? 'first_anchor'
                : 'none',
    citation: { a: citation.a, b: citation.b, c: citation.c },
    judgedLocation,
    judgedRejectedAsNotAPlace: judgedProven && !judgedIsPlace ? judgedName : null,
    transitionCorroborated,
  }
}
