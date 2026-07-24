/**
 * Deterministic movement + place-naming backstops for the location seam.
 *
 * The scene extractor (a small model "witness") is unreliable at two things the
 * location cursor depends on: asserting that the viewpoint MOVED, and NAMING a
 * personal space the player retreated to. When it whiffs, the cursor sticks on the
 * place left behind and presence carry-forward never resets — the "I go to my room
 * but I'm still in the dining room (with my parents)" class. Same lesson the
 * presence fold (F3) and the codex name-grounding backstop already learned: a
 * pure-prompt fix fails the small model, so the corroboration is server-side math.
 *
 * These are pure functions over the PLAYER'S input (the protagonist's own narrated
 * action — the most reliable movement signal we have) and the owner name. Their
 * EFFECT is always gated by an actual place change at the call site, so a broad
 * detector here cannot fabricate a move on a turn that stayed put.
 */

function clean(text: string): string {
  return String(text || '')
    .toLowerCase()
    .replace(/[*_~`]+/g, ' ') // strip emphasis/markdown so "*I go*" reads as "i go"
    .replace(/\s+/g, ' ')
    .trim()
}

/** A direction/target word that turns a locomotion verb into an actual relocation.
 *  "for"/"towards" cover "set off for the mountains" / "ride towards the keep". */
const DIRECTION = '(?:to|into|inside|outside|out|toward|towards|back|upstairs|downstairs|up|down|through|onto|across|over to|off to|in|for)'

/** Verbs of self-locomotion that need a direction/target to count as a move. Open-
 *  world scale: not just walking between rooms but travelling between settlements,
 *  realms, planets (travel/journey/ride/sail/fly/cross/venture/voyage/…). Naming
 *  the destination stays the witness's job — these only establish that a move
 *  HAPPENED so the cursor/presence/travel-marker stay honest when the model
 *  under-flags it. */
const DIRECTED_VERB =
  '(?:go|goes|going|gone|went|head|heads|heading|headed|return|returns|returning|returned|walk|walks|walking|walked|run|runs|running|ran|move|moves|moving|moved|step|steps|stepping|stepped|enter|enters|entering|entered|stride|strides|striding|strode|storm|storms|storming|stormed|march|marches|marching|marched|wander|wanders|wandering|wandered|slip|slips|slipping|slipped|climb|climbs|climbing|climbed|descend|descends|descending|descended|ascend|ascends|ascending|ascended|sneak|sneaks|sneaking|snuck|rush|rushes|rushing|rushed|creep|creeps|creeping|crept|hurry|hurries|hurrying|hurried|make my way|made my way|making my way|retire|retires|retiring|retired|travel|travels|travelling|traveling|travelled|traveled|journey|journeys|journeying|journeyed|ride|rides|riding|rode|ridden|sail|sails|sailing|sailed|fly|flies|flying|flew|flown|cross|crosses|crossing|crossed|venture|ventures|venturing|ventured|voyage|voyages|voyaging|voyaged|drive|drives|driving|drove|driven|trek|treks|trekking|trekked|hike|hikes|hiking|hiked|set off|set out|sets off|sets out|setting off|setting out|proceed|proceeds|proceeding|proceeded|advance|advances|advancing|advanced|teleport|teleports|teleporting|teleported|warp|warps|warping|warped|clamber|clambers|clambering|clambered)'

/** Verbs that mean "left the current place" with no direction needed. */
const DEPARTURE_VERB =
  '(?:exit|exits|exiting|exited|depart|departs|departing|departed|retreat|retreats|retreating|retreated|flee|flees|fleeing|fled|withdraw|withdraws|withdrawing|withdrew|disembark|disembarks|disembarking|disembarked)'

// verb (+ a short filler run) + direction → "go to my room", "head back inside", and
// — with the wider window — "head down the hall into my room" (a multi-word phrase can
// sit between the verb and the direction). Recall-favouring on purpose: a stray match on
// a stay-put turn is inert because the caller only acts when the resolved place changed.
const DIRECTED_MOVE = new RegExp(`\\b${DIRECTED_VERB}\\b(?:\\s+\\w+){0,4}?\\s+${DIRECTION}\\b`)
const DEPARTURE = new RegExp(`\\b${DEPARTURE_VERB}\\b`)
// "leave/left" only counts with a place-ish object or clause end (not "leave me alone")
const LEAVE_MOVE = /\b(?:leave|leaves|leaving|left)\b(?!\s+(?:me|him|her|them|us|it|you)\b)/
// sealing a door behind you is an unambiguous exit of a space
const DOOR_BEHIND = /\b(?:shut|shuts|shutting|close|closes|closing|closed|lock|locks|locking|locked|slam|slams|slamming|slammed)\b[^.!?]*\bdoor\b[^.!?]*\bbehind\b/

// Presence has a slightly different threshold from a location cursor: an
// explicit exit proves the people in the old room are no longer co-located even
// when the player has not yet named the destination. Keep this first-person and
// physical, so “leave the question” / “walk out of the conversation” do not
// clear a scene cast.
const EXPLICIT_SCENE_EXIT =
  /\b(?:i|we)\b[^.!?]{0,72}\b(?:leave|exit|walk\s+out|step\s+out|head\s+out|go\s+out)\b(?:\s+(?:of|from|the|this|my|our)\s+(?:[a-z]+\s+){0,3}(?:room|hall|house|home|apartment|mansion|manor|building|office|cafe|restaurant|bar|shop|store|garden|yard|street|station)\b|\s+into\s+(?:the\s+)?(?:night|rain|street|outside|open\s+air)\b)/i

// This is intentionally much narrower than `detectNarratedMovement`. The broad
// detector is useful for telemetry and for spotting likely missed moves, but it is
// not proof that the player changed location: "leave the decision", "return to the
// question", and "retreat into myself" are all valid non-spatial sentences.
// State-changing consumers must use this matcher instead.
const EXPLICIT_DESTINATION = new RegExp(
  '\\b(?:i|we)\\s+(?:(?:quietly|quickly|slowly|carefully|immediately)\\s+){0,2}' +
    '(?:go|head|walk|run|move|step|enter|stride|storm|march|wander|slip|climb|descend|ascend|sneak|rush|creep|hurry|retire|travel|journey|ride|sail|fly|cross|venture|voyage|drive|trek|hike|proceed|advance|teleport|warp|clamber|make my way|made my way|set off|set out|return)' +
    '(?:\\s+\\w+){0,3}?\\s+(?:to|into|inside|through|onto|in|back to)\\s+([^,.!?;]{2,60})',
)
const DESTINATION_STOP_WORDS = new Set([
  'the', 'a', 'an', 'my', 'our', 'own', 'of', 'at', 'on', 'in', 'to', 'back',
])
const ABSTRACT_DESTINATIONS = new Set([
  'decision', 'question', 'answer', 'subject', 'topic', 'matter', 'issue',
  'argument', 'conversation', 'discussion', 'memory', 'past', 'future',
  'myself', 'yourself', 'himself', 'herself', 'ourselves', 'themselves',
  'meeting', 'appointment', 'plan', 'idea', 'dream', 'thought', 'mind',
])

const PHYSICAL_DESTINATION_WORD =
  /\b(?:room|hall|kitchen|bedroom|study|library|attic|basement|apartment|house|home|mansion|manor|villa|cafe|coffee\s+shop|restaurant|bar|tavern|inn|shop|store|market|garden|courtyard|street|road|alley|station|airport|dock|harbo[u]?r|car|bus\s+stop|train\s+station)\b/i
// Kept separate from EXPLICIT_DESTINATION: this captures the exact physical
// destination a player writes in a normal action/choice, including "head for"
// and "aiming for". The caller treats it as a commitment only after the
// physical-place guard below passes.
const EXPLICIT_PHYSICAL_DESTINATION =
  /\b(?:go|head|walk|run|move|step|travel|journey|ride|drive|aim|aiming|turn|turning|set\s+off|make\s+my\s+way)\b(?:\s+\w+){0,6}?\s+(?:to|into|toward|towards|for)\s+([^,.!?;*]{2,80})/gi

function comparableTokens(value: string): string[] {
  return clean(value)
    .split(/\s+/)
    .map((token) => token.replace(/[^a-z0-9'-]/g, ''))
    .filter((token) => token.length >= 3 && !DESTINATION_STOP_WORDS.has(token))
}

/**
 * Exact physical destination deliberately written by the player. This is used
 * to keep a choice such as “Head for the cafe” from being narrated as a trip
 * somewhere else before metadata can observe the arrival. It rejects abstract
 * targets and keeps the final destination in a compound action (“turn toward
 * the bus stop, aiming for the cafe” → “the cafe”).
 */
export function extractExplicitPhysicalDestination(
  playerInput: string | null | undefined,
): string | null {
  const text = String(playerInput || '').replace(/[\*_`]+/g, ' ')
  let result: string | null = null
  for (let match = EXPLICIT_PHYSICAL_DESTINATION.exec(text); match; match = EXPLICIT_PHYSICAL_DESTINATION.exec(text)) {
    let candidate = match[1]
      .split(/\b(?:and|then|but|before|after|while)\b/i)[0]
      .trim()
    // Let a final appositive supply a concrete destination after an initially
    // vague target (“aiming for the one place that feels neutral, the cafe”).
    const suffix = text
      .slice(match.index + match[0].length)
      .match(/^\s*,\s*([^,.!?;*]{2,60})/)
    if (suffix?.[1]) candidate = `${candidate}, ${suffix[1].trim()}`
    if (!candidate || !PHYSICAL_DESTINATION_WORD.test(candidate)) continue
    // A final appositive often carries the actual destination after a vague
    // phrase (“the one place that feels neutral, the cafe”).
    const afterComma = candidate.split(',').map((part) => part.trim()).filter(Boolean).pop()
    result = afterComma || candidate
  }
  return result
}

