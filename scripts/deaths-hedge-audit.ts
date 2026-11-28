/**
 * DEATHS-HEDGE: the deaths call gets one identical backup request when its
 * first answer is slow, so one stuck answer cannot hold the buttons and the
 * turn's state (a 10.7 s deaths call held the buttons 12.7 s on the test stack,
 * 2026-11-28).
 *
 * Covers (`hedgedCall`, fake calls, no network):
 *   (a) a fast answer: one request, no backup.
 *   (b) a stuck first answer: the backup goes out at `hedgeMs`, its answer wins,
 *       the stuck request is cancelled.
 *   (c) a first request that fails early: the backup goes out at once.
 *   (d) both fail: the last error is thrown, after exactly two requests.
 *   (e) `hedgeMs` 0: one request only, however slow.
 *   (f) never more than two requests.
 * And, read as text:
 *   (g) the deaths extractor sends its request through `hedgedCall` with the
 *       signal and `DEATHS_HEDGE_MS`, the default is 2500, and the processor
 *       logs `deaths_hedged`.
 *
 *   bun --no-env-file run scripts/deaths-hedge-audit.ts
 *   bun --no-env-file run scripts/deaths-hedge-audit.ts --bites
 */
import assert from 'node:assert/strict'
import { cp, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { hedgedCall } from '../worker/lib/hedged-call'

let pass = 0
let fail = 0
async function check(label: string, fn: () => Promise<void> | void) {
  try {
    await fn()
    pass++
    console.log(`  ok   ${label}`)
  } catch (error) {
    fail++
    console.log(`  FAIL ${label}`)
    console.log(`       ${(error as Error).message.split('\n').join('\n       ')}`)
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** A fake model call: each request takes its scripted time, then answers or fails. */
function script(steps: Array<{ ms: number; value?: string; error?: string }>) {
  const signals: AbortSignal[] = []
  const startedAt: number[] = []
  const t0 = Date.now()
  const call = (signal: AbortSignal) => {
    const step = steps[signals.length]
    signals.push(signal)
    startedAt.push(Date.now() - t0)
    if (!step) return Promise.reject(new Error('unscripted request'))
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => (step.error ? reject(new Error(step.error)) : resolve(step.value!)), step.ms)
      signal.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('aborted')) }, { once: true })
    })
  }
  return { call, signals, startedAt, t0 }
}

await check('(a) a fast answer makes one request and no backup', async () => {
  const s = script([{ ms: 20, value: 'first' }])
  let hedged = 0
  const value = await hedgedCall(s.call, { hedgeMs: 200, onHedge: () => hedged++ })
  await sleep(250)
  assert.equal(value, 'first')
  assert.equal(s.signals.length, 1, 'one request')
  assert.equal(hedged, 0, 'no backup')
})

await check('(b) a stuck first answer: the backup goes out at hedgeMs, wins, and the stuck request is cancelled', async () => {
  const s = script([{ ms: 3000, value: 'stuck' }, { ms: 30, value: 'backup' }])
  let hedged = 0
  const value = await hedgedCall(s.call, { hedgeMs: 100, onHedge: () => hedged++ })
  const took = Date.now() - s.t0
  assert.equal(value, 'backup')
  assert.ok(took < 400, `answered in ${took} ms, not after the stuck 3 s`)
  assert.ok(s.startedAt[1] >= 90 && s.startedAt[1] < 250, `backup sent at ${s.startedAt[1]} ms`)
  assert.equal(hedged, 1, 'onHedge fired once')
  assert.equal(s.signals[0].aborted, true, 'the stuck request was cancelled')
})

await check('(c) a first request that fails early sends the backup at once', async () => {
  const s = script([{ ms: 20, error: 'host error' }, { ms: 20, value: 'backup' }])
  const value = await hedgedCall(s.call, { hedgeMs: 1000 })
  const took = Date.now() - s.t0
  assert.equal(value, 'backup')
  assert.ok(took < 300, `answered in ${took} ms, not after the 1 s backup time`)
})

await check('(d) both fail: the last error is thrown after exactly two requests', async () => {
  const s = script([{ ms: 20, error: 'first error' }, { ms: 20, error: 'second error' }])
  await assert.rejects(hedgedCall(s.call, { hedgeMs: 1000 }), /second error/)
  assert.equal(s.signals.length, 2)
})

await check('(e) hedgeMs 0 makes one request only, however slow', async () => {
  const s = script([{ ms: 300, value: 'slow' }])
  let hedged = 0
  const value = await hedgedCall(s.call, { hedgeMs: 0, onHedge: () => hedged++ })
  assert.equal(value, 'slow')
  assert.equal(s.signals.length, 1)
  assert.equal(hedged, 0)
})

await check('(f) never more than two requests, even when both are slow', async () => {
  const s = script([{ ms: 400, value: 'first' }, { ms: 400, value: 'second' }])
  const value = await hedgedCall(s.call, { hedgeMs: 50 })
  await sleep(200)
  assert.equal(value, 'first')
  assert.equal(s.signals.length, 2)
})

