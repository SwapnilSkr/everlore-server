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

/**
 * The location witness, not a regex, decides whether a scene has moved and
 * what the place is called.  These checks deliberately do not *extract* a
 * destination from player prose; they only reject a malformed model label
 * before it can become a durable graph entity.
 */
const LOCATION_CLAUSE_WORDS = new Set([
  'where', 'when', 'while', 'because', 'though', 'although', 'which', 'who',
  'that', 'then', 'but', 'and', 'if', 'after', 'before', 'once', 'until',
])
const LOCATION_ACTION_WORDS = new Set([
  'am', 'are', 'is', 'was', 'were', 'be', 'been', 'being', 'go', 'going',
  'gone', 'take', 'care', 'tell', 'tells', 'told', 'say', 'says', 'said',
  'ask', 'asks', 'asked', 'wait', 'waits', 'waiting', 'meet', 'meets',
  'met', 'come', 'comes', 'coming', 'leave', 'leaves', 'left', 'stay',
  'stays', 'staying', 'return', 'returns', 'returned',
])
const LOCATION_PRONOUNS = new Set([
  'i', 'me', 'my', 'mine', 'we', 'us', 'our', 'you', 'your', 'he', 'him',
  'his', 'she', 'her', 'they', 'them', 'their', 'it', 'its',
])
/**
 * Concrete place nouns that make a witness label safe to persist as a graph node.
 *
 * Two defects lived here and both produced the same symptom — a cursor that
 * silently refuses to move. (1) There was no plural tolerance, so `cellar`
 * matched "cellar" but not "root cellars". (2) The list was missing ordinary
 * place nouns: a player who climbed to the "north wall", dismounted at the
 * "stables" or went down to the "root cellars" was refused every time, and the
 * place was minted as a `concept` entity instead of a location.
 *
 * Kept as an explicit stem list (rather than "any noun") because this is a
 * SAFETY gate: it is the thing standing between the witness and a Places graph
 * full of "the quiet road" and "the last report's location". Stems are matched
 * with optional -s/-es so the plural of every entry is covered once.
 */
const PLACE_STEMS = [
  // interiors
  'room', 'hall', 'hallway', 'chamber', 'table', 'court', 'courtroom', 'council', 'kitchen',
  'bedroom', 'study', 'library', 'attic', 'basement', 'cellar', 'parlour', 'parlor', 'lounge',
  'foyer', 'corridor', 'passage', 'passageway', 'stair', 'staircase', 'landing', 'cloister',
  'apartment', 'flat', 'house', 'home', 'mansion', 'manor', 'villa', 'cottage', 'cabin', 'hut',
  'lodge', 'tavern', 'inn', 'bar', 'restaurant', 'cafe', 'office', 'shop', 'store', 'market',
  'stall', 'workshop', 'forge', 'smithy', 'mill', 'barn', 'stable', 'granary', 'larder',
  'pantry', 'vault', 'armoury', 'armory', 'barracks', 'dungeon', 'cell', 'crypt', 'tomb',
  'shrine', 'temple', 'chapel', 'cathedral', 'church', 'monastery', 'abbey', 'hospital',
  'clinic', 'ward', 'infirmary', 'school', 'academy', 'hangar', 'warehouse', 'laboratory',
  'lab', 'bunker', 'deck', 'cockpit', 'bridge', 'cabin',
  // exteriors + settlement
  'garden', 'courtyard', 'terrace', 'balcony', 'yard', 'street', 'road', 'lane', 'alley',
  'path', 'trail', 'track', 'square', 'plaza', 'green', 'common', 'bridge', 'well', 'fountain',
  'gate', 'gatehouse', 'wall', 'rampart', 'parapet', 'battlement', 'watchtower', 'tower',
  'keep', 'castle', 'fortress', 'citadel', 'palace', 'camp', 'encampment', 'outpost',
  'station', 'dock', 'pier', 'quay', 'harbor', 'harbour', 'port', 'ford', 'crossing',
  'village', 'hamlet', 'town', 'city', 'capital', 'kingdom', 'realm', 'province', 'district',
  'quarter', 'borough', 'ward',
  // vehicles that function as places
  'ship', 'boat', 'train', 'car', 'carriage', 'wagon', 'shuttle', 'vessel',
  // natural
  'forest', 'wood', 'grove', 'mountain', 'hill', 'ridge', 'peak', 'cliff', 'coast', 'shore',
  'beach', 'island', 'valley', 'glen', 'moor', 'marsh', 'swamp', 'desert', 'plain', 'field',
  'meadow', 'farm', 'orchard', 'river', 'stream', 'lake', 'pond', 'spring', 'cave', 'cavern',
  'grotto', 'canyon', 'gorge', 'pass', 'summit', 'clearing', 'quarry', 'mine', 'pit',
]
const PHYSICAL_LOCATION_WORD = new RegExp(`\\b(?:${PLACE_STEMS.join('|')})(?:s|es)?\\b`, 'i')

