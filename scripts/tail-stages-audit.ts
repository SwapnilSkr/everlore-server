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
 *   - `tail_stages` names every step of the tail; the five post-stream model
 *     calls run CONCURRENTLY, so each is timed on its own inside the batch and
 *     `extraction_join` is the batch — only the serial steps are summed;
 *   - a call its own gate skipped leaves NO key, so "skipped" never reads as
 *     "instant";
 *   - `tail_slowest_call` says which of the five set the pace;
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
// call (60 ms and 12 ms).
const CALL_MS: Record<string, number> = { scene_witness: 60, choice_metadata: 12 }
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

const { extractSceneMetadata } = await import('../worker/lib/metadata-extractor')
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

await check('a gated-off call leaves no key at all', async () => {
  // No unfamiliar candidate and no eligible roster: the entity judge and the
  // death extractor return without calling a model, so they are absent — never 0.
  const gated = buildTailStages({
    scene_witness: 40,
    entity_adjudication: undefined,
    deaths: undefined,
  })
  assert.deepEqual(gated, { scene_witness: 40 }, 'a skipped call must be absent, never written as 0')
  // …and the processor decides each omission from that call's own gate.
  assert.ok(
    processorSource.includes('if (entityCandidates.length) tailCallMs.entity_adjudication'),
    'the entity judge must be recorded only when it had a candidate',
  )
  assert.ok(
    processorSource.includes('if (endpointWillCall) tailCallMs.scene_endpoint'),
    'the endpoint judge must be recorded only when there was prose to judge',
  )
  assert.ok(
    processorSource.includes('if (deathWillCall) tailCallMs.deaths'),
    'the death extractor must be recorded only when its own gate let it call',
  )
})

await check('the slowest call names one of the five, and nothing when none ran', async () => {
  assert.equal(slowestTailCall({ scene_witness: 400, choice_metadata: 90, deaths: 40 }), 'scene_witness')
  assert.equal(slowestTailCall({ scene_endpoint: 1_020, choice_metadata: 990 }), 'scene_endpoint')
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
