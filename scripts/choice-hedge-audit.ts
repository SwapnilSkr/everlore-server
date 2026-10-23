/** No env, network or wall-clock waits: exercise the real streaming race. */
import assert from 'node:assert/strict'
import { mock } from 'bun:test'
import { cpSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runWithLLMUsage, snapshotLLMUsage } from '../src/ai/usage'

const env = { OPENROUTER_PREFERRED_P90_LATENCY_SECONDS: 3, CHOICE_HEDGE_MS: 1500 }
mock.module('../src/config/env', () => ({ env }))
let nonstreamText = '{}'
let nonstreamError = false
const nonstreamCalls: Array<{ params: Record<string, unknown>; options: Record<string, unknown> }> = []
mock.module('../src/config/openai', () => ({
  getOpenRouter: () => ({ chat: { completions: { create: async (params: Record<string, unknown>, options: Record<string, unknown>) => {
    assert.notEqual(params.stream, true, 'streaming must use the fake stream client')
    nonstreamCalls.push({ params, options })
    if (nonstreamError) throw new Error('nonstream failure')
    return { choices: [{ message: { content: nonstreamText } }], usage: { prompt_tokens: 6200, completion_tokens: 292 } }
  } } } }),
}))
mock.module('../src/utils/logger', () => ({ log: { info() {}, warn() {} } }))
const { callLLM, setNarrationStreamingClientForAudit, NARRATION_HEDGE_MS } = await import('../src/ai/client')
mock.module('../src/ai', () => ({ callLLM, AI_MODELS: { metadata: 'gpt-4o-mini' } }))
const realEnforceSchema = (await import('../worker/lib/structured-output')).enforceSchema
let validationFails = false
mock.module('../worker/lib/structured-output', () => ({ enforceSchema: (raw: string) => {
  if (validationFails) throw new Error('validation failure')
  return realEnforceSchema(raw)
} }))
const { extractChoiceMetadata, extractSceneWitness } = await import('../worker/lib/metadata-extractor')
const { choiceHedgeLogFields, buildTailStages } = await import('../src/models/generation-log.model')
import type { ChoiceHedgeRoute } from '../src/models/generation-log.model'
type Client = NonNullable<Parameters<typeof setNarrationStreamingClientForAudit>[0]>
type Part = Awaited<ReturnType<Client['create']>> extends AsyncIterable<infer T> ? T : never

const realDateNow = Date.now
const realSetTimeout = globalThis.setTimeout
const realClearTimeout = globalThis.clearTimeout
const flush = async () => { for (let i = 0; i < 60; i++) await Promise.resolve() }

class Clock {
  now = 0
  nextId = 0
  timers = new Map<number, { at: number; fn: () => void }>()
  install() {
    Date.now = () => this.now
    globalThis.setTimeout = ((fn: () => void, ms = 0) => {
      const id = ++this.nextId
      this.timers.set(id, { at: this.now + ms, fn })
      return id
    }) as unknown as typeof setTimeout
    globalThis.clearTimeout = ((id: number) => { this.timers.delete(id) }) as unknown as typeof clearTimeout
  }
  async to(at: number) {
    assert.ok(at >= this.now)
    await flush()
    while (true) {
      const next = [...this.timers].sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0]
      if (!next || next[1].at > at) break
      this.now = next[1].at
      this.timers.delete(next[0])
      next[1].fn()
      await flush()
    }
    this.now = at
    await flush()
  }
  restore() {
    Date.now = realDateNow
    globalThis.setTimeout = realSetTimeout
    globalThis.clearTimeout = realClearTimeout
  }
}

type Event = { at: number; part?: Part; error?: Error; end?: boolean }
type Plan = { events: Event[]; ignoreAbort?: boolean; stuckOpening?: boolean; deliveryDelayMs?: number }
const text = (at: number, content: string, provider?: string): Event => ({
  at, part: { choices: [{ delta: { content } }], ...(provider ? { provider } : {}) },
})
const end = (at: number): Event => ({ at, end: true })
const rateLimit = () => Object.assign(new Error('provider busy'), { status: 429 })
const H = env.CHOICE_HEDGE_MS
assert.equal(NARRATION_HEDGE_MS, 3500, 'production narration hedge threshold')


