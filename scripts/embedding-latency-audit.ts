/**
 * QUERY EMBEDDING: one bounded request per turn, where its time goes, and what
 * happens when it stalls.
 *
 * Measured on prod (55 turns, Oct 23 2026): the OpenAI query embedding was p50
 * 539 ms and p90 3.5 s, and every turn requested it TWICE — `querySummaries` and
 * `queryRag` each embedded the same `ragQueryText` and the turn waited for the
 * slower one. Worker context assembly (p50 1.55 s, p95 6.0 s) was the largest
 * part of the player's first-word delay that we control.
 *
 * The fix is structural, so it is pinned structurally here:
 *   - identical texts share one flight, a stalled QUERY call is hedged once and
 *     then abandoned at a deadline, and retrieval degrades to its non-vector
 *     routes instead of losing the turn;
 *   - the BACKGROUND path (`embed`: lore chunking, memory curation, summaries)
 *     keeps the SDK's patience and is never hedged or abandoned;
 *   - the worker starts the query embedding before it reads anything, from the
 *     same helper the packet uses, so retrieval inherits a flight in the air;
 *   - every prep step reports its own milliseconds on `prep_stages`.
 *
 * No network, no env, no Mongo: the client is injected through the seam in
 * `src/ai/embedding.ts`, the collections are in memory, and every external
 * service the packet touches is a stub with a deliberate sleep so the stage
 * timings have something to attribute.
 *
 *   bun --no-env-file run scripts/embedding-latency-audit.ts
 */
import assert from 'node:assert/strict'
import { mock } from 'bun:test'
import { readFileSync } from 'node:fs'
import { ObjectId } from 'mongodb'

let pass = 0
let fail = 0
async function check(label: string, fn: () => Promise<void>) {
  try {
    await fn()
    pass++
    console.log(`  ok   ${label}`)
  } catch (err) {
    fail++
    console.log(`  FAIL ${label}\n       ${(err as Error).message}`)
  }
}

const unavailable = (): never => {
  throw new Error('External dependency reached in embedding audit')
}

// ── Boundaries ────────────────────────────────────────────────────────────────
// The timing knobs moved into `src/config/env.ts`. Read their shipped defaults
// out of the source so the audit asserts the numbers that ship instead of a
// second copy of them; a missing default fails loudly here.
const envSource = readFileSync(new URL('../src/config/env.ts', import.meta.url), 'utf8')
function shippedMs(name: string): number {
  const match = envSource.match(new RegExp(`${name}: '(\\d+)'`))
  if (!match) throw new Error(`${name} default not found in src/config/env.ts`)
  return Number(match[1])
}
const SHIPPED_HEDGE_MS = shippedMs('EMBED_HEDGE_MS')
const SHIPPED_DEADLINE_MS = shippedMs('EMBED_DEADLINE_MS')

// A missing key must not reach a client: the query path builds its request from
// a constant model + dimension, and the audit injects the client anyway.
const env = {
  OPENAI_API_KEY: '',
  OPENROUTER_API_KEY: '',
  NARRATION_SFW_MODEL: 'audit-narration',
  NARRATION_NSFW_MODEL: 'audit-narration-nsfw',
  NARRATION_SFW_FALLBACK_MODELS: [],
  NARRATION_NSFW_FALLBACK_MODELS: [],
  CHEAP_RANK_MODEL: 'audit-cheap-rank',
  IMAGE_MODEL: 'audit-image',
  AUTHORING_MODEL: 'audit-authoring',
  TTS_MODEL: 'audit-tts',
  RAG_RERANK_ENABLED: false,
  EMBED_HEDGE_MS: SHIPPED_HEDGE_MS,
  EMBED_DEADLINE_MS: SHIPPED_DEADLINE_MS,
}
mock.module('../src/config/env', () => ({ env }))
mock.module('../src/config/openai', () => ({ getOpenAI: unavailable, getOpenRouter: unavailable }))

const warnings: Array<{ msg: string; fields: Record<string, unknown> }> = []
mock.module('../src/utils/logger', () => ({
  log: {
    debug() {},
    info() {},
    warn(msg: string, fields: Record<string, unknown> = {}) {
      warnings.push({ msg, fields })
    },
    error() {},
  },
}))

// The vector half of retrieval is counted, never served: the timeout check
// asserts it was not reached at all, and the healthy check asserts it was.
// A small sleep makes it visible as its own prep stage.
let vectorCalls = 0
mock.module('../src/services/vector-store', () => ({
  vectorStore: {
    query: async () => {
      vectorCalls++
      await Bun.sleep(4)
      return { matches: [], namespace: '' }
    },
  },
}))

