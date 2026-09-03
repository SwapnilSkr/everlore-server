/**
 * Place promotion — can furniture ever become a map node?
 *
 * Every case is drawn from live turns. The bench, the hearth and the terminal
 * are the labels that actually reached the cursor; the hall, the cellars and the
 * canal are the places the old vocabulary gate got wrong in the other direction.
 */
import { classifyPlaceRelation, decidePlacePromotion, type PlaceAccrual } from '../worker/lib/place-promotion'
import { locationCandidateKey } from '../worker/lib/movement-signal'

let pass = 0
let fail = 0
function check(label: string, got: unknown, want: unknown) {
  if (JSON.stringify(got) === JSON.stringify(want)) pass++
  else {
    fail++
    console.log(`  FAIL ${label}\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`)
  }
}
const CAST = ['Bram', 'Tomas', 'Soren', 'Kael']
const rel = (place: string, prose: string) => classifyPlaceRelation(place, prose, { people: CAST })

console.log('relation — entering and leaving, viewpoint-owned:')
check('walking into a place is an entry', rel('the hall', 'I walk back into the hall.'), { entry: true, exit: false })
check('climbing down to a place is an entry', rel('root cellars', 'I take a lamp and go down to the root cellars.'), { entry: true, exit: false })
check('walking out of a place is an exit', rel('the hall', 'I walk out of the hall and into the rain.'), { entry: false, exit: true })
check('sitting ON something is neither', rel('the old bench', 'I sit on the old bench and say nothing.'), { entry: false, exit: false })
check('standing AT something is neither', rel('the north wall', 'I stand at the north wall, looking out.'), { entry: false, exit: false })
check('a place merely named is neither', rel('the canal', "The canal's empty this time of night."), { entry: false, exit: false })
check(
  "somebody else's movement does not accrue",
  rel('the cellars', 'Bram went down to the cellars an hour ago.'),
  { entry: false, exit: false },
)
check('second person counts as the viewpoint', rel('the bridge', 'You step out onto the bridge.'), { entry: true, exit: false })

console.log('promotion — furniture must never become a map node:')
const promote = (
  candidate: string,
  relation: { entry: boolean; exit: boolean },
  prior: PlaceAccrual | null,
  seq = 10,
  extra: { containment?: boolean; authored?: boolean; arrived?: boolean; departed?: boolean } = {},
) =>
  decidePlacePromotion({
    candidate,
    sequence: seq,
    relation,
    containment: extra.containment === true,
    authored: extra.authored === true,
    arrived: extra.arrived === true,
    departed: extra.departed === true,
    prior,
  })

check('a first sighting never promotes', promote('the old bench', { entry: false, exit: false }, null).promote, false)
check('...it is provisional', promote('the old bench', { entry: false, exit: false }, null).reason, 'provisional')

// THE BENCH. Named as the cursor on two consecutive turns, sat on, never entered.
const bench1 = promote('the old bench', { entry: false, exit: false }, null, 63).next
const bench2 = promote('the old bench', { entry: false, exit: false }, bench1, 64).next
const bench3 = promote('the old bench', { entry: false, exit: false }, bench2, 65)
check('furniture sighted three times still does not promote', bench3.promote, false)
check('...because it was never entered', bench3.next.entries, 0)

// THE HALL. Walked into, later walked out of.
const hall1 = promote('the hall', { entry: true, exit: false }, null, 44)
check('entering once is not yet a place', hall1.promote, false)
const hall2 = promote('the hall', { entry: false, exit: true }, hall1.next, 45)
check('entered AND left promotes', hall2.promote, true)
check('...for that reason', hall2.reason, 'entered_and_left')

// Returned to repeatedly without ever being seen left.
const a = promote('root cellars', { entry: true, exit: false }, null, 30).next
const b = promote('root cellars', { entry: false, exit: false }, a, 31).next
const c = promote('root cellars', { entry: false, exit: false }, b, 32)
check('three sightings with an arrival promotes', c.promote, true)
check('...for that reason', c.reason, 'recurrent_arrival')

check('a validated containment edge promotes at once', promote('the manor', { entry: false, exit: false }, null, 5, { containment: true }).promote, true)
check('an authored place needs no accrual', promote('Marrow Ford', { entry: false, exit: false }, null, 2, { authored: true }).promote, true)
check('the same turn twice does not double-count', promote('the hall', { entry: true, exit: false }, promote('the hall', { entry: true, exit: false }, null, 44).next, 44).next.sightings, 1)

// ─────────────────────────────────────────────────────────────────────────────
// A CURSOR MOVE is an arrival. Without this a new world could never mint a
// single place: `classifyPlaceRelation` recorded ZERO entries across sixteen
// live turns and two walks between rooms, so nothing accrued, nothing promoted,
// nothing was minted — and `authored`, which asks whether a place is already on
// the map, could never become true either. A closed loop.
// ─────────────────────────────────────────────────────────────────────────────
console.log('\na cursor move is the arrival the preposition scan misses:')
{
  const none = { entry: false, exit: false }
  check(
    'prose that names no place still accrues the entry the cursor proved',
    promote('Counting House', none, null, 2, { arrived: true }).next.entries,
    1,
  )
  check('a first arrival alone does not promote', promote('Counting House', none, null, 2, { arrived: true }).promote, false)
  const entered: PlaceAccrual = {
    name: 'Counting House', sightings: 1, entries: 1, exits: 0,
    containment: false, first_sequence: 2, last_sequence: 2,
  }
  const left = promote('Counting House', none, entered, 8, { departed: true })
  check('leaving it completes entered-and-left', [left.promote, left.reason], [true, 'entered_and_left'])
  const seen2: PlaceAccrual = {
    name: 'Long Pier', sightings: 2, entries: 1, exits: 0,
    containment: false, first_sequence: 8, last_sequence: 9,
  }
  const third = promote('Long Pier', none, seen2, 12, {})
  check('a third sighting after an arrival promotes', [third.promote, third.reason], [true, 'recurrent_arrival'])
  const bench: PlaceAccrual = {
    name: 'the old bench', sightings: 6, entries: 0, exits: 0,
    containment: false, first_sequence: 3, last_sequence: 12,
  }
  check('furniture named six times still never promotes', promote('the old bench', none, bench, 13, {}).promote, false)
  check('...and a departure alone does not promote it', promote('the old bench', none, bench, 13, { departed: true }).promote, false)
}

// The narrator alternates "The Counting House" and "Counting House" freely, and
// keying accrual on the raw name split one room into two candidates that each
// counted half the visits — so a room plainly entered and left twice could
// never reach `entered_and_left`. Seen live on the first world created after
// the authored opening began seeding the cursor.
check(
  'an article does not create a second candidate',
  locationCandidateKey('The Counting House') === locationCandidateKey('Counting House'),
  true,
)
check(
  'nor does a possessive',
  locationCandidateKey("my brother's room") === locationCandidateKey("brother's room"),
  true,
)
check(
  'but two different rooms stay apart',
  locationCandidateKey('the tide-stair') === locationCandidateKey('the terminal room'),
  false,
)

console.log(`\nplace promotion audit: ${fail === 0 ? 'ALL GREEN' : `${fail} FAILED`} (${pass} passed)`)
process.exit(fail === 0 ? 0 : 1)
