/**
 * The LOCATION DECISION as a whole — what actually moves the map.
 *
 * The citation stack is audited a layer down (`audit:location-evidence`); this
 * pins the arbitration on top of it, which is where the controlled corpus found
 * its errors. Every case below is a real turn from `corpus:location-ab`, with
 * the world it came from named, so a regression says which playthrough broke.
 */
import { decideLocation, type LocationDecisionInput } from '../worker/lib/location-decision'

let pass = 0
let fail = 0
function check(label: string, got: unknown, want: unknown) {
  if (JSON.stringify(got) === JSON.stringify(want)) pass++
  else {
    fail++
    console.log(`  FAIL ${label}\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`)
  }
}

const CAST = ['Tomas', 'Bram', 'Mara', 'Soren', 'Cedric', 'Isolde', 'Kaelen']

function decide(over: Partial<LocationDecisionInput> & { witness?: Partial<LocationDecisionInput['witness']> }) {
  const input: LocationDecisionInput = {
    isContinuation: false,
    playerInput: '',
    narrative: '',
    cursorName: 'the hall',
    knownPeople: CAST,
    knownPlaceNames: ['the hall', 'root cellars', 'north wall'],
    witness: {
      current_location: null,
      player_destination: null,
      player_travel_confirmed: false,
      viewpoint_moved: false,
      location_evidence: null,
      location_evidence_source: 'narrative',
      ...(over.witness || {}),
    },
    actionDestination: null,
    endpoint: null,
    priorDrift: null,
    sequence: 20,
    ...over,
    witness: {
      current_location: null,
      player_destination: null,
      player_travel_confirmed: false,
      viewpoint_moved: false,
      location_evidence: null,
      location_evidence_source: 'narrative',
      ...(over.witness || {}),
    },
  }
  return decideLocation(input)
}

const judge = (name: string, evidence: string, sceneTransition = false) => ({
  available: true,
  sceneTransition,
  location: { name, evidence },
})

// ── A continuous scene re-describes itself. It does not move. ────────────────
// Both namers read one passage and name whichever part of the room the sentence
// they picked was about: the table, the court, the hearth, the city outside.
// Each is a faithful reading and none of them is a move. On the held-out corpus
// this single class was 13 of 14 remaining errors.
console.log('a re-description of the same scene is not a move:')
{
  // Aurelius Valemont seq 2 — turn two, nobody has moved, the judge names the furniture.
  const d = decide({
    cursorName: 'the dining hall',
    playerInput: 'I suggest you watch your tone, my queen.',
    narrative: "Isolde's fingers tighten around her wine glass. The tension at the table thickens.",
    endpoint: judge('the table', 'The tension at the table thickens.'),
  })
  check('furniture named on a still turn does not move the cursor', d.viewpointMoved, false)
  check('...but it is still this turn\'s scene anchor', d.sceneAnchor, 'the table')
}
{
  // Aurelius Valemont seq 5 — an abstraction with a perfect locative.
  const d = decide({
    cursorName: 'the dining hall',
    playerInput: 'I will not be silenced, Isolde.',
    narrative: '"Silence is a virtue you have never possessed. But here, in this court, you will learn it."',
    endpoint: judge('the court', 'here, in this court, you will learn it'),
  })
  check('an institution named on a still turn does not move the cursor', d.viewpointMoved, false)
}
{
  // Neon Divide seq 23 — furniture whose name shares a token with the real room.
  const d = decide({
    cursorName: "the Whisper's Edge",
    playerInput: "don't worry you'll be fine.",
    narrative: 'He leans forward, elbows on the terminal table.',
    witness: { current_location: 'terminal room', location_evidence: 'at the terminal table' },
    endpoint: judge('terminal table', 'He leans forward, elbows on the terminal table.'),
  })
  check('a shared token is not two namers agreeing', d.viewpointMoved, false)
}

