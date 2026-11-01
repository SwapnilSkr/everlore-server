import assert from 'node:assert/strict'
import { mock } from 'bun:test'

// Exercise the real non-streamed client boundary with a fake SDK transport.
mock.module('../src/config/env', () => ({ env: {} }))
let reason = 'length', fail = false
mock.module('../src/config/openai', () => ({ getOpenRouter: () => ({ chat: { completions: { create: async () => {
  if (fail) { fail = false; throw Object.assign(new Error('rate limit'), { status: 429 }) }
  return { choices: [{ finish_reason: reason, message: { content: 'A sentence. Partial' } }] }
} } } }) }))
const { callLLM, callLLMWithFallback } = await import('../src/ai/client')
try {
  const request = { model: 'fake', messages: [{ role: 'user', content: 'Test' }] }
  assert.equal(await callLLM(request), 'A sentence. Partial')
  for (const finishReason of ['length', 'stop']) {
    reason = finishReason
    const result = await callLLMWithFallback(request, [])
    assert.equal(result.finishReason, finishReason)
    assert.equal(result.content, 'A sentence. Partial')
  }
  fail = true; reason = 'length'
  const fallback = await callLLMWithFallback(request, ['backup'])
  assert.equal(fallback.finishReason, 'length'); assert.equal(fallback.model, 'backup')
  console.log('PASS writer finish reason survives transport and fallback without changing string callers')
} catch (error) {
  throw new Error('FAIL writer finish reason', { cause: error })
}
