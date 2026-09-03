/**
 * OPEN THREADS: what closes them.
 *
 * The curator was asked, from the first version of the prompt, to report which
 * earlier thread this turn paid off — and it was never shown the threads. It
 * sees one exchange and no story. On a live 84-turn save it named a payoff
 * ONCE: 48 threads opened, 1 ever closed, and the rest were handed to the
 * narrator every turn as debts the story still owed. At turn 16 all five slots
 * of that block were the same demand — the king must confirm the departure
 * order before the council — which he had already done twice. One turn later he
 * reversed his own order.
 *
 * Replaying that save with the threads listed closes 37 of the 48. This pins
 * the routing, which is the half that has to be exact.
 *
 *   bun run audit:thread-closure
 */
import { routeThreadClosures } from '../worker/processors/memory.processor'

let pass = 0
let fail = 0
function check(label: string, got: unknown, want: unknown) {
  if (JSON.stringify(got) === JSON.stringify(want)) {
    pass++
    console.log(`  ok   ${label}`)
  } else {
    fail++
    console.log(`  FAIL ${label}\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`)
  }
}
const OFFERED = ['T1', 'T2', 'T3']

console.log('\nthe field it arrives in does not decide what it is:')
check('ids in the id field', routeThreadClosures({ closed_thread_ids: ['T1', 'T3'] }, OFFERED).ids, ['T1', 'T3'])
// Observed live, on turn 15 of the save — the turn that settled the oldest
// demand in the story. Routed as prose, "T1" becomes a text-search query.
check(
  'ids misfiled into the prose field are still ids',
  routeThreadClosures({ resolved_threads: ['T1', 'T2'] }, OFFERED).ids,
  ['T1', 'T2'],
)
check(
  '...and are not also left as prose',
  routeThreadClosures({ resolved_threads: ['T1', 'T2'] }, OFFERED).prose,
  [],
)
check('lowercase and padding still match', routeThreadClosures({ closed_thread_ids: [' t2 '] }, OFFERED).ids, ['T2'])
check(
  'the same id in both fields closes once',
  routeThreadClosures({ closed_thread_ids: ['T1'], resolved_threads: ['T1'] }, OFFERED).ids,
  ['T1'],
)

console.log('\nan id that was never offered is not an id:')
// The ids are positional and rebuilt every turn, so a hallucinated "T9" must
// never resolve to whatever happens to be ninth.
check('an unoffered id is dropped', routeThreadClosures({ closed_thread_ids: ['T9'] }, OFFERED).ids, [])
check(
  'a real prose payoff survives as prose',
  routeThreadClosures({ resolved_threads: ["the player's promise to return Mira's locket"] }, OFFERED),
  { ids: [], prose: ["the player's promise to return Mira's locket"] },
)
check('prose and ids can arrive together', routeThreadClosures({ resolved_threads: ['T2', 'a debt to Mira'] }, OFFERED), {
  ids: ['T2'],
  prose: ['a debt to Mira'],
})

console.log('\nnothing is a valid answer:')
check('empty', routeThreadClosures({}, OFFERED), { ids: [], prose: [] })
check('nulls and junk', routeThreadClosures({ closed_thread_ids: [null, '', 'none'] as any }, OFFERED).ids, [])
check('no threads were offered', routeThreadClosures({ closed_thread_ids: ['T1'] }, []).ids, [])

console.log(`\nthread closure audit: ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