// ── …unless the player said where they are, or both namers said the same. ───
console.log('\nwhat still moves on a still turn:')
{
  // Reese After Soundcheck seq 16 — no transition flagged; the player sat down somewhere new.
  const d = decide({
    cursorName: 'the green room',
    playerInput: 'I sit on the edge of the dock and let my feet hang.',
    narrative: 'I stay leaning against the brick wall beside the open dock door, watching you.',
    endpoint: judge('the dock', 'I stay leaning against the brick wall beside the open dock door'),
  })
  check('the player saying where they sat moves the cursor', d.placeName, 'the dock')
  check('...and it counts as a move', d.viewpointMoved, true)
}
{
  // Vesperkeep Hall seq 49 — "I leave the window and go back to the hearth."
  const d = decide({
    cursorName: 'north wall',
    playerInput: 'I leave the window and go back to the hearth to sit with Tomas.',
    narrative: "Tomas doesn't move from his place by the cold stone, but his eyes follow Kael back across the hall.",
    witness: { current_location: 'the hall', location_evidence: 'When Kael settles beside him' },
    endpoint: judge('the hall', 'When Kael settles beside him, Tomas lets out a slow breath.'),
  })
  check('two namers agreeing on a corroborated move is enough', d.placeName, 'the hall')
}
{
  // The same agreement WITHOUT a move: an appointment for dawn. Aurelius seq 21.
  const d = decide({
    cursorName: 'the dining hall',
    playerInput: 'I will meet you in the war room at dawn.',
    narrative: '"Dawn then. We\'ll discuss Falkreath and the northern borders."',
    witness: { current_location: 'war room', location_evidence: "We'll discuss Falkreath and the northern borders." },
    endpoint: judge('war room', "We'll discuss Falkreath and the northern borders."),
  })
  check('agreement about a place nobody went to does not move the cursor', d.viewpointMoved, false)
}
{
  // Live Aurelius Valemont — both namers said solar, the noun list did not
  // contain that word (it contains "table"), and the council cast followed
  // through the door. Agreement is placehood. The player walked. The cursor moves.
  const d = decide({
    cursorName: 'the table',
    playerInput: '*I push open the heavy oak door and step inside.*',
    narrative:
      "The solar is dim and smells of old books and woodsmoke. King Aldric stands by a high window, his back to the door, silhouetted against the grey light. He doesn't turn.",
    witness: {
      current_location: 'solar',
      location_evidence: "He doesn't turn.",
      viewpoint_moved: false,
    },
    endpoint: judge('the solar', 'The solar is dim and smells of old books and woodsmoke.', false),
  })
  check('two namers agreeing on a new room the player entered moves the cursor', d.placeName, 'the solar')
  check('...and it counts as a move, even when both flags said stay', d.viewpointMoved, true)
  check('...the noun list does not get to reject it', d.judgedRejectedAsNotAPlace, null)
}
{
  // The hearth finding this must not undo: both namers can agree on furniture
  // in the room they are already in. That is not a move.
  const d = decide({
    cursorName: 'the hall',
    playerInput: 'I wait by the fire.',
    narrative: 'The hearth has gone cold and the benches are empty.',
    witness: { current_location: 'the hearth', location_evidence: 'The hearth has gone cold' },
    endpoint: judge('the hearth', 'The hearth has gone cold and the benches are empty.', false),
  })
  check('two namers agreeing on furniture in the same room does not move', d.viewpointMoved, false)
}

