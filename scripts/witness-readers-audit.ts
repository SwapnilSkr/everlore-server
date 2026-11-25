/**
 * WITNESS READERS: everything that reads a STORED turn and decides what
 * happened sees the hidden English copy of a non-English save
 * (`everlore-docs/phases/reply-language.md` §4, §9a; brief rl-3r).
 *
 * Two rules, tested here on the real functions:
 *  - a reader that DECIDES reads `witnessOf` — a native/English side by side,
 *    only the English may reach it;
 *  - an English save is byte-for-byte the same: the same functions on an event
 *    with no witness produce the frozen output the unmodified code produced.
 *
 * Pure: no network, no DB, no model call. Every reader under test is exported
 * for exactly this purpose (a small named function, not a copy).
 *
 *   bun --no-env-file run scripts/witness-readers-audit.ts
 *   bun --no-env-file run scripts/witness-readers-audit.ts --bites
 */
import assert from 'node:assert/strict'
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { witnessOf, playerTextOf, WITNESS_PROJECTION, keywordQueryTextFor } from '../src/utils/witness'
import { eventPlayerParts, openingSceneCanon } from '../src/utils/prompt-builder'
import { continueNarration } from '../src/services/context-packet.service'
import { sceneCarryProse } from '../src/services/scene-state.service'
import { lookEvidenceProse } from '../src/services/media/look-evidence'
import { liveFrameLanguage } from '../src/utils/reply-language'
import { characterProjectionTurnInputs } from '../worker/processors/character-projection.processor'
import { batchRowReady } from '../worker/lib/character-projection-lease'
import { storySummarySource } from '../worker/processors/summary.processor'
import { authoredOpeningForChoice } from '../worker/processors/generation.processor'
import { offeredChipEnglish } from '../worker/lib/player-turn'

// ── fixtures: one turn with a native side and an English side ────────────────
const NATIVE_PROSE = 'Mara entra no salão e pendura o casaco molhado. "Você demorou", ela diz.'
const ENGLISH_PROSE = 'Mara enters the hall and hangs up her wet coat. "You took your time", she says.'
const NATIVE_PLAYER = '*Eu me encosto no batente, observando-a.* Quanto tempo você ficou fora?'
const ENGLISH_PLAYER = '*I lean against the doorframe, watching her.* How long were you away?'
const NATIVE_SPOKEN = 'Quanto tempo você ficou fora?'
const ENGLISH_SPOKEN = 'How long were you away?'
const NATIVE_FACTS = ['Eu me encosto no batente, observando-a.']
const ENGLISH_FACTS = ['I lean against the doorframe, watching her.']

/** A non-English turn: native fields PLUS the hidden English copy. */
const bilingual = (sequence = 2) => ({
  sequence,
  scene_tag: 'dialogue',
  data: {
    player_input: NATIVE_PLAYER,
    player_spoken_input: NATIVE_SPOKEN,
    player_narration_facts: NATIVE_FACTS,
    ai_response: NATIVE_PROSE,
    present_characters: ['Mara'],
    state_mutations: {},
    flag_mutations: {},
    witness: {
      lang: 'pt',
      ai_response: ENGLISH_PROSE,
      player_input: ENGLISH_PLAYER,
      player_spoken_input: ENGLISH_SPOKEN,
      player_narration_facts: ENGLISH_FACTS,
    },
  },
})

/** The SAME turn on an English save: no witness key at all. */
const english = (sequence = 2) => ({
  sequence,
  scene_tag: 'dialogue',
  data: {
    player_input: ENGLISH_PLAYER,
    player_spoken_input: ENGLISH_SPOKEN,
    player_narration_facts: ENGLISH_FACTS,
    ai_response: ENGLISH_PROSE,
    present_characters: ['Mara'],
    state_mutations: {},
    flag_mutations: {},
  },
})

let pass = 0
let fail = 0
async function check(label: string, fn: () => Promise<void> | void) {
  try {
    await fn()
    pass++
    console.log(`  ok   ${label}`)
  } catch (err) {
    fail++
    console.log(`  FAIL ${label}\n       ${(err as Error).message}`)
  }
}

// ── 1. the witness view itself ──────────────────────────────────────────────
await check('witnessOf: the English side wins; an English row is returned exactly', () => {
  const view = witnessOf(bilingual())
  assert.equal(view.ai_response, ENGLISH_PROSE)
  assert.equal(view.player_input, ENGLISH_PLAYER)
  assert.equal(view.player_spoken_input, ENGLISH_SPOKEN)
  assert.deepEqual(view.player_narration_facts, ENGLISH_FACTS)
  // An English save: the same objects it already had, no copy, no undefined.
  const own = english()
  const native = witnessOf(own)
  assert.equal(native.ai_response, own.data.ai_response)
  assert.equal(native.player_input, own.data.player_input)
  assert.equal(native.player_narration_facts, own.data.player_narration_facts)
  // A failed copy reads native.
  const failed = witnessOf({ data: { ...bilingual().data, witness_status: 'failed' } })
  assert.equal(failed.ai_response, NATIVE_PROSE)
  assert.equal(failed.player_input, NATIVE_PLAYER)
})

