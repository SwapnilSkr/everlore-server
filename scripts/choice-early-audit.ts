/**
 * CHOICE-EARLY: the tap-to-play buttons run on their own model and are
 * published as soon as their own call is audited, not after the whole tail.
 *
 * Covers:
 *   (a) `extractChoiceMetadata` asks `choice_metadata` on `AI_MODELS.choices`
 *       with reasoning off; the beat ledger and the witness stay on
 *       `AI_MODELS.metadata`.
 *   (b) one retry on `AI_MODELS.metadata` when the first call throws or comes
 *       back with no buttons; a good first answer makes exactly one call.
 *   (c) the choice half never waits on the witness call.
 *   (d) the processor publishes `choices_ready` inside the `earlyChoicesPromise`
 *       chain, guards both publish sites, and assigns the finished set after
 *       the join.
 *   (f) a non-English turn launches the button half BEFORE the hidden English
 *       copy: the `choice_metadata` request leaves at once while the copy is
 *       still 2 s away.
 *   (g) the split ledger still waits for the copy and its request is exactly the
 *       one built after it, with the English player line.
 *   (h) the English repeat check still sees the English line when it arrives
 *       late, through `englishTurn`.
 *   (i) the processor wiring, read as text: the early launch sits before the
 *       copy and `englishDone` is called after it.
 *   (j) the split ledger no longer holds the buttons: `onChoices` fires with the
 *       button half while a 3 s ledger is still out, and the returned promise
 *       still carries `beat_ledger`.
 *   (k) the processor races the early publish on `choicesOnly`, while
 *       `metaPromise` still joins `choiceHalfPromise`.
 *   (l) `choicesNameAnyone` reads what the this-turn deaths filter reads: the
 *       English pair when there is one, `label send`, whole word, any case.
 *   (m) when it says no, that deaths filter keeps every button for ANY set of
 *       reported cast names, so skipping the wait cannot change the buttons.
 *   (n) the processor wiring, read as text: the buttons await the deaths only
 *       when a button names someone on `packet.lifecycleRoster`, the stored
 *       deltas still await `deathExtractionPromise`, and the filter reads the
 *       English pair the way (l) does.
 *   (o) the deaths extractor can only report a name from its candidates.
 *
 * Pure: every model call is injected. No network, no DB.
 *
 *   bun --no-env-file run scripts/choice-early-audit.ts
 *   bun --no-env-file run scripts/choice-early-audit.ts --bites
 */
import assert from 'node:assert/strict'
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import {
  extractChoiceMetadata,
  extractSceneWitness,
  choicesNameAnyone,
  filterChoicePairs,
  type MetadataOpts,
  type SceneMetadata,
} from '../worker/lib/metadata-extractor'
import { AI_MODELS } from '../src/ai/models'

const FIXTURE_PROSE = 'Mara steps into the hall and sets her wet coat aside.'
const FIXTURE_STATS = [{ name: 'resolve', min: 0, max: 100, description: 'how steady the protagonist holds' }]
const FIXTURE_FLAGS = ['listened']

const WITNESS_RAW = '{"present_characters":["Mara"],"characters_departed":[],"physical_state_opened":[],"physical_state_closed":[],"current_location":"the hall","player_destination":null,"player_travel_confirmed":false,"location_evidence":null,"location_evidence_source":null,"containment_hint":null,"movement":"lateral","viewpoint_moved":true,"time_elapsed":null,"time_evidence":null,"location_state_changes":[],"location_permanent_facts":[]}'
const LEDGER_RAW = '{"beat_ledger":{"npc_beats":[],"emotional_shift":null,"setting":null,"consequence":null,"unresolved_hook":null}}'
const GOOD_RAW = '{"state_mutations":{},"flag_mutations":{},"scene_tag":"dialogue","emotional_tone":"warm","beat_ledger":{"npc_beats":[],"emotional_shift":null,"setting":null,"consequence":null,"unresolved_hook":null},"choices":[{"label":"Ask why she left","kind":"say","send":"Why did you stay away so long?"}],"milestone":null}'
const EMPTY_RAW = '{"choices":[],"milestone":null}'

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

const byPurpose = (requests: Array<Record<string, any>>, purpose: string) =>
  requests.filter((request) => request.purpose === purpose)

/**
 * A stubbed transport. `choiceAnswers` is consumed one per `choice_metadata`
 * call: a string is returned, an Error is thrown. Past the end, the last answer
 * repeats. The ledger and the witness always answer.
 *
 * `sends` records when each request was made: the early-launch checks read when
 * a call started relative to the copy, which the request bodies cannot say.
 */
