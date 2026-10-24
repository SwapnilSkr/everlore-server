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
 * The app reads none of it (`everlore/lib` has zero hits for `codex_projection`,
 * `beat_ledger` and `interaction_signals`), and the narrator reads the last two
 * straight from the events collection, so nothing needs these fields on the
 * wire. This pins both halves: every internal key is gone, at the top level, in
 * each edit-history snapshot and on each replay variant, while the keys a player
 * actually uses survive.
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
  'interaction_signals',
  'beat_ledger',
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
const VARIANT_PROSE = 'She steps between me and the door.'

/** The narrator's private reading of the player's own words. */
const INTERACTION_SIGNALS = [{
  source: 'player' as const,
  target_character_id: 'card_1',
  target_name: 'Bram',
  kind: 'threat' as const,
  evidence: PLAYER_INPUT,
  confidence: 0.7,
  expires_after_sequence: 44,
}]

/** The narrator's handoff note for the next turn. */
const BEAT_LEDGER = {
  npc_beats: [{ character: 'Bram', intent: 'deflect', reaction: 'looks away' }],
  emotional_shift: 'guarded',
  setting: 'the hall',
  consequence: 'she knows I suspect her',
  unresolved_hook: 'the locked drawer',
}

/** A variant as the processor writes it (its own prose, chips, presence), plus
 *  the internal keys a stored document may still carry: the strip must take
 *  whatever of the internal set is there, not only `beat_ledger`. */
function replayVariants() {
  return [
    {
      id: 'base_42',
      narrative: VARIANT_PROSE,
      model_used: 'narration-a',
      created_at: new Date(),
      source: 'base',
      choices: CHOICES.map((choice) => ({ ...choice })),
      present_characters: ['Bram'],
      beat_ledger: BEAT_LEDGER,
      interaction_signals: INTERACTION_SIGNALS,
      codex_projection_status: 'completed' as const,
    },
    {
      id: 'replay_42_1',
      narrative: 'She closes the drawer and says nothing.',
      model_used: 'narration-b',
      created_at: new Date(),
      source: 'replay',
    },
  ]
}

function turnData() {
  return {
    player_input: PLAYER_INPUT,
    ai_response: AI_RESPONSE,
    choices: CHOICES.map((choice) => ({ ...choice })),
    replay_variants: replayVariants(),
    // Real lines, so "voice off" is proven by their REMOVAL rather than by the
    // fixture never having had them.
    spoken_lines: detectSpokenLines(AI_RESPONSE, ''),
    // Every internal key, at the place the server really writes them.
    interaction_signals: INTERACTION_SIGNALS,
    beat_ledger: BEAT_LEDGER,
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

await check('a replay variant keeps its prose, chips and presence, and loses the narrator notes', async () => {
  process.env.MEDIA_ENABLED = 'true'
  process.env.MEDIA_VOICE_ENABLED = 'true'
  type Variant = Record<string, unknown>
  const event = turn()
  const out = publicMediaEvent(event as never) as unknown as ReturnType<typeof turn>
  const variants = out.data.replay_variants as unknown as Variant[]
  assert.equal(variants.length, 2, 'every variant must still reach the app')

  // The variant's own prose is the whole point of a replay: it stays, with the
  // chips and presence the app renders beside it.
  assert.equal(variants[0].id, 'base_42', 'a variant keeps its id')
  assert.equal(variants[0].narrative, VARIANT_PROSE, 'a variant keeps its prose')
  assert.deepEqual(variants[0].choices, CHOICES, 'a variant keeps its chips')
  assert.deepEqual(variants[0].present_characters, ['Bram'], 'a variant keeps its presence')
  assert.equal(variants[1].narrative, 'She closes the drawer and says nothing.', 'the second variant keeps its prose')

  // A stored variant may carry any of the internal keys, not only the ledger.
  for (const key of ['beat_ledger', 'interaction_signals', 'codex_projection_status']) {
    assert.equal(key in variants[0], false, `${key} must not reach the app on a replay variant`)
  }
  // An edit snapshot holds the whole previous turn, variants included.
  const editVariants = out.edit_history[0].previous_data.replay_variants as unknown as Variant[]
  for (const key of ['beat_ledger', 'interaction_signals', 'codex_projection_status']) {
    assert.equal(key in editVariants[0], false, `${key} must not reach the app on a variant inside an edit snapshot`)
  }
  assert.equal(editVariants[0].narrative, VARIANT_PROSE, 'a variant inside an edit snapshot keeps its prose')
})

await check('the narrator reads the ledger and the signals from the database, never through the strip', async () => {
  // `beat_ledger` and `interaction_signals` leave every wire payload, so the
  // narrator must never be reading what the app is sent: these three read the
  // events collection themselves.
  for (const rel of [
    '../src/utils/prompt-builder.ts',
    '../worker/processors/generation.processor.ts',
    '../src/services/context-packet.service.ts',
  ]) {
    const src = readFileSync(new URL(rel, import.meta.url), 'utf8')
    assert.equal(
      src.includes('publicMediaEvent'),
      false,
      `${rel} must not use publicMediaEvent — the narrator's read must never pass through the strip`,
    )
  }
})

await check('the strip list names every key it claims, and every place it is applied', async () => {
  for (const key of INTERNAL_KEYS) {
    assert.ok(eventsSource.includes(`delete data.${key}`), `publicMediaEvent must delete ${key} itself, not by pattern`)
  }
  assert.ok(
    /for \(const edit of event\.edit_history \|\| \[\]\) \{[\s\S]*?delete edit\.previous_data\.spoken_lines[\s\S]*?stripInternalTurnFields\(edit\.previous_data\)/.test(eventsSource),
    'every edit snapshot must lose its lines and its internals',
  )
  assert.ok(
    /for \(const variant of data\.replay_variants \|\| \[\]\) stripInternalTurnFields\(variant\)/.test(eventsSource),
    'every replay variant must be stripped like a turn',
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
