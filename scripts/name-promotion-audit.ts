/**
 * A label-only person may be given a proper name only when the TURN says that
 * name is theirs. The prose is full of proper nouns that are not the speaker —
 * houses, lords referred to in the third person, places — and a wrong promotion
 * is silent, permanent, and fuses two people's bonds onto one card.
 *
 *   bun run scripts/name-promotion-audit.ts
 */
import { namePromotionEvidence } from '../worker/lib/character-codex-extractor'

let failures = 0
function ok(label: string, cond: boolean, detail = '') {
  console.log(`  ${cond ? '✅' : '❌'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!cond) failures++
}

console.log('=== accepted: the turn says the name is his ===')
ok('an explicit self-introduction',
  namePromotionEvidence('Aldric', '*He shrugs.* "I am Aldric, and I keep the north road."', '') === 'self_introduction')
ok('the answer to the player asking',
  namePromotionEvidence('Aldric', '"Aldric," *he says at last.*', 'I ask him what his name is.') !== null)
ok('a literal naming in the narration',
  namePromotionEvidence('Aldric', '*A rider named Aldric waits at the ford.*', '') === 'named_in_prose')
ok('quoted direct address',
  namePromotionEvidence('Aldric', '*She raises a hand.* "Aldric, hold there."', '') === 'named_in_prose')

console.log('\n=== refused: the name is merely nearby ===')
ok('the house he serves is not his name',
  namePromotionEvidence('Thorne', '"House Thorne is offering you a place at our table."', 'I ask what joining would cost me.') === null)
ok('a lord spoken of in the third person is someone else',
  namePromotionEvidence('Thorne', '"Lord Thorne does not make the same mistake twice."', '') === null,
  'the observed emulator card fused an envoy with his lord')
ok('a place name is not a person',
  namePromotionEvidence('Blackstone', '"Blackstone Keep is yours to hold, if your oath is true."', '') === null)
ok('another character in the scene is not him',
  namePromotionEvidence('Mira', '*Mira watches the rider from the gate.*', '') === null)
ok('a name only the player used is not proof',
  namePromotionEvidence('Aldric', '*The rider says nothing.*', 'I wonder if this is Aldric.') === null)

console.log(`\n${failures === 0 ? '✅ ALL INVARIANTS HELD' : `❌ ${failures} FAILED`}`)
process.exit(failures === 0 ? 0 : 1)
