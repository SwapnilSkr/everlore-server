/** Pure fake-clock/transport audit. Every invariant has a failing mutant in /tmp;
 * the working tree is never tampered with. No env files, network or services. */
import assert from 'node:assert/strict'
import { mock } from 'bun:test'
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import ts from 'typescript'

const root = resolve(import.meta.dir, '..')
const routerPath = resolve(root, 'worker/lib/intent-router.ts')
const processorPath = resolve(root, 'worker/processors/generation.processor.ts')
const child = process.argv[2] === '--case'
const target = child ? process.argv[3] : undefined
const modulePath = child ? process.argv[4] : routerPath
const processor = readFileSync(child ? process.argv[5] : processorPath, 'utf8')
const config = { switch: 'on' as 'on' | 'off', model: 'deepseek/deepseek-v4.1-flash-1017', host: 'Relace' }
const defaults = { capable: true, enabled: true, mode: 'free_play' }
const env = { NSFW_SAME_TURN_ROUTER: 'on', NSFW_SAME_TURN_ROUTER_MODEL: config.model,
  NSFW_SAME_TURN_ROUTER_HOST: config.host, NSFW_SAME_TURN_ROUTER_NON_EN_WAIT_MS: 1200,
  NSFW_INTENT_DEFER_ENABLED: true,
  OPENROUTER_PREFERRED_P90_LATENCY_SECONDS: 3, CHEAP_RANK_MODEL: 'gpt-4o-mini' }
mock.module('../src/config/env', () => ({ env }))
mock.module('../src/config/mongo', () => ({ mongoColl: {} }))
globalThis.fetch = Object.assign(async () => { throw new Error('Network forbidden') }, { preconnect() {} })
const response = (sexual: boolean) => ({ provider: 'Relace', choices: [{ finish_reason: 'stop',
  message: { content: JSON.stringify({ sexual_intent: sexual }) } }], usage: { prompt_tokens: 100, completion_tokens: 8 } })
let sdkReply: unknown = response(true), sdkFailure = false
let sdkParams: Record<string, unknown> = {}, sdkOptions: Record<string, unknown> = {}
const sdk = { withOptions: () => sdk, chat: { completions: { create: async (params: Record<string, unknown>, options: Record<string, unknown>) => {
  sdkParams = params; sdkOptions = options
  if (sdkFailure) throw new Error('fixture HTTP failure')
  return sdkReply
} } } }
mock.module('../src/config/openai', () => ({ getOpenRouter: () => sdk, getOpenAI: () => { throw new Error('OpenAI forbidden') } }))
const router = await import(modulePath!) as typeof import('../worker/lib/intent-router')
const { scoreScene, contentIntentMessages, classifyBorderlineIntent } = await import('../worker/lib/nsfw-classifier')
const { runWithLLMUsage, runWithLLMTrace, snapshotLLMUsage, snapshotLLMTrace } = await import('../src/ai/usage')

