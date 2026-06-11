/**
 * Memory version graph (Phase 2) audit — Tier 1 (deterministic server math on a
 * throwaway instance; no LLM, no Pinecone). Exercises the `repair_memory_links`
 * maintenance task, which is the deterministic core shared with the live path:
 *   (1) reconcile — a backward `superseded_by_event_ids` mark materializes the
 *       forward `updates_memory_ids` on the event's new correcting atom (this is
 *       the race-closing reconcile the curator also does inline);
 *   (2) prune dangling forward links to removed atoms;
 *   (3) prune backward marks pointing at removed events.
 *
 * The supersession backward-mark write + the rewind/recurate prune are covered
 * LIVE (Tier 2) — they need real embeddings / a full instance. See
 * LIVE_VERIFICATION.md.
 *
 *   bun run scripts/memory-links-audit.ts   (alias: bun run audit:memory-links)
 */
import { ObjectId } from 'mongodb'
import { connectMongo, coll } from '../src/config/mongo'
import { maintenanceProcessor } from '../worker/processors/maintenance.processor'
import { idString } from '../src/utils/mongo-id'

let passed = 0
let failed = 0
function check(label: string, cond: boolean) {
  if (cond) { passed++; console.log(`  ✓ ${label}`) }
  else { failed++; console.error(`  ✗ ${label}`) }
}

const runRepair = (instanceId: string) =>
  maintenanceProcessor({ data: { task: 'repair_memory_links', instanceId } } as never)

async function main() {
  await connectMongo()
  const iid = new ObjectId()
  const pid = new ObjectId()
  const eventA = new ObjectId() // the supersession trigger (alive)
  const deadEvent = new ObjectId() // never inserted
  const now = new Date()

  const mem = (over: Record<string, unknown>) => ({
    _id: new ObjectId(),
    instance_id: iid,
    player_id: pid,
    text: 'x',
    type: 'fact',
    importance: 3,
    is_nsfw: false,
    source_event_ids: [],
    access_count: 0,
    last_accessed_at: now,
    is_archived: false,
    status: 'active',
    created_at: now,
    updated_at: now,
    ...over,
  })

  // A live event the reconcile can attribute to.
  await coll('events').insertOne({ _id: eventA, instance_id: iid, sequence: 10 } as never)

  // oldAtom: superseded by eventA (backward mark present, NO forward link yet).
  const oldAtom = mem({
    text: 'Mira is engaged to Lord X.',
    is_archived: true,
    status: 'superseded',
    superseded_by_event_ids: [eventA],
  })
  // newAtom: the correcting atom from eventA — should receive the forward link.
  const newAtom = mem({
    text: 'Mira broke the engagement to Lord X.',
    source_event_ids: [eventA],
  })
  // danglingAtom: forward-links a memory id that does NOT exist → must be pruned.
  const ghostId = new ObjectId()
  const danglingAtom = mem({
    text: 'derived inference',
    updates_memory_ids: [ghostId],
    extends_memory_ids: [ghostId],
  })
  // staleMarkAtom: superseded by an event that does NOT exist → mark pruned.
  const staleMarkAtom = mem({
    text: 'old fact',
    is_archived: true,
    status: 'superseded',
    superseded_by_event_ids: [deadEvent],
  })

  await coll('memories').insertMany([oldAtom, newAtom, danglingAtom, staleMarkAtom] as never)

  console.log('repair_memory_links — reconcile + prune:')
  const r1 = (await runRepair(idString(iid))) as { reconciled: number; prunedLinks: number; prunedMarks: number }

  const newAfter: any = await coll('memories').findOne({ _id: newAtom._id })
  check(
    'reconcile: new atom gains forward updates_memory_ids → old atom',
    (newAfter.updates_memory_ids || []).some((id: ObjectId) => idString(id) === idString(oldAtom._id)),
  )
  check('reconcile count ≥ 1', r1.reconciled >= 1)

  const dangAfter: any = await coll('memories').findOne({ _id: danglingAtom._id })
  check(
    'prune: dangling updates link removed',
    !(dangAfter.updates_memory_ids || []).some((id: ObjectId) => idString(id) === idString(ghostId)),
  )
  check(
    'prune: dangling extends link removed',
    !(dangAfter.extends_memory_ids || []).some((id: ObjectId) => idString(id) === idString(ghostId)),
  )
  check('prunedLinks count ≥ 1', r1.prunedLinks >= 1)

  const staleAfter: any = await coll('memories').findOne({ _id: staleMarkAtom._id })
  check(
    'prune: backward mark to removed event dropped',
    !(staleAfter.superseded_by_event_ids || []).some((id: ObjectId) => idString(id) === idString(deadEvent)),
  )
  check('prunedMarks count ≥ 1', r1.prunedMarks >= 1)

  // Idempotency: a second run is a no-op (reconcile uses addToSet; nothing new).
  console.log('idempotency — second run is a no-op:')
  const r2 = (await runRepair(idString(iid))) as { prunedLinks: number; prunedMarks: number }
  check('second run prunes nothing more', r2.prunedLinks === 0 && r2.prunedMarks === 0)
  const newAfter2: any = await coll('memories').findOne({ _id: newAtom._id })
  check(
    'second run keeps a single forward link (no duplication)',
    (newAfter2.updates_memory_ids || []).filter((id: ObjectId) => idString(id) === idString(oldAtom._id)).length === 1,
  )

  // Cleanup — leave no trace (throwaway instance).
  await coll('memories').deleteMany({ instance_id: iid })
  await coll('events').deleteMany({ instance_id: iid })

  console.log(`\n${failed === 0 ? 'ALL GREEN' : 'FAILURES'} — passed ${passed}, failed ${failed}`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((e) => { console.error(e); process.exit(2) })
