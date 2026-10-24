import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mock } from 'bun:test'
import { ObjectId } from 'mongodb'
import OpenAI from 'openai'
import { startTraceAuditMongo } from './story-engine-fixtures'
import { runWithLLMTrace, runWithLLMUsage, snapshotLLMTrace, snapshotLLMUsage, traceFetch, beginLLMTrace, settleLLMTrace, setLLMTraceSequence, traceProvider } from '../src/ai/usage'

mock.module('../src/config/env', () => ({ env: { OPENROUTER_PREFERRED_P90_LATENCY_SECONDS: 3, EMBED_HEDGE_MS: 15, EMBED_DEADLINE_MS: 100 } }))
const local = await startTraceAuditMongo()
mock.module('../src/config/mongo', () => ({ coll: (name: string) => local.db.collection(name), mongoColl: { events: () => local.db.collection('events') } }))
const { callLLM, callLLMStream, callLLMWithFallback, callLLMStreamWithFallback, setLLMClientForAudit, setNarrationStreamingClientForAudit, buildChatRequest } = await import('../src/ai/client')
const { embedQuery, setEmbeddingClientForAudit } = await import('../src/ai/embedding')
const { flushLLMTraces, flushLLMTracesLater, prepareTraceFlush, buildTraceBody, traceLogFields, runBackgroundLLMTrace } = await import('../src/services/llm-trace.service')
const { buildPrompt } = await import('../src/utils/prompt-builder')
const instance = new ObjectId(), player = new ObjectId()
const originalFetch = globalThis.fetch
const sent: Array<Record<string, unknown>> = []
const usage = { prompt_tokens: 100, completion_tokens: 12, total_tokens: 112, cost: .0003,
  prompt_tokens_details: { cached_tokens: 72 }, completion_tokens_details: { reasoning_tokens: 3 } }