// ── The in-memory collections the packet and retrieval read ───────────────────
const keywordDoc = {
  _id: new ObjectId('000000000000000000000101'),
  text: 'The steward keeps the south gate key.',
  importance: 3,
  subject_entity_ids: [],
  object_entity_ids: [],
}
const threadDoc = {
  _id: new ObjectId('000000000000000000000102'),
  text: 'Promise: return the locket.',
  importance: 4,
  unresolved_thread: true,
}
const stewardCard = {
  _id: new ObjectId('000000000000000000000103'),
  entity_id: new ObjectId('000000000000000000000104'),
  canonical_name: 'The steward',
  aliases: [] as string[],
  mention_count: 3,
  last_seen_sequence: 10,
  life_state: 'alive',
}
const fixtureEvents = [
  {
    _id: new ObjectId('000000000000000000000105'),
    sequence: 11,
    location_anchor: { name: 'The Counting House' },
    data: { player_input: 'I ask about the gate.', ai_response: 'The steward looks up.' },
  },
  {
    _id: new ObjectId('000000000000000000000106'),
    sequence: 10,
    location_anchor: { name: 'The Counting House' },
    data: { player_input: 'I enter.', ai_response: 'Dust turns in the lamplight.' },
  },
]
function cursor<T>(rows: T[], settleMs = 0) {
  const api = {
    sort: () => api,
    limit: () => api,
    toArray: async () => {
      if (settleMs > 0) await Bun.sleep(settleMs)
      return rows
    },
  }
  return api
}
mock.module('../src/config/mongo', () => ({
  mongoColl: {
    memories: () => ({
      find: (query: { unresolved_thread?: boolean }) => {
        const rows = query?.unresolved_thread === true ? [threadDoc] : [keywordDoc]
        return cursor(rows)
      },
      updateMany: async () => ({ modifiedCount: 0 }),
    }),
    events: () => ({ find: () => cursor(fixtureEvents, 20) }),
    sceneSummaries: () => ({ findOne: async () => null }),
    characters: () => ({ find: () => cursor([stewardCard], 8) }),
    entities: () => ({ findOne: async () => null }),
    timelineBranches: () => ({ find: () => cursor([]) }),
  },
}))

// The packet's collaborators, each with a sleep so `prep_stages` has something
// to attribute. Only the shapes the packet reads.
let kinshipCalls = 0
mock.module('../src/services/entity-graph.service', () => ({
  entityGraphService: {
    normalizeEntityName: (name: string) => String(name || '').trim().toLowerCase(),
    findMentionedCharacterCards: async () => {
      await Bun.sleep(15)
      return { mentionedEntityIds: [] as string[], cards: [] }
    },
    wakeStubsByCues: async () => {
      await Bun.sleep(10)
      return { entityIds: [] as string[] }
    },
    characterCardsForEntities: async () => [],
    characterPositions: async () => {
      await Bun.sleep(5)
      return []
    },
    placeAncestry: async () => [],
  },
}))
mock.module('../src/services/kinship-graph.service', () => ({
  kinshipGraphService: {
    kinshipBrief: async () => {
      kinshipCalls++
      await Bun.sleep(5)
      return []
    },
  },
}))
mock.module('../src/services/time.service', () => ({
  timeService: { timelineContext: async () => 'Late afternoon.' },
}))
mock.module('../src/services/scene-state.service', () => ({
  loadCurrentSceneState: async () => null,
}))

// ── The injected embeddings client ────────────────────────────────────────────
// `behaviour` decides, per (text, Nth request for that text), what the client
// does. Requests are recorded so the count is the assertion, not a side effect;
// the options are recorded so "bounded" vs "SDK defaults" is asserted, not timed.
type FakeResponse = { data: Array<{ index: number; embedding: number[] }> }
type FakeOptions = { signal?: AbortSignal; timeout?: number; maxRetries?: number } | undefined
let behaviour: (text: string, nth: number) => Promise<FakeResponse> = () => new Promise(() => {})
const requests: Array<{ text: string; at: number; options: FakeOptions }> = []
const perText = new Map<string, number>()

const fakeClient = {
  embeddings: {
    create(body: { input: string }, options?: FakeOptions) {
      const nth = (perText.get(body.input) || 0) + 1
      perText.set(body.input, nth)
      requests.push({ text: body.input, at: Date.now(), options })
      return behaviour(body.input, nth)
    },
  },
}