await check('playerTextOf: the English player text, native fallback for a stored row', () => {
  assert.equal(playerTextOf(bilingual()), ENGLISH_PLAYER)
  assert.equal(playerTextOf(english()), ENGLISH_PLAYER)
  // The fallback only covers a row with NO player text; it never overrides an
  // English player text that is present.
  assert.equal(playerTextOf(bilingual(), 'stored'), ENGLISH_PLAYER)
  assert.equal(playerTextOf({ data: { witness: { ai_response: 'x', player_input: '' } }, userMessage: 'stored' }, 'stored'), 'stored')
})

// ── 2. prompt-builder continuity line: one view, never mixed ────────────────
await check('continuity line: both player fields come from the English side', () => {
  const parts = eventPlayerParts(bilingual())
  assert.equal(parts.spoken, ENGLISH_SPOKEN)
  assert.deepEqual(parts.narrationFacts, ENGLISH_FACTS)
  // The English transform of a frozen English event is byte-identical.
  const plain = eventPlayerParts(english())
  assert.deepEqual(plain, { spoken: ENGLISH_SPOKEN, narrationFacts: ENGLISH_FACTS })
  // NEVER mixed: a row whose witness has no spoken/facts re-parses the ENGLISH
  // player text — it must not fall back to the native `player_input`. The parse
  // of the English text yields the English narration fact, not the native one.
  const noParts = eventPlayerParts({
    data: { ...bilingual().data, player_narration_facts: undefined, player_spoken_input: undefined, witness: { ai_response: ENGLISH_PROSE, player_input: ENGLISH_PLAYER } },
  })
  assert.equal(noParts.spoken, 'How long were you away?')
  assert.deepEqual(noParts.narrationFacts, ENGLISH_FACTS)
  assert.ok(!JSON.stringify(noParts).includes('Eu me encosto'), 'the native player text must not be parsed')
})

await check('continuity line: an English event is the frozen output of the unmodified code', () => {
  // The unmodified code read `data.player_spoken_input`/`data.player_narration_facts`
  // directly; for an English row that is the identical object `witnessOf` returns.
  const frozen = {
    spoken: String(english().data.player_spoken_input || '').trim(),
    narrationFacts: (english().data.player_narration_facts || []).map((f) => String(f).trim()).filter(Boolean),
  }
  assert.deepEqual(eventPlayerParts(english()), frozen)
})

await check('openingSceneCanon: an authored brand-new opening is its own (English) prose', () => {
  const seed = { sequence: 1, data: { player_input: '', ai_response: 'The inn door sticks.', model_used: 'seed' } }
  assert.equal(openingSceneCanon([seed]), 'The inn door sticks.')
  // A player-made world's opening that is NOT English carries a witness; the
  // canon brief reads the English side (§6, §9a).
  const nonEnglishSeed = { sequence: 1, data: { player_input: '', ai_response: 'A porta range.', model_used: 'seed',
    witness: { lang: 'pt', ai_response: 'The door creaks.', player_input: '' } } }
  assert.equal(openingSceneCanon([nonEnglishSeed]), 'The door creaks.')
  // Not the first generated turn: no opening canon at all.
  assert.equal(openingSceneCanon([seed, english(2)]), null)
})

// ── 3. the choice context's authored opening and the opening cast ───────────
await check('choice context opening: the seed opening is read on its English side at the call site', async () => {
  const seed = { sequence: 1, data: { player_input: '', ai_response: NATIVE_PROSE, model_used: 'seed',
    witness: { lang: 'pt', ai_response: ENGLISH_PROSE, player_input: '' } } }
  assert.equal(authoredOpeningForChoice([seed]), ENGLISH_PROSE)
  const plainSeed = { sequence: 1, data: { player_input: '', ai_response: ENGLISH_PROSE, model_used: 'seed' } }
  assert.equal(authoredOpeningForChoice([plainSeed]), ENGLISH_PROSE)
  // More than one event (or no seed) means no authored opening.
  assert.equal(authoredOpeningForChoice([plainSeed, english(2)]), '')
  // The builder itself reads no event: the caller hands it the already-read
  // opening, so the AST-extracted builder keeps its closure (beat-ledger-split).
  const source = await readFile(new URL('../worker/processors/generation.processor.ts', import.meta.url), 'utf8')
  const builder = source.slice(source.indexOf('function buildChoiceDecisionContext'))
  const body = builder.slice(0, builder.indexOf('\n}\n'))
  assert.ok(body.includes('String(input.authoredOpening || \'\').trim()'), 'the builder must take the opening as input')
  assert.ok(!body.includes("data?.ai_response"), 'the builder must not read an event')
  assert.ok(source.includes('authoredOpening: authoredOpeningForChoice(recentEvents),'), 'the call site must read it through witnessOf')
})