/**
 * True when the player's narrated action describes the protagonist physically
 * relocating. Deliberately broad — the caller only acts on it when the resolved
 * place actually changed, so a false read on a stay-put turn is inert.
 */
export function detectNarratedMovement(playerInput: string | null | undefined): boolean {
  const t = clean(playerInput || '')
  if (!t) return false
  return DIRECTED_MOVE.test(t) || DEPARTURE.test(t) || LEAVE_MOVE.test(t) || DOOR_BEHIND.test(t)
}

/** A verified departure that resets scene presence without guessing a location. */
export function isExplicitSceneExit(playerInput: string | null | undefined): boolean {
  return EXPLICIT_SCENE_EXIT.test(clean(playerInput || ''))
}

// Personal/owned spaces only — a room or a dwelling the protagonist holds. NOT
// settlements ("my village"/"my city"/"my kingdom" denote origin/affiliation, not
// ownership — naming them "<owner>'s village" would be wrong; the witness names
// those from the prose, or the vague guard keeps the cursor).
const ROOM_NOUN_CANON: Record<string, string> = {
  room: 'room', bedroom: 'room', chamber: 'chambers', chambers: 'chambers',
  study: 'study', quarters: 'quarters', cabin: 'cabin', den: 'den', office: 'office',
  cell: 'cell', suite: 'suite', loft: 'loft', dorm: 'room',
  house: 'house', home: 'home', apartment: 'apartment', flat: 'flat',
  cottage: 'cottage', hut: 'hut', tent: 'tent',
  // more owned rooms (attic/basement/workshop/studio/garret) and dwellings
  // (penthouse/villa/bungalow/lodge) — still personal spaces, never settlements.
  attic: 'attic', basement: 'basement', workshop: 'workshop', studio: 'studio',
  garret: 'garret', penthouse: 'penthouse', villa: 'villa', bungalow: 'bungalow',
  lodge: 'lodge',
}

