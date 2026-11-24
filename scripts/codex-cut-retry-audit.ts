/**
 * Pure regression checks for the codex extraction cut-retry: a single-turn
 * extraction that runs out of room (or is filtered, malformed or throws) gets
 * exactly one more call at the bigger budget, with low reasoning effort. No
 * provider calls: `params.call` stands in and records every request.
 *
 *   bun --no-env-file run scripts/codex-cut-retry-audit.ts [--bites]
 */
import assert from 'node:assert/strict'

// env.ts validates production auth at import time; this audit never touches it.
process.env.NODE_ENV = 'test'
const { extractCharacterCodexDeltas, extractCharacterCodexBatch } = await import('../worker/lib/character-codex-extractor')
const { AI_MODELS } = await import('../src/ai/models')

const failures: string[] = []
function check(label: string, fn: () => void): void {
  try { fn(); console.log(`PASS ${label}`) }
  catch (error) { failures.push(label); console.error(`FAIL ${label}`); console.error(error) }
}

interface FakeReply {
  text?: string
  finish?: string | null
  error?: unknown
}
interface RecordedCall {
  kind: 'extraction' | 'adjudication'
  request: Record<string, any>
}

let plan: FakeReply[] = []
let calls: RecordedCall[] = []
const JUDGE_REPLY = '{"reject":[],"supplements":[]}'

const fakeCall = async (request: Record<string, any>): Promise<string> => {
  const kind = request.maxTokens === 700 ? 'adjudication' : 'extraction'
  calls.push({ kind, request })
  if (kind === 'adjudication') return JUDGE_REPLY
  const reply = plan.shift()
  assert.ok(reply, 'unexpected extra extraction call')
  if (reply.error !== undefined) throw reply.error
  request.onFinishReason?.(reply.finish ?? null)
  return reply.text ?? ''
}

const GOOD = '{"characters":[]}'

const baseParams = {
  playerInput: 'I look around the room.',
  aiResponse: 'The room is quiet and dust hangs in the light.',
  existing: [],
}

async function run(replies: FakeReply[]) {
  plan = [...replies]
  calls = []
  const raw: string[] = []
  const lost: Array<{ reason: string }> = []
  let deltas: unknown
  let error: unknown
  try {
    deltas = await extractCharacterCodexDeltas({
      ...baseParams,
      call: fakeCall as never,
      onRaw: (text) => raw.push(text),
      onLost: (info) => lost.push(info),
    })
  } catch (caught) { error = caught }
  return {
    deltas,
    error,
    raw,
    lost,
    calls,
    extraction: calls.filter((call) => call.kind === 'extraction'),
    adjudication: calls.filter((call) => call.kind === 'adjudication'),
  }
}

const cutJson = '{"characters":['
const malformed = 'the model did not answer in JSON'

// --- length then good --------------------------------------------------------
{
  // A parseable reply is still unusable when the provider says it was cut.
  const result = await run([{ text: GOOD, finish: 'length' }, { text: GOOD, finish: 'stop' }])
  check('a length-cut first reply is retried once and recovered', () => {
    assert.equal(result.error, undefined)
    assert.equal(result.extraction.length, 2)
    assert.equal(result.lost.length, 0)
    assert.deepEqual(result.deltas, [])
    assert.deepEqual(result.raw, [GOOD])
  })
  check('the first extraction asks for 1800 tokens', () => {
    assert.equal(result.extraction[0].request.maxTokens, 1800)
  })
  check('the retry asks for 3600 tokens', () => {
    assert.equal(result.extraction[1].request.maxTokens, 3600)
  })
  check('the retry differs only in its token budget', () => {
    const [first, retry] = result.extraction.map((call) => call.request)
    assert.notEqual(first, retry)
    for (const key of ['purpose', 'model', 'messages', 'temperature', 'responseFormat', 'reasoningEffort']) {
      assert.deepEqual(retry[key], first[key], key)
    }
  })
  check('both extraction attempts ask for low effort', () => {
    assert.deepEqual(result.extraction.map((call) => call.request.reasoningEffort), ['low', 'low'])
  })
  check('onRaw fires once with the text used', () => {
    assert.deepEqual(result.raw, [GOOD])
  })
}

