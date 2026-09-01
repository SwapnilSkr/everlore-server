/**
 * LIVE probe for recurrence-based carding. Calls the real extractor twice on the
 * same turn, changing only whether the unnamed figure is on the promotable list:
 *
 *   not promotable → no card (a first-sight passer-by is not a Bonds card)
 *   promotable     → a role_label card (the story kept coming back to him)
 *
 *   bun run scripts/recurring-promotion-probe.ts
 */
import { extractCharacterCodexDeltas } from '../worker/lib/character-codex-extractor'

const PLAYER = 'I sheathe the sword and offer him my hand in good faith.'
const PROSE = `*Michael slides the blade back into its scabbard and extends his hand. The rider's smile doesn't reach his eyes, but he clasps Michael's forearm in a warrior's grip, his own grip callused and strong.*

"Honest steel is a rare thing," *he says, letting go.* "Walk with me. The gates of Thorne are open to those who can look a man in the eye before they cut him down." *He turns his horse and gestures for Michael to follow.*`

async function run(label: string, promotable: string[]) {
  const deltas = await extractCharacterCodexDeltas({
    playerInput: PLAYER,
    aiResponse: PROSE,
    existing: [],
    protagonistName: 'Michael Oliver',
    presentCast: ['the rider'],
    promotableRecurringPeople: promotable,
  })
  const rider = deltas.find((d) => /rider/i.test(`${d.name} ${d.resolved_name || ''}`))
  console.log(`\n${label}`)
  console.log(`  cards: ${deltas.map((d) => `${d.name} [${d.identity_kind || '?'}]`).join(', ') || '(none)'}`)
  console.log(`  rider carded: ${rider ? `YES — "${rider.name}" (${rider.identity_kind}), meters ${JSON.stringify(rider.relationship_deltas || null)}` : 'no'}`)
  return !!rider
}

const withoutList = await run('A · "the rider" NOT on the promotable list', [])
const withList = await run('B · "the rider" ON the promotable list (3+ mentions, 2+ involvements)', ['the rider'])

const okA = withoutList === false
const okB = withList === true
console.log(`\n${okA ? '✅' : '❌'} first sight is not a card`)
console.log(`${okB ? '✅' : '❌'} recurrence earns a card without a name`)
process.exit(okA && okB ? 0 : 1)