// ── 4. character projection inputs and the batch lease ──────────────────────
await check('character projection: turn inputs read only the English side', () => {
  const inputs = characterProjectionTurnInputs(bilingual() as never)
  assert.equal(inputs.playerInput, ENGLISH_PLAYER)
  assert.equal(inputs.aiResponse, ENGLISH_PROSE)
  // An English turn is exactly the frozen shape.
  assert.deepEqual(characterProjectionTurnInputs(english() as never),
    { sequence: 2, playerInput: ENGLISH_PLAYER, aiResponse: ENGLISH_PROSE, presentCast: ['Mara'] })
  // A continue: the witness player text is empty; both fields still come from
  // the one view (English prose, empty player text).
  const cont = characterProjectionTurnInputs({ sequence: 3, data: { player_input: '', ai_response: NATIVE_PROSE,
    witness: { lang: 'pt', ai_response: ENGLISH_PROSE, player_input: '' }, present_characters: [] } } as never)
  assert.equal(cont.playerInput, '')
  assert.equal(cont.aiResponse, ENGLISH_PROSE)
})

await check('character projection: a world action with an empty witness player text still reads its context', () => {
  const action = {
    sequence: 4,
    data: {
      player_input: '', ai_response: NATIVE_PROSE, present_characters: ['Mara'],
      world_action: { kind: 'travel', destination: 'o mercado', companions: [] },
      codex_projection_context: { player_input: 'I travel to the market.' },
      witness: { lang: 'pt', ai_response: ENGLISH_PROSE, player_input: '' },
    },
  }
  const inputs = characterProjectionTurnInputs(action as never)
  // The witness player text is empty, so the world action's own context supplies
  // it — the fallback stays, and an empty witness never blocks it.
  assert.equal(inputs.playerInput, 'I travel to the market.')
  // The prose is still the English side, not the native one.
  assert.equal(inputs.aiResponse, ENGLISH_PROSE)
})

await check('batch lease: a bilingual row is ready on its English copy; a failed copy reads native', () => {
  assert.equal(batchRowReady({ _id: 'x', data: { ...bilingual().data, codex_projection_status: 'pending' } } as never), true)
  // A failed copy still has a string in each field (native), so the batch is not
  // blocked by a translation that never landed.
  assert.equal(batchRowReady({ _id: 'x', data: { ...bilingual().data, witness_status: 'failed' } } as never), true)
  // A row with no prose is not ready, exactly as before.
  assert.equal(batchRowReady({ _id: 'x', data: { present_characters: [], player_input: '' } } as never), false)
  // A live claim stops the batch.
  assert.equal(batchRowReady({ _id: 'x', data: { ...english().data, codex_projection_claimed_at: new Date() } } as never), false)
  // `witnessOf` accepts a partial projection as the data (`dataOf`), so a row
  // that was read with only its English copy is ready on that copy — a native
  // read would see no text and wrongly stop the batch.
  const partial = { _id: 'x', data: { present_characters: ['Mara'], witness: { lang: 'pt', ai_response: ENGLISH_PROSE, player_input: ENGLISH_PLAYER } } }
  assert.equal(batchRowReady(partial as never), true)
})

// ── 5. summary, kinship-style reads and scene-state carry ───────────────────
await check('summary: a story save reads the English pair; group text is untouched', () => {
  const text = storySummarySource([english(1), bilingual(2) as never])
  assert.ok(text.includes(`Player: ${ENGLISH_PLAYER}`))
  assert.ok(text.includes(`World: ${ENGLISH_PROSE}`))
  assert.ok(!text.includes(NATIVE_PROSE), 'the native prose must not reach the summary')
  // English rows are the frozen format.
  assert.equal(storySummarySource([english(3) as never]),
    `[Turn 3] Player: ${ENGLISH_PLAYER}\nWorld: ${ENGLISH_PROSE}`)
})

await check('scene-state carry: the legacy-carry prose is the English side, lowercased', () => {
  const prose = sceneCarryProse([bilingual() as never])
  assert.ok(prose.includes('mara enters the hall'))
  assert.ok(!prose.includes('mara entra'))
  // Same normalisation as the unmodified code produced for an English row.
  const englishProse = ` ${ENGLISH_PROSE.toLowerCase().replace(/[^a-z0-9\s'-]+/g, ' ').replace(/\s+/g, ' ')} `
  assert.equal(sceneCarryProse([english() as never]), englishProse)
})

// ── 6. media look evidence ──────────────────────────────────────────────────
await check('look evidence: the prose a face is read from is the English side', () => {
  const prose = lookEvidenceProse([bilingual() as never], () => true)
  assert.ok(prose.includes('Mara enters the hall'))
  assert.ok(!prose.includes('Mara entra'))
  assert.equal(lookEvidenceProse([english() as never], () => true), ENGLISH_PROSE)
  // An irrelevant turn is skipped (the predicate is the card's presence test).
  assert.equal(lookEvidenceProse([bilingual() as never], () => false), '')
})

// ── 7. context packet: a continue's query narration ─────────────────────────
await check('continue query: the previous narration is the English side', () => {
  assert.equal(continueNarration([english(1), bilingual(2) as never]), ENGLISH_PROSE)
  assert.equal(continueNarration([english(1) as never]), ENGLISH_PROSE)
  assert.equal(continueNarration([{ data: { ai_response: NATIVE_PROSE, witness_status: 'failed' } }]), NATIVE_PROSE)
})

