/**
 * One-off P1 backfill: give the dev instance's existing flat locations a
 * containment spine (parent_id / place_kind; world_root_id stays null = the
 * single implicit world). Mansion is the building; its rooms hang under it; the
 * street is exterior (parent unknown until the story names the neighbourhood).
 *   bun run scripts/backfill-instance-locations.ts [instanceId]
 */
import { connectMongo, coll } from '../src/config/mongo'
import { ObjectId } from 'mongodb'

const IID = process.argv[2] || '6a2869768f7446e38bdb6fce'

// canonical_name (normalized lower) → { parent canonical | null, place_kind }
const PLAN: Record<string, { parent: string | null; kind: string }> = {
  'mansion': { parent: null, kind: 'building' },
  'dining room': { parent: 'mansion', kind: 'room' },
  'great room': { parent: 'mansion', kind: 'room' },
  'foyer': { parent: 'mansion', kind: 'room' },
  'hallway': { parent: 'mansion', kind: 'area' },
  'corridors': { parent: 'mansion', kind: 'area' },
  'garden': { parent: 'mansion', kind: 'area' }, // estate grounds
  'street': { parent: null, kind: 'area' },       // exterior; neighbourhood not yet known
}

async function main() {
  await connectMongo()
  const iid = new ObjectId(IID)
  const locs = await coll('entities').find({ instance_id: iid, type: 'location' }).toArray()
  const byNorm = new Map(locs.map((l: any) => [l.name_normalized, l]))

  for (const [norm, plan] of Object.entries(PLAN)) {
    const ent: any = byNorm.get(norm)
    if (!ent) { console.log(`  (skip) "${norm}" not present`); continue }
    const parentEnt: any = plan.parent ? byNorm.get(plan.parent) : null
    if (plan.parent && !parentEnt) { console.log(`  (warn) parent "${plan.parent}" for "${norm}" not found`); }
    await coll('entities').updateOne(
      { _id: ent._id },
      { $set: { parent_id: parentEnt?._id ?? null, world_root_id: null, place_kind: plan.kind, updated_at: new Date() } },
    )
    console.log(`  "${ent.canonical_name}" → parent=${parentEnt?.canonical_name ?? '(none)'} kind=${plan.kind}`)
  }

  // Report the resulting tree.
  console.log('\nResulting spine:')
  const after = await coll('entities').find({ instance_id: iid, type: 'location' }).toArray()
  const byId = new Map(after.map((l: any) => [String(l._id), l]))
  for (const l of after as any[]) {
    const parent = l.parent_id ? byId.get(String(l.parent_id))?.canonical_name : '(root)'
    console.log(`  ${l.canonical_name} [${l.place_kind || '?'}] ⊂ ${parent}`)
  }
  process.exit(0)
}
main().catch((e) => { console.error(e); process.exit(1) })
