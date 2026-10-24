/**
 * THE TAIL AND THE GAPS: where the seconds AFTER the prose go, and where the
 * seconds BEFORE the narrator go.
 *
 * Measured on prod (Oct 23 2026): `post_stream_ms` p50 3.6 s, p90 6.0 s, max
 * 10.2 s per turn — the time the composer waits after the last streamed token,
 * with nothing inside it measured. And `end_to_end_ttft_ms` p50 2.37 s against
 * `context_latency_ms` p50 0.76 s plus `ttft_ms` p50 1.05 s: ~0.5 s of the
 * player's first word belonged to no stage at all.
 *
 * Both are now broken down on `generation_logs`, and this pins the breakdown:
 *   - `tail_stages` names every step of the tail; the post-stream model calls
 *     run CONCURRENTLY, so each is timed on its own inside the batch and
 *     `extraction_join` is the batch — only the serial steps are summed;
 *   - each call reports from inside its own lib, so its own gate decides whether
 *     there is a stage at all, and a call its own gate skipped leaves NO key —
 *     "skipped" never reads as "instant";
 *   - `beat_ledger` exists only when the choices pass is split, and is timed
 *     around the ledger call, never inside `choice_metadata`;
 *   - `tail_slowest_call` says which call set the pace;
 *   - `pre_narrator_stages` closes the gap between the socket message and the
 *     narrator's request, so prep + host + gaps equal `end_to_end_ttft_ms`.
 *
 * The processor itself has no pure seam (BullMQ job, Redis, Mongo, narrator), so
 * — following `embedding-latency-audit` (i) — the parts that CAN run here run
 * for real (the builders, and the extractor pair behind an injected model
 * client), and the processor's wiring is pinned on its source.
 *
 *   bun --no-env-file run scripts/tail-stages-audit.ts
 */
import assert from 'node:assert/strict'
import { mock } from 'bun:test'
import { readFileSync } from 'node:fs'

let pass = 0
let fail = 0
async function check(label: string, fn: () => Promise<void>) {
  try {
    await fn()
    pass++
    console.log(`  ok   ${label}`)
  } catch (err) {
    fail++
    console.log(`  FAIL ${label}\n       ${(err as Error).message}`)
  }
}

// ── The extractor pair's only seam ────────────────────────────────────────────
// `extractSceneMetadata` runs its two halves in parallel against one client. The
// fake answers each purpose after a DIFFERENT sleep, so a timing taken around
// the pair (~60 ms for both) is distinguishable from a timing taken around each
// call (60 ms and 12 ms). The ledger's sleep is deliberately long: a choices
// stage that swallowed the ledger join would read ≥120 ms instead of ~12.
const CALL_MS: Record<string, number> = {
  scene_witness: 60,
  choice_metadata: 12,
  beat_ledger: 120,
  entity_adjudication: 30,
  scene_endpoint: 20,
  character_deaths: 8,
}
const calls: Array<{ purpose: string; ms: number }> = []
let failPurpose: string | null = null

mock.module('../src/ai', () => ({
  AI_MODELS: { metadata: 'audit-metadata' },
  callLLM: async (opts: { purpose?: string }) => {
    const purpose = String(opts.purpose || '')
    const ms = CALL_MS[purpose] ?? 0
    calls.push({ purpose, ms })
    await Bun.sleep(ms)
    if (purpose === failPurpose) throw new Error(`${purpose} failed`)
    return '{}'
  },
}))

const { extractSceneMetadata, extractChoiceMetadata } = await import('../worker/lib/metadata-extractor')
const { adjudicateEntityCandidates, entityAdjudicationCandidates } = await import('../worker/lib/entity-adjudicator')
const { adjudicateSceneEndpoint } = await import('../worker/lib/scene-endpoint-adjudicator')
const { extractLifecycleChanges } = await import('../worker/lib/character-lifecycle-extractor')
const {
  PRE_NARRATOR_STAGE_KEYS,
  TAIL_MODEL_CALL_STAGES,
  TAIL_STAGE_KEYS,
  buildPreNarratorStages,
  buildTailStages,
  slowestTailCall,
} = await import('../src/models/generation-log.model')

