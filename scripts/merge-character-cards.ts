/**
 * Merge a duplicate character card into the canonical one (codex fragmentation
 * repair — e.g. a stray "Sister" minted alongside "Twin Sister"). Folds the
 * dupe's aliases/mentions/facts/meters into KEEP, re-points the dupe ENTITY's
 * memory + edge references to KEEP's entity, registers the dupe's name as an
 * alias, then deletes the dupe card + entity. Idempotent-ish; prints before/after.
 *
 *   bun run scripts/merge-character-cards.ts <instanceId> "<keepName>" "<dupeName>"
 */
import { ObjectId } from 'mongodb'
import { connectMongo, mongoColl } from '../src/config/mongo'

const [INSTANCE, KEEP, DUPE] = [process.argv[2], process.argv[3], process.argv[4]]
if (!INSTANCE || !KEEP || !DUPE) {
  console.error('usage: bun run scripts/merge-character-cards.ts <instanceId> "<keepName>" "<dupeName>"')
  process.exit(1)
}
const uniq = (xs: string[]) => {
  const seen = new Set<string>(), out: string[] = []
  for (const x of xs) { const k = (x || '').trim(); if (k && !seen.has(k.toLowerCase())) { seen.add(k.toLowerCase()); out.push(k) } }
  return out
}

async function main() {
  await connectMongo()
  const iid = ObjectId.createFromHexString(INSTANCE)
  const keep: any = await mongoColl.characters().findOne({ instance_id: iid, canonical_name: KEEP })
  const dupe: any = await mongoColl.characters().findOne({ instance_id: iid, canonical_name: DUPE })
  if (!keep) throw new Error(`keep card "${KEEP}" not found`)
  if (!dupe) { console.log(`dupe "${DUPE}" not present — nothing to do.`); process.exit(0) }
  if (String(keep._id) === String(dupe._id)) throw new Error('keep and dupe are the same card')
  if (dupe.is_protagonist) throw new Error('refusing to delete a protagonist card as the dupe')

  console.log('BEFORE:')
  console.log(`  keep "${keep.canonical_name}" mentions=${keep.mention_count} aliases=${JSON.stringify(keep.aliases)} entity=${keep.entity_id}`)
  console.log(`  dupe "${dupe.canonical_name}" mentions=${dupe.mention_count} aliases=${JSON.stringify(dupe.aliases)} entity=${dupe.entity_id}`)

  // 1. Fold the card fields. Idempotent: if the dupe's name is already a keep
  // alias, a prior run already folded these — don't re-add mention_count.
  const alreadyFolded = (keep.aliases || []).some(
    (a: string) => a.trim().toLowerCase() === dupe.canonical_name.trim().toLowerCase(),
  )
  const mergedAliases = uniq([...(keep.aliases || []), ...(dupe.aliases || []), dupe.canonical_name]).slice(0, 20)
  const mergedImmutable = uniq([...(keep.immutable_facts || []), ...(dupe.immutable_facts || [])])
  const mergedMutable = uniq([...(keep.mutable_state || []), ...(dupe.mutable_state || [])])
  const meters = { ...(dupe.relationship || {}), ...(keep.relationship || {}) } // keep's values win
  await mongoColl.characters().updateOne(
    { _id: keep._id },
    { $set: {
      aliases: mergedAliases,
      immutable_facts: mergedImmutable,
      mutable_state: mergedMutable,
      mention_count: (keep.mention_count || 0) + (alreadyFolded ? 0 : (dupe.mention_count || 0)),
      relationship: meters,
      disposition_to_player: keep.disposition_to_player || dupe.disposition_to_player,
      hidden_thought: keep.hidden_thought || dupe.hidden_thought,
      updated_at: new Date(),
    } },
  )

  // 2. Re-point the dupe ENTITY's references to keep's entity, then remove it.
  let memRepointed = 0, edgeRepointed = 0
  if (dupe.entity_id && keep.entity_id && String(dupe.entity_id) !== String(keep.entity_id)) {
    const de = dupe.entity_id, ke = keep.entity_id
    // $addToSet + $pull on the same path can't share one update — do them in
    // sequence (add keep's entity, then drop the dupe's).
    const m1 = await mongoColl.memories().updateMany({ instance_id: iid, subject_entity_ids: de }, { $addToSet: { subject_entity_ids: ke } })
    await mongoColl.memories().updateMany({ instance_id: iid, subject_entity_ids: de }, { $pull: { subject_entity_ids: de } })
    const m2 = await mongoColl.memories().updateMany({ instance_id: iid, object_entity_ids: de }, { $addToSet: { object_entity_ids: ke } })
    await mongoColl.memories().updateMany({ instance_id: iid, object_entity_ids: de }, { $pull: { object_entity_ids: de } })
    memRepointed = (m1.modifiedCount || 0) + (m2.modifiedCount || 0)
    // Re-point per-edge: a blind updateMany collides with the unique assertion
    // index when keep already has the same (source,target,type,label) edge. Try
    // each, and on a duplicate-key collision drop the dupe's edge (keep's wins).
    const repointEdges = async (field: 'source_entity_id' | 'target_entity_id') => {
      const edges = await mongoColl.entityEdges().find({ instance_id: iid, [field]: de }).toArray()
      let n = 0
      for (const edge of edges as any[]) {
        try {
          await mongoColl.entityEdges().updateOne({ _id: edge._id }, { $set: { [field]: ke } })
          n++
        } catch (err: any) {
          if (err?.code === 11000) {
            await mongoColl.entityEdges().deleteOne({ _id: edge._id }) // keep already has this relationship
          } else throw err
        }
      }
      return n
    }
    edgeRepointed = (await repointEdges('source_entity_id')) + (await repointEdges('target_entity_id'))
    // Register dupe entity's names as aliases on keep's entity, then delete dupe entity.
    const dupeEnt: any = await mongoColl.entities().findOne({ _id: de })
    if (dupeEnt) {
      const keepEnt: any = await mongoColl.entities().findOne({ _id: ke })
      const entAliases = uniq([...((keepEnt?.aliases) || []), ...(dupeEnt.aliases || []), dupeEnt.canonical_name])
      await mongoColl.entities().updateOne({ _id: ke }, { $set: { aliases: entAliases, updated_at: new Date() } })
      await mongoColl.entities().deleteOne({ _id: de })
    }
  }

  // 3. Delete the dupe card.
  await mongoColl.characters().deleteOne({ _id: dupe._id })

  const after: any = await mongoColl.characters().findOne({ _id: keep._id })
  console.log('\nAFTER:')
  console.log(`  keep "${after.canonical_name}" mentions=${after.mention_count} aliases=${JSON.stringify(after.aliases)}`)
  console.log(`  memories re-pointed=${memRepointed}  edges re-pointed=${edgeRepointed}  dupe card+entity deleted`)
  const remaining = await mongoColl.characters().countDocuments({ instance_id: iid, canonical_name: DUPE })
  console.log(`  "${DUPE}" cards remaining: ${remaining}`)
  process.exit(0)
}
main().catch((e) => { console.error(e); process.exit(2) })
