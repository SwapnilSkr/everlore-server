import assert from 'node:assert/strict'
import { mock } from 'bun:test'
import { ObjectId } from 'mongodb'

type Row = Record<string, unknown>
const calls: Row[] = [], bodies: Row[] = []
const player = new ObjectId(), chats = [new ObjectId(), new ObjectId()]
const unavailable = (): never => { throw new Error('Unexpected external dependency in memory trace audit') }
globalThis.fetch = Object.assign(async () => unavailable(), { preconnect: unavailable })
mock.module('../src/config/env', () => ({ env: {} }))
mock.module('../src/config/redis', () => ({ getRedisClient: unavailable, getQueueRedisClient: unavailable }))
mock.module('../src/config/mongo', () => ({
  coll: (name: string) => ({ createIndex: async () => '', insertMany: async (rows: Row[]) => { (name === 'llm_calls' ? calls : bodies).push(...rows) } }),
  mongoColl: { users: () => ({ findOne: async () => ({ _id: player }) }), events: () => ({ findOne: async () => ({ sequence: 6, player_id: player }) }) },
}))
mock.module('../src/config/openai', () => ({ getOpenRouter: () => ({ chat: { completions: { create: async () => ({
  choices: [{ message: { content: '{}' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, cost: 0.0002 },
}) } } }) }))
const { callLLM } = await import('../src/ai/client')
const { runBackgroundLLMTrace } = await import('../src/services/llm-trace.service')
try {
  for (const instance of chats) for (const purpose of ['memory_curation', 'scene_summary']) {
    await runBackgroundLLMTrace({ instance_id: instance, player_id: player, event_id: String(new ObjectId()) }, () => callLLM({
      model: 'fixture-curator', purpose, messages: [{ role: 'user', content: 'Fixture numbered conversation.' }],
    }))
  }
  for (let i = 0; i < 50 && calls.length < 4; i++) await Bun.sleep(1)
  assert.equal(calls.length, 4); assert.equal(bodies.length, 4)
  for (const instance of chats) {
    const perChat = calls.filter(call => String(call.instance_id) === String(instance))
    assert.deepEqual(perChat.map(call => call.purpose).sort(), ['memory_curation', 'scene_summary'])
    assert(perChat.every(call => call.phase === 'background' && call.sequence === 6 && String(call.player_id) === String(player)))
    assert.equal(perChat.reduce((cost, call) => cost + Number(call.cost_usd), 0), 0.0004)
    assert.equal(perChat.reduce((tokens, call) => tokens + Number(call.total_tokens), 0), 30)
  }
  console.log('PASS memory usage trace stores curator and summary calls and provider costs separately per chat')
} catch (error) { throw new Error('FAIL memory usage trace', { cause: error }) }
