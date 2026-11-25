/**
 * A replay frees the player once the new version is saved and refolds the
 * character cards under the same lock. Real lock transitions and the real
 * replay processor; scripted story service, fake Redis. No network, no database.
 *
 * bun --no-env-file run scripts/replay-tail-audit.ts [--bites]
 */
import assert from 'node:assert/strict'
import { mock } from 'bun:test'
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const locks = await import('../src/utils/generation-lock')
const { acquireGenerationTurn, finishGenerationTurn, generationLockKey, generationSlots, markGenerationStreamEnd,
  markReplayTail, pastReplayTail, refreshGenerationLock, releaseGenerationLock, waitForPriorGeneration } = locks

const key = generationLockKey('player', 'save')
class FakeRedis {
  rows = new Map<string, string>()
  frames: string[] = []
  async get(k: string) { return this.rows.get(k) ?? null }
  async publish(_channel: string, frame: string) { this.frames.push(JSON.parse(frame).type); return 1 }
  async eval(_script: string, _n: number, ...args: string[]) {
    const [k, outcomeKey, before, after, , outcome, channel, frame] = args
    if ((this.rows.get(k) ?? '') !== before) return 0
    if (channel) this.frames.push(JSON.parse(frame).type)
    if (outcome) this.rows.set(outcomeKey, outcome)
    if (after) this.rows.set(k, after); else this.rows.delete(k)
    return 1
  }
}
let redis = new FakeRedis()
// The lock module takes a Redis; this one answers the three calls it makes.
const r = () => redis as unknown as Parameters<typeof acquireGenerationTurn>[0]

let replayed = 0
let onReplay: (onSaved: (result: unknown) => Promise<void>) => Promise<void> = async () => {}
let live = true
mock.module('../src/config/redis', () => ({ getRedisClient: () => redis }))
mock.module('../src/utils/live-instance', () => ({ liveInstanceExists: async () => live }))
mock.module('../src/utils/mongo-id', () => ({ parseObjectId: (value: string) => value, idString: String }))
mock.module('../src/services/media/events', () => ({ wireSpokenLines: (lines: unknown) => lines ?? [] }))
mock.module('../src/utils/logger', () => ({ log: { info() {}, warn() {}, error() {} } }))
mock.module('../src/services/memory.service', () => ({
  memoryService: {
    replayEvent: async (_event: string, _player: string, _delta: unknown, onSaved: (result: unknown) => Promise<void>) => {
      replayed++
      await onReplay(onSaved)
    },
  },
}))
const { replayProcessor } = await import('../worker/processors/replay.processor')

const RESULT = { event: { data: { ai_response: 'New words.', choices: [{ label: 'Wait' }], present_characters: ['Mara'], replay_variants: [] } },
  selected_index: 1, instance_state: { current_scene: { tag: 'dialogue' } } }
const job = (data: Record<string, unknown> = {}) => ({
  id: 'R', data: { mode: 'replay', instanceId: 'save', playerId: 'player', eventId: 'event', ...data },
  discard() {}, async updateData() {},
}) as unknown as Parameters<typeof replayProcessor>[0]

let pass = 0
let fail = 0
async function check(label: string, fn: () => Promise<void>) {
  redis = new FakeRedis(); replayed = 0; live = true
  try { await fn(); pass++; console.log(`  ok   ${label}`) }
  catch (err) { fail++; console.log(`  FAIL ${label}\n       ${(err as Error).message}`) }
}
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 5))