// ── 8. keyword recall text ──────────────────────────────────────────────────
await check('keyword text: a tapped chip with stored English searches English; a typed or altered line stays native', () => {
  const newest = {
    data: {
      choices: [
        { label: 'Ir ao mercado', kind: 'act', send: 'Ir ao mercado' },
        { label: 'Ficar', kind: 'act', send: '*Fico parado.*' },
      ],
      witness: { lang: 'pt', choices: [{ label: 'Go to the market', send: 'I go to the market.' }, { label: 'Stay', send: '*I stay still.*' }] },
    },
  }
  // A tapped chip (any case/spacing) searches with its stored English send.
  assert.equal(keywordQueryTextFor('Ir ao mercado', offeredChipEnglish('  ir   AO mercado! ', newest)), 'I go to the market.')
  // An altered chip is not the chip: no stored English, the typed text is used.
  assert.equal(keywordQueryTextFor('Ir para o mercado', offeredChipEnglish('Ir para o mercado', newest)), 'Ir para o mercado')
  // A typed line with no chip at all keeps its own text.
  assert.equal(keywordQueryTextFor('Quanto tempo você ficou fora?', offeredChipEnglish('Quanto tempo você ficou fora?', newest)), 'Quanto tempo você ficou fora?')
  // No stored English anywhere (an English turn): native.
  assert.equal(keywordQueryTextFor('Go to the market', offeredChipEnglish('Go to the market', { data: { choices: newest.data.choices } })), 'Go to the market')
})

await check('keyword recall: only the $text half takes the keyword text; the embedding keeps its own', async () => {
  const rag = await readFile(new URL('../src/providers/rag.provider.ts', import.meta.url), 'utf8')
  const body = rag.slice(rag.indexOf('export async function queryRag('))
  assert.ok(body.includes('keywordText: string = queryText,'), 'every other caller searches exactly as before')
  assert.ok(body.includes('$text: { $search: keywordText }'))
  assert.ok(body.includes('queryEmbedding = await embedQuery(queryText)'))
  const packet = await readFile(new URL('../src/services/context-packet.service.ts', import.meta.url), 'utf8')
  assert.match(packet, /queryRag\([\s\S]{0,420}prefetched\?\.responses,\s*undefined,\s*keywordText,\s*\)/)
  assert.ok(packet.includes('isContinuation ? null : offeredChipEnglish(userMessage, recentEvents[recentEvents.length - 1]),'))
})

// ── 9. projections: every moved reader's query fetches the witness ──────────
await check('projections: each moved reader that projects prose also fetches the witness', async () => {
  const projection = JSON.stringify(WITNESS_PROJECTION)
  assert.equal(projection, JSON.stringify({ 'data.witness': 1, 'data.witness_status': 1 }))
  // Each file has N prose projections; every one must spread WITNESS_PROJECTION.
  // (A projection that fetches `data.ai_response` without it is the bug this
  // catches: `witnessOf` would read a row that never loaded the English copy.)
  const expectations: Array<[string, number]> = [
    ['src/services/scene-state.service.ts', 1],
    ['src/services/media/look-evidence.ts', 1],
    ['src/services/kinship-graph.service.ts', 2],
  ]
  for (const [file, expected] of expectations) {
    const source = await readFile(new URL(`../${file}`, import.meta.url), 'utf8')
    const prose = (source.match(/'data\.ai_response': 1/g) || []).length
    const witness = (source.match(/\.\.\.WITNESS_PROJECTION/g) || []).length
    assert.equal(prose, expected, `${file}: expected ${expected} prose projection(s), found ${prose}`)
    assert.equal(witness, prose, `${file}: every prose projection must fetch the witness (${witness}/${prose})`)
  }
  // context-packet reads whole documents (no projection), so `witnessOf` sees
  // the witness key it needs; prove the read carries no narrowing projection.
  const packet = await readFile(new URL('../src/services/context-packet.service.ts', import.meta.url), 'utf8')
  const recent = packet.slice(packet.indexOf('const recentEvents = await mongoColl'))
  assert.ok(!recent.slice(0, 300).includes('projection'), 'the recent-events read must not narrow away the witness')
})

// ── 10. the load frame ──────────────────────────────────────────────────────
await check('load frame: reply_language is the effective code (`en` when absent) and the list is the one registry', async () => {
  // REPLY_LANGUAGES is read from `env` at module load, so an audit run without
  // it sees an empty registry: the row is hidden and `en` is what comes back.
  // That is exactly the off/empty case the app must handle.
  const english = liveFrameLanguage({})
  assert.equal(english.reply_language, 'en')
  assert.deepEqual(english.reply_languages, [])
  // The effective code follows the save; a code that is off behaves as English.
  assert.equal(liveFrameLanguage({ reply_language: 'en' }).reply_language, 'en')
  assert.equal(liveFrameLanguage({ reply_language: 'fr' }).reply_language, 'en')
  const registry = await readFile(new URL('../src/utils/reply-language.ts', import.meta.url), 'utf8')
  assert.ok(registry.includes('reply_languages: replyLanguageOptions(),'), 'the list must be the one registry')
})

