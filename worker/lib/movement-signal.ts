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
