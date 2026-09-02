/**
 * Repair duplicate LOCATION entities that share a normalized name.
 *
 * These are not article variants — `merge-location-entities.ts` already handles
 * those. They are the SAME normalized name minted twice at different parents,
 * because the unique index is
 * `(instance_id, type, world_root_id, parent_id, name_normalized, identity_scope)`
 * and `parent_id` is part of the key. On a live world this produced "the hall"
 * as a CHILD OF "the hall" — a place inside itself — plus a second "root
 * cellars" hanging off the first hall.
 *
 * Keep is the earliest-seen row (the real one); everything else folds into it.
 * Read-only unless --apply is passed.
 *
 *   bun run scripts/repair-duplicate-places.ts <instanceId> [--apply]
 */
import { ObjectId } from 'mongodb'
import { connectMongo, coll } from '../src/config/mongo'

const [INSTANCE, ...flags] = process.argv.slice(2)
const APPLY = flags.includes('--apply')
if (!INSTANCE) {
  console.error('usage: bun run scripts/repair-duplicate-places.ts <instanceId> [--apply]')
  process.exit(1)
}

await connectMongo()
const iid = ObjectId.createFromHexString(INSTANCE)
const places = (await coll('entities').find({ instance_id: iid, type: 'location' }).toArray()) as any[]

const byName = new Map<string, any[]>()
for (const place of places) {
  const key = String(place.name_normalized || '')
  if (!key) continue
  byName.set(key, [...(byName.get(key) || []), place])
}

// A place that is its own ancestor is always wrong, duplicate or not.
const selfParented = places.filter((p) => p.parent_id && String(p.parent_id) === String(p._id))

const groups = [...byName.entries()].filter(([, rows]) => rows.length > 1)
if (!groups.length && !selfParented.length) {
  console.log('no duplicate or self-parented places')
  process.exit(0)
}

for (const [name, rows] of groups) {
  const sorted = [...rows].sort(
    (a, b) =>
      (a.first_seen_sequence ?? 0) - (b.first_seen_sequence ?? 0) ||
      (b.mention_count ?? 0) - (a.mention_count ?? 0),
  )
  const [keep, ...dupes] = sorted
  console.log(`\n"${name}" — ${rows.length} rows`)
  console.log(`  KEEP  ${String(keep._id)}  seq ${keep.first_seen_sequence}-${keep.last_seen_sequence}  mentions=${keep.mention_count}  parent=${keep.parent_id ? String(keep.parent_id) : 'null'}`)
  for (const dupe of dupes) {
    const selfChild = String(dupe.parent_id || '') === String(keep._id)
    console.log(
      `  DUPE  ${String(dupe._id)}  seq ${dupe.first_seen_sequence}-${dupe.last_seen_sequence}  mentions=${dupe.mention_count}` +
        `  parent=${dupe.parent_id ? String(dupe.parent_id) : 'null'}${selfChild ? '  ← a child of KEEP: the place is inside itself' : ''}`,
    )
    if (APPLY) {
      const proc = Bun.spawn(
        ['bun', 'run', 'scripts/merge-location-entities.ts', INSTANCE, String(keep._id), String(dupe._id)],
        { stdout: 'inherit', stderr: 'inherit', stdin: 'ignore' },
      )
      const code = await proc.exited
      if (code !== 0) console.log(`    merge FAILED (exit ${code})`)
    }
  }
}

for (const place of selfParented) {
  console.log(`\nself-parented: "${place.canonical_name}" ${String(place._id)}`)
  if (APPLY) {
    await coll('entities').updateOne({ _id: place._id }, { $set: { parent_id: null, updated_at: new Date() } })
    console.log('  parent cleared')
  }
}

console.log(APPLY ? '\napplied' : '\ndry run — pass --apply to write')
process.exit(0)
