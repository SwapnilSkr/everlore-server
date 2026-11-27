/**
 * REPLY-LANGUAGE CHOICES: the non-English choice pass (§5 of
 * `everlore-docs/phases/reply-language.md`).
 *
 * Covers the paired `label_local`/`send_local` schema, the language line, the native
 * choice half, the promise handoff that lets rl-3 start choices at stream end,
 * alignment through every filter, and the grounding guard that runs on the
 * English pair.
 *
 * The absent-language path is pinned byte for byte against request and result
 * fixtures captured from the tree BEFORE this change (see the hashes below).
 *
 * Pure: the model call is injected. No network, no DB.
 *
 *   bun --no-env-file run scripts/reply-language-choices-audit.ts
 *   bun --no-env-file run scripts/reply-language-choices-audit.ts --bites
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import {
  choiceLanguageInstruction,
  extractChoiceMetadata,
  extractSceneMetadata,
  extractSceneWitness,
  filterChoicePairs,
  mergeSceneMetadata,
  type MetadataOpts,
} from '../worker/lib/metadata-extractor'
import { auditChoicePairs } from '../worker/lib/choice-grounding-audit'
import type { ChoiceEnglish } from '../src/utils/witness'

// ── the pre-change fixture ───────────────────────────────────────────────────
// Same inputs as the capture taken from the tree before this change. The
// hashes are of `JSON.stringify(captured)`; if the English path moves at all,
// these fail.
const FIXTURE_PROSE = 'Mara steps into the hall and sets her wet coat aside. "Você demorou", ela diz.'
const FIXTURE_PLAYER = '*I lean against the doorframe, watching her.* Quanto tempo você ficou fora?'
const FIXTURE_STATS = [{ name: 'resolve', min: 0, max: 100, description: 'how steady the protagonist holds' }]
const FIXTURE_FLAGS = ['listened']
const FIXTURE_OPTS: MetadataOpts = {
  isSentient: true,
  currentLocationName: 'the hall',
  priorPresent: ['Mara'],
  priorPhysical: ['Mara holds the brass key.'],
  protagonist: { name: 'Nell', aliases: ['the visitor'] },
  roster: [{ name: 'Mara', aliases: ['the steward'] }],
  knownPlaces: [{ name: 'the hall', aliases: ['great hall'] }],
  playerInput: FIXTURE_PLAYER,
  worldContext: 'A quiet manor drama.',
  recentChoiceLabels: ['Wait'],
  choiceContext: 'Mara served the household for years.',
}
const FROZEN = {
  witnessRequest: '6be147e6a0468b3984cb12f9bbd2ee18c4000db60b2f6d84af756f15696f6c22',
  // buttons-fast moved the choice pass to `AI_MODELS.choices` with
  // `noReasoning: true`. Reverting only those two fields reproduces the old
  // pins (`3f11c62a…` unsplit, `018189ce…` split); the witness and ledger pins
  // are unchanged because those calls still use `AI_MODELS.metadata`.
  //
  // buttons-slim then moved the four stat/flag/tag/tone fields to the witness:
  // the witness request moves only in its schema (the four properties, now
  // required) and `maxTokens` 620 → 720; the choice requests move only by the
  // four rule lines removed from the system and the four properties removed
  // from the schema; the ledger request is unchanged (`b497658e…`), and this
  // result moves only in `state_mutations` and `emotional_tone`, which now take
  // the safe defaults here.
  unsplitRequest: '4775303c09c89e14b249f0d0cea805aa52ee735364284949c49b5574e784856d',
  splitChoiceRequest: '695bf1cdef6a57ee6c20b3cc03eb9ff2961a83a7f2a872f01152f310b11e8f53',
  splitLedgerRequest: 'b497658ea879876a3f4f42b17ed6f4ecbbd9b238fa0be70596047adbde561fb1',
  result: '5966858544c5c5956895a643f02628e706477dd0506d16f442a77d5d0146ec15',
}

const WITNESS_RAW = '{"present_characters":["Mara"],"characters_departed":[],"physical_state_opened":[],"physical_state_closed":[],"current_location":"the hall","player_destination":null,"player_travel_confirmed":false,"location_evidence":"steps into the hall","location_evidence_source":"narrative","containment_hint":null,"movement":"lateral","viewpoint_moved":true,"time_elapsed":null,"time_evidence":null,"location_state_changes":[],"location_permanent_facts":[]}'
const LEDGER_RAW = '{"beat_ledger":{"npc_beats":[],"emotional_shift":null,"setting":null,"consequence":null,"unresolved_hook":null}}'
const CHOICE_RAW = '{"state_mutations":{"resolve":{"op":"add","value":2}},"flag_mutations":{},"scene_tag":"dialogue","emotional_tone":"warm","beat_ledger":{"npc_beats":[],"emotional_shift":null,"setting":null,"consequence":null,"unresolved_hook":null},"choices":[{"label":"Ask why she left","kind":"say","send":"Why did you stay away so long?"}],"milestone":null}'

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

const sha = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const byPurpose = (requests: Array<Record<string, any>>, purpose: string) =>
  requests.find((request) => request.purpose === purpose)!
const userOf = (request: Record<string, any>) => request.messages[1].content as string
const systemOf = (request: Record<string, any>) => request.messages[0].content as string

const NATIVE_PROSE = 'Mara entra no salão. "Você demorou", ela diz.'
const ENGLISH_PROSE = 'Mara steps into the hall. "You took your time", she says.'
const NATIVE_PLAYER = 'Quanto tempo você ficou fora?'
const ENGLISH_PLAYER = 'How long were you away?'

function fixtureCall(choiceRaw: string = CHOICE_RAW) {
  const requests: Array<Record<string, any>> = []
  const call = async (request: Record<string, any>) => {
    requests.push(JSON.parse(JSON.stringify(request)))
    switch (request.purpose) {
      case 'scene_witness': return WITNESS_RAW
      case 'beat_ledger': return LEDGER_RAW
      case 'choice_metadata': return choiceRaw
      default: return '{}'
    }
  }
  return { requests, call }
}

// ── 1. absent: requests and results byte-identical ───────────────────────────
await check('absent: the witness, choice and ledger requests match the pre-change fixture', async () => {
  const witness = fixtureCall()
  await extractSceneWitness(FIXTURE_PROSE, { ...FIXTURE_OPTS, call: witness.call })
  const unsplit = fixtureCall()
  await extractChoiceMetadata(FIXTURE_PROSE, FIXTURE_STATS, FIXTURE_FLAGS, { ...FIXTURE_OPTS, call: unsplit.call }, { split: false })
  const split = fixtureCall()
  await extractChoiceMetadata(FIXTURE_PROSE, FIXTURE_STATS, FIXTURE_FLAGS, { ...FIXTURE_OPTS, call: split.call }, { split: true })
  assert.equal(sha(witness.requests[0]), FROZEN.witnessRequest, 'the witness request moved')
  assert.equal(sha(unsplit.requests[0]), FROZEN.unsplitRequest, 'the unsplit choice request moved')
  assert.equal(sha(byPurpose(split.requests, 'choice_metadata')), FROZEN.splitChoiceRequest, 'the split choice request moved')
  assert.equal(sha(byPurpose(split.requests, 'beat_ledger')), FROZEN.splitLedgerRequest, 'the ledger request moved')
})

await check('absent: results match the pre-change fixture and gain no choices_en', async () => {
  for (const split of [false, true]) {
    const { call } = fixtureCall()
    const result = await extractChoiceMetadata(FIXTURE_PROSE, FIXTURE_STATS, FIXTURE_FLAGS, { ...FIXTURE_OPTS, call }, { split })
    assert.equal(sha(result), FROZEN.result, `the split=${split} result moved`)
    assert.equal('choices_en' in result, false, 'an English turn must not gain choices_en')
  }
})

await check('absent: an explicit undefined choiceLanguage equals an omitted one', async () => {
  const omitted = fixtureCall()
  const omittedResult = await extractChoiceMetadata(FIXTURE_PROSE, FIXTURE_STATS, FIXTURE_FLAGS, { ...FIXTURE_OPTS, call: omitted.call })
  const explicit = fixtureCall()
  const explicitResult = await extractChoiceMetadata(FIXTURE_PROSE, FIXTURE_STATS, FIXTURE_FLAGS, { ...FIXTURE_OPTS, choiceLanguage: undefined, call: explicit.call })
  assert.deepEqual(explicit.requests, omitted.requests)
  assert.deepEqual(explicitResult, omittedResult)
})

// ── 2. present: the native choice half and the language line ────────────────
const LANGUAGE = { name: 'Brazilian Portuguese', narrative: NATIVE_PROSE, playerInput: NATIVE_PLAYER }
const LANGUAGE_OPTS: MetadataOpts = { ...FIXTURE_OPTS, playerInput: ENGLISH_PLAYER, choiceLanguage: LANGUAGE }
const EN_RAW = '{"choices":[{"label":"Ask why she left","kind":"say","send":"Why did you stay away so long?","label_local":"Perguntar por que ela saiu","send_local":"Por que você ficou fora tanto tempo?"}],"milestone":null}'

await check('present: the choice half reads the native prose and native player turn', async () => {
  const { requests, call } = fixtureCall(EN_RAW)
  await extractChoiceMetadata(ENGLISH_PROSE, FIXTURE_STATS, FIXTURE_FLAGS, { ...LANGUAGE_OPTS, call }, { split: true })
  const choice = byPurpose(requests, 'choice_metadata')
  assert.equal(userOf(choice), NATIVE_PROSE)
  assert.ok(
    systemOf(choice).includes(`PLAYER TURN (authoritative for player movement; empty means no new player turn): ${NATIVE_PLAYER}`),
    'the choice prompt must carry the native player turn',
  )
  assert.equal(systemOf(choice).includes(ENGLISH_PLAYER), false, 'the English player turn must not reach the choice half')
})

await check('present: one language line, at the very end of the choice system prompt', async () => {
  const { requests, call } = fixtureCall(EN_RAW)
  await extractChoiceMetadata(ENGLISH_PROSE, FIXTURE_STATS, FIXTURE_FLAGS, { ...LANGUAGE_OPTS, call }, { split: true })
  const system = systemOf(byPurpose(requests, 'choice_metadata'))
  assert.equal(system.split('\n').at(-1), choiceLanguageInstruction(LANGUAGE.name))
  assert.equal(system.split('CHOICE LANGUAGE:').length - 1, 1, 'the line must appear exactly once')
})

await check('present: the schema requires label_local/send_local and maxTokens is 900', async () => {
  const { requests, call } = fixtureCall(EN_RAW)
  await extractChoiceMetadata(ENGLISH_PROSE, FIXTURE_STATS, FIXTURE_FLAGS, { ...LANGUAGE_OPTS, call }, { split: true })
  const choice = byPurpose(requests, 'choice_metadata')
  assert.equal(choice.maxTokens, 900)
  const item = (choice.responseSchema as Record<string, any>).properties.choices.items
  assert.deepEqual(item.required, ['label', 'kind', 'send', 'label_local', 'send_local'])
  assert.equal('beat_ledger' in (choice.responseSchema as Record<string, any>).properties, false, 'split still omits the ledger')
})

await check('present: the witness half and the ledger keep the main narrative; the ledger has no language line', async () => {
  const witness = fixtureCall()
  await extractSceneWitness(ENGLISH_PROSE, { ...LANGUAGE_OPTS, call: witness.call })
  assert.equal(userOf(witness.requests[0]), ENGLISH_PROSE)
  assert.ok(systemOf(witness.requests[0]).includes(ENGLISH_PLAYER), 'the witness prompt keeps the English player turn')

  const choice = fixtureCall(EN_RAW)
  await extractChoiceMetadata(ENGLISH_PROSE, FIXTURE_STATS, FIXTURE_FLAGS, { ...LANGUAGE_OPTS, call: choice.call }, { split: true })
  const ledger = byPurpose(choice.requests, 'beat_ledger')
  assert.equal(userOf(ledger), ENGLISH_PROSE)
  assert.equal(systemOf(ledger).includes('CHOICE LANGUAGE:'), false, 'the ledger is English and gets no language line')
})

await check('present: a promised English copy lets the choice half start first and the rest wait', async () => {
  let resolveCopy!: (value: string) => void
  const copy = new Promise<string>((resolve) => { resolveCopy = resolve })
  const requests: Array<Record<string, any>> = []
  const call = async (request: Record<string, any>) => {
    requests.push(JSON.parse(JSON.stringify(request)))
    return request.purpose === 'choice_metadata' ? EN_RAW : request.purpose === 'beat_ledger' ? LEDGER_RAW : WITNESS_RAW
  }
  const pending = extractSceneMetadata(copy, FIXTURE_STATS, FIXTURE_FLAGS, { ...LANGUAGE_OPTS, call })
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.deepEqual(requests.map((request) => request.purpose), ['choice_metadata'], 'only the native choice call may start before the copy')
  resolveCopy(ENGLISH_PROSE)
  const result = await pending
  assert.ok(requests.some((request) => request.purpose === 'scene_witness'))
  assert.equal(userOf(byPurpose(requests, 'scene_witness')), ENGLISH_PROSE, 'the witness reads the English copy')
  assert.equal(result.choices_en?.length, 1)

  // Split: the ledger reads the English copy, so it waits — the choice call
  // does not, because it runs on the native text.
  let resolveCopy2!: (value: string) => void
  const copy2 = new Promise<string>((resolve) => { resolveCopy2 = resolve })
  const splitRequests: Array<Record<string, any>> = []
  const splitCall = async (request: Record<string, any>) => {
    splitRequests.push(JSON.parse(JSON.stringify(request)))
    return request.purpose === 'choice_metadata' ? EN_RAW : LEDGER_RAW
  }
  const splitPending = extractChoiceMetadata(copy2, FIXTURE_STATS, FIXTURE_FLAGS, { ...LANGUAGE_OPTS, call: splitCall }, { split: true })
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.deepEqual(splitRequests.map((request) => request.purpose), ['choice_metadata'], 'the ledger must wait for the copy')
  resolveCopy2(ENGLISH_PROSE)
  await splitPending
  assert.equal(userOf(byPurpose(splitRequests, 'beat_ledger')), ENGLISH_PROSE, 'the ledger reads the English copy')
})

await check('present: mergeSceneMetadata joins the halves exactly as extractSceneMetadata', async () => {
  const pair = async () => {
    const witness = fixtureCall()
    const choice = fixtureCall(EN_RAW)
    const witnessHalf = await extractSceneWitness(ENGLISH_PROSE, { ...LANGUAGE_OPTS, call: witness.call })
    const choiceHalf = await extractChoiceMetadata(ENGLISH_PROSE, FIXTURE_STATS, FIXTURE_FLAGS, { ...LANGUAGE_OPTS, call: choice.call }, { split: true })
    return { witnessHalf, choiceHalf }
  }
  const { witnessHalf, choiceHalf } = await pair()
  const merged = mergeSceneMetadata(witnessHalf, choiceHalf)
  const { call } = fixtureCall(EN_RAW)
  const viaPair = await extractSceneMetadata(ENGLISH_PROSE, FIXTURE_STATS, FIXTURE_FLAGS, { ...LANGUAGE_OPTS, call })
  assert.deepEqual(merged, viaPair)
  assert.deepEqual(merged.choices_en, [{ label: 'Ask why she left', send: 'Why did you stay away so long?' }])
})

// ── 3. result: native chips, aligned English pairs, through every filter ────
function pairRaw(items: unknown[]): string {
  return JSON.stringify({ choices: items, milestone: null })
}
const EN_ITEM = (label: string, send: string, labelEn: string, sendEn: string) => ({
  label: labelEn, kind: 'act', send: sendEn, label_local: label, send_local: send,
})
const SAY_ITEM = (label: string, send: string, labelEn: string, sendEn: string) => ({
  label: labelEn, kind: 'say', send: sendEn, label_local: label, send_local: send,
})

await check('result: the native choices and the English pairs are aligned by index', async () => {
  const raw = pairRaw([
    EN_ITEM('Perguntar agora', '*Pergunto agora.*', 'Ask now', '*I ask now.*'),
    EN_ITEM('Esperar em silêncio', '*Espero em silêncio.*', 'Wait in silence', '*I wait in silence.*'),
  ])
  const { call } = fixtureCall(raw)
  const result = await extractChoiceMetadata(ENGLISH_PROSE, FIXTURE_STATS, FIXTURE_FLAGS, { ...LANGUAGE_OPTS, call }, { split: true })
  assert.deepEqual(result.choices.map((choice) => choice.label), ['Perguntar agora', 'Esperar em silêncio'])
  assert.deepEqual(result.choices_en, [
    { label: 'Ask now', send: '*I ask now.*' },
    { label: 'Wait in silence', send: '*I wait in silence.*' },
  ])
})

await check('result: repeat filtering keeps pairs aligned, including the floor restore', async () => {
  const raw = pairRaw([
    EN_ITEM('Wait', '*Eu espero junto à porta.*', 'Wait', '*I wait by the door.*'),
    EN_ITEM('Ask', '*Eu pergunto ao intendente.*', 'Ask', '*I ask the steward.*'),
    EN_ITEM('Leave', '*Eu saio do salão.*', 'Leave', '*I leave the hall.*'),
  ])
  const expectedEn: Record<string, ChoiceEnglish> = {
    Wait: { label: 'Wait', send: '*I wait by the door.*' },
    Ask: { label: 'Ask', send: '*I ask the steward.*' },
    Leave: { label: 'Leave', send: '*I leave the hall.*' },
  }
  const opts: MetadataOpts = { ...LANGUAGE_OPTS, recentChoiceLabels: ['Wait', 'Ask', 'Leave'], choiceLanguage: LANGUAGE }
  const { call } = fixtureCall(raw)
  const result = await extractChoiceMetadata(ENGLISH_PROSE, FIXTURE_STATS, FIXTURE_FLAGS, { ...opts, call }, { split: true })
  // All three are repeats; the floor restores two, in dropRepeatedChoices order.
  assert.equal(result.choices.length, 2)
  assert.deepEqual(
    result.choices_en,
    result.choices.map((choice) => expectedEn[choice.label]),
    'the English pair must follow the native chip, not the original index',
  )
})

await check('result: a native chip repeating the player line is dropped and the pair stays aligned', async () => {
  const raw = pairRaw([
    SAY_ITEM('Perguntar de novo', 'Quanto tempo você ficou fora?', 'Ask again', 'How long have you been away?'),
    EN_ITEM('Esperar', '*Eu espero em silêncio.*', 'Wait', '*I wait in silence.*'),
    EN_ITEM('Sair', '*Eu saio do salão.*', 'Leave', '*I leave the hall.*'),
  ])
  const opts: MetadataOpts = { ...LANGUAGE_OPTS, playerInputEnglish: ENGLISH_PLAYER }
  const { call } = fixtureCall(raw)
  const result = await extractChoiceMetadata(ENGLISH_PROSE, FIXTURE_STATS, FIXTURE_FLAGS, { ...opts, call }, { split: true })
  assert.deepEqual(result.choices.map((choice) => choice.label), ['Esperar', 'Sair'])
  assert.deepEqual(result.choices_en?.map((choice) => choice.label), ['Wait', 'Leave'], 'the English pair must follow the native drop')
})

await check('result: the English pair repeating the witness line is dropped too', async () => {
  const raw = pairRaw([
    SAY_ITEM('Perguntar sobre a tempestade', 'Pergunto de novo sobre a tormenta.', 'Ask about the storm', 'How long were you away?'),
    EN_ITEM('Esperar', '*Eu espero em silêncio.*', 'Wait', '*I wait in silence.*'),
    EN_ITEM('Sair', '*Eu saio do salão.*', 'Leave', '*I leave the hall.*'),
  ])
  const opts: MetadataOpts = { ...LANGUAGE_OPTS, playerInputEnglish: ENGLISH_PLAYER }
  const { call } = fixtureCall(raw)
  const result = await extractChoiceMetadata(ENGLISH_PROSE, FIXTURE_STATS, FIXTURE_FLAGS, { ...opts, call }, { split: true })
  assert.deepEqual(result.choices.map((choice) => choice.label), ['Esperar', 'Sair'])
  assert.deepEqual(result.choices_en?.map((choice) => choice.label), ['Wait', 'Leave'])
})

await check('result: player-line repeats keep the floor and the pairs aligned', async () => {
  const raw = pairRaw([
    SAY_ITEM('Perguntar de novo', NATIVE_PLAYER, 'Ask again', 'How long have you been away?'),
    SAY_ITEM('Repetir a pergunta', NATIVE_PLAYER, 'Repeat the question', 'How long were you gone?'),
    SAY_ITEM('Insistir', NATIVE_PLAYER, 'Press her', 'How long did you stay out?'),
  ])
  const opts: MetadataOpts = { ...LANGUAGE_OPTS, playerInputEnglish: undefined }
  const { call } = fixtureCall(raw)
  const result = await extractChoiceMetadata(ENGLISH_PROSE, FIXTURE_STATS, FIXTURE_FLAGS, { ...opts, call }, { split: true })
  assert.deepEqual(result.choices.map((choice) => choice.label), ['Perguntar de novo', 'Repetir a pergunta'])
  assert.deepEqual(result.choices_en?.map((choice) => choice.label), ['Ask again', 'Repeat the question'])
})

await check('result: a choice missing a native field is dropped with its pair', async () => {
  const raw = pairRaw([
    { label: 'Ask now', kind: 'act', send: '*I ask now.*', send_local: '*Eu pergunto agora.*' },
    EN_ITEM('Esperar em silêncio', '*Eu espero em silêncio.*', 'Wait in silence', '*I wait in silence.*'),
  ])
  const { call } = fixtureCall(raw)
  const result = await extractChoiceMetadata(ENGLISH_PROSE, FIXTURE_STATS, FIXTURE_FLAGS, { ...LANGUAGE_OPTS, call }, { split: true })
  assert.deepEqual(result.choices.map((choice) => choice.label), ['Esperar em silêncio'])
  assert.deepEqual(result.choices_en, [{ label: 'Wait in silence', send: '*I wait in silence.*' }])
})

await check('result: an untranslated field of 3+ words drops the pair; two words may match', async () => {
  const raw = pairRaw([
    EN_ITEM('Esperar aqui', '*Eu espero em silêncio.*', 'Esperar aqui', '*I wait in silence.*'),
    EN_ITEM('Perguntar agora', '*Eu pergunto agora mesmo.*', 'Ask now', '*Eu pergunto agora mesmo.*'),
  ])
  const { call } = fixtureCall(raw)
  const result = await extractChoiceMetadata(ENGLISH_PROSE, FIXTURE_STATS, FIXTURE_FLAGS, { ...LANGUAGE_OPTS, call }, { split: true })
  assert.deepEqual(result.choices.map((choice) => choice.label), ['Esperar aqui'], 'the untranslated 4-word send drops the second pair; the 2-word label may match')
  assert.equal(result.choices_en?.length, 1)
})

await check('result: a move with one part left in English is dropped', async () => {
  const raw = pairRaw([
    EN_ITEM('Perguntar', '*I lean in closer.* O que houve com você?', 'Ask', '*I lean in closer.* What happened to you?'),
    EN_ITEM('Chegar perto', '*Eu chego mais perto.* What happened to you?', 'Come close', '*I come closer.* What happened to you?'),
    EN_ITEM('Chamar', '*Eu aceno.* "Kai! Vem cá."', 'Call', '*I wave.* "Kai! Come here."'),
    EN_ITEM('Esperar', '*Eu espero.*', 'Wait', '*I wait.*'),
  ])
  const { call } = fixtureCall(raw)
  const result = await extractChoiceMetadata(ENGLISH_PROSE, FIXTURE_STATS, FIXTURE_FLAGS, { ...LANGUAGE_OPTS, call }, { split: true })
  assert.deepEqual(result.choices.map((choice) => choice.label), ['Chamar', 'Esperar'])
})

// ── the authored writing style, told only to models that write ─────────────
await check('instruction: es names the tú imperative and Latin American Spanish; pt the você imperative; English neither', () => {
  const es = choiceLanguageInstruction('Spanish')
  assert.ok(es.includes('Latin American Spanish'), 'es must name the regional variety')
  assert.ok(es.includes('tú'), 'es must name the informal tú imperative')
  assert.ok(es.includes('Every label_local uses one form:'), 'es must state the one label form')
  const pt = choiceLanguageInstruction('Brazilian Portuguese')
  assert.ok(pt.includes('você'), 'pt must name the você imperative')
  assert.ok(pt.includes('imperative'))
  assert.ok(pt.includes('Every label_local uses one form:'))
  // A name with no authored style — English included — reads exactly as before.
  for (const bare of [choiceLanguageInstruction('English'), choiceLanguageInstruction('Klingon')]) {
    assert.equal(bare.includes('Latin American'), false)
    assert.equal(bare.includes('você'), false)
    assert.equal(bare.includes('one form'), false)
  }
})

// ── the rare turn left with too few buttons ──────────────────────────────────
const HALF_RAW = pairRaw([
  { label: 'Ask now', kind: 'act', send: '*I ask now, quietly.*' },
  EN_ITEM('Esperar', '*Eu espero.*', 'Wait', '*I wait.*'),
  EN_ITEM('Leave', '*I leave the hall.*', 'Leave', '*I leave the hall.*'),
])
async function withTranslation(raw: string, answer: string | Error, language = true, name = LANGUAGE.name) {
  const requests: Array<Record<string, any>> = []
  const call = async (request: Record<string, any>) => {
    requests.push(JSON.parse(JSON.stringify(request)))
    if (request.purpose === 'choice_metadata') return raw
    if (request.purpose === 'beat_ledger') return LEDGER_RAW
    if (answer instanceof Error) throw answer
    return answer
  }
  const opts = language
    ? { ...LANGUAGE_OPTS, choiceLanguage: { ...LANGUAGE, name } }
    : FIXTURE_OPTS
  const result = await extractChoiceMetadata(ENGLISH_PROSE, FIXTURE_STATS, FIXTURE_FLAGS, { ...opts, recentChoiceLabels: [], call }, { split: true })
  return { result, asked: requests.filter((request) => request.purpose === 'choice_translation') }
}
/** A proper rescue answer for HALF_RAW's two dropped buttons: both sides, English
 *  and the player's copy, in the order they were sent. */
