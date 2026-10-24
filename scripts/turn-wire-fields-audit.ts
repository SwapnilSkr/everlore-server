/**
 * WHAT A TURN SENDS BACK: the player's own words and the story, and nothing of
 * the machinery that produced them.
 *
 * History leaves through `memoryService.getEvents`, the replay and edit
 * responses, and `generationService.loadInstance` — every one of them through
 * `publicMediaEvent`. That function already stripped the voice internals; it did
 * not strip the card-projection bookkeeping, which is per-turn server state:
 * `codex_projection_context` alone carries the player's raw input a second time
 * plus the internal signal/anomaly inputs the projection is built from.
 *
 * The app reads none of it (`everlore/lib` has zero hits for `codex_projection`),
 * and the worker reads its own Mongo document, so nothing needs these fields on
 * the wire. This pins both halves: every internal key is gone, at the top level
 * AND in each edit-history snapshot, while the keys a player actually uses
 * survive.
 *
 *   bun --no-env-file run scripts/turn-wire-fields-audit.ts
 */
import assert from 'node:assert/strict'
import { mock } from 'bun:test'
import { ObjectId } from 'mongodb'
import { readFileSync } from 'node:fs'

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

// The turn's own paths never touch Redis or Mongo; a stub that refuses makes a
// mistaken call here loud instead of a hang.
mock.module('../src/config/redis', () => ({
  getRedisClient: () => { throw new Error('this audit must not reach Redis') },
}))

const { publicMediaEvent } = await import('../src/services/media/events')
const { detectSpokenLines } = await import('../src/services/media/detection')

const eventsSource = readFileSync(
  new URL('../src/services/media/events.ts', import.meta.url),
  'utf8',
)

/** Server bookkeeping that must never reach a player, whatever it costs. */
const INTERNAL_KEYS = [
  'voice_attribution',
  'media_revision',
  'codex_projection_context',
  'codex_projection_dropped_unattributable',
  'codex_projection_ms',
  'codex_projection_claimed_at',
  'codex_projection_error',
  'codex_projection_attempts',
  'codex_projection_status',
  'codex_projection_completed_at',
]

const PLAYER_INPUT = 'I ask what she is hiding.'
const AI_RESPONSE = 'She looks up. “Not yet,” she says.'
const CHOICES = [{ label: 'Press her', kind: 'act' as const, send: '*I press her.*' }]

function turnData() {
  return {
    player_input: PLAYER_INPUT,
    ai_response: AI_RESPONSE,
    choices: CHOICES.map((choice) => ({ ...choice })),
    // Real lines, so "voice off" is proven by their REMOVAL rather than by the
    // fixture never having had them.
    spoken_lines: detectSpokenLines(AI_RESPONSE, ''),
    // Every internal key, at the place the server really writes them.
    voice_attribution: { status: 'done' as const, claimed_at: new Date() },
    media_revision: 'rev-1',
    codex_projection_context: {
      player_input: PLAYER_INPUT,
      player_self_name: 'Mara',
      anomalies: { stubNames: ['Bram'], droppedChoices: ['Press her'], locationAnchorName: 'hall', witnessLocationName: 'hall', excludeNames: [] },
      signals: { signals: [] } as Record<string, unknown>,
    },
    codex_projection_dropped_unattributable: 2,
    codex_projection_ms: { total: 8_400, batch_size: 1 },
    codex_projection_claimed_at: new Date(),
    codex_projection_error: 'upstream 502',
    codex_projection_attempts: 1,
    codex_projection_status: 'completed' as const,
    codex_projection_completed_at: new Date(),
  }
}

function turn() {
  return {
    _id: new ObjectId(),
    instance_id: new ObjectId(),
    player_id: new ObjectId(),
    sequence: 42,
    type: 'narration',
    data: turnData() as ReturnType<typeof turnData> & { spoken_lines?: unknown; media?: unknown },
    is_user_edited: false,
    edit_history: [{ previous_data: turnData(), edited_at: new Date() }],
    scene_tag: 'dialogue',
    created_at: new Date(),
  }
}

