/**
 * ONE PERSON, TWO ROWS.
 *
 * The memory curator mints an ACTIVE character row the first time it uses a
 * name as a subject, with no card link, keyed on the bare name. At that moment
 * the codex card for the same man may still be carrying an earlier label ("the
 * second guard"), so nothing matches and a second row is born.
 *
 * When the card later renames onto that name the two rows collide — and the
 * occupant lookup only checked the CARD's identity scope, while the memory row
 * carries none. Mongo's unique index treats missing as null, so both survived
 * under the same name. The stub-merge pass that would otherwise heal this only
 * touches rows whose status IS a stub, and this one is active.
 *
 * Live: two Roland rows on one save, his 33 mentions split 10/2, so recall saw
 * two men where the codex showed one card.
 *
 * Needs a scratch mongod; MONGODB_URI must point at one.
 *   mongod --dbpath /tmp/x --port 27021 --fork --logpath /tmp/x/log
 *   MONGODB_URI=mongodb://127.0.0.1:27021/idsplit bun run scripts/identity-split-check.ts
 */
import { ObjectId } from 'mongodb'
import { connectMongo, coll } from '../src/config/mongo'
import { entityGraphService } from '../src/services/entity-graph.service'

let pass = 0
let fail = 0
const check = (label: string, got: unknown, want: unknown) => {
  if (JSON.stringify(got) === JSON.stringify(want)) { pass++; console.log(`  ok   ${label}`) }
  else { fail++; console.log(`  FAIL ${label}\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`) }
}

async function main() {
  await connectMongo()
  const iid = new ObjectId()
  const pid = new ObjectId()
  const cardId = new ObjectId()
  const now = new Date()

  // The card, minted at turn 45 under a descriptive label, scoped.
  await coll('characters').insertOne({
    _id: cardId, instance_id: iid, player_id: pid,
    canonical_name: 'Roland', name_normalized: 'roland', identity_scope: 's45',
    aliases: ['the second guard'], is_protagonist: false,
    first_seen_sequence: 45, last_seen_sequence: 84, mention_count: 12,
    created_at: now, updated_at: now,
  } as never)
  // Its entity row, still under the old label.
  const oldRow = {
    _id: new ObjectId(), instance_id: iid, player_id: pid, type: 'character',
    canonical_name: 'the second guard', name_normalized: 'the second guard',
    identity_scope: 's45', aliases: [], name_tokens: ['second', 'guard'],
    character_id: cardId, status: 'active',
    first_seen_sequence: 45, last_seen_sequence: 55, mention_count: 2,
    created_at: now, updated_at: now,
  }
  // The row the MEMORY path minted at turn 56, when the curator first used the
  // subject "Roland". `resolveOrCreateEntities` writes status 'active' with no
  // character_id and keys only on the bare name, so it neither found the card's
  // row (still called "the second guard") nor left anything the stub-merge pass
  // would later clean up — that pass only touches rows whose status IS a stub.
  const stub = {
    _id: new ObjectId(), instance_id: iid, player_id: pid, type: 'character',
    canonical_name: 'Roland', name_normalized: 'roland',
    aliases: [], name_tokens: ['roland'], status: 'active',
    first_seen_sequence: 56, last_seen_sequence: 84, mention_count: 10,
    created_at: now, updated_at: now,
  }
  await coll('entities').insertMany([oldRow, stub] as never[])

  const cards = await coll('characters').find({ instance_id: iid }).toArray()
  await entityGraphService.syncCodexEntities({
    instanceId: String(iid), playerId: String(pid), cards: cards as never, sequence: 84,
  })

  const rows = await coll('entities').find({ instance_id: iid, name_normalized: 'roland' }).toArray()
  console.log('\na scoped card renaming onto an unscoped stub:')
  check('one row survives, not two', rows.length, 1)
  check('...and it is the card’s row', String((rows[0] as any)?.character_id), String(cardId))
  check('...carrying the stub’s sightings', (rows[0] as any)?.mention_count >= 10, true)
  check('the old label is gone', (await coll('entities').countDocuments({ instance_id: iid, name_normalized: 'the second guard' })), 0)

  await coll('entities').deleteMany({ instance_id: iid })
  await coll('characters').deleteMany({ instance_id: iid })
  console.log(`\nidentity split check: ${pass} passed, ${fail} failed`)
  process.exit(fail === 0 ? 0 : 1)
}
main().catch((e) => { console.error(e); process.exit(1) })
