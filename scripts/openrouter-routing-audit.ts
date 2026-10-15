/** Pure regression checks for the chat transport boundary. No provider calls. */
import { readFileSync } from 'node:fs'
import { buildChatRequest } from '../src/ai/client'
import { AI_MODELS } from '../src/ai/models'

const failures: string[] = []
function check(condition: boolean, label: string): void {
  if (condition) console.log(`PASS ${label}`)
  else { failures.push(label); console.error(`FAIL ${label}`) }
}

const excluded = new Set(['embedding', 'image', 'tts'])
const chatModels = Object.entries(AI_MODELS)
  .filter(([key]) => !excluded.has(key))
  .flatMap(([key, value]) => Array.isArray(value)
    ? value.map((model) => [key, model] as const)
    : [[key, value as string] as const])

const bareIds = ['gpt-4o-mini', 'gpt-5.6-luna', 'gpt-5', 'gpt-4o', 'gpt-3.5-turbo', 'gpt-6-example', 'o1', 'o3-mini']
for (const [label, model] of [...chatModels, ...bareIds.map((id) => [`bare ${id}`, id] as const)]) {
  for (const stream of [false, true]) {
    const built = buildChatRequest({ model, messages: [{ role: 'user', content: 'Hi' }] }, stream)
    const expected = /^(?:gpt-|o\d)/i.test(model) ? `openai/${model}` : model
    check(built.client === 'openrouter' && built.params.model === expected,
      `${label} ${stream ? 'stream' : 'chat'} uses OpenRouter as ${expected}`)
  }
}

const schema = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] }
const structured = buildChatRequest({
  model: 'gpt-5.6-luna', messages: [{ role: 'user', content: 'Hi' }],
  responseSchema: schema,
  responseFormat: { type: 'json_schema', json_schema: { name: 'story_metadata', strict: false, schema } },
  reasoningEffort: 'low', sessionId: 'story-1', purpose: 'metadata',
})
check(structured.params.response_format?.type === 'json_schema'
  && structured.params.response_format.json_schema?.schema === schema
  && structured.params.response_format.json_schema?.name === 'story_metadata',
  'schema and existing schema name reach OpenRouter')
check(structured.params.provider?.require_parameters === true
  && structured.params.provider?.sort === 'throughput'
  && structured.params.provider?.allow_fallbacks === true,
  'schema requirement merges with provider preferences')
check(structured.params.session_id === 'story-1' && structured.params.reasoning?.effort === 'low'
  && !('reasoning_effort' in structured.params), 'sticky routing and OpenRouter reasoning dialect')
check(structured.params.max_completion_tokens === 1800
  && !('temperature' in structured.params), 'GPT-5 completion dialect')

const schemaOnly = buildChatRequest({ model: 'gpt-4o-mini', messages: [], responseSchema: schema })
check(schemaOnly.params.response_format?.json_schema?.schema === schema
  && schemaOnly.params.provider?.require_parameters === true,
  'schema-only callers receive JSON schema and endpoint requirement')
const plain = buildChatRequest({ model: 'deepseek/deepseek-v3.2', messages: [], sessionId: 'story-1' }, true)
check(plain.params.session_id === 'story-1' && plain.params.provider?.require_parameters === undefined,
  'streaming sticky route does not require schema parameters')

// The embedding module is deliberately outside this task's editable paths.
const embedding = readFileSync(new URL('../src/ai/embedding.ts', import.meta.url), 'utf8')
check(embedding.includes("import { getOpenAI } from '../config/openai'")
  && (embedding.match(/getOpenAI\(\)\.embeddings\.create/g)?.length ?? 0) === 0
  && (embedding.match(/const openai = getOpenAI\(\)/g)?.length ?? 0) === 2
  && (embedding.match(/openai\.embeddings\.create/g)?.length ?? 0) === 2
  && embedding.includes('const EMBEDDING_DIMENSIONS = 1024'),
  'both embedding calls remain direct OpenAI at 1024 dimensions')

if (failures.length) {
  console.error(`${failures.length} OpenRouter routing checks failed`)
  process.exit(1)
}
console.log('OpenRouter routing audit passed')
