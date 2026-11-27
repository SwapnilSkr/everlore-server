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
  type MetadataOpts,
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
 */
function stub(choiceAnswers: Array<string | Error>) {
  const requests: Array<Record<string, any>> = []
  let choiceAttempt = 0
  const call = async (request: Record<string, any>) => {
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
  return { requests, call }
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
