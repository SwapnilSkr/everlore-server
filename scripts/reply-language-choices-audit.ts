/**
 * REPLY-LANGUAGE CHOICES: the non-English choice pass (§5 of
 * `everlore-docs/phases/reply-language.md`).
 *
 * Covers the paired `label_en`/`send_en` schema, the language line, the native
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
  witnessRequest: 'd89a01dd06acb61e3909bceec5a6a4d69bcc1af788a5f77b2bd45b01905a22e7',
  unsplitRequest: '3f11c62aff10e84b44dedf6af4625de1ca5a27ff1658b8cb0286d4ad48dbf7d5',
  splitChoiceRequest: '018189ce68b7bf8ab3aaf97b6c7f7835aa6f019c8b42b69a1cdeded3a5e664da',
  splitLedgerRequest: 'b497658ea879876a3f4f42b17ed6f4ecbbd9b238fa0be70596047adbde561fb1',
  result: 'f7e27d15e9fce9c6585e287234f8bbcf1963e3b8149b7e7f829758374b541cf5',
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
  assert.equal(sha(witness.requests[0]), FROZEN.witnessRequest, 'the witness request moved')

  const unsplit = fixtureCall()
  await extractChoiceMetadata(FIXTURE_PROSE, FIXTURE_STATS, FIXTURE_FLAGS, { ...FIXTURE_OPTS, call: unsplit.call }, { split: false })
  assert.equal(sha(unsplit.requests[0]), FROZEN.unsplitRequest, 'the unsplit choice request moved')

  const split = fixtureCall()
  await extractChoiceMetadata(FIXTURE_PROSE, FIXTURE_STATS, FIXTURE_FLAGS, { ...FIXTURE_OPTS, call: split.call }, { split: true })
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
const EN_RAW = '{"choices":[{"label":"Perguntar por que ela saiu","kind":"say","send":"Por que você ficou fora tanto tempo?","label_en":"Ask why she left","send_en":"Why did you stay away so long?"}],"milestone":null}'

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

await check('present: the schema requires label_en/send_en and maxTokens is 900', async () => {
  const { requests, call } = fixtureCall(EN_RAW)
  await extractChoiceMetadata(ENGLISH_PROSE, FIXTURE_STATS, FIXTURE_FLAGS, { ...LANGUAGE_OPTS, call }, { split: true })
  const choice = byPurpose(requests, 'choice_metadata')
  assert.equal(choice.maxTokens, 900)
  const item = (choice.responseSchema as Record<string, any>).properties.choices.items
  assert.deepEqual(item.required, ['label', 'kind', 'send', 'label_en', 'send_en'])
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
  label, kind: 'act', send, label_en: labelEn, send_en: sendEn,
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

await check('result: a choice missing an English field is dropped with its pair', async () => {
  const raw = pairRaw([
    { label: 'Perguntar agora', kind: 'act', send: '*Eu pergunto agora.*', send_en: '*I ask now.*' },
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
      edits: [[extractor, "...(englishChoices === undefined\n          ? {}\n          : { choices_en: ordered.map((index) => englishChoices[index]) }),", 'choices_en: ordered.map((index) => englishChoices?.[index] ?? { label: \'\', send: \'\' }),']],
    },
    {
      name: 'present: the choice half reads the English prose',
      check: 'present: the choice half reads the native prose and native player turn',
      edits: [[extractor, 'const choiceNarrative = language\n        ? language.narrative\n        : typeof narrative === \'string\' ? narrative : await narrative', 'const choiceNarrative = typeof narrative === \'string\' ? narrative : await narrative']],
    },
    {
      name: 'present: the language line is not last',
      check: 'present: one language line, at the very end of the choice system prompt',
      edits: [[extractor, '? `${strippedChoiceBase}\\n${choiceLanguageInstruction(language.name)}`', '? `${choiceLanguageInstruction(language.name)}\\n${strippedChoiceBase}`']],
    },
    {
      name: 'present: maxTokens is not raised',
      check: 'present: the schema requires label_en/send_en and maxTokens is 900',
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
      edits: [[extractor, "(async () => extractSceneWitness(typeof narrative === 'string' ? narrative : await narrative, opts))(),", "(async () => extractSceneWitness(opts?.choiceLanguage?.narrative ?? (typeof narrative === 'string' ? narrative : await narrative), opts))(),"]],
    },
    {
      name: 'present: the English pair is not aligned through the repeats filter',
      check: 'result: repeat filtering keeps pairs aligned, including the floor restore',
      edits: [[extractor, ': { choices_en: ordered.map((index) => englishChoices[index]) }),', ': { choices_en: englishChoices.filter(Boolean) }),']],
    },
    {
      name: 'present: an untranslated two-word field is treated as translated',
      check: 'result: an untranslated field of 3+ words drops the pair; two words may match',
      edits: [[output, 'key.split(\' \').filter(Boolean).length >= 3', 'key.split(\' \').filter(Boolean).length >= 2']],
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
