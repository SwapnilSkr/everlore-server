/**
 * Deterministic audit for the UNNAMED → NAMED promotion of a codex card.
 *
 * The product promise this pins: a character the story tracked for turns before
 * ever naming them keeps EVERYTHING when the name finally lands — the same card,
 * the same four bond meters, the same history, the same entity id underneath (so
 * memories and kinship edges keep resolving). A rename must never read as a new
 * person meeting the player for the first time.
 *
 *   bun run scripts/identity-promotion-audit.ts
 */
import { ObjectId } from 'mongodb'
import { foldDelta, newFoldState, type CharacterCodexDelta } from '../src/services/character-codex.service'
import type { CharacterProfileDoc } from '../src/models/character-profile.model'

let failures = 0
function ok(label: string, cond: boolean, detail = '') {
  console.log(`  ${cond ? '✅' : '❌'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!cond) failures++
}

const iid = new ObjectId()
const pid = new ObjectId()
const cardId = new ObjectId()
const entityId = new ObjectId()

/** The card as it stands after three unnamed turns of real interaction. */
const card: CharacterProfileDoc = {
  _id: cardId,
  instance_id: iid,
  player_id: pid,
  entity_id: entityId,
  canonical_name: 'the rider',
  name_normalized: 'the rider',
  aliases: ['grey-bearded rider'],
  identity_kind: 'role_label',
  role: 'outrider of House Thorne',
  appearance: 'scarred, grey-bearded',
  relationship: { trust: 58, affection: 50, fear: 0, rivalry: 4 },
  relationship_moments: [{ meter: 'trust', delta: 8, sequence: 3 }],
  immutable_facts: ['clasped Michael’s forearm in a warrior’s grip at the gates'],
  mutable_state: ['escorting Michael toward House Thorne'],
  mention_count: 3,
  first_seen_sequence: 1,
  last_seen_sequence: 3,
  is_protagonist: false,
  created_at: new Date(),
  updated_at: new Date(),
} as CharacterProfileDoc

// The shape the live extractor really returns when the player asks his name and
// the prose answers "Aldric Vane" (verified against the model, not invented).
const rename = {
  name: 'Aldric Vane',
  identity_kind: 'proper_name',
  resolved_name: 'the rider',
  aliases: ['the rider', 'grey-bearded rider'],
  is_protagonist: false,
  relationship_deltas: { trust: 3 },
  relationship_evidence: { trust: 'You can use it, since you didn’t draw on me twice.' },
} as unknown as CharacterCodexDelta

const state = newFoldState([card])
foldDelta(state, rename, 4, { iid, pid, now: new Date() })

console.log('=== the name lands on the SAME card ===')
ok('no second card was created', state.created.size === 0, `created=${state.created.size}`)
ok('the existing card was updated', state.dirty.has(card))
ok('same card _id', card._id.equals(cardId))
ok('same entity_id (memories + kinship edges still resolve)', !!card.entity_id?.equals(entityId))
ok('canonical name is now the proper name', card.canonical_name === 'Aldric Vane', card.canonical_name)
ok('identity_kind promoted to proper_name', card.identity_kind === 'proper_name', String(card.identity_kind))
ok('the old label is released as a resolving alias', !(card.aliases || []).includes('the rider'), JSON.stringify(card.aliases))
ok('and kept for display and recall', (card.former_labels || []).includes('the rider'), JSON.stringify(card.former_labels))

console.log('\n=== the bond survives the rename ===')
const r = card.relationship!
ok('trust carried over and moved by this turn only', r.trust === 61, `trust=${r.trust} (58 + 3)`)
ok('affection untouched', r.affection === 50, `affection=${r.affection}`)
ok('fear untouched', r.fear === 0, `fear=${r.fear}`)
ok('rivalry untouched', r.rivalry === 4, `rivalry=${r.rivalry}`)
ok('the earlier bond moment is still in history', (card.relationship_moments || []).some((m) => m.sequence === 3 && m.delta === 8))
ok('permanent history kept', (card.immutable_facts || []).some((f) => f.includes('forearm')))
ok('current state kept', (card.mutable_state || []).some((s) => s.includes('House Thorne')))

console.log('\n=== a later mention can never demote the name back to a label ===')
foldDelta(state, {
  name: 'the rider', identity_kind: 'role_label', is_protagonist: false,
} as unknown as CharacterCodexDelta, 5, { iid, pid, now: new Date() })
ok('still Aldric Vane', card.canonical_name === 'Aldric Vane', card.canonical_name)
ok('still proper_name', card.identity_kind === 'proper_name', String(card.identity_kind))
// A bare label is no longer OWNED by a named person — that is what stops a
// stranger inheriting his bond. Continuity still routes the player's own use of
// the word back to him; that is settled in the extractor (resolveFormerLabelHolder)
// and covered by the identity-scope audit, not here.
ok('an unowned label no longer lands on the named card', state.created.size === 1, `created=${state.created.size}`)
ok("his bond is untouched by it", card.relationship?.trust === 61, `trust=${card.relationship?.trust}`)

console.log(`\n${failures === 0 ? '✅ ALL INVARIANTS HELD' : `❌ ${failures} FAILED`}`)
process.exit(failures === 0 ? 0 : 1)