function fixture(plans: Plan[]) {
  const clock = new Clock()
  clock.install()
  const calls: Array<{ at: number; params: Record<string, unknown>; signal: AbortSignal; options: Parameters<Client['create']>[1]; delivered: number }> = []
  const client: Client = {
    async create(params, options) {
      const plan = plans[calls.length]
      assert.ok(plan, 'unexpected extra provider request')
      const call = { at: clock.now, params, signal: options.signal, options, delivered: 0 }
      calls.push(call)
      if (plan.stuckOpening) return await new Promise<never>(() => {})
      const queued: Event[] = []
      let waiting: { resolve: (part: IteratorResult<Part>) => void; reject: (error: unknown) => void } | undefined
      let stopped = false
      const drain = () => {
        if (!waiting || !queued.length) return
        const event = queued.shift()!
        const current = waiting
        waiting = undefined
        const deliver = () => {
          if (event.error) { stopped = true; current.reject(event.error) }
          else if (event.end) { stopped = true; current.resolve({ done: true, value: undefined }) }
          else { call.delivered++; current.resolve({ done: false, value: event.part! }) }
        }
        if (plan.deliveryDelayMs) setTimeout(deliver, plan.deliveryDelayMs)
        else deliver()
      }
      const enqueue = (event: Event) => { queued.push(event); drain() }
      // Deliberately allow a provider to queue chunks after abort in (b)/(c).
      // A cooperative transport would mask a missing synchronous winner gate.
      if (!plan.ignoreAbort) options.signal.addEventListener('abort', () => {
        queued.length = 0
        enqueue({ at: clock.now, error: options.signal.reason })
      }, { once: true })
      for (const event of plan.events) setTimeout(() => enqueue(event), event.at)
      return {
        [Symbol.asyncIterator]() {
          return {
            next(): Promise<IteratorResult<Part>> {
              if (stopped) return Promise.resolve({ done: true, value: undefined })
              return new Promise((resolve, reject) => { waiting = { resolve, reject }; drain() })
            },
            async return() { stopped = true; return { done: true as const, value: undefined } },
          }
        },
      }
    },
  }
  setNarrationStreamingClientForAudit(client)
  return { clock, calls }
}

let passed = 0
let failed = 0
async function check(label: string, plans: Plan[], test: (f: ReturnType<typeof fixture>) => Promise<void>) {
  const f = fixture(plans)
  env.CHOICE_HEDGE_MS = H
  nonstreamCalls.length = 0
  nonstreamError = false
  validationFails = false
  nonstreamText = MODEL_TEXT
  try {
    await runWithLLMUsage(() => test(f))
    passed++
    console.log(`PASS ${label}`)
  } catch (error) {
    failed++
    console.error(`FAIL ${label}: ${(error as Error).stack}`)
  } finally {
    setNarrationStreamingClientForAudit(null)
    f.clock.restore()
  }
}
const MODEL_TEXT = JSON.stringify({
  state_mutations: { resolve: { op: 'add', value: 1 } },
  flag_mutations: { listened: { op: 'set', value: true } },
  scene_tag: 'exploration', emotional_tone: 'curious',
  beat_ledger: { npc_beats: [], emotional_shift: 'Curiosity', setting: 'A quiet room', consequence: null, unresolved_hook: 'A sealed letter' },
  choices: [
    { label: 'Read the letter', kind: 'act', send: 'I read the letter.' },
    { label: 'Ask about the seal', kind: 'say', send: 'Who sealed it?' },
  ], milestone: 'A new lead',
})
const PROSE = 'The steward places a sealed letter on the table.'
function extraction() {
  const route: ChoiceHedgeRoute = { hedged: false }
  const stages: Record<string, number> = {}
  let raw = ''
  const result = extractChoiceMetadata(PROSE, ['resolve'], ['listened'], {
    onChoiceHedge: () => { route.hedged = true },
    onChoiceFirstToken: (ms, winner) => { stages.choice_metadata_first_token = ms; route.winner = winner },
    onStage: (key, ms) => { stages[key] = ms },
    onRaw: (_, value) => { raw = value },
  })
  return { result, route, stages, raw: () => raw }
}

