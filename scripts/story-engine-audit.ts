import assert from 'node:assert/strict'
import { mock } from 'bun:test'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { ObjectId, type Document } from 'mongodb'
import { Elysia } from 'elysia'
import { startTraceAuditMongo } from './story-engine-fixtures'
import type { LLMCallDoc } from '../src/models/llm-call.model'
import type { GenerationLogDoc } from '../src/models/generation-log.model'

const local = await startTraceAuditMongo()
mock.module('../src/config/mongo', () => ({ coll: (name: string) => local.db.collection(name), mongoColl: {} }))
mock.module('../src/config/env', () => ({ env: { ADMIN_USERNAME: 'fixture-admin', ADMIN_PASSWORD: 'fixture-password' } }))
// Keep the real auth hook, parser and constant-time comparison. Only its rate
// limiter's storage is a fixture; no external Redis is ever contacted.
mock.module('../src/config/redis', () => ({ getRedisClient: () => ({ get: async () => null, incr: async () => 1, expire: async () => 1, ttl: async () => 900 }) }))
const { adminStoryEngineRoutes } = await import('../src/routes/admin-story-engine.routes')
const { explainStoryTurn, storyLabel } = await import('../src/services/story-engine-explain')
const { runWithLLMTrace, beginLLMTrace, snapshotLLMTrace, settleLLMTrace, traceProvider } = await import('../src/ai/usage')
const { flushLLMTraces } = await import('../src/services/llm-trace.service')
const app = new Elysia({ prefix: '/admin' }).use(adminStoryEngineRoutes)
const instance = new ObjectId(), player = new ObjectId(), world = new ObjectId(), logId = new ObjectId(), legacyId = new ObjectId()
const at = Date.now() - 20000
let callId = ''
const auth = { authorization: `Basic ${Buffer.from('fixture-admin:fixture-password').toString('base64')}` }
let passes = 0
function pass(label: string) { passes++; console.log(`PASS ${label}`) }
async function send(path: string, authenticated = true) { return app.handle(new Request(`http://localhost/admin/story-engine${path}`, { headers: authenticated ? auth : {} })) }
const baseTurn = { _id: logId, instance_id: instance, player_id: player, sequence: 7, model_used: 'fixture/narrator',
  created_at: new Date(at + 10000), dispatched_at: new Date(at), narrator_started_at: new Date(at + 1000), first_word_at: new Date(at + 4000), reply_ended_at: new Date(at + 6000),
  latency_ms: 5000, ttft_ms: 3000, end_to_end_ttft_ms: 4000, stream_ms: 2000, post_stream_ms: 4000, context_latency_ms: 900,
  prep_stages: { vector: 600, codex: 300 }, tail_stages: { choice_metadata: 3500 }, pre_narrator_stages: { prompt_build: 100 },
  turn_cost_usd: .003, call_count: 2, failed_call_count: 0, provider: 'Fixture host', hedged: false }