const COPIES = JSON.stringify({ choices: [
  { label_en: 'Ask now', send_en: '*I ask now, quietly.*', label_local: 'Perguntar agora', send_local: '*Eu pergunto agora, baixinho.*' },
  { label_en: 'Leave', send_en: '*I leave the hall.*', label_local: 'Sair', send_local: '*Eu saio do salão.*' },
] })

await check('missing copies: fewer than two pairs gets one rescue, kept in order', async () => {
  const { result, asked } = await withTranslation(HALF_RAW, COPIES)
  assert.equal(asked.length, 1)
  assert.deepEqual(JSON.parse(userOf(asked[0])), [
    { label: 'Ask now', send: '*I ask now, quietly.*' },
    { label: 'Leave', send: '*I leave the hall.*', label_local: 'Leave', send_local: '*I leave the hall.*' },
  ], 'every dropped button goes, whatever language each field is in')
  assert.equal(asked[0].purpose, 'choice_translation')
  assert.equal(asked[0].temperature, 0)
  assert.equal(asked[0].timeoutMs, 6000, 'the turn must not wait on it for long')
  assert.equal(asked[0].responseFormat.json_schema.strict, true)
  const item = (asked[0].responseSchema as Record<string, any>).properties.choices.items
  assert.deepEqual(item.required, ['label_en', 'send_en', 'label_local', 'send_local'], 'both sides are required')
  assert.ok(systemOf(asked[0]).includes(LANGUAGE.name))
  assert.ok(systemOf(asked[0]).includes('você'), 'the pt rescue names its imperative')
  assert.deepEqual(result.choices.map((choice) => choice.label), ['Perguntar agora', 'Esperar', 'Sair'])
  assert.deepEqual(result.choices_en?.map((choice) => choice.label), ['Ask now', 'Wait', 'Leave'])
})