await check('(a) fast primary cancels hedge at FIRST token, not completion', [
  { events: [text(800, MODEL_TEXT.slice(0, 20)), text(H + 2000, MODEL_TEXT.slice(20)), end(H + 2010)] },
], async ({ clock, calls }) => {
  const x = extraction()
  await clock.to(H + 2020)
  assert.equal(calls.length, 1)
  assert.equal(nonstreamCalls.length, 0)
  assert.equal(x.raw(), MODEL_TEXT)
  assert.equal((await x.result).scene_tag, 'exploration')
  assert.deepEqual(x.stages, { choice_metadata_first_token: 800, choice_metadata: H + 2010 })
  assert.deepEqual(choiceHedgeLogFields(x.route), {})
  assert.equal(clock.timers.size, 0)
})

for (const winner of ['primary', 'hedge'] as const) {
  await check(`(b,d) silent primary: exactly one hedge; ${winner} wins, loser aborted and accounted`, [
    { ignoreAbort: true, events: [
      { at: 1, part: { usage: { prompt_tokens: 6200, completion_tokens: 0 } } },
      text(H + (winner === 'primary' ? 20 : 60), winner === 'primary' ? MODEL_TEXT : 'LOSER'), end(H + 90),
    ] },
    { ignoreAbort: true, events: [
      { at: 1, part: { usage: { prompt_tokens: 6201, completion_tokens: 1 } } },
      text(winner === 'hedge' ? 20 : 60, winner === 'hedge' ? MODEL_TEXT : 'LOSER'), end(90),
    ] },
  ], async ({ clock, calls }) => {
    const x = extraction()
    await clock.to(H - 1)
    assert.equal(calls.length, 1)
    await clock.to(H)
    assert.equal(calls.length, 2)
    assert.equal(calls[1].at, H)
    assert.deepEqual(calls[1].params, calls[0].params, 'identical backup request')
    await clock.to(H + 20)
    assert.equal(calls[winner === 'primary' ? 1 : 0].signal.aborted, true, 'loser immediately aborted')
    await clock.to(H + 100)
    assert.equal(calls.length, 2)
    await x.result
    assert.equal(x.raw(), MODEL_TEXT, 'loser text never reaches validation')
    assert.deepEqual(x.stages, { choice_metadata_first_token: H + 20, choice_metadata: H + 90 })
    const usage = snapshotLLMUsage()
    assert.equal(usage.length, 2)
    assert.equal(usage[winner === 'primary' ? 1 : 0].purpose, 'choice_metadata_hedge_lost')
    assert.equal(usage[winner === 'primary' ? 0 : 1].purpose, 'choice_metadata')
    assert.deepEqual(usage.map(u => u.prompt_tokens), [6200, 6201])
    assert.deepEqual(choiceHedgeLogFields(x.route), { choice_hedged: true, choice_hedge_winner: winner })
    assert.ok(calls.every(c => c.options.maxRetries === 0 && c.options.timeout === 90000))
    assert.equal(clock.timers.size, 0)
  })
}

await check('(c,f) same text gives identical metadata; zero is the exact non-streamed request', [
  { events: [text(10, MODEL_TEXT.slice(0, 50)), text(20, MODEL_TEXT.slice(50)), end(30)] },
], async ({ clock, calls }) => {
  const streamed = extraction()
  await clock.to(40)
  const expected = await streamed.result
  assert.equal(expected.scene_tag, 'exploration')
  assert.equal(expected.choices.length, 2)
  assert.ok(Object.keys(expected.state_mutations).length > 0)
  assert.ok(Object.keys(expected.flag_mutations).length > 0)
  env.CHOICE_HEDGE_MS = 0
  const plain = extraction()
  assert.deepEqual(await plain.result, expected)
  assert.equal(plain.raw(), streamed.raw())
  assert.equal(calls.length, 1)
  assert.equal(nonstreamCalls.length, 1)
  const { stream, stream_options, ...body } = calls[0].params
  assert.equal(stream, true)
  assert.deepEqual(stream_options, { include_usage: true })
  assert.deepEqual(body, nonstreamCalls[0].params, 'request must differ ONLY by streaming flags')
  assert.deepEqual(nonstreamCalls[0].options, { timeout: 90000 }, 'rollback retains SDK retry defaults')
  assert.equal(body.model, 'openai/gpt-4o-mini')
  assert.equal(body.temperature, 0.2)
  assert.equal(body.max_tokens, 450)
  assert.equal((body.response_format as { type: string }).type, 'json_schema')
  assert.equal((body.provider as { sort: string; require_parameters: boolean }).sort, 'throughput')
  assert.equal((body.provider as { require_parameters: boolean }).require_parameters, true)
  assert.deepEqual(choiceHedgeLogFields(plain.route), {})
  assert.ok(!('choice_metadata_first_token' in plain.stages))
  assert.deepEqual(snapshotLLMUsage().map(u => u.streamed), [true, false])
})

