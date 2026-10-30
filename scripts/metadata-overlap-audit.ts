/** Pure admission/ordering audit. Real lock transitions, WS dispatch, packet and
 * prompt builders; scripted extraction, fake Redis CAS/TTL and Mongo reads.
 * Mutants are temporary copies, never edits to the working tree. No network. */
import assert from 'node:assert/strict'
import { mock } from 'bun:test'
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ObjectId } from 'mongodb'

if (process.argv[2] === '--rewind-audit') await runPureRewindAudit()

const mutantPath = process.argv[2]
const locks = await import(mutantPath || '../src/utils/generation-lock') as typeof import('../src/utils/generation-lock')
const { acquireGenerationTurn: acquire, markGenerationStreamEnd: end, finishGenerationTurn: finish,
  waitForPriorGeneration: barrier, releaseGenerationLock: release, refreshGenerationLock: refresh,
  generationLockKey, generationSlots, GENERATION_LOCK_CAS: CAS,
  GENERATION_LOCK_HEARTBEAT_TTL_SECONDS: TTL } = locks
const processor = readFileSync(process.argv[3] || new URL('../worker/processors/generation.processor.ts', import.meta.url), 'utf8')
const worker = readFileSync(new URL('../worker/index.ts', import.meta.url), 'utf8')
const controllerSource = readFileSync(new URL('../src/controllers/chronicle.controller.ts', import.meta.url), 'utf8')
const pid = new ObjectId(), iid = new ObjectId(), eid = new ObjectId()
const key = generationLockKey(String(pid), String(iid)), channel = `user:${pid}:events`
const frame = (type: string) => JSON.stringify({ type, instanceId: String(iid) })

class RedisFixture {
  clock = 0
  rows = new Map<string, { value: string; expires: number }>()
  frames: string[] = []
  conflicts = 0
  async get(key: string) {
    const row = this.rows.get(key)
    if (!row || row.expires <= this.clock) { this.rows.delete(key); return null }
    return row.value
  }
  async set(key: string, value: string, _ex: string, seconds: number, nx?: string) {
    const current = this.rows.get(key)
    if (nx && current && current.expires > this.clock) return null
    this.rows.set(key, { value, expires: this.clock + seconds * 1000 }); return 'OK'
  }
  async del(key: string) { return this.rows.delete(key) ? 1 : 0 }
  async publish(_channel: string, value: string) { this.frames.push(JSON.parse(value).type); return 1 }
  // No awaits inside this section: it models the atomic Redis script, including
  // TTL preservation. All transition/ownership decisions run in real code.
  async eval(script: string, count: number, ...args: string[]) {
    assert.equal(script, CAS); assert.equal(count, 2)
    const [key, outcomeKey, before, after, ttl, outcome, channel, frame, resultTtl] = args
    const row = this.rows.get(key)
    const current = row && row.expires > this.clock ? row.value : ''
    if (current !== before) { this.conflicts++; return 0 }
    if (channel) this.frames.push(JSON.parse(frame).type)
    if (outcome) this.rows.set(outcomeKey, { value: outcome, expires: this.clock + Number(resultTtl) * 1000 })
    if (!after) this.rows.delete(key)
    else this.rows.set(key, { value: after, expires: ttl === 'keep' ? row!.expires : this.clock + Number(ttl) * 1000 })
    return 1
  }
}
let redis = new RedisFixture()
const r = () => redis as unknown as Parameters<typeof acquire>[0]
let eventRows: Record<string, unknown>[] = []
let readCount = 0
// Fixture documents contain deliberately partial Mongo rows; the production
// packet and prompt builders receive the actual runtime shapes they consume.
function collection(rows: () => Record<string, unknown>[]) {
  return {
    find: () => {
      readCount++
      let result = [...rows()]
      const cursor = {
        sort: (sort: Record<string, number>) => { result.sort((a, b) => (Number(a.sequence) - Number(b.sequence)) * (sort.sequence || 1)); return cursor },
        limit: (n: number) => { result = result.slice(0, n); return cursor },
        toArray: async () => structuredClone(result),
      }
      return cursor
    },
    findOne: async () => { readCount++; return rows()[0] || null },
  }
}
const eventCollection = collection(() => eventRows)
const target = { instance_id: iid, player_id: pid, _id: eid }
const empty = collection(() => [])
let characterTarget = false
const mongo = { worldInstances: () => collection(() => [{ _id: iid, player_id: pid }]), events: () => eventCollection, characters: () => collection(() => characterTarget ? [target] : []), sceneSummaries: () => empty,
  entities: () => empty, users: () => ({ findOne: async () => ({ preferences: {} }) }),
  memories: () => ({ findOne: async () => target }) }
