/**
 * Durability audit — can a wrong write ever be un-written?
 *
 * Every bug that made this project feel unfixable was a DURABLE one: a cursor
 * stuck for eleven turns, a companion who followed the player forever. The error
 * rate was never the problem; the fact that an error could not decay was.
 * These cases pin the two re-derivation paths.
 */
import { decideCursorDrift, decidePartyDecay, type DriftState } from '../worker/lib/cursor-drift'
import { locationNamesCompatible } from '../worker/lib/movement-signal'

let pass = 0
let fail = 0
function check(label: string, got: unknown, want: unknown) {
  if (JSON.stringify(got) === JSON.stringify(want)) pass++
  else {
    fail++
    console.log(`  FAIL ${label}\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`)
  }
}
const drift = (sceneAnchor: string | null, cursorName: string | null, prior: DriftState | null, sequence = 10) =>
  decideCursorDrift({ sceneAnchor, cursorName, prior, sequence, compatible: locationNamesCompatible })

console.log('cursor drift — a wrong cursor must be recoverable:')
check('agreement clears the counter', drift('the hall', 'the hall', { name: 'the hall', count: 1, since_sequence: 9 }).count, 0)
check('no anchor never accrues drift', drift(null, 'root cellars', { name: 'the hall', count: 1, since_sequence: 9 }).count, 0)
check('one disagreement does not repair', drift('the hall', 'root cellars', null).repair, null)
check('...it is remembered', drift('the hall', 'root cellars', null).next, { name: 'the hall', count: 1, since_sequence: 10 })
check(
  'the SAME place twice repairs the cursor',
  drift('the hall', 'root cellars', { name: 'the hall', count: 1, since_sequence: 9 }).repair,
  'the hall',
)
check(
  '...and the counter is cleared by the repair',
  drift('the hall', 'root cellars', { name: 'the hall', count: 1, since_sequence: 9 }).next,
  null,
)
check(
  'two DIFFERENT places do not repair — a stray read cannot accumulate',
  drift('the gatehouse', 'root cellars', { name: 'the hall', count: 1, since_sequence: 9 }).repair,
  null,
)
check(
  '...the new place starts its own count at 1',
  drift('the gatehouse', 'root cellars', { name: 'the hall', count: 1, since_sequence: 9 }).count,
  1,
)
check(
  'an agreeing turn between two disagreements resets the run',
  drift('the hall', 'root cellars', drift('the hall', 'the hall', { name: 'the hall', count: 1, since_sequence: 8 }).next).repair,
  null,
)
// The live bug this exists for: the player walks out of the War Room, the prose
// says "The hall outside is quiet", and no move is ever detected.
check(
  'the War Room case repairs without any move being detected',
  drift('the hall', 'War Room', { name: 'the hall', count: 1, since_sequence: 48 }, 49).repair,
  'the hall',
)

console.log('party decay — a companion must be able to stop travelling with you:')
check('present resets the count', decidePartyDecay({ seenThisScene: true, priorMisses: 1 }), { misses: 0, drop: false })
check('one absence does not drop', decidePartyDecay({ seenThisScene: false, priorMisses: 0 }), { misses: 1, drop: false })
check('two absences drop', decidePartyDecay({ seenThisScene: false, priorMisses: 1 }), { misses: 2, drop: true })
check('a quiet companion who reappears is safe', decidePartyDecay({ seenThisScene: true, priorMisses: 0 }), { misses: 0, drop: false })

console.log(`\ndurability audit: ${fail === 0 ? 'ALL GREEN' : `${fail} FAILED`} (${pass} passed)`)
process.exit(fail === 0 ? 0 : 1)