try {
  await local.db.collection('generation_logs').insertMany([baseTurn, { ...baseTurn, _id: legacyId, sequence: 6, created_at: new Date(at - 20000), call_count: undefined }])
  await local.db.collection('world_instances').insertOne({ _id: instance, template_id: world })
  await local.db.collection('world_templates').insertOne({ _id: world, title: 'Fixture world' })
  await runWithLLMTrace({ instance_id: instance, player_id: player, sequence: 7 }, async () => {
    for (const [purpose, start, duration, usd, phase] of [
      ['narration', 1000, 5000, .002, 'reply'], ['choice_metadata', 6000, 3500, .001, 'after_reply'],
      ['memory_curation', 9000, 1000, .0005, 'background'],
    ] as const) {
      const trace = beginLLMTrace({ model: purpose === 'narration' ? 'fixture/narrator' : 'fixture/metadata', purpose,
        streamed: purpose === 'narration', messages: [{ role: 'user', content: 'Private fixture story' }], params: {},
        sections: [{ name: 'player_input', chars: 21 }] })!
      settleLLMTrace(trace)
      Object.assign(trace.call, { started_at: new Date(at + start), created_at: new Date(at + start), duration_ms: duration, phase, attempts: 1 })
      traceProvider(trace, { provider: 'Fixture host', choices: [{ finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110, cost: usd, prompt_tokens_details: { cached_tokens: 72 }, completion_tokens_details: { reasoning_tokens: 2 } } })
      trace.response = 'Private fixture reply'
      if (purpose === 'narration') callId = trace.call._id.toHexString()
    }
    await flushLLMTraces(snapshotLLMTrace(), 7, new Date(at + 1000))
  })
  const paths = ['/turns', `/turns/${logId}`, `/calls/${callId}/body`, '/summary']
  for (const path of paths) {
    const response = await send(path, false)
    assert.equal(response.status, 401, `${path} must require credentials`)
    assert.deepEqual(await response.json(), { error: 'Unauthorized' })
    pass(`401 without credentials: ${path.replace(/[a-f0-9]{24}/g, ':id')}`)
  }
  for (const path of paths) { assert.equal((await send(path)).status, 200, path); pass(`200 with valid admin auth: ${path.replace(/[a-f0-9]{24}/g, ':id')}`) }
  const list = await (await send('/turns?limit=1')).json()
  assert.equal(list.total, 2); assert.equal(list.items.length, 1); assert.equal(list.items[0].world_id, world.toHexString())
  assert.equal(list.items[0].world_title, 'Fixture world'); assert.equal(list.items[0].slowest.label, 'Narrator')
  assert.doesNotMatch(JSON.stringify(list), /Private fixture/)
  pass('list pagination, indexed page lookups, world metadata and no player text')
  for (const query of [`model=fixture%2Fmetadata`, `world_id=${world}`, `instance_id=${instance}`, 'slow=first_word', 'slow=after_reply', 'min_cost_usd=0.001', 'failed=false']) assert.equal((await (await send(`/turns?${query}`)).json()).total, query.startsWith('model=') ? 1 : 2)
  assert.equal((await (await send('/turns?failed=true')).json()).total, 0)
  assert.equal((await (await send('/turns?from=2099-01-01T00%3A00%3A00Z')).json()).total, 0)
  pass('model, world, save, slow, failed, cost and date filters')
  const detail = await (await send(`/turns/${logId}`)).json()
  assert.equal(detail.calls.length, 3); assert.equal(detail.calls[0].offset_ms, 1000)
  assert.equal(detail.anchors.done_at, baseTurn.created_at.toISOString())
  assert.equal(detail.turn.prep_stages.vector, 600)
  assert.equal(detail.cost.total, .0035); assert.equal(detail.cost.background, .0005)
  assert.equal(detail.tokens.cached, 216); assert.equal(detail.tokens.reasoning, 6)
  assert.equal(detail.prompt_sections[0].label, 'Player input')
  const legacy = await (await send(`/turns/${legacyId}`)).json()
  assert.equal(legacy.legacy, true); assert.deepEqual(legacy.calls, [])
  pass('detail anchors, labels, offsets, all costs/tokens and legacy fallback')
  const body = await (await send(`/calls/${callId}/body`)).json()
  assert.equal(body.response, 'Private fixture reply'); assert.equal(body.request[0].content, 'Private fixture story')
  assert.ok(Date.parse(body.expires_at) > Date.now())
  await local.db.collection('llm_call_bodies').updateOne({ _id: new ObjectId(callId) }, { $set: { created_at: new Date(Date.now() - 604801000) } })
  const expired = await send(`/calls/${callId}/body`)
  assert.equal(expired.status, 404); assert.deepEqual(await expired.json(), { error: 'This text is no longer kept (bodies are kept 7 days).' })
  pass('body text only on authenticated body route, TTL enforced before Mongo sweep')
  for (const path of ['/turns/not-an-id', '/calls/no/body', '/turns?limit=101', '/turns?page=1.5', '/turns?instance_id=no', '/turns?world_id=no', '/turns?from=tomorrow', '/summary?days=91', '/summary?days=1.5']) assert.equal((await send(path)).status, 422, path)
  assert.equal((await send(`/turns/${new ObjectId()}`)).status, 404)
  pass('invalid ids and query parameters rejected before database conversion')
  const summary = await (await send('/summary?days=7')).json()
  assert.equal(summary.reliability.calls, 3); assert.equal(summary.reliability.error_rate, 0)
  assert.ok(Math.abs(summary.cost.per_turn_avg_usd - .00325) < 1e-12); assert.ok(Math.abs(summary.cost.per_turn_p50_usd - .00325) < 1e-12)
  assert.equal(summary.cost.total_usd, .0035); assert.equal(summary.cost.by_provider[0].provider, 'Fixture host')
  assert.equal(summary.first_word_daily[0].p50_ms, 4000); assert.equal(summary.after_reply_daily[0].p90_ms, 4000)
  assert.equal(summary.slowest_call_types[0].purpose, 'narration')
  pass('summary percentiles, costs, reliability, provider and slowest purposes')
  const calls = await local.db.collection<LLMCallDoc>('llm_calls').find().sort({ started_at: 1 }).toArray()
  const turn = baseTurn as unknown as GenerationLogDoc
  const host = explainStoryTurn(turn, calls)
  assert.match(host.headline, /host took 3.0 s.*75%/); assert.ok(host.points.some(p => /72%.*cache/.test(p)))
  pass('explainer fixture 1: narrator dominated, tail pace and cache')
  const prep = explainStoryTurn({ ...turn, ttft_ms: 500, prep_stages: { vector: 3200 } }, calls)
  assert.match(prep.headline, /Memory search.*3.5 s preparation/)
  pass('explainer fixture 2: preparation dominated and largest step named')
  const hedged = explainStoryTurn({ ...turn, hedged: true, hedge_winner: 'hedge' }, [
    { ...calls[0], role: 'primary', status: 'aborted', won: false },
    { ...calls[0], _id: new ObjectId(), role: 'hedge', won: true, started_at: new Date(calls[0].started_at.getTime() + 3500) },
  ])
  assert.ok(hedged.points.some(p => /3.5 s.*second copy won/.test(p)))
  pass('explainer fixture 3: hedge threshold and winner')
  const fallback = explainStoryTurn({ ...turn, fallback_attempts: [{ from: 'fixture/busy', to: 'fixture/fallback' }] }, [
    { ...calls[0], attempts: 3, status: 'error', error: { kind: 'rate_limited', message: 'Busy' } },
    { ...calls[0], role: 'fallback', finish_reason: 'length' },
  ])
  assert.ok(fallback.points.some(p => /busy.*rate-limited.*fixture\/fallback/.test(p)))
  assert.ok(fallback.points.some(p => /3 HTTP attempts.*2 retries/.test(p)))
  assert.ok(fallback.points.some(p => /failed.*model was busy/.test(p)))
  assert.ok(fallback.points.some(p => /length limit.*cut/.test(p)))
  pass('explainer fixture 4: fallback, retries, errors and length cap')
  const normal = explainStoryTurn({ ...turn, end_to_end_ttft_ms: 1400, post_stream_ms: 1600, ttft_ms: 900 }, [])
  assert.equal(normal.headline, 'A normal turn: first word in 1.4 s, done 1.6 s after the reply.')
  assert.equal(storyLabel('future_purpose'), 'future_purpose')
  pass('explainer fixture 5: normal turn and visible unknown purposes')
  const source = readFileSync('src/services/story-engine.service.ts', 'utf8')
  assert.ok(source.indexOf('{ $limit: limit }') < source.indexOf('pairLookup(),'))
  const plan = await local.db.collection('llm_calls').find({ instance_id: instance, sequence: 7 }).explain('queryPlanner')
  assert.match(JSON.stringify(plan.queryPlanner.winningPlan), /IXSCAN/)
  const logPlan = await local.db.collection('generation_logs').find().sort({ created_at: -1, _id: -1 }).explain('queryPlanner')
  assert.match(JSON.stringify(logPlan.queryPlanner.winningPlan), /IXSCAN/)
  pass('turn pair lookup and turn list ordering actually use indexes created by the store')
  function files(path: string): string[] { return readdirSync(path, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? files(join(path, entry.name)) : [join(path, entry.name)]) }
  for (const file of [...files('src/routes'), ...files('src/controllers')]) {
    if (/admin/.test(file)) continue
    assert.doesNotMatch(readFileSync(file, 'utf8'), /llm_call_bodies|storyCallBody|story-engine\.service|llm-trace\.service/)
  }
  const adminRoutesSource = readFileSync('src/routes/admin.routes.ts', 'utf8')
  assert.equal((adminRoutesSource.match(/\.use\(requireAdmin\)\n\s*\.use\(adminStoryEngineRoutes\)/g) ?? []).length, 1)
  pass('no player HTTP/socket route imports trace bodies; one admin mount')
  console.log(`Story engine audit: ${passes} passed, 0 failed`)
} finally { await local.close() }
