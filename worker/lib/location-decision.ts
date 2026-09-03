import {
  detectNarratedMovement,
  hasGroundedWitnessLocationEvidence,
  isSafeWitnessLocationCandidate,
  labelsAgreeOnPlace,
  locationNamesCompatible,
  sameLocationLabel,
} from './movement-signal'
import {
  evaluateLocationCitation,
  citationAdmitsLocation,
  passageSituatesViewpoint,
  playerTextSituatesViewpoint,
  type ViewpointOptions,
} from './location-citation'
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
  /**
   * Who the narration calls the player. Most saves narrate in the third
   * person, where every sentence about the player's own position reads as
   * somebody else's clause unless this is supplied.
   */
  viewpoint?: ViewpointOptions
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
    viewpoint: input.viewpoint,
  })
  const citedVerified = !!witness.current_location && citationAdmitsLocation(citation)
  const validLocationCited = isSafeWitnessLocationCandidate(witness.current_location, {
    ...options,
    proseCited: citedVerified,
  })

  // The witness's `containment_hint` is NOT a third namer, and it was checked:
  // it names the ENCLOSING place ("Vesperkeep" for the hall, "the keep" for the
  // root cellars), which is its job, and it also emits a character's name as a
  // container. Present on ~30% of turns and agreeing with the scene's own place
  // on 17%/27% across the two corpora. It belongs to the promotion path, where
  // a containment edge is evidence a name is a place at all, not here.
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
  //
  // The judge's evidence comes in two strengths, and conflating them is what
  // let a dinner-table promise about dawn move the map. A claim that VERIFIES
  // — its own citation passes the stack, or some sentence of the narration or
  // of the player's instruction situates the viewpoint there — stands on its
  // own. A claim that merely AGREES with the witness is a second namer, not a
  // second proof: it says where the scene is, never that the scene moved.
  const judgedVerified =
    !!input.endpoint?.location &&
    (citationAdmitsLocation(
      evaluateLocationCitation({
        place: judgedName,
        evidence: input.endpoint.location.evidence,
        source: input.narrative,
        people: input.knownPeople,
        viewpoint: input.viewpoint,
      }),
    ) ||
      passageSituatesViewpoint(judgedName, input.narrative, { people: input.knownPeople, viewpoint: input.viewpoint }) ||
      playerTextSituatesViewpoint(judgedName, input.playerInput, { people: input.knownPeople }))
  // Two INDEPENDENT namers landing on the same place. The witness extractor and
  // the endpoint judge are separate calls with separate prompts, and the judge
  // is deliberately never told the cursor or the known places, so it cannot be
  // agreeing by anchoring on the same prior. Demanding a third proof of a
  // sentence neither of them quoted well is how "I leave the window and go back
  // to the hearth" left the cursor at the north wall for seven turns — but
  // agreement alone also put the cursor in a war room the player had only
  // agreed to visit at dawn, so it may only complete a move something else
  // already says happened.
  // Agreement is checked on the NAMES THEMSELVES, not by the fuzzy compatibility
  // used to decide whether two labels are the same node. "terminal table" and
  // "terminal room" share a token and compare as compatible, which turned a
  // piece of furniture into a corroborated second namer and held a whole world
  // at it for five turns. Two models agreeing is only evidence when they said
  // the same thing.
  // Containment rather than identity — see `labelsAgreeOnPlace`. The
  // terminal-table finding that tightened this is preserved: overlap still is
  // not agreement, only one label wholly containing the other is.
  const judgedAgreed =
    !!judgedName && !!witness.current_location && labelsAgreeOnPlace(judgedName, witness.current_location)
  //
  // MEASURED, do not drop the transition requirement here. Letting strict
  // agreement admit on its own recovers one turn — a move into a war room whose
  // transition the judge missed — and loses five, because "I will meet you in
  // the war room at dawn" is also strict agreement with no transition, and the
  // map follows the player to an appointment they will keep at dawn. Held-out
  // 94.9% → 90.9%. One turn of lag is the right side of that trade.
  const judgedProven = judgedVerified || (judgedAgreed && transitionCorroborated)
  // A PROVED LABEL CARRYING A PROPER NOUN IS A PLACE.
  //
  // The judge's verified claims were being thrown away for the SHAPE of their
  // name: "Falkreath's borderlands" is the sentence the arrival is written in,
  // and the noun list refused it because "borderlands" is not in the list and
  // the proper-name test wants every word capitalised. The player then spent
  // eleven turns with the cursor in a council chamber three days' ride away.
  //
  // Handing the judge the witness's full `proseCited` exemption is too much:
  // measured, it admitted "the hearth" as a move out of the hall it stands in
  // and cost five turns on the keeper corpus. Furniture passes a room's
  // grammar, and a citation cannot tell them apart — placehood is not
  // structural, which this stack has now been told from six directions.
  //
  // A capitalised token is the narrow thing that separates them. It is
  // orthography, not a vocabulary of which nouns count as places, and it is the
  // same test the authored-opening path already ships. "Falkreath's
  // borderlands" and "the Whisper's Edge" carry one; "the hearth", "the room"
  // and "his own chambers" do not, and those keep answering to the noun list.
  const judgedNameHasProperNoun = (() => {
    const words = String(judgedName || '').trim().split(/\s+/).filter(Boolean)
    const head = /^(?:the|a|an)$/i.test(words[0] || '') ? words.slice(1) : words
    return head.some((word) => /^[\p{Lu}]/u.test(word))
  })()
  // TWO NAMERS AGREEING IS PLACEHOOD.
  //
  // The noun list is a muzzle for a single uncited guess. It may not veto a
  // place both independent readers named. Live: both said "the solar", the
  // list did not contain that word (it contains "table"), the name was
  // thrown away, and the council cast was carried into a private room.
  // Agreement does not by itself MOVE the cursor — `movedOrNamedByPlayer`
  // still has to fire — it only means the name is allowed to be a place.
  const judgedIsPlace =
    isSafeWitnessLocationCandidate(judgedName, options) ||
    judgedAgreed ||
    (judgedVerified &&
      judgedNameHasProperNoun &&
      isSafeWitnessLocationCandidate(judgedName, { ...options, proseCited: true }))
  const judgedLocation = judgedProven && judgedIsPlace ? judgedName : null

  const actionDestination =
    input.actionDestination && isSafeWitnessLocationCandidate(input.actionDestination, options)
      ? input.actionDestination
      : null
  // A DESTINATION IS NOT AN ARRIVAL.
  //
  // This path used to ask only that the cited sentence really occur in what the
  // player typed — check (a), which proves the sentence exists and nothing
  // about what it says. `player_travel_confirmed` is one boolean from one
  // model, and setting it bypassed the entire citation stack that every other
  // route through this function has to pass.
  //
  // Live, on turn 41 of a court campaign: "I gather my things and prepare to
  // leave for Falkreath." The witness read the cursor correctly — it reported
  // the player still in the palace — and set the destination flag anyway, and
  // the map put him in an enemy kingdom while he was standing in his father's
  // study packing a satchel. He arrived two turns later.
  //
  // The path already asserts the PLAYER'S OWN WORDS established this, so those
  // words are what it must be held to: the same viewpoint-locative test the
  // rest of the stack uses. "I continue toward the docks" passes it; "prepare
  // to leave for Falkreath" does not, and neither does any appointment.
  const destinationReached =
    !!witness.player_destination &&
    playerTextSituatesViewpoint(witness.player_destination, input.playerInput, { people: input.knownPeople })
  const witnessedDestination =
    !input.actionDestination &&
    !input.isContinuation &&
    witness.player_travel_confirmed &&
    witness.viewpoint_moved &&
    witness.location_evidence_source === 'player' &&
    validEvidence &&
    validDestination &&
    destinationReached
      ? witness.player_destination
      : null
  // The witness is instructed to HOLD the prior place unless the viewpoint
  // moved, and it obeys past the point of truth — on the corpus it reported
  // "the green room" for five consecutive turns spent on a loading dock. So its
  // claim may move the cursor only when this passage actually names the place
  // and puts the viewpoint there: its own citation must pass the whole stack,
  // or some sentence of the narration must. The old fallback here asked only
  // for a real excerpt plus a corroborated transition, which is (a) alone; on a
  // turn that did break scene it promoted the stale held name over a citation
  // that never mentioned it.
  //
  // The second chance is the same pair of independent witnesses the judge gets:
  // a sentence of the NARRATION that situates the viewpoint there, or the
  // PLAYER'S OWN instruction saying they went. "I walk down to the root cellars
  // alone" is the strongest locative claim in the turn, and the prose that
  // follows it describes the descent without ever naming the room.
  const witnessSecondNamer =
    !!witness.current_location &&
    (passageSituatesViewpoint(witness.current_location, input.narrative, { people: input.knownPeople, viewpoint: input.viewpoint }) ||
      playerTextSituatesViewpoint(witness.current_location, input.playerInput, { people: input.knownPeople }))
  //
  // A MOVE on a turn where nothing transitioned needs the player's own words.
  //
  // Both namers read one passage and name one place, and on a continuous scene
  // they name whichever part of it the sentence they picked was about — the
  // table, the court, the hearth, the city outside. Every one of those is a
  // faithful reading and none of them is a move, and the grammar of "in this
  // court, you will learn it" is indistinguishable from "in the hall, the air
  // is cold". No verifier separates them, which is the same wall placehood hits
  // from five other directions.
  //
  // What separates them is not the sentence but the turn: if nothing in the
  // narration or the player's instruction says the scene changed, then a new
  // name is a re-description of where they already are. The exception is the
  // player saying where they are in their own words — "I sit on the edge of the
  // dock", "I stop under the bridge" — which is the player operating the
  // product, and the two namers independently returning the SAME label, which
  // is a coincidence a re-description does not produce.
  // A DEPARTURE VERB IS NOT A DESTINATION.
  //
  // This used to accept `transitionCorroborated`, which folds in a scan of the
  // player's text for locomotion verbs. "*I nod and leave*" trips it, and the
  // only place named on that turn was the judge RE-DESCRIBING the room being
  // left ("the quiet room" for the study); the cursor moved into a synonym of
  // where it already was. "I can always head to Eryndor instead" trips it too,
  // and Eryndor is a place the player is threatening to visit.
  //
  // The verb scan says something happened; it never says WHERE, and it is an
  // open list of verbs deciding an outcome, which is the thing this stack is
  // not allowed to do. The judge's own transition verdict and the player's own
  // locative are both about the turn rather than about a vocabulary.
  const turnTransitioned = judgeTransition === true
  // Agreement names the place. It does not, by itself, mean the player moved.
  // Both namers can agree on furniture in the room they are already in ("the
  // hearth" while the cursor is "the hall"). That used to count as a move the
  // moment we stopped asking the noun list for permission. A still turn stays
  // put unless the player said they are at this place, or the judge called a
  // scene change, or the player actually walked and both namers named the
  // same NEW place.
  const movedOrNamedByPlayer = (place: string | null): boolean =>
    !!place &&
    (turnTransitioned ||
      playerTextSituatesViewpoint(place, input.playerInput, { people: input.knownPeople }) ||
      (!!witness.current_location &&
        !!judgedName &&
        sameLocationLabel(judgedName, witness.current_location) &&
        detectNarratedMovement(input.playerInput) &&
        !locationNamesCompatible(place, cursorName)))

  //
  // TRIED AND REVERTED: treating the witness ABANDONING its prior as evidence.
  // It is told to hold unless the viewpoint moved, so letting go looks like a
  // deliberate decision — and it recovers the runner's corridor, which the
  // judge lost to the district he was heading towards. But a witness reading a
  // poisoned graph abandons just as confidently: on a world whose locations
  // included "the war room where Father is already waiting", it moved a dinner
  // scene into the war room on turn six and held it there. Held-out 94.9% →
  // 89.9%, and it cost a keeper turn as well. The bias is real; it is not
  // separable from a hallucination.
  const narratedArrival =
    !input.isContinuation &&
    !actionDestination &&
    !witnessedDestination &&
    validLocationCited &&
    (citedVerified || (witnessSecondNamer && transitionCorroborated)) &&
    movedOrNamedByPlayer(witness.current_location) &&
    !locationNamesCompatible(witness.current_location, cursorName)
      ? witness.current_location
      : null
  const judgedArrival =
    !input.isContinuation &&
    !actionDestination &&
    !witnessedDestination &&
    !narratedArrival &&
    !!judgedLocation &&
    movedOrNamedByPlayer(judgedLocation) &&
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

  // The FIRST anchor stays permissive on purpose. It was tightened to the same
  // bar as every other path — a passing citation or a second namer — and that
  // left FOUR turns of a cold-start world with NO CURSOR AT ALL, which is worse
  // than a provisional one: an unset cursor tells the narrator nothing, and the
  // narrator then invents a setting that the next turn's extractors read back
  // as canon. A first anchor is the two-tier map's provisional tier — it names
  // the setting for this turn and mints nothing (`LocationAnchorDoc.entity_id`
  // is nullable for exactly this), so being wrong costs one turn.
  // The FIRST anchor stays permissive on purpose — tightening it to the same bar
  // as every other path left FOUR turns of a cold-start world with NO CURSOR AT
  // ALL, which is worse than a provisional one: an unset cursor tells the
  // narrator nothing and it invents a setting the next turn reads back as canon.
  // This is the two-tier map's provisional tier; being wrong costs one turn.
  //
  // But permissive is not the same as unordered, and it was ordered wrongly. The
  // witness won on a REAL EXCERPT alone — check (a), which proves only that the
  // sentence exists — while a fully verified judge claim sat behind it. On turn
  // two of a court drama the witness reported "the war room", citing "all eyes
  // remain on you"; the judge read the same passage, said the scene was at the
  // table, and quoted a sentence that names it and situates the viewpoint at it.
  // The map took the war room. A verified claim now goes first, from either
  // namer, and the unverified witness claim is only the last resort that keeps
  // the cursor from being unset.
  const firstAnchor = !cursorName
    ? (citedVerified && validLocationCited ? witness.current_location : null) ||
      judgedLocation ||
      (validLocationCited && witness.location_evidence_source === 'narrative' && validEvidence
        ? witness.current_location
        : null)
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
