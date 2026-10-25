/** Measurement only. Use bun --no-env-file for free checks; --live may use Bun's
 * implicit credentials. Never reads secret files or loads app env/DB.
 * --self-test: free, no writes/network. --offline: fallback/snapshot lexicon only.
 * --live: 84 lines x 3 runs x 4 models, cumulatively capped at $0.10.
 * Optional --lexicon-json /absolute/path/to/non-secret-export.json (array of docs).
 * The report is also the append-before-send spend journal; keep it for resumes.
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { appendFile, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { mock } from 'bun:test'

const ROOT = resolve(import.meta.dir, '..')
const REPORT = resolve(ROOT, '../.agents/reports/intent-router-ab.md')
const API = 'https://openrouter.ai/api'
const CAP = 0.10
const DEADLINE = 650
const RUNS = 3
const OUTPUT = 16
const JEV_PRICE = 0.042 / 1e6
const CUTS = [0.3, 0.5, 0.7, 0.9, 0.95]
const MODELS = {
  mini: 'openai/gpt-4o-mini', jev: 'typesafe/jev-1.14',
  deepseek: 'deepseek/deepseek-v4.1-flash-1017', gemini: 'google/gemini-2.5-flash-lite',
} as const
type Arm = keyof typeof MODELS
type Obj = Record<string, unknown>
type Gold = { text: string; sexual: boolean }
type Lex = { term: string; weight: number; is_phrase: boolean }
type Message = { role: string; content: string }
type Prompt = { messages: Message[]; temperature: number; maxTokens: number; timeoutMs: number; responseFormat: Obj; model: string }
type Result = {
  arm: Arm; run: number; index: number; probability?: number; ms?: number;
  elapsed: number; error?: string; input?: number; output?: number; cost?: number;
  provider?: string; model?: string; generation?: string; reasoning?: number;
  finish?: string; nativeFinish?: string; requestVersion?: number;
}
type Usage = Pick<Result, 'input' | 'output' | 'cost' | 'reasoning'>
type Event =
  | { kind: 'config'; fingerprint: string; lexicon: string; goldHash: string; promptHash: string }
  | { kind: 'begin'; id: string; reserve: number; inputBound: number }
  | { kind: 'end'; id: string; result: Result }
  | { kind: 'settle'; id: string; usage: Usage & { cost: number }; source: 'generation' }
type Price = { input: number; output: number; request: number; tags: string[] }
const object = (v: unknown): Obj => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Obj : {}
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0
const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex')
function check(v: unknown, message: string): asserts v { if (!v) throw new Error(message) }
function rate(v: unknown): number {
  check(typeof v === 'string' && v.trim() !== '' || finite(v), 'Missing public price')
  const n = Number(v); check(finite(n), 'Invalid public price'); return n
}
function goldFrom(v: unknown): Gold[] {
  const items = object(v).items
  check(Array.isArray(items) && items.length === 84, 'Expected exactly 84 gold lines')
  const rows = items.map(v => {
    const r = object(v)
    check(typeof r.text === 'string' && r.text.length > 0 && r.text.length <= 600 && typeof r.sexual === 'boolean', 'Invalid gold line')
    return { text: r.text, sexual: r.sexual }
  })
  check(rows.filter(r => r.sexual).length === 40, 'Expected 40 sexual and 44 nonsexual lines')
  return rows
}
function lexFrom(v: unknown): Lex[] {
  check(Array.isArray(v) && v.length > 0, 'Lexicon export must be a nonempty JSON array')
  return v.map(v => {
    const r = object(v)
    check(typeof r.term === 'string' && r.term.length > 0 && finite(r.weight) && r.weight <= 100 && typeof r.is_phrase === 'boolean', 'Invalid lexicon document')
    return { term: r.term, weight: r.weight, is_phrase: r.is_phrase }
  }).filter(r => r.weight >= 1)
}

// Mock only I/O dependencies, then import the REAL scorer and capture the REAL
// classifier request. This avoids env validation, DB connections, flags, retries,
// and production telemetry writes while keeping its prompt byte-for-byte exact.
async function production(lexicon: Lex[]) {
  let captured: Prompt | undefined
  mock.module('../src/config/env', () => ({ env: { NSFW_INTENT_DEFER_ENABLED: true } }))
  mock.module('../src/config/mongo', () => ({ mongoColl: { nsfwLexicon: () => ({
    find: () => ({ toArray: async () => lexicon }),
  }) } }))
  mock.module('../src/ai', () => ({ AI_MODELS: { cheapRank: 'gpt-4o-mini' }, callLLM: async (p: Prompt) => {
    captured = p; return '{"sexual_intent":false}'
  } }))
  const real = await import('../worker/lib/nsfw-classifier')
  if (lexicon.length) await real.loadNsfwLexicon(true)
  await real.classifyBorderlineIntent('prompt capture')
  check(captured, 'Production classifier did not supply its prompt')
  check(captured.model === 'gpt-4o-mini' && captured.maxTokens === OUTPUT && captured.timeoutMs === 6000 && captured.temperature === 0, 'Production classifier request drifted')
  return { score: real.scoreScene, prompt: captured }
}
function request(arm: Arm, text: string, prompt: Prompt, price: Price): Obj {
  const system = prompt.messages.find(m => m.role === 'system')?.content
  check(system, 'Missing production system prompt')
  if (arm === 'jev') return {
    model: MODELS.jev, state: { turn: text.trim().slice(0, 600) },
    questions: { sexual_intent: { type: 'choice', instructions: system,
      criteria: { yes: 'The turn expresses unambiguous sexual intent.', no: 'The turn does not express unambiguous sexual intent, or the intent is uncertain.' } } },
  }
  return {
    model: MODELS[arm], messages: [{ role: 'system', content: system }, { role: 'user', content: text.trim().slice(0, 600) }],
    temperature: prompt.temperature, max_tokens: outputLimit(arm), response_format: arm === 'gemini' ? {
      type: 'json_schema', json_schema: { name: 'sexual_intent', strict: true, schema: {
        type: 'object', properties: { sexual_intent: { type: 'boolean' } }, required: ['sexual_intent'], additionalProperties: false,
      } },
    } : prompt.responseFormat,
    provider: { only: arm === 'deepseek' ? ['Relace'] : price.tags, allow_fallbacks: false, require_parameters: true },
    ...(arm === 'deepseek' ? { reasoning: { enabled: false } } : {}),
  }
}
function probability(arm: Arm, raw: unknown): number {
  const r = object(raw)
  if (arm === 'jev') {
    const a = object(object(r.answers).sexual_intent), p = object(a.probabilities)
    check(a.type === 'choice' && (a.choice === 'yes' || a.choice === 'no') && finite(p.yes) && p.yes <= 1 && finite(p.no) && p.no <= 1 && Math.abs(p.yes + p.no - 1) < 0.001, 'Malformed Jev decision')
    return p.yes
  }
  check(Array.isArray(r.choices) && r.choices.length === 1, 'Missing chat decision')
  const choice = object(r.choices[0]), message = object(choice.message)
  check(choice.finish_reason === 'stop' && typeof message.content === 'string', 'Incomplete chat decision')
  const parsed = object(JSON.parse(message.content))
  check(Object.keys(parsed).length === 1 && typeof parsed.sexual_intent === 'boolean', 'Malformed chat decision')
  return parsed.sexual_intent ? 1 : 0
}

class Budget {
  spent = 0
  seen = new Set<string>()
  pending = new Map<string, { reserve: number; inputBound: number }>()
  constructor(events: Event[] = [], private enforceBounds = true) {
    for (const e of events) {
      if (e.kind === 'begin') this.begin(e.id, e.reserve, e.inputBound)
      if (e.kind === 'end') this.end(e.id, e.result.cost)
      if (e.kind === 'settle') this.end(e.id, e.usage.cost)
    }
  }
  get held() { return [...this.pending.values()].reduce((n, p) => n + p.reserve, 0) }
  begin(id: string, reserve: number, inputBound: number) {
    check(!this.seen.has(id) && finite(reserve) && reserve > 0 && this.spent + this.held + reserve <= CAP, 'Spend cap would be exceeded')
    check(Number.isSafeInteger(inputBound) && inputBound > 0, 'Invalid token bound')
    this.pending.set(id, { reserve, inputBound })
    this.seen.add(id)
  }
  end(id: string, cost?: number) {
    const held = this.pending.get(id); check(held, 'Unreserved settlement')
    // Unknown charges keep their full reserve in the cumulative cap.
    if (cost === undefined) return
    check(finite(cost), 'Invalid real usage cost')
    this.spent += cost; this.pending.delete(id)
    if (this.enforceBounds) check(cost <= held.reserve && this.spent + this.held <= CAP, 'Provider exceeded reserved price/token bound; stop')
  }
}
const outputLimit = (arm: Arm) => arm === 'gemini' ? 64 : OUTPUT
function reserveFor(body: Obj, p: Price, arm: Arm) {
  // UTF-8 bytes bound text tokens; generous extra room covers server framing.
  // The API is still trusted to honor pricing and output bounds; breaches stop.
  const inputBound = Buffer.byteLength(JSON.stringify(body)) * 2 + 8192
  return { inputBound, reserve: inputBound * (arm === 'jev' ? JEV_PRICE : p.input) + (arm === 'jev' ? 0 : outputLimit(arm) * p.output) + p.request }
}
function usage(arm: Arm, raw: unknown): Usage {
  const u = object(object(raw).usage)
  const input = arm === 'jev' ? u.input_tokens : u.prompt_tokens
  const output = arm === 'jev' ? u.output_tokens : u.completion_tokens
  for (const v of [input, output]) check(v === undefined || finite(v) && Number.isInteger(v), 'Invalid real token usage')
  if (arm === 'jev') check(finite(input), 'Missing Jev input token usage')
  const cost = arm === 'jev' && finite(input) ? input * JEV_PRICE : u.cost
  check(finite(cost), 'Missing real cost usage')
  const reasoning = object(u.completion_tokens_details).reasoning_tokens
  return { ...(finite(input) ? { input } : {}), ...(finite(output) ? { output } : {}), cost, ...(finite(reasoning) ? { reasoning } : {}) }
}
// Called synchronously when building the narrator request; NEVER await a judge.
function route(fallback: boolean, decision: { probability?: number; ms?: number; error?: string } | undefined, cut: number, narratorAt = DEADLINE) {
  return decision && !decision.error && decision.ms !== undefined && decision.ms < Math.min(DEADLINE, narratorAt) && decision.probability !== undefined
    ? decision.probability >= cut : fallback
}
function quantile(xs: number[], q: number): number | null {
  return xs.length ? [...xs].sort((a, b) => a - b)[Math.max(0, Math.ceil(q * xs.length) - 1)] : null
}
type Observation = { run: number; index: number; predicted: boolean; ms?: number; error?: string; call?: boolean }
function metrics(rows: Observation[], gold: Gold[]) {
  let tp = 0, fp = 0, fn = 0, tn = 0
  const falsePositive: string[] = [], falseNegative: string[] = []
  for (const r of rows) {
    const expected = gold[r.index - 1].sexual
    if (r.predicted && expected) tp++
    else if (r.predicted) { fp++; falsePositive.push(`${r.index}/r${r.run}`) }
    else if (expected) { fn++; falseNegative.push(`${r.index}/r${r.run}`) }
    else tn++
  }
  const precision = tp + fp ? tp / (tp + fp) : 0, recall = tp + fn ? tp / (tp + fn) : 0
  const times = rows.flatMap(r => r.ms === undefined || r.error ? [] : [r.ms])
  const calls = rows.filter(r => r.call)
  return { n: rows.length, tp, fp, fn, tn, precision, recall, f1: precision + recall ? 2 * precision * recall / (precision + recall) : 0,
    p50: quantile(times, .5), p90: quantile(times, .9), errors: rows.filter(r => r.error).length,
    onTime: (calls.length ? calls : rows).length ? (calls.length ? calls : rows).filter(r => !r.error && r.ms !== undefined && r.ms < DEADLINE).length / (calls.length || rows.length) : null,
    falsePositive, falseNegative }
}
function arms(gold: Gold[], scores: number[], lexMs: number[][], results: Result[]) {
  const entries: Array<{ name: string; rows: Observation[] }> = []
  const make = (name: string, pick: (run: number, i: number) => Omit<Observation, 'run' | 'index'> | undefined) => {
    const rows: Observation[] = []
    for (let run = 1; run <= RUNS; run++) for (let i = 0; i < gold.length; i++) {
      const r = pick(run, i); if (r) rows.push({ ...r, run, index: i + 1 })
    }
    entries.push({ name, rows })
  }
  const found = (arm: Arm, run: number, i: number) => results.find(r => r.arm === arm && r.run === run && r.index === i + 1)
  make('a: lexicon / b: production same-turn route', (run, i) => ({ predicted: scores[i] >= 3, ms: lexMs[run - 1][i] }))
  make('b: lexicon + mini borderline (post-reply signal)', (run, i) => {
    if (!found('mini', run, i)) return undefined
    if (scores[i] === 0 || scores[i] >= 3) return { predicted: scores[i] >= 3, ms: lexMs[run - 1][i] }
    const r = found('mini', run, i)
    return r && { predicted: !r.error && r.probability === 1, ms: r.ms, error: r.error, call: true }
  })
  for (const arm of Object.keys(MODELS) as Arm[]) for (const cut of arm === 'jev' ? CUTS : [.5]) {
    make(`${arm} >= ${cut}`, (run, i) => {
      const r = found(arm, run, i)
      return r && { predicted: r.error ? scores[i] >= 3 : r.probability! >= cut, ms: r.ms, error: r.error, call: true }
    })
    make(`${arm} >= ${cut}, deadline/fallback`, (run, i) => {
      const r = found(arm, run, i)
      return r && { predicted: route(scores[i] >= 3, r, cut), ms: r.ms, error: r.error, call: true }
    })
    make(`g: lexicon strong OR ${arm} >= ${cut}`, (run, i) => {
      if (!found(arm, run, i)) return undefined
      if (scores[i] >= 3) return { predicted: true, ms: lexMs[run - 1][i] }
      const r = found(arm, run, i)
      return r && { predicted: !r.error && r.probability! >= cut, ms: r.ms, error: r.error, call: true }
    })
    make(`g: lexicon strong OR ${arm} >= ${cut}, deadline/fallback`, (run, i) => {
      const r = found(arm, run, i)
      if (!r) return undefined
      if (scores[i] >= 3) return { predicted: true, ms: lexMs[run - 1][i] }
      return { predicted: route(false, r, cut), ms: r.ms, error: r.error, call: true }
    })
  }
  return entries
}

const PREFIX = '<!-- intent-router-ab-journal '
function journalFrom(text: string): Event[] {
  return text.split('\n').filter(l => l.startsWith(PREFIX)).map(l => {
    check(l.endsWith(' -->'), 'Truncated journal: refuse live run')
    const e = object(JSON.parse(l.slice(PREFIX.length, -4)))
    if (e.kind === 'config') {
      check(typeof e.fingerprint === 'string' && typeof e.lexicon === 'string' && typeof e.goldHash === 'string' && typeof e.promptHash === 'string', 'Invalid journal config')
      return { kind: 'config', fingerprint: e.fingerprint, lexicon: e.lexicon, goldHash: e.goldHash, promptHash: e.promptHash }
    }
    check(typeof e.id === 'string' && /^(mini|jev|deepseek|gemini)\/[1-3]\/(?:[1-9]|[1-7][0-9]|8[0-4])$/.test(e.id), 'Invalid journal request id')
    if (e.kind === 'begin') {
      check(finite(e.reserve) && finite(e.inputBound), 'Invalid journal reserve')
      return { kind: 'begin', id: e.id, reserve: e.reserve, inputBound: e.inputBound }
    }
    if (e.kind === 'settle') {
      const u = object(e.usage)
      check(e.source === 'generation' && finite(u.cost), 'Invalid settlement')
      for (const k of ['input', 'output', 'reasoning']) check(u[k] === undefined || finite(u[k]) && Number.isInteger(u[k]), 'Invalid settled token usage')
      return { kind: 'settle', id: e.id, usage: u as Usage & { cost: number }, source: 'generation' }
    }
    check(e.kind === 'end', 'Invalid journal event')
    const r = object(e.result)
    check(typeof r.arm === 'string' && r.arm in MODELS && Number.isInteger(r.run) && Number.isInteger(r.index) && `${r.arm}/${r.run}/${r.index}` === e.id && finite(r.elapsed), 'Invalid journal result')
    check(r.probability === undefined || finite(r.probability) && r.probability <= 1, 'Invalid journal probability')
    for (const k of ['ms', 'input', 'output', 'cost', 'reasoning']) check(r[k] === undefined || finite(r[k]), 'Invalid journal usage/latency')
    for (const k of ['error', 'provider', 'model', 'generation', 'finish', 'nativeFinish']) check(r[k] === undefined || typeof r[k] === 'string', 'Invalid journal metadata')
    check(r.requestVersion === undefined || r.requestVersion === 2, 'Invalid request version')
    check(typeof r.error === 'string' || finite(r.probability) && finite(r.ms), 'Incomplete journal decision')
    return { kind: 'end', id: e.id, result: r as Result }
  })
}
async function record(events: Event[], e: Event) {
  // A durable reservation precedes every request. No key/request/error body is logged.
  await appendFile(REPORT, `${PREFIX}${JSON.stringify(e)} -->\n`, { flush: true })
  events.push(e)
}
async function prices(arm: Arm): Promise<Price> {
  const response = await fetch(`${API}/v1/models/${MODELS[arm]}/endpoints`, { signal: AbortSignal.timeout(10000) })
  check(response.ok, 'Public endpoint metadata unavailable')
  const all = object(object(await response.json()).data).endpoints
  check(Array.isArray(all), 'Missing endpoint list')
  const endpoints = all.map(object).filter(e => arm !== 'deepseek' || e.provider_name === 'Relace')
  check(endpoints.length > 0, 'Required model/provider unavailable')
  const ps = endpoints.map(e => object(e.pricing))
  // Include cache writes and price overrides in the reservation; no tools/media.
  const variants = ps.flatMap(p => [p, ...(Array.isArray(p.overrides) ? p.overrides.map(object) : [])])
  const input = Math.max(...variants.flatMap(p => [rate(p.prompt), rate(p.input_cache_read ?? 0), rate(p.input_cache_write ?? 0)]))
  const output = Math.max(...variants.map(p => rate(p.completion)))
  const request = Math.max(...variants.map(p => rate(p.request ?? 0)))
  if (arm === 'jev') check(Math.abs(input - JEV_PRICE) < 1e-15 && output === 0, 'Jev input pricing changed') // listed as 0.000000042; float division differs in the last bit
  return { input, output, request, tags: endpoints.map(e => { check(typeof e.tag === 'string', 'Missing endpoint tag'); return e.tag }) }
}
type Transport = (url: string, init: RequestInit) => Promise<Response>
async function generationUsage(id: string, send: Transport): Promise<Usage & { cost: number } | undefined> {
  try {
    const response = await send(`${API}/v1/generation?id=${encodeURIComponent(id)}`, {
      headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}` }, signal: AbortSignal.timeout(10000),
    })
    if (!response.ok) return undefined
    const d = object(object(await response.json()).data)
    check(d.id === id && finite(d.total_cost), 'Missing generation cost')
    check(typeof d.finish_reason === 'string' && d.finish_reason.length > 0 || d.cancelled === true, 'Generation not finalized')
    const u: Usage & { cost: number } = { cost: d.total_cost }
    for (const [key, value] of [['input', d.native_tokens_prompt], ['output', d.native_tokens_completion], ['reasoning', d.native_tokens_reasoning]] as const) {
      check(value == null || finite(value) && Number.isInteger(value), 'Invalid generation token usage')
      if (finite(value)) u[key] = value
    }
    return u
  } catch { return undefined }
}
async function reconcile(budget: Budget, events: Event[], send: Transport = fetch, persist = record) {
  for (const [id, held] of budget.pending) {
    const end = events.find(e => e.kind === 'end' && e.id === id)
    if (end?.kind !== 'end' || !end.result.generation) continue
    const u = await generationUsage(end.result.generation, send)
    if (!u) continue
    if (end.result.arm === 'jev') {
      if (u.input === undefined) continue
      u.cost = u.input * JEV_PRICE
    }
    await persist(events, { kind: 'settle', id, usage: u, source: 'generation' })
    budget.end(id, u.cost)
    check((u.input ?? 0) <= held.inputBound && (end.result.arm === 'jev' || (u.output ?? 0) <= (end.result.requestVersion === 2 ? outputLimit(end.result.arm) : OUTPUT)), 'Provider exceeded token bound; live run stopped')
  }
}
function resultsFrom(events: Event[]): Result[] {
  return events.flatMap(e => {
    if (e.kind !== 'end') return []
    const settled = events.find(s => s.kind === 'settle' && s.id === e.id)
    return [{ ...e.result, ...(settled?.kind === 'settle' ? settled.usage : {}) }]
  })
}
async function call(arm: Arm, run: number, index: number, text: string, prompt: Prompt, price: Price,
  budget: Budget, events: Event[], send: Transport = fetch, persist = record): Promise<Result> {
  const body = request(arm, text, prompt, price), reservation = reserveFor(body, price, arm)
  const id = `${arm}/${run}/${index}`
  budget.begin(id, reservation.reserve, reservation.inputBound)
  await persist(events, { kind: 'begin', id, ...reservation })
  const result: Result = { arm, run, index, elapsed: 0, requestVersion: 2 }
  const start = performance.now()
  try {
    const response = await send(`${API}/${arm === 'jev' ? 'alpha/decisions' : 'v1/chat/completions'}`, {
      method: 'POST', headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(prompt.timeoutMs),
    })
    if (!response.ok) result.error = `http_${response.status}`
    const raw: unknown = await response.json(), r = object(raw)
    try {
      Object.assign(result, usage(arm, raw))
      if ((result.input ?? 0) > reservation.inputBound || arm !== 'jev' && (result.output ?? 0) > outputLimit(arm)) result.error ??= 'token_bound_exceeded'
    }
    catch { /* A missing cost is reconciled independently of decision validity. */ }
    if (typeof r.id === 'string') result.generation = r.id
    if (typeof r.provider === 'string') result.provider = r.provider
    if (typeof r.model === 'string') result.model = r.model
    const choice = Array.isArray(r.choices) ? object(r.choices[0]) : {}
    if (typeof choice.finish_reason === 'string') result.finish = choice.finish_reason
    if (typeof choice.native_finish_reason === 'string') result.nativeFinish = choice.native_finish_reason
    if (!result.error) {
      try { result.probability = probability(arm, raw) }
      catch { result.error = result.finish === 'length' ? 'incomplete_decision' : 'invalid_decision' }
      if (!result.error) result.ms = performance.now() - start
      if (arm === 'deepseek' && (r.provider !== 'Relace' || (result.reasoning ?? 0) > 0)) result.error = 'provider_or_thinking_mismatch'
    }
  } catch (error) {
    result.error ??= error instanceof DOMException && error.name === 'TimeoutError' ? 'timeout' : 'transport_or_parse_error'
  }
  result.elapsed = performance.now() - start
  await persist(events, { kind: 'end', id, result })
  budget.end(id, result.cost)
  check(result.error !== 'token_bound_exceeded', 'Provider exceeded token bound; live run stopped')
  if (result.cost === undefined) await reconcile(budget, events, send, persist)
  return result
}

