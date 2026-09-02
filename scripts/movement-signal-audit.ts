/**
 * Pure-function audit for the deterministic movement + possessive-room backstops
 * (worker/lib/movement-signal.ts). No DB. Run: bun run audit:movement
 */
import {
  detectNarratedMovement,
  extractExplicitPhysicalDestination,
  isExplicitSceneExit,
  locationNamesCompatible,
  resolvePossessiveRoomName,
  validatedContainmentHint,
} from '../worker/lib/movement-signal'

let pass = 0
let fail = 0
function check(label: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (ok) pass++
  else { fail++; console.log(`  FAIL ${label}\n       got ${JSON.stringify(got)} want ${JSON.stringify(want)}`) }
}

console.log('detectNarratedMovement — MOVES (expect true):')
for (const t of [
  '*I go to my room and shut the door*',
  'I head back inside the mansion',
  'I walk into the hall',
  'I step outside',
  'I leave the dining room',
  'I retreat to my chambers',
  'I storm out',
  'I make my way to the garden',
  'I go back downstairs',
  'I close the door behind me',
  'I retire to my study for the night',
  // open-world scale — settlements / realms / planets, not just rooms
  'I travel to the city of Veliscourt',
  'I journey to the Shadow Realm',
  'I ride to the northern capital',
  'I sail to the northern isles',
  'I cross into the kingdom of Marr',
  'I venture into the forest',
  'I set off for the mountains',
  'I return to my village',
  'We board the ship and voyage across the sea',
  'I teleport to the citadel',
  // recall recovery (June 26): a multi-word phrase between the verb and the
  // direction used to slip past the old {0,2} window — the live playtest gap.
  'I head down the hall into my room and shut the door',
  'I make my way down the corridor toward the throne room',
  // bare up/down as a direction particle after a locomotion verb
  'I walk down the stairs',
  'I climb up to the rampart',
  // physical-locomotion verb with no adjective/noun homograph (gated by a direction)
  'I clamber up the cliff face',
]) check(t, detectNarratedMovement(t), true)

console.log('detectNarratedMovement — NON-MOVES (expect false):')
for (const t of [
  'I look at him across the table',
  '"Leave me alone," I snap',
  'I reach for my plate',
  'I think about the garden we used to visit',
  'I sit in silence',
  'Why are you so focused on your phone?',
  // the widened window is still BOUNDED — a direction word far past the verb
  // (here "for" is 8 words after "go") must NOT trigger a phantom move.
  'I go and quietly grab the old rusty key for her',
  // ADJECTIVE/NOUN homographs of locomotion verbs must NOT read as movement, even
  // when a direction word trails (these are why swim/stagger/limp/tiptoe were rejected)
  'It was a staggering amount to pay',          // "staggering" = adjective, not a move
  'I clean the swimming pool to a shine',       // "swimming pool" = noun phrase
  'I stand on tiptoe to reach the shelf',       // "on tiptoe to" = no move
  'It was a limp excuse to offer',              // "limp" = adjective
  '',
]) check(t, detectNarratedMovement(t), false)