await check('lock: nothing is admitted while a replay writes, the next line is once it is saved', async () => {
  assert.ok(await acquireGenerationTurn(r(), key, 'R', false))
  assert.equal(await acquireGenerationTurn(r(), key, 'N', true), null, 'mid-replay a line is refused as before')
  assert.equal(await markReplayTail(r(), key, 'R', 'c', JSON.stringify({ type: 'replay_complete' })), true)
  assert.deepEqual(redis.frames, ['replay_complete'])
  assert.deepEqual(await acquireGenerationTurn(r(), key, 'N', true), { priorTurnId: 'R' })
  assert.equal(await acquireGenerationTurn(r(), key, 'N2', true), null, 'one waiter only')
})
await check('lock: the next line starts only when the cards are done', async () => {
  await acquireGenerationTurn(r(), key, 'R', false)
  await markReplayTail(r(), key, 'R', 'c', JSON.stringify({ type: 'replay_complete' }))
  await acquireGenerationTurn(r(), key, 'N', true)
  let started = false
  const waiting = waitForPriorGeneration(r(), key, 'N', 'R').then(() => { started = true })
  await settle(); await settle()
  assert.equal(started, false)
  await finishGenerationTurn(r(), key, 'R', true)
  await waiting
  assert.equal(started, true)
  assert.equal(generationSlots(await redis.get(key))?.owner, 'N')
  assert.equal(generationSlots(await redis.get(key))?.kind, undefined, 'the promoted turn is an ordinary one')
})
await check('lock: the tail keeps its lease and a stranger cannot mark or drop it', async () => {
  await acquireGenerationTurn(r(), key, 'R', false)
  assert.equal(await markReplayTail(r(), key, 'other', 'c', '{}'), false)
  await markReplayTail(r(), key, 'R', 'c', JSON.stringify({ type: 'replay_complete' }))
  await refreshGenerationLock(r(), key, 'R')
  await releaseGenerationLock(r(), key, 'other')
  assert.deepEqual(generationSlots(await redis.get(key)), { owner: 'R', phase: 'tail', kind: 'replay' })
})
await check('lock: exclusive work waits out a replay tail, and only a replay tail', async () => {
  const attempt = () => acquireGenerationTurn(r(), key, 'X', false)
  await acquireGenerationTurn(r(), key, 'R', false)
  assert.equal(await pastReplayTail(r(), key, attempt, { sleep: async () => { throw new Error('waited on a replay still writing') } }), null)
  await markReplayTail(r(), key, 'R', 'c', JSON.stringify({ type: 'replay_complete' }))
  let sleeps = 0
  const won = await pastReplayTail(r(), key, attempt, {
    sleep: async () => { if (++sleeps === 3) await finishGenerationTurn(r(), key, 'R', true) },
  })
  assert.ok(won); assert.equal(sleeps, 3); assert.equal(await redis.get(key), 'X')
  await releaseGenerationLock(r(), key, 'X')
  await acquireGenerationTurn(r(), key, 'T', true)
  await markGenerationStreamEnd(r(), key, 'T', 'c', JSON.stringify({ type: 'generation_stream_end' }))
  assert.equal(await pastReplayTail(r(), key, attempt, { sleep: async () => { throw new Error('waited on a story turn') } }), null)
})
await check('lock: exclusive work gives way to a line already waiting, and to the clock', async () => {
  const attempt = () => acquireGenerationTurn(r(), key, 'X', false)
  await acquireGenerationTurn(r(), key, 'R', false)
  await markReplayTail(r(), key, 'R', 'c', JSON.stringify({ type: 'replay_complete' }))
  let clock = 0
  assert.equal(await pastReplayTail(r(), key, attempt, { timeoutMs: 300, now: () => clock, sleep: async (ms) => { clock += ms } }), null)
  assert.ok(clock >= 300 && clock < 600)
  await acquireGenerationTurn(r(), key, 'N', true)
  assert.equal(await pastReplayTail(r(), key, attempt, { sleep: async () => { throw new Error('waited behind a line') } }), null)
})

await check('processor: the player is freed at the save, the lock at the end of the cards', async () => {
  await acquireGenerationTurn(r(), key, 'R', false)
  const seen: string[] = []
  onReplay = async (onSaved) => {
    seen.push(`before ${redis.frames.join()} ${await redis.get(key)}`)
    await onSaved(RESULT)
    seen.push(`saved ${redis.frames.join()} ${generationSlots(await redis.get(key))?.phase}`)
    assert.deepEqual(await acquireGenerationTurn(r(), key, 'N', true), { priorTurnId: 'R' })
  }
  await replayProcessor(job())
  assert.deepEqual(seen, ['before  R', 'saved replay_complete tail'])
  assert.deepEqual(redis.frames, ['replay_complete', 'world_projection_updated'])
  assert.equal(redis.rows.get(`${key}:done:R`), 'saved')
  assert.equal(await waitForPriorGeneration(r(), key, 'N', 'R') >= 0, true)
})
await check('processor: a failure after the save shows no error and fails no next line', async () => {
  await acquireGenerationTurn(r(), key, 'R', false)
  onReplay = async (onSaved) => {
    await onSaved(RESULT)
    await acquireGenerationTurn(r(), key, 'N', true)
    throw new Error('cards down')
  }
  await replayProcessor(job())
  assert.deepEqual(redis.frames, ['replay_complete'])
  assert.equal(redis.rows.get(`${key}:done:R`), 'saved')
  assert.equal(generationSlots(await redis.get(key))?.owner, 'N')
})
await check('processor: a failure before the save is reported, thrown and released as before', async () => {
  await acquireGenerationTurn(r(), key, 'R', false)
  onReplay = async () => { throw new Error('matched the existing response') }
  await assert.rejects(replayProcessor(job()), /matched/)
  assert.deepEqual(redis.frames, ['error'])
  assert.equal(await redis.get(key), null)
})
await check('processor: a lost lease still shows the version', async () => {
  onReplay = async (onSaved) => { await onSaved(RESULT) }
  await replayProcessor(job())
  assert.deepEqual(redis.frames, ['replay_complete', 'world_projection_updated'])
})
await check('processor: a replay picked up again after its save writes no second version', async () => {
  await acquireGenerationTurn(r(), key, 'R', false)
  await markReplayTail(r(), key, 'R', 'c', JSON.stringify({ type: 'replay_complete' }))
  await acquireGenerationTurn(r(), key, 'N', true)
  await replayProcessor(job({ replaySaved: true }))
  assert.equal(replayed, 0)
  assert.equal(redis.rows.get(`${key}:done:R`), 'saved')
  const first = job()
  redis = new FakeRedis(); await acquireGenerationTurn(r(), key, 'R', false)
  onReplay = async (onSaved) => { await onSaved(RESULT) }
  await replayProcessor(first)
  assert.equal(first.data.replaySaved, true)
})