mock.module('../src/config/mongo', () => ({ mongoColl: mongo }))
mock.module('../src/config/redis', () => ({ getRedisClient: () => redis, getRedisSubscriber: () => ({}) }))
mock.module('../src/services/last-active.service', () => ({ recordLastActive: () => {} }))
mock.module('../src/middleware/auth', () => ({ verifyWsToken: async () => null }))
mock.module('../src/services/auth.service', () => ({ authService: { getLiveAccess: async () => ({ tier: 'free' }) } }))
let rateAllowed = true, reservationAllowed = true, reservations = 0, refunds = 0
mock.module('../src/middleware/rate-limit', () => ({ rateLimit: async () => ({ allowed: rateAllowed }) }))
mock.module('../src/services/billing.service', () => ({ billingService: {
  reserve: async () => { if (!reservationAllowed) throw new Error('fixture reservation denied'); reservations++; return { reservation_id: 'fixture-reservation' } },
  release: async () => { refunds++ },
} }))
mock.module('../src/utils/logger', () => ({ log: { info() {}, warn() {}, error() {} } }))
const queued: { name: string; data: Record<string, unknown>; opts: { jobId?: string } }[] = []
mock.module('../src/queues', () => ({ QUEUE_RETENTION: { generation: {} }, getGenerationQueue: () => ({
  add: async (name: string, data: Record<string, unknown>, opts: { jobId?: string }) => {
    queued.push({ name, data, opts }); return { id: opts.jobId }
  },
}) }))
mock.module('../src/services/instance.service', () => ({ instanceService: { loadSession: async () => ({ template_id: String(eid) }) } }))
mock.module('../src/services/media/events', () => ({ publicMediaEvent: (row: unknown) => row, withTurnMedia: async (rows: unknown) => rows }))
mock.module('../src/providers/rag.provider', () => ({ queryRag: async () => ({ loreTexts: [], memoryTexts: [], openThreads: [], retrievedEntityIds: [], embedMs: 0 }), querySummaries: async () => [] }))
mock.module('../src/services/character-codex.service', () => ({ rankCodexForInjection: () => [], characterCodexService: { editCharacter: async () => { throw new Error('Edit entered while busy') } } }))
mock.module('../src/services/entity-graph.service', () => ({ normalizeEntityName: (s: string) => s.toLowerCase(), entityGraphService: {
  normalizeEntityName: (s: string) => s.toLowerCase(), findMentionedCharacterCards: async () => ({ mentionedEntityIds: [], cards: [] }),
  wakeStubsByCues: async () => ({ entityIds: [] }),
} }))
mock.module('../src/services/kinship-graph.service', () => ({ kinshipGraphService: { kinshipBrief: async () => [] } }))
mock.module('../src/services/time.service', () => ({ timeService: { timelineContext: async () => null } }))
// Controller methods must refuse before entering any mutations.
mock.module('../src/services/memory.service', () => ({ memoryService: new Proxy({}, { get: () => async () => { throw new Error('Mutation entered while busy') } }) }))
mock.module('../src/services/memory-supersession.service', () => ({ memorySupersessionService: {} }))
mock.module('../src/services/location.service', () => ({ locationService: {} }))
mock.module('../src/services/relation-candidate.service', () => ({ relationCandidateService: {} }))
mock.module('../worker/lib/kinship-transition-extractor', () => ({ TRANSITION_PLAYER: 'player' }))
globalThis.fetch = Object.assign(async () => { throw new Error('Network forbidden in pure audit') }, { preconnect() { throw new Error('Network forbidden') } })
const { playWsService } = await import('../src/services/play-ws.service')
const { chronicleController } = await import(process.argv[4] || '../src/controllers/chronicle.controller')
const { buildContextPacket } = await import(process.argv[5] || '../src/services/context-packet.service')
const { renderSceneStateForPrompt } = await import('../src/services/scene-state.service')
const { buildPrompt } = await import('../src/utils/prompt-builder')
const { buildPrepStages } = await import('../src/models/generation-log.model')
const user = { id: String(pid), tier: 'free' as const, role: 'player' as const }
const sent: Record<string, unknown>[] = []
const socket = { send: (message: string) => sent.push(JSON.parse(message)), close() {}, data: { _user: user, jwt: { verify: async () => null } } }
async function send(action: string, payload?: unknown) {
  sent.length = 0
  await playWsService.handleMessage(socket, { action, instance_id: String(iid), event_id: String(eid), payload })
  return sent.at(-1)!
}
async function twoSlots() {
  redis = new RedisFixture()
  assert.ok(await acquire(r(), key, 'N', true))
  await end(r(), key, 'N', channel, frame('generation_stream_end'))
  assert.deepEqual(await acquire(r(), key, 'N1', true), { priorTurnId: 'N' })
}
let pass = 0, fail = 0
async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); pass++; console.log(`ok ${name}`) }
  catch (error) { fail++; console.error(`FAIL ${name}: ${(error as Error).message}`) }
}