// --- content_filter that still parses ---------------------------------------
{
  const result = await run([{ text: GOOD, finish: 'content_filter' }, { text: GOOD, finish: 'stop' }])
  check('a content_filter reply that parses is still retried', () => {
    assert.equal(result.error, undefined)
    assert.equal(result.extraction.length, 2)
    assert.equal(result.lost.length, 0)
    assert.deepEqual(result.deltas, [])
  })
}

// --- malformed then good -----------------------------------------------------
{
  const result = await run([{ text: malformed, finish: 'stop' }, { text: GOOD, finish: 'stop' }])
  check('a malformed first reply is retried', () => {
    assert.equal(result.error, undefined)
    assert.equal(result.extraction.length, 2)
    assert.deepEqual(result.raw, [GOOD])
  })
}

// --- throw then good ---------------------------------------------------------
{
  const result = await run([{ error: new Error('fixture transport failure') }, { text: GOOD, finish: 'stop' }])
  check('a thrown first call is retried', () => {
    assert.equal(result.error, undefined)
    assert.equal(result.extraction.length, 2)
    assert.equal(result.lost.length, 0)
  })
}

// --- a usable empty array is a real "nothing changed" ------------------------
{
  const result = await run([{ text: GOOD, finish: 'stop' }])
  check('a usable empty characters array is never retried', () => {
    assert.equal(result.error, undefined)
    assert.equal(result.extraction.length, 1)
    assert.equal(result.lost.length, 0)
    assert.deepEqual(result.deltas, [])
  })
}

// --- both attempts unusable --------------------------------------------------
for (const scenario of [
  { label: 'length', replies: [{ text: cutJson, finish: 'length' }, { text: cutJson, finish: 'length' }] },
  { label: 'content_filter', replies: [{ text: GOOD, finish: 'content_filter' }, { text: GOOD, finish: 'content_filter' }] },
  { label: 'malformed', replies: [{ text: malformed, finish: 'stop' }, { text: malformed, finish: 'stop' }] },
  { label: 'error', replies: [{ error: new Error('first') }, { error: new Error('second') }] },
]) {
  const result = await run(scenario.replies)
  check(`both attempts ${scenario.label} reports reason ${scenario.label}`, () => {
    assert.equal(result.error, undefined)
    assert.equal(result.extraction.length, 2)
    assert.deepEqual(result.deltas, [])
    assert.deepEqual(result.lost, [{ reason: scenario.label }])
    if (scenario.label === 'error') assert.equal(result.adjudication.length, 0)
  })
}

// --- onLost / onRaw details --------------------------------------------------
{
  const result = await run([{ text: malformed, finish: 'stop' }, { text: malformed, finish: 'stop' }])
  check('both attempts failing calls onLost once', () => {
    assert.equal(result.lost.length, 1)
  })
  check('onLost carries only the reason token', () => {
    assert.deepEqual(Object.keys(result.lost[0]), ['reason'])
    const serialized = JSON.stringify(result.lost[0])
    assert.equal(serialized.includes(baseParams.playerInput), false)
    assert.equal(serialized.includes(baseParams.aiResponse), false)
    assert.equal(serialized.includes(malformed), false)
  })
  check('onRaw fires once on a lost turn', () => {
    assert.deepEqual(result.raw, [malformed])
  })
}
{
  const result = await run([{ text: 'FIRST TEXT', finish: 'stop' }, { error: new Error('retry failed') }])
  check('a retry that throws falls back to the first text', () => {
    assert.equal(result.error, undefined)
    assert.deepEqual(result.deltas, [])
    assert.deepEqual(result.raw, ['FIRST TEXT'])
    assert.deepEqual(result.lost, [{ reason: 'error' }])
  })
}