function locationComparable(value: string): string {
  return String(value || '')
    .replace(/[\*_`]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLocaleLowerCase()
}

/** A compact, noun-like location label is safe to persist as a graph node. */
export function isSafeWitnessLocationCandidate(
  raw: string | null | undefined,
  options: { knownPeople?: string[]; knownPlaces?: string[] } = {},
): boolean {
  const value = String(raw || '').replace(/\s+/g, ' ').trim()
  if (!value || value.length < 3 || value.length > 72) return false
  if (/[.!?;:"“”`*\n]/.test(value)) return false
  const words = value.toLocaleLowerCase().match(/[\p{L}\p{N}-]+/gu) || []
  if (!words.length || words.length > 8) return false
  if (words.some((word) => LOCATION_CLAUSE_WORDS.has(word) || LOCATION_ACTION_WORDS.has(word) || LOCATION_PRONOUNS.has(word))) {
    return false
  }
  const normalized = locationComparable(value)
  if (/^(?:here|there|inside|outside|the room|a room|this place|that place|somewhere)$/i.test(normalized)) return false

  // A trailing card name is a common witness failure: "the war room Cedric".
  // Never "clean" it heuristically—reject it so the witness has to return the
  // actual place label on the next turn instead of silently inventing one.
  const knownPeople = (options.knownPeople || []).map(locationComparable).filter(Boolean)
  if (knownPeople.some((person) => normalized === person || normalized.endsWith(` ${person}`))) return false

  const knownPlaces = new Set((options.knownPlaces || []).map(locationComparable).filter(Boolean))
  if (knownPlaces.has(normalized)) return true

  // Permit a concrete place noun ("war room", "royal table") or a compact
  // proper-name location ("Milan", "Ebonreach"). This is validation only;
  // it never scans narrative/player text to manufacture a destination.
  const looksLikeProperName = value.split(/\s+/).every((word) => /^[A-Z][\p{L}'’-]*$/u.test(word))
  return PHYSICAL_LOCATION_WORD.test(value) || looksLikeProperName
}

/** Verify that the witness supplied a real, quoted-free excerpt of its source. */
export function hasGroundedWitnessLocationEvidence(
  evidence: string | null | undefined,
  sourceText: string | null | undefined,
): boolean {
  const excerpt = locationComparable(String(evidence || ''))
  const source = locationComparable(String(sourceText || ''))
  return excerpt.length >= 3 && excerpt.length <= 220 && source.includes(excerpt)
}

/** A direction/target word that turns a locomotion verb into an actual relocation.
 *  "for"/"towards" cover "set off for the mountains" / "ride towards the keep". */
const DIRECTION = '(?:to|into|inside|outside|out|toward|towards|back|upstairs|downstairs|up|down|through|onto|across|over to|off to|in|for|north|south|east|west|northward|southward|eastward|westward|northwards|southwards|eastwards|westwards|inland|abroad|onward|onwards|homeward|homewards)'

/** Verbs of self-locomotion that need a direction/target to count as a move. Open-
 *  world scale: not just walking between rooms but travelling between settlements,
 *  realms, planets (travel/journey/ride/sail/fly/cross/venture/voyage/…). Naming
 *  the destination stays the witness's job — these only establish that a move
 *  HAPPENED so the cursor/presence/travel-marker stay honest when the model
 *  under-flags it. */
const DIRECTED_VERB =
  '(?:go|goes|going|gone|went|head|heads|heading|headed|return|returns|returning|returned|walk|walks|walking|walked|run|runs|running|ran|move|moves|moving|moved|step|steps|stepping|stepped|enter|enters|entering|entered|stride|strides|striding|strode|storm|storms|storming|stormed|march|marches|marching|marched|wander|wanders|wandering|wandered|slip|slips|slipping|slipped|climb|climbs|climbing|climbed|descend|descends|descending|descended|ascend|ascends|ascending|ascended|sneak|sneaks|sneaking|snuck|rush|rushes|rushing|rushed|creep|creeps|creeping|crept|hurry|hurries|hurrying|hurried|make my way|made my way|making my way|retire|retires|retiring|retired|travel|travels|travelling|traveling|travelled|traveled|journey|journeys|journeying|journeyed|ride|rides|riding|rode|ridden|sail|sails|sailing|sailed|fly|flies|flying|flew|flown|cross|crosses|crossing|crossed|venture|ventures|venturing|ventured|voyage|voyages|voyaging|voyaged|drive|drives|driving|drove|driven|trek|treks|trekking|trekked|hike|hikes|hiking|hiked|set off|set out|sets off|sets out|setting off|setting out|proceed|proceeds|proceeding|proceeded|advance|advances|advancing|advanced|teleport|teleports|teleporting|teleported|warp|warps|warping|warped|clamber|clambers|clambering|clambered|follow|follows|following|followed|accompany|accompanies|accompanying|accompanied|trail|trails|trailing|trailed)'

/** Verbs that mean "left the current place" with no direction needed. */
const DEPARTURE_VERB =
  '(?:exit|exits|exiting|exited|depart|departs|departing|departed|retreat|retreats|retreating|retreated|flee|flees|fleeing|fled|withdraw|withdraws|withdrawing|withdrew|disembark|disembarks|disembarking|disembarked)'

// verb (+ a short filler run) + direction → "go to my room", "head back inside", and
// — with the wider window — "head down the hall into my room" (a multi-word phrase can
// sit between the verb and the direction). Recall-favouring on purpose: a stray match on
// a stay-put turn is inert because the caller only acts when the resolved place changed.
const DIRECTED_MOVE = new RegExp(`\\b${DIRECTED_VERB}\\b(?:\\s+\\w+){0,4}?\\s+${DIRECTION}\\b`)
const DEPARTURE = new RegExp(`\\b${DEPARTURE_VERB}\\b`)
/** Arriving is a move even with no direction word: "we reach the gatehouse",
 *  "I arrive at the keep". The determiner is required so "I reach for my sword"
 *  and "I reach out to him" stay put, and an infinitive of purpose is excluded
 *  so "I stand on tiptoe TO REACH the shelf" is a stretch, not a journey. */
const ARRIVAL = /(?<!\bto\s)\b(?:reach|reaches|reached|reaching|arrive|arrives|arrived|arriving|approach|approaches|approached|approaching)\b\s+(?:at\s+|in\s+)?(?:the|a|an|my|our|his|her|their)\b/
/**
 * Arrival phrasings the determiner-gated ARRIVAL above cannot see.
 *
 * Each of these was a live stuck-cursor turn. "I arrive at Marrow Ford" names a
 * PROPER place, so there is no determiner to match (the text is lowercased by
 * then, so capitalization is gone too). "I dismount in the village square" and
 * "we make camp by the river" establish a place without any locomotion verb at
 * all. "I am led into the great hall" moves the player without them doing the
 * moving. In every case the witness correctly named the new place and the cursor
 * refused it, because the player-side corroboration this is paired with saw
 * nothing.
 *
 * Pronoun objects are excluded so "I arrive at her side" / "we approach him"
 * stay put — arriving at a PERSON is not arriving at a PLACE.
 */
const ARRIVAL_NAMED =
  /(?<!\bto\s)\b(?:reach|reaches|reached|reaching|arrive|arrives|arrived|arriving)\b\s+(?:at|in)\s+(?!(?:me|him|her|them|us|you|it|his|their)\b)[a-z][a-z'’-]{2,}/
const ALIGHT = /\b(?:dismount|dismounts|dismounted|dismounting|alight|alights|alighted|alighting|make camp|makes camp|made camp|making camp|set up camp|sets up camp)\b/
const ESCORTED = new RegExp(
  `\\b(?:am|are|is|was|were|get|gets|got)\\s+(?:led|taken|brought|escorted|guided|ushered|marched|shown|carried)\\b(?:\\s+\\w+){0,3}?\\s+${DIRECTION}\\b`,
)
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
  /\b(?:i|we)\b[^.!?]{0,72}\b(?:leave|exit|walk\s+out|step\s+out|head\s+out|go\s+out)\b(?:\s+(?:(?:of|from)\s+)?(?:[a-z]+(?:['’]s)?\s+){0,4}(?:room|hall|house|home|apartment|mansion|manor|townhouse|villa|estate|compound|building|office|cafe|restaurant|bar|club|shop|store|gallery|museum|warehouse|hotel|inn|theat(?:er|re)|library|market|courtyard|garden|yard|street|station|airport|hospital|school|campus|church|temple|car|train|ship)\b|\s+into\s+(?:the\s+)?(?:night|rain|street|outside|open\s+air)\b)/i

// A player commonly describes a scene transition in natural story prose rather
// than through the travel control: "I enter my room" or "I leave in disguise
// as I approach the kingdom." This is intentionally used only to reset the
// *scene cast* and to direct the narrator's viewpoint. It never creates or
// selects a durable location — that remains gated by the LLM witness + its
// quoted evidence below.
const OWNED_SPACE_ENTRY =
  /\b(?:i|we)\b[^.!?]{0,48}\b(?:go|head|walk|run|move|step|enter|stride|return|retire|slip)\b[^.!?]{0,24}\b(?:to\s+)?(?:my|our)\s+(?:room|bedroom|chambers?|study|quarters|cabin|den|office|cell|suite|loft|dorm|house|home|apartment|flat|cottage|hut|tent|attic|basement|workshop|studio|garret|penthouse|villa|bungalow|lodge)\b/i
const DEPARTURE_TO_PHYSICAL_DESTINATION =
  /\b(?:i|we)\b[^.!?]{0,64}\b(?:leave|depart|set\s+off|travel|journey|ride|walk|head|go)\b[^.!?]{0,64}\b(?:approach(?:ing)?|reach(?:ing)?|arrive(?:s|d|ing)?|enter(?:s|ed|ing)?)\b[^.!?]{0,48}\b(?:the\s+)?(?:room|hall|house|home|apartment|mansion|manor|townhouse|villa|estate|compound|building|office|cafe|restaurant|bar|club|shop|store|gallery|museum|warehouse|hotel|inn|library|market|courtyard|garden|yard|street|station|airport|campus|temple|car|train|ship|city|town|village|capital|kingdom|realm|forest|mountain|coast|island|district|quarter|borough)\b/i

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
  /\b(?:room|hall|kitchen|bedroom|study|library|attic|basement|apartment|house|home|mansion|manor|townhouse|villa|estate|compound|cafe|coffee\s+shop|restaurant|bar|tavern|inn|hotel|club|shop|store|market|gallery|museum|warehouse|theat(?:er|re)|garden|courtyard|street|road|avenue|boulevard|lane|alley|via|district|neighbou?rhood|quarter|borough|city|town|village|capital|country|kingdom|realm|forest|mountain|mountains|coast|island|station|airport|dock|harbo[u]?r|car|bus\s+stop|train\s+station)\b/i
// A player may explicitly travel to a city whose name is not in our generic
// place vocabulary ("I finally reach Milan"). A capitalized proper noun is a
// valid place candidate only after an explicit locomotion/arrival pattern has
// already matched; it never scans arbitrary prose for place-like words.
const NAMED_DESTINATION = /\b[A-Z][\p{L}'’-]{2,}\b/u
// Kept separate from EXPLICIT_DESTINATION: this captures the exact physical
// destination a player writes in a normal action/choice, including "head for"
// and "aiming for". The caller treats it as a commitment only after the
// physical-place guard below passes.
const EXPLICIT_PHYSICAL_DESTINATION =
  /\b(?:go|head|walk|run|move|step|travel|journey|ride|drive|aim|aiming|turn|turning|set\s+off|make\s+my\s+way)\b(?:\s+\w+){0,6}?\s+(?:to|into|toward|towards|for)\s+([^,.!?;*]{2,80})/gi
// Arrival verbs need no direction preposition: "After two days, I finally
// reach Milan" is just as explicit a move as "I travel to Milan". Keeping
// this separate avoids turning "reach for my coat" into a destination.
const EXPLICIT_ARRIVAL_DESTINATION =
  /\b(?:reach|reaches|reaching|reached|arrive|arrives|arriving|arrived)\b\s+(?:at|in)?\s*([^,.!?;*]{2,80})/gi
// Exact lodging verbs are a common natural way to establish a new scene without
// saying “go to”: “I take a hotel to stay at” and “I check into an inn.” Keep
// this intentionally venue-only; it is a high-confidence fallback when the AI
// witness is unavailable, not a broad semantic parser.
const EXPLICIT_LODGING_DESTINATION =
  /\b(?:i|we)\s+(?:take|book|check\s+into|check\s+in\s+at|get\s+(?:a\s+)?room\s+at)\s+(?:a\s+|an\s+|the\s+)?(hotel|inn|hostel|motel)\b/i

/** Remove the player action or direct address that follows an otherwise valid
 * destination. The graph stores places, never the reason for going there. */
function trimDestinationTail(raw: string): string {
  let candidate = raw
    .split(/\b(?:and|then|but|before|after|while)\b/i)[0]
    .trim()
  // "I go to my bedroom as I begin packing" → "my bedroom". Scope this to
  // a first-person clause so a legitimate place name containing "as" survives.
  candidate = candidate.replace(/\s+as\s+(?:i|we)\b.*$/i, '').trim()
  // "I head for the living room to say goodbye to Lisa" → "the living room".
  // These are purpose clauses, not part of the destination's identity.
  candidate = candidate
    .replace(/\s+to\s+(?=(?:say|tell|ask|speak|talk|meet|see|greet|comfort|hug|kiss|say\s+goodbye)\b).*$/i, '')
    .trim()
  // A relationship address after a place is conversational punctuation:
  // "I need to go to the airport, Dad" must not mint "airport dad".
  candidate = candidate.replace(/\s+(?:dad|mom|mother|father|mama|papa)\s*$/i, '').trim()
  return candidate
}

// A street address remains a physical destination even when the surrounding
// action is directed at a door rather than the street itself: “I walk up to the
// oak door at Via Brera, 14.”  This intentionally requires a street-style
// introducer, never a bare capitalized word, so it cannot turn a named person or
// abstract goal into a place.
// Keep this intentionally narrow. Generic verbs can use “square” ("square my
// shoulders") and common nouns such as road/lane can occur in ordinary prose;
// treating either as a street introducer made the whole action look like an
// address. The multilingual street forms below are distinctive enough to be a
// safe address signal on their own.
const ADDRESS_DESTINATION =
  /\b(?:via|viale|rue|calle)\s+[\p{L}][\p{L}' -]{1,50}(?:,\s*(?:number|no\.?|#)?\s*\d{1,5})?/iu

const GENERIC_LOCATION_TOKENS = new Set([
  'the', 'a', 'an', 'my', 'our', 'this', 'that', 'place', 'room', 'hall',
  'house', 'home', 'building', 'street', 'road', 'district', 'city', 'town',
  'village', 'garden', 'gallery', 'hotel', 'warehouse', 'office', 'shop', 'store',
])

// A player can deliberately choose an unnamed but still real venue: “I take a
// hotel to stay at”, “I check into an inn”, “I go to the airport”. These labels
// are too broad to compare arbitrary graph nodes, but they are concrete enough
// for an AI witness candidate when the player wrote the same word this turn.
const PLAYER_GROUNDED_GENERIC_DESTINATIONS = new Set([
  'hotel', 'inn', 'hostel', 'motel', 'airport', 'station', 'terminal',
  'restaurant', 'cafe', 'bar', 'tavern', 'hospital', 'clinic', 'store', 'shop',
  'market', 'gallery', 'museum', 'library', 'theater', 'theatre',
])

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
  const lodging = text.match(EXPLICIT_LODGING_DESTINATION)?.[1]
  if (lodging) return lodging
  // Prefer an explicit address over a more generic object of approach (“the
  // door at Via Brera, 14” → “Via Brera, 14”).  It is only accepted alongside
  // a genuine locomotion signal, so a remembered address does not move the map.
  const address = text.match(ADDRESS_DESTINATION)?.[0]?.trim() || null
  if (address && detectNarratedMovement(text)) return address
  let result: string | null = null
  for (const pattern of [EXPLICIT_PHYSICAL_DESTINATION, EXPLICIT_ARRIVAL_DESTINATION]) {
    pattern.lastIndex = 0
    for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
      let candidate = trimDestinationTail(match[1])
      // Let a final appositive supply a concrete destination after an initially
      // vague target (“aiming for the one place that feels neutral, the cafe”).
      const suffix = text
        .slice(match.index + match[0].length)
        .match(/^\s*,\s*([^,.!?;*]{2,60})/)
      if (suffix?.[1]) candidate = `${candidate}, ${suffix[1].trim()}`
      if (!candidate || (!PHYSICAL_DESTINATION_WORD.test(candidate) && !NAMED_DESTINATION.test(candidate))) continue
      // A final appositive often carries the actual destination after a vague
      // phrase (“the one place that feels neutral, the cafe”).
      const afterComma = candidate.split(',').map((part) => part.trim()).filter(Boolean).pop()
      result = afterComma || candidate
    }
  }
  return result
}

/**
 * Conservative semantic overlap for a player-written destination and the
 * witness's observed end location. It deliberately ignores generic place words:
 * “the room” must not validate “dining room”, while “Brera district” can validate
 * “Via Brera, 14”.
 */
export function locationNamesCompatible(a: string | null | undefined, b: string | null | undefined): boolean {
  const rawLeft = String(a || '').trim().toLowerCase()
  const rawRight = String(b || '').trim().toLowerCase()
  if (rawLeft && rawLeft === rawRight) return true
  const left = comparableTokens(String(a || '')).filter((token) => !GENERIC_LOCATION_TOKENS.has(token))
  const right = new Set(comparableTokens(String(b || '')).filter((token) => !GENERIC_LOCATION_TOKENS.has(token)))
  return left.length > 0 && left.some((token) => right.has(token))
}

/**
 * Minimal server-side validation for the AI movement witness. Meaning comes from
 * the witness; this only proves its proposed place was actually named by the
 * player, so an LLM cannot relocate the map to an invented destination.
 */
export function isGroundedPlayerDestination(
  playerInput: string | null | undefined,
  destination: string | null | undefined,
): boolean {
  const dest = String(destination || '').replace(/\s+/g, ' ').trim()
  if (!dest || /^(?:here|there|this place|that place|the room|outside|inside)$/i.test(dest)) return false
  const input = clean(playerInput || '')
  const allTokens = comparableTokens(dest)
  const distinctiveTokens = allTokens.filter((token) => !GENERIC_LOCATION_TOKENS.has(token))
  const tokens = distinctiveTokens.length > 0
    ? distinctiveTokens
    : allTokens.filter((token) => PLAYER_GROUNDED_GENERIC_DESTINATIONS.has(token))
  if (!tokens.length) return false
  return tokens.every((token) => new RegExp(`\\b${token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(input))
}

/**
 * A witness may refine an explicitly chosen destination to the more precise
 * place the narration actually reaches, but it can never redirect the player.
 * The witness value is used only when it shares a distinctive location token.
 */
export function refinePhysicalDestination(
  explicitDestination: string | null | undefined,
  witnessLocation: string | null | undefined,
): string | null {
  const explicit = String(explicitDestination || '').replace(/\s+/g, ' ').trim()
  const witness = String(witnessLocation || '').replace(/\s+/g, ' ').trim()
  if (!explicit) return null
  if (!witness || !locationNamesCompatible(explicit, witness)) return explicit
  const explicitTokens = comparableTokens(explicit).filter((token) => !GENERIC_LOCATION_TOKENS.has(token))
  const witnessTokens = comparableTokens(witness).filter((token) => !GENERIC_LOCATION_TOKENS.has(token))
  // Only replace the player target when the observation is strictly more
  // specific (e.g. Brera district → Via Brera, 14), never merely different.
  return witnessTokens.length > explicitTokens.length || /\d/.test(witness) ? witness : explicit
}

/**
 * A containment claim is safe only when the witness also corroborates the
 * player-selected destination and the claimed parent is already a known place
 * (usually the current anchor). This lets AI supply semantics without granting
 * it authority to mint a speculative hierarchy.
 */
export function validatedContainmentHint(params: {
  destination: string | null | undefined
  witnessLocation: string | null | undefined
  witnessContainment: string | null | undefined
  currentLocationName?: string | null
  knownLocationNames?: string[]
}): string | null {
  const destination = String(params.destination || '').trim()
  const witnessLocation = String(params.witnessLocation || '').trim()
  const hint = String(params.witnessContainment || '').trim()
  if (!destination || !witnessLocation || !hint) return null
  if (!locationNamesCompatible(destination, witnessLocation)) return null
  if (locationNamesCompatible(destination, hint)) return null
  const known = [params.currentLocationName || '', ...(params.knownLocationNames || [])]
  return known.some((name) => locationNamesCompatible(hint, name) || clean(hint) === clean(name)) ? hint : null
}

/**
 * True when the player's narrated action describes the protagonist physically
 * relocating. Deliberately broad — the caller only acts on it when the resolved
 * place actually changed, so a false read on a stay-put turn is inert.
 */
export function detectNarratedMovement(playerInput: string | null | undefined): boolean {
  const t = clean(playerInput || '')
  if (!t) return false
  return (
    DIRECTED_MOVE.test(t) ||
    DEPARTURE.test(t) ||
    LEAVE_MOVE.test(t) ||
    DOOR_BEHIND.test(t) ||
    ARRIVAL.test(t) ||
    ARRIVAL_NAMED.test(t) ||
    ALIGHT.test(t) ||
    ESCORTED.test(t)
  )
}

/** A verified departure that resets scene presence without guessing a location. */
export function isExplicitSceneExit(playerInput: string | null | undefined): boolean {
  return EXPLICIT_SCENE_EXIT.test(clean(playerInput || ''))
}

/**
 * A high-confidence player-authored scene transition. Unlike the map cursor,
 * presence can safely fail closed: carrying prior locals into a place the
 * player has just entered is worse than allowing a newly introduced local to
 * be discovered on the following turn.
 */
export function isExplicitPlayerSceneTransition(playerInput: string | null | undefined): boolean {
  const text = clean(playerInput || '')
  if (!text) return false
  return (
    isExplicitSceneExit(text) ||
    OWNED_SPACE_ENTRY.test(text) ||
    DEPARTURE_TO_PHYSICAL_DESTINATION.test(text) ||
    extractExplicitPhysicalDestination(text) != null
  )
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