function stub(choiceAnswers: Array<string | Error>) {
  const requests: Array<Record<string, any>> = []
  const sends: Array<{ purpose: string; at: number }> = []
  let choiceAttempt = 0
  const call = async (request: Record<string, any>) => {
    sends.push({ purpose: String(request.purpose || ''), at: Date.now() })
    requests.push(JSON.parse(JSON.stringify(request)))
    if (request.purpose === 'choice_metadata') {
      const answer = choiceAnswers[Math.min(choiceAttempt, choiceAnswers.length - 1)]
      choiceAttempt++
      if (answer instanceof Error) throw answer
      return answer
    }
    if (request.purpose === 'beat_ledger') return LEDGER_RAW
    if (request.purpose === 'scene_witness') return WITNESS_RAW
    return '{}'
  }
  return { requests, sends, call }
}

const opts = (call: MetadataOpts['call']): MetadataOpts => ({ call, playerInput: '*I wait by the door.*' })

// ── (a) the models on each request ──────────────────────────────────────────
await check('(a) choice_metadata runs on AI_MODELS.choices with reasoning off; ledger and witness stay on AI_MODELS.metadata', async () => {
  const { requests, call } = stub([GOOD_RAW])
  await extractChoiceMetadata(FIXTURE_PROSE, FIXTURE_STATS, FIXTURE_FLAGS, opts(call), { split: true })
  const choice = byPurpose(requests, 'choice_metadata')[0]
  assert.equal(choice.model, AI_MODELS.choices, 'the buttons must go to their own model')
  assert.equal(choice.noReasoning, true, 'the buttons must run with reasoning off')

  const ledger = byPurpose(requests, 'beat_ledger')[0]
  assert.ok(ledger, 'the split must still make its ledger call')
  assert.equal(ledger.model, AI_MODELS.metadata, 'the ledger stays on the metadata model')

  const witnessStub = stub([GOOD_RAW])
  await extractSceneWitness(FIXTURE_PROSE, opts(witnessStub.call))
  assert.equal(witnessStub.requests[0].model, AI_MODELS.metadata, 'the witness stays on the metadata model')
})

// ── (b) one retry, on the metadata model ────────────────────────────────────
await check('(b) a thrown first call retries exactly once on AI_MODELS.metadata and keeps the buttons', async () => {
  const { requests, call } = stub([new Error('host outage'), GOOD_RAW])
  let reported: string | undefined
  const result = await extractChoiceMetadata(FIXTURE_PROSE, FIXTURE_STATS, FIXTURE_FLAGS, {
    ...opts(call),
    onChoiceModel: (model) => { reported = model },
  }, { split: true })
  const calls = byPurpose(requests, 'choice_metadata')
  assert.equal(calls.length, 2, 'a throw must add exactly one more attempt')
  assert.equal(calls[1].model, AI_MODELS.metadata, 'the retry must go to the metadata model')
  assert.equal('noReasoning' in calls[1], false, 'the retry keeps reasoning on')
  assert.ok(result.choices.length > 0, 'the retry must still return buttons')
  assert.equal(reported, AI_MODELS.metadata, 'the log must name the model that produced the kept buttons')
})

await check('(b) an empty first answer retries exactly once on AI_MODELS.metadata and keeps the buttons', async () => {
  const { requests, call } = stub([EMPTY_RAW, GOOD_RAW])
  let reported: string | undefined
  const result = await extractChoiceMetadata(FIXTURE_PROSE, FIXTURE_STATS, FIXTURE_FLAGS, {
    ...opts(call),
    onChoiceModel: (model) => { reported = model },
  }, { split: true })
  const calls = byPurpose(requests, 'choice_metadata')
  assert.equal(calls.length, 2, 'no buttons must add exactly one more attempt')
  assert.equal(calls[1].model, AI_MODELS.metadata, 'the retry must go to the metadata model')
  assert.ok(result.choices.length > 0, 'the retry must still return buttons')
  assert.equal(reported, AI_MODELS.metadata)
})

await check('(b) a good first answer makes one call and reports AI_MODELS.choices', async () => {
  const { requests, call } = stub([GOOD_RAW])
  let reported: string | undefined
  const result = await extractChoiceMetadata(FIXTURE_PROSE, FIXTURE_STATS, FIXTURE_FLAGS, {
    ...opts(call),
    onChoiceModel: (model) => { reported = model },
  }, { split: true })
  assert.equal(byPurpose(requests, 'choice_metadata').length, 1, 'a good answer must not be retried')
  assert.ok(result.choices.length > 0)
  assert.equal(reported, AI_MODELS.choices)
})