await check('missing copies: two pairs or an English turn never call it', async () => {
  const two = pairRaw([
    EN_ITEM('Esperar', '*Eu espero.*', 'Wait', '*I wait.*'),
    EN_ITEM('Sair', '*Eu saio.*', 'Leave', '*I leave.*'),
    { label: 'Ask now', kind: 'act', send: '*I ask now, quietly.*' },
  ])
  assert.equal((await withTranslation(two, COPIES)).asked.length, 0)
  assert.equal((await withTranslation(pairRaw([]), COPIES)).asked.length, 0, 'nothing to translate')
  assert.equal((await withTranslation(CHOICE_RAW, COPIES, false)).asked.length, 0, 'an English turn')
})

// The real turn 22 of the first Spanish save: the model wrote Spanish into the
// English slots too, every native copy equalled its English one, and all four
// buttons vanished. The rescue must rebuild both sides from what was dropped.
const TURN_22_RAW = JSON.stringify({
  choices: [
    { label: 'Te acerco más a mí', kind: 'act', send: '*I pull you closer to me.*', label_local: 'Te acerco más a mí', send_local: '*Te acerco más a mí.*' },
    { label: 'Pregunto sobre la película', kind: 'say', send: 'What movie are we going to see?', label_local: 'Pregunto sobre la película', send_local: '¿Qué película vamos a ver?' },
    { label: 'Bromeo sobre la situación', kind: 'say', send: 'Just remember, I might get jealous!', label_local: 'Bromeo sobre la situación', send_local: 'Solo recuerda, ¡podría ponerme celoso!' },
    { label: 'Sonrío y te miro a los ojos', kind: 'act', send: '*I smile and look into your eyes.*', label_local: 'Sonrío y te miro a los ojos', send_local: '*Sonrío y te miro a los ojos.*' },
  ],
  milestone: null,
})
const TURN_22_COPIES = JSON.stringify({ choices: [
  { label_en: 'Pull you closer', send_en: '*I pull you closer to me.*', label_local: 'Te acerco más a mí', send_local: '*Te acerco más a mí.*' },
  { label_en: 'Ask about the movie', send_en: 'What movie are we going to see?', label_local: 'Pregunto sobre la película', send_local: '¿Qué película vamos a ver?' },
  { label_en: 'Joke about the situation', send_en: 'Just remember, I might get jealous!', label_local: 'Bromeo sobre la situación', send_local: 'Solo recuerda, ¡podría ponerme celoso!' },
  { label_en: 'Smile and look into your eyes', send_en: '*I smile and look into your eyes.*', label_local: 'Sonrío y te miro a los ojos', send_local: '*Sonrío y te miro a los ojos.*' },
] })