const ok = (embedding: number[]): Promise<FakeResponse> =>
  Bun.sleep(20).then(() => ({ data: [{ index: 0, embedding }] }))
const hang = (): Promise<FakeResponse> => new Promise(() => {})

const embedding = await import('../src/ai/embedding')
const { embed, embedQuery, setEmbeddingClientForAudit, isEmbedTimeout, EMBED_HEDGE_MS, EMBED_DEADLINE_MS } = embedding
setEmbeddingClientForAudit(fakeClient)
// The RAG and summary searches pull their embedding from the barrel; point it at
// the module under test so the bounded path is the real one, not a copy.
mock.module('../src/ai', () => ({
  embed,
  embedQuery,
  isEmbedTimeout,
  callLLM: unavailable,
  AI_MODELS: { cheapRank: 'audit-cheap-rank' },
}))
const { queryRag, querySummaries } = await import('../src/providers/rag.provider')
const { buildContextPacket, ragQueryTextFor } = await import('../src/services/context-packet.service')
const { buildPrepStages, PREP_STAGE_KEYS } = await import('../src/models/generation-log.model')

function requestsFor(text: string): number {
  return requests.filter((entry) => entry.text === text).length
}

console.log('\none request per text, however many callers race for it:')
await check('two concurrent embeds of the same text share one request', async () => {
  behaviour = () => ok([0.5, 0.25])
  const [a, b] = await Promise.all([embedQuery('shared text'), embedQuery('shared text')])
  assert.deepEqual(a, [0.5, 0.25])
  assert.deepEqual(b, [0.5, 0.25])
  assert.equal(requestsFor('shared text'), 1)
})
await check('different texts are not collapsed', async () => {
  behaviour = () => ok([1, 0])
  await Promise.all([embedQuery('first text'), embedQuery('second text')])
  assert.equal(requestsFor('first text'), 1)
  assert.equal(requestsFor('second text'), 1)
})

console.log('\na stalled call is hedged once, and the faster answer wins:')
await check(`a first request slower than ${EMBED_HEDGE_MS}ms is duplicated`, async () => {
  behaviour = (_text, nth) => (nth === 1 ? hang() : ok([0.9, 0.1]))
  const started = Date.now()
  const vector = await embedQuery('hedged text')
  const elapsed = Date.now() - started
  assert.deepEqual(vector, [0.9, 0.1], 'the duplicate answered, so its vector must be the one returned')
  assert.equal(requestsFor('hedged text'), 2, 'exactly one duplicate — not a retry storm')
  assert.ok(elapsed >= EMBED_HEDGE_MS - 30, `duplicated too early (${elapsed}ms)`)
  assert.ok(elapsed < EMBED_HEDGE_MS + 500, `duplicate was not sent at the hedge (${elapsed}ms)`)
})
await check('a fast first request is never duplicated', async () => {
  behaviour = () => ok([0.2, 0.2])
  await embedQuery('prompt text')
  await Bun.sleep(EMBED_HEDGE_MS + 100)
  assert.equal(requestsFor('prompt text'), 1)
})

console.log('\nthe deadline is the deadline, not the SDK timeout plus retries:')
await check(`both requests stalled: embedQuery rejects at ${EMBED_DEADLINE_MS}ms`, async () => {
  behaviour = () => hang()
  warnings.length = 0
  const started = Date.now()
  let caught: unknown
  try {
    await embedQuery('stalled text')
  } catch (err) {
    caught = err
  }
  const elapsed = Date.now() - started
  assert.ok(caught, 'a stalled embedding must reject, not resolve')
  assert.ok(isEmbedTimeout(caught), `expected a deadline error, got ${String(caught)}`)
  assert.ok(elapsed >= EMBED_DEADLINE_MS - 30, `rejected before the deadline (${elapsed}ms)`)
  assert.ok(elapsed < EMBED_DEADLINE_MS + 800, `rejected long after the deadline (${elapsed}ms) — is a retry still running?`)
  assert.equal(requestsFor('stalled text'), 2)
  const timeouts = warnings.filter((entry) => entry.msg === 'embed.query_timeout')
  assert.equal(timeouts.length, 1, 'one embed.query_timeout line per stalled query embed')
  assert.equal(typeof timeouts[0]?.fields.ms, 'number')
  assert.ok(
    !JSON.stringify(timeouts[0]?.fields).includes('stalled text'),
    'the player\'s own text must never reach a log line',
  )
})