await check('(g) the deaths extractor uses hedgedCall with the signal and DEATHS_HEDGE_MS; default 2500; the turn log records it', async () => {
  const extractor = await readFile(new URL('../worker/lib/character-lifecycle-extractor.ts', import.meta.url), 'utf8')
  assert.ok(extractor.includes("const raw = await hedgedCall((signal) => callLLM({\n      signal,\n      model: AI_MODELS.metadata,\n      purpose: 'character_deaths',"),
    'the deaths request must go through hedgedCall and pass its signal')
  assert.ok(extractor.includes('{ hedgeMs: params.hedgeMs ?? env.DEATHS_HEDGE_MS, onHedge: params.onHedge })'),
    'the backup time must come from DEATHS_HEDGE_MS')
  const env = await readFile(new URL('../src/config/env.ts', import.meta.url), 'utf8')
  assert.ok(env.includes("DEATHS_HEDGE_MS: '2500',"), 'default 2500 ms')
  const processor = await readFile(new URL('../worker/processors/generation.processor.ts', import.meta.url), 'utf8')
  assert.ok(processor.includes('onHedge: () => { deathsHedged = true },'), 'the processor must hear the backup')
  assert.ok(processor.includes('...(deathsHedged ? { deaths_hedged: true } : {}),'), 'the turn log must record it')
})

if (fail > 0) {
  console.log(`\ndeaths-hedge audit: ${pass} passed, ${fail} failed`)
  process.exit(1)
}
if (process.argv.includes('--bites')) await runBites()
else console.log(`\ndeaths-hedge audit: ${pass} passed, 0 failed`)

// ── bites ────────────────────────────────────────────────────────────────────
async function runBites() {
  const root = await mkdtemp(join(import.meta.dir, '.deaths-hedge-bites-'))
  const server = new URL('..', import.meta.url).pathname
  const helper = 'worker/lib/hedged-call.ts'
  const extractor = 'worker/lib/character-lifecycle-extractor.ts'
  const mutations: Array<{ name: string; check: string; file: string; from: string; to: string }> = [
    { name: 'no backup timer', check: '(b)', file: helper, from: 'if (maxRequests > 1) timer = setTimeout(launch, opts.hedgeMs)', to: 'if (false) timer = setTimeout(launch, opts.hedgeMs)' },
    { name: 'the stuck request is not cancelled', check: '(b)', file: helper, from: 'for (const other of controllers) if (other !== controller) other.abort()', to: 'void controllers' },
    { name: 'an early failure waits for the backup time', check: '(c)', file: helper, from: '            if (timer) clearTimeout(timer)\n            launch()', to: '            void 0' },
    { name: 'all failures resolve instead of throwing', check: '(d)', file: helper, from: 'reject(lastError)', to: 'resolve(undefined as T)' },
    { name: 'hedgeMs 0 still sends a backup', check: '(e)', file: helper, from: 'const maxRequests = opts.hedgeMs > 0 ? 2 : 1', to: 'const maxRequests = 2' },
    { name: 'the extractor drops the signal', check: '(g)', file: extractor, from: "callLLM({\n      signal,\n      model: AI_MODELS.metadata,", to: "callLLM({\n      model: AI_MODELS.metadata," },
  ]
  try {
    await cp(join(server, 'src'), join(root, 'src'), { recursive: true })
    await cp(join(server, 'worker'), join(root, 'worker'), { recursive: true })
    await cp(join(server, 'scripts', 'deaths-hedge-audit.ts'), join(root, 'scripts', 'deaths-hedge-audit.ts'))
    await symlink(join(server, 'node_modules'), join(root, 'node_modules'), 'dir')
    let bitten = 0
    for (const m of mutations) {
      const path = join(root, m.file)
      const original = await readFile(path, 'utf8')
      assert.ok(original.includes(m.from), `${m.name}: anchor missing`)
      await writeFile(path, original.split(m.from).join(m.to))
      try {
        const proc = Bun.spawn(['bun', '--no-env-file', 'run', join(root, 'scripts', 'deaths-hedge-audit.ts')], { cwd: root, stdout: 'pipe', stderr: 'pipe' })
        const out = (await new Response(proc.stdout).text()) + (await new Response(proc.stderr).text())
        const code = await proc.exited
        assert.notEqual(code, 0, `${m.name}: the audit accepted it\n${out}`)
        assert.ok(out.includes(`FAIL ${m.check}`), `${m.name}: failed outside ${m.check}\n${out}`)
        bitten++
        console.log(`BITE ${m.name}: exit ${code}; FAIL ${m.check}`)
      } finally {
        await writeFile(path, original)
      }
    }
    console.log(`deaths-hedge bites: ${bitten}/${mutations.length} mutations rejected; scratch removed`)
    if (bitten !== mutations.length) process.exit(1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}
