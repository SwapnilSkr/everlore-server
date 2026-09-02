/**
 * Location citation stack (a)(b)(c). Every FAIL case below moved a live cursor
 * or refused a live move; every PASS case is a real witness citation.
 */
import {
  excerptNamesPlace,
  excerptSituatesViewpoint,
  evaluateLocationCitation,
  citationAdmitsLocation,
  passageSituatesViewpoint,
  extractStatedPosition,
} from '../worker/lib/location-citation'

let failed = 0
function ok(label: string, pass: boolean) {
  console.log(`${pass ? '✅' : '❌'} ${label}`)
  if (!pass) failed++
}

const CAST = ['Bram', 'Tomas', 'Neva', 'Mara', 'Soren']

function situates(place: string, evidence: string): boolean {
  return excerptSituatesViewpoint(place, evidence, { people: CAST })
}

console.log('(b) — the excerpt names THIS place:')
ok('exact name', excerptNamesPlace('the hall', 'the hall is quiet again'))
ok('case/article insensitive', excerptNamesPlace('Night Garden', 'the night garden was empty'))
ok('every distinctive word required', excerptNamesPlace('root cellars', 'the cellars of another house') === false)
ok('multi-word run matches', excerptNamesPlace('root cellars', 'back in the root cellars, the air is cold'))
ok('unrelated sentence fails', excerptNamesPlace('the hall', 'he pours another measure') === false)

console.log('\n(c) — the excerpt puts the VIEWPOINT there (expect true):')
ok('locative PP, scene-setting', situates('root cellars', 'Back in the root cellars, the air is cold.'))
ok('viewpoint owns the clause', situates('village square', 'We reach the village square.'))
ok('viewpoint + locative', situates('the hall', 'I step back into the hall.'))
ok('place is the subject', situates('the hall', 'The hall is quiet again.'))
ok('second person viewpoint', situates('the gatehouse', 'You stand in the gatehouse, breathing hard.'))
ok('competitor after the viewpoint', situates('the hall', 'I follow her into the hall.'))
ok('proper place as subject', situates('Marrow Ford', 'Marrow Ford lies grey under the rain.'))

console.log('\n(c) — a mere mention must NOT move the cursor (expect false):')
ok('goal PP is not arrival', situates('Marrow Ford', 'the low road to Marrow Ford') === false)
ok('somebody else is down there', situates('the cellars', "Bram's down there in the cellars.") === false)
ok('third person owns the clause', situates('the cellars', 'He is waiting in the cellars.') === false)
ok('talked ABOUT a place', situates('the hall', 'He talked about the hall for a while.') === false)
ok('a plan is not a place', situates('the capital', 'She will ride for the capital at dawn.') === false)
ok('place absent from excerpt', situates('the hall', 'the fire has burned down to embers') === false)
ok('named person owns the locative', situates('the watchtower', 'Tomas waits at the watchtower.') === false)

console.log('\nfull stack against a source passage:')
const PROSE =
  'The rain had not stopped. Back in the root cellars, the air is cold and close. ' +
  "Bram's down there in the cellars with his ledgers, and the low road to Marrow Ford is washed out."

const good = evaluateLocationCitation({
  place: 'root cellars',
  evidence: 'Back in the root cellars, the air is cold',
  source: PROSE,
  people: CAST,
})
ok('a real, locative, place-naming citation admits', citationAdmitsLocation(good))

const goalPP = evaluateLocationCitation({
  place: 'Marrow Ford',
  evidence: 'the low road to Marrow Ford',
  source: PROSE,
  people: CAST,
})
ok('verbatim goal PP is refused by (c)', goalPP.a && goalPP.b && !goalPP.c)

const otherSubject = evaluateLocationCitation({
  place: 'the cellars',
  evidence: "Bram's down there in the cellars",
  source: PROSE,
  people: CAST,
})
ok('verbatim but somebody else is refused by (c)', otherSubject.a && !otherSubject.c)

const fabricated = evaluateLocationCitation({
  place: 'the hall',
  evidence: 'I am standing in the hall',
  source: PROSE,
  people: CAST,
})
ok('a paraphrase is refused by (a)', !fabricated.a)


console.log('\npassage verification — the judge names the place, the source must say so:')
const DOCK =
  'I let out a slow breath, the smoke curling up into the damp air. I stay leaning against the brick wall ' +
  'beside the open dock door, watching you. I lower myself to sit a few feet from you, my own legs dangling over the edge.'
ok('a badly-cited but real place is verified from the passage',
  passageSituatesViewpoint('the dock', DOCK, { people: CAST }))

const SILHOUETTE =
  'Tomas pulls the door shut behind him, his silhouette a stark cutout against the deeper black of the gatehouse road.'
ok('somebody else out on a road does not move the player',
  passageSituatesViewpoint('gatehouse road', SILHOUETTE, { people: CAST }) === false)

ok('a place absent from the passage is never verified',
  passageSituatesViewpoint('Marrow Ford', DOCK, { people: CAST }) === false)

ok('a mentioned destination is not an arrival',
  passageSituatesViewpoint('the loading dock', '"The dock\'s just out back. Past the stage."', { people: CAST }) === false)



console.log('\na place name that carries its own locative preposition:')
ok('"under the bridge" is situated by "the air under the bridge is heavy"',
  situates('under the bridge', 'The air under the bridge is heavy with the promise of it.'))
ok('"behind the bar" is situated by "He is still behind the bar"',
  situates('behind the bar', 'He is still behind the bar, but the glass is finally down.') === false)
ok('"across the square" still needs the viewpoint',
  situates('across the square', 'I wait across the square, out of the lamplight.'))
ok('stripping the preposition does not admit a mention',
  situates('under the bridge', 'He said he would meet her under the bridge tomorrow.') === false)

console.log('\nthe player\'s own text as the second witness (sentient / second-person worlds):')
ok('"I stop under the bridge" situates the viewpoint',
  passageSituatesViewpoint('the bridge', 'I stop under the bridge and watch the water.', { people: CAST }))
ok('a third-person narrator at the same place does not, on its own',
  passageSituatesViewpoint('the bridge', "She's still at the bridge, but she's not watching him anymore.", { people: CAST }) === false)
ok('a player merely intending to go does not situate them',
  passageSituatesViewpoint('the cafe', 'I want to head for the cafe later.', { people: CAST }) === false)

console.log('\nthe player stating their own position (pre-stream, quoted not resolved):')
ok('"I stop under the bridge" is a position', extractStatedPosition('I stop under the bridge and watch the water.') === 'under the bridge')
ok('"walk to the canal bridge" is a position', extractStatedPosition('I walk to the canal bridge.') === 'to the canal bridge')
ok('the span stops at the coordinator', extractStatedPosition('I sit by the hearth and say nothing.') === 'by the hearth')
ok('an intention is not a position', extractStatedPosition('I want to head for the cafe later.') === null)
ok('looking AT a person is not a position', extractStatedPosition('I look at Soren.') === null)
ok('a named companion is not a position', extractStatedPosition('I turn to Tomas.', { people: ['Tomas'] }) === null)
ok('a bare action has none', extractStatedPosition('I nod.') === null)

console.log(`\nlocation evidence audit: ${failed === 0 ? 'ALL GREEN' : `${failed} FAILED`}`)
process.exit(failed === 0 ? 0 : 1)