await check('(a) real WS chat/continue/world_action admit after stream end; pre-end/third/replay refuse', async () => {
  for (const action of ['chat', 'continue', 'world_action']) {
    redis = new RedisFixture(); queued.length = 0
    const payload = action === 'world_action' ? { kind: 'travel', destination: 'Fixture destination', companions: [] } : { message: 'I wait beside the door.' }
    assert.equal((await send(action, payload)).type, 'ack')
    const first = queued[0]
    assert.ok(first.opts.jobId); assert.equal(first.data.priorTurnId, undefined)
    assert.equal((await send(action, payload)).code, 'GENERATION_IN_PROGRESS')
    await end(r(), key, first.opts.jobId!, channel, frame('generation_stream_end'))
    assert.equal((await send(action, payload)).type, 'ack')
    assert.equal(queued[1].data.priorTurnId, first.opts.jobId)
    assert.equal((await send(action, payload)).code, 'GENERATION_IN_PROGRESS')
    assert.equal((await send('replay')).code, 'GENERATION_IN_PROGRESS')
    assert.equal(queued.length, 2)
  }
})
await check('(a) existing rate, validation, input guard and billing gates still run before enqueue', async () => {
  redis = new RedisFixture(); queued.length = 0
  rateAllowed = false
  assert.equal((await send('chat', { message: 'I wait.' })).code, 'RATE_LIMITED')
  rateAllowed = true
  await send('chat', { message: '' }); assert.equal(await redis.get(key), null)
  const reservedBefore = reservations, refundsBefore = refunds
  assert.equal((await send('chat', { message: 'I have sex with my mother' })).code, 'BAD_REQUEST')
  assert.equal(reservations, reservedBefore + 1); assert.equal(refunds, refundsBefore + 1)
  assert.equal(await redis.get(key), null)
  reservationAllowed = false
  assert.equal((await send('chat', { message: 'I wait.' })).type, 'error')
  reservationAllowed = true
  assert.equal(queued.length, 0); assert.equal(await redis.get(key), null)
})
await check('(a) simultaneous contenders CAS to one waiter; failed dispatch removes only itself', async () => {
  redis = new RedisFixture(); await acquire(r(), key, 'N', true)
  await end(r(), key, 'N', channel, frame('generation_stream_end'))
  const attempts = await Promise.all(Array.from({ length: 12 }, (_, n) => acquire(r(), key, `next-${n}`, true)))
  assert.equal(attempts.filter(Boolean).length, 1); assert.ok(redis.conflicts > 0)
  const winner = generationSlots(await redis.get(key))!.next!
  await release(r(), key, 'stale-job'); assert.equal(generationSlots(await redis.get(key))!.next, winner)
  await release(r(), key, winner); assert.deepEqual(generationSlots(await redis.get(key)), { owner: 'N', phase: 'tail' })
})