const percent = (n: number | null) => n === null ? '—' : `${(n * 100).toFixed(1)}%`
const millis = (n: number | null) => n === null ? '—' : n.toFixed(2)
async function report(status: string, gold: Gold[], scores: number[], lexMs: number[][], events: Event[]) {
  const results = resultsFrom(events)
  const budget = new Budget(events, false)
  const summaries = arms(gold, scores, lexMs, results).map(a => ({ ...a, m: metrics(a.rows, gold) }))
  const best = summaries.filter(a => a.rows.length === gold.length * RUNS && a.name.endsWith('deadline/fallback'))
    .sort((a, b) => b.m.f1 - a.m.f1 || b.m.precision - a.m.precision || b.m.recall - a.m.recall)[0]
  const failures = (values: string[]) => {
    const byIndex = new Map<string, string[]>()
    for (const v of values) { const [i, run] = v.split('/'); byIndex.set(i, [...byIndex.get(i) ?? [], run]) }
    return [...byIndex].map(([i, runs]) => `${i} (${runs.join('/')})`).join(', ') || 'none'
  }
  const config = events.find(e => e.kind === 'config')
  const lines = [
    '# intent-router-ab — measurement report', '', `Status: **${status}**. Updated ${new Date().toISOString()}.`, '',
    'Changed only `everlore-server/scripts/intent-router-ab.ts` and this report. No production code, prompts, data, DB writes, branches or commits.', '',
    `Lexicon: **${config?.kind === 'config' ? config.lexicon : 'unknown'}**. No momentum; imported production scoreScene with empty recentEvents. A frozen JSON export can be supplied with --lexicon-json; no DB connection is made.`, '',
    `Spend: **$${budget.spent.toFixed(9)} actual + $${budget.held.toFixed(9)} unresolved reserved**, cumulative cap $0.10 (about ₹8, using the brief's planning conversion ₹80/$). Actual spend approximately ₹${(budget.spent * 80).toFixed(4)}. Chat uses real response usage.cost or a free /generation lookup; Jev uses real input_tokens × $0.042/M. Reservations are appended and flushed before sending; unknown usage/interruption retains its full reserve in the cap while other calls may use the remaining budget. No paid retries.`, '',
    `Unresolved request IDs (never re-bought): ${[...budget.pending.keys()].join(', ') || 'none'}.`, '',
    '## Method', '',
    'All 84 owner-authored lines, 40 sexual/44 nonsexual, three runs each. Gold indices below are **1-based**, suffix /r1–/r3 identifies repetitions. Precision/recall/F1 pool all 252 decisions; run 1/2/3 F1 is also shown. Partial rows are explicitly marked by n. Missing model rows are unmeasured, never guessed. Errors use the current lexicon fallback for full-line/deadline arms; the production borderline signal falls back false.', '',
    'The exact content_intent system prompt and request options are captured from the imported production classifyBorderlineIntent with a mock transport. Chat uses temperature 0, no retries, 6 s measurement timeout. mini/DeepSeek use JSON object, max_tokens 16; DeepSeek is pinned only to Relace with reasoning disabled and provider fallback disabled. Revised Gemini requests use max_tokens 64, an exact boolean JSON schema and default Flash-Lite thinking (off); all parsers require stop and exactly one boolean sexual_intent key, rejecting fences, extra keys and incomplete replies. Jev uses the same intent definition as a typed yes/no choice and reports P(yes), not confidence. Only gold turn text is sent as model input state/user content.', '',
    `The first live run is preserved: ${results.filter(r => r.requestVersion === undefined).length} original attempts, including seven Gemini MAX_TOKENS failures (confirmed by free generation metadata) and gemini/1/53 HTTP 429 without recorded usage or a generation ID. That unknown charge remains reserved; it is not assumed free. ${results.filter(r => r.requestVersion === 2).length} attempts use the revised request. Original errors remain in every denominator; no completed call was re-bought. Gemini request settings therefore differ across these attempts.`, '',
    'Network calls are sequential, interleaved by a deterministic hash of run/index/arm. Repetitions are measured separately, with no excluded warmups. b and g reuse the corresponding all-line responses; they do not generate additional paid calls. b is the post-reply classification signal, **not the production same-turn route**, which equals a. Its table latency includes zero-network paths; raw mini timing is reported separately.', '',
    'Request latency starts immediately before fetch and stops after a validated decision is parsed. p50/p90 use nearest ranks among valid responses; errors have no parsed-decision latency and remain in the call denominator for <650 ms. Local scorer timing is measured over 3×84 calls. Deadline rows change routing outcomes only; their latency is still the underlying uncensored measurement. Timing for hybrids includes local strong-score paths and excludes network calls they would skip. The <650 ms share is over invoked network calls (over local evaluations for a). All shares use strict <650 ms. Partial arms do not have headline accuracy scores.', '',
    '| Detector | n/252 | Precision | Recall | F1 | F1 r1/r2/r3 | p50 ms | p90 ms | calls <650 ms | errors |',
    '|---|---:|---:|---:|---:|---|---:|---:|---:|---:|',
    ...summaries.map(a => `| ${a.name} | ${a.m.n}/252 | ${a.m.n === 252 ? percent(a.m.precision) : '—'} | ${a.m.n === 252 ? percent(a.m.recall) : '—'} | ${a.m.n === 252 ? percent(a.m.f1) : '—'} | ${[1, 2, 3].map(run => a.rows.filter(r => r.run === run).length === 84 ? percent(metrics(a.rows.filter(r => r.run === run), gold).f1) : '—').join(' / ')} | ${millis(a.m.p50)} | ${millis(a.m.p90)} | ${percent(a.m.onTime)} | ${a.m.errors} |`), '',
    '## Raw request latency by run', '',
    '| Model | Run | Requests /84 | Valid | p50 ms | p90 ms | calls <650 ms | Actual USD |',
    '|---|---:|---:|---:|---:|---:|---:|---:|',
    ...(Object.keys(MODELS) as Arm[]).flatMap(arm => [1, 2, 3].map(run => {
      const rs = results.filter(r => r.arm === arm && r.run === run), ms = rs.flatMap(r => !r.error && r.ms !== undefined ? [r.ms] : [])
      return `| ${MODELS[arm]} | ${run} | ${rs.length}/84 | ${ms.length} | ${millis(quantile(ms, .5))} | ${millis(quantile(ms, .9))} | ${rs.length ? percent(ms.filter(t => t < DEADLINE).length / rs.length) : '—'} | ${rs.reduce((n, r) => n + (r.cost ?? 0), 0).toFixed(9)} |`
    })), '',
    'Public API shape and pricing references: [Jev Decisions API and $0.042/M input](https://openrouter.ai/blog/insights/what-is-jev/); [current endpoint metadata](https://openrouter.ai/api/v1/models/typesafe/jev-1.14/endpoints). The live harness fetches every requested model’s endpoint prices before making paid calls; metadata requests are free and contain no gold text or credentials.', '',
    '## False positives and false negatives', '',
    ...summaries.map(a => a.rows.length ? `- **${a.name}** (n=${a.rows.length}): FP ${failures(a.m.falsePositive)}; FN ${failures(a.m.falseNegative)}.` : `- **${a.name}**: unmeasured.`), '',
    '## Recommendation and deadline rule', '',
    results.length === 1008 && best ? `Best measured deadline-adjusted F1: **${best.name}**, precision ${percent(best.m.precision)}, recall ${percent(best.m.recall)}, F1 ${percent(best.m.f1)}. This is the provisional detector/cut-off recommendation for a later wiring brief, selected by F1 then precision then recall. It is tuned on the same gold, without a held-out set; inspect false positives above before adoption. ${scores.some((s, i) => s >= 3 && !gold[i].sexual) ? 'The lexicon-strong hybrid cannot repair lexicon false positives, so compare its precision with model-authoritative routing.' : ''}` : '**No detector passes yet: live comparison is incomplete. Keep production routing unchanged.** Jev at P(yes) ≥0.5 is a candidate to test, not a validated recommendation.', '',
    'Proposed integration rule: start one detector at turn pickup, alongside existing preparation. Store a validated result in a per-turn settled slot only if it arrives strictly before 650 ms. At narrator request construction, synchronously inspect the slot; use it only if already settled and within the deadline. Otherwise immediately use today’s scoreScene decision, preserving opt-in/world gates, Ardent, scene momentum and the existing post-reply borderline behavior. Never await, race, sleep, or poll on the narrator path; never switch narrator after it starts. Timeout/error/malformed output uses that same fallback. A late positive never arms next-turn momentum via this new path.', '',
    '**Expected added detector waiting cost: 0 ms by construction.** This is not a measured production first-word delta: callback/CPU contention, network contention and any narrator-dependent first-token change remain unmeasured. A fixed 650 ms wait would violate this rule, especially on a turn whose preparation finishes earlier.', '',
    '## Limits, open questions and contracts', '',
    '- Context-free gold lines: no momentum, history, modes, world gates or opt-in behavior measured; one gold labeller. Some short lines are inherently ambiguous.',
    '- Mac network path, not ap-south-1. The supplied production prep p10/p50/p90 704/759/1167 ms is context, not paired timing data; no exact overlap/first-word effect can be inferred from those quantiles.',
    '- No production lexicon snapshot is available unless explicitly identified above; built-in fallback cannot certify today’s Mongo-backed precision/recall. No word list was added or edited.',
    '- Only the gold corpus is sent. TypeSafe AUP uncertainty is accepted by this brief, not independently resolved.',
    '- No external payload/DB contract changes here. A later wiring brief must specify turn-local deadline/settled state, cancellation, error fallback, result provenance and trace fields; narrator selection must stay behind current eligibility gates. The orchestrator should record any adopted routing decision in GLOSSARY.md; that file is outside this brief’s Paths.', '',
    '## Exact verification commands and results', '',
    'See the companion [fix report](intent-router-ab-fix-1.md) for exact commands, results and diagnosis.', '',
    'The HTML-comment journal in this file is retained for the cumulative cap and resume. Do not delete paid-call entries.', '',
  ]
  // Never rewrite a paid-call journal: an interrupted truncate/write could erase
  // spend and permit a second budget. Subsequent summaries are append-only.
  if (events.some(e => e.kind === 'begin')) await appendFile(REPORT, '\n' + lines.join('\n'), { flush: true })
  else await writeFile(REPORT, events.map(e => `${PREFIX}${JSON.stringify(e)} -->`).join('\n') + '\n\n' + lines.join('\n'), { flush: true })
}

