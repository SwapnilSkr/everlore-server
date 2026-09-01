/**
 * The cursor must FOLLOW the player when they travel, and must NOT follow a
 * place that is merely talked about.
 *
 * The old gate required a player-sourced `player_destination` for every move
 * after the first. The witness reliably reports the arrival place in
 * `current_location` with NARRATIVE evidence instead, so in practice the cursor
 * anchored once and never moved again — a full playthrough that rode to a keep
 * still read "You are here: the road". Reopening it safely needs a second,
 * independent witness: the player's own narrated action.
 *
 *   bun run scripts/narrated-arrival-audit.ts
 */
import { detectNarratedMovement, locationNamesCompatible, isSafeWitnessLocationCandidate, hasGroundedWitnessLocationEvidence } from '../worker/lib/movement-signal'

let failures = 0
function ok(label: string, cond: boolean, detail = '') {
  console.log(`  ${cond ? '✅' : '❌'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!cond) failures++
}

// The exact decision the processor makes, in one place, so the audit tests the
// rule rather than a paraphrase of it.
function cursorFollows(params: {
  playerInput: string
  prose: string
  witnessLocation: string | null
  evidence: string | null
  travelConfirmed: boolean
  viewpointMoved: boolean
  currentPlace: string | null
}): boolean {
  const opts = { knownPeople: [], knownPlaces: [params.currentPlace || ''] }
  return (
    params.travelConfirmed &&
    params.viewpointMoved &&
    hasGroundedWitnessLocationEvidence(params.evidence, params.prose) &&
    isSafeWitnessLocationCandidate(params.witnessLocation, opts) &&
    detectNarratedMovement(params.playerInput) &&
    !locationNamesCompatible(params.witnessLocation, params.currentPlace)
  )
}

console.log('=== the cursor follows real travel ===')
ok('riding to a keep moves the cursor off the road', cursorFollows({
  playerInput: 'We ride north and reach the gatehouse of Blackstone Keep. I dismount.',
  prose: '*Blackstone Keep shows itself — squat, grey, snow gathering in the crenellations. Michael dismounts at the gatehouse.*',
  witnessLocation: 'gatehouse of Blackstone Keep',
  evidence: 'Blackstone Keep shows itself — squat, grey, snow gathering in the crenellations',
  travelConfirmed: true, viewpointMoved: true, currentPlace: 'the road',
}), 'the exact playthrough that failed')

console.log('\n=== and refuses everything else ===')
ok('a place merely TALKED about does not move it', cursorFollows({
  playerInput: 'I ask him what Blackstone Keep is like.',
  prose: '*He shrugs.* "Blackstone Keep is a day north. Good stone, deep well."',
  witnessLocation: 'Blackstone Keep',
  evidence: 'Blackstone Keep is a day north',
  travelConfirmed: true, viewpointMoved: true, currentPlace: 'the road',
}) === false, 'no player movement — this was the phantom-travel bug')
ok('the witness alone is not enough without player movement', cursorFollows({
  playerInput: 'I say nothing and wait.',
  prose: '*The gatehouse of Blackstone Keep looms over the road ahead.*',
  witnessLocation: 'gatehouse of Blackstone Keep',
  evidence: 'The gatehouse of Blackstone Keep looms over the road ahead',
  travelConfirmed: true, viewpointMoved: true, currentPlace: 'the road',
}) === false)
ok('staying in the same place is not a move', cursorFollows({
  playerInput: 'I walk over to the fire and sit down.',
  prose: '*He crosses the road to the fire.*',
  witnessLocation: 'the road',
  evidence: 'He crosses the road to the fire',
  travelConfirmed: true, viewpointMoved: true, currentPlace: 'the road',
}) === false, 'same place — locationNamesCompatible')
ok('the witness saying "no travel" is respected', cursorFollows({
  playerInput: 'We ride north and reach the gatehouse of Blackstone Keep.',
  prose: '*Blackstone Keep shows itself.*',
  witnessLocation: 'gatehouse of Blackstone Keep',
  evidence: 'Blackstone Keep shows itself',
  travelConfirmed: false, viewpointMoved: false, currentPlace: 'the road',
}) === false)
ok('fabricated evidence is refused', cursorFollows({
  playerInput: 'I ride north to the keep.',
  prose: '*The road goes on.*',
  witnessLocation: 'Blackstone Keep',
  evidence: 'Michael passes through the gates of Blackstone Keep',
  travelConfirmed: true, viewpointMoved: true, currentPlace: 'the road',
}) === false, 'evidence not present in the prose')

console.log('\n=== the player-movement witness itself ===')
for (const [t, want] of [
  ['We ride north and reach the gatehouse.', true],
  ['I go to my room and shut the door.', true],
  ['I leave the hall.', true],
  ['I ask him about the keep.', false],
  ['I draw my sword.', false],
  ['I say nothing.', false],
] as Array<[string, boolean]>) {
  ok(`"${t}" → movement=${want}`, detectNarratedMovement(t) === want)
}

console.log(`\n${failures === 0 ? '✅ ALL INVARIANTS HELD' : `❌ ${failures} FAILED`}`)
process.exit(failures === 0 ? 0 : 1)