await check('rescue: turn 22 (Spanish in the English slots) is rebuilt into four buttons', async () => {
  const { result, asked } = await withTranslation(TURN_22_RAW, TURN_22_COPIES, true, 'Spanish')
  assert.equal(asked.length, 1, 'all four turned unusable, so one rescue must run')
  assert.equal(JSON.parse(userOf(asked[0])).length, 4, 'every dropped button goes, not only a native part')
  assert.ok(systemOf(asked[0]).includes('tú'), 'the es rescue names its label form')
  assert.ok(systemOf(asked[0]).includes('Latin American Spanish'))
  assert.deepEqual(result.choices.map((choice) => choice.label), [
    'Te acerco más a mí', 'Pregunto sobre la película', 'Bromeo sobre la situación', 'Sonrío y te miro a los ojos',
  ])
  assert.deepEqual(result.choices.map((choice) => choice.kind), ['act', 'say', 'say', 'act'], 'kind comes from the original row')
  assert.deepEqual(result.choices_en?.map((choice) => choice.label), [
    'Pull you closer', 'Ask about the movie', 'Joke about the situation', 'Smile and look into your eyes',
  ], 'the English side must be English')
})

// A rescue that is no better: both sides still the same text. The unchanged
// sanitizer must drop them, so the guard survives the new path.
const IDENTITY_RAW = pairRaw([
  SAY_ITEM('Pregunto por la película', '¿Qué película vamos a ver?', 'Pregunto por la película', '¿Qué película vamos a ver?'),
  SAY_ITEM('Bromeo sobre la situación', 'Solo recuerda, ¡podría ponerme celoso!', 'Bromeo sobre la situación', 'Solo recuerda, ¡podría ponerme celoso!'),
])
const IDENTITY_COPIES = JSON.stringify({ choices: [
  { label_en: 'Pregunto por la película', send_en: '¿Qué película vamos a ver?', label_local: 'Pregunto por la película', send_local: '¿Qué película vamos a ver?' },
  { label_en: 'Bromeo sobre la situación', send_en: 'Solo recuerda, ¡podría ponerme celoso!', label_local: 'Bromeo sobre la situación', send_local: 'Solo recuerda, ¡podría ponerme celoso!' },
]})

