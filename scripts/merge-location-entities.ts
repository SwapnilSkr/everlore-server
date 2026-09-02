/**
 * Merge duplicate LOCATION entities into a canonical one (location fragmentation
 * repair — e.g. a vague "the room" minted alongside "dining room", or an
 * article-variant "the mansion" alongside "mansion"). The sibling of
 * merge-character-cards.ts, but for places, which have no separate card — the
 * entity IS the record. Folds the dupe's aliases/mentions/facts/state into KEEP,
 * re-points memory + edge references, rewrites stored event location_anchors and
 * travel labels, repoints the instance cursor if it sat on a dupe, then deletes
 * the dupe entity. Idempotent-ish; prints before/after.
 *
 *   bun run scripts/merge-location-entities.ts <instanceId> "<keepName>" "<dupeName>" ["<dupe2>" ...]
 */
import { ObjectId } from 'mongodb'
import { connectMongo, coll } from '../src/config/mongo'
import { isVagueLocationLabel } from '../src/services/entity-graph.service'

const [INSTANCE, KEEP, ...DUPES] = process.argv.slice(2)
if (!INSTANCE || !KEEP || DUPES.length === 0) {
  console.error('usage: bun run scripts/merge-location-entities.ts <instanceId> "<keepName>" "<dupeName>" ["<dupe2>" ...]')
  process.exit(1)
}
const norm = (s: string) => (s || '').toLowerCase().replace(/\s+/g, ' ').trim()
const uniq = (xs: string[]) => {
  const seen = new Set<string>(), out: string[] = []
  for (const x of xs) { const k = (x || '').trim(); if (k && !seen.has(k.toLowerCase())) { seen.add(k.toLowerCase()); out.push(k) } }
  return out
}

/**
 * Accepts a NAME or an entity _id. The id form exists because the worst
 * duplicates share a normalized name and differ only by parent — a name lookup
 * cannot tell them apart, and `findOne` would return the same document twice.
 */
async function findLoc(iid: ObjectId, nameOrId: string) {
  if (/^[0-9a-f]{24}$/i.test(nameOrId)) {
    return coll('entities').findOne({
      _id: ObjectId.createFromHexString(nameOrId),
      instance_id: iid,
      type: 'location',
    }) as any
  }
  return coll('entities').findOne({ instance_id: iid, type: 'location', name_normalized: norm(nameOrId) }) as any
}