await check('(e,h) both contenders fail: unchanged intimate fallback and no invented winner', [
  { events: [{ at: H + 10, error: rateLimit() }] },
  { events: [{ at: 20, error: new Error('hedge failure') }] },
], async ({ clock, calls }) => {
  const x = extraction()
  await clock.to(H + 100)
  const failedResult = await x.result
  assert.equal(calls.length, 2, 'choice has no model fallback or retries')
  assert.equal(failedResult.scene_tag, 'intimate')
  env.CHOICE_HEDGE_MS = 0
  nonstreamError = true
  assert.deepEqual(await extraction().result, failedResult)
  assert.deepEqual(choiceHedgeLogFields(x.route), { choice_hedged: true })
  assert.ok(!('choice_metadata_first_token' in x.stages))
  assert.equal(x.stages.choice_metadata, H + 20)
  assert.equal(snapshotLLMUsage()[1].purpose, 'choice_metadata_hedge_lost')
})

for (const error of [rateLimit(), Object.assign(new Error('bad gateway'), { status: 502 }), new Error('connection reset')]) {
  await check(`(i) early primary ${error.message}: immediate backup returns normal metadata`, [
    { events: [{ at: 10, error }] },
    { events: [text(H + 20, MODEL_TEXT), end(H + 30)] },
  ], async ({ clock, calls }) => {
    const x = extraction()
    await clock.to(9)
    assert.equal(calls.length, 1)
    await clock.to(10)
    assert.equal(calls.length, 2, 'early primary error must start the backup immediately')
    assert.equal(calls[1].at, 10)
    assert.deepEqual(calls[1].params, calls[0].params)
    await clock.to(H)
    assert.equal(calls.length, 2, 'original hedge timer must not retry a silent backup')
    await clock.to(H + 30)
    assert.equal(x.stages.choice_metadata_first_token, H + 30)
    await clock.to(H + 100)
    assert.equal(calls.length, 2, 'original hedge timer must not send a third request')
    const result = await x.result
    assert.equal(result.scene_tag, 'exploration')
    assert.equal(result.choices.length, 2)
    assert.equal(x.raw(), MODEL_TEXT)
    assert.deepEqual(choiceHedgeLogFields(x.route), { choice_hedged: true, choice_hedge_winner: 'hedge' })
    assert.deepEqual(snapshotLLMUsage().map(u => u.purpose), ['choice_metadata_hedge_lost', 'choice_metadata'])
    assert.equal(nonstreamCalls.length, 0)
    assert.equal(clock.timers.size, 0)
  })
}

await check('(ii) early primary and backup fail: unchanged fallback with exactly two requests', [
  { events: [{ at: 10, error: rateLimit() }] },
  { events: [{ at: 20, error: new Error('backup failure') }] },
], async ({ clock, calls }) => {
  const x = extraction()
  let settled = false
  void x.result.then(() => { settled = true })
  await clock.to(30)
  assert.equal(settled, true, 'both early errors must settle without waiting for the hedge delay')
  assert.equal(calls.length, 2)
  assert.equal(calls[1].at, 10)
  const result = await x.result
  assert.equal(result.scene_tag, 'intimate')
  assert.equal(result.choices.length, 0)
  env.CHOICE_HEDGE_MS = 0
  nonstreamError = true
  assert.deepEqual(result, await extraction().result)
  await clock.to(H + 100)
  assert.equal(calls.length, 2)
  assert.deepEqual(choiceHedgeLogFields(x.route), { choice_hedged: true })
  assert.ok(!('choice_metadata_first_token' in x.stages))
  assert.equal(x.stages.choice_metadata, 30)
  assert.deepEqual(snapshotLLMUsage().map(u => u.purpose), ['choice_metadata', 'choice_metadata_hedge_lost'])
  assert.equal(clock.timers.size, 0)
})