await check('rescue: an answer still identical on both sides is dropped by the guard', async () => {
  const { result, asked } = await withTranslation(IDENTITY_RAW, IDENTITY_COPIES, true, 'Spanish')
  // Both attempts come back with no buttons, so the one retry runs the rescue
  // again: one `choice_translation` per choice attempt.
  assert.equal(asked.length, 2, 'the rescue path must run on each attempt')
  assert.deepEqual(result.choices, [], 'no button may ship with its native copy still English')
  assert.deepEqual(result.choices_en, [])
})

await check('rescue: a failed, short or malformed answer keeps whatever the turn had', async () => {
  const proper = { label_en: 'Ask now', send_en: '*I ask now, quietly.*', label_local: 'Perguntar agora', send_local: '*Eu pergunto agora, baixinho.*' }
  const leave = { label_en: 'Leave', send_en: '*I leave the hall.*', label_local: 'Sair', send_local: '*Eu saio do salão.*' }
  for (const answer of [
    new Error('down'),
    'not json',
    '{}',
    JSON.stringify({ choices: [proper] }),
    JSON.stringify({ choices: [proper, leave, { label_en: 'Extra', send_en: '*I wait.*', label_local: 'Extra', send_local: '*Extra.*' }] }),
    '{"choices":[null,null]}',
    JSON.stringify({ choices: [proper, { label_en: 'Leave', send_en: '*I leave the hall.*' }] }),
    JSON.stringify({ choices: [
      { label_en: 'Ask now', send_en: '*I ask now, quietly.*', label_local: 'Ask now', send_local: '*I ask now, quietly.*' },
      { label_en: 'Leave', send_en: '*I leave the hall.*', label_local: 'Leave', send_local: '*I leave the hall.*' },
    ] }),
  ]) {
    const { result } = await withTranslation(HALF_RAW, answer)
    assert.deepEqual(result.choices.map((choice) => choice.label), ['Esperar'], String(answer))
    assert.deepEqual(result.choices_en, [{ label: 'Wait', send: '*I wait.*' }])
  }
})