console.log('\na rejection is not a result:')
await check('a rejected embed is not cached', async () => {
  behaviour = () => Promise.reject(new Error('provider down'))
  await assert.rejects(embedQuery('rejected text'))
  const afterFirst = requestsFor('rejected text')
  assert.ok(afterFirst >= 1)
  await assert.rejects(embedQuery('rejected text'))
  assert.ok(requestsFor('rejected text') > afterFirst, 'the next call must try again instead of replaying the failure')
})
await check('a successful embed is cached, so a replay does not re-request', async () => {
  behaviour = () => ok([0.3, 0.3])
  await embedQuery('cached text')
  await embedQuery('cached text')
  assert.equal(requestsFor('cached text'), 1)
})

console.log('\nonly the path a player waits on is bounded:')
await check('the background path outlives the deadline, is never hedged, and keeps SDK defaults', async () => {
  // The query path is bounded on the wire, not just in its own timer.
  behaviour = () => ok([0.4, 0.1])
  await embedQuery('bounded query text')
  const bounded = requests.find((entry) => entry.text === 'bounded query text')
  assert.equal(bounded?.options?.timeout, EMBED_DEADLINE_MS, 'the query request must carry the deadline as its timeout')
  assert.equal(bounded?.options?.maxRetries, 0, 'SDK retries would stack up behind the deadline')

  // The background path: slower than the whole deadline, and still it waits.
  behaviour = () => Bun.sleep(EMBED_DEADLINE_MS + 150).then(() => ({ data: [{ index: 0, embedding: [0.7, 0.3] }] }))
  const started = Date.now()
  const vector = await embed('slow background text')
  const elapsed = Date.now() - started
  assert.deepEqual(vector, [0.7, 0.3], 'a background embedding must still deliver its vector')
  assert.ok(elapsed >= EMBED_DEADLINE_MS + 100, `background embed was cut short at ${elapsed}ms — it must not inherit the query deadline`)
  assert.equal(requestsFor('slow background text'), 1, 'a background embed must never be hedged')
  assert.equal(
    requests.find((entry) => entry.text === 'slow background text')?.options,
    undefined,
    'the background path must keep the SDK defaults, not the query timeout',
  )
})

console.log('\nretrieval loses its vector half, not the turn:')
await check('queryRag returns keyword and open-thread results through an embed timeout', async () => {
  behaviour = () => hang()
  vectorCalls = 0
  const instanceId = new ObjectId('000000000000000000000201').toHexString()
  const templateId = new ObjectId('000000000000000000000202').toHexString()
  const started = Date.now()
  const rag = await queryRag(templateId, instanceId, 'the south gate key', 10, 25)
  const elapsed = Date.now() - started
  assert.ok(elapsed >= EMBED_DEADLINE_MS - 30, `returned before the deadline (${elapsed}ms)`)
  assert.equal(vectorCalls, 0, 'no vector search may run without an embedding')
  assert.deepEqual(rag.loreTexts, [])
  assert.ok(
    rag.memoryTexts.includes('The steward keeps the south gate key.'),
    'keyword recall must survive the timeout',
  )
  assert.deepEqual(rag.openThreads, ['Promise: return the locket.'])
  assert.equal(rag.embedMs, 0, 'a timed-out embed contributes no embed time')
  assert.ok(
    rag.stageMs.embed_wait >= EMBED_DEADLINE_MS - 30,
    `the wait itself must still be attributed to embed_wait (got ${rag.stageMs.embed_wait}ms)`,
  )
})
await check('queryRag keeps its vector half, and reports the embed time it paid', async () => {
  behaviour = () => ok([0.4, 0.6])
  vectorCalls = 0
  const instanceId = new ObjectId('000000000000000000000301').toHexString()
  const templateId = new ObjectId('000000000000000000000302').toHexString()
  const rag = await queryRag(templateId, instanceId, 'a fresh query', 10, 25)
  assert.equal(vectorCalls, 2, 'lore and memory vector queries still run on a healthy embed')
  assert.ok(rag.embedMs >= 15, `the wait for the embed must be measured (got ${rag.embedMs}ms)`)
  assert.equal(requestsFor('a fresh query'), 1)
  assert.ok(rag.stageMs.vector >= 3, `the Pinecone half must be timed (got ${rag.stageMs.vector}ms)`)
  assert.ok(rag.stageMs.rag_mongo >= 0, 'the Mongo half must be timed')
})

