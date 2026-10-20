/** Offline validation and provider-response regression checks. */
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { mock } from 'bun:test'
import { t, ValidationError } from 'elysia'
import { validationResponse, VALIDATION_MESSAGE } from '../src/utils/validation-response'
import { consumeLLMStream, EmptyLLMResponseError, llmResponseContent, type LLMResponsePart } from '../src/utils/llm-response'
import { internalErrorResponse } from '../src/utils/internal-error-response'
import { log } from '../src/utils/logger'

if (process.argv.includes('--bites')) {
  const mutations = [
    ['raw validation message', '../src/utils/validation-response.ts', 'response: { error: VALIDATION_MESSAGE }', 'response: { error: String(source.message) }', 'validation copy must be plain'],
    ['dropped empty-response reason', '../src/utils/llm-response.ts', 'super(`Empty LLM response (${formatLLMResponseReason(reason)})`)', "super('Empty LLM response')", 'empty stream carries provider reason'],
    ['missing internal error mapping', '../src/utils/internal-error-response.ts', "return { status: 500, body: { error: 'Internal server error' } }", 'return null', 'empty responses keep generic HTTP 500'],
  ]
  for (const [name, file, before, after, expected] of mutations) {
    const path = new URL(file, import.meta.url)
    const original = readFileSync(path, 'utf8')
    assert.equal(original.split(before).length, 2, `one mutation target: ${name}`)
    try {
      writeFileSync(path, original.replace(before, after))
      const proc = Bun.spawn(['bun', 'run', 'audit:error-clarity'], { stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' })
      const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
      assert.notEqual(code, 0, `${name} must fail`)
      assert.ok((stdout + stderr).includes(expected), `${name} must fail its intended assertion`)
      console.log(`BITE ${name}: exit ${code}; ${expected}`)
    } finally {
      writeFileSync(path, original)
    }
    assert.equal(readFileSync(path, 'utf8'), original)
  }
  console.log('3/3 mutations rejected; helpers restored byte for byte')
} else {
  const schema = t.Object({ code: t.String({ minLength: 4 }), phone: t.String() })
  const otpError = new ValidationError('body', schema, { code: '', phone: 'fixture-private-phone' })
  const mapped = validationResponse(otpError)
  assert.ok(!/[{]|"type"|schema|Expected|\/?code/.test(mapped.response.error), 'validation copy must be plain')
  assert.equal(mapped.response.error, VALIDATION_MESSAGE)
  assert.equal(otpError.status, 422)
  assert.equal(mapped.details.on, 'body')
  assert.deepEqual(mapped.details.properties, ['/code'])
  assert.equal(mapped.details.errors[0].summary, 'StringMinLength')
  console.log('PASS real OTP ValidationError maps to plain copy and structured constraints')

  const secret = 'fixture-private-submitted-value'
  for (const on of ['body', 'query', 'params']) {
    const error = new ValidationError(on, schema, { code: { token: secret }, phone: secret })
    const result = validationResponse(error)
    assert.equal(result.details.on, on)
    assert.equal(result.response.error, VALIDATION_MESSAGE)
    assert.ok(!JSON.stringify(result).includes(secret), 'validation logs never contain submitted values')
  }
  const serialized = validationResponse({ message: JSON.stringify({ on: 'body', property: '/code', summary: secret, found: secret }) })
  assert.equal(serialized.response.error, VALIDATION_MESSAGE)
  assert.deepEqual(serialized.details.properties, ['/code'])
  assert.ok(!JSON.stringify(serialized).includes(secret))
  assert.equal(validationResponse(new Error(secret)).response.error, VALIDATION_MESSAGE)
  console.log('PASS body/query/params and serialized validation details exclude submitted values')
  console.log('SAMPLE http.validation', JSON.stringify({ route: '/auth/otp/verify', method: 'POST', ...mapped.details }))

  async function* parts(chunks: LLMResponsePart[]) { yield* chunks }
  const consume = (chunks: LLMResponsePart[]) => consumeLLMStream(parts(chunks), () => {})
  await assert.rejects(consume([{ error: { message: 'fixture upstream unavailable', code: 503 } }]),
    (error: unknown) => error instanceof Error && error.message.startsWith('Empty LLM response')
      && error.message.includes('provider: fixture upstream unavailable; code=503'), 'empty stream carries provider reason')
  console.log('PASS empty stream carries provider reason')
  for (const reason of ['error', 'length', 'content_filter']) {
    await assert.rejects(consume([{ choices: [{ finish_reason: reason }] }]), new RegExp(`Empty LLM response.*finish_reason=${reason}`))
  }
  await assert.rejects(consume([
    { choices: [{ finish_reason: 'length' }] },
    { error: { message: 'fixture failure', code: 'upstream' }, choices: [{ finish_reason: 'error' }] },
    { usage: { completion_tokens: 0 } },
  ]), /Empty LLM response \(finish_reason=error; provider: fixture failure; code=upstream\)/)
  await assert.rejects(consume([]), /Empty LLM response.*no finish reason or provider error supplied/)
  await assert.rejects(consume([{ error: { code: 502 } }]), /provider: code=502/)
  console.log('PASS finish reasons, combined reasons, code-only errors and absent diagnostics')

  const deltas: string[] = []
  const normal = await consumeLLMStream(parts([
    { choices: [{ delta: { content: 'The door ' } }] },
    { choices: [{ delta: { content: 'opens.' } }] },
    { choices: [{ finish_reason: 'stop' }] }, { usage: { completion_tokens: 3 } },
  ]), (delta) => { deltas.push(delta) })
  assert.equal(normal.content, 'The door opens.')
  assert.deepEqual(deltas, ['The door ', 'opens.'])
  assert.equal(normal.finishReason, 'stop')
  assert.deepEqual(normal.usage, { completion_tokens: 3 })
  const partial = await consume([{ choices: [{ delta: { content: 'Kept prose.' } }] }, { error: { message: 'fixture disconnect' } }])
  assert.equal(partial.content, 'Kept prose.')
  assert.equal(partial.providerError, 'fixture disconnect')
  console.log('PASS normal text, deltas, usage and partial text survive unchanged')

  assert.throws(() => llmResponseContent({ error: { message: 'fixture non-stream failure' }, choices: [{ finish_reason: 'error' }] }),
    /Empty LLM response \(finish_reason=error; provider: fixture non-stream failure\)/)
  assert.throws(() => llmResponseContent({ choices: [{ finish_reason: 'length', message: { content: '' } }] }), /finish_reason=length/)
  assert.equal(llmResponseContent({ choices: [{ message: { content: 'Complete prose.' } }] }), 'Complete prose.')
  console.log('PASS non-streamed responses keep reasons and normal text')

  for (const providerError of ['fixture model not found', 'fixture rate limit exceeded', 'fixture Rate exceeded', 'fixture Too many requests']) {
    const error = new EmptyLLMResponseError({ providerError })
    assert.ok(error.message.includes(providerError), 'fixture retains provider text')
    const result = internalErrorResponse(error)
    assert.deepEqual(result, { status: 500, body: { error: 'Internal server error' } }, 'empty responses keep generic HTTP 500')
    assert.ok(!JSON.stringify(result.body).includes(providerError), 'HTTP body excludes provider text')
  }
  for (const error of [new Error('model not found'), new Error('rate limit exceeded'), null, undefined]) {
    assert.equal(internalErrorResponse(error), null, 'other errors retain existing HTTP mappings')
  }
  console.log('PASS empty responses keep generic HTTP 500 for not found, rate limit, Rate and Too many; other errors pass through')

  // Exercise the real client with a local transport; network access is forbidden.
  globalThis.fetch = Object.assign(async () => { throw new Error('Unexpected network access') }, { preconnect: () => {} })
  let response: unknown
  let calls = 0
  const client = { chat: { completions: { create: async () => { calls++; return response } } } }
  mock.module('../src/config/openai', () => ({ getOpenRouter: () => client }))
  const { callLLM, callLLMStream, callLLMWithFallback, callLLMStreamWithFallback, isRateLimitError } = await import('../src/ai/client')
  const req = { model: 'fixture/narrator', messages: [] }
  const warnings: Array<{ message: string; fields: Record<string, unknown> }> = []
  const originalWarn = log.warn
  log.warn = (message, fields = {}) => { warnings.push({ message, fields }) }
  try {
    response = parts([{ choices: [{ delta: { content: 'Kept prose.' } }] }, { error: { message: 'fixture disconnect', code: 502 }, choices: [{ finish_reason: 'error' }] }])
    assert.equal(await callLLMStream(req, () => {}), 'Kept prose.')
    assert.equal(warnings.length, 1)
    assert.equal(warnings[0].message, 'chat.stream_provider_error')
    assert.match(String(warnings[0].fields.reason), /finish_reason=error; provider: fixture disconnect; code=502/)
    response = { error: { message: 'fixture non-stream failure', code: 503 } }
    await assert.rejects(callLLM(req), /Empty LLM response.*fixture non-stream failure; code=503/)
    for (const streamed of [false, true]) {
      const data = { error: { message: 'fixture rate limit 429', code: 429 } }
      response = streamed ? parts([data]) : data
      const before = calls
      await assert.rejects(streamed ? callLLMStreamWithFallback(req, ['fixture/fallback'], () => {})
        : callLLMWithFallback(req, ['fixture/fallback']), (error: unknown) => {
        assert.ok(error instanceof Error && error.message.startsWith('Empty LLM response'))
        assert.equal(isRateLimitError(error), false)
        return true
      })
      assert.equal(calls - before, 1, 'empty response must not gain a fallback')
    }
    assert.equal(isRateLimitError({ status: 429 }), true)
    assert.equal(isRateLimitError(new Error('rate limit 429')), true)
  } finally { log.warn = originalWarn }
  console.log('PASS real client warns after partial prose, includes non-stream errors and preserves fallback policy')
  console.log('error-clarity: all checks passed (no network calls)')
}