await check('filterChoicePairs: keeps each native chip with its pair through a filter', () => {
  const choices = [
    { label: 'A', kind: 'act', send: '*a*' },
    { label: 'B', kind: 'act', send: '*b*' },
    { label: 'C', kind: 'act', send: '*c*' },
  ]
  const pairs: ChoiceEnglish[] = [
    { label: 'A en', send: '*a en*' },
    { label: 'B en', send: '*b en*' },
    { label: 'C en', send: '*c en*' },
  ]
  const kept = filterChoicePairs(choices, pairs, (choice) => choice.label !== 'B')
  assert.deepEqual(kept.choices.map((choice) => choice.label), ['A', 'C'])
  assert.deepEqual(kept.choices_en, [pairs[0], pairs[2]])
  // A missing English entry drops the chip rather than keeping it half-paired.
  const half = filterChoicePairs(choices, pairs.slice(0, 1), () => true)
  assert.deepEqual(half.choices.map((choice) => choice.label), ['A'])
})

await check('filterChoicePairs: an English save filters the native list alone', () => {
  const choices = [
    { label: 'A', kind: 'act', send: '*a*' },
    { label: 'B', kind: 'act', send: '*b*' },
  ]
  const kept = filterChoicePairs(choices, undefined, (choice) => choice.label === 'B')
  assert.deepEqual(kept.choices.map((choice) => choice.label), ['B'])
  assert.deepEqual(kept.choices_en, [])
})