// ── (c) the choice half never waits on the witness ──────────────────────────
await check('(c) a 3 s witness cannot delay extractChoiceMetadata past 500 ms', async () => {
  const requests: Array<Record<string, any>> = []
  const call = async (request: Record<string, any>) => {
    requests.push(JSON.parse(JSON.stringify(request)))
    if (request.purpose === 'scene_witness') {
      await new Promise((resolve) => setTimeout(resolve, 3000))
      return WITNESS_RAW
    }
    if (request.purpose === 'beat_ledger') return LEDGER_RAW
    return GOOD_RAW
  }
  const startedAt = Date.now()
  const result = await extractChoiceMetadata(FIXTURE_PROSE, FIXTURE_STATS, FIXTURE_FLAGS, opts(call), { split: true })
  const ms = Date.now() - startedAt
  assert.ok(result.choices.length > 0)
  assert.ok(ms < 500, `the choice half waited ${ms} ms on the witness`)
})

// ── (d) the processor wiring, read as text ──────────────────────────────────
await check('(d) the processor publishes choices_ready early, guards both sites, and assigns after the join', async () => {
  const processor = await readFile(new URL('../worker/processors/generation.processor.ts', import.meta.url), 'utf8')
  const earlyAt = processor.indexOf('const earlyChoicesPromise =')
  assert.ok(earlyAt >= 0, 'earlyChoicesPromise must exist')
  const joinAt = processor.indexOf(
    'const [meta, entityAdjudication, characterLifecycleDeltas, endpointAdjudication] = await Promise.all(',
  )
  assert.ok(joinAt > earlyAt, 'the early chain must be declared before the join')

  const earlyBlock = processor.slice(earlyAt, joinAt)
  assert.ok(earlyBlock.includes("type: 'choices_ready'"), 'the early chain must publish choices_ready')
  assert.ok(earlyBlock.includes('redis.publish(channel'), 'the early chain must publish on the turn channel')

  const guarded = processor.match(/if \(!choicesReadySent &&/g) ?? []
  assert.ok(guarded.length >= 2, `both publish sites must be guarded by choicesReadySent (found ${guarded.length})`)

  const assignedAt = processor.indexOf('parsed.choices = finished.choices')
  assert.ok(assignedAt > joinAt, 'the finished set must be assigned after the join')
})

// ── (f)-(i) a non-English turn starts the buttons before the English copy ───
const NATIVE_LINE = 'Quanto tempo você ficou fora?'
const ENGLISH_LINE = 'How long were you away?'
const ENGLISH_PROSE = 'Mara steps into the hall.'
const CHOICE_LANGUAGE = { name: 'Brazilian Portuguese', narrative: 'Mara entra no salão.', playerInput: NATIVE_LINE }

/** Native chips with their English pairs: the paired schema, so no translation
 *  retry is needed and the only calls are the ones a check means to measure. */
function pairRaw(pairs: Array<{ label: string; send: string; local: string; localSend: string; kind?: string }>): string {
  return JSON.stringify({
    choices: pairs.map((pair) => ({
      label: pair.label,
      kind: pair.kind || 'act',
      send: pair.send,
      label_local: pair.local,
      send_local: pair.localSend,
    })),
    milestone: null,
  })
}
const PAIR_RAW = pairRaw([
  { label: 'Ask why she left', send: '*I ask why she left.*', local: 'Perguntar por que ela saiu', localSend: '*Eu pergunto por que ela saiu.*' },
  { label: 'Wait in silence', send: '*I wait in silence.*', local: 'Esperar em silêncio', localSend: '*Eu espero em silêncio.*' },
])

/** The value the processor hands the button half: one promise per input, both
 *  resolved by the copy that starts after the launch. */
const englishValuesOf = (copy: Promise<{ playerInput: string; playerInputEnglish: string; narrative: string }>) =>
  copy.then(({ playerInput, playerInputEnglish }) => ({ playerInput, playerInputEnglish }))

await check('(f) with choiceLanguage set, the button call is sent within 100 ms while the copy takes 2 s', async () => {
  const { sends, call } = stub([PAIR_RAW])
  const launchedAt = Date.now()
  const englishTurn = new Promise<{ playerInput: string; playerInputEnglish: string; narrative: string }>((resolve) => {
    setTimeout(() => resolve({ playerInput: ENGLISH_LINE, playerInputEnglish: ENGLISH_LINE, narrative: ENGLISH_PROSE }), 2000)
  })
  const pending = extractChoiceMetadata(
    englishTurn.then((copy) => copy.narrative),
    FIXTURE_STATS,
    FIXTURE_FLAGS,
    {
      call,
      playerInput: NATIVE_LINE,
      choiceLanguage: CHOICE_LANGUAGE,
      englishTurn: englishValuesOf(englishTurn),
    },
    { split: true },
  )
  await new Promise((resolve) => setTimeout(resolve, 100))
  const choiceSend = sends.find((send) => send.purpose === 'choice_metadata')
  assert.ok(choiceSend, 'the button call must be sent before the copy settles')
  assert.ok(
    choiceSend.at - launchedAt <= 100,
    `the button call was sent ${choiceSend.at - launchedAt} ms after the launch, while the copy was still 2 s away`,
  )
  assert.equal(sends.some((send) => send.purpose === 'beat_ledger'), false, 'the ledger must still wait for the copy')
  const result = await pending
  assert.ok(result.choices.length >= 2, 'the waiting pair must still ship its buttons')
})

await check('(g) the split ledger is sent only after englishTurn and is the request built with the English player line', async () => {
  let resolvedAt = 0
  const englishTurn = new Promise<{ playerInput: string; playerInputEnglish: string; narrative: string }>((resolve) => {
    setTimeout(() => {
      resolvedAt = Date.now()
      resolve({ playerInput: ENGLISH_LINE, playerInputEnglish: ENGLISH_LINE, narrative: ENGLISH_PROSE })
    }, 300)
  })
  const early = stub([PAIR_RAW])
  await extractChoiceMetadata(
    englishTurn.then((copy) => copy.narrative),
    FIXTURE_STATS,
    FIXTURE_FLAGS,
    {
      call: early.call,
      playerInput: NATIVE_LINE,
      choiceLanguage: CHOICE_LANGUAGE,
      englishTurn: englishValuesOf(englishTurn),
    },
    { split: true },
  )
  // Today's launch: the objects the processor built after the copy, with the
  // English player line and no promise.
  const today = stub([PAIR_RAW])
  await extractChoiceMetadata(
    Promise.resolve(ENGLISH_PROSE),
    FIXTURE_STATS,
    FIXTURE_FLAGS,
    { call: today.call, playerInput: ENGLISH_LINE, choiceLanguage: CHOICE_LANGUAGE },
    { split: true },
  )
  const ledgerSend = early.sends.find((send) => send.purpose === 'beat_ledger')
  assert.ok(ledgerSend, 'the split must still make its ledger call')
  assert.ok(
    ledgerSend.at >= resolvedAt,
    `the ledger was sent ${resolvedAt - ledgerSend.at} ms before the copy settled`,
  )
  const earlyLedger = byPurpose(early.requests, 'beat_ledger')[0]
  const todayLedger = byPurpose(today.requests, 'beat_ledger')[0]
  assert.deepEqual(earlyLedger, todayLedger, 'the early ledger must be byte-identical to the one built with the English line')
  const system = JSON.stringify(earlyLedger.messages[0].content)
  assert.ok(system.includes(ENGLISH_LINE), 'the ledger must be told the English player turn')
  assert.equal(system.includes(NATIVE_LINE), false, 'the native player turn must not reach the ledger')
})

await check('(h) an English pair equal to the English line is dropped when the line arrives late via englishTurn', async () => {
  const raw = pairRaw([
    { label: 'Ask about the storm', kind: 'say', send: 'How long were you away?', local: 'Perguntar sobre a tempestade', localSend: 'Pergunto de novo sobre a tormenta.' },
    { label: 'Wait', send: '*I wait in silence.*', local: 'Esperar', localSend: '*Eu espero em silêncio.*' },
    { label: 'Leave', send: '*I leave the hall.*', local: 'Sair', localSend: '*Eu saio do salão.*' },
  ])
  let resolveCopy!: (copy: { playerInput: string; playerInputEnglish: string; narrative: string }) => void
  const englishTurn = new Promise<{ playerInput: string; playerInputEnglish: string; narrative: string }>((resolve) => {
    resolveCopy = resolve
  })
  const { requests, call } = stub([raw])
  const pending = extractChoiceMetadata(
    englishTurn.then((copy) => copy.narrative),
    FIXTURE_STATS,
    FIXTURE_FLAGS,
    {
      call,
      playerInput: NATIVE_LINE,
      choiceLanguage: CHOICE_LANGUAGE,
      englishTurn: englishValuesOf(englishTurn),
    },
    { split: true },
  )
  // The buttons answer first: when they do, the English line does not exist yet.
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(byPurpose(requests, 'choice_metadata').length, 1, 'the buttons must answer before the copy settles')
  resolveCopy({ playerInput: ENGLISH_LINE, playerInputEnglish: ENGLISH_LINE, narrative: ENGLISH_PROSE })
  const result = await pending
  assert.deepEqual(result.choices.map((choice) => choice.label), ['Esperar', 'Sair'])
  assert.deepEqual(result.choices_en?.map((choice) => choice.label), ['Wait', 'Leave'])
})

await check('(i) the processor launches the non-English buttons before the copy and hands the copy over after it', async () => {
  const processor = await readFile(new URL('../worker/processors/generation.processor.ts', import.meta.url), 'utf8')
  const launch = processor.indexOf('const earlyChoiceHalf =')
  assert.ok(launch > 0, 'the early button launch must exist')
  const witness = processor.indexOf('await runTurnWitness(')
  assert.ok(witness > launch, 'the early launch must be declared before the copy runs')
  const done = processor.indexOf('englishDone?.({')
  assert.ok(done > witness, 'englishDone must be called after the copy block')
  assert.ok(
    processor.slice(launch, witness).includes('englishReady.then'),
    'the launch must be handed the copy through the promise',
  )
})

// ── (j)-(k) the buttons stop waiting for the split ledger call ──────────────
const SLOW_LEDGER_RAW = '{"beat_ledger":{"npc_beats":["Mara sets her coat aside"],"emotional_shift":null,"setting":"the hall","consequence":null,"unresolved_hook":null}}'

await check('(j) with the split on, onChoices fires with the buttons while the ledger is still 3 s out; the returned promise carries it', async () => {
  const LEDGER_DELAY_MS = 3000
  const call = async (request: Record<string, any>) => {
    if (request.purpose === 'beat_ledger') {
      await new Promise((resolve) => setTimeout(resolve, LEDGER_DELAY_MS))
      return SLOW_LEDGER_RAW
    }
    if (request.purpose === 'scene_witness') return WITNESS_RAW
    return GOOD_RAW
  }
  const startedAt = Date.now()
  let firedAt: number | undefined
  let early: SceneMetadata | undefined
  const pending = extractChoiceMetadata(FIXTURE_PROSE, FIXTURE_STATS, FIXTURE_FLAGS, {
    ...opts(call),
    onChoices: (result) => { firedAt = Date.now() - startedAt; early = result },
  }, { split: true })
  await new Promise((resolve) => setTimeout(resolve, 300))
  assert.notEqual(firedAt, undefined, 'onChoices must fire without waiting for the ledger')
  assert.ok((firedAt as number) <= 300, `onChoices fired ${firedAt} ms after the launch, while the ledger was 3 s out`)
  assert.ok((early?.choices?.length ?? 0) > 0, 'onChoices must receive the buttons')
  assert.equal(early?.beat_ledger?.setting ?? null, null, 'the half reported before the join has no ledger in it')
  const result = await pending
  const returnedAt = Date.now() - startedAt
  assert.ok(returnedAt >= LEDGER_DELAY_MS, `the returned promise settled at ${returnedAt} ms, before the ledger`)
  assert.equal(result.beat_ledger?.setting, 'the hall', 'the returned promise must still carry beat_ledger')
})

await check('(k) the processor races the early publish on choicesOnly and keeps metaPromise on choiceHalfPromise', async () => {
  const processor = await readFile(new URL('../worker/processors/generation.processor.ts', import.meta.url), 'utf8')
  const earlyAt = processor.indexOf('const earlyChoicesPromise =')
  assert.ok(earlyAt >= 0, 'earlyChoicesPromise must exist')
  const earlyLine = processor.slice(earlyAt, processor.indexOf('\n', earlyAt))
  assert.ok(earlyLine.includes('Promise.race([choicesOnly, choiceHalfPromise])'),
    `the early publish must race on the button half alone: ${earlyLine}`)
  const metaAt = processor.indexOf('const metaPromise =')
  assert.ok(metaAt >= 0, 'metaPromise must exist')
  const metaBlock = processor.slice(metaAt, processor.indexOf('\n', processor.indexOf('.then(', metaAt)))
  assert.ok(metaBlock.includes('choiceHalfPromise'), 'metaPromise must keep the ledger-carrying half')
  assert.equal(metaBlock.includes('choicesOnly'), false, 'metaPromise must not read the pre-ledger half')
})

await check('(l) choicesNameAnyone reads the English pair, label and send, whole word, any case', () => {
  const names = ['Vernon', 'Ann']
  const chip = (label: string, send: string) => ({ label, send, kind: 'say' })
  // No English list (an English save): the chip itself is read.
  assert.equal(choicesNameAnyone([chip('Ask Vernon', 'Where were you?')], undefined, names), true, 'label')
  assert.equal(choicesNameAnyone([chip('Wait', 'I look at vernon.')], undefined, names), true, 'send, any case')
  assert.equal(choicesNameAnyone([chip('Ask Annabel', 'Where were you?')], undefined, names), false, 'a longer name is not Ann')
  assert.equal(choicesNameAnyone([chip('Look around', 'I look around.')], undefined, names), false, 'nobody named')
  assert.equal(choicesNameAnyone([chip('Ask Vernon', 'Hi')], undefined, []), false, 'empty cast list')
  // With an English list the English pair is what counts, as in the filter.
  assert.equal(
    choicesNameAnyone([chip('Pergunta ao Vernon', 'Onde estavas?')], [{ label: 'Ask the steward', send: 'Where were you?' }], names),
    false, 'native names him, English pair does not')
  assert.equal(
    choicesNameAnyone([chip('Pergunta ao mordomo', 'Onde estavas?')], [{ label: 'Ask Vernon', send: 'Where were you?' }], names),
    true, 'English pair names him')
})

await check('(m) when no button names the cast, the this-turn deaths filter keeps every button for any reported names', () => {
  const cast = ['Vernon', 'Ann', 'Old Tom']
  const fixtures: Array<{ choices: Array<{ label: string; send: string; kind: string }>; en?: Array<{ label: string; send: string }> }> = [
    { choices: [{ label: 'Look around', send: 'I look around the hall.', kind: 'do' }, { label: 'Ask Annabel', send: 'Annabel, why?', kind: 'say' }] },
    { choices: [{ label: 'Pergunta ao Vernon', send: 'Vernon?', kind: 'say' }, { label: 'Sai', send: 'Saio.', kind: 'do' }],
      en: [{ label: 'Ask the steward', send: 'Steward?' }, { label: 'Leave', send: 'I leave.' }] },
    { choices: [{ label: 'Call for Tom', send: 'Tom! Tommy!', kind: 'say' }] },
    // Names the cast only in the send, or only in the English pair: the helper
    // must say yes here, or the filter below would drop a button it let through.
    { choices: [{ label: 'Wait', send: 'I wait for Vernon.', kind: 'do' }] },
    { choices: [{ label: 'Espera', send: 'Espero.', kind: 'do' }], en: [{ label: 'Wait for Ann', send: 'I wait.' }] },
  ]
  // Every subset of the cast list, as the deaths call could report.
  const subsets = Array.from({ length: 1 << cast.length }, (_, mask) => cast.filter((_, i) => mask & (1 << i)))
  let skipped = 0
  for (const f of fixtures) {
    if (choicesNameAnyone(f.choices, f.en, cast)) continue
    skipped++
    for (const reported of subsets) {
      // The processor's this-turn deaths filter, same predicate as (n) pins.
      const kept = filterChoicePairs(f.choices, f.en, (choice, english) =>
        !reported.some((name) => new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i')
          .test(`${(english ?? choice).label} ${(english ?? choice).send}`)))
      assert.equal(kept.choices.length, f.choices.length, `skipped the wait, then reported ${reported.join(',')} dropped a button: ${JSON.stringify(f)}`)
    }
  }
  assert.equal(skipped, 3, 'the three fixtures that name nobody must skip the wait')
})

await check('(n) the processor awaits the deaths for the buttons only when a button names the cast list', async () => {
  const processor = await readFile(new URL('../worker/processors/generation.processor.ts', import.meta.url), 'utf8')
  const earlyAt = processor.indexOf('const earlyChoicesPromise =')
  assert.ok(earlyAt >= 0, 'earlyChoicesPromise must exist')
  const earlyLine = processor.slice(earlyAt, processor.indexOf('\n', earlyAt))
  assert.equal(earlyLine.includes('deathExtractionPromise'), false, `the join must not wait on the deaths: ${earlyLine}`)
  const thenAt = processor.indexOf('.then(', earlyAt)
  const body = processor.slice(thenAt, processor.indexOf('const startedAt = Date.now()', thenAt))
  assert.ok(body.includes('choicesWaitedForDeaths = choicesNameAnyone(choice.choices || [], choice.choices_en, lifecycleNames)'),
    `the wait must be decided from the buttons and the cast list: ${body}`)
  assert.ok(body.includes('choicesWaitedForDeaths ? await deathExtractionPromise : []'), `the deaths must be awaited when a button names the cast: ${body}`)
  const namesAt = processor.indexOf('const lifecycleNames =')
  const namesBlock = processor.slice(namesAt, processor.indexOf('let choicesWaitedForDeaths', namesAt))
  assert.ok(namesBlock.includes('packet.lifecycleRoster') && namesBlock.includes('card.canonical_name'),
    `the names must be the deaths call's own candidates: ${namesBlock}`)
  assert.ok(/candidates: packet\.lifecycleRoster \|\| \[\],/.test(processor.slice(processor.indexOf('const deathExtractionPromise ='), namesAt)),
    'the deaths call must read the same list')
  const tailAt = processor.indexOf('const [meta, entityAdjudication, characterLifecycleDeltas, endpointAdjudication] = await Promise.all([')
  assert.ok(tailAt > earlyAt && processor.slice(tailAt, processor.indexOf('])', tailAt)).includes('deathExtractionPromise'),
    'the stored deltas must still await deathExtractionPromise')
  const finishAt = processor.indexOf('const finishChoices = (')
  const finish = processor.slice(finishAt, earlyAt)
  assert.ok(finish.includes('keep(`${(english ?? choice).label} ${(english ?? choice).send}`)'), 'the filter must read the English pair as (l) does')
  assert.ok(finish.includes("!deltas.some((delta) => new RegExp(`\\\\b${escapeRegExp(delta.name)}\\\\b`, 'i').test(text))"),
    'the this-turn filter must match the reported name as (m) does')
})

await check('(o) the deaths extractor reports only names from its candidates', async () => {
  const extractor = await readFile(new URL('../worker/lib/character-lifecycle-extractor.ts', import.meta.url), 'utf8')
  assert.ok(extractor.includes(".filter((card) => !card.is_protagonist && card.canonical_name)\n    .map((card) => ({ name: card.canonical_name,"),
    'candidates must be the non-protagonist canonical names')
  assert.ok(extractor.includes("const name = byName.get(normalizeEntityName(String((change as any).name || '')))"),
    'a reported name must be looked up in the candidates')
  assert.ok(extractor.includes('if (!name || !evidence) continue'), 'an unknown name must be dropped')
})

if (fail > 0) {
  console.log(`\nchoice-early audit: ${pass} passed, ${fail} failed`)
  process.exit(1)
}

if (process.argv.includes('--bites')) {
  await runBites()
} else {
  console.log(`\nchoice-early audit: ${pass} passed, 0 failed`)
}

// ── bites ────────────────────────────────────────────────────────────────────
type Edit = [file: string, from: string, to: string]
type Mutation = { name: string; check: string; edits: Edit[] }

async function runBites() {
  const root = await mkdtemp(join(import.meta.dir, '.choice-early-bites-'))
  const server = new URL('..', import.meta.url).pathname
  const AUDIT = 'scripts/choice-early-audit.ts'
  const extractor = 'worker/lib/metadata-extractor.ts'
  const processor = 'worker/processors/generation.processor.ts'

  const mutations: Mutation[] = [
    {
      name: '(a) buttons sent back to the metadata model',
      check: '(a) choice_metadata runs on AI_MODELS.choices with reasoning off; ledger and witness stay on AI_MODELS.metadata',
      edits: [[extractor, '          model,\n          ...(noReasoning ? { noReasoning: true } : {}),', '          model: AI_MODELS.metadata,\n          ...(noReasoning ? { noReasoning: true } : {}),']],
    },
    {
      name: '(b) the one retry removed',
      check: '(b) a thrown first call retries exactly once on AI_MODELS.metadata and keeps the buttons',
      edits: [[extractor,
        '      try {\n        const first = await askChoices(AI_MODELS.choices, true)\n        if ((first.choices?.length ?? 0) > 0) { opts?.onChoiceModel?.(AI_MODELS.choices); return first }\n      } catch { /* fall through to the one retry */ }\n      // A host outage or a refused adult scene must never leave the turn without buttons.\n      const retry = await askChoices(AI_MODELS.metadata, false)\n      opts?.onChoiceModel?.(AI_MODELS.metadata)\n      return retry',
        '      const first = await askChoices(AI_MODELS.choices, true)\n      opts?.onChoiceModel?.(AI_MODELS.choices)\n      return first']],
    },
    {
      name: '(c) a 3 s wait added to the choice half',
      check: '(c) a 3 s witness cannot delay extractChoiceMetadata past 500 ms',
      edits: [[extractor, '  const language = opts?.choiceLanguage', '  await new Promise((resolve) => setTimeout(resolve, 3000))\n  const language = opts?.choiceLanguage']],
    },
    {
      name: '(d) the early publish guard removed',
      check: '(d) the processor publishes choices_ready early, guards both sites, and assigns after the join',
      edits: [[processor, '      if (!choicesReadySent && done.choices.length > 0) {', '      if (done.choices.length > 0) {']],
    },
    {
      name: '(f) the button half made to wait for the copy',
      check: '(f) with choiceLanguage set, the button call is sent within 100 ms while the copy takes 2 s',
      edits: [[extractor, '  const language = opts?.choiceLanguage', '  await opts?.englishTurn\n  const language = opts?.choiceLanguage']],
    },
    {
      name: '(g) the ledger kept on the early (native) object',
      check: '(g) the split ledger is sent only after englishTurn and is the request built with the English player line',
      edits: [[extractor, '      const english = opts?.englishTurn ? await opts.englishTurn : undefined', '      const english = undefined']],
    },
    {
      name: '(h) the late English line never read',
      check: '(h) an English pair equal to the English line is dropped when the line arrives late via englishTurn',
      edits: [[extractor,
        '          language ? (opts?.englishTurn ? (await opts.englishTurn).playerInputEnglish : opts?.playerInputEnglish) : undefined,',
        '          language ? opts?.playerInputEnglish : undefined,']],
    },
    {
      name: '(i) the early launch renamed away',
      check: '(i) the processor launches the non-English buttons before the copy and hands the copy over after it',
      edits: [[processor, 'const earlyChoiceHalf = englishReady', 'const lateChoiceHalf = englishReady']],
    },
    {
      name: '(j) onChoices moved after the ledger join',
      check: '(j) with the split on, onChoices fires with the buttons while the ledger is still 3 s out; the returned promise carries it',
      edits: [[extractor,
        '  try { opts?.onChoices?.(choices) } catch {}\n  return ledgerPromise ? { ...choices, beat_ledger: await ledgerPromise } : choices',
        '  const joined = ledgerPromise ? { ...choices, beat_ledger: await ledgerPromise } : choices\n  try { opts?.onChoices?.(joined) } catch {}\n  return joined']],
    },
    {
      name: '(k) the early publish put back on the ledger-bearing half',
      check: '(k) the processor races the early publish on choicesOnly and keeps metaPromise on choiceHalfPromise',
      edits: [[processor, 'Promise.race([choicesOnly, choiceHalfPromise])', 'choiceHalfPromise']],
    },
    {
      name: '(l) the name match made a substring',
      check: '(l) choicesNameAnyone reads the English pair, label and send, whole word, any case',
      edits: [[extractor, "new RegExp(`\\\\b${escaped(name)}\\\\b`, 'i')", "new RegExp(escaped(name), 'i')"]],
    },
    {
      name: '(l) the native chip read instead of the English pair',
      check: '(l) choicesNameAnyone reads the English pair, label and send, whole word, any case',
      edits: [[extractor, '    const pair = choicesEn?.[index] ?? choice\n', '    const pair = choice\n']],
    },
    {
      name: '(m) the helper reads the label only',
      check: '(m) when no button names the cast, the this-turn deaths filter keeps every button for any reported names',
      edits: [[extractor, '    const text = `${pair.label} ${pair.send}`\n    return patterns', '    const text = `${pair.label}`\n    return patterns']],
    },
    {
      name: '(n) the buttons never wait for the deaths',
      check: '(n) the processor awaits the deaths for the buttons only when a button names the cast list',
      edits: [[processor, 'choicesWaitedForDeaths ? await deathExtractionPromise : []', 'false ? await deathExtractionPromise : []']],
    },
    {
      name: '(o) the extractor keeps a name off the cast list',
      check: '(o) the deaths extractor reports only names from its candidates',
      edits: [['worker/lib/character-lifecycle-extractor.ts', 'if (!name || !evidence) continue', 'if (!evidence) continue']],
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
    console.log(`choice-early bites: ${bitten}/${mutations.length} mutations rejected; scratch restored and removed`)
    if (bitten !== mutations.length) process.exit(1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}
