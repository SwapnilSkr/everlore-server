// Explicitly authorized tiny live probe: two calls, <=20 output tokens each.
// This import graph has no Mongo/Redis connection modules.
import { callLLM, callLLMStream } from '../src/ai/client'
import { runWithLLMTrace, runWithLLMUsage, snapshotLLMTrace } from '../src/ai/usage'

await runWithLLMTrace({}, () => runWithLLMUsage(async () => {
  const request = { model: 'openai/gpt-4o-mini', purpose: 'trace_probe', maxTokens: 20,
    messages: [{ role: 'user', content: 'Reply with the word ready.' }] }
  try {
    await callLLM(request)
    await callLLMStream(request, () => {})
  } catch {
    console.error('Probe request failed; inspect the bounded error below.')
    process.exitCode = 1
  }
  const calls = snapshotLLMTrace().map(record => record.call)
  console.log(JSON.stringify({ calls, spend_usd: calls.reduce((n, c) => n + (c.cost_usd ?? 0), 0),
    missing_cost: calls.some(call => call.cost_usd === undefined) }, null, 2))
}))
