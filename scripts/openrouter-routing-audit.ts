/** Pure regression checks for the chat transport boundary. No provider calls. */
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { buildChatRequest } from '../src/ai/client'
import { AI_MODELS } from '../src/ai/models'
import { env } from '../src/config/env'

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

for (const [label, request] of [
  ['streamed prose', plain],
  ['structured', structured],
  ['streamed schema', buildChatRequest({ model: 'gpt-4o-mini', messages: [], responseSchema: schema }, true)],
  ['streamed JSON', buildChatRequest({ model: 'gpt-4o-mini', messages: [], responseFormat: { type: 'json_object' } }, true)],
  ['replay prose', buildChatRequest({ model: 'gpt-4o-mini', messages: [] })],
] as const) {
  const provider = request.params.provider
  // Both gpt-4o-mini structured shapes are measured: they name their hosts.
  const measured = label === 'streamed schema' || label === 'streamed JSON'
  check((measured ? !('sort' in (provider ?? {})) : provider?.sort === (label === 'streamed prose' ? 'latency' : 'throughput'))
    && provider?.allow_fallbacks === true, `${label} keeps its intended sorting and fallback routing`)
  const prose = label === 'streamed prose' || label === 'replay prose'
  check(prose
    ? Array.isArray(provider?.ignore) && provider.ignore.includes('GMICloud')
    : provider?.ignore === undefined,
  `${label} ${prose ? 'skips' : 'does not filter'} the thinking-only narration host`)
  const p90 = env.OPENROUTER_PREFERRED_P90_LATENCY_SECONDS
  check(!measured && Number.isFinite(p90) && p90 > 0
    ? provider?.preferred_max_latency?.p90 === p90
    : provider?.preferred_max_latency === undefined,
  `${label} ${measured ? 'omits' : 'retains'} the configured soft p90 latency preference`)
}

const orderedModel = 'deepseek/deepseek-v4.1-flash-1017'
const hostOrder = ['InferenceNet', 'Relace', 'Reka']
const ordered = buildChatRequest({ model: orderedModel, messages: [] }, true)
check(JSON.stringify(ordered.params.provider?.order) === JSON.stringify(hostOrder)
  && ordered.params.provider?.allow_fallbacks === true
  && !('sort' in ordered.params.provider)
  && JSON.stringify(ordered.params.provider?.ignore) === JSON.stringify(['GMICloud']),
  '(a) v4.1 narration uses exact host order, automatic fallbacks, no sort and the global ban')
check(JSON.stringify(ordered.params.reasoning) === JSON.stringify({ enabled: false }),
  '(a) v4.1 streamed narration disables thinking')
check(JSON.stringify(plain.params.provider?.ignore) === JSON.stringify(['GMICloud', 'AtlasCloud', 'SiliconFlow'])
  && plain.params.provider?.sort === 'latency' && !('order' in plain.params.provider),
  '(b) v3.2 narration merges model bans and retains latency sorting without order')

for (const model of ['deepseek/deepseek-v4-flash-0731', 'xiaomi/mimo-v2.6-flash']) {
  for (const stream of [false, true]) {
    const { params } = buildChatRequest({ model, messages: [] }, stream)
    check(JSON.stringify(params.provider?.ignore) === JSON.stringify(['GMICloud', 'DeepInfra'])
      && params.provider?.sort === (stream ? 'latency' : 'throughput')
      && !('order' in params.provider),
    `${model} ${stream ? 'stream' : 'replay'} applies only its measured host bans`)
  }
}
const replay = buildChatRequest({ model: orderedModel, messages: [] })
check(JSON.stringify(replay.params.provider?.order) === JSON.stringify(hostOrder)
  && replay.params.provider?.allow_fallbacks === true && !('sort' in replay.params.provider)
  && JSON.stringify(replay.params.provider?.ignore) === JSON.stringify(['GMICloud'])
  && !('reasoning' in replay.params),
  'v4.1 replay retains host order and bans without a thinking override')