await check('(b,c,d) 4s merged extraction tail overlaps 0.5s prep; real packet/prompt sees N; complete precedes prose', async () => {
  await twoSlots()
  const scene = { as_of_sequence: 2, place: { name: 'Fixture room' }, cast: [{ name: 'Fixture witness', since_sequence: 2, source: 'arrival' }], physical: [{ kind: 'held', statement: 'The witness holds the brass key.', actors: ['Fixture witness'], since_sequence: 2 }], scene_break: false }
  eventRows = [{ _id: eid, instance_id: iid, sequence: 1, data: { ai_response: 'STALE PROSE', present_characters: ['STALE CAST'], beat_ledger: { unresolved_hook: 'STALE HOOK' } } }]
  readCount = 0
  const startedAt = Date.now()
  // The choices half completes early. The separate ledger half paces the tail:
  // neither saving nor opening the barrier at choices completion is sufficient.
  const extraction = async (ms: number, value: unknown) => { await Bun.sleep(ms); return value }
  const tail = (async () => {
    const [choices, ledger] = await Promise.all([extraction(60, ['Wait']), extraction(4000, { unresolved_hook: 'Ask about the missing brass key', last_beat: 'The witness returns.' })])
    eventRows.push({ _id: new ObjectId(), instance_id: iid, sequence: 2, data: { ai_response: 'The witness returns with the brass key.', present_characters: ['Fixture witness'], scene_state: scene, beat_ledger: ledger, choices } })
    await finish(r(), key, 'N', true, channel, frame('generation_complete'))
  })()
  // Input embedding/live prep starts now, without any save read.
  const independentPrep = Bun.sleep(500)
  await independentPrep
  assert.equal(readCount, 0)
  const waitMs = await barrier(r(), key, 'N1', 'N')
  const packet = await buildContextPacket({ instanceId: String(iid), playerId: String(pid), session: { template_id: String(eid) }, userMessage: 'I ask about the key.', isContinuation: false })
  const prompt = JSON.stringify(buildPrompt({ seedPrompt: 'A fixture story.', isSentient: false, worldState: {}, activeFlags: {}, globalLore: '', retrievedLore: [], retrievedMemories: [], sceneSummary: null, recentEvents: packet.recentEvents, sceneStateText: renderSceneStateForPrompt(packet.sceneState), userMessage: 'I ask about the key.', maxTokens: 10000, proseOnly: true }))
  const elapsed = Date.now() - startedAt
  assert.ok(elapsed >= 3950 && elapsed < 4400, `narrator at ${elapsed}ms: expected ~4000, not 4500`)
  assert.ok(waitMs > 3000 && waitMs < 3900)
  assert.equal(packet.recentEvents.at(-1)?.data.ai_response, 'The witness returns with the brass key.')
  assert.deepEqual(packet.recentEvents.at(-1)?.data.present_characters, ['Fixture witness'])
  assert.deepEqual(packet.sceneState, scene)
  // Production intentionally renders semantic continuity instead of raw prior prose.
  // The prose reaches buildPrompt in recentEvents (asserted above); the actual
  // prompt must contain the fresh merged ledger, presence and physical state.
  for (const text of ['Fixture witness', 'holds the brass key', 'Ask about the missing brass key']) assert.ok(prompt.includes(text), text)
  await redis.publish(channel, frame('generation_delta'))
  assert.ok(redis.frames.indexOf('generation_complete') < redis.frames.indexOf('generation_delta'))
  assert.equal(buildPrepStages({ prior_turn_wait: waitMs }).prior_turn_wait, Math.round(waitMs))
  await tail
  console.log(`   fixture: narrator ${elapsed}ms after admission; prior_turn_wait=${waitMs}ms`)
})
await check('(d) no-prior wait is zero; completion is atomic with promotion and rejects stale publishers', async () => {
  redis = new RedisFixture(); await acquire(r(), key, 'solo', true)
  assert.equal(await barrier(r(), key, 'solo'), 0)
  await twoSlots()
  const waiting = barrier(r(), key, 'N1', 'N')
  await finish(r(), key, 'N', true, channel, frame('generation_complete'))
  await waiting
  assert.equal(redis.frames.at(-1), 'generation_complete')
  assert.deepEqual(generationSlots(await redis.get(key)), { owner: 'N1', phase: 'running' })
  await assert.rejects(finish(r(), key, 'N', true, channel, frame('stale-completion')))
  assert.ok(!redis.frames.includes('stale-completion'))
})
await check('(e) post-stream failure, expired outcome and bounded timeout all fail closed without narration', async () => {
  await twoSlots(); await finish(r(), key, 'N', false)
  await assert.rejects(barrier(r(), key, 'N1', 'N'), /Prior turn unavailable/)
  await release(r(), key, 'N1'); assert.equal(await redis.get(key), null)
  await twoSlots()
  let time = 0
  await assert.rejects(barrier(r(), key, 'N1', 'N', { now: () => time, sleep: async (ms) => { time += ms }, timeoutMs: 30000 }), /Prior turn unavailable/)
  assert.equal(time, 30000)
  await twoSlots(); await finish(r(), key, 'N', true)
  redis.clock = 241000
  // Keep the successor's lease but remove the predecessor outcome.
  await redis.set(key, JSON.stringify({ owner: 'N1', phase: 'running' }), 'EX', 240)
  time = 0
  await assert.rejects(barrier(r(), key, 'N1', 'N', { now: () => time, sleep: async (ms) => { time += ms }, timeoutMs: 40 }))
  const hangingRedis = { get: () => new Promise<string | null>(() => {}), eval: redis.eval.bind(redis) }
  await assert.rejects(Promise.race([
    barrier(hangingRedis as never, key, 'N1', 'N', { timeoutMs: 10 }),
    Bun.sleep(200).then(() => { throw new Error('Barrier deadline did not bound a hung Redis GET') }),
  ]), /Prior turn unavailable/)
})
await check('(f) waiter heartbeat never extends a dead head: both slots expire within heartbeat TTL', async () => {
  await twoSlots(); await refresh(r(), key, 'N')
  redis.clock = (TTL - 1) * 1000
  await refresh(r(), key, 'N1')
  assert.notEqual(await redis.get(key), null)
  redis.clock = TTL * 1000
  assert.equal(await redis.get(key), null)
  await assert.rejects(barrier(r(), key, 'N1', 'N'))
  // A waiter that died before promotion also receives only a live-sized lease.
  await twoSlots(); await finish(r(), key, 'N', true)
  redis.clock = TTL * 1000
  assert.equal(await redis.get(key), null)
  await release(r(), key, 'N')
  assert.ok(await acquire(r(), key, 'new', true))
  await release(r(), key, 'N1')
  assert.equal(generationSlots(await redis.get(key))!.owner, 'new')
})
await check('(g) real rewind/edit/HTTP replay guards refuse while either slot is held', async () => {
  eventRows = [target]
  characterTarget = true
  const methods = [
    () => chronicleController.rewind({ params: { instanceId: String(iid) }, body: { sequence: 1 }, user }),
    () => chronicleController.editEvent({ params: { eventId: String(eid) }, body: { ai_response: 'Replacement' }, user }),
    () => chronicleController.editMemory({ params: { memoryId: String(eid) }, body: { text: 'Replacement' }, user }),
    () => chronicleController.editCharacter({ params: { characterId: String(eid) }, body: { persona: 'Replacement' }, user }),
    () => chronicleController.deleteMemory({ params: { memoryId: String(eid) }, user }),
    () => chronicleController.updateEventTimeAnchor({ params: { eventId: String(eid) }, body: { event_time_label: 'Replacement' }, user }),
    () => chronicleController.replayEvent({ params: { eventId: String(eid) }, user }),
    () => chronicleController.selectReplayVariant({ params: { eventId: String(eid) }, body: { variant_index: 0 }, user }),
  ]
  await twoSlots()
  for (const method of methods) await assert.rejects(method, (err: unknown) => (err as { statusCode?: number }).statusCode === 409)
  await release(r(), key, 'N1')
  for (const method of methods) await assert.rejects(method, (err: unknown) => (err as { statusCode?: number }).statusCode === 409)
  await acquire(r(), key, 'N1', true); await finish(r(), key, 'N', true)
  for (const method of methods) await assert.rejects(method, (err: unknown) => (err as { statusCode?: number }).statusCode === 409)
  characterTarget = false
})
await check('wiring: barrier precedes every save read; merged event/session precede completion; Lua publish precedes promotion', async () => {
  const barrierAt = processor.indexOf('const priorTurnWaitMs = await waitForPriorGeneration(')
  assert.ok(barrierAt > processor.indexOf('startQueryEmbedding(ragQueryTextFor({ isContinuation, userMessage }))'))
  for (const read of ['mongoColl.events().findOne(', 'const priorPending = pendingFromSession(session)', '.listKnownLocations(instanceId, 30)', 'listCharacterLastPlaces(instanceId)', 'await fenceOnPriorProjection(', 'await buildContextPacket({']) {
    assert.ok(processor.indexOf(read) > barrierAt, `${read} must follow the barrier`)
  }
  assert.ok(processor.includes('await redis.del(`session:${instanceId}`)\n    session = await instanceService.loadSession(instanceId, playerId)'))
  const completion = processor.indexOf('await finishGenerationTurn(')
  for (const write of ['await mongoColl.events().insertOne(event)', 'await mongoColl.worldInstances().updateOne({ _id: instanceOid }, instanceUpdate', 'await redis.set(`session:${instanceId}`, JSON.stringify(updatedSession)']) assert.ok(processor.indexOf(write) < completion)
  assert.ok(processor.includes('beat_ledger: parsed.beat_ledger'))
  assert.ok(processor.includes('streamEndPublish = markGenerationStreamEnd('))
  assert.ok(processor.includes('await streamEndPublish'))
  assert.ok(processor.includes('prior_turn_wait: priorTurnWaitMs'))
  assert.ok(!worker.includes('redis.del(generationLockKey('))
  assert.ok(worker.includes('finally {\n      stopHeartbeat()\n      // Success'))
  assert.ok(controllerSource.includes("'NX',"))
  assert.ok(CAS.indexOf('redis.call("publish"') < CAS.indexOf('redis.call("del"'))
  assert.ok(CAS.includes('if (current or "") ~= ARGV[1] then return 0 end'))
  assert.ok(CAS.includes('"KEEPTTL"'))
})
console.log(`${pass} passed, ${fail} failed`)
if (fail) process.exit(1)

