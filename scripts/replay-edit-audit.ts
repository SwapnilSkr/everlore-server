/**
 * Live integration audit for the replay/edit/variant-select CHOICE regeneration.
 * Clones a real instance + its events/characters into a temp id, exercises the
 * real services against the CLONE, asserts the new chips behaviour, then deletes
 * the clone. Never touches the source world (mirrors rewind-audit.ts).
 *
 *   bun run scripts/replay-edit-audit.ts [sourceInstanceId]
 *
 * Needs: Mongo + Redis (local), OpenAI + OpenRouter + Pinecone (real generation).
 */
import { ObjectId } from 'mongodb'
import { connectMongo, mongoColl } from '../src/config/mongo'
import { connectRedis } from '../src/config/redis'
import { memoryService } from '../src/services/memory.service'

const SOURCE = process.argv[2] || '6a2869768f7446e38bdb6fce'

let failures = 0
function ok(label: string, cond: boolean, detail = '') {
  console.log(`${cond ? '✅' : '❌'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!cond) failures++
}

type Choice = { label: string; kind: string; send: string }
const FIRST_PERSON = /\b(I|I'm|I'll|I've|I'd|my|me|mine|myself)\b/i
function actionFirstPerson(c: Choice): boolean {
  const action = [...c.send.matchAll(/\*([^*]+)\*/g)].map((x) => x[1]).join(' ').trim()
  return !action || FIRST_PERSON.test(action) // pure-dialogue 'say' lines are exempt
}
function allFirstPerson(choices: Choice[]): boolean {
  return choices.length > 0 && choices.every(actionFirstPerson)
}
function sameChoices(a: Choice[] = [], b: Choice[] = []): boolean {
  if (a.length !== b.length) return false
  return a.every((x, i) => x.label === b[i].label && x.kind === b[i].kind && x.send === b[i].send)
}
function fmt(choices: Choice[] = []): string {
  return choices.length ? choices.map((c) => `[${c.kind}] ${c.label}`).join(' | ') : '(none)'
}
async function rejects(label: string, fn: () => Promise<unknown>, messageIncludes: string) {
  try {
    await fn()
    ok(label, false, 'resolved unexpectedly')
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    ok(label, msg.includes(messageIncludes), msg)
  }
}

async function main() {
  await connectMongo()
  await connectRedis()

  const src = await mongoColl.worldInstances().findOne({ _id: new ObjectId(SOURCE) })
  if (!src) {
    throw new Error(
      `source instance ${SOURCE} not found. This audit clones a REAL save and needs one to ` +
        'exist: pass an instance id explicitly — bun run scripts/replay-edit-audit.ts <instanceId>. ' +
        `(The built-in default is only a convenience and goes stale when that save is deleted.)`,
    )
  }
  const tempId = new ObjectId()
  const playerId = src.player_id

  // Clone instance + events + characters under tempId.
  await mongoColl.worldInstances().insertOne({ ...src, _id: tempId })
  const srcEvents = await mongoColl.events().find({ instance_id: src._id }).toArray()
  if (srcEvents.length) {
    await mongoColl.events().insertMany(srcEvents.map((e) => ({ ...e, _id: new ObjectId(), instance_id: tempId })))
  }
  const srcChars = await mongoColl.characters().find({ instance_id: src._id }).toArray()
  if (srcChars.length) {
    await mongoColl.characters().insertMany(srcChars.map((c) => ({ ...c, _id: new ObjectId(), instance_id: tempId })))
  }
  console.log(`Cloned ${SOURCE} → ${tempId} (${srcEvents.length} events, sentient=${!!src.is_sentient})`)

  try {
    const latest = await mongoColl.events().findOne(
      { instance_id: tempId, 'data.ai_response': { $exists: true, $ne: '' } },
      { sort: { sequence: -1 } },
    )
    if (!latest) throw new Error('no narratable event on clone')
    const eid = String(latest._id)
    console.log(`Target cloned event seq=${latest.sequence} (choices before: ${fmt(latest.data?.choices)})\n`)

    // 1. REPLAY — regenerates chips from the new variant + stores them on it.
    console.log('--- replayEvent ---')
    await memoryService.replayEvent(eid, String(playerId))
    let ev: any = await mongoColl.events().findOne({ _id: latest._id })
    const replayChoices: Choice[] = ev.data.choices || []
    const variants: any[] = ev.data.replay_variants || []
    const replayIdx = variants.length - 1
    console.log(`  data.choices: ${fmt(replayChoices)}`)
    ok('replay produced choices', replayChoices.length >= 2, `${replayChoices.length}`)
    ok('replay choices are first-person', allFirstPerson(replayChoices))
    ok('replay variant stores its own choices', sameChoices(variants[replayIdx]?.choices, replayChoices),
      `variant[${replayIdx}]=${fmt(variants[replayIdx]?.choices)}`)

    // 2. SELECT base (index 0) — restores the base variant's own chips (no blank).
    console.log('--- selectReplayVariant(0) [base] ---')
    await memoryService.selectReplayVariant(eid, String(playerId), 0)
    ev = await mongoColl.events().findOne({ _id: latest._id })
    ok('select(base) restores base variant chips (not blanked)', sameChoices(ev.data.choices, variants[0]?.choices || []),
      `data=${fmt(ev.data.choices)} vs base=${fmt(variants[0]?.choices)}`)

    // 3. SELECT the replay variant — restores its (non-empty) chips.
    console.log(`--- selectReplayVariant(${replayIdx}) [replay] ---`)
    await memoryService.selectReplayVariant(eid, String(playerId), replayIdx)
    ev = await mongoColl.events().findOne({ _id: latest._id })
    ok('select(replay) restores non-empty chips', ev.data.choices?.length >= 2 && sameChoices(ev.data.choices, replayChoices),
      fmt(ev.data.choices))

    // 4. EDIT rejects stale/wrong request fields instead of marking a no-op.
    console.log('--- editEvent { narrative } wrong field ---')
    await rejects(
      'edit rejects wrong field instead of no-op recuration',
      () => memoryService.editEvent(eid, String(playerId), { narrative: 'wrong key' }),
      'No editable event fields provided',
    )
    await rejects(
      'edit rejects empty ai_response',
      () => memoryService.editEvent(eid, String(playerId), { ai_response: '' }),
      'ai_response cannot be empty',
    )

    // 5. EDIT (rewrite prose) — regenerates chips, returns them, stores on 'edit' variant.
    console.log('--- editEvent { ai_response } ---')
    const rewrite = `*I draw a slow breath and step into the candlelight, no longer willing to stand unseen at the edge of my own family.* "I'm here too," *I say, and the words land heavier than I meant them to.*`
    const editRes: any = await memoryService.editEvent(eid, String(playerId), { ai_response: rewrite })
    console.log(`  returned choices: ${fmt(editRes.choices)}`)
    ok('edit returns choices', Array.isArray(editRes.choices) && editRes.choices.length >= 2, `${editRes.choices?.length}`)
    ok('edit choices are first-person', allFirstPerson(editRes.choices || []))
    ev = await mongoColl.events().findOne({ _id: latest._id })
    ok('edit sets event.data.choices to returned', sameChoices(ev.data.choices, editRes.choices))
    const editVariants: any[] = ev.data.replay_variants || []
    const lastVar = editVariants[editVariants.length - 1]
    ok("edit variant is 'edit' source w/ its own chips", lastVar?.source === 'edit' && sameChoices(lastVar?.choices, editRes.choices),
      `source=${lastVar?.source}`)

    // 6. EDIT (player input only) — prose unchanged → chips untouched, returns null.
    console.log('--- editEvent { player_input } only ---')
    const beforePlayerEdit: Choice[] = ev.data.choices || []
    const playerEditRes: any = await memoryService.editEvent(eid, String(playerId), { player_input: '*I square my shoulders.*' })
    ok('player-only edit returns null choices', playerEditRes.choices === null, `${JSON.stringify(playerEditRes.choices)}`)
    ev = await mongoColl.events().findOne({ _id: latest._id })
    ok('player-only edit leaves chips untouched', sameChoices(ev.data.choices, beforePlayerEdit), fmt(ev.data.choices))
  } finally {
    await mongoColl.worldInstances().deleteOne({ _id: tempId })
    await mongoColl.events().deleteMany({ instance_id: tempId })
    await mongoColl.characters().deleteMany({ instance_id: tempId })
    await mongoColl.memories().deleteMany({ instance_id: tempId })
    await mongoColl.sceneSummaries().deleteMany({ instance_id: tempId })
    console.log(`\nCleaned up clone ${tempId}.`)
  }

  console.log(`\n${failures === 0 ? '✅ ALL INVARIANTS HELD' : `❌ ${failures} invariant failure(s)`}`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(2)
})