for (const primaryRateLimited of [false, true]) {
  await check(`early failures preserve 429 arbitration: ${primaryRateLimited ? 'primary' : 'backup'} rate limited`, [
    { events: [{ at: 10, error: primaryRateLimited ? rateLimit() : new Error('primary failure') }] },
    { events: [{ at: 20, error: primaryRateLimited ? new Error('backup failure') : rateLimit() }] },
  ], async ({ clock, calls }) => {
    const rejection = assert.rejects(callLLM({
      model: 'audit/structured', messages: [], responseSchema: {},
      firstTokenHedge: { delayMs: H, lostPurpose: 'choice_metadata_hedge_lost' },
    }), { status: 429 })
    let settled = false
    void rejection.then(() => { settled = true }, () => { settled = true })
    await clock.to(H + 100)
    assert.equal(settled, true, 'both errors must settle before the deadline')
    await rejection
    assert.equal(calls.length, 2)
    assert.equal(clock.timers.size, 0)
  })
}

for (const loser of ['primary', 'hedge'] as const) {
  await check(`loser error is suppressed: ${loser}`, [
    { events: loser === 'primary' ? [{ at: H + 10, error: new Error('primary failure') }] : [text(H + 30, MODEL_TEXT), end(H + 40)] },
    { events: loser === 'hedge' ? [{ at: 10, error: new Error('hedge failure') }] : [text(30, MODEL_TEXT), end(40)] },
  ], async ({ clock, calls }) => {
    const x = extraction()
    await clock.to(H + 100)
    assert.equal((await x.result).scene_tag, 'exploration')
    assert.equal(calls.length, 2)
    assert.equal(snapshotLLMUsage()[loser === 'primary' ? 0 : 1].purpose, 'choice_metadata_hedge_lost')
  })
}

await check('winner text that fails validation gives the unchanged fallback', [
  { events: [text(H + 50, '{"scene_tag":"intimate"}'), end(H + 60)] },
  { events: [text(10, MODEL_TEXT), end(20)] },
], async ({ clock }) => {
  validationFails = true
  const x = extraction()
  await clock.to(H + 100)
  env.CHOICE_HEDGE_MS = 0
  nonstreamError = true
  assert.deepEqual(await x.result, await extraction().result)
  assert.deepEqual(choiceHedgeLogFields(x.route), { choice_hedged: true, choice_hedge_winner: 'hedge' })
})

await check('malformed text retains the existing parser repair result', [
  { events: [text(10, 'broken JSON'), end(20)] },
], async ({ clock }) => {
  const x = extraction()
  await clock.to(30)
  env.CHOICE_HEDGE_MS = 0
  nonstreamText = 'broken JSON'
  assert.deepEqual(await x.result, await extraction().result)
  assert.equal((await x.result).scene_tag, 'dialogue')
})

for (const started of [false, true]) {
  await check(`90s overall deadline applies ${started ? 'after first token' : 'while opening streams'}`, [
    { events: started ? [text(800, '{')] : [], stuckOpening: !started },
    ...(!started ? [{ events: [], stuckOpening: true }] : []),
  ], async ({ clock, calls }) => {
    const x = extraction()
    let settled = false
    void x.result.then(() => { settled = true })
    await clock.to(89999)
    assert.equal(settled, false)
    await clock.to(90000)
    assert.equal(settled, true)
    assert.equal((await x.result).scene_tag, 'intimate')
    assert.ok(calls.every(c => c.signal.aborted))
    assert.equal(x.stages.choice_metadata, 90000)
    assert.equal(clock.timers.size, 0)
  })
}

await check('scene witness stays non-streamed even with choice hedge enabled', [], async ({ calls }) => {
  nonstreamText = '{}'
  await extractSceneWitness(PROSE)
  assert.equal(calls.length, 0)
  assert.equal(nonstreamCalls.length, 1)
  assert.equal(nonstreamCalls[0].params.stream, undefined)
  assert.equal(nonstreamCalls[0].params.max_tokens, 620)
})