await check('load frame: one helper, used by the HTTP path and the live-chat load frame', async () => {
  const service = await readFile(new URL('../src/services/instance.service.ts', import.meta.url), 'utf8')
  assert.equal((service.match(/\.\.\.liveFrameLanguage\(/g) || []).length, 2, 'getById and updateSettings both use it')
  const ws = await readFile(new URL('../src/services/play-ws.service.ts', import.meta.url), 'utf8')
  assert.ok(ws.includes('const storyFrame = { ...responseState, ...liveFrameLanguage(state.instance) }'), 'the instance_loaded frame must carry the language fields')
  assert.ok(ws.includes('publicGroupPayload(responseState, state.template) : storyFrame'), 'a story frame carries them; a group frame does not')
  // Never a second list.
  assert.ok(!ws.includes('replyLanguageOptions('), 'the live-chat frame must not build its own list')
})

// ── 11. allow list: a NEW native read in a moved reader fails here ──────────
// Every read of a stored turn's text in these files is listed with a reason.
// A line that is not here fails the audit until it is classified: MOVED (it
// reads through `witnessOf`/`playerTextOf`), NATIVE on purpose (display, a
// write, the wire), or rl-4 (edit/replay/select — a separate brief).
type Classification = { line: string; why: string }
const ALLOW: Record<string, Classification[]> = {
  'src/utils/prompt-builder.ts': [
    { line: "const last = [...recentEvents].reverse().find((event) => String(event.data?.ai_response || '').trim())", why: 'openingCharacterName: name-hygiene continuity, prose-native by rl-3' },
    { line: "const text = String(last?.data?.ai_response || '')", why: 'openingCharacterName body: native by rl-3' },
    { line: "const last = [...recentEvents].reverse().find((event) => String(event?.data?.ai_response || '').trim())", why: 'immediateNarrativeBeat: orientation only, kept native (reply-language.md §4)' },
    { line: "const narrative = String(last?.data?.ai_response || '').trim()", why: 'immediateNarrativeBeat body: kept native' },
    { line: "const playerMsg = event.data?.player_input || ''", why: 'the non-proseOnly (JSON envelope) replay history path, not a live decision' },
    { line: "const aiMsg = event.data?.ai_response || ''", why: 'the non-proseOnly replay history path' },
  ],
  'src/services/memory.service.ts': [
    { line: "const last = [...(recentEvents || [])].reverse().find((event) => String(event.data?.ai_response || '').trim())", why: 'openingCharacterName: name-hygiene continuity, native by rl-3' },
    { line: "const text = String(last?.data?.ai_response || '')", why: 'openingCharacterName body: native' },
    { line: "narrative: event.data?.ai_response || '',", why: 'baseReplayVariantFor: the variant IS the displayed prose (rl-4)' },
    { line: "event.data?.player_input || '',", why: 'replayProjectionKeyFor: a hash of the stored text, read by no model' },
    { line: "idString(turn._id), turn.data?.player_input || '', turn.data?.ai_response || '',", why: 'replayProjectionKeyFor: a hash of the stored text, read by no model' },
    { line: 'firstVersion.narrative === event.data?.ai_response && !firstVersion.projection', why: 'replay: is the shown prose still version one, compared and never read' },
    { line: "if (typeof event.data?.ai_response === 'string' && event.data.ai_response.trim()) {", why: 'normalizeReplayVariants existence check: rl-4' },
    { line: "projection: { 'data.ai_response': 1, sequence: 1 },", why: 'buildRecap latest-event read: recap stays native (§9)' },
    { line: 'const lastResponse = latestEvent?.data?.ai_response', why: 'buildRecap spine: native by §9' },
    { line: 'const nextAiResponse = updates.ai_response ?? event.data.ai_response', why: 'editEvent: rl-4' },
    { line: 'const nextPlayerInput = updates.player_input ?? event.data.player_input', why: 'editEvent: rl-4' },
    { line: "const aiChanged = typeof updates.ai_response === 'string' && updates.ai_response !== event.data.ai_response", why: 'editEvent dirty check: rl-4' },
    { line: "const playerChanged = typeof updates.player_input === 'string' && updates.player_input !== event.data.player_input", why: 'editEvent dirty check: rl-4' },
    { line: "'data.ai_response': nextAiResponse,", why: 'editEvent write: rl-4' },
    { line: "'data.player_input': nextPlayerInput,", why: 'editEvent write: rl-4' },
    { line: "'data.player_spoken_input': parsedPlayerInput.spoken,", why: 'editEvent write: rl-4' },
    { line: "'data.player_narration_facts': parsedPlayerInput.narrationFacts,", why: 'editEvent write: rl-4' },
    { line: "if (!(event.data?.ai_response || '').trim() || event.data?.model_used === 'seed') {", why: 'replayEvent refuses an empty turn: rl-4' },
    { line: "const parsed = parsePlayerInput(event.data.player_input || '')", why: 'replayEvent / selectReplayVariant: rl-4' },
    { line: "playerNative: event.data.player_input || '',", why: 'replay/select witness copies the native player text (rl-4)' },
    { line: 'const replayViewPlayer = replayAcceptedWitness ? replayAcceptedWitness.player : event.data.player_input || \'\'', why: 'replay refused/English view falls back to native (rl-4)' },
    { line: "nativePlayerInput: event.data.player_input || '',", why: 'the choice half reads the native player turn (§5, rl-4)' },
    { line: ": chosen.narrative || event.data.ai_response || ''", why: 'select view falls back to the chosen native prose (rl-4)' },
    { line: "let selectViewPlayer = chosenWitness ? chosenWitness.player_input : event.data.player_input || ''", why: 'select view falls back to the native player text (rl-4)' },
    { line: "selectViewPlayer = event.data.player_input || ''", why: 'select failed-copy view falls back to native (rl-4)' },
    { line: "'data.ai_response': nextVariant.narrative,", why: 'replay variant write: rl-4' },
    { line: '...spokenLineUpdate(nextVariant.narrative, event.data.player_spoken_input ?? event.data.player_input, event.data.player_input),', why: 'replay spoken-line write: rl-4' },
    { line: "const nextAi = chosen.narrative || event.data.ai_response || ''", why: 'selectReplayVariant: rl-4' },
    { line: 'const changed = nextAi !== event.data.ai_response', why: 'selectReplayVariant: rl-4' },
    { line: "'data.ai_response': nextAi,", why: 'selectReplayVariant write: rl-4' },
    { line: '...spokenLineUpdate(nextAi, event.data.player_spoken_input ?? event.data.player_input, event.data.player_input),', why: 'selectReplayVariant spoken-line write: rl-4' },
  ],
  'src/services/scene-state.service.ts': [
    { line: "'data.ai_response': 1,", why: 'PROJECTION: fetches the native field as well; the witness is spread beside it' },
  ],
  'src/services/media/look-evidence.ts': [
    { line: "projection: { 'data.ai_response': 1, 'data.present_characters': 1, ...WITNESS_PROJECTION },", why: 'PROJECTION: native fetched, witness spread beside it' },
  ],
  'worker/processors/character-projection.processor.ts': [],
  'worker/processors/summary.processor.ts': [],
  'worker/processors/generation.processor.ts': [
    { line: "const last = [...(events || [])].reverse().find((event) => String(event.data?.ai_response || '').trim())", why: 'openingCharacterName: name-hygiene continuity, native by rl-3' },
    { line: "const text = String(last?.data?.ai_response || '')", why: 'openingCharacterName body: native' },
    { line: "normalizeEntityName(String(event?.data?.player_input || '')))", why: 'recentChoiceLabels drop list: a label the player SENT, native text (wire)' },
    { line: "player_input: event.data.player_input,", why: 'the generation_complete wire: display, native (rl-3 allow list)' },
    { line: "recentEvents.filter((e: any) => String(e?.data?.ai_response || '').trim()).length <= 1)", why: 'openingScene boolean: counts prose existence, not content' },
  ],
  'src/services/context-packet.service.ts': [
    { line: "playerInput: String(event.data?.player_input || ''),", why: 'onActiveCastReady sidecar turns: interaction-signal input, native, out of scope (§4)' },
    { line: "narration: String(event.data?.ai_response || ''),", why: 'onActiveCastReady sidecar narration excerpt: native, out of scope' },
  ],
  'worker/lib/character-projection-lease.ts': [],
  'src/services/kinship-graph.service.ts': [
    { line: "{ projection: { sequence: 1, _id: 1, 'data.codex_deltas': 1, 'data.player_input': 1, 'data.ai_response': 1, ...WITNESS_PROJECTION } },", why: 'PROJECTION: native fetched, witness spread beside it' },
  ],
}

await check('allow list: every native prose/player read in a moved file is classified', async () => {
  const reads = (line: string) =>
    /\.data\??\.(ai_response|player_input|player_spoken_input|player_narration_facts)\b/.test(line) ||
    /\bdata\.(ai_response|player_input|player_spoken_input|player_narration_facts)\b/.test(line)
  const offenders: string[] = []
  for (const [file, allowed] of Object.entries(ALLOW)) {
    const source = await readFile(new URL(`../${file}`, import.meta.url), 'utf8')
    const used = new Set<number>()
    for (const [i, line] of source.split('\n').entries()) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue
      if (!reads(line)) continue
      // `witnessOf`, `playerTextOf` and the projection constant are the moved way.
      if (/\bwitnessOf\(|\bplayerTextOf\(|WITNESS_PROJECTION/.test(line) && !allowed.some((a) => line.includes(a.line))) continue
      const index = allowed.findIndex((a) => line.includes(a.line))
      if (index >= 0) { used.add(index); continue }
      offenders.push(`${file}:${i + 1}  ${trimmed}`)
    }
    // Every classification must still match a real line: a stale entry means the
    // code moved and the reason should be re-checked.
    const stale = allowed.filter((_, index) => !used.has(index))
    if (stale.length) offenders.push(`${file}: stale allow entries:\n    ${stale.map((a) => a.line).join('\n    ')}`)
  }
  assert.deepEqual(offenders, [], `unclassified native reads in moved readers:\n${offenders.join('\n')}`)
})

if (fail > 0) {
  console.log(`\nwitness readers audit: ${pass} passed, ${fail} failed`)
  process.exit(1)
}

if (process.argv.includes('--bites')) {
  await runBites()
} else {
  console.log(`\nwitness readers audit: ${pass} passed, 0 failed`)
}

// ── bites ────────────────────────────────────────────────────────────────────
type Edit = [file: string, from: string, to: string]
type Mutation = { name: string; check: string; edits: Edit[] }

async function runBites() {
  const root = await mkdtemp(join(import.meta.dir, '.witness-readers-bites-'))
  const server = new URL('..', import.meta.url).pathname
  const AUDIT = 'scripts/witness-readers-audit.ts'
  const witness = 'src/utils/witness.ts'
  const pb = 'src/utils/prompt-builder.ts'
  const packet = 'src/services/context-packet.service.ts'
  const scene = 'src/services/scene-state.service.ts'
  const look = 'src/services/media/look-evidence.ts'
  const proj = 'worker/processors/character-projection.processor.ts'
  const lease = 'worker/lib/character-projection-lease.ts'
  const summary = 'worker/processors/summary.processor.ts'
  const gen = 'worker/processors/generation.processor.ts'
  const replyLanguage = 'src/utils/reply-language.ts'
  const ws = 'src/services/play-ws.service.ts'

  const mutations: Mutation[] = [
    {
      name: '1 witnessOf: the native side wins over a good copy',
      check: 'witnessOf: the English side wins; an English row is returned exactly',
      edits: [[witness, "if (witness && data.witness_status !== 'failed' && wellFormed(witness)) {", 'if (false) {']],
    },
    {
      name: '2 playerTextOf: the fallback overrides the English player text',
      check: 'playerTextOf: the English player text, native fallback for a stored row',
      edits: [[witness, 'return witnessOf(event).player_input || fallback || \'\'', 'return fallback || witnessOf(event).player_input || \'\'']],
    },
    {
      name: '3 continuity: the spoken half reads the native field',
      check: 'continuity line: both player fields come from the English side',
      edits: [[pb, 'const view = witnessOf(event)', 'const view = (event as any).data']],
    },
    {
      name: '4 continuity: the facts re-parse the native player text (mixed sides)',
      check: 'continuity line: both player fields come from the English side',
      edits: [[pb, "const parsed = parsePlayerInput(String(view.player_input || ''))", "const parsed = parsePlayerInput(String((event as any).data?.player_input || ''))"]],
    },
    {
      name: '5 opening canon: the native opening prose is carried',
      check: 'openingSceneCanon: an authored brand-new opening is its own (English) prose',
      edits: [[pb, "return String(witnessOf(opening).ai_response).trim().slice(0, 1_800) || null", "return String(opening.data.ai_response).trim().slice(0, 1_800) || null"]],
    },
    {
      name: '6 choice opening: the native seed prose is shown',
      check: 'choice context opening: the seed opening is read on its English side at the call site',
      edits: [[gen, "? String(witnessOf(recentEvents[0]).ai_response || '').trim()", "? String(recentEvents[0].data.ai_response || '').trim()"]],
    },
    {
      name: '7 projection inputs: the prose reads native',
      check: 'character projection: turn inputs read only the English side',
      edits: [[proj, 'aiResponse: view.ai_response ?? \'\'', 'aiResponse: event.data.ai_response']],
    },
    {
      name: '8 projection inputs: the player text reads native',
      check: 'character projection: turn inputs read only the English side',
      edits: [[proj, "playerInput: view.player_input || (event.data.world_action", "playerInput: event.data.player_input || (event.data.world_action"]],
    },
    {
      name: '9 projection inputs: an empty witness blocks the world action context',
      check: 'character projection: a world action with an empty witness player text still reads its context',
      edits: [[proj, "playerInput: view.player_input || (event.data.world_action ? event.data.codex_projection_context?.player_input || '' : '')", "playerInput: view.player_input || ''"]],
    },
    {
      name: '10 batch lease: readiness reads native text',
      check: 'batch lease: a bilingual row is ready on its English copy; a failed copy reads native',
      edits: [[lease, "const view = witnessOf(row)\n  return Array.isArray(row.data.present_characters) && typeof view.ai_response === 'string' &&\n    typeof view.player_input === 'string'", "const view = row.data\n  return Array.isArray(row.data.present_characters) && typeof view.ai_response === 'string' &&\n    typeof view.player_input === 'string'"]],
    },
    {
      name: '11 summary: the story recap reads native',
      check: 'summary: a story save reads the English pair; group text is untouched',
      edits: [[summary, 'const view = witnessOf(e)', 'const view = (e as any).data']],
    },
    {
      name: '12 scene carry: the prose evidence reads native',
      check: 'scene-state carry: the legacy-carry prose is the English side, lowercased',
      edits: [[scene, "String(witnessOf(event).ai_response || '')", "String(event.data?.ai_response || '')"]],
    },
    {
      name: '13 look evidence: the prose reads native',
      check: 'look evidence: the prose a face is read from is the English side',
      edits: [[look, "const prose = witnessOf(turn).ai_response || ''", "const prose = turn.data?.ai_response || ''"]],
    },
    {
      name: '14 continue query: the previous narration reads native',
      check: "continue query: the previous narration is the English side",
      edits: [[packet, 'return witnessOf(events[events.length - 1]).ai_response', 'return (events[events.length - 1] as any)?.data?.ai_response']],
    },
    {
      name: '15 keyword text: a tapped chip keeps its native text',
      check: 'keyword text: a tapped chip with stored English searches English; a typed or altered line stays native',
      edits: [[witness, "return chipEnglish && chipEnglish.trim() ? chipEnglish : nativeText", 'return nativeText']],
    },
    {
      name: '16 projection: the scene-state read drops the witness fields',
      check: 'projections: each moved reader that projects prose also fetches the witness',
      edits: [[scene, "...WITNESS_PROJECTION,", '']],
    },
    {
      name: '17 load frame: the list is built a second way (empty)',
      check: 'load frame: reply_language is the effective code (`en` when absent) and the list is the one registry',
      edits: [[replyLanguage, 'reply_languages: replyLanguageOptions(),', 'reply_languages: [],']],
    },
    {
      name: '18 load frame: the live-chat frame stops carrying the fields',
      check: 'load frame: one helper, used by the HTTP path and the live-chat load frame',
      edits: [[ws, ', ...liveFrameLanguage(state.instance) }', ' }']],
    },
    {
      name: '15b keyword text: the search never receives it',
      check: 'keyword recall: only the $text half takes the keyword text; the embedding keeps its own',
      edits: [[packet, '      undefined,\n      keywordText,\n', '']],
    },
    {
      name: '15c keyword text: the embedding moves with it',
      check: 'keyword recall: only the $text half takes the keyword text; the embedding keeps its own',
      edits: [['src/providers/rag.provider.ts', 'queryEmbedding = await embedQuery(queryText)', 'queryEmbedding = await embedQuery(keywordText)']],
    },
    {
      name: '15d place history: earlier player lines stay native',
      check: 'allow list: every native prose/player read in a moved file is classified',
      edits: [[gen, 'playerInput: playerTextOf(event, event.userMessage),', "playerInput: String(event.data?.player_input || event.userMessage || ''),"]],
    },
    {
      name: '19 allow list: a new native read in a moved reader',
      check: 'allow list: every native prose/player read in a moved file is classified',
      edits: [[summary, 'export function storySummarySource', "const leaked = (e: any) => e.data.ai_response\nexport function storySummarySource"]],
    },
  ]

  try {
    await cp(join(server, 'src'), join(root, 'src'), { recursive: true })
    await cp(join(server, 'worker'), join(root, 'worker'), { recursive: true })
    await mkdir(join(root, 'scripts'), { recursive: true })
    await cp(join(server, AUDIT), join(root, AUDIT))
    await symlink(join(server, 'node_modules'), join(root, 'node_modules'), 'dir')

    const runAudit = async () => {
      const child = Bun.spawn(['bun', '--no-env-file', 'run', AUDIT], {
        cwd: root,
        env: { ...process.env, NODE_ENV: 'test' },
        stdout: 'pipe', stderr: 'pipe', stdin: 'ignore',
      })
      const timer = setTimeout(() => child.kill(9), 120_000)
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ])
      clearTimeout(timer)
      return { stdout, stderr, code }
    }

    const clean = await runAudit()
    assert.equal(clean.code, 0, `the unmutated copy must pass:\n${clean.stdout}\n${clean.stderr}`)
    console.log(`baseline: clean copy passes (${(clean.stdout.match(/^  ok /gm) ?? []).length} checks)`)

    let bitten = 0
    for (const mutation of mutations) {
      const originals = new Map<string, string>()
      try {
        for (const [file, from, to] of mutation.edits) {
          const path = join(root, file)
          const text = originals.get(path) ?? (await readFile(path, 'utf8'))
          originals.set(path, text)
          assert.ok(text.includes(from), `${mutation.name}: mutation anchor missing: ${from}`)
          await writeFile(path, text.replaceAll(from, to))
        }
        const result = await runAudit()
        assert.notEqual(result.code, 0, `${mutation.name}: the audit accepted the broken behaviour\n${result.stdout}`)
        assert.ok(
          `${result.stdout}${result.stderr}`.includes(`FAIL ${mutation.check}`),
          `${mutation.name}: failed outside the intended check\n${result.stdout}\n${result.stderr}`,
        )
        bitten++
        console.log(`BITE ${mutation.name}: exit ${result.code}; FAIL ${mutation.check}`)
      } finally {
        for (const [path, original] of originals) await writeFile(path, original)
      }
    }
    console.log(`witness readers bites: ${bitten}/${mutations.length} mutations rejected; scratch restored and removed`)
    if (bitten !== mutations.length) process.exit(1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}