const processorSource = readFileSync(
  new URL('../worker/processors/generation.processor.ts', import.meta.url),
  'utf8',
)
const modelSource = readFileSync(new URL('../src/models/generation-log.model.ts', import.meta.url), 'utf8')

const PROSE = 'The steward sets the key down on the counting-house table and says nothing.'
const PERSON_PROSE = 'Mara steps into the hall and sets her wet coat aside.'

console.log('\nthe tail says where the seconds after the prose went:')

await check('the tail builder keeps finite integers and drops everything else', async () => {
  const all = Object.fromEntries(TAIL_STAGE_KEYS.map((key) => [key, 12.4])) as Record<string, number>
  const built = buildTailStages(all)
  for (const key of TAIL_STAGE_KEYS) {
    assert.equal(built[key], 12, `${key} must survive as a rounded integer`)
    assert.equal(Number.isInteger(built[key]), true, `${key} must be an integer`)
  }
  const noisy = buildTailStages({
    stubs: 5,
    location: -1,
    time: Number.NaN,
    deaths: Number.POSITIVE_INFINITY,
    not_a_stage: 9,
    post_insert: undefined,
  } as Record<string, number | undefined>)
  assert.deepEqual(noisy, { stubs: 5 }, 'negative, non-finite, unknown and missing stages must be dropped')
})

await check('the log row carries the tail stages and the slowest call', async () => {
  assert.ok(modelSource.includes('tail_stages?: TailStages'), 'the document must declare tail_stages')
  assert.ok(modelSource.includes('tail_slowest_call?: TailModelCallStage'), 'the document must declare tail_slowest_call')
  assert.ok(
    processorSource.includes('const tailStages = buildTailStages({'),
    'the row must build its stages through the builder, not by hand',
  )
  assert.ok(processorSource.includes('tail_stages: tailStages,'), 'the row must carry tail_stages')
  assert.ok(
    processorSource.includes('const slowestCall = slowestTailCall(tailCallMs)'),
    'the slowest call must be derived from the recorded call timings',
  )
  assert.ok(
    processorSource.includes('...(slowestCall ? { tail_slowest_call: slowestCall } : {})'),
    'the row must carry the slowest call, and omit the key when no call ran',
  )
})

await check('each concurrent call is timed on its own, not around the join', async () => {
  calls.length = 0
  const stages: Record<string, number> = {}
  const started = Date.now()
  await extractSceneMetadata(PROSE, [], [], { onStage: (stage, ms) => { stages[stage] = ms } })
  const pairMs = Date.now() - started

  assert.deepEqual(
    calls.map((call) => call.purpose).sort(),
    ['choice_metadata', 'scene_witness'],
    'both halves must reach the model',
  )
  assert.equal(typeof stages.scene_witness, 'number', 'scene_witness must be timed')
  assert.equal(typeof stages.choice_metadata, 'number', 'choice_metadata must be timed')
  assert.ok(Math.abs(stages.scene_witness - 60) <= 40, `scene_witness must report its own ~60ms (${stages.scene_witness}ms)`)
  assert.ok(Math.abs(stages.choice_metadata - 12) <= 40, `choice_metadata must report its own ~12ms (${stages.choice_metadata}ms)`)
  // The pair takes ~60ms, so a reading taken around it would make BOTH halves
  // read the same. They must not.
  assert.ok(
    stages.scene_witness - stages.choice_metadata >= 30,
    `both halves read ${stages.scene_witness}ms/${stages.choice_metadata}ms — that is one timing taken around the pair, not two calls`,
  )
  assert.ok(pairMs >= stages.scene_witness - 5, `the pair (${pairMs}ms) cannot be quicker than its slowest call (${stages.scene_witness}ms)`)
  console.log(
    `       fixture: a 60ms witness beside a 12ms choice took ${pairMs}ms together (${JSON.stringify(stages)})`,
  )
})

