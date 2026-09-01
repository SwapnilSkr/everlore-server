/**
 * LIVE end-to-end probe for identity scoping. Real extractor, real fold — the
 * four scenarios that used to corrupt a bond, run against the model.
 *
 *   bun run scripts/identity-scope-probe.ts
 */
import { ObjectId } from 'mongodb'
import { extractCharacterCodexDeltas } from '../worker/lib/character-codex-extractor'
import { foldDelta, newFoldState } from '../src/services/character-codex.service'
import type { CharacterProfileDoc } from '../src/models/character-profile.model'

const iid = new ObjectId(); const pid = new ObjectId()
let failures = 0
function ok(l: string, c: boolean, d = '') { console.log(`  ${c ? '✅' : '❌'} ${l}${d ? ` — ${d}` : ''}`); if (!c) failures++ }

const rider = (): CharacterProfileDoc => ({
  _id: new ObjectId(), instance_id: iid, player_id: pid,
  canonical_name: 'the rider', name_normalized: 'the rider', aliases: [],
  identity_kind: 'role_label', identity_scope: 's5',
  role: 'outrider of House Thorne', appearance: 'scarred, grey-bearded',
  relationship: { trust: 58, affection: 50, fear: 0, rivalry: 4 },
  immutable_facts: ['clasped Michael’s forearm in a warrior’s grip'], mutable_state: [],
  disposition_to_player: 'wary respect', hidden_thought: '',
  mention_count: 3, first_seen_sequence: 5, last_seen_sequence: 5, is_protagonist: false,
  created_at: new Date(), updated_at: new Date(),
} as CharacterProfileDoc)

async function extract(o: any) {
  return extractCharacterCodexDeltas({
    existing: [], protagonistName: 'Michael Oliver', promotableRecurringPeople: [], ...o,
  })
}
const toExisting = (c: CharacterProfileDoc) => ({
  canonical_name: c.canonical_name, aliases: c.aliases, role: c.role, appearance: c.appearance,
  identity_kind: c.identity_kind,
  relationship: c.relationship, identity_scope: c.identity_scope,
  last_seen_sequence: c.last_seen_sequence, former_labels: c.former_labels, mutable_state: c.mutable_state,
  immutable_facts: c.immutable_facts,
})

// ── 1 · a STRANGER the prose also calls "the rider", 35 turns later ──────
console.log('\n=== 1 · a stranger sharing the label must not inherit the bond ===')
{
  const first = rider(); const state = newFoldState([first])
  const deltas = await extract({
    playerInput: 'I keep my hands where she can see them.',
    aiResponse: `*Three days north of Thorne, a rider blocks the ford. She is young, hooded, and the horse under her is Vane green. She has never seen Michael before in her life.*\n\n"Toll," *the rider says, and levels a crossbow at his chest.*`,
    existing: [toExisting(first)], presentCast: ['the rider'], sequence: 40,
  })
  for (const d of deltas) if (!d.is_protagonist) foldDelta(state, d, 40, { iid, pid, now: new Date() })
  ok('she minted her own card', state.created.size === 1, `created=${state.created.size}`)
  ok('his bond is untouched', JSON.stringify(first.relationship) === JSON.stringify({ trust: 58, affection: 50, fear: 0, rivalry: 4 }), JSON.stringify(first.relationship))
  ok('his appearance is untouched', first.appearance === 'scarred, grey-bearded', String(first.appearance))
  const she = [...state.created][0]
  ok('she carries her own scope', !!she?.identity_scope && she.identity_scope !== 's5', String(she?.identity_scope))
}

// ── 2 · the SAME rider, next turn ────────────────────────────────────────
console.log('\n=== 2 · the same rider on the next turn still merges ===')
{
  const first = rider(); const state = newFoldState([first])
  const deltas = await extract({
    playerInput: 'I sheathe the sword and offer him my hand in good faith.',
    aiResponse: `*Michael slides the blade back into its scabbard and extends his hand. The rider clasps his forearm in a warrior's grip.*\n\n"Honest steel is a rare thing," *he says.*`,
    existing: [toExisting(first)], presentCast: ['the rider'], sequence: 6,
  })
  for (const d of deltas) if (!d.is_protagonist) foldDelta(state, d, 6, { iid, pid, now: new Date() })
  ok('no duplicate card', state.created.size === 0, `created=${state.created.size}`)
  ok('the bond accrued on his card', (first.relationship?.trust ?? 0) >= 58, `trust=${first.relationship?.trust}`)
}

// ── 3 · he is finally named ──────────────────────────────────────────────
console.log('\n=== 3 · naming him keeps the card, the bond and the history ===')
let named: CharacterProfileDoc
{
  const first = rider(); const state = newFoldState([first])
  const deltas = await extract({
    playerInput: 'I ask him what his name is.',
    aiResponse: `*The rider weighs the question longer than it deserves.*\n\n"Aldric," *he says at last.* "Aldric Vane. You can use it, since you didn't draw on me twice."`,
    existing: [toExisting(first)], presentCast: ['the rider'], sequence: 7,
  })
  for (const d of deltas) if (!d.is_protagonist) foldDelta(state, d, 7, { iid, pid, now: new Date() })
  ok('same card, no duplicate', state.created.size === 0, `created=${state.created.size}`)
  ok('renamed to the proper name', first.canonical_name === 'Aldric Vane', first.canonical_name)
  ok('bond preserved', (first.relationship?.trust ?? 0) >= 58, `trust=${first.relationship?.trust}`)
  ok('history preserved', (first.immutable_facts || []).some((f) => f.includes('forearm')))
  ok('label released from aliases', !(first.aliases || []).includes('the rider'), JSON.stringify(first.aliases))
  ok('label kept for recall', (first.former_labels || []).includes('the rider'), JSON.stringify(first.former_labels))
  first.last_seen_sequence = 7
  named = first
}

// ── 4 · the player calls the NAMED man "rider" again ─────────────────────
console.log('\n=== 4 · "let\'s go, rider" still means Aldric ===')
{
  const state = newFoldState([named])
  const before = named.relationship?.trust
  const deltas = await extract({
    playerInput: "Let's go, rider.",
    aiResponse: `*Aldric tightens the girth strap and swings up into the saddle.*\n\n"Aye," *he says.* "Before the light goes."`,
    existing: [toExisting(named)], presentCast: ['Aldric Vane'], sequence: 8,
  })
  for (const d of deltas) if (!d.is_protagonist) foldDelta(state, d, 8, { iid, pid, now: new Date() })
  ok('no second card for the old label', state.created.size === 0, `created=${state.created.size}`)
  ok('still Aldric Vane', named.canonical_name === 'Aldric Vane', named.canonical_name)
  ok('bond continuous', (named.relationship?.trust ?? 0) >= (before ?? 0), `trust=${named.relationship?.trust}`)
}

console.log(`\n${failures === 0 ? '✅ ALL LIVE SCENARIOS PASS' : `❌ ${failures} FAILED`}`)
process.exit(failures === 0 ? 0 : 1)
