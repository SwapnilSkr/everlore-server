import {
  adjudicatedPersonKeys,
  entityAdjudicationCandidates,
  filterAdjudicatedPresence,
  type EntityAdjudicationResult,
} from '../worker/lib/entity-adjudicator'

let failed = 0
function ok(label: string, condition: boolean, detail = '') {
  console.log(`${condition ? '✅' : '❌'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!condition) failed++
}

const silence = entityAdjudicationCandidates({
  prose: '*Silence answers from the other side of the door.*',
  knownNames: [],
})
ok('personified Silence never reaches the semantic judge', silence.length === 0)

const mara = entityAdjudicationCandidates({
  prose: '*Mara steps into the hall and sets her wet coat aside.*',
  knownNames: [],
})
ok('named human action reaches the semantic judge', mara.length === 1 && mara[0].key === 'mara')

const notPerson: EntityAdjudicationResult = {
  available: true,
  decisions: [{ key: 'mara', display: 'Mara', verdict: 'not_person', confidence: 0.99, evidenceType: 'test' }],
}
ok('negative verdict blocks candidate presence', filterAdjudicatedPresence(['Mara'], mara, notPerson).length === 0)
ok('negative verdict blocks promotion', adjudicatedPersonKeys(mara, notPerson).size === 0)

const person: EntityAdjudicationResult = {
  available: true,
  decisions: [{ key: 'mara', display: 'Mara', verdict: 'person', confidence: 0.99, evidenceType: 'test' }],
}
ok('person verdict preserves presence', filterAdjudicatedPresence(['Mara'], mara, person).join() === 'Mara')
ok('person verdict allows promotion', adjudicatedPersonKeys(mara, person).has('mara'))

const unavailable: EntityAdjudicationResult = { available: false, decisions: [] }
ok('judge outage preserves existing deterministic presence', filterAdjudicatedPresence(['Mara'], mara, unavailable).join() === 'Mara')
ok('judge outage preserves existing deterministic promotion', adjudicatedPersonKeys(mara, unavailable).has('mara'))

console.log(`\nentity adjudication audit: ${failed === 0 ? 'ALL GREEN' : `${failed} failure(s)`}`)
process.exit(failed ? 1 : 0)
