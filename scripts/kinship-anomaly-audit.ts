/**
 * Pure-function audit for the projection ANOMALY detector's kinship check.
 * `kinship_phrase_no_edge` must fire only for a family tie the save's
 * relationship graph does NOT already hold — a turn that says "your father" about
 * a father recorded turns ago is not an extraction miss. No DB / no LLM.
 * Run: bun run audit:kinship-anomaly
 */
import {
  detectProjectionAnomalies, kinRelationGroup, type AnomalyInput,
} from '../worker/lib/projection-anomaly-detector'

let pass = 0
let fail = 0
function check(label: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (ok) pass++
  else { fail++; console.log(`  FAIL ${label}\n       got ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`) }
}

const base: AnomalyInput = {
  prose: '', presentNames: [], codexNames: [], stubNames: [], hadRelationAssertion: false,
}
/** An edge row's group, built the way the processor builds it. The writer stamps
 *  `biological` on an unmarked tie, so these are the REAL shapes from entity_edges. */
const group = (kind: string, gender?: string | null, modifier?: string | null) => kinRelationGroup(kind, gender, modifier)!
const FATHER = group('parent_of', 'm', 'biological')
const SISTER = group('sibling_of', 'f', 'biological')

/** Only the kinship findings — every other type is checked separately below. */
const kin = (input: Partial<AnomalyInput>) =>
  detectProjectionAnomalies({ ...base, ...input }).filter((f) => f.type === 'kinship_phrase_no_edge')

console.log('(a) a tie the graph already holds is not a miss:')
check('"your father" with father known ⇒ no finding',
  kin({ prose: 'Your father settles into the chair.', knownKinRelations: [FATHER] }), [])

console.log('(b) group normalisation — synonyms of a known tie:')
check('a prose term lands in the same group as its stored edge',
  kinRelationGroup('parent_of', 'm'), kinRelationGroup('parent_of', 'm', 'biological'))
check('"your dad" with father known ⇒ no finding',
  kin({ prose: 'Your dad settles into the chair.', knownKinRelations: [FATHER] }), [])

console.log('(c) a tie the graph does not hold still fires:')
check('"your sister" with only father known ⇒ finding names sister',
  kin({ prose: 'Your sister waits by the door.', knownKinRelations: [FATHER] }),
  [{
    type: 'kinship_phrase_no_edge',
    severity: 'info',
    details: "prose states a kin tie (sister) the relationship graph doesn't hold",
  }])
// The group is kind + gender + modifier, not the bare structural kind — a known
// father must not silence a mother, nor a stepfather a father.
check('"your mother" with only father known ⇒ fires',
  kin({ prose: 'Your mother waits.', knownKinRelations: [FATHER] }).map((f) => f.details),
  ["prose states a kin tie (mother) the relationship graph doesn't hold"])
check('"your stepfather" with only father known ⇒ fires',
  kin({ prose: 'Your stepfather waits.', knownKinRelations: [FATHER] }).map((f) => f.details),
  ["prose states a kin tie (stepfather) the relationship graph doesn't hold"])

console.log('(d) every match is collected, known ones excluded from details:')
check('"your father … my sister" with father known ⇒ names sister only',
  kin({ prose: 'Your father nods. My sister waits by the door.', knownKinRelations: [FATHER] }).map((f) => f.details),
  ["prose states a kin tie (sister) the relationship graph doesn't hold"])
check('two unknown ties are both named',
  kin({ prose: 'Your sister nods. Your brother waits.', knownKinRelations: [] }).map((f) => f.details),
  ["prose states a kin tie (sister, brother) the relationship graph doesn't hold"])

console.log('(e) nothing supplied — today\'s behaviour, unchanged:')
check('absent knownKinRelations ⇒ one finding, first phrase, legacy wording',
  kin({ prose: 'Your father nods. Your sister waits by the door.' }),
  [{
    type: 'kinship_phrase_no_edge',
    severity: 'info',
    details: 'prose states a kin tie (Your father) but no relation assertion was produced',
  }])
check('an empty known set still fires (the graph holds nothing yet)',
  kin({ prose: 'Your father nods.', knownKinRelations: [] }).map((f) => f.details),
  ["prose states a kin tie (father) the relationship graph doesn't hold"])

console.log('(f) figurative prose and an asserted tie are still silent:')
check('a father figure ⇒ no finding',
  kin({ prose: 'He is a father figure to me.', knownKinRelations: [] }), [])
check('"like a father" ⇒ no finding',
  kin({ prose: 'He watches her like a father.', knownKinRelations: [] }), [])
check('a relation assertion was produced ⇒ no finding',
  kin({ prose: 'Your sister waits.', hadRelationAssertion: true, knownKinRelations: [] }), [])

console.log('(g) the other anomaly types are untouched by the new input:')
{
  const shared: AnomalyInput = {
    ...base,
    prose: 'Mara nodded. My sister waits by the door. The hall is quiet.',
    droppedChoices: [{ issues: [{ type: 'fabricated_kin', term: 'brother', group: 'brother' }] }],
    witnessLocationName: 'The Ash Bridge',
    locationAnchorName: null,
    newCardNames: ['Neva Vale'],
  }
  const nonKin = (input: AnomalyInput) =>
    detectProjectionAnomalies(input).filter((f) => f.type !== 'kinship_phrase_no_edge')
  check('the shared fixture really exercises the four other types',
    [...new Set(nonKin(shared).map((f) => f.type))].sort(),
    ['card_without_prose_anchor', 'choice_ungrounded', 'location_phrase_no_anchor', 'prose_person_untracked'])
  check('non-kinship findings identical with and without known groups',
    nonKin({ ...shared, knownKinRelations: [SISTER] }),
    nonKin(shared))
  check('same fixture and sister known ⇒ no kinship finding',
    kin({ ...shared, knownKinRelations: [SISTER] }), [])
  check('same fixture and nothing known ⇒ the kinship finding is still there',
    kin(shared).length, 1)
}

console.log(`\nkinship anomaly audit: ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
