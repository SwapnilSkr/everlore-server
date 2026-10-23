/** No env, network or wall-clock waits: exercise the real streaming race. */
import assert from 'node:assert/strict'
import { mock } from 'bun:test'
import { readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { runWithLLMUsage, snapshotLLMUsage } from '../src/ai/usage'

mock.module('../src/config/env', () => ({ env: { OPENROUTER_PREFERRED_P90_LATENCY_SECONDS: 3 } }))
mock.module('../src/config/openai', () => ({
  getOpenRouter: () => { throw new Error('Network client reached in narration audit') },
}))
mock.module('../src/utils/logger', () => ({ log: { info() {}, warn() {} } }))
const { callLLMStreamWithFallback, setNarrationStreamingClientForAudit, NARRATION_HEDGE_MS } = await import('../src/ai/client')
type Client = NonNullable<Parameters<typeof setNarrationStreamingClientForAudit>[0]>
type Part = Awaited<ReturnType<Client['create']>> extends AsyncIterable<infer T> ? T : never

const realSetTimeout = globalThis.setTimeout
const realClearTimeout = globalThis.clearTimeout
const flush = async () => { for (let i = 0; i < 60; i++) await Promise.resolve() }

class Clock {
  now = 0
  nextId = 0
  timers = new Map<number, { at: number; fn: () => void }>()
  install() {
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
const H = NARRATION_HEDGE_MS
assert.equal(H, 3500, 'production narration hedge threshold')
const request = { model: 'audit/primary', messages: [{ role: 'user', content: 'Continue.' }], sessionId: 'sticky-story', temperature: 0.7, maxTokens: 105 }

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

await check('(a,g) fast primary: one request, provider, no hedge', [
  { events: [text(10, 'Fast', 'fast-host'), text(20, ' reply'), end(25)] },
], async ({ clock, calls }) => {
  const deltas: string[] = []
  const result = callLLMStreamWithFallback(request, [], (d) => deltas.push(d))
  await clock.to(H + 100)
  assert.deepEqual(await result, { content: 'Fast reply', model: request.model, fallbackAttempts: [], provider: 'fast-host', hedged: false, hedgeWinner: undefined })
  assert.deepEqual(deltas, ['Fast', ' reply'])
  assert.equal(calls.length, 1)
  assert.equal(calls[0].params.session_id, request.sessionId)
  assert.equal(calls[0].options.maxRetries, 0)
  assert.equal(clock.timers.size, 0)
})

await check('(b,g,h) hedge at threshold, no sticky key, hedge alone wins; loser usage', [
  { ignoreAbort: true, events: [{ at: 1, part: { usage: { prompt_tokens: 12, completion_tokens: 2, total_tokens: 14 } } }, text(H + 500, 'Late primary'), end(H + 501)] },
  { events: [text(50, 'Hedge', 'hedge-host'), text(60, ' wins'), { at: 65, part: { usage: { prompt_tokens: 20, completion_tokens: 3, total_tokens: 23 } } }, end(70)] },
], async ({ clock, calls }) => {
  const deltas: string[] = []
  const result = callLLMStreamWithFallback(request, [], (d) => deltas.push(d))
  await clock.to(H - 1)
  assert.equal(calls.length, 1)
  await clock.to(H)
  assert.equal(calls.length, 2)
  assert.equal(calls[1].at, H)
  const { session_id, ...primaryParams } = calls[0].params
  assert.equal(session_id, request.sessionId)
  assert.ok(!('session_id' in calls[1].params))
  assert.deepEqual(calls[1].params, primaryParams)
  await clock.to(H + 50)
  assert.equal(calls[0].signal.aborted, true)
  await clock.to(H + 100)
  assert.deepEqual(await result, { content: 'Hedge wins', model: request.model, fallbackAttempts: [], provider: 'hedge-host', hedged: true, hedgeWinner: 'hedge' })
  assert.deepEqual(snapshotLLMUsage().map(({ purpose, total_tokens }) => ({ purpose, total_tokens })), [
    { purpose: 'narration_hedge_lost', total_tokens: 14 }, { purpose: 'narration', total_tokens: 23 },
  ])
  await clock.to(H + 600)
  assert.deepEqual(deltas, ['Hedge', ' wins'])
  assert.ok(calls[0].delivered >= 2, 'late loser chunk reached the parser boundary')
  assert.equal(clock.timers.size, 0)
})

await check('(c,g,h) primary wins after hedge; queued hedge chunks never escape', [
  { events: [text(H + 50, 'Primary', 'primary-host'), text(H + 60, ' wins'), end(H + 70)] },
  // Both chunks enter the transport queue before primary wins at H+50, but
  // resolving its pending next() is delayed until after that winning delta.
  { ignoreAbort: true, deliveryDelayMs: 3, events: [text(49, 'Queued hedge 1', 'loser-host'), text(49, 'Queued hedge 2'), end(53)] },
], async ({ clock, calls }) => {
  const deltas: string[] = []
  const result = callLLMStreamWithFallback(request, [], (d) => deltas.push(d))
  await clock.to(H + 50)
  assert.equal(calls.length, 2)
  assert.equal(calls[1].signal.aborted, true)
  await clock.to(H + 100)
  assert.deepEqual(await result, { content: 'Primary wins', model: request.model, fallbackAttempts: [], provider: 'primary-host', hedged: true, hedgeWinner: 'primary' })
  assert.deepEqual(deltas, ['Primary', ' wins'])
  assert.ok(calls[1].delivered > 0, 'buffered losing text was delivered despite abort')
  assert.equal(snapshotLLMUsage()[1].purpose, 'narration_hedge_lost')
  assert.equal(snapshotLLMUsage()[1].total_tokens, 0)
})

await check('(d,h) primary error after hedge leaves hedge running and accounts loser', [
  { events: [{ at: H + 10, error: new Error('primary failed') }] },
  { events: [text(30, 'Rescued'), end(40)] },
], async ({ clock }) => {
  const result = callLLMStreamWithFallback(request, [], () => {})
  await clock.to(H + 100)
  assert.equal((await result).content, 'Rescued')
  assert.equal(snapshotLLMUsage()[0].purpose, 'narration_hedge_lost')
})

await check('(e) two pre-text 429s fall back once to the next model', [
  { events: [{ at: H + 10, error: rateLimit() }] },
  { events: [{ at: 20, error: rateLimit() }] },
  { events: [text(10, 'Fallback'), end(20)] },
], async ({ clock, calls }) => {
  const fallbacks: unknown[] = []
  const result = callLLMStreamWithFallback(request, ['audit/next'], () => {}, (a) => fallbacks.push(a))
  await clock.to(H + 100)
  assert.equal((await result).content, 'Fallback')
  assert.equal((await result).model, 'audit/next')
  assert.deepEqual((await result).fallbackAttempts, [{ from: request.model, to: 'audit/next' }])
  assert.equal((await result).hedged, true)
  assert.equal((await result).hedgeWinner, 'primary')
  assert.equal(calls.length, 3)
  assert.equal(fallbacks.length, 1)
})

await check('(f) mid-stream winner error is thrown without retry', [
  { events: [text(10, 'Visible'), { at: 20, error: rateLimit() }] },
], async ({ clock, calls }) => {
  const deltas: string[] = []
  const rejection = assert.rejects(callLLMStreamWithFallback(request, ['audit/next'], (d) => deltas.push(d)), { status: 429 })
  await clock.to(H + 100)
  await rejection
  assert.deepEqual(deltas, ['Visible'])
  assert.equal(calls.length, 1)
})

// Cover both orders and both rate-limit positions, including non-429 failures.
for (const rateLimited of ['primary', 'hedge', 'neither'] as const) {
  for (const primaryFirst of [true, false]) {
    await check(`both fail: ${rateLimited} 429, primary fails ${primaryFirst ? 'first' : 'last'}`, [
      { events: [{ at: H + (primaryFirst ? 10 : 20), error: rateLimited === 'primary' ? rateLimit() : new Error('primary unavailable') }] },
      { events: [{ at: primaryFirst ? 20 : 10, error: rateLimited === 'hedge' ? rateLimit() : new Error('hedge unavailable') }] },
      ...(rateLimited === 'neither' ? [] : [{ events: [text(10, 'Recovered'), end(20)] }]),
    ], async ({ clock, calls }) => {
      const result = callLLMStreamWithFallback(request, ['audit/next'], () => {})
      const rejection = rateLimited === 'neither' ? assert.rejects(result, /unavailable/) : undefined
      await clock.to(H + 100)
      if (rejection) { await rejection; assert.equal(calls.length, 2) }
      else { assert.equal((await result).content, 'Recovered'); assert.equal(calls.length, 3) }
    })
  }
}

for (const rateLimited of [false, true]) {
  await check(`primary error before hedge: ${rateLimited ? '429 falls back' : 'other error throws'}`, [
    { events: [{ at: 10, error: rateLimited ? rateLimit() : new Error('early failure') }] },
    ...(rateLimited ? [{ events: [text(10, 'Next'), end(20)] }] : []),
  ], async ({ clock, calls }) => {
    const result = callLLMStreamWithFallback(request, ['audit/next'], () => {})
    const rejection = rateLimited ? undefined : assert.rejects(result, /early failure/)
    await clock.to(H + 100)
    if (rejection) { await rejection; assert.equal(calls.length, 1) }
    else { assert.equal((await result).content, 'Next'); assert.equal(calls.length, 2) }
  })
}

await check('hedge error leaves primary running', [
  { events: [text(H + 30, 'Primary survives'), end(H + 40)] },
  { events: [{ at: 10, error: new Error('hedge failed') }] },
], async ({ clock }) => {
  const result = callLLMStreamWithFallback(request, [], () => {})
  await clock.to(H + 100)
  assert.equal((await result).content, 'Primary survives')
  assert.equal(snapshotLLMUsage()[1].purpose, 'narration_hedge_lost')
})

await check('30-second first-token deadline bounds both stuck requests', [
  { events: [], stuckOpening: true }, { events: [], stuckOpening: true },
], async ({ clock, calls }) => {
  const rejection = assert.rejects(callLLMStreamWithFallback(request, ['audit/next'], () => {}), /first token within 30000ms/)
  await clock.to(29999)
  assert.equal(calls.length, 2)
  assert.equal(calls[0].signal.aborted, false)
  await clock.to(30000)
  assert.ok(calls.every((c) => c.signal.aborted))
  await rejection
  assert.equal(clock.timers.size, 0)
})

await check('caller cancellation aborts both and clears timers', [
  { events: [], stuckOpening: true }, { events: [], stuckOpening: true },
], async ({ clock, calls }) => {
  const controller = new AbortController()
  const rejection = assert.rejects(callLLMStreamWithFallback({ ...request, signal: controller.signal }, [], () => {}), /caller cancelled/)
  await clock.to(H)
  controller.abort(new Error('caller cancelled'))
  await rejection
  assert.equal(calls.length, 2)
  assert.ok(calls.every((c) => c.signal.aborted))
  assert.equal(clock.timers.size, 0)
})

console.log(`Narration hedge audit: ${passed} passed, ${failed} failed`)
process.exitCode = failed ? 1 : 0

// Mutate only our owned production file, one fault at a time, and restore the
// exact bytes even if a child fails unexpectedly. Children never load env files.
if (process.argv.includes('--bites') && !failed) {
  const path = new URL('../src/ai/client.ts', import.meta.url)
  const original = readFileSync(path, 'utf8')
  const mutations: Array<{ name: string; replacements: Array<[string, string]>; expected: string; routing?: boolean }> = [
    { name: '(a) hedge fast primary', replacements: [['}, NARRATION_HEDGE_MS)', '}, 0)']], expected: 'FAIL (a,g)' },
    { name: '(b) delay hedge by 1ms', replacements: [['}, NARRATION_HEDGE_MS)', '}, NARRATION_HEDGE_MS + 1)']], expected: 'FAIL (b,g,h)' },
    { name: '(b) retain sticky key', replacements: [["label === 'hedge' ? { ...req, sessionId: undefined } : req", 'req']], expected: 'FAIL (b,g,h)' },
    { name: '(b) omit immediate loser abort', replacements: [["loser?.controller.abort(new Error('Narration hedge lost'))", 'void loser']], expected: 'FAIL (b,g,h)' },
    { name: '(c) leak buffered loser chunks', replacements: [
      ['if (controller.signal.aborted) break', '// broken parser gate'],
      ['if (controller.signal.aborted) return', '// broken delta gate'],
      ['if (winner === label) onDelta(delta)', 'onDelta(delta)'],
    ], expected: 'FAIL (c,g,h)' },
    { name: '(d) fail when one contender fails', replacements: [['if (!other?.failed) return', 'if (!other?.failed) { finish(error); return }']], expected: 'FAIL (d,h)' },
    { name: '(e) disable 429 fallback', replacements: [['if (streamed || !isRateLimitError(error) || !nextModel)', 'if (true || streamed || !isRateLimitError(error) || !nextModel)']], expected: 'FAIL (e)' },
    { name: '(f) retry visible prose', replacements: [['if (streamed || !isRateLimitError(error) || !nextModel)', 'if (!isRateLimitError(error) || !nextModel)']], expected: 'FAIL (f)' },
    { name: '(g) drop provider', replacements: [['return { content: result.content, provider }', 'return { content: result.content, provider: undefined }']], expected: 'FAIL (a,g)' },
    { name: '(g) report unhedged', replacements: [['...result, model, fallbackAttempts, hedged,', '...result, model, fallbackAttempts, hedged: false,']], expected: 'FAIL (b,g,h)' },
    { name: '(g) report wrong winner', replacements: [["hedgeWinner: hedged ? result.hedgeWinner ?? 'primary' : undefined", "hedgeWinner: hedged ? 'primary' : undefined"]], expected: 'FAIL (b,g,h)' },
    { name: '(h) lose loser-purpose accounting', replacements: [["'narration_hedge_lost'", "'narration'"]], expected: 'FAIL (b,g,h)' },
    { name: 'either 429 can trigger fallback', replacements: [['isRateLimitError(error) ? error : isRateLimitError(other.error) ? other.error : error', 'error']], expected: 'FAIL both fail: primary 429, primary fails first' },
    { name: 'shared first-token deadline', replacements: [['}, firstTokenTimeoutMs)', '}, firstTokenTimeoutMs * 2)']], expected: 'FAIL 30-second first-token deadline' },
    { name: 'streamed prose latency sort', replacements: [["sort: narration ? 'latency' : 'throughput'", "sort: 'throughput'"]], expected: 'FAIL streamed prose keeps its intended sorting', routing: true },
    { name: 'structured throughput sort', replacements: [["sort: narration ? 'latency' : 'throughput'", "sort: 'latency'"]], expected: 'FAIL structured keeps its intended sorting', routing: true },
    { name: 'provider fallback enabled', replacements: [['allow_fallbacks: true', 'allow_fallbacks: false']], expected: 'FAIL streamed prose keeps its intended sorting', routing: true },
    { name: 'shared p90 preference', replacements: [['preferred_max_latency: { p90 }', 'preferred_max_latency: { p90: p90 + 1 }']], expected: 'FAIL streamed prose retains the configured soft p90', routing: true },
  ]
  for (const mutation of mutations) {
    try {
      let broken = original
      for (const [before, after] of mutation.replacements) {
        assert.equal(broken.split(before).length, 2, `one mutation target: ${mutation.name}`)
        broken = broken.replace(before, after)
      }
      writeFileSync(path, broken)
      const child = spawnSync('bun', ['--no-env-file', 'run', mutation.routing ? 'scripts/openrouter-routing-audit.ts' : 'scripts/narration-hedge-audit.ts'], { encoding: 'utf8', timeout: 10000 })
      assert.equal(child.error, undefined, `child executed: ${mutation.name}`)
      assert.notEqual(child.status, 0, `mutation must fail: ${mutation.name}`)
      assert.ok((child.stdout + child.stderr).includes(mutation.expected), `intended check failed: ${mutation.name}\n${child.stdout}${child.stderr}`)
      console.log(`BITE ${mutation.name}: exit ${child.status}; ${mutation.expected}`)
    } finally { writeFileSync(path, original) }
  }
  assert.equal(readFileSync(path, 'utf8'), original)
  console.log(`${mutations.length}/${mutations.length} mutations rejected; client restored byte for byte`)
}
