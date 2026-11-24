/**
 * Pure regression checks for the structured content_filter retry. No provider
 * calls: a fake client stands in at the audit seam and records every request.
 */
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { mock } from 'bun:test'
import { runWithLLMTrace, runWithLLMUsage, snapshotLLMTrace, snapshotLLMUsage } from '../src/ai/usage'
import { EmptyLLMResponseError } from '../src/utils/llm-response'

const warnings: Array<{ message: string; fields: Record<string, unknown> }> = []
mock.module('../src/utils/logger', () => ({
  log: {
    info() {},
    warn(message: string, fields: Record<string, unknown>) { warnings.push({ message, fields }) },
    error() {},
  },
}))
mock.module('../src/config/env', () => ({ env: { OPENROUTER_PREFERRED_P90_LATENCY_SECONDS: 3 } }))
const { callLLM, buildChatRequest, contentFilterRetryParams, setLLMClientForAudit } = await import('../src/ai/client')

const failures: string[] = []
function check(label: string, fn: () => void): void {
  try { fn(); console.log(`PASS ${label}`) }
  catch (error) { failures.push(label); console.error(`FAIL ${label}`); console.error(error) }
}

const schema = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] }
const prompt = 'PRIVATE PROMPT TEXT'
const replyText = 'PRIVATE REPLY TEXT'
const base = {
  model: 'fixture/structured',
  messages: [{ role: 'user', content: prompt }],
  purpose: 'choices',
  responseSchema: schema,
}

interface FakeReply {
  content?: string | null
  finish?: string | null
  provider?: string
  usage?: unknown
  error?: unknown
  /** Virtual milliseconds this call consumes, for deadline checks. */
  advanceMs?: number
  /** Runs after the request is recorded, before it resolves. */
  during?: (signal: AbortSignal | undefined) => void
}
interface RecordedCall { params: Record<string, unknown>; options: Record<string, unknown> }

const calls: RecordedCall[] = []
let plan: FakeReply[] = []
let clock = 1_000_000
const realNow = Date.now
Date.now = () => clock