console.log('\na turn carries the story and nothing of the machinery:')

await check('with voice on, every internal key is gone from the turn and from its edit history', async () => {
  process.env.MEDIA_ENABLED = 'true'
  process.env.MEDIA_VOICE_ENABLED = 'true'
  const event = turn()
  assert.ok((event.data.spoken_lines as unknown[]).length > 0, 'fixture: the prose must yield a spoken line')

  const out = publicMediaEvent(event as never) as unknown as ReturnType<typeof turn>

  for (const key of INTERNAL_KEYS) {
    assert.equal(key in out.data, false, `${key} must not reach the app on the turn`)
    assert.equal(key in out.edit_history[0].previous_data, false, `${key} must not reach the app in an edit's previous_data`)
    assert.equal(key in event.edit_history[0].previous_data, false, `${key} must be stripped in place, as the rest are`)
  }

  // …and the player's own keys are untouched.
  assert.equal(out.data.player_input, PLAYER_INPUT, 'the player input must survive')
  assert.equal(out.data.ai_response, AI_RESPONSE, 'the prose must survive')
  assert.deepEqual(out.data.choices, CHOICES, 'the choices must survive')
  assert.ok((out.data.spoken_lines as unknown[]).length > 0, 'with voice on the lines must survive')
  assert.equal(out.edit_history[0].previous_data.ai_response, AI_RESPONSE, 'an edit snapshot keeps its prose')
  assert.deepEqual(out.edit_history[0].previous_data.choices, CHOICES, 'an edit snapshot keeps its choices')
  // Lines always go from an edit snapshot: their offsets point into prose that
  // is no longer the turn's.
  assert.equal('spoken_lines' in out.edit_history[0].previous_data, false, 'an edit snapshot never carries lines')
  // Routing fields the client needs are not bookkeeping.
  assert.equal(out.sequence, 42, 'the sequence must survive')
  assert.equal(out.type, 'narration', 'the type must survive')
})

await check('with voice off, the lines go and the story stays', async () => {
  process.env.MEDIA_VOICE_ENABLED = 'false'
  const event = turn()
  assert.ok((event.data.spoken_lines as unknown[]).length > 0, 'fixture: the turn must carry lines to lose')
  const out = publicMediaEvent(event as never) as unknown as ReturnType<typeof turn>
  process.env.MEDIA_VOICE_ENABLED = 'true'

  assert.equal('spoken_lines' in out.data, false, 'voice off means no lines on the wire')
  assert.equal(out.data.ai_response, AI_RESPONSE, 'the prose still arrives')
  assert.deepEqual(out.data.choices, CHOICES, 'the choices still arrive')
  assert.equal(out.data.player_input, PLAYER_INPUT, 'the player input still arrives')
  for (const key of INTERNAL_KEYS) {
    assert.equal(key in out.data, false, `${key} must stay off the wire with voice off too`)
  }
})

await check('the strip list names every key it claims, and both places it is applied', async () => {
  for (const key of INTERNAL_KEYS) {
    assert.ok(eventsSource.includes(`delete data.${key}`), `publicMediaEvent must delete ${key} itself, not by pattern`)
  }
  assert.ok(
    /for \(const edit of event\.edit_history \|\| \[\]\) \{[\s\S]*?delete edit\.previous_data\.spoken_lines[\s\S]*?stripInternalTurnFields\(edit\.previous_data\)/.test(eventsSource),
    'every edit snapshot must lose its lines and its internals',
  )
  // A key nobody named is a key nobody checked: the fields this audit covers
  // must be the fields the model declares, or one of them has quietly gone.
  const modelSource = readFileSync(new URL('../src/models/world-event.model.ts', import.meta.url), 'utf8')
  for (const key of INTERNAL_KEYS) {
    assert.ok(modelSource.includes(key), `${key} is not declared on the event model — is this audit still testing the right field?`)
  }
})

console.log(`\nturn wire fields audit: ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