const unruled = buildChatRequest({ model: 'gpt-4o-mini', messages: [] }, true)
check(JSON.stringify(unruled.params.provider?.ignore) === JSON.stringify(['GMICloud'])
  && unruled.params.provider?.sort === 'latency' && !('order' in unruled.params.provider)
  && JSON.stringify(unruled.params.reasoning) === JSON.stringify({ enabled: false }),
  'unlisted prose models keep only the global ban and streamed thinking override')
const text = buildChatRequest({ model: orderedModel, messages: [], responseFormat: { type: 'text' } }, true)
check(JSON.stringify(text.params.provider) === JSON.stringify(ordered.params.provider)
  && JSON.stringify(text.params.reasoning) === JSON.stringify(ordered.params.reasoning),
  'explicit text format uses the same streamed prose routing')

for (const model of [orderedModel, 'deepseek/deepseek-v3.2', 'deepseek/deepseek-v4-flash-0731', 'xiaomi/mimo-v2.6-flash']) {
  for (const stream of [false, true]) {
    for (const [format, options] of [
      ['schema', { responseSchema: schema }],
      ['JSON schema', { responseFormat: { type: 'json_schema', json_schema: { name: 'audit', schema } } }],
      ['JSON object', { responseFormat: { type: 'json_object' } }],
    ] as const) {
      const { params } = buildChatRequest({ model, messages: [], reasoningEffort: 'low', ...options }, stream)
      check(!('order' in params.provider) && !('ignore' in params.provider)
        && !('reasoning' in params) && params.provider?.sort === 'throughput'
        && params.provider?.allow_fallbacks === true
        && params.provider?.require_parameters === (format === 'JSON object' ? undefined : true),
      `(c) ${model} ${stream ? 'stream' : 'chat'} ${format} has structured routing without prose overrides`)
    }
  }
}
// Measured structured models name their hosts, streamed or not, with every
// structured shape and both the normalized and bare id. Throughput sorting and
// the p90 hint are gone so neither can move the reply to another host.
const p90 = env.OPENROUTER_PREFERRED_P90_LATENCY_SECONDS
const p90Preference = Number.isFinite(p90) && p90 > 0 ? { preferred_max_latency: { p90 } } : {}
for (const [normalized, order] of [
  ['openai/gpt-4o-mini', ['OpenAI', 'Azure']],
  ['openai/gpt-6-luna', ['Amazon Bedrock', 'OpenAI', 'Azure']],
] as const) {
  for (const model of [normalized, normalized.replace(/^openai\//, '')]) {
    for (const stream of [false, true]) {
      for (const [format, options, requireParameters] of [
        ['JSON object', { responseFormat: { type: 'json_object' } }, false],
        ['JSON schema', { responseFormat: { type: 'json_schema', json_schema: { name: 'audit', schema } } }, true],
        ['schema', { responseSchema: schema }, true],
      ] as const) {
        const { params } = buildChatRequest({ model, messages: [], ...options }, stream)
        const expected = { order: [...order], allow_fallbacks: true, ...(requireParameters ? { require_parameters: true } : {}) }
        check(JSON.stringify(params.provider) === JSON.stringify(expected),
          `(e) ${model} ${stream ? 'stream' : 'chat'} ${format} sends the exact structured host order`)
        check(!('sort' in params.provider) && !('preferred_max_latency' in params.provider) && !('ignore' in params.provider),
          `(e) ${model} ${stream ? 'stream' : 'chat'} ${format} keeps no sort, p90 or ignore`)
      }
    }
  }
}
const proseMini = buildChatRequest({ model: 'gpt-4o-mini', messages: [], purpose: 'scene_summary' })
check(JSON.stringify(proseMini.params.provider) === JSON.stringify({
  sort: 'throughput', ignore: ['GMICloud'], allow_fallbacks: true, ...p90Preference,
}), '(e) a gpt-4o-mini prose call keeps throughput sorting and the p90 preference')
check(!('order' in proseMini.params.provider) && !('reasoning' in proseMini.params),
  '(e) a gpt-4o-mini prose call keeps no host order and no reasoning override')
const unlistedStructured = buildChatRequest({ model: 'gpt-5.6-luna', messages: [], responseSchema: schema }, true)
check(JSON.stringify(unlistedStructured.params.provider) === JSON.stringify({
  sort: 'throughput', allow_fallbacks: true, require_parameters: true, ...p90Preference,
}), '(e) an unlisted structured model keeps throughput sorting and the p90 preference')

for (const model of ['gpt-5.6-luna', 'openai/gpt-5.6-luna']) {
  for (const stream of [false, true]) {
    for (const structuredCall of [false, true]) {
      const request = { model, messages: [], ...(structuredCall ? { responseSchema: schema } : {}) }
      const { params } = buildChatRequest({ ...request, reasoningEffort: 'low' }, stream)
      check(JSON.stringify(params.reasoning) === JSON.stringify({ effort: 'low' }),
        `(d) ${model} ${stream ? 'stream' : 'chat'} ${structuredCall ? 'schema' : 'prose'} keeps effort-only reasoning`)
      check(!('reasoning' in buildChatRequest(request, stream).params),
        `(d) ${model} ${stream ? 'stream' : 'chat'} ${structuredCall ? 'schema' : 'prose'} adds no reasoning without effort`)
    }
  }
}

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

// Opt-in production mutations: no provider calls, and exact restoration even
// when an assertion fails. Only the client file owned by this brief is touched.
if (process.argv.includes('--bites')) {
  const path = new URL('../src/ai/client.ts', import.meta.url)
  const original = readFileSync(path, 'utf8')
  const mutations: Array<{ name: string; before: string; after: string; expected: string }> = [
    { name: 'host order', before: "['InferenceNet', 'Relace', 'Reka']", after: "['Relace', 'InferenceNet', 'Reka']", expected: 'FAIL (a) v4.1 narration uses exact host order' },
    { name: 'ordered fallbacks', before: 'allow_fallbacks: true', after: 'allow_fallbacks: false', expected: 'FAIL (a) v4.1 narration uses exact host order' },
    { name: 'ordered sort omitted', before: '{ order: [...order] }', after: "{ order: [...order], sort: 'latency' }", expected: 'FAIL (a) v4.1 narration uses exact host order' },
    { name: 'global prose ban', before: "['GMICloud'] as const", after: '[] as const', expected: 'FAIL (a) v4.1 narration uses exact host order' },
    { name: 'thinking disabled', before: '{ reasoning: { enabled: false } }', after: '{ reasoning: { enabled: true } }', expected: 'FAIL (a) v4.1 streamed narration disables thinking' },
    { name: 'AtlasCloud ban', before: "['AtlasCloud', 'SiliconFlow']", after: "['SiliconFlow']", expected: 'FAIL (b)' },
    { name: 'SiliconFlow ban', before: "['AtlasCloud', 'SiliconFlow']", after: "['AtlasCloud']", expected: 'FAIL (b)' },
    { name: 'unordered latency sort', before: "sort: narration ? 'latency' : 'throughput'", after: "sort: 'throughput'", expected: 'FAIL (b)' },
    { name: 'v4-flash ban', before: "'deepseek/deepseek-v4-flash-0731': { ignore: ['DeepInfra'] }", after: "'deepseek/deepseek-v4-flash-0731': {}", expected: 'FAIL deepseek/deepseek-v4-flash-0731 stream' },
    { name: 'MiMo ban', before: "'xiaomi/mimo-v2.6-flash': { ignore: ['DeepInfra'] }", after: "'xiaomi/mimo-v2.6-flash': {}", expected: 'FAIL xiaomi/mimo-v2.6-flash stream' },
    { name: 'replay host rules', before: 'const rules = prose ?', after: 'const rules = narration ?', expected: 'FAIL v4.1 replay' },
    { name: 'replay thinking unchanged', before: '((stream && prose) || req.noReasoning) && !isNextGenOpenAIModel(model)', after: '(prose || req.noReasoning) && !isNextGenOpenAIModel(model)', expected: 'FAIL v4.1 replay' },
    { name: 'model ban scope', before: 'NARRATION_HOST_RULES[model] : undefined', after: "NARRATION_HOST_RULES['deepseek/deepseek-v3.2'] : undefined", expected: 'FAIL unlisted prose models' },
    { name: 'explicit text prose', before: "(!req.responseFormat || req.responseFormat.type === 'text')", after: '!req.responseFormat', expected: 'FAIL explicit text format' },
    { name: 'structured order isolation', before: 'const rules = prose ?', after: 'const rules = true ?', expected: 'FAIL (c) deepseek/deepseek-v4.1-flash-1017' },
    { name: 'structured ignore isolation', before: '...(prose ? { ignore:', after: '...(true ? { ignore:', expected: 'FAIL (c)' },
    { name: 'structured thinking isolation', before: '((stream && prose) || req.noReasoning) && !isNextGenOpenAIModel(model)', after: '(stream || req.noReasoning) && !isNextGenOpenAIModel(model)', expected: 'FAIL (c)' },
    { name: 'structured throughput sort', before: "sort: narration ? 'latency' : 'throughput'", after: "sort: 'latency'", expected: 'FAIL (c)' },
    { name: 'structured parameter requirement', before: 'require_parameters: true', after: 'require_parameters: false', expected: 'FAIL (c)' },
    { name: 'measured order swapped', before: "'openai/gpt-4o-mini': ['OpenAI', 'Azure']", after: "'openai/gpt-4o-mini': ['Azure', 'OpenAI']", expected: 'FAIL (e) openai/gpt-4o-mini chat JSON object sends the exact structured host order' },
    { name: 'measured wrong model key', before: "'openai/gpt-6-luna':", after: "'openai/gpt-6-luna-typo':", expected: 'FAIL (e) openai/gpt-6-luna chat JSON object sends the exact structured host order' },
    { name: 'measured sort left in', before: '...(order ? { order: [...order] } :', after: "...(order ? { order: [...order], sort: 'throughput' } :", expected: 'FAIL (e) openai/gpt-4o-mini chat JSON object keeps no sort, p90 or ignore' },
    { name: 'measured p90 left in', before: 'measured === undefined && Number.isFinite(p90) && p90 > 0', after: 'Number.isFinite(p90) && p90 > 0', expected: 'FAIL (e) openai/gpt-4o-mini chat JSON object keeps no sort, p90 or ignore' },
    { name: 'measured rule applied to prose', before: 'const measured = prose ? undefined : STRUCTURED_HOST_ORDER[model]', after: 'const measured = STRUCTURED_HOST_ORDER[model]', expected: 'FAIL (e) a gpt-4o-mini prose call keeps throughput sorting' },
    { name: 'OpenAI effort-only reasoning', before: 'params.reasoning = { effort: req.reasoningEffort }', after: 'params.reasoning = { effort: req.reasoningEffort, enabled: false }', expected: 'FAIL (d)' },
    { name: 'OpenAI no-effort isolation', before: '((stream && prose) || req.noReasoning) && !isNextGenOpenAIModel(model)', after: '(stream && prose)', expected: 'FAIL (d) gpt-5.6-luna stream prose adds no reasoning without effort' },
  ]
  for (const mutation of mutations) {
    try {
      assert.equal(original.split(mutation.before).length, 2, `one mutation target: ${mutation.name}`)
      writeFileSync(path, original.replace(mutation.before, mutation.after))
      const child = spawnSync('bun', ['--no-env-file', 'run', import.meta.path], { encoding: 'utf8', timeout: 10000 })
      assert.equal(child.error, undefined, `child executed: ${mutation.name}`)
      assert.equal(child.status, 1, `mutation must fail: ${mutation.name}`)
      assert.ok((child.stdout + child.stderr).includes(mutation.expected), `intended failure: ${mutation.name}\n${child.stdout}${child.stderr}`)
      console.log(`BITE ${mutation.name}: exit ${child.status}; ${mutation.expected}`)
    } finally { writeFileSync(path, original) }
  }
  assert.equal(readFileSync(path, 'utf8'), original)
  console.log(`${mutations.length}/${mutations.length} mutations rejected; client restored byte for byte`)
}