setLLMClientForAudit({
  chat: {
    completions: {
      async create(params: Record<string, unknown>, options: Record<string, unknown>) {
        const reply = plan.shift()
        assert.ok(reply, 'unexpected extra provider request')
        calls.push({ params, options })
        clock += reply.advanceMs ?? 0
        reply.during?.(options?.signal as AbortSignal | undefined)
        if (reply.error) throw reply.error
        const content = reply.content === undefined ? replyText : reply.content
        return {
          ...(typeof reply.provider === 'string' ? { provider: reply.provider } : {}),
          choices: [{ message: { content }, finish_reason: reply.finish ?? 'stop' }],
          usage: reply.usage ?? { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
        }
      },
    },
  },
} as never)

async function run(replies: FakeReply[], extra: Record<string, unknown> = {}) {
  calls.length = 0
  plan = [...replies]
  warnings.length = 0
  clock = 1_000_000
  const reasons: Array<string | null | undefined> = []
  let value: string | undefined
  let error: unknown
  let traces: ReturnType<typeof snapshotLLMTrace> = []
  let usage: ReturnType<typeof snapshotLLMUsage> = []
  await runWithLLMTrace({}, () => runWithLLMUsage(async () => {
    try {
      value = await callLLM({
        ...base,
        ...extra,
        onFinishReason: (reason) => reasons.push(reason),
      } as Parameters<typeof callLLM>[0])
    } catch (caught) { error = caught }
    traces = snapshotLLMTrace()
    usage = snapshotLLMUsage()
  }))
  return { value, error, reasons, traces, usage, calls: [...calls], warnings: [...warnings] }
}

const cutJson = '{"choices": [{"text": "Keep going'
const goodJson = '{"ok": true}'

// 1 and 2: a cut or complete-looking reply with content_filter is sent again.
{
  const result = await run([
    { content: cutJson, finish: 'content_filter', provider: 'FixtureHost', advanceMs: 40 },
    { content: goodJson, finish: 'stop', provider: 'OtherHost' },
  ])
  check('cut structured JSON is retried and recovered', () => {
    assert.equal(result.error, undefined)
    assert.equal(result.value, goodJson)
    assert.equal(result.calls.length, 2)
    assert.deepEqual(result.calls[1].params.provider, {
      sort: 'throughput', allow_fallbacks: true, require_parameters: true,
      preferred_max_latency: { p90: 3 }, ignore: ['FixtureHost'],
    })
  })
  check('the retry repeats every other param and only adds the host to ignore', () => {
    const [first, retry] = result.calls.map(call => call.params)
    assert.notEqual(first, retry)
    for (const key of ['model', 'messages', 'temperature', 'max_tokens', 'response_format']) {
      assert.deepEqual(retry[key], first[key])
    }
    assert.deepEqual(retry.provider.require_parameters, first.provider.require_parameters)
    assert.equal(retry.provider.sort, first.provider.sort)
  })
  check('the first attempt body is never edited by the retry', () => {
    assert.equal('ignore' in result.calls[0].params.provider, false)
  })
  check('both attempts record usage', () => {
    assert.equal(result.usage.length, 2)
    assert.ok(result.usage.every(call => call.purpose === 'choices' && call.streamed === false && call.total_tokens === 10))
  })
  check('each attempt has its own trace, role and response', () => {
    assert.equal(result.traces.length, 2)
    assert.deepEqual(result.traces.map(trace => trace.call.role), ['primary', 'fallback'])
    assert.equal(result.traces[0].response, cutJson)
    assert.equal(result.traces[0].call.finish_reason, 'content_filter')
    assert.equal(result.traces[1].response, goodJson)
    assert.equal(result.traces[1].call.finish_reason, 'stop')
  })
  check('onFinishReason fires once with the used finish reason', () => {
    assert.deepEqual(result.reasons, ['stop'])
  })
  check('the cut is logged once with no prompt or reply text', () => {
    assert.equal(result.warnings.length, 1)
    const entry = result.warnings[0]
    assert.equal(entry.message, 'chat.content_filtered')
    assert.deepEqual(Object.keys(entry.fields).sort(), ['host', 'model', 'purpose', 'recovered'])
    assert.equal(entry.fields.host, 'FixtureHost')
    assert.equal(entry.fields.recovered, true)
    assert.equal(entry.fields.purpose, 'choices')
    const serialized = JSON.stringify(entry)
    assert.equal(serialized.includes(prompt), false)
    assert.equal(serialized.includes(replyText), false)
    assert.equal(serialized.includes(cutJson), false)
  })
}
{
  const result = await run([
    { content: goodJson, finish: 'content_filter', provider: 'FixtureHost' },
    { content: goodJson, finish: 'stop', provider: 'OtherHost' },
  ])
  check('a valid-looking JSON reply with content_filter is retried', () => {
    assert.equal(result.calls.length, 2)
    assert.equal(result.value, goodJson)
    assert.equal(result.reasons[0], 'stop')
  })
}

// 3: empty content with content_filter is still retried.
for (const host of ['Azure', 'OpenAI']) {
  const result = await run([
    { content: cutJson, finish: 'content_filter', provider: host },
    { content: goodJson, finish: 'stop', provider: 'OtherHost' },
  ], { model: 'gpt-4o-mini' })
  check(`a cut at ${host} retries a gpt-4o-mini pass with order kept and ${host} ignored`, () => {
    assert.equal(result.error, undefined)
    assert.equal(result.value, goodJson)
    assert.equal(result.calls.length, 2)
    const expected = { order: ['OpenAI', 'Azure'], allow_fallbacks: true, require_parameters: true }
    assert.deepEqual(result.calls[0].params.provider, expected)
    assert.deepEqual(result.calls[1].params.provider, { ...expected, ignore: [host] })
    assert.deepEqual(result.reasons, ['stop'])
  })
}
{
  const result = await run([
    { content: null, finish: 'content_filter', provider: 'FixtureHost' },
    { content: goodJson, finish: 'stop', provider: 'OtherHost' },
  ])
  check('an empty reply with content_filter is retried', () => {
    assert.equal(result.error, undefined)
    assert.equal(result.calls.length, 2)
    assert.equal(result.value, goodJson)
    assert.deepEqual(result.reasons, ['stop'])
  })
}

// 4: no host named means no retry.
{
  const result = await run([
    { content: cutJson, finish: 'content_filter' },
    { content: goodJson, finish: 'stop', provider: 'OtherHost' },
  ])
  check('a cut reply with no named host is not retried', () => {
    assert.equal(result.calls.length, 1)
    assert.equal(result.value, cutJson)
    assert.equal(result.warnings.length, 1)
    assert.equal(result.warnings[0].fields.host, undefined)
    assert.equal(result.warnings[0].fields.recovered, false)
    assert.deepEqual(result.reasons, ['content_filter'])
  })
}

// 5: an existing ignore list is merged, deduplicated, and never mutated.
{
  const params = { model: 'fixture/structured', provider: { sort: 'throughput', ignore: ['Alpha', 'FixtureHost'] } }
  const frozen = JSON.stringify(params)
  const result = contentFilterRetryParams(params, 'FixtureHost')
  check('existing ignore merges without duplicates and stays unmutated', () => {
    assert.deepEqual((result.provider as { ignore: string[] }).ignore, ['Alpha', 'FixtureHost'])
    assert.notEqual(result, params)
    assert.notEqual((result.provider as { ignore: string[] }).ignore, (params.provider as { ignore: string[] }).ignore)
    assert.equal(JSON.stringify(params), frozen)
  })
}

// 6: the retry is filtered too — the first reply is the answer.
{
  const result = await run([
    { content: cutJson, finish: 'content_filter', provider: 'FixtureHost' },
    { content: goodJson, finish: 'content_filter', provider: 'OtherHost' },
  ])
  check('a retry filtered too returns the first reply', () => {
    assert.equal(result.calls.length, 2)
    assert.equal(result.value, cutJson)
    assert.deepEqual(result.reasons, ['content_filter'])
    assert.equal(result.warnings[0].fields.recovered, false)
  })
}

// 7: the retry throws — the first reply is the answer.
{
  const result = await run([
    { content: cutJson, finish: 'content_filter', provider: 'FixtureHost' },
    { error: new Error('fixture transport failure') },
  ])
  check('a retry that throws returns the first reply', () => {
    assert.equal(result.error, undefined)
    assert.equal(result.calls.length, 2)
    assert.equal(result.value, cutJson)
    assert.equal(result.warnings[0].fields.recovered, false)
  })
}

// 8: the retry is empty — the first reply is the answer.
{
  const result = await run([
    { content: cutJson, finish: 'content_filter', provider: 'FixtureHost' },
    { content: null, finish: 'stop', provider: 'OtherHost' },
  ])
  check('a retry that is empty returns the first reply', () => {
    assert.equal(result.error, undefined)
    assert.equal(result.value, cutJson)
    assert.equal(result.warnings[0].fields.recovered, false)
  })
}

// 4 again: an empty first reply keeps its own error when the retry cannot answer.
{
  const result = await run([
    { content: null, finish: 'content_filter', provider: 'FixtureHost' },
    { content: null, finish: 'stop', provider: 'OtherHost' },
  ])
  check('an empty first reply keeps its error when the retry fails', () => {
    assert.ok(result.error instanceof EmptyLLMResponseError)
    assert.equal(result.warnings.length, 1)
  })
}

// 3: an aborted signal is never retried.
{
  const controller = new AbortController()
  const result = await run([
    { content: cutJson, finish: 'content_filter', provider: 'FixtureHost', during: () => controller.abort(new Error('player cancelled')) },
    { content: goodJson, finish: 'stop', provider: 'OtherHost' },
  ], { signal: controller.signal })
  check('an aborted signal is never retried', () => {
    assert.equal(result.calls.length, 1)
    assert.equal(result.value, cutJson)
  })
}

// 4: an abort during the retry throws the abort.
{
  const controller = new AbortController()
  const result = await run([
    { content: cutJson, finish: 'content_filter', provider: 'FixtureHost' },
    {
      error: new Error('player cancelled'),
      during: () => controller.abort(new Error('player cancelled')),
    },
  ], { signal: controller.signal })
  check('an abort during the retry throws the abort', () => {
    assert.equal(result.calls.length, 2)
    assert.ok(result.error instanceof Error)
    assert.equal(result.error.message, 'player cancelled')
    assert.equal(result.value, undefined)
  })
}

// 4: a transport that resolves good content after the abort still loses to it.
{
  const controller = new AbortController()
  const result = await run([
    { content: cutJson, finish: 'content_filter', provider: 'FixtureHost' },
    {
      content: goodJson,
      finish: 'stop',
      provider: 'OtherHost',
      during: () => controller.abort(new Error('player cancelled')),
    },
  ], { signal: controller.signal })
  check('an abort during the retry wins over a resolved retry reply', () => {
    assert.equal(result.calls.length, 2)
    assert.equal(result.value, undefined)
    assert.equal(result.error.message, 'player cancelled')
  })
}

// 3: no time left means no retry.
{
  const result = await run([
    { content: cutJson, finish: 'content_filter', provider: 'FixtureHost', advanceMs: 600 },
    { content: goodJson, finish: 'stop', provider: 'OtherHost' },
  ], { timeoutMs: 500 })
  check('no retry once the deadline is spent', () => {
    assert.equal(result.calls.length, 1)
    assert.equal(result.value, cutJson)
  })
}

// 3: the retry's timeout is what the first call left.
{
  const controller = new AbortController()
  const result = await run([
    { content: cutJson, finish: 'content_filter', provider: 'FixtureHost', advanceMs: 300 },
    { content: goodJson, finish: 'stop', provider: 'OtherHost' },
  ], { timeoutMs: 1000, signal: controller.signal })
  check('the retry gets the time the first call left', () => {
    assert.equal(result.calls.length, 2)
    assert.equal(result.calls[0].options.timeout, 1000)
    assert.equal(result.calls[1].options.timeout, 700)
  })
  check('the retry shares the first call signal and retry policy', () => {
    assert.equal(result.calls[0].options.signal, controller.signal)
    assert.equal(result.calls[1].options.signal, controller.signal)
    assert.equal(result.calls[0].options.maxRetries, 0)
    assert.equal(result.calls[1].options.maxRetries, 0)
  })
}

// 8: prose is never retried, and neither is an unlabeled finish reason.
{
  const result = await run([
    { content: replyText, finish: 'content_filter', provider: 'FixtureHost' },
    { content: 'A second continuation', finish: 'stop', provider: 'OtherHost' },
  ], { responseSchema: undefined })
  check('prose is never retried for a content filter', () => {
    assert.equal(result.calls.length, 1)
    assert.equal(result.value, replyText)
    assert.equal(result.warnings.length, 0)
  })
}
{
  const result = await run([
    { content: replyText, finish: 'content_filter', provider: 'FixtureHost' },
    { content: 'A second continuation', finish: 'stop', provider: 'OtherHost' },
  ], { responseSchema: undefined, responseFormat: { type: 'text' } })
  check('an explicit text format stays prose and is never retried', () => {
    assert.equal(result.calls.length, 1)
    assert.equal(result.value, replyText)
  })
}
{
  const result = await run([
    { content: goodJson, finish: 'content_filter', provider: 'FixtureHost' },
    { content: goodJson, finish: 'stop', provider: 'OtherHost' },
  ], { responseSchema: undefined, responseFormat: { type: 'json_object' } })
  check('a json_object reply counts as structured', () => {
    assert.equal(result.calls.length, 2)
  })
}
{
  const result = await run([
    { content: cutJson, finish: 'length', provider: 'FixtureHost' },
    { content: goodJson, finish: 'stop', provider: 'OtherHost' },
  ])
  check('finish_reason length is not retried', () => {
    assert.equal(result.calls.length, 1)
    assert.equal(result.value, cutJson)
    assert.deepEqual(result.reasons, ['length'])
  })
}

// 8: a normal reply still takes exactly one call with the same params.
{
  const result = await run([{ content: goodJson, finish: 'stop', provider: 'FixtureHost' }])
  check('a normal structured reply takes one provider call', () => {
    assert.equal(result.calls.length, 1)
    assert.equal(result.value, goodJson)
    assert.equal(result.usage.length, 1)
    assert.equal(result.traces.length, 1)
    assert.equal(result.warnings.length, 0)
    assert.deepEqual(result.reasons, ['stop'])
    assert.deepEqual(result.calls[0].params, buildChatRequest(base as never).params)
  })
}
{
  const result = await run([{ content: replyText, finish: 'stop', provider: 'FixtureHost' }], { responseSchema: undefined })
  check('a normal prose reply keeps its params and one call', () => {
    assert.equal(result.calls.length, 1)
    assert.deepEqual(result.calls[0].params, buildChatRequest({ ...base, responseSchema: undefined } as never).params)
  })
}

Date.now = realNow

if (failures.length) {
  console.error(`${failures.length} content-filter retry checks failed`)
  process.exit(1)
}
console.log('Content-filter retry audit passed')

// Opt-in mutations: no provider calls, and exact restoration even when an
// assertion fails. Only the client file owned by this brief is touched.
if (process.argv.includes('--bites')) {
  const path = new URL('../src/ai/client.ts', import.meta.url)
  const original = readFileSync(path, 'utf8')
  const gate = "first.finishReason === 'content_filter' && !isProseRequest(req)"
  const hostGuard = 'if (host && !req.signal?.aborted && remaining > 0) {'
  const retryCall = "client, remaining, 'fallback')"
  const finishCall = 'req.onFinishReason?.(used.finishReason)'
  const logCall = "log.warn('chat.content_filtered', { purpose: req.purpose, model: req.model, host, recovered })"
  const mutations: Array<{ name: string; before: string; after: string; expected: string }> = [
    { name: 'prose gate', before: `${gate}`, after: "first.finishReason === 'content_filter'", expected: 'FAIL prose is never retried for a content filter' },
    { name: 'filter reason', before: gate, after: "first.finishReason === 'content_filterx' && !isProseRequest(req)", expected: 'FAIL a valid-looking JSON reply with content_filter is retried' },
    { name: 'length reason', before: gate, after: "first.finishReason !== 'stop' && !isProseRequest(req)", expected: 'FAIL finish_reason length is not retried' },
    { name: 'normal reply gate', before: gate, after: '!isProseRequest(req)', expected: 'FAIL a normal structured reply takes one provider call' },
    { name: 'json_object prose', before: "(!req.responseFormat || req.responseFormat.type === 'text')", after: "(!req.responseFormat || req.responseFormat.type !== 'json_schema')", expected: 'FAIL a json_object reply counts as structured' },
    { name: 'host guard', before: hostGuard, after: 'if (!req.signal?.aborted && remaining > 0) {', expected: 'FAIL a cut reply with no named host is not retried' },
    { name: 'abort guard', before: hostGuard, after: 'if (host && remaining > 0) {', expected: 'FAIL an aborted signal is never retried' },
    { name: 'deadline guard', before: hostGuard, after: 'if (host && !req.signal?.aborted && remaining > -999999) {', expected: 'FAIL no retry once the deadline is spent' },
    { name: 'remaining timeout', before: retryCall, after: "client, timeout, 'fallback')", expected: 'FAIL the retry gets the time the first call left' },
    { name: 'fallback role', before: retryCall, after: "client, remaining, 'primary')", expected: 'FAIL each attempt has its own trace, role and response' },
    { name: 'filtered retry accepted', before: "retry.content !== null && retry.finishReason !== 'content_filter'", after: 'retry.content !== null', expected: 'FAIL a retry filtered too returns the first reply' },
    { name: 'empty retry accepted', before: "retry.content !== null && retry.finishReason !== 'content_filter'", after: "retry.finishReason !== 'content_filter'", expected: 'FAIL a retry that is empty returns the first reply' },
    { name: 'retry error thrown', before: 'if (req.signal?.aborted) abortError = error', after: 'abortError = error', expected: 'FAIL a retry that throws returns the first reply' },
    { name: 'abort after retry ignored', before: 'if (req.signal?.aborted) throw req.signal.reason', after: 'if (false) throw req.signal.reason', expected: 'FAIL an abort during the retry wins over a resolved retry reply' },
    { name: 'empty error swallowed', before: 'if (used.content === null) throw used.emptyError', after: "if (used.content === null) return ''", expected: 'FAIL an empty first reply keeps its error when the retry fails' },
    { name: 'wrong finish reason reported', before: finishCall, after: 'req.onFinishReason?.(first.finishReason)', expected: 'FAIL onFinishReason fires once with the used finish reason' },
    { name: 'finish reason twice', before: finishCall, after: `${finishCall}, ${finishCall}`, expected: 'FAIL onFinishReason fires once with the used finish reason' },
    { name: 'retry usage dropped', before: 'recordLLMUsage({ purpose: req.purpose, model: req.model, streamed: false,', after: "traceRole === 'fallback' ? void 0 : recordLLMUsage({ purpose: req.purpose, model: req.model, streamed: false,", expected: 'FAIL both attempts record usage' },
    { name: 'no traces', before: 'const trace = beginLLMTrace({ model: params.model, purpose: req.purpose, streamed: false,', after: 'const trace = undefined && beginLLMTrace({ model: params.model, purpose: req.purpose, streamed: false,', expected: 'FAIL each attempt has its own trace, role and response' },
    { name: 'log carries text', before: '{ purpose: req.purpose, model: req.model, host, recovered }', after: '{ purpose: req.purpose, model: req.model, host, recovered, prompt: req.messages }', expected: 'FAIL the cut is logged once with no prompt or reply text' },
    { name: 'log twice', before: logCall, after: `${logCall}; ${logCall}`, expected: 'FAIL the cut is logged once with no prompt or reply text' },
    { name: 'ignore duplicates', before: 'ignore: [...new Set([...existing, host])]', after: 'ignore: [host]', expected: 'FAIL existing ignore merges without duplicates and stays unmutated' },
    { name: 'ignore mutation', before: 'return { ...params, provider: { ...provider, ignore: [...new Set([...existing, host])] } }', after: 'provider.ignore = [host]; return params', expected: 'FAIL existing ignore merges without duplicates and stays unmutated' },
    { name: 'retry drops host order', before: 'provider: { ...provider, ignore: [...new Set([...existing, host])] }', after: 'provider: { ignore: [...new Set([...existing, host])] }', expected: 'FAIL a cut at Azure retries a gpt-4o-mini pass' },
    { name: 'signal dropped', before: '...(req.signal ? { signal: req.signal } : {}),', after: '...(req.signal && false ? { signal: req.signal } : {}),', expected: 'FAIL the retry shares the first call signal and retry policy' },
    { name: 'retry policy dropped', before: '...(req.timeoutMs ? { maxRetries: 0 } : {})', after: '...(false ? { maxRetries: 0 } : {})', expected: 'FAIL the retry shares the first call signal and retry policy' },
  ]
  for (const mutation of mutations) {
    try {
      assert.equal(original.split(mutation.before).length, 2, `one mutation target: ${mutation.name}`)
      writeFileSync(path, original.replace(mutation.before, mutation.after))
      const child = spawnSync('bun', ['--no-env-file', 'run', import.meta.path], { encoding: 'utf8', timeout: 20000 })
      assert.equal(child.error, undefined, `child executed: ${mutation.name}`)
      assert.equal(child.status, 1, `mutation must fail: ${mutation.name}`)
      assert.ok((child.stdout + child.stderr).includes(mutation.expected), `intended failure: ${mutation.name}\n${child.stdout}${child.stderr}`)
      console.log(`BITE ${mutation.name}: exit ${child.status}; ${mutation.expected}`)
    } finally { writeFileSync(path, original) }
  }
  assert.equal(readFileSync(path, 'utf8'), original)
  console.log(`${mutations.length}/${mutations.length} mutations rejected; client restored byte for byte`)
}