// --- batch: one call, throws as before, effort and size ----------------------
{
  plan = [{ error: new Error('batch boom') }]
  calls = []
  let error: unknown
  try {
    await extractCharacterCodexBatch({
      existing: [],
      call: fakeCall as never,
      turns: [
        { sequence: 1, playerInput: 'one', aiResponse: 'first turn', presentCast: [] },
        { sequence: 2, playerInput: 'two', aiResponse: 'second turn', presentCast: [] },
      ],
    })
  } catch (caught) { error = caught }
  const extraction = calls.filter((call) => call.kind === 'extraction')
  check('a failed batch extraction still throws', () => {
    assert.ok(error instanceof Error)
    assert.equal((error as Error).message, 'batch boom')
  })
  check('a batch extraction is a single call', () => {
    assert.equal(extraction.length, 1)
    assert.equal(calls.length, 1)
  })
  check('the batch carries effort and 1800 tokens per turn', () => {
    assert.equal(extraction[0].request.maxTokens, 3600)
    assert.equal(extraction[0].request.reasoningEffort, 'low')
  })
}

// --- the bond adjudication call is untouched ---------------------------------
{
  const result = await run([{ text: GOOD, finish: 'stop' }])
  check('the bond adjudication request is unchanged', () => {
    assert.equal(result.adjudication.length, 1)
    const request = result.adjudication[0].request
    assert.equal(request.purpose, 'codex_extraction')
    assert.equal(request.model, AI_MODELS.metadata)
    assert.equal(request.maxTokens, 700)
    assert.equal(request.temperature, 0)
    assert.deepEqual(request.responseFormat, { type: 'json_object' })
    assert.equal('reasoningEffort' in request, false)
  })
}

if (failures.length) {
  console.error(`${failures.length} codex cut-retry checks failed`)
  process.exit(1)
}
console.log('Codex cut-retry audit passed')