await check('a call that fails is still a wait; only a skipped call has no key', async () => {
  failPurpose = 'scene_witness'
  const stages: Record<string, number> = {}
  await extractSceneMetadata(PROSE, [], [], { onStage: (stage, ms) => { stages[stage] = ms } })
  failPurpose = null
  assert.equal(typeof stages.scene_witness, 'number', 'a failed call is still time the tail waited')
  assert.equal(typeof stages.choice_metadata, 'number', 'the other half is unaffected')
})

await check('a split choices pass times its ledger on its own, and an unsplit one has no ledger stage', async () => {
  calls.length = 0
  const splitStages: Record<string, number> = {}
  await extractChoiceMetadata(
    PROSE, [], [],
    { onStage: (stage, ms) => { splitStages[stage] = ms } },
    { split: true },
  )
  assert.deepEqual(
    calls.map((call) => call.purpose).sort(),
    ['beat_ledger', 'choice_metadata'],
    'a split pass must make both calls',
  )
  assert.equal(typeof splitStages.beat_ledger, 'number', 'the ledger call must be timed')
  assert.ok(
    Math.abs(splitStages.beat_ledger - 120) <= 60,
    `beat_ledger must report its own ~120ms (${splitStages.beat_ledger}ms)`,
  )
  // The ledger sleeps 120ms and the choices 12ms. A stage taken around the pair
  // would report the ledger's wait inside `choice_metadata`; this must not.
  assert.ok(
    splitStages.choice_metadata <= 80,
    `choice_metadata must cover only the choices request, never the ledger join (${splitStages.choice_metadata}ms)`,
  )
  // The join waits on `extractChoiceMetadata`, which does not settle until the
  // ledger does — so the ledger can pace it and must be nameable.
  assert.ok(
    (TAIL_MODEL_CALL_STAGES as readonly string[]).includes('beat_ledger'),
    'the ledger can hold extraction_join open, so tail_slowest_call must be able to name it',
  )

  calls.length = 0
  const unsplitStages: Record<string, number> = {}
  await extractChoiceMetadata(
    PROSE, [], [],
    { onStage: (stage, ms) => { unsplitStages[stage] = ms } },
    { split: false },
  )
  assert.deepEqual(calls.map((call) => call.purpose), ['choice_metadata'], 'an unsplit pass makes one call')
  assert.equal('beat_ledger' in unsplitStages, false, 'unsplit there is no ledger call, so no ledger stage')
  assert.equal(typeof unsplitStages.choice_metadata, 'number', 'the unsplit call is still timed')
  console.log(
    `       fixture: a 120ms ledger beside a 12ms choices call read ${splitStages.beat_ledger}ms/${splitStages.choice_metadata}ms`,
  )
})