/**
 * When the player retreats to a space the prose marks as the protagonist's OWN
 * ("my room"), return a SPECIFIC owner-scoped name ("<owner>'s room") so the
 * cartographer mints a distinct place instead of a bare "the room" that collapses
 * onto whatever the cursor was. Returns null when there's no possessive-room cue
 * or no owner to attribute it to. First person only — "his/her" usually refers to
 * another character, which we must not mis-attribute to the protagonist.
 */
export function resolvePossessiveRoomName(
  playerInput: string | null | undefined,
  ownerName: string | null | undefined,
): string | null {
  if (!ownerName) return null
  const t = clean(playerInput || '')
  const m = t.match(/\b(my)(?:\s+own)?\s+(room|bedroom|chamber|chambers|study|quarters|cabin|den|office|cell|suite|loft|dorm|house|home|apartment|flat|cottage|hut|tent|attic|basement|workshop|studio|garret|penthouse|villa|bungalow|lodge)\b/)
  if (!m) return null
  // The room must be the DESTINATION, not the place being left. "I leave my room
  // and head to the dining room" governs "my room" with a departure verb — naming
  // the destination as the room would invert the move (the bug a live turn caught).
  // Guard is proximity-anchored: a departure cue must IMMEDIATELY precede the room,
  // so "I leave the hall and go to my room" (room is the real destination) is kept.
  const before = t.slice(0, m.index)
  if (
    /\b(leave|leaves|leaving|left|exit|exits|exiting|exited|escape|escapes|escaping|escaped|flee|flees|fleeing|fled|abandon|abandons|abandoning|abandoned|depart|departs|departing|departed)\s+$/.test(before) ||
    /\b(?:out of|away from|from)\s+$/.test(before)
  ) {
    return null
  }
  const noun = ROOM_NOUN_CANON[m[2]] || 'room'
  return `${ownerName.trim()}'s ${noun}`
}

/**
 * High-precision location-commit gate. It requires a first-person physical action
 * with an explicit destination that materially overlaps the extracted place. The
 * metadata witness may suggest the destination, but can never move the cursor on
 * its own. Ambiguous or figurative wording fails closed and leaves the cursor put.
 */
export function isExplicitPlayerLocationChange(
  playerInput: string | null | undefined,
  extractedLocation: string | null | undefined,
  ownerName: string | null | undefined,
): boolean {
  const input = clean(playerInput || '')
  const location = clean(extractedLocation || '')
  if (!input || !location) return false

  const personalSpace = resolvePossessiveRoomName(input, ownerName)
  if (personalSpace && clean(personalSpace) === location) return true

  const match = input.match(EXPLICIT_DESTINATION)
  if (!match) return false
  const target = match[1]
    .split(/\b(?:and|then|but|before|after|while)\b/)[0]
    .trim()
  const targetTokens = comparableTokens(target)
  if (!targetTokens.length || ABSTRACT_DESTINATIONS.has(targetTokens[0])) return false

  const locationTokens = new Set(comparableTokens(location))
  return targetTokens.some((token) => locationTokens.has(token))
}