async function selfTest() {
  const { score, prompt } = await production([])
  assert.deepEqual(score('undress', []), { score: 2, decision: 'sfw' })
  assert.deepEqual(score('undress orgasm', []), { score: 4, decision: 'nsfw' })
  assert.equal(score('undress', [{ scene_tag: 'romantic' }]).score, 2)
  assert.equal(score('', [{ nsfw_intent: true }]).score, 0)
  assert.equal(score('', [{ nsfw_intent: true, nsfw_intent_source: 'intent_judge' }]).score, 2)
  const m = metrics([{ run: 1, index: 1, predicted: true }, { run: 1, index: 2, predicted: false }, { run: 1, index: 3, predicted: true }], [{ text: '', sexual: true }, { text: '', sexual: true }, { text: '', sexual: false }])
  assert.equal(m.precision, .5); assert.equal(m.recall, .5); assert.equal(m.f1, .5)
  assert.deepEqual(m.falsePositive, ['3/r1']); assert.deepEqual(m.falseNegative, ['2/r1'])
  assert.equal(quantile([9, 1, 2], .5), 2); assert.equal(quantile([], .9), null)
  for (const fallback of [false, true]) {
    assert.equal(route(fallback, undefined, .5), fallback)
    assert.equal(route(fallback, { error: 'timeout', probability: 1, ms: 1 }, .5), fallback)
    assert.equal(route(fallback, { probability: 1, ms: 650 }, .5), fallback)
    assert.equal(route(fallback, { probability: 1, ms: 500 }, .5, 499), fallback)
    assert.equal(route(fallback, { probability: 1, ms: 649 }, .5), true)
    assert.equal(route(fallback, { probability: 0, ms: 1 }, .5), false)
  }
  const b = new Budget(); b.begin('a', .06, 10)
  assert.throws(() => b.begin('b', .05, 10), /cap/)
  b.end('a', .01); b.begin('b', .08, 10); b.end('b', undefined)
  assert.equal(b.held, .08); assert.throws(() => b.begin('c', .02, 10), /cap/)
  assert.throws(() => new Budget().begin('bad', NaN, 10))
  const over = new Budget(); over.begin('x', .001, 10); assert.throws(() => over.end('x', .002), /exceeded/)
  const exact = new Budget(); exact.begin('exact', CAP, 10); exact.end('exact', CAP)
  assert.throws(() => exact.begin('past', .000001, 10), /cap/)
  assert.throws(() => b.begin('a', .000001, 10), /cap/)
  assert.equal(probability('jev', { answers: { sexual_intent: { type: 'choice', choice: 'yes', probabilities: { yes: .7, no: .3 } } } }), .7)
  assert.throws(() => probability('jev', { answers: { sexual_intent: { type: 'choice', choice: 'yes', probabilities: { yes: 1.1, no: -.1 } } } }))
  assert.throws(() => probability('mini', { choices: [{ finish_reason: 'stop', message: { content: '{"sexual_intent":"false"}' } }] }))
  for (const content of ['```json\n{"sexual_intent":true}\n```', '{"sexual_intent":true,"extra":1}', 'true', 'null', '{"sexual_intent":']) {
    assert.throws(() => probability('gemini', { choices: [{ finish_reason: 'stop', message: { content } }] }))
  }
  assert.throws(() => probability('gemini', { choices: [{ finish_reason: 'length', message: { content: '{"sexual_intent":true}' } }] }), /Incomplete/)
  assert.equal(probability('gemini', { choices: [{ finish_reason: 'stop', message: { content: '{"sexual_intent":false}' } }] }), 0)
  assert.deepEqual(usage('jev', { usage: { input_tokens: 100 } }), { input: 100, cost: 100 * JEV_PRICE })
  assert.deepEqual(usage('mini', { usage: { cost: .00001 } }), { cost: .00001 })
  assert.throws(() => usage('jev', { usage: { cost: 0 } }), /Missing Jev/)
  const price: Price = { input: .15 / 1e6, output: .6 / 1e6, request: 0, tags: ['test'] }
  const deep = request('deepseek', 'gold', prompt, price)
  assert.deepEqual(deep.reasoning, { enabled: false })
  assert.deepEqual(deep.provider, { only: ['Relace'], allow_fallbacks: false, require_parameters: true })
  assert.equal(object((deep.messages as Message[])[0]).content, prompt.messages[0].content)
  const gemini = request('gemini', 'gold', prompt, price)
  assert.equal(gemini.max_tokens, 64); assert.equal(gemini.reasoning, undefined)
  assert.equal(object(gemini.response_format).type, 'json_schema')
  assert.deepEqual(object(object(gemini.response_format).json_schema).schema, {
    type: 'object', properties: { sexual_intent: { type: 'boolean' } }, required: ['sexual_intent'], additionalProperties: false,
  })
  assert.equal(reserveFor(gemini, price, 'gemini').reserve, reserveFor(gemini, price, 'mini').reserve + 48 * price.output)
  const events: Event[] = [], budget = new Budget()
  const persist = async (events: Event[], e: Event) => { events.push(e) }
  const response = (content: string) => new Response(JSON.stringify({ model: MODELS.mini, provider: 'fixture', choices: [{ finish_reason: 'stop', message: { content } }], usage: { prompt_tokens: 100, completion_tokens: 8, cost: .00002 } }))
  const r = await call('mini', 1, 1, 'fixture', prompt, price, budget, events, async () => { assert.equal(events[0].kind, 'begin'); return response('{"sexual_intent":true}') }, persist)
  assert.equal(r.probability, 1); assert.equal(budget.spent, .00002)
  assert.equal(new Budget(journalFrom(events.map(e => `${PREFIX}${JSON.stringify(e)} -->`).join('\n'))).spent, .00002)
  const malformed = await call('mini', 1, 2, 'fixture', prompt, price, budget, events, async () => response('{}'), persist)
  assert(malformed.error); assert.equal(budget.spent, .00004)
  const missing = await call('mini', 1, 3, 'fixture', prompt, price, budget, events, async () => new Response('{}'), persist)
  assert(missing.error); assert(budget.held > 0)
  const resumed = new Budget(journalFrom(events.map(e => `${PREFIX}${JSON.stringify(e)} -->`).join('\n')))
  assert.equal(resumed.held, budget.held); assert.equal(resumed.spent, budget.spent)
  const timeout = await call('mini', 1, 4, 'fixture', prompt, price, budget, events, async () => { throw new DOMException('fixture', 'TimeoutError') }, persist)
  assert.equal(timeout.error, 'timeout'); assert.equal(route(true, timeout, .5), true)
  const jr = await call('jev', 1, 5, 'fixture', prompt, { ...price, input: JEV_PRICE, output: 0 }, budget, events, async (url, init) => {
    assert(url.endsWith('/alpha/decisions'))
    assert.equal(object(JSON.parse(String(init.body))).model, MODELS.jev)
    return new Response(JSON.stringify({ answers: { sexual_intent: { type: 'choice', choice: 'yes', probabilities: { yes: .7, no: .3 }, confidence: .99 } }, usage: { input_tokens: 100, output_tokens: 99, cost: 999 } }))
  }, persist)
  assert.equal(jr.probability, .7); assert.equal(jr.cost, 100 * JEV_PRICE)
  const recoveredEvents: Event[] = [], recoveredBudget = new Budget()
  const completed = await call('gemini', 1, 1, 'fixture', prompt, price, recoveredBudget, recoveredEvents, async (url) => {
    if (url.includes('/generation?')) {
      assert.equal(recoveredEvents.at(-1)?.kind, 'end') // generation ID is durable before lookup
      return new Response(JSON.stringify({ data: { id: 'gen-fixture', finish_reason: 'stop', native_tokens_prompt: 100, native_tokens_completion: 20, total_cost: .00003 } }))
    }
    return new Response(JSON.stringify({ id: 'gen-fixture', choices: [{ finish_reason: 'stop', message: { content: '{"sexual_intent":true}' } }] }))
  }, persist)
  assert.equal(completed.probability, 1); assert.equal(completed.error, undefined)
  assert.equal(recoveredBudget.held, 0); assert.equal(recoveredBudget.spent, .00003)
  assert.equal(resultsFrom(recoveredEvents)[0].cost, .00003)
  const recoveredJournal = journalFrom(recoveredEvents.map(e => `${PREFIX}${JSON.stringify(e)} -->`).join('\n'))
  assert.equal(new Budget(recoveredJournal).spent, .00003)
  assert.throws(() => new Budget([...recoveredJournal, recoveredJournal.at(-1)!]), /Unreserved/)
  assert.equal(await generationUsage('gen-fixture', async () => new Response(JSON.stringify({ data: { id: 'wrong', total_cost: 0 } }))), undefined)
  assert.equal(await generationUsage('gen-fixture', async () => new Response(JSON.stringify({ data: { id: 'gen-fixture', finish_reason: null, total_cost: 0 } }))), undefined)
  assert.equal(await generationUsage('gen-fixture', async () => new Response('{}', { status: 404 })), undefined)
  const originalEvents: Event[] = [
    { kind: 'begin', id: 'gemini/1/53', inputBound: 9834, reserve: .0017816400000000001 },
    { kind: 'end', id: 'gemini/1/53', result: { arm: 'gemini', run: 1, index: 53, elapsed: 535.5967909999999, error: 'http_429' } },
  ]
  const original = new Budget(originalEvents)
  await reconcile(original, originalEvents, async () => { assert.fail('No generation ID; must not guess cost or send request') }, persist)
  assert.equal(original.held, .0017816400000000001); assert.equal(original.spent, 0)
  assert.throws(() => original.begin('gemini/1/53', .00001, 10), /cap/)
  original.begin('mini/1/1', .09, 10); original.end('mini/1/1', .09)
  assert.throws(() => original.begin('mini/1/2', .009, 10), /cap/) // retained 429 reserve bites
  const truncated = await call('gemini', 1, 2, 'fixture', prompt, price, recoveredBudget, recoveredEvents, async () => new Response(JSON.stringify({ choices: [{ finish_reason: 'length', message: { content: '{"sexual_intent":true}' } }], usage: { prompt_tokens: 100, completion_tokens: 4, cost: .00001 } })), persist)
  assert.equal(truncated.error, 'incomplete_decision'); assert.equal(truncated.ms, undefined)
  assert.equal(recoveredBudget.spent, .00004); assert.equal(recoveredBudget.held, 0)
  const gold = goldFrom(JSON.parse(await readFile(resolve(ROOT, 'corpus/intent-gold.json'), 'utf8')))
  const scores = gold.map(r => score(r.text, []).score), times = Array.from({ length: RUNS }, () => gold.map(() => .01))
  const synthetic: Result[] = []
  for (let run = 1; run <= RUNS; run++) for (const arm of Object.keys(MODELS) as Arm[]) for (const [i, row] of gold.entries()) {
    synthetic.push({ arm, run, index: i + 1, probability: arm === 'jev' ? row.sexual ? .8 : .2 : Number(row.sexual), ms: 1000, elapsed: 1000 })
  }
  const derived = arms(gold, scores, times, synthetic)
  assert.equal(synthetic.length, 1008); assert(derived.every(a => a.rows.length === 252))
  const rawMini = derived.find(a => a.name === 'mini >= 0.5')!
  assert.equal(metrics(rawMini.rows, gold).f1, 1)
  assert.equal(metrics(rawMini.rows, gold).onTime, 0)
  const late = derived.find(a => a.name === 'mini >= 0.5, deadline/fallback')!
  assert.deepEqual(late.rows.map(r => r.predicted), derived[0].rows.map(r => r.predicted))
  assert.equal(metrics(derived.find(a => a.name === 'jev >= 0.9')!.rows, gold).recall, 0)
  assert(arms(gold, scores, times, []).slice(1).every(a => a.rows.length === 0))
  assert.throws(() => journalFrom(`${PREFIX}{`), /Truncated/)
  console.log('PASS: imported scorer/metrics, deadline/error fallback, cap bites including retained 429 reserve, durable resume/no duplicate settlement, inline/generation/Jev input-only usage, strict Gemini schema/64-token reservation/truncation rejection, exact prompt, Relace/thinking-off, typed probabilities, 1008 synthetic decisions across all arms/3 runs. No network or writes; $0.')
}

