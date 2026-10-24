/**
 * EVERY PER-TURN FRAME CARRIES ITS jobId.
 *
 * With fast replies (CHAT_LATENCY Q4) two turns of one save can be live at once:
 * N in its post-reply tail, N+1 admitted. Both publish to the same
 * `user:<id>:events` channel, so a frame that names only `instanceId` cannot be
 * routed to the turn that sent it — the app would have to guess, and the guess
 * is wrong exactly when it matters (a late `choices_ready` from N landing on
 * N+1's bubble).
 *
 * Every per-turn frame therefore carries `jobId`: the BullMQ job id, which is
 * the same string the client already got in that turn's direct `ack`.
 * `generationService.dispatch` enqueues with `jobId: params.turnId` and returns
 * `job.id`; the worker's lock token for that same turn is `String(job.id)`.
 *
 * This pins the publish sites at the source: every frame literal in the two
 * files that publish them is located by its own object boundaries (brace
 * matching that ignores strings and comments, so prose can never be mistaken
 * for the payload), and each one must carry `jobId: String(job.id)` — the same
 * expression as the lock token, never a bare `job.id` that would serialise as a
 * number and never match the ack's string. The client's half of the contract
 * (`ack` carries jobId) is read here and never edited. Replay frames are out of
 * scope by decision: a replay turn takes the lock exclusively (no tail/next
 * overlap, `acquireGenerationTurn(..., false)`) and returns to
 * `replayProcessor` before any turn frame is published, so there is never a
 * second live job to route its frames between.
 *
 * A frame type in these files that is not in the catalogue below fails the
 * audit, with or without jobId: a new frame is a deliberate edit here.
 *
 *   bun --no-env-file run scripts/turn-frame-ids-audit.ts
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const source = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8')

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

const PROCESSOR = '../worker/processors/generation.processor.ts'
const WORKER = '../worker/index.ts'
const processor = source(PROCESSOR)
const worker = source(WORKER)

/** A per-turn frame is a `type: '…'` literal: the generation lifecycle, the
 *  chips that settle a turn, and the milestone that belongs to it. */
const FRAME = /\btype:\s*'(generation_[a-z_]+|choices_ready|milestone_unlocked)'/g

/** The catalogue. Exact, per file, duplicates included. */
const CATALOGUE: Record<string, string[]> = {
  [PROCESSOR]: [
    'choices_ready',
    'generation_complete',
    'generation_delta',
    'generation_reset',
    'generation_started',
    'generation_stream_end',
    'milestone_unlocked',
  ],
  [WORKER]: [
    'generation_failed',
    'generation_reset',
    'generation_reset',
    'generation_retrying',
  ],
}

/** `{`/`}` pairs of real code. Strings, template literals and comments are
 *  skipped, so a brace in prose (or in a JSON sample in a comment) never
 *  becomes a payload boundary. */
function objectSpans(src: string): Array<{ open: number; close: number }> {
  const stack: number[] = []
  const spans: Array<{ open: number; close: number }> = []
  let i = 0
  while (i < src.length) {
    const c = src[i]
    if (c === '/' && src[i + 1] === '/') {
      const end = src.indexOf('\n', i)
      i = end < 0 ? src.length : end
      continue
    }
    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2)
      i = end < 0 ? src.length : end + 2
      continue
    }
    if (c === '"' || c === "'" || c === '`') {
      i++
      while (i < src.length && src[i] !== c) i += src[i] === '\\' ? 2 : 1
      i++
      continue
    }
    if (c === '{') stack.push(i)
    else if (c === '}') {
      const open = stack.pop()
      if (open !== undefined) spans.push({ open, close: i })
    }
    i++
  }
  return spans
}

/** The innermost payload object around `at`. */
function payloadAround(src: string, spans: Array<{ open: number; close: number }>, at: number): string {
  let best: { open: number; close: number } | undefined
  for (const span of spans) {
    if (span.open < at && at < span.close && (!best || span.open > best.open)) best = span
  }
  assert.ok(best, 'no object literal around a frame type — has the publish been rewritten?')
  return src.slice(best!.open, best!.close + 1)
}