// ── The witness ANCHORS. Its held place needs a namer, not just an excerpt. ──
console.log('\nthe witness holding the prior place is not evidence of it:')
{
  // Reese After Soundcheck seq 19 — the witness held "the green room" for five
  // turns spent on a loading dock, and on the one turn that did break scene its
  // stale name was promoted over a citation that never mentions it.
  const d = decide({
    cursorName: 'the loading dock',
    playerInput: 'Do you want to walk down the alley?',
    narrative: "I glance toward the alley's mouth, where the streetlights bleed into the dark. I push up from the edge.",
    witness: {
      current_location: 'the green room',
      player_destination: 'the alley',
      viewpoint_moved: true,
      location_evidence: "I glance toward the alley's mouth",
    },
    endpoint: judge('the alley', 'I push up from the edge.', true),
  })
  check('a real excerpt that never names the place cannot move the cursor', d.placeName, null)
}
{
  // Vesperkeep Hall seq 33 — the player says where they went and the prose
  // describes the descent without ever naming the room.
  const d = decide({
    cursorName: 'the hall',
    playerInput: 'I walk down to the root cellars alone. Tomas does not come with me.',
    narrative: 'Kael turns his back on the hall, descending the worn steps into the damp dark beneath the kitchen.',
    witness: {
      current_location: 'root cellars',
      viewpoint_moved: true,
      location_evidence: 'descending the worn steps into the damp dark beneath the kitchen',
    },
    endpoint: judge('root cellars', 'the damp dark beneath the kitchen', true),
  })
  check("the player's own instruction is the witness's second namer", d.placeName, 'root cellars')
}

// ── A mentioned place is never an arrival. ──────────────────────────────────
console.log('\na place that is only spoken of:')
{
  // Vesperkeep Hall seq 59 — "I tell him about the ledgers in the cellars."
  const d = decide({
    cursorName: 'the hall',
    playerInput: 'I tell him about the ledgers in the cellars.',
    narrative: '"Bram\'s ledgers," he repeats. "You went down there to count the dark, Kael."',
    witness: { current_location: 'the hall', location_evidence: 'His gaze stays fixed on the north wall' },
    endpoint: judge('the cellars', 'You went down there to count the dark, Kael.'),
  })
  check('a locative modifying an object noun does not move the cursor', d.viewpointMoved, false)
}
{
  // The Unseen Child / Neon Divide class — a third party's whereabouts.
  const d = decide({
    cursorName: 'the hall',
    playerInput: 'I ask about the root cellars and the north wall. We do not go there.',
    narrative: "\"The root cellars are beneath the kitchen. Bram's down there now, with his ledgers.\"",
    witness: { current_location: 'the hall', location_evidence: "Bram's down there now, with his ledgers" },
    endpoint: judge('root cellars', "Bram's down there now, with his ledgers."),
  })
  check('somebody else being somewhere does not move the player', d.viewpointMoved, false)
}

// ── The product's own controls outrank every model. ─────────────────────────
console.log('\nthe typed travel control:')
{
  const d = decide({
    cursorName: 'the hall',
    actionDestination: 'root cellars',
    playerInput: '',
    narrative: 'The stair is colder than he remembers.',
    witness: { current_location: 'the hall', location_evidence: 'The stair is colder than he remembers' },
  })
  check('a typed destination moves the cursor with no citation at all', d.placeName, 'root cellars')
  check('...on the action path', d.path, 'action')
}

// ── The first anchor is permissive, but it is ORDERED. ──────────────────────
console.log('\nthe first anchor prefers a VERIFIED claim over a real excerpt:')
{
  // Aurelius Valemont seq 2 — turn two of a world with no cursor yet. The
  // witness reports a room from a poisoned graph and cites a sentence that
  // never names it; the judge reads the same passage and quotes one that does.
  const d = decide({
    cursorName: null,
    playerInput: '',
    narrative:
      "Isolde's fingers tighten around her wine glass. Cedric shifts uncomfortably in his chair. The tension at the table thickens as all eyes remain on you.",
    witness: { current_location: 'the war room', location_evidence: 'all eyes remain on you' },
    endpoint: judge('the table', 'The tension at the table thickens as all eyes remain on you'),
  })
  check('an unverified witness claim does not outrank a verified judge one', d.placeName, 'the table')
}
{
  // …but an unverified witness claim is still better than no cursor at all.
  const d = decide({
    cursorName: null,
    playerInput: '',
    narrative: 'The hearth has gone cold and the benches are empty.',
    witness: { current_location: 'the hall', location_evidence: 'The hearth has gone cold' },
    endpoint: null,
  })
  check('with nothing verified, the cursor is still set', d.placeName, 'the hall')
  check('...and it is an established scene, not a move', [d.viewpointMoved, d.sceneEstablished], [false, true])
}

