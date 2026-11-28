/** Pure audit for routing-fast: the two-host hedge, the answer cache, the
 *  Portuguese/Spanish act check, and the `draft` frame's silence. Every check
 *  has a failing mutant in a scratch copy; the working tree is never tampered
 *  with. No env files, no network, no services.
 *
 *   bun --no-env-file run scripts/routing-fast-audit.ts
 */
import assert from 'node:assert/strict'
import { mock } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const root = resolve(import.meta.dir, '..')
const repo = {
  router: resolve(root, 'worker/lib/intent-router.ts'),
  packs: resolve(root, 'src/utils/input-guard-languages.ts'),
  service: resolve(root, 'src/services/play-ws.service.ts'),
  env: resolve(root, 'src/config/env.ts'),
}

/** Optional `--flag value` overrides, used only by the bites below. */
function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`)
  return index > 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback
}
const child = process.argv.includes('--case')
const target = child ? arg('case', '') : undefined
const paths = {
  router: arg('router', repo.router),
  packs: arg('packs', repo.packs),
  service: arg('service', repo.service),
  env: arg('env', repo.env),
}

// The router reads three env values; the audits below pin all of them.
const env = {
  NSFW_SAME_TURN_ROUTER: 'on',
  NSFW_SAME_TURN_ROUTER_MODEL: 'deepseek/deepseek-v4.1-flash-1017',
  NSFW_SAME_TURN_ROUTER_HOST: 'Relace',
  NSFW_SAME_TURN_ROUTER_FALLBACK_HOSTS: ['InferenceNet'],
  NSFW_SAME_TURN_ROUTER_HEDGE_MS: 350,
  NSFW_SAME_TURN_ROUTER_NON_EN_WAIT_MS: 0,
  NSFW_INTENT_CACHE: 'on',
  NSFW_INTENT_DEFER_ENABLED: false,
  OPENROUTER_PREFERRED_P90_LATENCY_SECONDS: 3,
  CHEAP_RANK_MODEL: 'gpt-4o-mini',
}
mock.module('../src/config/env', () => ({ env }))
mock.module('../src/config/mongo', () => ({ mongoColl: {} }))
globalThis.fetch = Object.assign(async () => { throw new Error('Network forbidden') }, { preconnect() {} })
mock.module('../src/config/openai', () => ({
  getOpenRouter: () => { throw new Error('OpenRouter forbidden: the transport is stubbed') },
  getOpenAI: () => { throw new Error('OpenAI forbidden') },
}))

const router = await import(paths.router) as typeof import('../worker/lib/intent-router')
const { sexualActIn } = await import(paths.packs) as typeof import('../src/utils/input-guard-languages')
const { scoreScene } = await import('../worker/lib/nsfw-classifier')

const config = { switch: 'on' as const, model: 'm', host: 'Relace', fallbackHosts: ['InferenceNet'] }
const defaults = { capable: true, enabled: true, mode: 'free_play' }
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
const response = (sexual: boolean) => ({ provider: 'Relace', choices: [{ finish_reason: 'stop',
  message: { content: JSON.stringify({ sexual_intent: sexual }) } }], usage: { prompt_tokens: 100, completion_tokens: 8 } })

type Handler = (signal: AbortSignal) => Promise<unknown> | unknown
/** A transport that records which host each request was pinned to. A host with
 *  no handler never answers — it stays silent like a slow provider. */
function makeTransport(handlers: Record<string, Handler>) {
  const calls: string[] = []
  const signals: Record<string, AbortSignal> = {}
  const transport: import('../worker/lib/intent-router').IntentTransport = (params, signal) => {
    const host = String((params.provider as { only?: string[] }).only?.[0])
    calls.push(host)
    signals[host] = signal
    const handler = handlers[host]
    return handler ? Promise.resolve().then(() => handler(signal)) : new Promise(() => {})
  }
  return { transport, calls, signals }
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
  // (a) the primary answers first: one request, no hedge.
  hedgeOne: async () => {
    const t = makeTransport({ Relace: () => response(true) })
    const turn = router.startIntentRouter({ ...defaults, text: 'take me' }, { config, transport: t.transport, hedgeMs: 200 })
    await turn.wait(2000)
    const d = turn.decide(defaults)
    assert.equal(d.host, 'Relace'); assert.equal(d.sexual, true); assert.equal(d.hedged, false)
    assert.equal(d.settled, true); assert.deepEqual(t.calls, ['Relace'], 'exactly one request reaches the primary')
  },
  // (a) the primary is silent: the hedge reaches the other host, and the first
  // answer settles the slot with the primary cut off.
  hedgeSecond: async () => {
    const t = makeTransport({
      Relace: () => new Promise(() => {}),
      InferenceNet: async () => { await sleep(30); return response(false) },
    })
    const turn = router.startIntentRouter({ ...defaults, text: 'take me' }, { config, transport: t.transport, hedgeMs: 40 })
    await turn.wait(2000)
    const d = turn.decide(defaults)
    assert.equal(d.host, 'InferenceNet'); assert.equal(d.sexual, false); assert.equal(d.hedged, true)
    assert.deepEqual(t.calls, ['Relace', 'InferenceNet'])
    assert.equal(t.signals.Relace.aborted, true, 'the losing request is aborted')
  },
  // (a) the primary fails: the other host is asked at once.
  hedgeFirstFail: async () => {
    const t = makeTransport({
      Relace: async () => { throw new Error('fixture failure') },
      InferenceNet: async () => response(true),
    })
    const turn = router.startIntentRouter({ ...defaults, text: 'take me' }, { config, transport: t.transport, hedgeMs: 5000 })
    await turn.wait(2000)
    const d = turn.decide(defaults)
    assert.equal(d.host, 'InferenceNet'); assert.equal(d.sexual, true); assert.equal(d.hedged, true)
    assert.equal(d.error, undefined)
  },
  // (a) a third host is not a third attempt: two hosts, no more.
  hedgeTwoHosts: async () => {
    const extra = { ...config, fallbackHosts: ['InferenceNet', 'Reka'] }
    const t = makeTransport({
      Relace: async () => { throw new Error('fixture A') },
      InferenceNet: async () => { throw new Error('fixture B') },
      Reka: () => response(true),
    })
    const turn = router.startIntentRouter({ ...defaults, text: 'take me' }, { config: extra, transport: t.transport, hedgeMs: 5000 })
    await turn.wait(2000)
    const d = turn.decide(defaults)
    assert.equal(d.error, 'error'); assert.equal(d.sexual, undefined)
    assert.deepEqual(t.calls, ['Relace', 'InferenceNet'], 'the third host is never asked')
  },
  // (a) both fail: the slot settles `error`, never a guessed answer.
  hedgeBothFail: async () => {
    const t = makeTransport({
      Relace: async () => { throw new Error('fixture A') },
      InferenceNet: async () => { throw new Error('fixture B') },
    })
    const turn = router.startIntentRouter({ ...defaults, text: 'take me' }, { config, transport: t.transport, hedgeMs: 5000 })
    await turn.wait(2000)
    const d = turn.decide(defaults)
    assert.equal(d.settled, true); assert.equal(d.error, 'error'); assert.equal(d.sexual, undefined)
  },
  // (b) a precomputed answer settles at once and asks nobody.
  precomputed: () => {
    for (const sexual of [true, false]) {
      const t = makeTransport({})
      const turn = router.startIntentRouter({ ...defaults, text: 'tap', precomputed: sexual }, { config, transport: t.transport })
      const d = turn.decide(defaults)
      assert.equal(d.host, 'cache'); assert.equal(d.sexual, sexual); assert.equal(d.settled, true)
      assert.equal(d.ms, 0); assert.equal(t.calls.length, 0, 'the cache is not re-asked')
    }
  },
  // (c) the key is stable for one save and one text, and never carries the text.
  cacheKey: () => {
    const a = router.intentCacheKey('player', 'save', 'I take your hand.')
    assert.equal(a, router.intentCacheKey('player', 'save', 'I take your hand.'))
    assert.equal(a, router.intentCacheKey('player', 'save', '  I take your hand.  '), 'outer spaces are the same line')
    assert.notEqual(a, router.intentCacheKey('player', 'other-save', 'I take your hand.'))
    assert.notEqual(a, router.intentCacheKey('other-player', 'save', 'I take your hand.'))
    assert.equal(a.includes('take your hand'), false, 'the text must never appear in the key')
  },
  // (d) the pt/es act check reads an act, and only a live one.
  sexualAct: () => {
    assert.equal(sexualActIn('pt', 'Eu transei com minha irmã.'), true, 'Portuguese first person')
    assert.equal(sexualActIn('es', 'Follé con mi hermana.'), true, 'Spanish first person')
    assert.equal(sexualActIn('pt', 'beijo ela'), false, 'a kiss is not an act')
    assert.equal(sexualActIn('es', 'la beso'), false, 'a kiss is not an act')
    assert.equal(sexualActIn('pt', 'Conversamos sobre sexo com minha irmã.'), false, 'talking about it')
    assert.equal(sexualActIn('pt', 'Eu não transo com minhas primas.'), false, 'a denial')
    assert.equal(sexualActIn('en', 'I want you inside me.'), false, 'English is not this check')
    assert.equal(sexualActIn(undefined, 'Eu transei com ela.'), false, 'no language, no check')
    assert.equal(sexualActIn('pt', 'Tudo bem.'), false, 'ordinary speech')
  },
  // (e) routing with the router late: native act and momentum, English unchanged.
  routeLate: () => {
    const late = () => router.startIntentRouter({ ...defaults, text: 'x' }, { config,
      transport: () => new Promise(() => {}), hedgeMs: 5000 })
    const explicitPt = router.decideIntentRoute({ ...defaults, text: 'Eu transei com minha irmã.', recentEvents: [], language: 'pt', router: late() })
    assert.equal(explicitPt.sceneClassification, 'nsfw'); assert.equal(explicitPt.currentTurnScore, 3)
    assert.equal(explicitPt.borderlineForIntent, false)

    const momentum = [{ scene_tag: 'intimate' }, { scene_tag: 'intimate' }]
    const neutralPt = router.decideIntentRoute({ ...defaults, text: 'Tudo bem.', recentEvents: momentum, language: 'pt', router: late() })
    assert.equal(neutralPt.currentTurnScore, 0); assert.equal(neutralPt.sceneClassification, 'nsfw', 'momentum alone carries it')
    const quietPt = router.decideIntentRoute({ ...defaults, text: 'Tudo bem.', recentEvents: [], language: 'pt', router: late() })
    assert.equal(quietPt.sceneClassification, 'sfw')

    // English keeps today's code byte for byte: a late router falls back to the
    // same lexicon score and the same borderline band.
    for (const text of ['take me', 'You are a dick.', 'Hello.']) {
      const events: Parameters<typeof scoreScene>[1] = [{ scene_tag: 'intimate' }]
      const actual = router.decideIntentRoute({ ...defaults, text, recentEvents: events, language: 'en', router: late() })
      sameOld(actual, oldDecision(text, events))
    }
    const noLanguage = router.decideIntentRoute({ ...defaults, text: 'take me', recentEvents: [], router: late() })
    sameOld(noLanguage, oldDecision('take me', []))
  },
  // (f) the draft frame answers nothing and never logs the line.
  draftSource: () => {
    const source = readFileSync(paths.service, 'utf8')
    const start = source.indexOf("case 'draft': {")
    const end = source.indexOf("case 'ping': {", start)
    assert.ok(start > 0 && end > start, 'the draft case must sit before ping')
    const block = source.slice(start, end)
    assert.equal(/ws\.send/.test(block), false, 'a draft sends nothing on the socket')
    assert.equal(/\blog\.\w+\s*\(/.test(block), false, 'a draft never logs, so the text cannot leak')
    assert.match(block, /rateLimit\(user\.id, 'draft'\)/)
    assert.match(block, /intentCacheKey\(user\.id, instanceId, trimmed\), answer, 120\)/)
  },
  // (h) a draft is judged only where the turn's router would judge it: an
  // adult-capable solo save, a player with adult content on, outside the adult
  // mode. Every other draft returns before any model call is paid for.
  draftGate: () => {
    const source = readFileSync(paths.service, 'utf8')
    const block = source.slice(source.indexOf("case 'draft': {"), source.indexOf("case 'ping': {"))
    const judged = block.indexOf('judgeSexualIntent(')
    assert.ok(judged > 0, 'the draft case judges the line')
    for (const gate of [
      /instanceService\.loadSession\(instanceId, user\.id\)/,
      /session\.kind === 'group' \|\| !session\.is_nsfw_capable \|\| session\.mode === NSFW_MODE\) return/,
      /nsfw_enabled !== true\) return/,
    ]) {
      const at = block.search(gate)
      assert.ok(at > 0 && at < judged, `gate ${gate} must run before the judge`)
    }
  },
  // (i) a switched-off router asks nothing ahead of the turn either.
  judgeSwitchOff: async () => {
    const { transport, calls } = makeTransport({ Relace: () => response(true) })
    const answer = await router.judgeSexualIntent('anything', { transport, config: { ...config, switch: 'off' } })
    assert.equal(answer, undefined)
    assert.equal(calls.length, 0, 'no request when the router is off')
    const on = await router.judgeSexualIntent('anything', { transport, config })
    assert.equal(on, true)
  },
  // (g) the non-English wait starts at 0: the pt/es check now carries it.
  envDefault: () => {
    const source = readFileSync(paths.env, 'utf8')
    assert.match(source, /NSFW_SAME_TURN_ROUTER_NON_EN_WAIT_MS: '0'/, 'the default wait is 0')
    assert.match(source, /NSFW_SAME_TURN_ROUTER_HEDGE_MS: '350'/)
    assert.match(source, /NSFW_INTENT_CACHE: 'on'/)
  },
}

for (const [name, fn] of Object.entries(cases)) {
  if (target && name !== target) continue
  try { await fn(); console.log(`PASS ${name}`) }
  catch (error) { console.error(`FAIL ${name}: ${(error as Error).message}`); process.exit(1) }
}
if (child) process.exit(0)

// ── bites ─────────────────────────────────────────────────────────────────────

/** A copied file must resolve its relative imports against the real repo. */
function absolutize(text: string, dir: string): string {
  return text.replace(/from '([^']+)'/g, (_all, path: string) =>
    `from '${path.startsWith('.') ? resolve(dir, path) : path}'`)
}

type Bite = { case: string; file: keyof typeof repo; from: string; to: string }

const bites: Bite[] = [
  { case: 'hedgeOne', file: 'router', from: 'let hedged = false', to: 'let hedged = true' },
  { case: 'hedgeSecond', file: 'router', from: 'for (const controller of controllers) controller.abort()',
    to: 'for (const controller of controllers) void controller' },
  { case: 'hedgeFirstFail', file: 'router', from: 'if (next !== undefined) {\n          // An early failure',
    to: 'if (next === null) {\n          // An early failure' },
  { case: 'hedgeTwoHosts', file: 'router',
    from: '...(config.fallbackHosts ?? [])])].slice(0, 2)', to: '...(config.fallbackHosts ?? [])])]' },
  { case: 'hedgeBothFail', file: 'router',
    from: "settle({ error: failures.includes('malformed') ? 'malformed' : 'error', host })",
    to: 'settle({ sexual: true, host })' },
  { case: 'precomputed', file: 'router', from: 'if (typeof input.precomputed === \'boolean\') {', to: 'if (false) {' },
  { case: 'cacheKey', file: 'router', from: 'update(text.trim())', to: 'update(text)' },
  { case: 'sexualAct', file: 'packs', from: 'if (acts.some((match) => !denies(pack, tokens, match))) return true',
    to: 'if (acts.length > 0) return true' },
  { case: 'routeLate', file: 'router', from: "const momentum = scoreScene('', input.recentEvents).score",
    to: 'const momentum = 0' },
  { case: 'draftSource', file: 'service', from: "const rl = await rateLimit(user.id, 'draft')",
    to: "ws.send(JSON.stringify({ type: 'pong' }))\n        const rl = await rateLimit(user.id, 'draft')" },
  { case: 'draftGate', file: 'service', from: "if (player?.preferences?.nsfw_enabled !== true) return",
    to: "void player" },
  { case: 'judgeSwitchOff', file: 'router', from: "if (config.switch !== 'on') return undefined", to: '' },
  { case: 'envDefault', file: 'env', from: "NSFW_SAME_TURN_ROUTER_NON_EN_WAIT_MS: '0'",
    to: "NSFW_SAME_TURN_ROUTER_NON_EN_WAIT_MS: '1200'" },
]

const scratch = mkdtempSync(join(tmpdir(), 'everlore-routing-fast-'))
try {
  for (const bite of bites) {
    const original = readFileSync(repo[bite.file], 'utf8')
    assert.ok(original.includes(bite.from), `mutation anchor missing: ${bite.case}`)
    let mutant = original.replace(bite.from, bite.to)
    if (bite.file === 'router') mutant = absolutize(mutant, resolve(root, 'worker/lib'))
    if (bite.file === 'packs') mutant = absolutize(mutant, resolve(root, 'src/utils'))
    const path = join(scratch, `${bite.case}-${bite.file}.ts`)
    writeFileSync(path, mutant)
    const result = spawnSync('bun', ['--no-env-file', 'run', import.meta.filename, '--case', bite.case,
      '--router', bite.file === 'router' ? path : repo.router,
      '--packs', bite.file === 'packs' ? path : repo.packs,
      '--service', bite.file === 'service' ? path : repo.service,
      '--env', bite.file === 'env' ? path : repo.env], { cwd: root, encoding: 'utf8' })
    assert.equal(result.status, 1, `mutant survived ${bite.case}: ${result.stdout}\n${result.stderr}`)
    assert.match(result.stderr, new RegExp(`FAIL ${bite.case}:`), `mutant must fail its own check: ${result.stderr}`)
    console.log(`BITE ${bite.case}: mutant rejected (exit 1)`)
  }
} finally { rmSync(scratch, { recursive: true, force: true }) }
console.log(`ALL GREEN: ${Object.keys(cases).length} checks, ${bites.length} bites; no network`)
