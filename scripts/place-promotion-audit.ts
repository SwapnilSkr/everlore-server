/**
 * Place promotion — can furniture ever become a map node?
 *
 * Every case is drawn from live turns. The bench, the hearth and the terminal
 * are the labels that actually reached the cursor; the hall, the cellars and the
 * canal are the places the old vocabulary gate got wrong in the other direction.
 */
import { classifyPlaceRelation, decidePlacePromotion, type PlaceAccrual } from '../worker/lib/place-promotion'

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
  extra: { containment?: boolean; authored?: boolean } = {},
) =>
  decidePlacePromotion({
    candidate,
    sequence: seq,
    relation,
    containment: extra.containment === true,
    authored: extra.authored === true,
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

console.log(`\nplace promotion audit: ${fail === 0 ? 'ALL GREEN' : `${fail} FAILED`} (${pass} passed)`)
process.exit(fail === 0 ? 0 : 1)