// ── 4. the grounding guard decides on the English pair ──────────────────────
await check('auditChoicePairs: keeps a native chip only where its English pair needed no repair', () => {
  const choices = [
    { label: 'Abraçar minha irmã', kind: 'act', send: '*Eu abraço minha irmã.*' },
    { label: 'Esperar', kind: 'act', send: '*Eu espero.*' },
  ]
  const pairs: ChoiceEnglish[] = [
    { label: 'Hug my brother', send: '*I hug my brother.*' },
    { label: 'Wait', send: '*I wait.*' },
  ]
  const result = auditChoicePairs(choices, pairs, ['Mara (sister)'], 'Mara stands alone.')
  assert.deepEqual(result.choices.map((choice) => choice.label), ['Esperar'], 'the fabricated-kin English pair drops its native chip')
  assert.deepEqual(result.choices_en, [pairs[1]])
  assert.equal(result.repairedCount, 0, 'a repair would keep a half-grounded chip; it must be a drop')
  assert.equal(result.results.length, 2)
  assert.deepEqual(result.dropped.map((entry) => entry.choice.label), ['Abraçar minha irmã'])
})

await check('auditChoicePairs: fewer than two survivors ship as they are', () => {
  const choices = [{ label: 'Esperar', kind: 'act', send: '*Eu espero.*' }]
  const result = auditChoicePairs(choices, [{ label: 'Wait', send: '*I wait.*' }], [], 'The room is empty.')
  assert.equal(result.choices.length, 1, 'no invention to reach a floor of two')
  assert.equal(result.choices_en.length, 1)
})

await check('auditChoicePairs: a real relative in the English pair survives untouched', () => {
  const choices = [{ label: 'Abraçar minha irmã', kind: 'act', send: '*Eu abraço minha irmã.*' }]
  const result = auditChoicePairs(choices, [{ label: 'Hug my sister', send: '*I hug my sister.*' }], ['Mara (sister)'], 'Mara smiles.')
  assert.equal(result.choices.length, 1)
  assert.equal(result.results[0].grounded, true)
})

if (fail > 0) {
  console.log(`\nreply-language choices audit: ${pass} passed, ${fail} failed`)
  process.exit(1)
}

if (process.argv.includes('--bites')) {
  await runBites()
} else {
  console.log(`\nreply-language choices audit: ${pass} passed, 0 failed`)
}

// ── bites ────────────────────────────────────────────────────────────────────
type Edit = [file: string, from: string, to: string]
type Mutation = { name: string; check: string; edits: Edit[] }