console.log(`\nreplay tail audit: ${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
if (process.argv.includes('--bites')) await runBites()

async function runBites() {
  const server = new URL('..', import.meta.url).pathname
  const root = await mkdtemp(join(import.meta.dir, '.replay-tail-bites-'))
  const lock = 'src/utils/generation-lock.ts', proc = 'worker/processors/replay.processor.ts'
  const mutations: Array<[name: string, check: string, file: string, from: string, to: string]> = [
    ['the tail is never opened', 'lock: nothing is admitted', lock, "phase: 'tail', kind: 'replay' }", "phase: 'running', kind: 'replay' }"],
    ['the announcement is not atomic with the tail', 'lock: nothing is admitted', lock, "'keep', '', '', channel, frame)) return true", "'keep')) return true"],
    ['a stranger may mark the tail', 'lock: the tail keeps', lock, 'if (before !== token) return false', 'if (!before) return false'],
    ['the tail has no kind', 'lock: exclusive work waits', lock, "phase: 'tail', kind: 'replay' }", "phase: 'tail' }"],
    ['exclusive work waits on any tail', 'lock: exclusive work waits', lock, "slots?.kind !== 'replay' || slots.phase", "!slots || slots.phase"],
    ['exclusive work waits on a running replay', 'lock: exclusive work waits', lock, "      if (slots?.kind !== 'replay' || slots.phase !== 'tail' || slots.next) return null", "      if (slots && (slots.kind !== 'replay' || slots.next)) return null"],
    ['exclusive work waits behind a line', 'lock: exclusive work gives way', lock, " || slots.next) return null\n    }", ') return null\n    }'],
    ['exclusive work never gives up', 'lock: exclusive work gives way', lock, 'if (now() >= deadline) return null', 'if (now() >= deadline + 100_000) return null'],
    ['the lock is dropped at the save', 'processor: the player is freed', proc, '      saved = true\n', '      saved = true\n      await finishGenerationTurn(redis, lockKey, token, true)\n'],
    ['the end is recorded as a failure', 'processor: the player is freed', proc, "    )\n    await finishGenerationTurn(redis, lockKey, token, true).catch(() => {})\n  } catch", "    )\n  } catch"],
    ['a late failure reaches the player', 'processor: a failure after the save', proc, 'if (saved) {', 'if (false as boolean) {'],
    ['a late failure fails the next line', 'processor: a failure after the save', proc, "error: (err as Error).message })\n      await finishGenerationTurn(redis, lockKey, token, true).catch(() => {})", 'error: (err as Error).message })'],
    ['an early failure is swallowed', 'processor: a failure before the save', proc, 'if (saved) {', 'if (!saved) {'],
    ['a lost lease hides the version', 'processor: a lost lease', proc, '        await redis.publish(channel, frame)\n', ''],
    ['a second pickup writes again', 'processor: a replay picked up again', proc, 'if (job.data.replaySaved) {', 'if (false as boolean) {'],
    ['the save is not remembered', 'processor: a replay picked up again', proc, '      job.data.replaySaved = true\n', ''],
  ]
  let bitten = 0
  try {
    await cp(join(server, 'src'), join(root, 'src'), { recursive: true })
    await cp(join(server, 'worker'), join(root, 'worker'), { recursive: true })
    await mkdir(join(root, 'scripts'))
    await cp(import.meta.path, join(root, 'scripts/replay-tail-audit.ts'))
    await symlink(join(server, 'node_modules'), join(root, 'node_modules'), 'dir')
    for (const [name, label, file, from, to] of mutations) {
      const path = join(root, file), text = await readFile(path, 'utf8')
      assert.ok(text.includes(from), `${name}: anchor missing`)
      await writeFile(path, text.replace(from, to))
      const child = Bun.spawn(['bun', '--no-env-file', 'run', 'scripts/replay-tail-audit.ts'], { cwd: root, stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' })
      const timer = setTimeout(() => child.kill(9), 20_000)
      const [out, code] = await Promise.all([new Response(child.stdout).text(), child.exited])
      clearTimeout(timer)
      await writeFile(path, text)
      const bit = code !== 0 && out.includes(`FAIL ${label}`)
      if (bit) bitten++
      console.log(`${bit ? 'BITE' : 'MISS'} ${name}: exit ${code}${bit ? '' : `\n${out}`}`)
    }
  } finally { await rm(root, { recursive: true, force: true }) }
  console.log(`replay tail bites: ${bitten}/${mutations.length}`)
  if (bitten !== mutations.length) process.exit(1)
}