async function main() {
  const args = process.argv.slice(2)
  if (args.length === 1 && args[0] === '--self-test') return selfTest()
  check(args[0] === '--offline' || args[0] === '--live', 'Usage: bun --no-env-file run scripts/intent-router-ab.ts --self-test | --offline | --live [--lexicon-json PATH]')
  check(args.length === 1 || args.length === 3 && args[1] === '--lexicon-json', 'Unknown arguments')
  let lexicon: Lex[] = []
  if (args[2]) {
    check(args[2].endsWith('.json'), 'Lexicon must be a non-secret JSON export')
    lexicon = lexFrom(JSON.parse(await readFile(resolve(args[2]), 'utf8')))
    check(lexicon.length > 0, 'Lexicon export has no routable terms')
  }
  const gold = goldFrom(JSON.parse(await readFile(resolve(ROOT, 'corpus/intent-gold.json'), 'utf8')))
  const { score, prompt } = await production(lexicon)
  const scores: number[] = [], lexMs: number[][] = []
  for (let run = 0; run < RUNS; run++) {
    const times: number[] = []
    for (const [i, row] of gold.entries()) {
      const start = performance.now(), result = score(row.text, [])
      times.push(performance.now() - start)
      if (run === 0) scores[i] = result.score
    }
    lexMs.push(times)
  }
  let previous = ''
  try { previous = await readFile(REPORT, 'utf8') } catch (error) { check(object(error).code === 'ENOENT', 'Cannot read spend journal') }
  const events = journalFrom(previous)
  const config: Extract<Event, { kind: 'config' }> = { kind: 'config', fingerprint: hash({ gold, lexicon, prompt, MODELS, CUTS, version: 1 }),
    lexicon: lexicon.length ? `frozen JSON export, ${lexicon.length} routable terms, SHA256 ${hash(lexicon)}` : 'built-in production fallback ONLY; Mongo lexicon unavailable', goldHash: hash(gold), promptHash: hash(prompt) }
  let oldConfig = events.find(e => e.kind === 'config')
  if (oldConfig?.kind === 'config' && oldConfig.fingerprint !== config.fingerprint && !events.some(e => e.kind !== 'config')) {
    events.length = 0; oldConfig = undefined
    await writeFile(REPORT, '', { flush: true })
  }
  check(!oldConfig || oldConfig.kind === 'config' && oldConfig.fingerprint === config.fingerprint, 'Experiment changed: preserve existing spend/report; use a new brief for a new experiment')
  if (!oldConfig) await record(events, config)
  let status = 'OFFLINE ONLY — live detectors unmeasured'
  try {
    if (args[0] === '--live') {
      check(process.env.OPENROUTER_API_KEY, 'BLOCKED: OPENROUTER_API_KEY absent from process environment; no .env/secret file will be read')
      const budget = new Budget(events)
      await reconcile(budget, events)
      const pricing = {} as Record<Arm, Price>
      for (const arm of Object.keys(MODELS) as Arm[]) pricing[arm] = await prices(arm)
      for (let run = 1; run <= RUNS; run++) {
        const jobs = gold.flatMap((_, i) => (Object.keys(MODELS) as Arm[]).map(arm => ({ arm, index: i + 1 })))
          .sort((a, b) => hash({ run, ...a }).localeCompare(hash({ run, ...b })))
        for (const { arm, index } of jobs) {
          if (budget.seen.has(`${arm}/${run}/${index}`)) continue
          const result = await call(arm, run, index, gold[index - 1].text, prompt, pricing[arm], budget, events)
          console.log(JSON.stringify({ arm, run, index, ms: result.ms, error: result.error, finish: result.finish, spent: budget.spent, held: budget.held }))
        }
      }
      status = resultsFrom(events).length === 1008 ? 'LIVE COMPLETE — review deadline-adjusted quality before any production wiring' : 'LIVE STOPPED — interrupted attempts retain reserves; no paid retries'
    }
  } catch (error) {
    status = error instanceof Error ? error.message : 'Live run stopped'
    process.exitCode = 1
  }
  await report(status, gold, scores, lexMs, events)
  console.log(`${status}; report ${REPORT}`)
}
if (import.meta.main) main().catch(() => { console.error('Harness failed before experiment; no secret/error bodies logged. Check arguments, gold, snapshot and report journal.'); process.exitCode = 1 })