async function runBites() {
  const root = await mkdtemp(join(import.meta.dir, '.rl-choices-bites-'))
  const server = new URL('..', import.meta.url).pathname
  const AUDIT = 'scripts/reply-language-choices-audit.ts'
  const extractor = 'worker/lib/metadata-extractor.ts'
  const output = 'worker/lib/structured-output.ts'
  const grounding = 'worker/lib/choice-grounding-audit.ts'

  const mutations: Mutation[] = [
    {
      name: 'absent: the shared system prompt moved',
      check: 'absent: the witness, choice and ledger requests match the pre-change fixture',
      edits: [[extractor, '  return METADATA_RULES + context', "  return METADATA_RULES + context + ' '"]],
    },
    {
      name: 'absent: maxTokens moved for the English path',
      check: 'absent: the witness, choice and ledger requests match the pre-change fixture',
      edits: [[extractor, 'maxTokens: language ? 900 : 450,', 'maxTokens: 900,']],
    },
    {
      name: 'absent: the English result gained choices_en',
      check: 'absent: results match the pre-change fixture and gain no choices_en',
      edits: [[extractor, "...(englishChoices === undefined\n            ? {}\n            : { choices_en: keptOrder.map((index) => englishChoices[index]) }),", 'choices_en: keptOrder.map((index) => englishChoices?.[index] ?? { label: \'\', send: \'\' }),']],
    },
    {
      name: 'present: the choice half reads the English prose',
      check: 'present: the choice half reads the native prose and native player turn',
      edits: [[extractor, "const choiceNarrative = language\n          ? language.narrative\n          : typeof narrative === 'string' ? narrative : await narrative", "const choiceNarrative = typeof narrative === 'string' ? narrative : await narrative"]],
    },
    {
      name: 'present: the language line is not last',
      check: 'present: one language line, at the very end of the choice system prompt',
      edits: [[extractor, "? `${buttonsBase}${genderRule ? `\\n${genderRule}` : ''}\\n${choiceLanguageInstruction(language.name)}`", "? `${choiceLanguageInstruction(language.name)}\\n${buttonsBase}${genderRule ? `\\n${genderRule}` : ''}`"]],
    },
    {
      name: 'present: maxTokens is not raised',
      check: 'present: the schema requires label_local/send_local and maxTokens is 900',
      edits: [[extractor, 'maxTokens: language ? 900 : 450,', 'maxTokens: 450,']],
    },
    {
      name: 'present: the ledger reads the native prose',
      check: 'present: the witness half and the ledger keep the main narrative; the ledger has no language line',
      edits: [[extractor, "const ledgerNarrative = typeof narrative === 'string' ? narrative : await narrative", 'const ledgerNarrative = language ? language.narrative : (typeof narrative === \'string\' ? narrative : await narrative)']],
    },
    {
      name: 'present: the witness waits for nothing (starts on native)',
      check: 'present: a promised English copy lets the choice half start first and the rest wait',
      edits: [[extractor, "(async () => extractSceneWitness(typeof narrative === 'string' ? narrative : await narrative, opts, stats, flagKeys))(),", "(async () => extractSceneWitness(opts?.choiceLanguage?.narrative ?? (typeof narrative === 'string' ? narrative : await narrative), opts, stats, flagKeys))(),"]],
    },
    {
      name: 'present: the English pair is not aligned through the repeats filter',
      check: 'result: repeat filtering keeps pairs aligned, including the floor restore',
      edits: [[extractor, ': { choices_en: keptOrder.map((index) => englishChoices[index]) }),', ': { choices_en: englishChoices.filter(Boolean) }),']],
    },
    {
      name: 'result: the native player-line repeat is not dropped',
      check: 'result: a native chip repeating the player line is dropped and the pair stays aligned',
      edits: [[extractor, '    if (choiceRepeatsPlayerLine(choice, playerInput)) repeat = true', '    if (false) repeat = true']],
    },
    {
      name: 'result: the English pair repeating the witness line is not dropped',
      check: 'result: the English pair repeating the witness line is dropped too',
      edits: [[extractor, '    if (english && choiceRepeatsPlayerLine(english, playerInputEnglish)) repeat = true', '    if (false) repeat = true']],
    },
    {
      name: 'present: the English and native fields are read the wrong way round',
      check: 'result: the native choices and the English pairs are aligned by index',
      edits: [
        [output, "label: typeof source.label_local === 'string' ? source.label_local : ''", "label: typeof source.label === 'string' ? source.label : ''"],
        [output, "send: typeof source.send_local === 'string' ? source.send_local : ''", "send: typeof source.send === 'string' ? source.send : ''"],
      ],
    },
    {
      name: 'present: a half-translated move is accepted',
      check: 'result: a move with one part left in English is dropped',
      edits: [[output, "value.split('*').map(choiceTextKey)", '[choiceTextKey(value)]']],
    },
    {
      name: 'missing copies: never rescued',
      check: 'missing copies: fewer than two pairs gets one rescue, kept in order',
      edits: [[extractor, 'if (language && v.choices.length < CHOICE_PAIR_FLOOR)', 'if (language && v.choices.length < 0)']],
    },
    {
      name: 'missing copies: rescued although two pairs survive',
      check: 'missing copies: two pairs or an English turn never call it',
      edits: [[extractor, 'v.choices.length < CHOICE_PAIR_FLOOR)', 'v.choices.length < 9)']],
    },
    {
      name: 'rescue: a failure loses the button that worked',
      check: 'rescue: a failed, short or malformed answer keeps whatever the turn had',
      edits: [[extractor, '  } catch {\n    return raw\n  }', "  } catch {\n    return '{}'\n  }"]],
    },
    {
      name: 'rescue: a wrong count is matched by position',
      check: 'rescue: a failed, short or malformed answer keeps whatever the turn had',
      edits: [[extractor, '|| copies.length !== missing.length) return raw', ') return raw']],
    },
    {
      name: 'rescue: a malformed row is accepted',
      check: 'rescue: a failed, short or malformed answer keeps whatever the turn had',
      edits: [[extractor, '    if (!usable) return raw\n', '']],
    },
    {
      name: 'missing copies: buttons that already worked are sent again',
      check: 'missing copies: fewer than two pairs gets one rescue, kept in order',
      edits: [[output, ' && sanitizeChoicePairs([item]).choices.length === 0)', ')']],
    },
    {
      name: 'missing copies: the call can hang the turn',
      check: 'missing copies: fewer than two pairs gets one rescue, kept in order',
      edits: [[extractor, '      timeoutMs: CHOICE_TRANSLATION_TIMEOUT_MS,\n', '']],
    },
    {
      name: 'rescue: the rebuilt pair keeps the source label instead of label_en',
      check: 'rescue: turn 22 (Spanish in the English slots) is rebuilt into four buttons',
      edits: [[extractor, '        label: copy.label_en,', "        label: typeof item.label === 'string' ? item.label : copy.label_en,"]],
    },
    {
      name: 'rescue: the equal-text guard is bypassed',
      check: 'rescue: an answer still identical on both sides is dropped by the guard',
      edits: [[output, '    if (\n      untranslatedField(native.choice.label, english.choice.label)\n      || untranslatedField(native.choice.send, english.choice.send)\n    ) {\n      continue\n    }', '    if (false) {\n      continue\n    }']],
    },
    {
      name: 'instruction: the regional variety is dropped',
      check: 'instruction: es names the tú imperative and Latin American Spanish; pt the você imperative; English neither',
      edits: [[extractor, "  const varietyLine = variety ? ` Use ${variety}.` : ''", "  const varietyLine = ''"]],
    },
    {
      name: 'instruction: the one label form is dropped',
      check: 'instruction: es names the tú imperative and Latin American Spanish; pt the você imperative; English neither',
      edits: [[extractor, "  const formLine = choiceLabelForm ? ` Every label_local uses one form: ${choiceLabelForm}.` : ''", "  const formLine = ''"]],
    },
    {
      name: 'present: an untranslated two-word field is treated as translated',
      check: 'result: an untranslated field of 3+ words drops the pair; two words may match',
      edits: [[output, "part.split(' ').length >= 3", "part.split(' ').length >= 2"]],
    },
    {
      name: 'grounding: an ungrounded English pair is kept',
      check: 'auditChoicePairs: keeps a native chip only where its English pair needed no repair',
      edits: [[grounding, '    const issues = classifyChoiceGrounding(`${english.label} ${english.send}`, ctx)\n    if (!issues.length) {', '    const issues = classifyChoiceGrounding(`${english.label} ${english.send}`, ctx)\n    if (true) {']],
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
    console.log(`reply-language choices bites: ${bitten}/${mutations.length} mutations rejected; scratch restored and removed`)
    if (bitten !== mutations.length) process.exit(1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}