/** Every frame literal in one file, with the payload object it lives in. */
function framesIn(src: string) {
  const spans = objectSpans(src)
  const found: Array<{ type: string; payload: string; line: number }> = []
  for (const match of src.matchAll(FRAME)) {
    const line = src.slice(0, match.index).split('\n').length
    found.push({ type: match[1], payload: payloadAround(src, spans, match.index!), line })
  }
  return found
}

const processorFrames = framesIn(processor)
const workerFrames = framesIn(worker)

console.log('\nevery per-turn frame names the turn it belongs to:')

await check('each frame is a real payload object, and the catalogue names every one of them', () => {
  for (const [file, found] of [[PROCESSOR, processorFrames], [WORKER, workerFrames]] as const) {
    const expected = [...CATALOGUE[file]].sort()
    const actual = found.map((frame) => frame.type).sort()
    assert.deepEqual(
      actual, expected,
      `${file}: frames on the wire are ${JSON.stringify(actual)}, catalogue says ${JSON.stringify(expected)} — a new or renamed frame needs jobId and an entry here`,
    )
  }
})

await check('every per-turn frame carries jobId — the same expression as the lock token', () => {
  const all = [
    ...processorFrames.map((frame) => ({ ...frame, file: PROCESSOR })),
    ...workerFrames.map((frame) => ({ ...frame, file: WORKER })),
  ]
  assert.equal(all.length, 11, 'fixture: every per-turn publish site must be found')
  for (const frame of all) {
    const where = `${frame.file}:${frame.line} ${frame.type}`
    assert.ok(
      frame.payload.includes('jobId: String(job.id)'),
      `${where} must carry jobId: String(job.id), not a bare job.id — a number never matches the ack's string`,
    )
    assert.ok(frame.payload.includes('instanceId'), `${where} must keep the instanceId it already sent`)
  }
})

await check('the value equals the ack: dispatch enqueues the turn id as the job id', () => {
  const service = source('../src/services/generation.service.ts')
  assert.ok(
    service.includes('jobId: params.turnId'),
    'dispatch must enqueue with the turn id as the BullMQ job id, or the ack and the frames name different things',
  )
  assert.ok(service.includes('return job.id'), 'dispatch must hand that job id back to the caller to ack')
  // …and the processor uses that same id as its lock token, so a frame can
  // never name a turn the barrier does not know.
  assert.ok(
    processor.includes('markGenerationStreamEnd(\n      redis, lockKey, String(job.id), channel,'),
    'the stream-end frame must pass through the lock CAS under the same token it stamps on the frame',
  )
  assert.ok(
    processor.includes('finishGenerationTurn(\n    redis, lockKey, String(job.id), true,'),
    'the completion frame must pass through the lock CAS under the same token it stamps on the frame',
  )
})

await check("the client's half still holds: every ack sends jobId", () => {
  const playWs = source('../src/services/play-ws.service.ts')
  const acks = [...playWs.matchAll(/type: 'ack', jobId/g)]
  assert.equal(acks.length, 4, 'chat, continue, world action and replay each ack with the job id')
  assert.equal(
    [...playWs.matchAll(/type: 'ack',(?! jobId)/g)].length, 0,
    'an ack without jobId leaves the app unable to match the frames that follow it',
  )
})

await check('replay frames are untouched by this contract', () => {
  const replay = source('../worker/processors/replay.processor.ts')
  assert.equal(
    /jobId/.test(replay), false,
    'replay runs one job at a time; tagging its frames here would change a flow the contract leaves alone',
  )
  for (const type of ['replay_delta', 'replay_complete']) {
    assert.ok(replay.includes(`type: '${type}'`), `${type} must still be published`)
  }
})

console.log(`\nturn frame ids audit: ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
