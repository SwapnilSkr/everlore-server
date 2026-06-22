/**
 * Pure-function audit for the travelling-party signal detector (no DB / no LLM).
 * Run: bun run audit:party-signal
 */
import { detectCompanionJoins, detectCompanionDepartures } from '../worker/lib/party-signal'

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

console.log('joins — NOT a join (opt-in must not over-fire):')
check('solo travel, no companion', detectCompanionJoins('I set off down the road alone.'), [])
check('mere mention is not a join', detectCompanionJoins('You think of Mara as you walk.'), [])
check('someone leaving is not a join', detectCompanionJoins('Mara waves and walks away.'), [])

console.log('departures — explicit partings (+ destination):')
check('"Mara stays behind"', detectCompanionDepartures('Mara stays behind at the inn.'), [{ name: 'Mara' }])
check('"part ways with Bram"', detectCompanionDepartures('You part ways with Bram.'), [{ name: 'Bram' }])
check('"Mara leaves for the capital" (destination)', detectCompanionDepartures('Mara leaves for the capital.'), [{ name: 'Mara', destination: 'capital' }])
check('"Bram heads back to the village"', detectCompanionDepartures('Bram heads back to the village.'), [{ name: 'Bram', destination: 'village' }])

console.log('departures — NOT a parting:')
check('staying together is not a parting', detectCompanionDepartures('You and Mara press on together.'), [])

console.log(`\nparty signal audit: ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
