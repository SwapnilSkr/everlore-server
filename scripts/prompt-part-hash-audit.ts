/**
 * Pure audit: every narrator prompt block is fingerprinted, never stored.
 *
 * `buildPrompt` returns `parts: {name, chars, hash}[]` — one entry per block of
 * the prompt it emitted, in reading order, where `hash` is the first 16 hex
 * characters of SHA-256 over that block's exact text. The narration trace
 * records them as `llm_calls.prompt_parts`, which is what lets two consecutive
 * turns be compared byte for byte without rebuilding a prompt whose retrieval
 * inputs are already gone. No prompt text is stored in a part.
 *
 * (a)'s baseline is SNAPSHOTTED HERE, not rebuilt from `git show HEAD:`: the
 * digests below were produced by the pre-change builder at commit
 * 7eab73bd854d5da1999a05877866f343b5ca15cb over the fixture matrix at the
 * bottom of this file. They are intentionally brittle — any change to the
 * wording or order of a message is a failure, which is the point.
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mock } from 'bun:test'
import OpenAI from 'openai'
import { buildPrompt } from '../src/utils/prompt-builder'
import { traceFetch, beginLLMTrace, runWithLLMTrace, snapshotLLMTrace } from '../src/ai/usage'

type PromptArgs = Parameters<typeof buildPrompt>[0]
type Part = { name: string; chars: number; hash: string }

mock.module('../src/config/env', () => ({ env: { OPENROUTER_PREFERRED_P90_LATENCY_SECONDS: 3 } }))
const { callLLM, setLLMClientForAudit } = await import('../src/ai/client')

const hashOf = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 16)

let passed = 0
function check(label: string, fn: () => void) {
  fn()
  passed++
  console.log(`PASS ${label}`)
}

// ── fixtures ────────────────────────────────────────────────────────────────
// One matrix that touches every branch of the builder: POV, sentient/GM,
// opening vs continuation, with and without a summary, and the full reference
// set (codex, relationships, positions, scene state, persona, lore, memories,
// threads, summaries, interaction signals, hygiene corrections).
const base: PromptArgs = {
  seedPrompt: 'A lamplit harbour inn where the tide decides who stays.',
  isSentient: false,
  worldState: {},
  activeFlags: {},
  globalLore: 'The harbour trades salt, rope and rumour.',
  retrievedLore: [],
  retrievedMemories: [],
  sceneSummary: null,
  recentEvents: [],
  userMessage: 'I ask the innkeeper about the tide.',
  userSpokenInput: 'I ask the innkeeper about the tide.',
  maxTokens: 9000,
  proseOnly: true,
  narrationPov: 'third',
  chatMode: 'saga',
  narrativeStyle: 'noir',
  narrationTone: 'cinematic',
  toneExampleSeed: 'fixture-instance',
  messageLength: 'medium',
}

const recent = [
  {
    sequence: 1,
    scene_tag: 'dialogue',
    data: {
      player_input: 'I ask about the tide.',
      ai_response: 'She wipes the same clean spot twice. "It turns at midnight."',
      present_characters: ['Mara'],
      state_mutations: { trust: 2 },
      flag_mutations: { tide_known: true },
    },
  },
  {
    sequence: 2,
    scene_tag: 'exploration',
    data: {
      player_input: 'I watch the water.',
      ai_response: 'The harbour lights thin out one by one.',
      present_characters: ['Mara'],
      prose_hygiene_issues: [{ code: 'unbalanced_italics' }, { code: 'length_too_short' }],
      interaction_signals: [
        { source: 'player', target_name: 'Mara', kind: 'warmth', expires_after_sequence: 9 },
      ],
    },
  },
]

const fullReferences: PromptArgs = {
  ...base,
  isSentient: true,
  narrationPov: 'first',
  worldState: { trust: 40, danger: 12 },
  activeFlags: { tide_known: true, debt_open: 'unpaid' },
  retrievedLore: ['The harbour bell rings only for the drowned.', 'Salt keeps the lamps burning.'],
  retrievedMemories: ['Mara once hid me from the excise men.', 'I owe her a favour from the spring fair.'],
  openThreads: ['The unpaid debt to the harbour master.', 'Who rang the bell at dawn?'],
  relevantSummaries: ['An earlier chapter: the storm that closed the harbour for a week.'],
  sceneSummary: 'Mara and I are alone at the bar after closing.',
  timeContext: 'Story date: the first night of the spring tide.',
  locationContext: 'The Salted Lamp, a harbour inn. Back bar, after closing.',
  sceneStateText: 'Mara stands behind the bar, cloth in hand. I sit on the near stool.',
  companionFacts: ['Mara travels with me by default.'],
  relationshipFacts: ['Mara is my sister (alive).', 'Aldric is my father (deceased).'],
  positionFacts: ['Aldric was last seen at the harbour office.'],
  deceasedCharacterNames: ['Aldric'],
  focusCharacterName: 'Mara',
  userNarrationFacts: ['I set the brass key on the bar.'],
  currentInteractionSignals: [
    { source: 'player', target_name: 'Mara', kind: 'vulnerability', expires_after_sequence: 9 },
  ] as never,
  playerPersona: { name: 'Rin', gender: 'female', age: 29, description: 'A tired tide-watcher.' } as never,
  characterCodex: [
    {
      canonical_name: 'Rin',
      is_protagonist: true,
      immutable_facts: ['Born on the north quay.'],
      mutable_state: ['Carries the brass key.'],
    },
    {
      canonical_name: 'Mara',
      role: 'innkeeper',
      aliases: ['Mara the Younger'],
      appearance: 'Grey eyes, salt-stiff hair.',
      persona: 'Blunt, watchful, kind when it counts.',
      immutable_facts: ['Took over the inn from our mother.'],
      mutable_state: ['Hiding the ledger under the bar.'],
      disposition_to_player: 'warm, guarded',
      hidden_thought: 'She has not decided whether to tell me about the debt.',
      relationship: { trust: 71, affection: 54, fear: 8, rivalry: 20 },
      relationship_moments: [{ meter: 'trust', delta: 6, sequence: 2 }],
      relationship_state: { summary: 'Close, but she keeps the ledger to herself.' },
    },
    {
      canonical_name: 'The Harbour Master',
      identity_kind: 'role_label',
      role: 'collects the mooring tolls',
    },
  ],
  recentEvents: recent,
  isContinuation: false,
}

const openingEvent = [
  {
    sequence: 1,
    scene_tag: 'dialogue',
    data: {
      player_input: '',
      ai_response: 'The inn door sticks. Mara looks up from the bar. *"You are late."*',
      present_characters: ['Mara'],
      model_used: 'seed',
    },
  },
]

interface Fixture { id: string; input: PromptArgs; baseline: string }
const FIXTURES: Fixture[] = [
  { id: 'gm-third-opening', input: base, baseline: '68516b2435be1de3b486ec4fdc51a936181ed330c75ba5760a230b83fabdb3f0' },
  { id: 'gm-first-opening', input: { ...base, narrationPov: 'first' }, baseline: 'f65a95b6f2d863f43f5e4f0c8685feee6628b4595ca6b62a3530523a3ca0cb9d' },
  { id: 'sentient-third', input: { ...base, isSentient: true }, baseline: '183d2401e1cf3c7df8ae9b2f70a3e6629f28b2d33b437fb7e4d45f8b7ad3df1e' },
  { id: 'sentient-first-continuation', input: { ...base, isSentient: true, narrationPov: 'first', recentEvents: recent, isContinuation: true }, baseline: 'b5f1d70eaf4fe63e202292b48b20ee59ec1a806a5460802f94551c15aede82e2' },
  { id: 'gm-continuation-no-summary', input: { ...base, recentEvents: recent, isContinuation: true }, baseline: '1d354afdace9c979c932ba3188f5c2e31962aaae316151b1d4f4a8a3dd2b5a6a' },
  { id: 'gm-continuation-with-summary', input: { ...base, recentEvents: recent, sceneSummary: 'Mara counts the till while the lamps gutter.' }, baseline: '5b35f528cb348c6141baffccaae6bdced0bb57701346d7a6568621ae805f43f9' },
  { id: 'full-references', input: fullReferences, baseline: '1c061398153357cba831bb11ba00306d8fafb258182a37a6ed69b625be04e6d9' },
  { id: 'opening-canon', input: { ...base, recentEvents: openingEvent }, baseline: '7c3fd4ff18481c27e00751dc1d22f18bcdfbb1cc24fcb273c67df317de14b19f' },
  { id: 'json-envelope', input: { ...base, proseOnly: false, emitChoices: false, recentEvents: recent }, baseline: 'ecab23957bb8737a388b1c2ed686fd72880c0bb9a93cf52e14f68d0ad28f2f21' },
  { id: 'json-envelope-choices', input: { ...base, proseOnly: false, emitChoices: true, recentEvents: [] }, baseline: '999de7af105e9b54a0b3a63f6aa5d861f9ed07aa5e61ef2beada72f21b0d3482' },
]

const built = FIXTURES.map((fixture) => ({ ...fixture, prompt: buildPrompt(fixture.input) }))
const messagesOf = (prompt: { messages: Array<{ content: string }> }) =>
  prompt.messages.map((message) => message.content).join('')
const partIndex = (parts: Part[], name: string) => {
  const index = parts.findIndex((part) => part.name === name)
  assert.ok(index >= 0, `no part named ${name}`)
  return index
}

// ── (a) the prompt text did not move ───────────────────────────────────────
check('(a) every fixture emits the pre-change messages byte for byte', () => {
  for (const { id, prompt, baseline } of built) {
    assert.equal(
      createHash('sha256').update(JSON.stringify(prompt.messages)).digest('hex'),
      baseline,
      `${id}: emitted messages changed`,
    )
  }
})

// ── (b) the parts tile the messages exactly ────────────────────────────────
check('(b) part texts tile the messages; each hash is that slice; every chars > 0', () => {
  for (const { id, prompt } of built) {
    const text = messagesOf(prompt)
    assert.ok(prompt.parts.length > 0, `${id}: no parts`)
    let cursor = 0
    for (const part of prompt.parts) {
      assert.ok(part.chars > 0, `${id}/${part.name}: empty part`)
      const slice = text.slice(cursor, cursor + part.chars)
      assert.equal(slice.length, part.chars, `${id}/${part.name}: short slice`)
      assert.equal(hashOf(slice), part.hash, `${id}/${part.name}: hash is not its own slice`)
      cursor += part.chars
    }
    assert.equal(cursor, text.length, `${id}: parts leave text uncovered`)
  }
})

// ── (c) the same input fingerprints the same, and one memory moves one part ─
check('(c) identical inputs match; one changed memory moves only the memories part onward', () => {
  const first = buildPrompt(fullReferences)
  const second = buildPrompt(fullReferences)
  assert.deepEqual(first.parts, second.parts, 'same input, different parts')

  const appended = ', twice'
  const changed = buildPrompt({
    ...fullReferences,
    retrievedMemories: ['Mara once hid me from the excise men.', `I owe her a favour from the spring fair${appended}.`],
  })
  const boundary = partIndex(changed.parts, 'retrieved_memories')
  assert.equal(boundary, partIndex(first.parts, 'retrieved_memories'))
  assert.notEqual(changed.parts[boundary].hash, first.parts[boundary].hash, 'memories part did not move')
  assert.deepEqual(changed.parts.slice(0, boundary), first.parts.slice(0, boundary), 'an earlier part moved')
  assert.equal(changed.parts[boundary].chars - first.parts[boundary].chars, appended.length)
})

// ── (d) the player's message moves only the last part ─────────────────────
check("(d) a different player message moves only player_input", () => {
  const input: PromptArgs = { ...base, userSpokenInput: undefined }
  const before = buildPrompt(input)
  const after = buildPrompt({ ...input, userMessage: 'I ask the innkeeper about the debt instead.' })
  const last = before.parts.length - 1
  assert.equal(before.parts[last].name, 'player_input')
  assert.deepEqual(after.parts.slice(0, last), before.parts.slice(0, last), 'an earlier part moved')
  assert.equal(after.parts.length, before.parts.length, 'part count changed')
  assert.equal(after.parts[last].name, 'player_input')
  assert.notEqual(after.parts[last].hash, before.parts[last].hash, 'player_input did not move')
})

// ── (e) a part is a fingerprint and nothing else ──────────────────────────
check('(e) hashes are 16 lowercase hex chars and no part carries text', () => {
  for (const { id, prompt } of built) {
    for (const part of prompt.parts) {
      assert.deepEqual(Object.keys(part).sort(), ['chars', 'hash', 'name'], `${id}: extra part keys`)
      assert.match(part.hash, /^[0-9a-f]{16}$/, `${id}/${part.name}: malformed hash`)
      assert.equal(typeof part.chars, 'number')
      assert.ok(Number.isInteger(part.chars))
    }
  }
})

// ── (f) only a narration trace records prompt_parts ───────────────────────
const sent: Array<Record<string, unknown>> = []
const originalFetch = globalThis.fetch
globalThis.fetch = Object.assign(async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
  sent.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
  return Response.json({
    id: 'gen-fixture',
    provider: 'Fixture host',
    choices: [{ message: { content: 'A reply.' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
  })
}, { preconnect: originalFetch.preconnect }) as typeof fetch
setLLMClientForAudit(new OpenAI({ apiKey: 'fixture-only', baseURL: 'http://fixture.invalid/v1', fetch: traceFetch }))
try {
  const narrationParts: Part[] = buildPrompt(fullReferences).parts
  let calls: ReturnType<typeof snapshotLLMTrace>[number]['call'][] = []
  await runWithLLMTrace({}, async () => {
    await callLLM({
      model: 'fixture/narrator',
      purpose: 'narration',
      messages: [{ role: 'user', content: 'Continue.' }],
      promptSections: [{ name: 'static_prefix', chars: 10 }],
      promptParts: narrationParts,
    })
    await callLLM({ model: 'fixture/narrator', purpose: 'choice_metadata', messages: [{ role: 'user', content: 'Continue.' }] })
    calls = snapshotLLMTrace().map((record) => record.call)
  })
  check('(f) narration trace carries prompt_parts, others do not, no body carries it', () => {
    const narration = calls.find((call) => call.purpose === 'narration')!
    const other = calls.find((call) => call.purpose === 'choice_metadata')!
    assert.deepEqual(narration.prompt_parts, narrationParts)
    assert.equal('prompt_parts' in other, false)
    assert.deepEqual(other.prompt_sections, [{ name: 'user', chars: 9, tokens_est: 2.25 }])
    for (const body of sent) {
      assert.equal('promptParts' in body, false)
      assert.equal('prompt_parts' in body, false)
    }
  })
} finally {
  globalThis.fetch = originalFetch
  setLLMClientForAudit(null)
}

await runWithLLMTrace({}, async () => {
  const withParts = beginLLMTrace({
    model: 'fixture/direct', purpose: 'narration', streamed: false, messages: [], params: {},
    parts: [{ name: 'static_prefix', chars: 4, hash: '0123456789abcdef' }],
  })!
  const withoutParts = beginLLMTrace({ model: 'fixture/direct', purpose: 'scene_witness', streamed: false, messages: [], params: {} })!
  check('(f) beginLLMTrace records parts only when they are supplied', () => {
    assert.deepEqual(withParts.call.prompt_parts, [{ name: 'static_prefix', chars: 4, hash: '0123456789abcdef' }])
    assert.equal('prompt_parts' in withoutParts.call, false)
    assert.ok(Array.isArray(withParts.call.prompt_sections) && withParts.call.prompt_sections.length === 0)
  })
})

// ── reported shape ────────────────────────────────────────────────────────
const sample = built.find(({ id }) => id === 'full-references')!
console.log(`\npart names (${sample.id}, emission order):\n  ${sample.prompt.parts.map((part) => part.name).join(', ')}`)
console.log(`\nPrompt part hash audit: ${passed} passed, 0 failed`)
