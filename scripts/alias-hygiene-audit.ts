/**
 * A named person must not collect a bare TITLE as an alias.
 *
 * The prose addresses the protagonist as "ser" exactly as it addresses every
 * other knight, so storing "Ser" among his aliases makes every later lone "Ser"
 * resolve to him. The test is structural, not a list of honorifics: a word the
 * story itself writes in lowercase is a common noun, not a name — which covers
 * Ser, Archon, Kaptan and whatever the next world invents.
 *
 *   bun run scripts/alias-hygiene-audit.ts
 */
import { readsAsBareTitle } from '../worker/lib/character-codex-extractor'

let failures = 0
function ok(label: string, cond: boolean, detail = '') {
  console.log(`  ${cond ? '✅' : '❌'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!cond) failures++
}

/** The rule exactly as the extractor applies it to a proper-named card. */
function keepAlias(alias: string, prose: string): boolean {
  const t = alias.trim()
  if (!t) return false
  if (t.split(/\s+/).length > 1) return true
  return !readsAsBareTitle(t, prose)
}

const PROSE = `*The rider does not soften.* "The choice is still before you, ser. Ride with us now, or stand aside."

*Michael Oliver says nothing. Beside him Ser Roland shifts in the saddle, and the sergeant they call Gareth spits into the mud.*`

console.log('=== a bare title is dropped ===')
ok('"Ser" is not an alias — the prose lowercases it', !keepAlias('Ser', PROSE),
  'this is the exact alias that landed on the protagonist')
ok('"ser" likewise', !keepAlias('ser', PROSE))

console.log('\n=== real names are kept ===')
for (const n of ['Michael', 'Oliver', 'Roland', 'Gareth']) {
  ok(`"${n}" survives`, keepAlias(n, PROSE))
}
ok('a name the turn never mentions survives (no evidence either way)', keepAlias('Valemont', PROSE))

console.log('\n=== multi-word aliases are specific enough to keep ===')
ok('"Ser Roland" survives', keepAlias('Ser Roland', PROSE))
ok('"the grey-bearded rider" survives', keepAlias('the grey-bearded rider', PROSE))

console.log('\n=== it is the prose that decides, not a word list ===')
ok('a title the story CAPITALIZES is kept',
  keepAlias('Archon', '*The Archon inclines her head.*'), 'invented titles are not on any list')
ok('an invented lowercase honorific is dropped',
  !keepAlias('Kaptan', '*He bows.* "As you say, kaptan."'))

// ── the REPLAY half: a ledger row written before the guard existed ──────────
console.log('\n=== replay cannot resurrect a title from an old ledger row ===')
{
  const { ObjectId } = await import('mongodb')
  const { foldDelta, newFoldState } = await import('../src/services/character-codex.service')
  const iid = new ObjectId(); const pid = new ObjectId()
  const mk = (name: string, aliases: string[]) => ({
    _id: new ObjectId(), instance_id: iid, player_id: pid,
    canonical_name: name, name_normalized: name.toLowerCase(), aliases,
    identity_kind: 'proper_name', immutable_facts: [], mutable_state: [],
    disposition_to_player: '', hidden_thought: '', mention_count: 1,
    first_seen_sequence: 1, last_seen_sequence: 1, is_protagonist: false,
    created_at: new Date(), updated_at: new Date(),
  }) as any
  const hero = mk('Michael Oliver', ['Michael', 'Oliver', 'Ser'])
  const knight = mk('Ser Edric', ['Ser Edric'])
  const state = newFoldState([hero, knight])
  foldDelta(state, { name: 'Michael Oliver', aliases: ['Ser'], is_protagonist: false } as any,
    5, { iid, pid, now: new Date() })
  ok('the stored title is scrubbed on the next touch',
    !(hero.aliases || []).includes('Ser'), JSON.stringify(hero.aliases))
  ok('his real names survive',
    (hero.aliases || []).includes('Michael') && (hero.aliases || []).includes('Oliver'),
    JSON.stringify(hero.aliases))
  ok('the knight keeps his own full name', knight.canonical_name === 'Ser Edric')

  // A first name leads its owner's full name. Stripping it would be far worse
  // than the bug being fixed — a real dry run over 85 cards proposed exactly
  // this before the guard below existed.
  const elara = mk('Elara Thornwood', ['Elara', 'Elara Thornwood'])
  const brother = mk('Elara Thornwood the Younger', ['Elara Thornwood the Younger'])
  const s2 = newFoldState([elara, brother])
  foldDelta(s2, { name: 'Elara Thornwood', aliases: ['Elara'], is_protagonist: false } as any,
    6, { iid, pid, now: new Date() })
  ok('a first name is never mistaken for a title',
    (elara.aliases || []).includes('Elara'), JSON.stringify(elara.aliases))
}

console.log(`\n${failures === 0 ? '✅ ALL INVARIANTS HELD' : `❌ ${failures} FAILED`}`)
process.exit(failures === 0 ? 0 : 1)
