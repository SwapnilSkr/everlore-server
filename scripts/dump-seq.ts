import { connectMongo, coll } from '../src/config/mongo'
const IID = process.argv[2] || '6a2869768f7446e38bdb6fce'
const LO = Number(process.argv[3] || 15), HI = Number(process.argv[4] || 22)
async function main() {
  await connectMongo()
  const { ObjectId } = await import('mongodb')
  const events = await coll('events')
    .find({ instance_id: new ObjectId(IID), sequence: { $gte: LO, $lte: HI } })
    .sort({ sequence: 1 }).toArray()
  for (const ev of events) {
    const d = ev.data || {}
    console.log(`\n──── seq ${ev.sequence} [${ev.type}] present=[${(d.present_characters||[]).join(', ')}] loc=${JSON.stringify(ev.location_anchor?.canonical_name||ev.location_anchor)}`)
    if (d.player_input) console.log(`  ▶ PLAYER: ${d.player_input}`)
    console.log(`  ◆ AI: ${(d.ai_response||'').toString()}`)
    if (ev.data?.codex_deltas?.length) {
      console.log(`  ⚙ codex_deltas: ${JSON.stringify(ev.data.codex_deltas.map((x:any)=>({name:x.resolved_name||x.name, op:x.op||x.kind, role:x.role})))}`)
    }
  }
  process.exit(0)
}
main().catch((e) => { console.error(e); process.exit(1) })
