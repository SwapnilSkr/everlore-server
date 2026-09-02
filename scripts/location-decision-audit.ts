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

console.log(`\nlocation decision audit: ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