const read = (file: string) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')
await check('(h) real row wiring: omitted when unhedged, timing is a milestone', [], async () => {
  for (const winner of [undefined, 'primary', 'hedge'] as const) {
    assert.deepEqual(choiceHedgeLogFields({ hedged: false, winner }), {})
  }
  assert.deepEqual(buildTailStages({ choice_metadata_first_token: 1550.4, choice_metadata: 3500 }), {
    choice_metadata_first_token: 1550, choice_metadata: 3500,
  })
  const processor = read('worker/processors/generation.processor.ts')
  for (const wiring of [
    'const choiceRoute: ChoiceHedgeRoute = { hedged: false }',
    'onChoiceHedge: () => { choiceRoute.hedged = true }',
    'choiceFirstTokenMs = ms', 'choiceRoute.winner = winner',
    'choice_metadata_first_token: choiceFirstTokenMs', '...choiceHedgeLogFields(choiceRoute)',
  ]) assert.ok(processor.includes(wiring), `processor wiring: ${wiring}`)
  const config = read('src/config/env.ts')
  assert.ok(config.includes("CHOICE_HEDGE_MS: '1500'"), 'default is 1500ms')
  assert.ok(config.includes('CHOICE_HEDGE_MS: Number(process.env.CHOICE_HEDGE_MS || optionalEnvVars.CHOICE_HEDGE_MS)'), 'env knob loads zero')
  const row = read('src/models/generation-log.model.ts')
  assert.ok(row.includes('choice_hedged?: true'))
  assert.ok(row.includes("choice_hedge_winner?: 'primary' | 'hedge'"))
})

function child(script: string, cwd?: string) {
  const result = spawnSync('bun', ['--no-env-file', 'run', script, '--no-bites'], { cwd, encoding: 'utf8', timeout: 15000 })
  assert.equal(result.error, undefined, `child executed: ${script}`)
  return { code: result.status, output: result.stdout + result.stderr }
}
await check('(g) unchanged narration race and routing audits pass', [], async () => {
  for (const script of ['scripts/narration-hedge-audit.ts', 'scripts/openrouter-routing-audit.ts']) {
    const result = child(script)
    assert.equal(result.code, 0, result.output)
  }
})

console.log(`Choice hedge audit: ${passed} passed, ${failed} failed`)
process.exitCode = failed ? 1 : 0

