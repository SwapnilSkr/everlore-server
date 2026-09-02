/**
 * Pure-function audit for the travelling-party signal detector (no DB / no LLM).
 * Run: bun run audit:party-signal
 */
import { detectCompanionJoins, detectCompanionDepartures, detectSoloTravel } from '../worker/lib/party-signal'

let pass = 0
let fail = 0
function check(label: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (ok) pass++
  else { fail++; console.log(`  FAIL ${label}\n       got ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`) }
}

console.log('joins — explicit companion joins detected:')
check('"Mara joins you"', detectCompanionJoins('Mara joins you on the road.'), ['Mara'])
check('"Bram comes with us"', detectCompanionJoins('Bram comes with us.'), ['Bram'])
check('"decides to accompany you"', detectCompanionJoins('Elara decides to accompany you.'), ['Elara'])
check('player-led "I take Mara with me"', detectCompanionJoins('I take Mara with me.'), ['Mara'])
check('"together with Bram we set off"', detectCompanionJoins('Together with Bram we set off at dawn.'), ['Bram'])
check('"Mara and I set off"', detectCompanionJoins('Mara and I set off north.'), ['Mara'])
check('player-led "I bring Mara along"', detectCompanionJoins('I bring Mara along.'), ['Mara'])
// Asking someone to come along is how a player actually recruits a companion, and
// it went undetected — so a move left the companion out of the new scene entirely.
check('addressed "Neva, walk with me"', detectCompanionJoins('Neva, walk with me.'), ['Neva'])
check('addressed "Come with me, Bram"', detectCompanionJoins('Come with me, Bram.'), ['Bram'])

console.log('joins — NOT a join (opt-in must not over-fire):')
check('solo travel, no companion', detectCompanionJoins('I set off down the road alone.'), [])
check('mere mention is not a join', detectCompanionJoins('You think of Mara as you walk.'), [])
// GRABBING someone is not recruiting them. "take"/"bring" are the only join verbs
// that do not carry "with" themselves, so bare they matched ordinary transitive
// use: a live run enrolled an assaulted steward in the player's travelling party,
// and party membership bypasses the scene-state corroboration gate — so he
// followed the player out of the room and stayed in every scene after.
check('grabbing is not a join', detectCompanionJoins('I take Halvard by the collar and pull him up.'), [])
check('"I bring him to his knees" is not a join', detectCompanionJoins('I bring Halvard to his knees.'), [])
check('sending someone away is not a join', detectCompanionJoins('Neva, walk away from me.'), [])
check('someone leaving is not a join', detectCompanionJoins('Mara waves and walks away.'), [])

console.log('solo travel — the party is emptied with no name given:')
// "I ride back alone" names nobody, so no departure signal fired and the
// companion stayed in the party — and party membership skips the scene-state
// corroboration gate, so she was carried into every later scene. The player rode
// home by himself with his sister still standing beside him.
check('"I ride back alone"', detectSoloTravel('I ride back alone to Ashfall Hold.'), true)
check('"I set off alone"', detectSoloTravel('I set off alone.'), true)
check('"we travel on our own"', detectSoloTravel('We travel on our own from here.'), true)
check('travelling together is not solo', detectSoloTravel('Neva and I ride down the low road.'), false)
check('"leave me alone" is an idiom, not a departure', detectSoloTravel('I ask her to leave me alone.'), false)
check('feeling alone is not travelling alone', detectSoloTravel('I feel alone.'), false)

console.log('departures — explicit partings (+ destination):')
check('"Mara stays behind"', detectCompanionDepartures('Mara stays behind at the inn.'), [{ name: 'Mara' }])
check('"part ways with Bram"', detectCompanionDepartures('You part ways with Bram.'), [{ name: 'Bram' }])
check('"Mara leaves for the capital" (destination)', detectCompanionDepartures('Mara leaves for the capital.'), [{ name: 'Mara', destination: 'capital' }])
check('"Bram heads back to the village"', detectCompanionDepartures('Bram heads back to the village.'), [{ name: 'Bram', destination: 'village' }])

console.log('departures — NOT a parting:')
check('staying together is not a parting', detectCompanionDepartures('You and Mara press on together.'), [])

console.log(`\nparty signal audit: ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
