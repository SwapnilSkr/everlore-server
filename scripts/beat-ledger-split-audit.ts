/** Pure: fake client, no env files, no database and no model calls. */
import assert from 'node:assert/strict'
import { mock } from 'bun:test'
import { createHash } from 'node:crypto'
import { cpSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs, SpendBudget, reservation, budgetedSend, experimentCall, loadDecisionBuilder, judgeRequest } from './beat-ledger-split-ab'

const env = { CHOICE_HEDGE_MS: 1500, CHOICE_LEDGER_SPLIT: 'off' }
mock.module('../src/config/env', () => ({ env }))
type Request = Parameters<typeof import('../src/ai').callLLM>[0]
let requests: Request[] = []
let fail = ''
let holdLedger = false
let releaseLedger: (() => void) | undefined
const ledger = { npc_beats: [{ character: 'Neri', intent: 'seeks help', reaction: 'hopeful' }], emotional_shift: 'trust grows', setting: 'in the archive', consequence: 'a letter arrives', unresolved_hook: 'who sent the letter' }
const choices = [{ label: 'Read the letter', kind: 'act', send: '*I read the letter.*' }, { label: 'Ask Neri', kind: 'say', send: 'Who sent this?' }]
const output = { state_mutations: { focus: { op: 'add', value: 2 } }, flag_mutations: {}, scene_tag: 'exploration', emotional_tone: 'curious', beat_ledger: ledger, choices, milestone: null }
mock.module('../src/ai', () => ({ AI_MODELS: { metadata: 'gpt-4o-mini' }, callLLM: async (request: Request) => {
  requests.push(request)
  if (request.purpose === fail) throw new Error('fixture failure')
  if (request.purpose === 'beat_ledger') {
    if (holdLedger) await new Promise<void>((resolve) => { releaseLedger = resolve })
    return JSON.stringify({ beat_ledger: ledger })
  }
  const properties = (request.responseSchema as { properties: Record<string, unknown> }).properties
  if (!('beat_ledger' in properties)) { const { beat_ledger: _, ...rest } = output; return JSON.stringify(rest) }
  return JSON.stringify(output)
} }))
const { extractChoiceMetadata } = await import('../worker/lib/metadata-extractor')
const opts = { isSentient: false, protagonist: { name: 'Tavi', aliases: ['the keeper'] }, roster: [{ name: 'Neri', aliases: ['the courier'] }], currentLocationName: 'archive', priorPresent: ['Neri'], priorPhysical: [], knownPlaces: [{ name: 'archive', aliases: [] }], playerInput: '*I accept the letter.*', worldContext: 'An ordinary archive.', choiceContext: 'A letter arrived. Neri is the courier.', recentChoiceLabels: [] }
const narrative = 'Neri hands Tavi a sealed letter in the archive.'
const extract = () => extractChoiceMetadata(narrative, [{ name: 'focus', min: 0, max: 100, description: 'attention to work' }], ['letter_received'], opts)
let passed = 0, failed = 0
async function check(label: string, fn: () => unknown | Promise<unknown>) {
  requests = []; fail = ''; holdLedger = false; releaseLedger = undefined
  try { await fn(); passed++; console.log(`PASS ${label}`) }
  catch (error) { failed++; console.error(`FAIL ${label}: ${(error as Error).stack}`) }
}
let baseline: Request
let result: Awaited<ReturnType<typeof extract>>
const wire = (request: Request) => JSON.stringify(request)
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
await check('(a) off pins the legacy request byte for byte', async () => {
  env.CHOICE_LEDGER_SPLIT = 'off'
  result = await extract()
  assert.equal(requests.length, 1)
  baseline = requests[0]
  if (process.argv.includes('--legacy-pin')) { console.log(`LEGACY_PIN ${hash(wire(baseline))}`); return }
  assert.equal(hash(wire(baseline)), 'b52bf6028b5a28a334547c301214e43d4d5769f5cee917c30de402a242555f21')
  assert.equal(typeof baseline.firstTokenHedge?.onFirstToken, 'function')
  assert.equal(baseline.firstTokenHedge?.delayMs, 1500)
  const config = readFileSync(new URL('../src/config/env.ts', import.meta.url), 'utf8')
  assert.ok(config.includes("CHOICE_LEDGER_SPLIT: 'off'"))
  assert.ok(config.includes("CHOICE_LEDGER_SPLIT: process.env.CHOICE_LEDGER_SPLIT === 'on' ? 'on' : 'off'"))
})
if (process.argv.includes('--legacy-pin')) process.exit(failed ? 1 : 0)
await check('(b) split schemas, verbatim ledger rule and unchanged context/messages', async () => {
  env.CHOICE_LEDGER_SPLIT = 'on'
  await extract()
  assert.equal(requests.length, 2)
  const choice = requests.find((r) => r.purpose === 'choice_metadata')!
  const beat = requests.find((r) => r.purpose === 'beat_ledger')!
  const system = baseline.messages[0].content
  const rule = system.split('\n').find((line) => line.startsWith('- beat_ledger:'))!
  assert.ok(rule)
  const endRules = system.indexOf('\n\n--- CONTEXT')
  assert.ok(endRules > 0)
  assert.equal(choice.messages[0].content, system.replace(rule + '\n', ''))
  assert.equal(beat.messages[0].content, system.slice(0, system.indexOf('\n\nRules:')) + '\n\nRules:\n' + rule + '\n' + system.slice(endRules))
  for (const request of requests) {
    assert.deepEqual(request.messages.slice(1), baseline.messages.slice(1))
    assert.equal(request.model, baseline.model)
    assert.equal(request.temperature, baseline.temperature)
    assert.equal(request.maxTokens, baseline.maxTokens)
    assert.equal(request.firstTokenHedge?.delayMs, baseline.firstTokenHedge?.delayMs)
  }
  assert.equal(choice.firstTokenHedge?.lostPurpose, 'choice_metadata_hedge_lost')
  assert.equal(beat.firstTokenHedge?.lostPurpose, 'beat_ledger_hedge_lost')
  const schema = baseline.responseSchema as { properties: Record<string, unknown>; required: string[] }
  const { beat_ledger, ...properties } = schema.properties
  assert.deepEqual(choice.responseSchema, { ...schema, properties, required: schema.required.filter((k) => k !== 'beat_ledger') })
  assert.deepEqual(beat.responseSchema, { type: 'object', additionalProperties: false, properties: { beat_ledger }, required: ['beat_ledger'] })
})
await check('(c) merged shape and values match the legacy result', async () => {
  env.CHOICE_LEDGER_SPLIT = 'on'
  assert.deepEqual(await extract(), result)
  assert.deepEqual((await extract()).choices, choices)
  assert.deepEqual((await extract()).beat_ledger, ledger)
})
await check('(d) ledger failure leaves every choice field intact', async () => {
  fail = 'beat_ledger'
  const v = await extract()
  assert.deepEqual(v.choices, result.choices)
  assert.deepEqual(v.state_mutations, result.state_mutations)
  assert.equal(v.scene_tag, result.scene_tag)
  assert.deepEqual(v.beat_ledger, { npc_beats: [], emotional_shift: null, setting: null, consequence: null, unresolved_hook: null })
})
await check('(d) choices failure keeps the independent ledger', async () => {
  fail = 'choice_metadata'
  const v = await extract()
  assert.deepEqual(v.choices, [])
  assert.deepEqual(v.state_mutations, {})
  assert.equal(v.scene_tag, 'intimate')
  assert.deepEqual(v.beat_ledger, ledger)
})
await check('parallel launch and choices timing exclude the ledger join', async () => {
  holdLedger = true
  const stages: string[] = []
  let settled = false
  const promise = extractChoiceMetadata(narrative, [], [], { ...opts, onStage: (stage) => { stages.push(stage) } }).then((value) => { settled = true; return value })
  for (let i = 0; i < 10; i++) await Promise.resolve()
  assert.equal(requests.length, 2, 'both calls started while ledger blocked')
  assert.deepEqual(stages, ['choice_metadata'])
  assert.equal(settled, false)
  releaseLedger!()
  assert.deepEqual((await promise).beat_ledger, ledger)
  assert.deepEqual(stages, ['choice_metadata'])
})
await check('(e) dry-run default, strict flags and hard cap before every call', async () => {
  assert.equal(parseArgs([]).execute, false)
  assert.equal(parseArgs(['--execute']).execute, true)
  assert.equal(parseArgs(['--execute', '--dry-run']).execute, false)
  assert.equal(parseArgs(['--help']).execute, false)
  for (const value of ['1.500001', 'NaN', '0', '-1', 'Infinity']) assert.throws(() => parseArgs(['--max-usd', value]))
  assert.throws(() => parseArgs(['--unknown']))
  assert.throws(() => new SpendBudget(1.51))
  const b = new SpendBudget(.1)
  b.reserve(.06)
  assert.throws(() => b.reserve(.05), /STOP/)
  assert.equal(b.calls, 1)
  assert.equal(b.reserved, .06)
  assert.throws(() => b.reserve(0), /STOP/, 'once stopped, cannot send a cheaper call')
  assert.throws(() => reservation({}, { prompt: 1, completion: 1, request: 0 }))
  const source = readFileSync(new URL('./beat-ledger-split-ab.ts', import.meta.url), 'utf8')
  assert.ok(source.includes('budget.reserve(reservation(params, price))'))
  assert.ok(source.includes('if (args.execute) completions.create ='))
  assert.ok(source.includes('const invoke = experimentCall(args.execute, callLLM, plan)'))
  assert.ok(source.includes('const response = await budgetedSend(budget, params, price,'))
  let sent = 0, planned = 0
  const params = { max_tokens: 450, messages: [] }
  const price = { prompt: 0, completion: 0, request: .06 }
  const bounded = new SpendBudget(.1)
  await budgetedSend(bounded, params, price, async () => { sent++; return '{}' })
  await assert.rejects(budgetedSend(bounded, params, price, async () => { sent++; return '{}' }), /STOP/)
  assert.equal(sent, 1, 'second physical request never sent')
  const invoke = experimentCall(parseArgs([]).execute, async () => { sent++; return '{}' }, () => { planned++ })
  await extractChoiceMetadata(narrative, [], [], opts, { split: true, call: invoke })
  assert.equal(sent, 1, 'default dry-run never sends either model request')
  assert.equal(planned, 2)
})
await check('same processor builder, blind judging and randomized labels', async () => {
  const builder = await loadDecisionBuilder()
  const text = builder({ isSentient: false, playerName: 'Tavi', playerInput: 'Read it', worldState: {}, activeFlags: {}, characterCodex: [], recentEvents: [], loreTexts: [], memoryTexts: [], openThreads: [], relevantSummaries: [], relationshipFacts: [], positionFacts: [], companionFacts: [] })
  assert.ok(text.includes('Tavi')); assert.ok(text.includes('Read it'))
  const req = judgeRequest('deepseek/deepseek-v3.2', { narrative, opts }, choices, [], false)
  const context = JSON.parse(req.messages[1].content)
  assert.deepEqual(context.X, choices)
  assert.deepEqual(context.Y, [])
  assert.equal(context.choiceDecisionContext, opts.choiceContext)
  assert.ok(!req.messages.some((m) => /arm [AB]/i.test(m.content)))
})
console.log(`Beat ledger split audit: ${passed} passed, ${failed} failed`)
process.exitCode = failed ? 1 : 0
if (!process.argv.includes('--no-bites') && !failed) {
  const mutations = [
    { name: '(a) alter off purpose', file: 'worker/lib/metadata-extractor.ts', before: "purpose: 'choice_metadata',", after: "purpose: 'choice_metadata_changed',", expected: 'FAIL (a)' },
    { name: '(a) flip default', file: 'src/config/env.ts', before: "CHOICE_LEDGER_SPLIT: 'off'", after: "CHOICE_LEDGER_SPLIT: 'on'", expected: 'FAIL (a)' },
    { name: '(b) keep ledger schema on choices', file: 'worker/lib/metadata-extractor.ts', before: 'split ? CHOICES_ONLY_SCHEMA : CHOICE_META_SCHEMA', after: 'CHOICE_META_SCHEMA', expected: 'FAIL (b)' },
    { name: '(b) wrong ledger hedge accounting', file: 'worker/lib/metadata-extractor.ts', before: "lostPurpose: 'beat_ledger_hedge_lost'", after: "lostPurpose: 'choice_metadata_hedge_lost'", expected: 'FAIL (b)' },
    { name: '(b) keep ledger instruction in choices', file: 'worker/lib/metadata-extractor.ts', before: "split ? system.replace(ledgerRule + '\\n', '') : system", after: 'system', expected: 'FAIL (b)' },
    { name: '(c) discard ledger merge', file: 'worker/lib/metadata-extractor.ts', before: 'return ledgerPromise ? { ...choices, beat_ledger: await ledgerPromise } : choices', after: 'return choices', expected: 'FAIL (c)' },
    { name: '(d) ledger failure loses choices', file: 'worker/lib/metadata-extractor.ts', before: 'return WITNESS_FALLBACK.beat_ledger', after: 'return undefined', expected: 'FAIL (d) ledger' },
    { name: '(d) choices failure loses ledger', file: 'worker/lib/metadata-extractor.ts', before: 'return ledgerPromise ? { ...choices, beat_ledger: await ledgerPromise } : choices', after: "return ledgerPromise && choices.choices.length ? { ...choices, beat_ledger: await ledgerPromise } : choices", expected: 'FAIL (d) choices' },
    { name: 'choices timing lost in split', file: 'worker/lib/metadata-extractor.ts', before: "opts?.onStage?.('choice_metadata', Date.now() - startedAt)", after: "if (!split) opts?.onStage?.('choice_metadata', Date.now() - startedAt)", expected: 'FAIL parallel launch' },
    { name: '(e) dry-run opt-out', file: 'scripts/beat-ledger-split-ab.ts', before: 'let execute = false, turns = 30', after: 'let execute = true, turns = 30', expected: 'FAIL (e)' },
    { name: '(e) allow overspend', file: 'scripts/beat-ledger-split-ab.ts', before: 'this.reserved + amount > this.cap', after: 'false', expected: 'FAIL (e)' },
    { name: '(e) bypass transport reservation', file: 'scripts/beat-ledger-split-ab.ts', before: 'budget.reserve(reservation(params, price))', after: 'void params', expected: 'FAIL (e)' },
  ]
  const root = fileURLToPath(new URL('../', import.meta.url))
  const scratch = mkdtempSync(join(tmpdir(), 'beat-split-bites-'))
  try {
    for (const dir of ['src', 'worker', 'scripts']) cpSync(join(root, dir), join(scratch, dir), { recursive: true, filter: (path) => statSync(path).isDirectory() || path.endsWith('.ts') })
    cpSync(join(root, 'package.json'), join(scratch, 'package.json'))
    symlinkSync(join(root, 'node_modules'), join(scratch, 'node_modules'), 'dir')
    for (const mutation of mutations) {
      const path = join(scratch, mutation.file), original = readFileSync(path, 'utf8')
      assert.equal(original.split(mutation.before).length, 2, `one target: ${mutation.name}`)
      try {
        writeFileSync(path, original.replace(mutation.before, mutation.after))
        const child = spawnSync('bun', ['--no-env-file', 'scripts/beat-ledger-split-audit.ts', '--no-bites'], { cwd: scratch, encoding: 'utf8', timeout: 15000 })
        const output = child.stdout + child.stderr
        assert.equal(child.error, undefined)
        assert.notEqual(child.status, 0, `must reject ${mutation.name}`)
        assert.ok(output.includes(mutation.expected), `expected ${mutation.expected}: ${output}`)
        console.log(`BITE ${mutation.name}: exit ${child.status}; ${mutation.expected}`)
      } finally { writeFileSync(path, original) }
    }
  } finally { rmSync(scratch, { recursive: true, force: true }) }
  console.log(`${mutations.length}/${mutations.length} mutations rejected; source-only scratch removed`)
}