await check('each lib times its own call, and reports nothing when its own gate skips it', async () => {
  const reported: Record<string, number> = {}
  const report = (stage: string, ms: number) => { reported[stage] = ms }
  const mara = entityAdjudicationCandidates({ prose: PERSON_PROSE, knownNames: [] })
  assert.equal(mara.length, 1, 'fixture: the prose must yield one unfamiliar candidate')

  // The identity judge: no unfamiliar candidate means no model call at all.
  await adjudicateEntityCandidates({ prose: PERSON_PROSE, candidates: [], knownCast: [], knownPlaces: [], onStage: report })
  assert.equal('entity_adjudication' in reported, false, 'no candidate means no call, so no stage')
  await adjudicateEntityCandidates({ prose: PERSON_PROSE, candidates: mara, knownCast: [], knownPlaces: [], onStage: report })
  assert.ok(typeof reported.entity_adjudication === 'number', 'a judge that ran must be timed')
  assert.ok(
    Math.abs(reported.entity_adjudication - 30) <= 40,
    `entity_adjudication must report its own ~30ms (${reported.entity_adjudication}ms)`,
  )

  // The endpoint judge: empty prose returns its fallback with no model call.
  await adjudicateSceneEndpoint({ prose: '   ', candidates: [], onStage: report })
  assert.equal('scene_endpoint' in reported, false, 'no prose means no call, so no stage')
  await adjudicateSceneEndpoint({ prose: PERSON_PROSE, candidates: ['Mara'], onStage: report })
  assert.ok(typeof reported.scene_endpoint === 'number', 'an endpoint judge that ran must be timed')

  // The death extractor: no text, or no ELIGIBLE candidate, means no call.
  await extractLifecycleChanges({ prose: '', playerNarration: [], candidates: [], sequence: 1, onStage: report })
  assert.equal('deaths' in reported, false, 'no text and no roster leaves nothing to judge')
  await extractLifecycleChanges({
    prose: '', playerNarration: [], candidates: [{ canonical_name: 'Mara' }], sequence: 1, onStage: report,
  })
  assert.equal('deaths' in reported, false, 'a roster with no text is still no call')
  // The protagonist is filtered out of the eligible roster. The processor used
  // to decide this itself, and its copy only asked for a canonical name — so a
  // protagonist-only roster would have been labelled a call that never happened.
  await extractLifecycleChanges({
    prose: PERSON_PROSE, candidates: [{ canonical_name: 'Mara', is_protagonist: true }], sequence: 1, onStage: report,
  })
  assert.equal('deaths' in reported, false, 'the protagonist is not an eligible candidate, so no call and no stage')
  await extractLifecycleChanges({
    prose: PERSON_PROSE, candidates: [{ canonical_name: 'Mara' }], sequence: 1, onStage: report,
  })
  assert.ok(typeof reported.deaths === 'number', 'a death extractor that ran must be timed')
})

await check('a lib call that fails is still a wait, so its stage is still reported', async () => {
  const reported: Record<string, number> = {}
  const report = (stage: string, ms: number) => { reported[stage] = ms }
  const mara = entityAdjudicationCandidates({ prose: PERSON_PROSE, knownNames: [] })

  failPurpose = 'entity_adjudication'
  await adjudicateEntityCandidates({ prose: PERSON_PROSE, candidates: mara, knownCast: [], knownPlaces: [], onStage: report })
  failPurpose = 'scene_endpoint'
  await adjudicateSceneEndpoint({ prose: PERSON_PROSE, candidates: ['Mara'], onStage: report })
  failPurpose = 'character_deaths'
  await extractLifecycleChanges({
    prose: PERSON_PROSE, candidates: [{ canonical_name: 'Mara' }], sequence: 1, onStage: report,
  })
  failPurpose = null

  for (const stage of ['entity_adjudication', 'scene_endpoint', 'deaths']) {
    assert.ok(typeof reported[stage] === 'number', `${stage} must be reported even when its call threw`)
  }
})

await check('the processor does not decide for itself whether a lib called', async () => {
  // The three mirrored gates and their copies of the libs' conditions are gone.
  for (const stale of [
    'tailCallMs.entity_adjudication =',
    'tailCallMs.scene_endpoint =',
    'tailCallMs.deaths =',
    'entityCandidates.length) tailCallMs',
    'endpointWillCall',
    'deathWillCall',
  ]) {
    assert.equal(processorSource.includes(stale), false, `the processor must not mirror a lib's gate ("${stale}")`)
  }
  // …and each lib reports its own stage from its own gate.
  for (const [file, stage] of [
    ['entity-adjudicator.ts', 'entity_adjudication'],
    ['scene-endpoint-adjudicator.ts', 'scene_endpoint'],
    ['character-lifecycle-extractor.ts', 'deaths'],
  ] as const) {
    const source = readFileSync(new URL(`../worker/lib/${file}`, import.meta.url), 'utf8')
    assert.ok(source.includes(`onStage?.('${stage}'`), `${file} must report ${stage} from its own gate`)
  }
  const passes = processorSource.match(/onStage: recordTailStage/g) || []
  assert.equal(passes.length, 4, `one recorder must reach all four staging calls (found ${passes.length})`)
  assert.ok(
    processorSource.includes('const recordTailStage = (stage: TailModelCallStage, ms: number) => { tailCallMs[stage] = ms }'),
    'the processor must record whatever stage a lib reports, under the lib\'s own name',
  )
})