function fixture(text = 'Hello.', options = defaults, on = true) {
  let time = 0, calls = 0
  let resolveCall!: (raw: unknown) => void, rejectCall!: (error: Error) => void
  let signal!: AbortSignal
  const pending = new Promise<unknown>((yes, no) => { resolveCall = yes; rejectCall = no })
  const turn = router.startIntentRouter({ ...options, text }, { config: { ...config, switch: on ? 'on' : 'off' },
    now: () => time, transport: (_params, s) => { calls++; signal = s; return pending } })
  return {
    turn, get calls() { return calls }, get signal() { return signal },
    async settle(raw: unknown, ms = 252) { time = ms; resolveCall(raw); await pending; await Promise.resolve() },
    async error() { time = 50; rejectCall(new Error('fixture failure')); await pending.catch(() => {}); await Promise.resolve() },
    advance(ms: number) { time = ms },
    decide(recentEvents: Parameters<typeof scoreScene>[1] = [], current = options) {
      return router.decideIntentRoute({ ...current, text, recentEvents, router: turn })
    },
  }
}
function oldDecision(text: string, recentEvents: Parameters<typeof scoreScene>[1], options = defaults) {
  let currentTurnScore = 0, sceneClassification: 'sfw' | 'nsfw' = 'sfw', borderlineForIntent = false
  if (options.capable && options.enabled) {
    if (options.mode === 'ardent') sceneClassification = 'nsfw'
    else {
      currentTurnScore = scoreScene(text, []).score
      sceneClassification = scoreScene(text, recentEvents).decision
      borderlineForIntent = currentTurnScore >= 1 && currentTurnScore <= 2
    }
  }
  return { currentTurnScore, sceneClassification, borderlineForIntent }
}
function sameOld(actual: ReturnType<typeof router.decideIntentRoute>, expected: ReturnType<typeof oldDecision>) {
  assert.deepEqual({ currentTurnScore: actual.currentTurnScore, sceneClassification: actual.sceneClassification,
    borderlineForIntent: actual.borderlineForIntent }, expected)
}
const cases: Record<string, () => void | Promise<void>> = {
  yes: async () => {
    const f = fixture('A clean escalation.'); assert.equal(f.calls, 1)
    await f.settle(response(true))
    const d = f.decide(); assert.equal(d.sceneClassification, 'nsfw'); assert.equal(d.routerSettled, true)
    assert.equal(d.trace.sexual, true); assert.equal(d.trace.ms, 252); assert.equal(d.trace.host, 'Relace')
  },
  no: async () => {
    const f = fixture('Hello.'); await f.settle(response(false))
    const d = f.decide(); assert.equal(d.sceneClassification, 'sfw'); assert.equal(d.routerSettled, true)
    assert.equal(d.trace.sexual, false); assert.equal(d.currentTurnScore, 0); assert.equal(d.borderlineForIntent, false)
    assert.equal(f.decide([{ scene_tag: 'intimate' }, { scene_tag: 'intimate' }]).sceneClassification, 'nsfw')
  },
  insult: async () => {
    const text = 'You are a dick.'
    assert.equal(scoreScene(text, []).decision, 'nsfw', 'fixture must exercise the anatomy insult false positive')
    const f = fixture(text); await f.settle(response(false))
    const d = f.decide(); assert.equal(d.sceneClassification, 'sfw'); assert.equal(d.currentTurnScore, 0)
  },
  late: async () => {
    const f = fixture('take me'); f.advance(100)
    const d = f.decide(); assert.equal(d.trace.fallback, 'late'); assert.equal(d.trace.ms, 100)
    assert.equal(f.signal.aborted, false, 'a late answer is kept, not aborted')
    sameOld(d, oldDecision('take me', [])); assert.equal(d.routerSettled, false)
    const waiting = f.turn.lateResult(1000)
    await f.settle(response(true), 200)
    assert.deepEqual(await waiting, { sexual: true, ms: 200 })
    assert.deepEqual(f.decide().trace, d.trace, 'a late answer cannot change the frozen route')
  },
  lateIntent: async () => {
    for (const [raw, expected] of [[response(true), true], [response(false), false]] as const) {
      const f = fixture('take me'); const d = f.decide()
      assert.equal(d.sceneClassification, 'sfw', 'the streaming turn keeps the lexicon route')
      const waiting = f.turn.lateResult(1000); await f.settle(raw, 700)
      const late = await waiting
      assert.equal(late?.sexual, expected); assert.equal(late?.ms, 700)
      const intent = router.resolveNsfwIntent({ onTimeSexual: false, lateSexual: late?.sexual,
        judgedIntent: false, currentTurnScore: d.currentTurnScore })
      assert.deepEqual(intent, expected
        ? { nsfwIntent: true, source: 'intent_judge' }
        : { nsfwIntent: false, source: undefined })
      if (!expected) continue
      const stored = { nsfw_intent: true, nsfw_intent_source: 'intent_judge' }
      assert.equal(scoreScene('', [stored]).decision, 'sfw', 'one positive is momentum alone, as before')
      assert.equal(scoreScene('', [stored, stored]).decision, 'nsfw', 'the stored intent routes the next turn')
    }
    // Error and malformed answers change nothing.
    for (const failure of ['error', 'malformed'] as const) {
      const f = fixture('take me'); f.decide()
      const waiting = f.turn.lateResult(1000)
      if (failure === 'error') await f.error(); else await f.settle({})
      assert.equal(await waiting, undefined)
    }
    // An answer past the processor's bound is not read at all.
    const bound = fixture('take me'); bound.decide()
    assert.equal(await bound.turn.lateResult(20), undefined)
    assert.deepEqual(router.resolveNsfwIntent({ onTimeSexual: false, judgedIntent: false, currentTurnScore: 2 }),
      { nsfwIntent: false, source: undefined })
  },
  nonEnglish: async () => {
    // Portuguese/Spanish: the router's own answer at 1,000 ms is held for and
    // routes this turn adult, where the English lexicon sees nothing.
    const native = 'Quero que me toques agora.'
    assert.equal(scoreScene(native, []).score, 0, 'the fallback lexicon cannot read native text')
    const f = fixture(native)
    const waiting = f.turn.waitSinceStart(1200)
    await f.settle(response(true), 1000)
    await waiting
    const d = f.decide(); assert.equal(d.trace.fallback, undefined); assert.equal(d.sceneClassification, 'nsfw')
    assert.equal(d.trace.sexual, true); assert.equal(d.trace.ms, 1000)
    // The same timing on an English turn adds no wait, so it falls back late.
    const english = fixture('Hello.'); english.advance(1000)
    const late = english.decide(); assert.equal(late.trace.fallback, 'late'); assert.equal(late.sceneClassification, 'sfw')
    // The budget counts from the router's start, not from the call.
    const spent = fixture('Olá.'); spent.advance(1500)
    const startedAt = Date.now(); await spent.turn.waitSinceStart(1200)
    assert.ok(Date.now() - startedAt < 300, 'an already-spent budget must not wait again')
    assert.equal(spent.decide().trace.fallback, 'late')
    // The processor holds routing only for a save whose effective language is
    // not English, and always on the shared budget.
    assert.match(processor, /const turnReplyLanguage = effectiveReplyLanguage\(session\.reply_language\)/)
    assert.match(processor, /if \(turnReplyLanguage\) await intentRouter\.waitSinceStart\(env\.NSFW_SAME_TURN_ROUTER_NON_EN_WAIT_MS\)/)
  },
  cancel: async () => {
    const f = fixture(); f.turn.cancel(); assert.equal(f.signal.aborted, true)
    assert.equal(await f.turn.lateResult(1000), undefined)
    await f.settle(response(true)); assert.equal(f.decide().trace.sexual, undefined)
  },
  error: async () => {
    const f = fixture('take me'); await f.error()
    const d = f.decide(); assert.equal(d.trace.fallback, 'error'); assert.equal(d.routerSettled, false)
    sameOld(d, oldDecision('take me', [])); assert.equal(d.borderlineForIntent, true)
    const sync = router.startIntentRouter({ ...defaults, text: '' }, { config,
      transport: () => { throw new Error('sync') } })
    assert.equal(sync.decide(defaults).fallback, 'error')
  },
  malformed: async () => {
    const invalid = [null, {}, { choices: [] }, ...['{"sexual_intent": "true"}', '{"sexual_intent": true, "extra": false}',
      '{"sexual_intent":true,"sexual_intent":false}', '```json\n{"sexual_intent":true}\n```', 'true', 'null', '{}', '{'].map(content =>
      ({ choices: [{ finish_reason: 'stop', message: { content } }] })),
      { choices: [{ finish_reason: 'length', message: { content: '{"sexual_intent":true}' } }] }]
    for (const raw of invalid) {
      const f = fixture('take me'); await f.settle(raw)
      const d = f.decide(); assert.equal(d.trace.fallback, 'malformed'); assert.equal(d.routerSettled, false)
      sameOld(d, oldDecision('take me', []))
    }
  },
  gates: async () => {
    for (const options of [{ ...defaults, capable: false }, { ...defaults, enabled: false }]) {
      const f = fixture('You are a dick.', options); assert.equal(f.calls, 0)
      assert.equal(f.decide().trace.fallback, 'gated'); sameOld(f.decide(), oldDecision('You are a dick.', [], options))
    }
    const f = fixture(); await f.settle(response(true))
    assert.equal(f.decide([], { ...defaults, enabled: false }).sceneClassification, 'sfw')
    const changed = fixture(); await changed.settle(response(true))
    assert.equal(router.decideIntentRoute({ ...defaults, text: 'changed', recentEvents: [], router: changed.turn }).trace.fallback, 'gated')
  },
  ardent: () => {
    const options = { ...defaults, mode: 'ardent' }, f = fixture('Hello.', options)
    assert.equal(f.calls, 0); assert.equal(f.decide().sceneClassification, 'nsfw')
    sameOld(f.decide(), oldDecision('Hello.', [], options))
  },
  off: () => {
    for (const text of ['', 'Hello.', 'take me', 'You are a dick.']) {
      for (const options of [defaults, { ...defaults, capable: false }, { ...defaults, enabled: false }, { ...defaults, mode: 'ardent' }]) {
        for (const events of [[], [{ scene_tag: 'intimate' }], [{ nsfw_intent: true, nsfw_intent_source: 'intent_judge' }, { type: 'intimate' }]]) {
          const f = fixture(text, options, false); assert.equal(f.calls, 0)
          assert.equal(f.decide(events).trace.fallback, 'off'); sameOld(f.decide(events), oldDecision(text, events, options))
        }
      }
    }
  },
  judge: async () => {
    for (const sexual of [true, false]) {
      const f = fixture('take me'); await f.settle(response(sexual)); assert.equal(f.decide().borderlineForIntent, false)
    }
    const late = fixture('take me'); assert.equal(late.decide().borderlineForIntent, true)
    const error = fixture('take me'); await error.error(); assert.equal(error.decide().borderlineForIntent, true)
    const malformed = fixture('take me'); await malformed.settle({}); assert.equal(malformed.decide().borderlineForIntent, true)
    assert.match(processor, /const judgedNsfwIntent = borderlineForIntent \? \(await classifyBorderlineIntent\(classifyText\)\)/)
    assert.match(processor, /const sameTurnNsfwIntent = routerSettled && sameTurnRouterTrace\.sexual === true/)
    assert.match(processor, /const \{ nsfwIntent, source: nsfwIntentSource \} = resolveNsfwIntent\(\{/)
    assert.match(processor, /onTimeSexual: sameTurnNsfwIntent, lateSexual: lateRouterIntent\?\.sexual,/)
    assert.match(processor, /nsfw_intent_router_source: 'same_turn_router'/)
    // One new positive carries exactly the existing judge's +2 weight.
    assert.equal(scoreScene('', [{ nsfw_intent: true, nsfw_intent_source: 'intent_judge' }]).score, 2)
  },
  request: async () => {
    await runWithLLMTrace({}, () => runWithLLMUsage(async () => {
      const f = router.startIntentRouter({ ...defaults, text: '  Hello.  ' })
      // Flush fake SDK/trace continuations, never a real timer.
      for (let i = 0; i < 12; i++) await Promise.resolve()
      assert.equal(f.decide(defaults).sexual, true)
      assert.equal(sdkParams.model, config.model); assert.equal(sdkParams.max_tokens, 16); assert.equal(sdkParams.temperature, 0)
      assert.deepEqual(sdkParams.reasoning, { enabled: false }); assert.deepEqual(sdkParams.response_format, { type: 'json_object' })
      const provider = sdkParams.provider as Record<string, unknown>
      assert.deepEqual(provider.order, ['Relace']); assert.deepEqual(provider.only, ['Relace']); assert.equal(provider.allow_fallbacks, false); assert.equal(provider.require_parameters, true)
      assert.equal(sdkOptions.maxRetries, 0); assert.equal(sdkOptions.timeout, 6000); assert(sdkOptions.signal instanceof AbortSignal)
      assert.deepEqual(sdkParams.messages, contentIntentMessages('Hello.'))
      const before = JSON.stringify(sdkParams.messages)
      assert.equal(await classifyBorderlineIntent('Hello.'), 'nsfw')
      assert.equal(JSON.stringify(sdkParams.messages), before, 'measured and legacy prompts are identical')
      assert(snapshotLLMUsage().some(c => c.purpose === 'content_intent_same_turn'))
      const trace = snapshotLLMTrace().find(c => c.call.purpose === 'content_intent_same_turn')
      assert.equal(trace?.call.provider, 'Relace'); assert.equal(trace?.call.finish_reason, 'stop')
    }))
  },
  telemetry: async () => {
    for (const failure of ['malformed', 'error'] as const) {
      await runWithLLMTrace({}, () => runWithLLMUsage(async () => {
        sdkReply = {}; sdkFailure = failure === 'error'
        const f = router.startIntentRouter({ ...defaults, text: 'take me' })
        for (let i = 0; i < 12; i++) await Promise.resolve()
        assert.equal(f.decide(defaults).fallback, failure)
        const trace = snapshotLLMTrace()[0]
        assert.equal(trace.call.status, 'error'); assert.equal(trace.call.purpose, 'content_intent_same_turn')
        assert.equal(snapshotLLMUsage()[0].purpose, 'content_intent_same_turn')
      }))
    }
    sdkFailure = false; sdkReply = response(true)
  },
  source: () => {
    const file = ts.createSourceFile('processor.ts', processor, ts.ScriptTarget.Latest, true)
    const narrator = processor.indexOf('const narration = await callLLMStreamWithFallback(')
    function visit(node: ts.Node) {
      if (ts.isAwaitExpression(node) && /intentRouter|IntentRouter|decideIntentRoute/.test(node.expression.getText(file))) {
        const awaited = node.expression.getText(file)
        if (/^intentRouter\.lateResult\(/.test(awaited)) {
          assert(node.getStart(file) > narrator, 'the late answer is read after the prose, never before the narrator')
        } else {
          assert.equal(awaited, 'intentRouter.waitSinceStart(env.NSFW_SAME_TURN_ROUTER_NON_EN_WAIT_MS)',
            'the only other router await is the bounded non-English route hold')
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(file)
    const start = processor.indexOf('const intentRouter = startIntentRouter(')
    const live = processor.indexOf('const liveCheckStartedAt')
    const prompt = processor.indexOf('const prompt = buildPrompt(')
    const languageWait = processor.indexOf('if (turnReplyLanguage) await intentRouter.waitSinceStart(env.NSFW_SAME_TURN_ROUTER_NON_EN_WAIT_MS)')
    const decision = processor.indexOf('} = decideIntentRoute(')
    assert(start > 0 && start < live && prompt < decision && decision < narrator)
    assert(languageWait > 0 && languageWait < decision, 'the non-English hold precedes the routing decision')
    assert(processor.indexOf('const turnReplyLanguage = effectiveReplyLanguage(session.reply_language)') < languageWait,
      'the hold uses the turn\'s own effective language, not a re-derived one')
    assert.match(processor, /const lateRouterIntent = sameTurnRouterTrace\.started && sameTurnRouterTrace\.fallback === 'late'/)
    assert.match(processor, /same_turn_router_late: \{ sexual: lateRouterIntent\.sexual, ms: lateRouterIntent\.ms \}/)
    assert.match(processor, /const LATE_ROUTER_INTENT_WAIT_MS = 3000/)
    assert(!/\bawait\b|Promise\.race|setTimeout|sleep|poll/.test(processor.slice(decision, narrator)))
    assert.match(processor, /proseOnly: true/); assert.match(processor, /temperature: narrationTemperature\(modelId\)/)
    assert.match(processor, /finally \{\s*intentRouter.cancel\(\)/)
    assert.match(processor, /same_turn_router: sameTurnRouterTrace/)
    assert.match(processor, /pickup_to_routing_ms: routingDecidedAt - jobStartedAt/)
  },
}
for (const [name, fn] of Object.entries(cases)) {
  if (target && name !== target) continue
  try { await fn(); console.log(`PASS ${name}`) }
  catch (error) { console.error(`FAIL ${name}: ${(error as Error).message}`); process.exit(1) }
}
if (child) process.exit(0)

const source = readFileSync(routerPath, 'utf8')
const scratch = mkdtempSync(join(tmpdir(), 'everlore-intent-audit-'))
const mutations: Array<[string, string, string, 'router' | 'processor']> = [
  ['yes', "trace.sexual ? 'nsfw'", "trace.sexual ? 'sfw'", 'router'],
  ['no', "scoreScene('', input.recentEvents).decision", "'sfw'", 'router'],
  ['insult', "scoreScene('', input.recentEvents).decision", 'scoreScene(input.text, input.recentEvents).decision', 'router'],
  ['late', "snapshot = { ...slot, started, ...(fallback ? { fallback } : {}) }",
    "snapshot = { ...slot, started, ...(fallback ? { fallback } : {}) }; if (started && !slot.settled) controller.abort()", 'router'],
  ['lateIntent', 'return { sexual: slot.sexual, ms: slot.ms }', 'return undefined', 'router'],
  ['lateIntent', "if (closed || !slot.settled || slot.error || typeof slot.sexual !== 'boolean') return undefined", 'if (closed) return undefined', 'router'],
  ['lateIntent', 'const routerSexual = input.onTimeSexual || input.lateSexual === true', 'const routerSexual = input.onTimeSexual', 'router'],
  ['nonEnglish', 'await waitUpTo(Math.max(0, budgetMs - (now() - began)))', 'await waitUpTo(budgetMs)', 'router'],
  ['nonEnglish', 'if (turnReplyLanguage) await intentRouter.waitSinceStart(', 'if (true) await intentRouter.waitSinceStart(', 'processor'],
  ['cancel', 'cancel(): void { closed = true; if (started && !slot.settled) controller.abort() }', 'cancel(): void { closed = true }', 'router'],
  ['error', "error instanceof MalformedIntent ? 'malformed' : 'error'", "'malformed'", 'router'],
  ['malformed', "choice?.finish_reason !== 'stop'", 'false', 'router'],
  ['gates', "input.capable && input.enabled && input.mode !== NSFW_MODE", 'input.mode !== NSFW_MODE', 'router'],
  ['ardent', "input.capable && input.enabled && input.mode !== NSFW_MODE", 'input.capable && input.enabled', 'router'],
  ['off', "config.switch === 'on' && eligible(input)", 'eligible(input)', 'router'],
  ['judge', 'let borderlineForIntent = false', 'let borderlineForIntent = true', 'router'],
  ['request', 'order: [host], only: [host], allow_fallbacks: false', 'order: [host], only: [host], allow_fallbacks: true', 'router'],
  ['telemetry', 'settleLLMTrace(trace, error, signal.aborted)', 'settleLLMTrace(trace)', 'router'],
  ['source', '} = decideIntentRoute({', '} = await decideIntentRoute({', 'processor'],
]
try {
  for (const [name, before, after, kind] of mutations) {
    let mutant = kind === 'router' ? source : processor
    assert(mutant.includes(before), `mutation anchor missing: ${name}`)
    mutant = mutant.replace(before, after)
    if (kind === 'router') mutant = mutant.replace(/from '([^']+)'/g, (_all, path: string) =>
      `from '${path.startsWith('.') ? resolve(root, 'worker/lib', path) : path}'`)
    const path = join(scratch, `${name}.ts`); writeFileSync(path, mutant)
    const result = spawnSync('bun', ['--no-env-file', 'run', import.meta.filename, '--case', name,
      kind === 'router' ? path : routerPath, kind === 'processor' ? path : processorPath], { cwd: root, encoding: 'utf8' })
    assert.equal(result.status, 1, `mutant survived ${name}: ${result.stdout}\n${result.stderr}`)
    assert.match(result.stderr, new RegExp(`FAIL ${name}:`), `mutant must fail its intended assertion: ${result.stderr}`)
    console.log(`BITE ${name}: mutant rejected (exit 1)`)
  }
} finally { rmSync(scratch, { recursive: true, force: true }) }
console.log(`ALL GREEN: ${Object.keys(cases).length} checks, ${mutations.length} bites; no network`)
