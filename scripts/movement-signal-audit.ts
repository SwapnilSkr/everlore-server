/**
 * Pure-function audit for the deterministic movement + possessive-room backstops
 * (worker/lib/movement-signal.ts). No DB. Run: bun run audit:movement
 */
import { detectNarratedMovement, resolvePossessiveRoomName } from '../worker/lib/movement-signal'

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
]) check(t, detectNarratedMovement(t), true)

console.log('detectNarratedMovement — NON-MOVES (expect false):')
for (const t of [
  'I look at him across the table',
  '"Leave me alone," I snap',
  'I reach for my plate',
  'I think about the garden we used to visit',
  'I sit in silence',
  'Why are you so focused on your phone?',
  '',
]) check(t, detectNarratedMovement(t), false)

console.log('resolvePossessiveRoomName (owner = Swapnil Sarkar):')
const O = 'Swapnil Sarkar'
check('my room', resolvePossessiveRoomName('*I go to my room and shut the door*', O), "Swapnil Sarkar's room")
check('my own bedroom', resolvePossessiveRoomName('I retreat to my own bedroom', O), "Swapnil Sarkar's room")
check('my study', resolvePossessiveRoomName('I head to my study', O), "Swapnil Sarkar's study")
check('my chambers', resolvePossessiveRoomName('I withdraw to my chambers', O), "Swapnil Sarkar's chambers")
check('my house (dwelling)', resolvePossessiveRoomName('I return to my house', O), "Swapnil Sarkar's house")
check('my home (dwelling)', resolvePossessiveRoomName('I head home to my home', O), "Swapnil Sarkar's home")
check('her chambers (not first person)', resolvePossessiveRoomName('I follow her to her chambers', O), null)
check('my village (settlement, NOT owned)', resolvePossessiveRoomName('I return to my village', O), null)
check('my city (settlement, NOT owned)', resolvePossessiveRoomName('I travel to my city', O), null)
check('my kingdom (settlement, NOT owned)', resolvePossessiveRoomName('I ride to my kingdom', O), null)
check('no possessive', resolvePossessiveRoomName('I walk into the hall', O), null)
check('no owner', resolvePossessiveRoomName('I go to my room', null), null)

console.log(`\n${fail === 0 ? 'ALL GREEN' : 'FAILURES'}: ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
