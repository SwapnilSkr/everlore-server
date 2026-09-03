/**
 * Does the memory curator close a thread the turn actually paid off?
 *
 * Replays real turns from a live save through the curation call twice: once
 * with the open threads hidden (how it shipped) and once with them listed.
 * Read-only -- nothing is written back.
 *
 *   bun run scripts/thread-closure-replay.ts <instanceId> <seq> [seq...]
 */
import { ObjectId } from 'mongodb'
import { connectMongo, coll } from '../src/config/mongo'
import { callLLM } from '../src/ai'
import { buildMemoryCurationRequest } from '../worker/processors/memory.processor'

const iid = new ObjectId(process.argv[2])
const sequential = process.argv.includes('--sequential')
const seqs = process.argv.slice(3).filter((a) => !a.startsWith('--')).map(Number)

async function main() {
  await connectMongo()
  const events: any[] = await coll('events').find({ instance_id: iid }).sort({ sequence: 1 }).toArray()
  const seqOf = new Map(events.map((e) => [String(e._id), e.sequence]))
  const roster: any[] = await coll('characters').find({ instance_id: iid }).toArray()
  const memories: any[] = await coll('memories').find({ instance_id: iid }).toArray()
  for (const m of memories) m.seq = Math.min(...(m.source_event_ids || []).map((i: any) => seqOf.get(String(i)) ?? 999))

  if (sequential) {
    // Thread closures FORWARD: each turn only sees what is still open, so the
    // end state is what the save would actually have looked like.
    const closed = new Set<string>()
    let calls = 0
    for (const event of events) {
      if (!event.data?.ai_response) continue
      const prior = events.find((e) => e.sequence === event.sequence - 1)
      const open = memories
        .filter((m) => m.unresolved_thread && m.seq < event.sequence && !closed.has(String(m._id)))
        .sort((a, b) => +new Date(b.updated_at) - +new Date(a.updated_at))
        .slice(0, 12)
      if (!open.length) continue
      const openThreads = open.map((m, i) => ({ id: `T${i + 1}`, text: String(m.text) }))
      calls++
      let parsed: any = {}
      try {
        parsed = JSON.parse(
          await callLLM(
            buildMemoryCurationRequest({
              sceneTag: event.data?.scene_tag || 'dialogue',
              roster: roster.map((c) => ({ canonical_name: c.canonical_name, aliases: c.aliases, is_protagonist: c.is_protagonist })),
              isSentient: false,
              protagonistName: roster.find((c) => c.is_protagonist)?.canonical_name || null,
              playerPersonaName: null,
              precedingAiResponse: prior?.data?.ai_response || null,
              playerInput: String(event.data?.player_input || ''),
              playerSpokenInput: '',
              playerNarrationFacts: event.data?.player_narration_facts || [],
              aiResponse: String(event.data?.ai_response || ''),
              openThreads,
            }),
          ),
        )
      } catch { continue }
      const known = new Map(openThreads.map((t, i) => [t.id, open[i]._id]))
      const ids = [...(parsed.closed_thread_ids || []), ...(parsed.resolved_threads || [])]
        .map((x: any) => String(x).trim().toUpperCase())
        .filter((x: string) => known.has(x))
      const fresh = [...new Set(ids)].map((x) => String(known.get(x)))
      for (const id of fresh) closed.add(id)
      if (fresh.length) console.log(`  #${event.sequence} closed ${fresh.length} (open now ${memories.filter((m)=>m.unresolved_thread && m.seq<=event.sequence && !closed.has(String(m._id))).length})`)
    }
    const total = memories.filter((m) => m.unresolved_thread).length
    console.log(`\nSEQUENTIAL REPLAY over ${calls} turns`)
    console.log(`  threads opened:            ${total}`)
    console.log(`  closed as shipped:         ${memories.filter((m) => m.resolved_at).length}`)
    console.log(`  closed with threads shown: ${closed.size}`)
    console.log(`  still open at the end:     ${total - closed.size}`)
    process.exit(0)
  }

  for (const seq of seqs) {
    const event = events.find((e) => e.sequence === seq)
    const prior = events.find((e) => e.sequence === seq - 1)
    if (!event) continue
    // The threads that were open BEFORE this turn ran.
    const open = memories
      .filter((m) => m.unresolved_thread && m.seq < seq)
      .sort((a, b) => +new Date(b.updated_at) - +new Date(a.updated_at))
      .slice(0, 12)
    const openThreads = open.map((m, i) => ({ id: `T${i + 1}`, text: String(m.text) }))
    const base = {
      sceneTag: event.data?.scene_tag || 'dialogue',
      roster: roster.map((c) => ({ canonical_name: c.canonical_name, aliases: c.aliases, is_protagonist: c.is_protagonist })),
      isSentient: false,
      protagonistName: roster.find((c) => c.is_protagonist)?.canonical_name || null,
      playerPersonaName: null,
      precedingAiResponse: prior?.data?.ai_response || null,
      playerInput: String(event.data?.player_input || ''),
      playerSpokenInput: '',
      playerNarrationFacts: event.data?.player_narration_facts || [],
      aiResponse: String(event.data?.ai_response || ''),
    }
    const run = async (threads?: typeof openThreads) => {
      try {
        const raw = await callLLM(buildMemoryCurationRequest({ ...base, openThreads: threads }))
        const parsed = JSON.parse(raw)
        return {
          ids: (parsed.closed_thread_ids || []) as string[],
          prose: (parsed.resolved_threads || []) as string[],
        }
      } catch (err) {
        return { ids: [], prose: [], error: (err as Error).message }
      }
    }
    const before = await run(undefined)
    const after = await run(openThreads)
    console.log(`\n════ turn ${seq}  (${openThreads.length} threads open beforehand)`)
    console.log(`  player: ${base.playerInput.replace(/\s+/g, ' ').slice(0, 90)}`)
    // Mirrors the processor: an id is an id whichever field it arrived in.
    const known = new Set(openThreads.map((t) => t.id))
    const route = (r: { ids: string[]; prose: string[] }) => [
      ...new Set([...r.ids, ...r.prose].map((x) => String(x).trim().toUpperCase()).filter((x) => known.has(x))),
    ]
    const closedBefore = route(before)
    const closedAfter = route(after)
    console.log(`  BEFORE (threads hidden): would close ${closedBefore.length}  raw=${JSON.stringify(before.ids)}/${JSON.stringify(before.prose)}`)
    console.log(`  AFTER  (threads shown):  would close ${closedAfter.length}`)
    for (const id of closedAfter) {
      const t = openThreads.find((x) => x.id === id)
      if (t) console.log(`     ${t.id} -> ${t.text.slice(0, 118)}`)
    }
  }
  process.exit(0)
}
main().catch((e) => { console.error(e); process.exit(1) })