// Opt-in mutations: no provider calls, exact restoration even when an assertion
// fails. Only the extractor file owned by this brief is touched.
if (process.argv.includes('--bites')) {
  const { readFileSync, writeFileSync } = await import('node:fs')
  const { spawnSync } = await import('node:child_process')
  const path = new URL('../worker/lib/character-codex-extractor.ts', import.meta.url)
  const original = readFileSync(path, 'utf8')
  const firstCall = 'const first = await callAttempt(1800 * (turns?.length || 1))'
  const retryCall = 'const retry = await callAttempt(3600)'
  const reasonGate = "first.finishReason === 'length' || first.finishReason === 'content_filter'"
  const usable = '&& Array.isArray((parsed as Record<string, unknown>).characters)'
  const onLostCall = 'params.onLost?.({ reason })'
  const mutations: Array<{ name: string; before: string; after: string; expected: string }> = [
    { name: 'first effort', before: "reasoningEffort: 'low',", after: "reasoningEffort: 'medium',", expected: 'FAIL both extraction attempts ask for low effort' },
    { name: 'first size', before: firstCall, after: 'const first = await callAttempt(900 * (turns?.length || 1))', expected: 'FAIL the first extraction asks for 1800 tokens' },
    { name: 'retry size', before: retryCall, after: 'const retry = await callAttempt(1800)', expected: 'FAIL the retry asks for 3600 tokens' },
    { name: 'retry request drift', before: '        model: AI_MODELS.codexExtraction,', after: "        model: maxTokens > 2000 ? 'fixture/other-model' : AI_MODELS.codexExtraction,", expected: 'FAIL the retry differs only in its token budget' },
    { name: 'length reason', before: reasonGate, after: "first.finishReason === 'content_filter'", expected: 'FAIL a length-cut first reply is retried once and recovered' },
    { name: 'filter reason', before: reasonGate, after: "first.finishReason === 'length'", expected: 'FAIL a content_filter reply that parses is still retried' },
    { name: 'malformed reason', before: '} else if (!isUsableCodexReply(first.text)) {', after: '} else if (false) {', expected: 'FAIL a malformed first reply is retried' },
    { name: 'error reason', before: "    unusable = 'error'", after: '    return []', expected: 'FAIL a thrown first call is retried' },
    { name: 'empty array usable', before: usable, after: `${usable} && ((parsed as Record<string, unknown>).characters as unknown[]).length > 0`, expected: 'FAIL a usable empty characters array is never retried' },
    { name: 'lost call still judged', before: 'if (raw === undefined) return []', after: 'if (false) return []', expected: 'FAIL both attempts error reports reason error' },
    { name: 'onLost twice', before: onLostCall, after: `${onLostCall}; ${onLostCall}`, expected: 'FAIL both attempts failing calls onLost once' },
    { name: 'onLost length reason', before: "retry.finishReason === 'length' ? 'length'", after: "retry.finishReason === 'length' ? 'malformed'", expected: 'FAIL both attempts length reports reason length' },
    { name: 'onLost filter reason', before: "retry.finishReason === 'content_filter' ? 'content_filter'", after: "retry.finishReason === 'content_filter' ? 'malformed'", expected: 'FAIL both attempts content_filter reports reason content_filter' },
    { name: 'onLost error reason', before: "retry.error !== undefined ? 'error'", after: "retry.error !== undefined ? 'malformed'", expected: 'FAIL both attempts error reports reason error' },
    { name: 'onLost carries text', before: onLostCall, after: 'params.onLost?.({ reason, text: raw })', expected: 'FAIL onLost carries only the reason token' },
    { name: 'fallback ignores first', before: 'const raw = retry.error === undefined && retry.text !== undefined ? retry.text : first.text', after: 'const raw = retry.text', expected: 'FAIL a retry that throws falls back to the first text' },
    { name: 'onRaw twice', before: "params.onRaw?.(retry.text ?? '')", after: "params.onRaw?.(retry.text ?? ''); params.onRaw?.(retry.text ?? '')", expected: 'FAIL onRaw fires once with the text used' },
    { name: 'batch throw swallowed', before: 'if (first.error !== undefined) throw first.error', after: 'if (false) throw first.error', expected: 'FAIL a failed batch extraction still throws' },
    { name: 'batch size', before: firstCall, after: 'const first = await callAttempt(1800)', expected: 'FAIL the batch carries effort and 1800 tokens per turn' },
    { name: 'batch retried', before: `${firstCall}\n  if (turns) {`, after: `${firstCall}\n  if (turns && false) {`, expected: 'FAIL a failed batch extraction still throws' },
    { name: 'adjudication altered', before: 'maxTokens: 700 * (params.turns?.length || 1),', after: 'maxTokens: 900 * (params.turns?.length || 1),', expected: 'FAIL the bond adjudication request is unchanged' },
  ]
  for (const mutation of mutations) {
    try {
      assert.equal(original.split(mutation.before).length, 2, `one mutation target: ${mutation.name}`)
      writeFileSync(path, original.replace(mutation.before, mutation.after))
      const child = spawnSync('bun', ['--no-env-file', 'run', import.meta.path], { encoding: 'utf8', timeout: 60000 })
      assert.equal(child.error, undefined, `child executed: ${mutation.name}`)
      assert.equal(child.status, 1, `mutation must fail: ${mutation.name}`)
      assert.ok((child.stdout + child.stderr).includes(mutation.expected), `intended failure: ${mutation.name}\n${child.stdout}${child.stderr}`)
      console.log(`BITE ${mutation.name}: exit ${child.status}; ${mutation.expected}`)
    } finally { writeFileSync(path, original) }
  }
  assert.equal(readFileSync(path, 'utf8'), original)
  console.log(`${mutations.length}/${mutations.length} mutations rejected; extractor restored byte for byte`)
}
