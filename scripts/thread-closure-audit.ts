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
 * A later save showed the other half: appointments stored as ordinary
 * observations were never flagged as threads, so they never entered this list.
 * RAG kept retrieving "meet at the yard at first light" and "burn the note"
 * after both had already happened. Related live facts are now shown first,
 * promises are threads even without the flag, and a closed fact leaves retrieval.
 *
 * Replaying that first save with the threads listed closes 37 of the 48. This
 * pins the routing, which is the half that has to be exact.
 *
 *   bun run audit:thread-closure
 */
import { ObjectId } from 'mongodb'
import {
  closedMemorySetFields,
  forceUnresolvedThread,
  mergeCloseableCandidates,
  relatedMemoryQueries,
  routeThreadClosures,
} from '../worker/processors/memory.processor'

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

console.log('\na promise is a thread even when the flag is forgotten:')
check('flag true stays true', forceUnresolvedThread('observation', true), true)
check('promise without flag is still a thread', forceUnresolvedThread('promise', false), true)
check('promise with flag is a thread', forceUnresolvedThread('promise', true), true)
check('observation without flag is not a thread', forceUnresolvedThread('observation', false), false)
check('emotion without flag is not a thread', forceUnresolvedThread('emotion', undefined), false)

console.log('\nrelated facts this turn can close are shown first:')
const openId = new ObjectId()
const relatedId = new ObjectId()
const merged = mergeCloseableCandidates(
  [{ _id: relatedId, text: 'Meet the steward at the yard at first light.' }],
  [{ _id: openId, text: 'Protect Elara.' }],
)
check('related appointment is T1', merged[0]?.key, 'T1')
check('related appointment is the first shown', merged[0]?.text, 'Meet the steward at the yard at first light.')
check('open thread still appears', merged[1]?.text, 'Protect Elara.')
check('duplicate ids appear once', mergeCloseableCandidates(
  [{ _id: openId, text: 'Meet at first light.' }],
  [{ _id: openId, text: 'Meet at first light.' }],
).length, 1)
check('empty text is dropped', mergeCloseableCandidates([{ _id: new ObjectId(), text: '   ' }], []).length, 0)

console.log('\nclosing a paid fact takes it out of retrieval:')
const closed = closedMemorySetFields(new Date('2026-09-04T00:00:00Z'))
check('closed facts are archived', closed.is_archived, true)
check('closed facts are superseded', closed.status, 'superseded')
check('closed facts are no longer threads', closed.unresolved_thread, false)
check('closed facts keep a resolved timestamp', String(closed.resolved_at), String(new Date('2026-09-04T00:00:00Z')))

console.log('\nthe related-memory search query stays short enough to match:')
check(
  'player input is used when present',
  relatedMemoryQueries('*I pull out the parchment and set it alight.*', 'The parchment caught fire.')[0],
  '*I pull out the parchment and set it alight.*',
)
check(
  'opening narration is a second query',
  relatedMemoryQueries('I will see you soon', 'The steward gave a slow nod. "First light," he repeated. "The south gate."').length,
  2,
)
check('blank turns produce no query', relatedMemoryQueries('', ''), [])

console.log(`\nthread closure audit: ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