if (!mutantPath) {
  const original = readFileSync(new URL('../src/utils/generation-lock.ts', import.meta.url), 'utf8')
  const scratch = mkdtempSync(join(tmpdir(), 'metadata-overlap-'))
  const mutations = [
    ['(a) open before stream end', "slots.phase !== 'tail'", "slots.phase !== 'running'", '(a)'],
    ['(b,c) skip predecessor barrier', "const outcome = await redis.get(outcomeKey(key, priorTurnId))", "return now() - startedAt\n      const outcome = await redis.get(outcomeKey(key, priorTurnId))", '(b,c,d)'],
    ['(d) suppress completion frame', "token, success ? 'saved' : 'failed', channel, frame", "token, success ? 'saved' : 'failed', '', ''", '(d)'],
    ['(e) treat failed predecessor as saved', "if (expired || outcome === 'failed') throw unavailable()", "if (expired || outcome === 'failed') return 0", '(e)'],
    ['(e) remove wall-clock deadline', 'expired = true; reject(unavailable())', 'expired = true; void reject', '(e)'],
    ['(f) let waiter renew dead head', "generationSlots(before)?.owner === token", "(generationSlots(before)?.owner === token || generationSlots(before)?.next === token)", '(f)'],
    ['(g) leave an empty primary key while waiter holds', "JSON.stringify({ owner: slots.next, phase: 'running' }) : null", "null : null", '(g)'],
    ['(a) replace an already admitted waiter', " || slots.next) return null", " ) return null", '(a)'],
  ]
  try {
    const rewriteImports = (source: string, originalPath: URL) => source.replace("from 'mongodb'", `from '${new URL('../node_modules/mongodb', import.meta.url).pathname}'`).replace(
      /from '(\.\.?\/[^']+)'/g, (_match, path: string) => `from '${new URL(path, originalPath).pathname}'`,
    )
    const packetUrl = new URL('../src/services/context-packet.service.ts', import.meta.url)
    const extraMutations = [
      ['(c) omit newest event from packet', 'recentEvents.reverse()', 'recentEvents.splice(0, 1); recentEvents.reverse()', '(b,c,d)', 'packet'],
      ['(c) reuse dispatch session', 'session = await instanceService.loadSession(instanceId, playerId)', 'session = dispatchedSession', 'wiring', 'processor'],
      ['(g) bypass exclusive rewind/edit NX', "      'NX',", "      undefined,", '(g)', 'controller'],
    ]
    for (const [label, before, after, expected, target = 'lock'] of [...mutations, ...extraMutations]) {
      const source = target === 'processor' ? processor : target === 'controller' ? controllerSource : target === 'packet' ? readFileSync(packetUrl, 'utf8') : original
      assert.ok(source.includes(before), `mutation anchor: ${label}`)
      const path = join(scratch, 'lock.ts'), processorPath = join(scratch, 'processor.ts'), controllerPath = join(scratch, 'controller.ts'), packetPath = join(scratch, 'packet.ts')
      writeFileSync(path, target === 'lock' ? source.replace(before, after) : original)
      writeFileSync(processorPath, target === 'processor' ? source.replace(before, after) : processor)
      writeFileSync(controllerPath, rewriteImports(target === 'controller' ? source.replace(before, after) : controllerSource, new URL('../src/controllers/chronicle.controller.ts', import.meta.url)))
      writeFileSync(packetPath, rewriteImports(target === 'packet' ? source.replace(before, after) : readFileSync(packetUrl, 'utf8'), packetUrl))
      const child = Bun.spawn(['bun', '--no-env-file', 'run', import.meta.path, path, processorPath, controllerPath, packetPath], { stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' })
      const timer = setTimeout(() => child.kill(), 12000)
      const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
      clearTimeout(timer)
      assert.notEqual(code, 0, `mutation survived: ${label}`)
      assert.ok(`${stdout}${stderr}`.includes(`FAIL ${expected}`), `wrong failure for ${label}: ${stdout}${stderr}`)
      console.log(`BITE ${label}: exit ${code}, FAIL ${expected}`)
    }
  } finally { rmSync(scratch, { recursive: true, force: true }) }
}