async function main() {
  await connectMongo()
  const iid = ObjectId.createFromHexString(INSTANCE)
  const keep: any = await findLoc(iid, KEEP)
  if (!keep) throw new Error(`keep location "${KEEP}" not found`)

  console.log(`KEEP: "${keep.canonical_name}" mentions=${keep.mention_count} aliases=${JSON.stringify(keep.aliases)} _id=${keep._id}`)

  for (const dupeName of DUPES) {
    const dupe: any = await findLoc(iid, dupeName)
    if (!dupe) { console.log(`  dupe "${dupeName}" not present — skipping.`); continue }
    if (String(dupe._id) === String(keep._id)) { console.log(`  "${dupeName}" IS keep — skipping.`); continue }
    const de = dupe._id, ke = keep._id

    // 1. Fold entity fields into keep. A generic/relative dupe name ("the room",
    // "outside") is too vague to be a safe alias — it would wrongly collapse any
    // future "the room" (a different bedroom) into this place. Drop vague aliases.
    keep.aliases = uniq([...(keep.aliases || []), ...(dupe.aliases || []), dupe.canonical_name])
      .filter((a) => !isVagueLocationLabel(a))
      .slice(0, 30)
    keep.location_facts = [...(keep.location_facts || []), ...(dupe.location_facts || [])].slice(-12)
    keep.location_state = [...(keep.location_state || []), ...(dupe.location_state || [])].slice(-12)
    keep.mention_count = (keep.mention_count || 0) + (dupe.mention_count || 0)
    keep.first_seen_sequence = Math.min(keep.first_seen_sequence ?? 0, dupe.first_seen_sequence ?? 0)
    keep.last_seen_sequence = Math.max(keep.last_seen_sequence ?? 0, dupe.last_seen_sequence ?? 0)
    await coll('entities').updateOne({ _id: ke }, { $set: {
      aliases: keep.aliases, location_facts: keep.location_facts, location_state: keep.location_state,
      mention_count: keep.mention_count, first_seen_sequence: keep.first_seen_sequence,
      last_seen_sequence: keep.last_seen_sequence, updated_at: new Date(),
    } })

    // 2. Re-point memory entity refs (add keep, drop dupe — two updates each, Mongo conflict).
    let mem = 0
    for (const field of ['subject_entity_ids', 'object_entity_ids'] as const) {
      const r = await coll('memories').updateMany({ instance_id: iid, [field]: de }, { $addToSet: { [field]: ke } })
      await coll('memories').updateMany({ instance_id: iid, [field]: de }, { $pull: { [field]: de } })
      mem += r.modifiedCount || 0
    }
    // 2b. Re-point the memory PLACE anchor (location_entity_id / location_anchor /
    // location_name) — the place-scoped recall fields. Missing this strands the
    // dupe's memories on a deleted entity (a ghost place in the atlas).
    const placeAnchor = await coll('memories').updateMany(
      { instance_id: iid, $or: [{ location_entity_id: de }, { 'location_anchor.entity_id': de }] },
      {
        $set: {
          location_entity_id: ke,
          location_name: keep.canonical_name,
          'location_anchor.entity_id': ke,
          'location_anchor.name': keep.canonical_name,
          'location_anchor.name_normalized': keep.name_normalized,
        },
      },
    )
    mem += placeAnchor.modifiedCount || 0

    // 3. Re-point entity edges per-edge, dropping collisions (keep's edge wins).
    let edges = 0
    for (const field of ['source_entity_id', 'target_entity_id'] as const) {
      const es = await coll('entity_edges').find({ instance_id: iid, [field]: de }).toArray()
      for (const edge of es as any[]) {
        try { await coll('entity_edges').updateOne({ _id: edge._id }, { $set: { [field]: ke } }); edges++ }
        catch (err: any) { if (err?.code === 11000) await coll('entity_edges').deleteOne({ _id: edge._id }); else throw err }
      }
    }

    // 4. Rewrite stored event location_anchors + travel labels.
    const anchor = { entity_id: ke, name: keep.canonical_name, name_normalized: keep.name_normalized }
    const ev = await coll('events').updateMany(
      { instance_id: iid, 'location_anchor.entity_id': de },
      { $set: { location_anchor: anchor } },
    )
    // Travel labels are denormalized name strings — rewrite from/to that match the dupe.
    let travel = 0
    const travelEvents = await coll('events').find({ instance_id: iid, type: 'travel' }).toArray()
    for (const t of travelEvents as any[]) {
      const tv = t.data?.travel
      if (!tv) continue
      const set: Record<string, string> = {}
      if (norm(tv.from) === norm(dupe.canonical_name)) set['data.travel.from'] = keep.canonical_name
      if (norm(tv.to) === norm(dupe.canonical_name)) set['data.travel.to'] = keep.canonical_name
      if (Object.keys(set).length) { await coll('events').updateOne({ _id: t._id }, { $set: set }); travel++ }
    }

    // 5. Repoint the instance cursor if it sat on the dupe.
    const inst: any = await coll('world_instances').findOne({ _id: iid })
    let cursorMoved = false
    if (inst?.current_location && String(inst.current_location.entity_id) === String(de)) {
      await coll('world_instances').updateOne({ _id: iid }, { $set: { current_location: anchor } })
      cursorMoved = true
    }

    // 6. Delete the dupe entity.
    await coll('entities').deleteOne({ _id: de })
    console.log(`  merged "${dupe.canonical_name}" → "${keep.canonical_name}": memories=${mem} edges=${edges} eventAnchors=${ev.modifiedCount} travelLabels=${travel} cursor=${cursorMoved ? 'repointed' : 'unchanged'}`)
  }

  const after: any = await coll('entities').findOne({ _id: keep._id })
  console.log(`\nAFTER → "${after.canonical_name}" mentions=${after.mention_count} aliases=${JSON.stringify(after.aliases)} facts=${(after.location_facts||[]).length} state=${(after.location_state||[]).length}`)
  process.exit(0)
}
main().catch((e) => { console.error(e); process.exit(2) })