// Each new requirement must reject a real production defect, not an assertion
// that we merely claim would fail. Run mutations in a source-only scratch tree
// so audits never write to another task's files or copy env files or secrets.
if (!process.argv.includes('--no-bites') && !failed) {
  type Mutation = { name: string; file?: string; before: string; after: string; expected: string; script?: string }
  const mutations: Mutation[] = [
    { name: '(i) drop immediate backup', before: 'if (hedge && !winner && !hedged) { startHedge(); return }', after: 'if (false) { startHedge(); return }', expected: 'FAIL (i)' },
    { name: '(ii) forget early primary failure', before: 'if (hedge && !winner && !hedged) { startHedge(); return }', after: 'if (hedge && !winner && !hedged) { startHedge(); state.failed = false; return }', expected: 'FAIL (ii)' },
    { name: '(a) hedge fast primary', before: 'setTimeout(startHedge, hedge.delayMs)', after: 'setTimeout(startHedge, 0)', expected: 'FAIL (a)' },
    { name: '(b) hedge late', before: 'setTimeout(startHedge, hedge.delayMs)', after: 'setTimeout(startHedge, hedge.delayMs + 1)', expected: 'FAIL (b,d)' },
    { name: '(b) leave loser running', before: "loser?.controller.abort(new Error('Narration hedge lost'))", after: 'void loser', expected: 'FAIL (b,d)' },
    { name: '(c) drop schema on stream', before: 'if (req.responseSchema) {', after: 'if (req.responseSchema && !stream) {', expected: 'FAIL (c,f)' },
    { name: '(c) corrupt assembled text', before: 'return result.content', after: "return '{}'", expected: 'FAIL (c,f)' },
    { name: '(d) lose loser accounting', file: 'worker/lib/metadata-extractor.ts', before: "lostPurpose: 'choice_metadata_hedge_lost'", after: "lostPurpose: 'choice_metadata'", expected: 'FAIL (b,d)' },
    { name: '(e) wrong fallback', file: 'worker/lib/metadata-extractor.ts', before: "return { ...WITNESS_FALLBACK, scene_tag: 'intimate' }", after: "return { ...WITNESS_FALLBACK, scene_tag: 'dialogue' }", expected: 'FAIL (e,h)' },
    { name: '(f) stream when zero', before: 'req.firstTokenHedge.delayMs > 0', after: 'req.firstTokenHedge.delayMs >= 0', expected: 'FAIL (c,f)' },
    { name: '(g) narration threshold', before: 'export const NARRATION_HEDGE_MS = 3500', after: 'export const NARRATION_HEDGE_MS = 3501', expected: 'production narration hedge threshold' },
    { name: '(g) narration loser label', before: "hedge?.lostPurpose ?? 'narration_hedge_lost'", after: "hedge?.lostPurpose ?? 'narration'", expected: 'FAIL (b,g,h)', script: 'scripts/narration-hedge-audit.ts' },
    { name: '(g) narration 429 fallback', before: 'if (streamed || !isRateLimitError(error) || !nextModel)', after: 'if (true || streamed || !isRateLimitError(error) || !nextModel)', expected: 'FAIL (e)', script: 'scripts/narration-hedge-audit.ts' },
    { name: '(g) narration thinking host', before: "export const NARRATION_IGNORED_PROVIDERS = ['GMICloud'] as const", after: 'export const NARRATION_IGNORED_PROVIDERS = [] as const', expected: 'FAIL streamed prose skips', script: 'scripts/openrouter-routing-audit.ts' },
    { name: '(h) emit unhedged row fields', file: 'src/models/generation-log.model.ts', before: 'return route.hedged ? {', after: 'return true ? {', expected: 'FAIL (h)' },
    { name: '(h) wrong row winner', file: 'src/models/generation-log.model.ts', before: 'choice_hedge_winner: route.winner', after: "choice_hedge_winner: 'primary'", expected: 'FAIL (b,d) silent primary: exactly one hedge; hedge wins' },
    { name: '(h) disconnect processor row', file: 'worker/processors/generation.processor.ts', before: '...choiceHedgeLogFields(choiceRoute),', after: '...choiceHedgeLogFields({ hedged: false }),', expected: 'FAIL (h)' },
    { name: 'first token clock', file: 'worker/lib/metadata-extractor.ts', before: 'opts?.onChoiceFirstToken?.(Date.now() - startedAt, winner)', after: 'opts?.onChoiceFirstToken?.(0, winner)', expected: 'FAIL (a)' },
    { name: 'SDK retries', before: 'maxRetries: 0,\n    })', after: 'maxRetries: 2,\n    })', expected: 'FAIL (b,d)' },
    { name: 'overall timeout after first token', before: 'timeoutMs}ms`)), timeoutMs)', after: 'timeoutMs}ms`)), timeoutMs * 2)', expected: 'FAIL 90s overall deadline applies after first token' },
    { name: 'default knob', file: 'src/config/env.ts', before: "CHOICE_HEDGE_MS: '1500'", after: "CHOICE_HEDGE_MS: '1501'", expected: 'FAIL (h)' },
  ]
  const root = fileURLToPath(new URL('../', import.meta.url))
  const scratch = mkdtempSync(join(tmpdir(), 'choice-hedge-bites-'))
  try {
    for (const dir of ['src', 'worker', 'scripts']) {
      cpSync(join(root, dir), join(scratch, dir), {
        recursive: true,
        filter: path => statSync(path).isDirectory() || path.endsWith('.ts'),
      })
    }
    cpSync(join(root, 'package.json'), join(scratch, 'package.json'))
    symlinkSync(join(root, 'node_modules'), join(scratch, 'node_modules'), 'dir')
    for (const mutation of mutations) {
      const path = join(scratch, mutation.file ?? 'src/ai/client.ts')
      const original = readFileSync(path, 'utf8')
      assert.equal(original.split(mutation.before).length, 2, `one target: ${mutation.name}`)
      try {
        writeFileSync(path, original.replace(mutation.before, mutation.after))
        const result = child(mutation.script ?? 'scripts/choice-hedge-audit.ts', scratch)
        assert.notEqual(result.code, 0, `must reject ${mutation.name}`)
        assert.ok(result.output.includes(mutation.expected), `intended failure for ${mutation.name}:\n${result.output}`)
        console.log(`BITE ${mutation.name}: exit ${result.code}; ${mutation.expected}`)
      } finally {
        writeFileSync(path, original)
      }
      assert.equal(readFileSync(path, 'utf8'), original)
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
  console.log(`${mutations.length}/${mutations.length} mutations rejected; scratch tree removed; production files untouched`)
}