let narrationRequests = 0
let failedRequests = 0
const sdk = new OpenAI({ apiKey: 'fixture-only', baseURL: 'http://fixture.invalid/v1', fetch: traceFetch })
setLLMClientForAudit(sdk)
setNarrationStreamingClientForAudit({ create: (body, options) => sdk.chat.completions.create(body as never, options) as never })
setEmbeddingClientForAudit({ embeddings: { create: (body, options) => sdk.embeddings.create({ ...body, encoding_format: 'float' }, options) } })
globalThis.fetch = Object.assign(async (_input: unknown, init?: RequestInit) => {
  const body = JSON.parse(String(init?.body)) as Record<string, unknown>
  sent.push(body)
  if (body.input) return Response.json({ data: [{ index: 0, embedding: [1, 2] }], usage: { prompt_tokens: 5, total_tokens: 5 } })
  if (body.model === 'fixture/fail') {
    failedRequests++
    return Response.json({ error: { message: 'Host temporarily unavailable', type: 'server_error' } }, { status: 500, headers: { 'retry-after-ms': '1' } })
  }
  if (body.model === 'fixture/busy') return Response.json({ error: { message: 'Model busy' } }, { status: 429 })
  if (body.stream) {
    narrationRequests++
    if (narrationRequests === 1) return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
    })
    const parts = [
      { id: 'gen-fixture', provider: 'Fixture host', choices: [{ delta: { content: 'A reply.' } }] },
      { id: 'gen-fixture', choices: [{ delta: {}, finish_reason: 'stop' }], usage },
    ]
    return new Response(parts.map(part => `data: ${JSON.stringify(part)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
  }
  return Response.json({ id: 'gen-structured', provider: 'Fixture host', choices: [{ message: { content: '{"ready":true}' }, finish_reason: 'stop' }], usage })
}, { preconnect: originalFetch.preconnect }) as typeof fetch
let passed = 0
function check(label: string, fn: () => void) { fn(); passed++; console.log(`PASS ${label}`) }
try {
  await runWithLLMTrace({ instance_id: instance, player_id: player }, () => runWithLLMUsage(async () => {
    const request = { model: 'fixture/narrator', purpose: 'narration', messages: [{ role: 'user', content: 'Continue.' }],
      temperature: .7, maxTokens: 20, promptSections: [{ name: 'player_input', chars: 9 }] }
    assert.deepEqual(await embedQuery('trace fixture query'), [1, 2])
    await Bun.sleep(2)
    const result = await callLLMStreamWithFallback(request, [], () => {})
    await callLLM({ ...request, model: 'openai/gpt-6-luna', purpose: 'choice_metadata', reasoningEffort: 'low', promptSections: undefined, responseFormat: { type: 'json_object' } })
    await assert.rejects(callLLM({ ...request, model: 'fixture/fail', purpose: 'scene_witness' }))
    await Bun.sleep(5) // Give the embedding loser's abort microtask a chance to settle.
    const records = snapshotLLMTrace(), calls = records.map(record => record.call)
    check('narrator hedge winner and aborted loser are both recorded', () => {
      assert.equal(result.hedgeWinner, 'hedge')
      const narrator = calls.filter(call => call.purpose === 'narration')
      assert.equal(narrator.length, 2)
      assert.equal(narrator.find(c => c.role === 'hedge')?.won, true)
      assert.equal(narrator.find(c => c.role === 'primary')?.status, 'aborted')
      assert.equal(narrator.find(c => c.role === 'primary')?.won, false)
    })
    check('HTTP attempts count SDK retries, errors are readable and bounded', () => {
      const failed = calls.find(c => c.purpose === 'scene_witness')!
      assert.equal(failed.attempts, failedRequests)
      assert.equal(failed.attempts, 3)
      assert.equal(failed.status, 'error')
      assert.equal(failed.http_status, 500)
      assert.match(failed.error!.message, /Host temporarily unavailable/)
      assert.ok(failed.error!.message.length <= 300)
    })
    check('dialect sampling metadata equals the sent body; trace fields never transmitted', () => {
      const call = calls.find(c => c.purpose === 'choice_metadata')!
      const body = sent.find(body => body.model === 'openai/gpt-6-luna')!
      assert.equal(call.max_tokens, body.max_completion_tokens)
      assert.equal(call.max_tokens, 1220)
      assert.equal(call.temperature, undefined)
      assert.equal(body.temperature, undefined)
      assert.equal(call.response_format, 'json_object')
      assert.equal(call.reasoning_effort, (body.reasoning as { effort: string }).effort)
      assert.deepEqual(call.prompt_sections, [{ name: 'user', chars: 9, tokens_est: 2.25 }])
      for (const body of sent) for (const key of ['promptSections', 'traceRole', 'purpose', 'sections']) assert.equal(key in body, false)
    })
    check('provider usage, timing, ids, phases and embedding fields are captured', () => {
      const narrator = calls.find(c => c.won === true)!
      assert.equal(narrator.provider, 'Fixture host'); assert.equal(narrator.generation_id, 'gen-fixture')
      assert.equal(narrator.cost_usd, .0003); assert.equal(narrator.cached_tokens, 72); assert.equal(narrator.reasoning_tokens, 3)
      assert.equal(narrator.finish_reason, 'stop'); assert.equal(narrator.http_status, 200); assert.equal(narrator.attempts, 1)
      assert.ok(narrator.first_token_ms! >= 0 && narrator.first_token_ms! <= narrator.duration_ms)
      assert.ok(calls.every(c => c.duration_ms >= 0 && c.purpose !== 'unlabeled' && c.instance_id?.equals(instance)))
      const embedding = calls.find(c => c.purpose === 'embedding_query')!
      assert.equal(embedding.provider, 'OpenAI'); assert.equal(embedding.total_tokens, 5); assert.equal(embedding.cost_usd, undefined)
      const rows = prepareTraceFlush(records, 7)
      assert.equal(rows.find(r => r.call.purpose === 'choice_metadata')?.call.phase, 'after_reply')
      assert.equal(rows.find(r => r.call.purpose === 'embedding_query')?.call.phase, 'before_reply')
      assert.ok(rows.filter(r => r.call.purpose === 'narration').every(r => r.call.phase === 'reply'))
      assert.ok(rows.every(r => r.call.sequence === 7))
      assert.equal(traceLogFields(records).failed_call_count, 1)
    })
    check('old usage snapshots retain exactly their historical keys and accounting', () => {
      const legacy = snapshotLLMUsage()
      assert.equal(legacy.length, 3)
      assert.ok(legacy.every(c => Object.keys(c).sort().join() === 'completion_tokens,model,prompt_tokens,purpose,streamed,total_tokens'))
    })
    const logId = new ObjectId()
    await local.db.collection('generation_logs').insertOne({ _id: logId })
    await flushLLMTraces(records, 7)
    assert.equal(await local.db.collection('llm_calls').countDocuments(), records.length)
    assert.equal(await local.db.collection('llm_call_bodies').countDocuments(), records.length)
    const indexes = await local.db.collection('llm_call_bodies').indexes()
    assert.ok(indexes.some(index => index.expireAfterSeconds === 604800))
    assert.equal((await local.db.collection('llm_calls').indexes()).length, 5)
    assert.ok((await local.db.collection('llm_calls').find().toArray()).every(c => !('request' in c) && !('response' in c)))
    check('real isolated Mongo stores every call and body with TTL and indexes', () => {})
    check('flush is chained after the log insert and never awaited by the turn', () => {
      const source = readFileSync('worker/processors/generation.processor.ts', 'utf8')
      assert.match(source, /\.insertOne\(\{[\s\S]+\.then\(\(\) => \{ flushLLMTracesLater\(traceRecords, nextSequence, narratorStartedAt\) \}\)/)
      assert.doesNotMatch(source, /await\s+(?:flushLLMTraces|flushLLMTracesLater)/)
    })
    check('body caps, markers, head/tail and total request cap hold', () => {
      const giant = { ...records[0], request: Array.from({ length: 20 }, () => ({ role: 'user', content: 'H'.repeat(20000) + 'TAIL' })), response: 'A'.repeat(14000) + 'END' }
      const body = buildTraceBody(giant)
      assert.ok(body.response.length <= 8000); assert.ok(body.response.endsWith('END')); assert.match(body.response, /chars cut/)
      assert.ok(body.request.every(m => m.content.length <= 8000))
      assert.ok(body.request.reduce((n, m) => n + m.content.length, 0) <= 48000)
      assert.ok(body.request[0].truncated_chars! > 0); assert.match(body.request.at(-1)!.content, /omitted/)
    })
  }))
  await runBackgroundLLMTrace({ instance_id: instance, player_id: player, sequence: 10 }, async () => {
    for (const sequence of [10, 11]) {
      setLLMTraceSequence(sequence)
      const trace = beginLLMTrace({ model: 'fixture/background', purpose: 'codex_extraction', streamed: false, messages: [], params: {} })!
      settleLLMTrace(trace)
    }
  })
  for (let i = 0; i < 100 && await local.db.collection('llm_calls').countDocuments({ model: 'fixture/background' }) < 2; i++) await Bun.sleep(10)
  const background = await local.db.collection('llm_calls').find({ model: 'fixture/background' }).sort({ sequence: 1 }).toArray()
  check('background flush retains each batched event sequence and scope', () => {
    assert.deepEqual(background.map(c => c.sequence), [10, 11])
    assert.ok(background.every(c => c.phase === 'background' && c.player_id.equals(player)))
  })
  await runWithLLMTrace({ instance_id: instance }, async () => {
    const trace = beginLLMTrace({ model: 'fixture/flush', purpose: 'scene_witness', streamed: false, messages: [], params: {} })!
    settleLLMTrace(trace, new Error('Fixture request failed'))
    setLLMTraceSequence(12)
    let release = () => {}
    const gate = new Promise<void>(resolve => { release = resolve })
    let bodyWrites = 0, callWrites = 0
    const target = { bodies: { insertMany: async () => { bodyWrites++; await gate } },
      calls: { insertMany: async () => { callWrites++ } } } as unknown as import('../src/services/llm-trace.service').TraceStore
    const records = snapshotLLMTrace()
    assert.equal(flushLLMTracesLater(records, undefined, undefined, target), undefined)
    flushLLMTracesLater(records, undefined, undefined, target)
    await Bun.sleep(5)
    assert.equal(bodyWrites, 1); assert.equal(callWrites, 0)
    release()
    await Bun.sleep(5)
    check('failed-turn cleanup is wired, flush never blocks and duplicate schedules write once', () => {
      assert.equal(callWrites, 1); assert.equal(trace.call.sequence, 12)
      const source = readFileSync('worker/processors/generation.processor.ts', 'utf8')
      assert.ok(source.includes('generationProcessor(job).catch('))
      assert.ok(source.includes('setLLMTraceSequence(nextSequence)'))
      assert.match(source, /catch\(\(error: unknown\) => \{\s*flushLLMTracesLater\(snapshotLLMTrace\(\)\)/)
    })
  })
  await runWithLLMTrace({ instance_id: instance }, async () => {
    const errors = [
      [new Error('LLM stream did not produce a first token within 10ms'), 'timeout', 'no_first_token'],
      [new Error('LLM stream stalled for 10ms'), 'timeout', 'stalled'],
      [Object.assign(new Error('busy'), { status: 429 }), 'error', 'rate_limited'],
      [new Error('Empty LLM response'), 'error', 'empty_response'],
      [new Error('Bad JSON'), 'error', 'bad_json'],
      [new Error('Request aborted'), 'aborted', 'aborted'],
    ] as const
    for (const [error, status, kind] of errors) {
      const trace = beginLLMTrace({ model: 'fixture/error', purpose: 'scene_witness', streamed: false,
        messages: [{ role: 'user', content: 'Private text' }], params: {} })!
      settleLLMTrace(trace, error)
      assert.equal(trace.call.status, status); assert.equal(trace.call.error?.kind, kind)
    }
    const providerFailure = beginLLMTrace({ model: 'fixture/error', purpose: 'scene_witness', streamed: true, messages: [], params: {} })!
    traceProvider(providerFailure, { choices: [{ finish_reason: 'error' }] })
    settleLLMTrace(providerFailure)
    assert.equal(providerFailure.call.status, 'error')
    assert.equal(providerFailure.call.error?.kind, 'provider_error')
    const trace = beginLLMTrace({ model: 'fixture/error', purpose: 'scene_witness', streamed: false,
      messages: [{ role: 'user', content: 'Private text' }], params: {} })!
    settleLLMTrace(trace, new Error('Private text sk-fixture-secret ' + 'x'.repeat(500)))
    check('all error kinds classify correctly and request text is redacted and capped', () => {
      assert.doesNotMatch(trace.call.error!.message, /Private text|sk-fixture-secret/)
      assert.equal(trace.call.error!.message.length, 300)
    })
  })
  await runWithLLMTrace({}, async () => {
    await callLLMStream({ model: 'fixture/stream', purpose: 'scene_witness', messages: [] }, () => {})
    const malformed = beginLLMTrace({ model: 'fixture/json', purpose: 'choice_metadata', streamed: false,
      messages: [], params: { response_format: { type: 'json_object' } } })!
    malformed.response = '{broken'
    settleLLMTrace(malformed)
    check('invalid JSON is traced without changing its raw text; usage stays opt-in', () => {
      assert.equal(malformed.call.status, 'error'); assert.equal(malformed.call.error?.kind, 'bad_json')
      assert.equal(malformed.response, '{broken')
      assert.equal(sent.at(-1)!.stream_options, undefined)
      assert.equal(snapshotLLMTrace()[0].call.purpose, 'scene_witness')
    })
  })
  await runWithLLMTrace({}, async () => {
    const result = await callLLMWithFallback({ model: 'fixture/busy', purpose: 'narration', messages: [], timeoutMs: 1000 }, ['fixture/fallback'])
    const calls = snapshotLLMTrace().map(r => r.call)
    check('rate-limit fallback records every model attempt and role', () => {
      assert.equal(result.model, 'fixture/fallback')
      assert.deepEqual(calls.map(c => c.role), ['primary', 'fallback'])
      assert.equal(calls[0].error?.kind, 'rate_limited'); assert.equal(calls[0].attempts, 1)
      assert.equal(calls[1].status, 'ok')
    })
  })
  setNarrationStreamingClientForAudit({ create: async () => (async function* () {
    yield { choices: [{ delta: { content: 'Partial private reply.' } }] }
  })() })
  await runWithLLMTrace({}, async () => {
    const controller = new AbortController()
    await assert.rejects(callLLMStream({ model: 'fixture/cancel', purpose: 'narration', messages: [], signal: controller.signal },
      () => controller.abort(new Error('Fixture cancellation'))))
    const [trace] = snapshotLLMTrace()
    check('cancelled streaming call retains partial body and aborted status', () => {
      assert.equal(trace.call.status, 'aborted'); assert.equal(trace.call.error?.kind, 'aborted')
      assert.equal(trace.response, 'Partial private reply.')
      assert.ok(trace.call.first_token_ms! <= trace.call.duration_ms)
    })
  })
  setNarrationStreamingClientForAudit({ create: () => new Promise(() => {}) })
  await runWithLLMTrace({}, async () => {
    await assert.rejects(callLLMStream({ model: 'fixture/timeout', purpose: 'narration', messages: [], firstTokenTimeoutMs: 10 }, () => {}))
    check('real first-token deadline settles even when stream opening ignores abort', () => {
      const [trace] = snapshotLLMTrace()
      assert.equal(trace.call.status, 'timeout'); assert.equal(trace.call.error?.kind, 'no_first_token')
      assert.ok(trace.call.duration_ms > 0)
    })
  })
  let embeddingRequests = 0
  setEmbeddingClientForAudit({ embeddings: { create: async () => {
    if (++embeddingRequests === 1) return new Promise(() => {}) // Ignore abort on purpose.
    return { data: [{ index: 0, embedding: [3, 4] }] }
  } } })
  await runWithLLMTrace({ instance_id: instance }, async () => {
    assert.deepEqual(await embedQuery('embedding hedge fixture'), [3, 4])
    const calls = snapshotLLMTrace().map(r => r.call)
    check('embedding hedge records winner and settles an abort-ignoring loser', () => {
      assert.equal(calls.length, 2)
      assert.equal(calls[0].status, 'aborted'); assert.equal(calls[0].won, false)
      assert.equal(calls[1].status, 'ok'); assert.equal(calls[1].won, true)
      assert.ok(calls[0].duration_ms > 0)
    })
  })
  setEmbeddingClientForAudit({ embeddings: { create: (_body, options) => new Promise((_resolve, reject) => {
    options?.signal?.addEventListener('abort', () => reject(new Error('Request aborted')), { once: true })
  }) } })
  await runWithLLMTrace({ instance_id: instance }, async () => {
    await assert.rejects(embedQuery('deadline fixture query'))
    await Bun.sleep(5)
    const calls = snapshotLLMTrace().map(r => r.call)
    check('embedding deadline records both copies as timeouts', () => {
      assert.equal(calls.length, 2)
      assert.ok(calls.every(c => c.status === 'timeout' && c.error?.kind === 'timeout'))
    })
  })
  check('buildPrompt messages match pre-change hashes; sections sum exactly', () => {
    for (const proseOnly of [true, false]) {
      const prompt = buildPrompt({ seedPrompt: 'An authored premise.', isSentient: false, worldState: { tension: 4 }, activeFlags: {}, globalLore: 'World reference.', retrievedLore: ['A lore fact.'], retrievedMemories: ['A memory.'], sceneSummary: 'Earlier scene.', relevantSummaries: ['Past chapter.'], recentEvents: [{ sequence: 1, data: { player_input: 'Wait', ai_response: 'The door opens.', present_characters: ['A visitor'] } }], userMessage: 'I listen', maxTokens: 12000, proseOnly })
      assert.equal(createHash('sha256').update(JSON.stringify(prompt.messages)).digest('hex'), proseOnly ? 'e14f3d28fb89cab77eb8a7a5625f84f39b8c85e596e9e7adeb8fa69bdf4199d3' : '4ddb1e2c414f16720208d800c50dc07c706b32524a8a75048b50edfea0d5170c')
      assert.equal(prompt.sections.reduce((n, s) => n + s.chars, 0), prompt.messages.reduce((n, m) => n + m.content.length, 0))
      assert.ok(prompt.sections.every(s => s.chars > 0))
    }
    const inactive = buildChatRequest({ model: 'fixture/model', messages: [] }, true)
    assert.equal(inactive.params.stream_options, undefined)
  })
  console.log(`LLM trace audit: ${passed} passed, 0 failed`)
} finally {
  globalThis.fetch = originalFetch
  setLLMClientForAudit(null); setNarrationStreamingClientForAudit(null); setEmbeddingClientForAudit(null)
  await local.close()
}
