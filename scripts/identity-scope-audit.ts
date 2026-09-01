/**
 * Deterministic audit for LABEL-ONLY identity scoping.
 *
 * Two people the story knows only as "the rider" must be two cards with two
 * bonds — while every named character, and every card that predates the
 * identity_scope field, keeps resolving exactly as it did before.
 *
 *   bun run scripts/identity-scope-audit.ts
 */
import { ObjectId } from 'mongodb'
import { foldDelta, newFoldState, identityKey, type CharacterCodexDelta } from '../src/services/character-codex.service'
import { resolveIdentityScope, IDENTITY_SCOPE_STALE_TURNS } from '../worker/lib/character-codex-extractor'
import type { CharacterProfileDoc } from '../src/models/character-profile.model'

let failures = 0
function ok(label: string, cond: boolean, detail = '') {
  console.log(`  ${cond ? '✅' : '❌'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!cond) failures++
}
const iid = new ObjectId(); const pid = new ObjectId()
const ctx = () => ({ iid, pid, now: new Date() })
const card = (over: Partial<CharacterProfileDoc>): CharacterProfileDoc => ({
  _id: new ObjectId(), instance_id: iid, player_id: pid,
  canonical_name: '', name_normalized: '', aliases: [], immutable_facts: [], mutable_state: [],
  disposition_to_player: '', hidden_thought: '', mention_count: 1,
  first_seen_sequence: 1, last_seen_sequence: 1, is_protagonist: false,
  created_at: new Date(), updated_at: new Date(), ...over,
} as CharacterProfileDoc)
const delta = (o: Partial<CharacterCodexDelta>): CharacterCodexDelta =>
  ({ name: '', aliases: [], is_protagonist: false, ...o } as CharacterCodexDelta)

const PROSE = 'the rider dismounts and blocks the ford.'

console.log('=== the scope decision (extractor, pre-ledger) ===')
ok('a first sighting opens a new scope',
  resolveIdentityScope({ delta: delta({ name: 'the rider' }), sequence: 5, existing: [], prose: PROSE }) === 's5')
ok('a warm label stays the same person',
  resolveIdentityScope({
    delta: delta({ name: 'the rider' }), sequence: 7, prose: PROSE,
    existing: [{ canonical_name: 'the rider', identity_scope: 's5', last_seen_sequence: 6 }],
  }) === 's5')
ok('a COLD label is a different person',
  resolveIdentityScope({
    delta: delta({ name: 'the rider' }), sequence: 40, prose: PROSE,
    existing: [{ canonical_name: 'the rider', identity_scope: 's5', last_seen_sequence: 5 }],
  }) === 's40', `stale window = ${IDENTITY_SCOPE_STALE_TURNS} turns`)
ok('an explicit correction still wins over the clock',
  resolveIdentityScope({
    delta: delta({ name: 'the rider', resolved_name: 'the rider' }), sequence: 40, prose: PROSE,
    existing: [{ canonical_name: 'the rider', identity_scope: 's5', last_seen_sequence: 5 }],
  }) === 's5')
ok('a NAMED person is never scoped',
  resolveIdentityScope({ delta: delta({ name: 'Aldric Vane' }), sequence: 5, existing: [], prose: 'Aldric Vane rides up.' }) === undefined)

console.log('\n=== two riders, two cards, two bonds ===')
{
  const first = card({
    canonical_name: 'the rider', name_normalized: 'the rider', identity_kind: 'role_label',
    identity_scope: 's5', last_seen_sequence: 5,
    relationship: { trust: 58, affection: 50, fear: 0, rivalry: 4 },
  })
  const state = newFoldState([first])
  foldDelta(state, delta({
    name: 'the rider', identity_kind: 'role_label', identity_scope: 's40',
    appearance: 'young, hooded, Vane green',
    relationship_deltas: { fear: 6 }, relationship_evidence: { fear: 'levels a crossbow at his chest' },
  }), 40, ctx())
  ok('the second rider got his OWN card', state.created.size === 1, `created=${state.created.size}`)
  ok('the first rider keeps his bond untouched',
    JSON.stringify(first.relationship) === JSON.stringify({ trust: 58, affection: 50, fear: 0, rivalry: 4 }),
    JSON.stringify(first.relationship))
  ok('the first rider keeps his own appearance', !first.appearance)
  const second = [...state.created][0]
  ok('the second carries her own fear', second?.relationship?.fear === 6, JSON.stringify(second?.relationship))
  ok('both are displayed under the label the story used',
    first.canonical_name === 'the rider' && second?.canonical_name === 'the rider')
}

console.log('\n=== the same rider across consecutive turns still merges ===')
{
  const first = card({
    canonical_name: 'the rider', name_normalized: 'the rider', identity_kind: 'role_label',
    identity_scope: 's5', last_seen_sequence: 5, relationship: { trust: 58, affection: 50, fear: 0, rivalry: 4 },
  })
  const state = newFoldState([first])
  foldDelta(state, delta({
    name: 'the rider', identity_kind: 'role_label', identity_scope: 's5',
    relationship_deltas: { trust: 3 }, relationship_evidence: { trust: 'offers his hand in good faith' },
  }), 6, ctx())
  ok('no duplicate card', state.created.size === 0)
  ok('the bond accrued on the same card', first.relationship?.trust === 61, `trust=${first.relationship?.trust}`)
}

console.log('\n=== naming him releases the label ===')
{
  const first = card({
    canonical_name: 'the rider', name_normalized: 'the rider', identity_kind: 'role_label',
    identity_scope: 's5', last_seen_sequence: 6, relationship: { trust: 61, affection: 50, fear: 0, rivalry: 4 },
  })
  const state = newFoldState([first])
  foldDelta(state, delta({
    name: 'Aldric Vane', identity_kind: 'proper_name', resolved_name: 'the rider', aliases: ['the rider'],
  }), 7, ctx())
  ok('same card, renamed', state.created.size === 0 && first.canonical_name === 'Aldric Vane')
  ok('bond preserved through the rename', first.relationship?.trust === 61)
  ok('the scope is dropped — a name is its own identity', first.identity_scope === undefined)
  ok('the bare label is no longer a resolving alias', !(first.aliases || []).includes('the rider'), JSON.stringify(first.aliases))
  ok('but it is kept for display and recall', (first.former_labels || []).includes('the rider'), JSON.stringify(first.former_labels))

  // The scenario that used to corrupt Aldric: a stranger the prose calls "the rider".
  foldDelta(state, delta({
    name: 'the rider', identity_kind: 'role_label', identity_scope: 's44',
    relationship_deltas: { fear: 6 }, relationship_evidence: { fear: 'levels a crossbow at his chest' },
  }), 44, ctx())
  ok('a later rider does NOT land on Aldric', state.created.size === 1, `created=${state.created.size}`)
  ok("Aldric's bond is untouched", first.relationship?.trust === 61 && first.relationship?.fear === 0,
    JSON.stringify(first.relationship))
}

console.log('\n=== nothing changes for named people or legacy cards ===')
{
  const legacy = card({ canonical_name: 'Mira', name_normalized: 'mira', identity_kind: 'proper_name',
    relationship: { trust: 70, affection: 60, fear: 0, rivalry: 0 } })
  const state = newFoldState([legacy])
  foldDelta(state, delta({ name: 'Mira', relationship_deltas: { trust: 2 }, relationship_evidence: { trust: 'she smiles at the joke' } }), 9, ctx())
  ok('an unscoped delta finds the unscoped card', state.created.size === 0)
  ok('bond accrued normally', legacy.relationship?.trust === 72, `trust=${legacy.relationship?.trust}`)
  ok('identityKey of an unscoped name is just the name', identityKey('Mira') === 'mira')
}
{
  // A card minted before this field existed, still being played today.
  const legacyLabel = card({ canonical_name: 'the butler', name_normalized: 'the butler',
    identity_kind: 'role_label', last_seen_sequence: 30,
    relationship: { trust: 55, affection: 50, fear: 0, rivalry: 0 } })
  const state = newFoldState([legacyLabel])
  foldDelta(state, delta({ name: 'the butler', identity_kind: 'role_label', identity_scope: 's31',
    relationship_deltas: { trust: 2 }, relationship_evidence: { trust: 'he pours without being asked' } }), 31, ctx())
  ok('a legacy unscoped card is found by a scoped delta (no orphan)', state.created.size === 0, `created=${state.created.size}`)
  ok('and adopts the scope in place — that is the whole migration', legacyLabel.identity_scope === 's31')
  ok('its bond continued uninterrupted', legacyLabel.relationship?.trust === 57, `trust=${legacyLabel.relationship?.trust}`)
}

console.log(`\n${failures === 0 ? '✅ ALL INVARIANTS HELD' : `❌ ${failures} FAILED`}`)
process.exit(failures === 0 ? 0 : 1)