/** Run the existing live-oriented rewind audit with fake collections instead of
 * connecting to a save. Rewind/codex/entity graph implementations stay real. */
async function runPureRewindAudit(): Promise<never> {
  const root = new URL('..', import.meta.url).pathname.replace(/\/$/, '')
  type Row = Record<string, any> // Heterogeneous fake Mongo documents/operators only.
  const clone = (v: any): any => v instanceof ObjectId || v instanceof Date ? v : Array.isArray(v) ? v.map(clone) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clone(x)])) : v
  function get(v: any, path: string): any {
    if (!path) return v
    const [k, ...rest] = path.split('.')
    return Array.isArray(v) ? v.flatMap((x) => get(x, path)).filter((x) => x !== undefined) : v == null ? undefined : rest.length ? get(v[k], rest.join('.')) : v[k]
  }
  const eq = (a: any, b: any): boolean => Array.isArray(a) ? a.some((v) => eq(v, b)) : a instanceof ObjectId || b instanceof ObjectId ? String(a) === String(b) : a === b
  function matches(row: Row, filter: Row): boolean {
    return Object.entries(filter).every(([key, expected]) => key === '$or' ? expected.some((x: Row) => matches(row, x)) : key === '$and' ? expected.every((x: Row) => matches(row, x)) : valueMatch(get(row, key), expected))
  }
  function valueMatch(actual: any, expected: any): boolean {
    if (expected instanceof RegExp) return expected.test(String(actual || ''))
    if (!expected || typeof expected !== 'object' || expected instanceof ObjectId || expected instanceof Date) return expected === null ? actual == null : eq(actual, expected)
    return Object.entries(expected).every(([op, v]: [string, any]) => {
      switch (op) {
        case '$in': return v.some((x: any) => eq(actual, x))
        case '$nin': return !v.some((x: any) => eq(actual, x))
        case '$ne': return !eq(actual, v)
        case '$eq': return eq(actual, v)
        case '$gte': return actual >= v
        case '$gt': return actual > v
        case '$lte': return actual <= v
        case '$lt': return actual < v
        case '$exists': return (actual !== undefined) === v
        case '$size': return Array.isArray(actual) && actual.length === v
        case '$type': return v === 'array' ? Array.isArray(actual) : typeof actual === v
        case '$not': return !valueMatch(actual, v)
        default: if (op.startsWith('$')) throw new Error(`unsupported filter ${op}`); return matches(actual || {}, expected)
      }
    })
  }
  function set(row: Row, path: string, value: any, unset = false) {
    const parts = path.split('.'), last = parts.pop()!
    for (const part of parts) row = row[part] ||= {}
    if (unset) delete row[last]; else row[last] = clone(value)
  }
  class Collection {
    rows: Row[] = []
    find(filter: Row = {}) {
      let rows = this.rows.filter((row) => matches(row, filter))
      const cursor = { sort: (order: Row) => { rows.sort((a, b) => { for (const [key, dir] of Object.entries(order)) { const av = get(a, key), bv = get(b, key); if (!eq(av, bv)) return (av < bv ? -1 : 1) * Number(dir) } return 0 }); return cursor },
        limit: (n: number) => { rows = rows.slice(0, n); return cursor }, project: () => cursor,
        toArray: async () => clone(rows), [Symbol.asyncIterator]: async function* () { yield* clone(rows) } }
      return cursor
    }
    async findOne(filter: Row) { return clone(this.rows.find((row) => matches(row, filter)) || null) }
    async countDocuments(filter: Row = {}) { return this.rows.filter((row) => matches(row, filter)).length }
    async insertOne(row: Row) { this.rows.push(clone({ _id: new ObjectId(), ...row })); return { insertedId: row._id } }
    async insertMany(rows: Row[]) { for (const row of rows) await this.insertOne(row) }
    async deleteMany(filter: Row) { const size = this.rows.length; this.rows = this.rows.filter((row) => !matches(row, filter)); return { deletedCount: size - this.rows.length } }
    async deleteOne(filter: Row) { const found = this.rows.find((row) => matches(row, filter)); return this.deleteMany({ _id: found?._id }) }
    async updateOne(filter: Row, update: Row, opts: Row = {}) {
      let row = this.rows.find((row) => matches(row, filter)); const isNew = !row
      if (!row && opts.upsert) { row = { _id: new ObjectId(), ...clone(Object.fromEntries(Object.entries(filter).filter(([k, v]) => !k.startsWith('$') && (v == null || typeof v !== 'object' || v instanceof ObjectId)))) }; this.rows.push(row) }
      if (!row) return { matchedCount: 0 }
      if (Array.isArray(update)) throw new Error('pipeline update unsupported')
      for (const [op, fields] of Object.entries(update)) for (const [path, value] of Object.entries(fields as Row)) {
        if (op === '$set' || op === '$setOnInsert' && isNew) set(row, path, value)
        else if (op === '$setOnInsert') continue
        else if (op === '$unset') set(row, path, undefined, true)
        else if (op === '$inc') set(row, path, Number(get(row, path) || 0) + Number(value))
        else if (op === '$max') set(row, path, Math.max(get(row, path) ?? -Infinity, value))
        else if (op === '$min') set(row, path, Math.min(get(row, path) ?? Infinity, value))
        else if (op === '$pull') set(row, path, (get(row, path) || []).filter((x: any) => !valueMatch(x, value)))
        else if (op === '$push' || op === '$addToSet') {
          let values = [...(get(row, path) || [])]; const add = (value as Row)?.$each || [value]
          for (const v of add) if (op === '$push' || !values.some((x) => eq(x, v))) values.push(v)
          if ((value as Row)?.$slice) values = values.slice((value as Row).$slice)
          set(row, path, values)
        } else throw new Error(`unsupported update ${op}`)
      }
      return { matchedCount: 1, modifiedCount: 1 }
    }
    async updateMany(filter: Row, update: Row) { for (const row of this.rows.filter((r) => matches(r, filter))) await this.updateOne({ _id: row._id }, update) }
    async bulkWrite(ops: Row[]) { for (const op of ops) { if (op.updateOne) await this.updateOne(op.updateOne.filter, op.updateOne.update, op.updateOne); else if (op.insertOne) await this.insertOne(op.insertOne.document); else if (op.deleteOne) await this.deleteOne(op.deleteOne.filter); else throw new Error('unsupported bulk operation') } }
  }
  const collections = new Map<string, Collection>()
  const coll = (name: string) => { if (!collections.has(name)) collections.set(name, new Collection()); return collections.get(name)! }
  const mongoColl = new Proxy({}, { get: (_t, key) => () => coll(String(key)) })
  mock.module(`${root}/src/config/mongo.ts`, () => ({ mongoColl, connectMongo: async () => {}, coll }))
  mock.module(`${root}/src/config/redis.ts`, () => ({ connectRedis: async () => {}, getQueueRedisClient: () => { throw new Error('Queue forbidden') }, getRedisSubscriber: () => { throw new Error('Subscriber forbidden') }, getRedisClient: () => ({ del: async () => 0, get: async () => null, publish: async () => 0 }) }))
  globalThis.fetch = Object.assign(async () => { throw new Error('Network forbidden: pure rewind fixture') }, { preconnect() { throw new Error('Network forbidden') } })
  const source = new ObjectId(), player = new ObjectId(), template = new ObjectId()
  await coll('worldTemplates').insertOne({ _id: template, base_stats_template: {}, flag_definitions: {}, protagonist: { name: 'Fixture protagonist' }, is_sentient: false })
  await coll('worldInstances').insertOne({ _id: source, template_id: template, player_id: player, meta: { total_events: 4, total_memories: 0, milestones: [] } })
  for (let sequence = 0; sequence <= 3; sequence++) await coll('events').insertOne({ _id: new ObjectId(), instance_id: source, player_id: player, sequence, scene_tag: 'dialogue', data: { ai_response: 'Fixture prose', state_mutations: {}, flag_mutations: {} } })
  await coll('characters').insertOne({ _id: new ObjectId(), instance_id: source, player_id: player, canonical_name: 'Fixture protagonist', name_normalized: 'fixture protagonist', is_protagonist: true, aliases: ['Fixture referent'], immutable_facts: [], mutable_state: [] })
  process.argv[2] = String(source); process.argv[3] = '2'
  console.log('Pure rewind fixture: fake Mongo/Redis; network denied; real rewind/codex/entity graph services.')
  await import('./rewind-audit')
  // The existing audit exits from main() after its assertions and cleanup.
  return await new Promise<never>(() => {})
}
