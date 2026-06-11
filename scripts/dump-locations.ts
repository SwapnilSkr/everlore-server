import { connectMongo, coll } from '../src/config/mongo'
import { ObjectId } from 'mongodb'
async function main() {
  await connectMongo()
  const iid = new ObjectId(process.argv[2] || '6a2869768f7446e38bdb6fce')
  const locs = await coll('entities').find({ instance_id: iid, type: 'location' }).sort({ first_seen_sequence: 1 }).toArray()
  console.log(`=== ${locs.length} location entities ===`)
  for (const l of locs as any[]) {
    console.log(`"${l.canonical_name}" (norm="${l.name_normalized}") aliases=[${(l.aliases||[]).join(', ')}] first=${l.first_seen_sequence} last=${l.last_seen_sequence} mentions=${l.mention_count} status=${l.status} _id=${l._id}`)
  }
  // current cursor
  const inst: any = await coll('world_instances').findOne({ _id: iid })
  console.log(`\ncurrent_location cursor: ${JSON.stringify(inst?.current_location)}`)
  process.exit(0)
}
main().catch(e=>{console.error(e);process.exit(1)})
