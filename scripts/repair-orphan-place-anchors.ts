/**
 * Repair memories whose place anchor (location_entity_id / location_anchor)
 * points at a location entity that no longer exists — e.g. merged away before the
 * merge tool re-pointed memory anchors. Each orphan is re-resolved by its
 * location_name against surviving location entities (canonical OR alias).
 *   bun run scripts/repair-orphan-place-anchors.ts [instanceId]
 */
import { connectMongo, coll } from '../src/config/mongo'
import { ObjectId } from 'mongodb'
const norm = (s: string) => (s || '').toLowerCase().replace(/[^a-z0-9\s'-]+/g, '').replace(/\s+/g, ' ').trim()
async function main() {
  await connectMongo()
  const iid = new ObjectId(process.argv[2] || '6a2869768f7446e38bdb6fce')
  const locs = await coll('entities').find({ instance_id: iid, type: 'location' }).toArray()
  const liveIds = new Set(locs.map((l: any) => String(l._id)))
  const byName = new Map<string, any>()
  for (const l of locs as any[]) {
    byName.set(norm(l.canonical_name), l)
    for (const a of l.aliases || []) byName.set(norm(a), l)
  }
  const mems = await coll('memories').find({ instance_id: iid, location_entity_id: { $ne: null } }).toArray()
  let fixed = 0, unresolved = 0
  for (const m of mems as any[]) {
    if (liveIds.has(String(m.location_entity_id))) continue // anchor still valid
    const keep = byName.get(norm(m.location_name || ''))
    if (!keep) { unresolved++; console.log(`  (unresolved) "${m.location_name}" — no live place matches`); continue }
    await coll('memories').updateOne({ _id: m._id }, { $set: {
      location_entity_id: keep._id, location_name: keep.canonical_name,
      'location_anchor.entity_id': keep._id, 'location_anchor.name': keep.canonical_name,
      'location_anchor.name_normalized': keep.name_normalized,
    } })
    fixed++
  }
  console.log(`\nre-pointed ${fixed} orphaned memory place-anchor(s); ${unresolved} unresolved.`)
  process.exit(0)
}
main().catch(e => { console.error(e); process.exit(1) })