await check('a gated-off call leaves no key at all', async () => {
  // The builder drops an absent stage rather than writing 0, so "skipped" and
  // "instant" stay distinguishable. WHICH calls are skipped is decided inside
  // each lib, from its own gate, and pinned by the two checks below.
  const gated = buildTailStages({
    scene_witness: 40,
    beat_ledger: undefined,
    entity_adjudication: undefined,
    deaths: undefined,
  })
  assert.deepEqual(gated, { scene_witness: 40 }, 'a skipped call must be absent, never written as 0')
})

await check('the slowest call names one of the tail calls, and nothing when none ran', async () => {
  assert.equal(slowestTailCall({ scene_witness: 400, choice_metadata: 90, deaths: 40 }), 'scene_witness')
  assert.equal(slowestTailCall({ scene_endpoint: 1_020, choice_metadata: 990 }), 'scene_endpoint')
  assert.equal(slowestTailCall({ scene_witness: 900, beat_ledger: 1_500 }), 'beat_ledger', 'a slow ledger can pace the join')
  assert.equal(slowestTailCall({ scene_witness: 50, choice_metadata: 50 }), 'scene_witness', 'ties go to the first')
  assert.equal(slowestTailCall({}), undefined)
  assert.equal(slowestTailCall({ scene_witness: Number.NaN, deaths: Number.POSITIVE_INFINITY }), undefined)
})

await check('every step the tail measures is a known stage, so none is silently dropped', async () => {
  const block = processorSource.match(/buildTailStages\(\{([\s\S]*?)\n\s*\}\)/)?.[1] || ''
  const named = [...block.matchAll(/^\s*([a-z_]+):/gm)].map((match) => match[1])
  assert.ok(named.length >= 11, `the tail must stage its serial steps (found ${named.length})`)
  for (const key of named) {
    assert.ok(
      (TAIL_STAGE_KEYS as readonly string[]).includes(key),
      `${key} is not a tail stage, so the builder would drop it without a word`,
    )
  }
  // The five model calls arrive through the recorder the calls themselves fill.
  assert.ok(block.includes('...tailCallMs'), 'the five call timings must be carried, not re-derived')
})

await check('the serial steps, not the parallel calls, are what add up', async () => {
  const fixture = buildTailStages({
    scene_witness: 1_180,
    choice_metadata: 960,
    entity_adjudication: 240,
    scene_endpoint: 1_020,
    deaths: 310,
    extraction_join: 1_400,
    interaction_signal_wait: 0,
    content_intent: 6,
    choice_audit: 30,
    location: 54,
    time: 9,
    presence_scene: 82,
    stubs: 21,
    event_insert: 27,
    post_insert: 12,
  })
  const serialKeys = TAIL_STAGE_KEYS.filter(
    (key) => !(TAIL_MODEL_CALL_STAGES as readonly string[]).includes(key) && key !== 'session_write',
  )
  const serial = serialKeys.reduce((total, key) => total + (fixture[key] || 0), 0)
  const allCalls = TAIL_MODEL_CALL_STAGES.reduce((total, key) => total + (fixture[key] || 0), 0)
  assert.ok(allCalls > serial, 'the five calls are concurrent: summing them would count the join five times over')
  assert.equal(typeof fixture.interaction_signal_wait, 'number', 'a settled wait is recorded as ~0, not omitted')
  // `post_stream_ms` ends at `loggedAt`, which is before `session_write`; the
  // few ms left over here is the prose-hygiene block between the last token and
  // the first extraction promise, which no stage owns.
  const postStreamMs = 1_665
  const unaccounted = postStreamMs - serial
  assert.ok(
    unaccounted >= 0 && unaccounted <= 50,
    `the serial steps add up to ${serial}ms against ${postStreamMs}ms of post_stream: ${unaccounted}ms unaccounted`,
  )
  console.log(
    `       fixture: ${serial}ms staged across ${serialKeys.length} serial steps, ${unaccounted}ms in the un-staged prose prelude, ${postStreamMs}ms post_stream`,
  )
})