console.log('\nan early start makes the retrieval call free:')
await check('a still-running early start and queryRag make exactly one request', async () => {
  const instanceId = new ObjectId('000000000000000000000401').toHexString()
  const templateId = new ObjectId('000000000000000000000402').toHexString()
  // Slow enough that the flight is still in the air when queryRag asks for it —
  // this is the shape of a real turn: the fence and the recent-events read run
  // while the embedding is in flight.
  behaviour = () => Bun.sleep(60).then(() => ({ data: [{ index: 0, embedding: [0.2, 0.8] }] }))
  const text = 'does the steward still hold the gate?'
  // The worker pattern: fired before the packet is built, never awaited.
  void embedQuery(text).catch(() => {})
  await Bun.sleep(10)
  const rag = await queryRag(templateId, instanceId, text, 10, 25)
  assert.equal(requestsFor(text), 1, 'the query search must inherit the flight, not buy a second embedding')
  assert.ok(
    rag.stageMs.embed_wait >= 20,
    `queryRag should have waited on the shared flight, not a fresh request (${rag.stageMs.embed_wait}ms)`,
  )
  assert.ok(rag.stageMs.embed_wait <= 90, `queryRag waited past the flight (${rag.stageMs.embed_wait}ms)`)
  assert.equal(rag.stageMs.embed_wait, rag.embedMs)
})

console.log('\nboth sites derive the query text the same way:')
await check('the shared helper returns what the packet searched before, for every turn shape', async () => {
  // The derivation the packet used inline before the helper existed. A plain
  // message, an action narration, a world action and a continuation all have to
  // land on the same text from both call sites.
  const legacy = (params: { isContinuation: boolean; userMessage: string; lastNarration?: string | null }) =>
    params.isContinuation
      ? String(params.lastNarration || '') || 'Continue the current scene.'
      : params.userMessage

  const actionNarration = '*I travel to the Ash Tavern with Mara.*'
  const cases: Array<{ label: string; input: Parameters<typeof ragQueryTextFor>[0] }> = [
    { label: 'plain message', input: { isContinuation: false, userMessage: 'I draw my knife.' } },
    { label: 'action narration', input: { isContinuation: false, userMessage: actionNarration } },
    // A world action reaches the packet as `actionNarration || userMessage`, the
    // exact expression the processor hands the early start.
    { label: 'world action', input: { isContinuation: false, userMessage: actionNarration || 'I draw my knife.' } },
    { label: 'continuation', input: { isContinuation: true, userMessage: '', lastNarration: 'The steward nods.' } },
    { label: 'empty continuation', input: { isContinuation: true, userMessage: '', lastNarration: '' } },
  ]
  for (const { label, input } of cases) {
    assert.equal(ragQueryTextFor(input), legacy(input), `${label}: helper and pre-helper derivation disagree`)
  }

  // …and neither site re-implements it. Two derivations would mean two different
  // embeddings for one turn, which is the cost this whole change exists to avoid.
  const packetSource = readFileSync(new URL('../src/services/context-packet.service.ts', import.meta.url), 'utf8')
  const processorSource = readFileSync(
    new URL('../worker/processors/generation.processor.ts', import.meta.url),
    'utf8',
  )
  assert.ok(
    packetSource.includes('const ragQueryText = ragQueryTextFor({'),
    'the packet must derive ragQueryText through the shared helper',
  )
  assert.ok(
    processorSource.includes('startQueryEmbedding(ragQueryTextFor({ isContinuation, userMessage: actionNarration || userMessage }))'),
    'the early start must derive its text through the helper, from `actionNarration || userMessage`',
  )
})

console.log('\nprep stages say where the turn waited:')
const packetInstanceId = new ObjectId('000000000000000000000501').toHexString()
const packetTemplateId = new ObjectId('000000000000000000000502').toHexString()
const packetPlayerId = new ObjectId('000000000000000000000503').toHexString()
const PACKET_TEXT = 'I ask the steward about the south gate key.'
let packetElapsedMs = 0
let packetStages: Record<string, number> = {}