// ─── Aurelius Valemont, live save 6a993adf — the four rules added 2026-09-03 ───
// Every case below is a real turn from that playthrough. Its numbers are in
// `corpus/gold-valemont.json`; the save scored 77.4% before these and 92.9%
// after, with the keeper (98.6%) and held-out (94.9%) corpora unchanged.
{
  // #41. The witness read the cursor CORRECTLY — it reported the player still
  // in the palace — and set the travel flag anyway, on a sentence that says the
  // player is packing. The map put him in an enemy kingdom for three days.
  const d = decide({
    cursorName: 'Royal Council Chamber',
    playerInput: '*I gather my things and prepare to leave for Falkreath.*',
    narrative: 'Aldric watches him gather the map case and the small travel satchel.',
    witness: {
      current_location: 'Royal Council Chamber',
      player_destination: 'Falkreath',
      player_travel_confirmed: true,
      viewpoint_moved: true,
      location_evidence: 'I gather my things and prepare to leave for Falkreath.',
      location_evidence_source: 'player',
    },
  })
  check('preparing to leave for a place is not arriving at it', [d.placeName, d.viewpointMoved], [null, false])
}
{
  // #72, the same path on the turn the player really does arrive.
  const d = decide({
    cursorName: 'the city',
    playerInput: '*I continue toward the docks, staying alert.*',
    narrative: 'The dockside air was thick with salt, rot, and the low murmur of a dozen deals.',
    witness: {
      current_location: 'docks',
      player_destination: 'docks',
      player_travel_confirmed: true,
      viewpoint_moved: true,
      location_evidence: 'I continue toward the docks, staying alert.',
      location_evidence_source: 'player',
    },
  })
  check('...but continuing toward them is', [d.placeName, d.viewpointMoved], ['docks', true])
}
{
  // #66. A line of dialogue GRANTING passage carries every structural mark of
  // a locative claim. The player was still in the gatehouse, and stayed there
  // for five more turns while the cursor sat in the city.
  const d = decide({
    cursorName: 'gatehouse',
    playerInput: '*I finally get cleared*',
    narrative: 'He nodded to the guard at the door. "You can proceed into the city."',
    witness: { current_location: 'gatehouse', location_evidence: 'You can proceed into the city.' },
    endpoint: judge('the city', 'You can proceed into the city.', true),
  })
  check('permission to go somewhere does not put the viewpoint there', d.viewpointMoved, false)
}
{
  // #43. Third-person narration: the player is "he", which the viewpoint test
  // classified as a competitor stealing the clause. Most saves narrate this way.
  const arrival = {
    cursorName: 'Royal Council Chamber',
    playerInput: '*I set out on my journey*',
    narrative: 'By the second evening, he crossed into Falkreath\u2019s borderlands.',
    witness: { current_location: 'Falkreath', location_evidence: 'he crossed into Falkreath\u2019s borderlands' },
    endpoint: judge('Falkreath\u2019s borderlands', 'By the second evening, he crossed into Falkreath\u2019s borderlands.', true),
  }
  check('a third-person arrival is refused without the viewpoint', decide(arrival).viewpointMoved, false)
  const d = decide({ ...arrival, viewpoint: { surfaces: ['Aurelius Valemont'], thirdPerson: true } })
  check('...and lands once the narration POV is known', [d.placeName, d.viewpointMoved], ['Falkreath\u2019s borderlands', true])
}
{
  // #34. Two independent namers, one more specific than the other. Identity
  // said they disagreed and the cursor stayed in the council chamber for nine
  // turns while the scene played out in the study.
  const d = decide({
    cursorName: 'Royal Council Chamber',
    playerInput: '*I nod to the guard and make my way to the king\u2019s study.*',
    narrative: 'Inside, the study is dim, lit by a single tallow candle on the desk.',
    witness: { current_location: "king\u2019s study", location_evidence: 'the door closes', location_evidence_source: 'player' },
    endpoint: judge("the king\u2019s private study", 'Inside, the study is dim, lit by a single tallow candle on the desk.', true),
  })
  check('a more specific label from the second namer is agreement', d.placeName, "the king\u2019s private study")
}
{
  // The terminal-table finding this must not undo: overlap is not containment.
  const d = decide({
    cursorName: 'the hall',
    narrative: 'He leans forward, elbows on the terminal table.',
    witness: { current_location: 'terminal room', location_evidence: 'elbows on the terminal table' },
    endpoint: judge('terminal table', 'He leans forward, elbows on the terminal table', true),
  })
  check('two labels merely sharing a word still disagree', d.viewpointMoved, false)
}
{
  // #40. "*I nod and leave*" trips the locomotion-verb scan, and the only place
  // named was the judge re-describing the room being left.
  const d = decide({
    cursorName: "the king\u2019s study",
    playerInput: '*I nod and leave*',
    narrative: 'The weight of their conversation still hanging in the quiet room.',
    witness: { current_location: 'Royal Council Chamber', location_evidence: 'the quiet room' },
    endpoint: judge('the quiet room', 'the weight of their conversation still hanging in the quiet room.', false),
  })
  check('a departure verb does not make a re-description a destination', d.viewpointMoved, false)
}
{
  // Live Aurelius: "*I reach the yard*" while the cursor is the hunting lodge.
  // Token overlap used to treat this as (or later merge it with) the steward's
  // yard. A bare "yard" is a facet of the current building, not a new map node.
  const d = decide({
    cursorName: 'hunting lodge',
    knownPlaceNames: ['hunting lodge', "keep's outer yard", "the steward's yard"],
    playerInput: '*I reach the yard*',
    narrative:
      'The yard was a pocket of deep shadow between the hunting lodge and the stable.',
    witness: {
      current_location: 'yard',
      location_evidence: 'The yard was a pocket of deep shadow between the hunting lodge and the stable',
      location_evidence_source: 'narrative',
    },
    endpoint: judge(
      'the yard',
      'The yard was a pocket of deep shadow between the hunting lodge and the stable',
      false,
    ),
  })
  check('bare yard next to the lodge does not move the cursor', d.viewpointMoved, false)
  check('bare yard is not minted as the destination', d.placeName, null)
}
{
  // Both namers said "the lodge" and the judge called a transition. Overlap
  // used to rename the hunting lodge; identity says they are already there.
  const d = decide({
    cursorName: 'hunting lodge',
    playerInput: '*I walk back inside*',
    narrative: "The hunting lodge's main room is as we left it.",
    witness: {
      current_location: 'the lodge',
      location_evidence: "The hunting lodge's main room is as we left it",
    },
    endpoint: judge('the lodge', "The hunting lodge's main room is as we left it", true),
  })
  check('shorthand "the lodge" does not mint a second lodge', d.placeName, null)
  check('...and does not move the cursor', d.viewpointMoved, false)
}
{
  const d = decide({
    cursorName: 'hunting lodge',
    knownPlaceNames: ['hunting lodge', 'the inn'],
    playerInput: '*We return to the inn*',
    narrative: 'The heavy oak door swung open, releasing a wall of warmth and the low murmur of voices.',
    actionDestination: 'the inn',
    witness: {
      current_location: 'the bar',
      player_travel_confirmed: true,
      viewpoint_moved: true,
      location_evidence: 'the heavy oak door swung open',
      location_evidence_source: 'narrative',
    },
    endpoint: judge('the tavern', 'the heavy oak door swung open, releasing a wall of warmth', true),
  })
  check('returning to the inn is not overridden by the lodge', [d.placeName, d.viewpointMoved], ['the inn', true])
}
{
  const d = decide({
    cursorName: 'hunting lodge',
    knownPlaceNames: ['hunting lodge', 'the inn'],
    playerInput: '*We return to the inn*',
    narrative: 'The heavy oak door swung open, releasing a wall of warmth and the low murmur of voices.',
    witness: {
      current_location: 'the inn',
      location_evidence: 'the heavy oak door swung open',
      location_evidence_source: 'narrative',
    },
    endpoint: judge('the inn', 'the heavy oak door swung open, releasing a wall of warmth', true),
  })
  check('free-text return to the inn still leaves the lodge', [d.placeName, d.viewpointMoved], ['the inn', true])
}
{
  // The live failure: namers HOLD the yard. The player named a known inn.
  const d = decide({
    cursorName: 'the muddy yard',
    knownPlaceNames: ['the muddy yard', 'Stumbling Boar', 'the inn'],
    playerInput: '*We return to the inn*',
    narrative: 'Mud sucked at his boots. A window across the lane still glowed.',
    mapResolvedDestination: 'Stumbling Boar',
    witness: {
      current_location: 'the muddy yard',
      location_evidence: 'Mud sucked at his boots',
      location_evidence_source: 'narrative',
    },
    endpoint: judge('the muddy yard', 'Mud sucked at his boots', false),
  })
  check('map-resolved return moves even when namers hold', [d.placeName, d.viewpointMoved, d.path], ['Stumbling Boar', true, 'map_resolved'])
}
{
  const d = decide({
    cursorName: 'Royal Council Chamber',
    knownPlaceNames: ['Royal Council Chamber', "Aurelius Valemont's room"],
    playerInput: '*I leave for my room*',
    narrative: 'The chamber doors close on the argument.',
    mapResolvedDestination: "Aurelius Valemont's room",
    witness: {
      current_location: 'Royal Council Chamber',
      location_evidence: 'The chamber doors close',
    },
    endpoint: judge('Royal Council Chamber', 'The chamber doors close', false),
  })
  check('owned-room leave moves off the council', [d.placeName, d.viewpointMoved], ["Aurelius Valemont's room", true])
}
{
  const d = decide({
    cursorName: 'Royal Council Chamber',
    knownPlaceNames: ['Royal Council Chamber', "The Player's room"],
    playerInput: '*I leave for my room in order to be prepared*',
    narrative: 'The chamber doors close on the argument.',
    mapResolvedDestination: "The Player's room",
    witness: {
      current_location: 'Royal Council Chamber',
      location_evidence: 'The chamber doors close',
    },
    endpoint: judge('Royal Council Chamber', 'The chamber doors close', false),
  })
  check('unnamed owned-room leave still moves off the council', [d.placeName, d.viewpointMoved], ["The Player's room", true])
}
{
  const d = decide({
    cursorName: "Aurelius's room",
    knownPlaceNames: ["Aurelius's room", 'Falkreath', 'Stumbling Boar'],
    playerInput: "Let's head to the tavern in Falkreath for now....we will discuss everything later",
    narrative: 'Roland names Falkreath as a week’s ride and refuses to abandon the pass.',
    holdCursor: true,
    endpoint: judge('Falkreath', 'Falkreath is a week’s ride from these passes', true),
  })
  check('intent hold blocks judged arrival at the named town', [d.viewpointMoved, d.path], [false, 'none'])
}
{
  const d = decide({
    cursorName: 'the Stumbling Boar',
    knownPlaceNames: ['the Stumbling Boar', 'the inn'],
    cursorAliases: ['the inn', 'the tavern', 'inn'],
    playerInput: '*We return to the inn*',
    narrative: 'Aurelius turned back inside, the heavy door thudding shut behind him.',
    endpoint: judge('the inn', 'the heavy door thudding shut behind him', true),
  })
  check('the inn is not a new place when it is the occupied cursor', [d.viewpointMoved, d.placeName], [false, null])
}

console.log(`\nlocation decision audit: ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
