import { connectMongo, coll } from '../src/config/mongo'
import { isVagueLocationLabel } from '../src/services/entity-graph.service'
import { ObjectId } from 'mongodb'
async function main() {
  await connectMongo()
  const iid = new ObjectId(process.argv[2] || '6a2869768f7446e38bdb6fce')
  const locs = await coll('entities').find({ instance_id: iid, type: 'location' }).toArray()
  let fixed = 0
  for (const l of locs as any[]) {
    const kept = (l.aliases || []).filter((a: string) => !isVagueLocationLabel(a))
    if (kept.length !== (l.aliases || []).length) {
      const dropped = (l.aliases || []).filter((a: string) => isVagueLocationLabel(a))
      await coll('entities').updateOne({ _id: l._id }, { $set: { aliases: kept, updated_at: new Date() } })
      console.log(`  ${l.canonical_name}: dropped vague alias(es) [${dropped.join(', ')}] → aliases now [${kept.join(', ')}]`)
      fixed++
    }
  }
  console.log(`\nstripped vague aliases from ${fixed} location(s).`)
  process.exit(0)
}
main().catch(e=>{console.error(e);process.exit(1)})