await check('the packet times every prep step it owns, and the sum covers the elapsed time', async () => {
  behaviour = () => ok([0.1, 0.2])
  void embedQuery(PACKET_TEXT).catch(() => {})
  await Bun.sleep(30) // the fence + recent-events read the worker does first
  const started = Date.now()
  const packet = await buildContextPacket({
    instanceId: packetInstanceId,
    playerId: packetPlayerId,
    session: {
      template_id: packetTemplateId,
      is_sentient: false,
      max_lore_results: 10,
      max_context_memories: 25,
      current_time_anchor: {
        timeline_id: 'main',
        sequence: 11,
        real_time: new Date(0),
        causal_parent_event_ids: [],
      },
      // Provisional anchor: no entity id, so the packet never reads a place.
      current_location: { entity_id: null, name: 'The Counting House', name_normalized: 'the counting house' },
      travelling_with: [],
      seed_cast_snapshot: [],
    },
    userMessage: PACKET_TEXT,
    isContinuation: false,
  })
  packetElapsedMs = Date.now() - started
  packetStages = packet.prepStages as Record<string, number>

  for (const key of ['recent_events', 'mentions', 'stub_wake', 'summaries', 'embed_wait', 'vector', 'rag_mongo', 'codex', 'packet_tail'] as const) {
    assert.equal(typeof packetStages[key], 'number', `${key} must be timed`)
  }
  // The early start won: retrieval inherited a flight that had already settled,
  // so the packet waited for nothing embedding-shaped.
  assert.equal(requestsFor(PACKET_TEXT), 1, 'the packet and the early start must share one request')
  assert.ok(packetStages.embed_wait <= 15, `queryRag should not have waited for the embed (${packetStages.embed_wait}ms)`)
  assert.equal(packet.loreTexts.length + packet.memoryTexts.length > 0, true, 'the fixture must still retrieve')
  assert.equal(kinshipCalls, 1, 'the packet must run exactly one kinship read for this fixture')

  // Coverage: no prep time is unaccounted for, and the only double-count is the
  // summary search, which runs concurrently with RAG.
  const sum = Object.values(packetStages).reduce((total, ms) => total + (ms || 0), 0)
  const overlap = packetStages.summaries || 0
  assert.ok(sum >= packetElapsedMs - 15, `stages add up to ${sum}ms but the packet took ${packetElapsedMs}ms`)
  assert.ok(
    sum <= packetElapsedMs + overlap + 20,
    `stages add up to ${sum}ms, ${sum - packetElapsedMs - overlap}ms beyond the concurrent summary search`,
  )
  console.log(
    `       fixture: ${packetElapsedMs}ms elapsed, ${sum}ms staged (${JSON.stringify(packetStages)})`,
  )
})

await check('the log builder takes every known stage and drops everything else', async () => {
  const all = Object.fromEntries(PREP_STAGE_KEYS.map((key) => [key, 12.4])) as Record<string, number>
  const built = buildPrepStages(all)
  for (const key of PREP_STAGE_KEYS) {
    assert.equal(built[key], 12, `${key} must survive as a rounded integer`)
    assert.equal(Number.isInteger(built[key]), true, `${key} must be an integer`)
  }
  const noisy = buildPrepStages({
    fence: 5,
    embed_wait: -3,
    vector: Number.NaN,
    rag_mongo: Number.POSITIVE_INFINITY,
    not_a_stage: 9,
    post_packet: undefined,
  } as Record<string, number | undefined>)
  assert.deepEqual(noisy, { fence: 5 }, 'negative, non-finite, unknown and missing stages must be dropped')
})

await check('the processor writes those stages on the row it inserts', async () => {
  // The processor itself needs a BullMQ job, Redis, Mongo and the narrator, so it
  // has no pure seam to drive. This pins the wiring that carries a real packet's
  // stages onto the log document; the packet's own stages are checked above.
  const processorSource = readFileSync(
    new URL('../worker/processors/generation.processor.ts', import.meta.url),
    'utf8',
  )
  assert.ok(processorSource.includes('const prepStages = buildPrepStages({'), 'the processor must build stages through the builder')
  assert.ok(processorSource.includes('live_check: liveCheckMs'), 'the live check must be staged')
  assert.ok(processorSource.includes('fence: fenceMs'), 'the fence must be staged')
  assert.ok(processorSource.includes('...packet.prepStages'), 'the packet’s stages must be carried, not re-derived')
  assert.ok(
    processorSource.includes('post_packet: promptStartedAt - packetReturnedAt'),
    'the post-packet phase must be measured from the packet return to buildPrompt',
  )
  assert.ok(processorSource.includes('prep_stages: prepStages,'), 'the row must carry prep_stages')
})

console.log(`\nembedding latency audit: ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