console.log('resolvePossessiveRoomName (owner = Swapnil Sarkar):')
const O = 'Swapnil Sarkar'
check('my room', resolvePossessiveRoomName('*I go to my room and shut the door*', O), "Swapnil Sarkar's room")
check('my own bedroom', resolvePossessiveRoomName('I retreat to my own bedroom', O), "Swapnil Sarkar's room")
check('my study', resolvePossessiveRoomName('I head to my study', O), "Swapnil Sarkar's study")
check('my chambers', resolvePossessiveRoomName('I withdraw to my chambers', O), "Swapnil Sarkar's chambers")
check('my house (dwelling)', resolvePossessiveRoomName('I return to my house', O), "Swapnil Sarkar's house")
check('my penthouse (dwelling)', resolvePossessiveRoomName('I head up to my penthouse', O), "Swapnil Sarkar's penthouse")
check('my workshop (room)', resolvePossessiveRoomName('I slip into my workshop', O), "Swapnil Sarkar's workshop")
check('my basement (room)', resolvePossessiveRoomName('I go down to my basement', O), "Swapnil Sarkar's basement")
check('my home (dwelling)', resolvePossessiveRoomName('I head home to my home', O), "Swapnil Sarkar's home")
check('her chambers (not first person)', resolvePossessiveRoomName('I follow her to her chambers', O), null)
// origin vs destination — the room is what's being LEFT, not the destination
check('leave my room → dining room (origin)', resolvePossessiveRoomName('*I leave my room and head back down to the dining room.*', O), null)
check('storm out of my room (origin)', resolvePossessiveRoomName('I storm out of my room', O), null)
check('flee my chambers (origin)', resolvePossessiveRoomName('I flee my chambers', O), null)
check('leave the hall, go to my room (room IS destination)', resolvePossessiveRoomName('I leave the hall and go to my room', O), "Swapnil Sarkar's room")
check('return to my room after leaving dining (destination)', resolvePossessiveRoomName('I leave the dining room and retreat to my room', O), "Swapnil Sarkar's room")
check('my village (settlement, NOT owned)', resolvePossessiveRoomName('I return to my village', O), null)
check('my city (settlement, NOT owned)', resolvePossessiveRoomName('I travel to my city', O), null)
check('my kingdom (settlement, NOT owned)', resolvePossessiveRoomName('I ride to my kingdom', O), null)
check('no possessive', resolvePossessiveRoomName('I walk into the hall', O), null)
check('no owner', resolvePossessiveRoomName('I go to my room', null), null)

console.log('physical destination + scene exit gates:')
check('district destination', extractExplicitPhysicalDestination('I begin the walk toward the Brera district.'), 'the Brera district')
check('action clause is not part of bedroom name', extractExplicitPhysicalDestination('I go to my bedroom as I begin packing.'), 'my bedroom')
check('purpose clause is not part of living room name', extractExplicitPhysicalDestination('I head for the living room to say goodbye to Lisa.'), 'the living room')
check('direct address is not part of airport name', extractExplicitPhysicalDestination('I need to go to the airport Dad.'), 'the airport')
check('arrival verb registers Milan', extractExplicitPhysicalDestination('After two days, I finally reach Milan.'), 'Milan')
check('reach for a coat is not travel', extractExplicitPhysicalDestination('I reach for my coat.'), null)
check('taking a hotel registers the venue', extractExplicitPhysicalDestination('*I take a hotel to stay at.*'), 'hotel')
check('street address beats approached door', extractExplicitPhysicalDestination('I walk directly up to the heavy oak door at Via Brera, 14, and knock.'), 'Via Brera, 14')
check('square my shoulders remains a cafe journey', extractExplicitPhysicalDestination('*I square my shoulders and walk with purpose toward the cafe.*'), 'the cafe')
check('abstract answer is not a destination', extractExplicitPhysicalDestination('I head for an answer.'), null)
check('townhouse exit breaks scene', isExplicitSceneExit('I stand, nod, and exit the townhouse without another word.'), true)
check('possessive townhouse exit breaks scene', isExplicitSceneExit("I leave Vico's townhouse without looking back."), true)
check('gallery exit breaks scene', isExplicitSceneExit('I leave the gallery and step into the street.'), true)
check('leave the question does not break scene', isExplicitSceneExit('I leave the question to Mother.'), false)

console.log('witness location validation:')
check('Brera district corroborates Via Brera address', locationNamesCompatible('the Brera district', 'Via Brera, 14'), true)
check('different rooms do not corroborate', locationNamesCompatible('dining room', 'kitchen'), false)
check(
  'known current city accepted as container',
  validatedContainmentHint({
    destination: 'Via Brera, 14',
    witnessLocation: 'Via Brera, 14',
    witnessContainment: 'Milan',
    currentLocationName: 'Milan',
    knownLocationNames: ['Milan', 'cafe'],
  }),
  'Milan',
)
check(
  'unknown parent is held',
  validatedContainmentHint({
    destination: 'Via Brera, 14',
    witnessLocation: 'Via Brera, 14',
    witnessContainment: 'an invented empire',
    currentLocationName: 'Milan',
    knownLocationNames: ['Milan'],
  }),
  null,
)

console.log(`\n${fail === 0 ? 'ALL GREEN' : 'FAILURES'}: ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