console.log('\nand the gaps before the narrator are no longer anonymous:')

await check('the gaps, prep and the host add up to the first word', async () => {
  // One turn, in ms from the player's message: a 760ms packet and a 1050ms host
  // are the prod p50s; dispatch, queue, job setup and prompt assembly are what
  // used to leak around them.
  const t = {
    request: 0,
    enqueue: 18,
    jobStart: 62,
    liveCheck: 65,
    prepStart: 74,
    packet: 834,
    promptSent: 860,
    firstToken: 1_910,
  }
  const stages = buildPreNarratorStages({
    dispatch: t.enqueue - t.request,
    queue_wait: t.jobStart - t.enqueue,
    job_setup: t.liveCheck - t.jobStart,
    prompt_build: t.promptSent - t.packet,
  })
  for (const key of PRE_NARRATOR_STAGE_KEYS) {
    assert.equal(typeof stages[key], 'number', `${key} must be recorded on this fixture`)
  }
  const accounted =
    (stages.dispatch || 0) +
    (stages.queue_wait || 0) +
    (stages.job_setup || 0) +
    (t.prepStart - t.liveCheck) + // prep_stages.live_check, which sits outside context_latency_ms
    (t.packet - t.prepStart) + // context_latency_ms
    (stages.prompt_build || 0) +
    (t.firstToken - t.promptSent) // ttft_ms
  assert.equal(
    accounted,
    t.firstToken - t.request,
    `stages and metrics account for ${accounted}ms of ${t.firstToken - t.request}ms to the first word`,
  )
  assert.ok(t.firstToken - t.request - (t.packet - t.prepStart) - (t.firstToken - t.promptSent) > 40, 'the fixture must have real gaps to close')
  console.log(
    `       fixture: ${t.firstToken}ms to the first word = ${t.packet - t.prepStart}ms prep + ${t.firstToken - t.promptSent}ms host + ${accounted - (t.packet - t.prepStart) - (t.firstToken - t.promptSent)}ms of gaps, ${accounted}ms accounted`,
  )

  // Each gap is measured from the boundary that really marks it.
  assert.ok(
    processorSource.includes('dispatch: Math.max(0, enqueuedAt - requestStartedAt)'),
    'dispatch must run from the request time to the enqueue',
  )
  assert.ok(
    processorSource.includes('queue_wait: Math.max(0, jobStartedAt - enqueuedAt)'),
    'queue_wait must run from the enqueue to the job starting',
  )
  assert.ok(
    processorSource.includes('job_setup: Math.max(0, liveCheckStartedAt - jobStartedAt)'),
    'job_setup must run from the job starting to prep starting',
  )
  assert.ok(
    processorSource.includes('prompt_build: Math.max(0, genStart - packetReturnedAt)'),
    'prompt_build must run from prep ending to the narrator request being sent',
  )
  assert.ok(modelSource.includes('pre_narrator_stages?: PreNarratorStages'), 'the document must declare pre_narrator_stages')
  assert.ok(
    processorSource.includes('pre_narrator_stages: preNarratorStages,'),
    'the row must carry pre_narrator_stages',
  )
})

console.log(`\ntail stages audit: ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
