/**
 * THE PLAYER'S GENDER REACHES THE STORY.
 *
 * Before this round the narrator learned a player's gender only when the save
 * used a persona (`compactPersonaLine`); the onboarding answer never reached a
 * prompt, and the choice pass got neither. Portuguese prose called a player
 * "rapaz"/"ele" and Spanish flipped between "él" and "la" while the buttons
 * said "curioso". This audit pins ONE effective gender per turn (persona, else
 * onboarding, else unknown) and the one line each pass gains.
 *
 * A GM player who named and described their own protagonist already decided
 * that character's gender, so in a world that is not sentient the protagonist
 * card suppresses the line in both passes — and a persona still wins over it.
 * The decision is structural (the world's `is_sentient`); a card's `role` is
 * editable in the app, so it is never consulted.
 *
 * Pure: fixtures only, no model call, no database.
 *
 *   bun run audit:player-gender
 *   bun run audit:player-gender --bites
 */
import assert from 'node:assert/strict'
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { buildPrompt } from '../src/utils/prompt-builder'
import {
  effectivePlayerGender,
  isPlayerAuthoredProtagonist,
  storyPlayerGender,
} from '../src/models/player-gender'
import { extractChoiceMetadata, type MetadataOpts } from '../worker/lib/metadata-extractor'

let pass = 0
let fail = 0
function check(label: string, fn: () => void | Promise<void>) {
  return Promise.resolve()
    .then(fn)
    .then(() => { pass++; console.log(`  ok   ${label}`) })
    .catch((err) => { fail++; console.log(`  FAIL ${label}\n       ${(err as Error).message}`) })
}

const MALE = 'the player character is male'
const FEMALE = 'the player character is female'
const NEUTRAL = "the player character's gender is not stated"
const GENDER_MARKER = 'PLAYER GENDER'

type PromptArgs = Parameters<typeof buildPrompt>[0]
const base: PromptArgs = {
  seedPrompt: 'A lamplit harbour inn where the tide decides who stays.',
  isSentient: false,
  worldState: {},
  activeFlags: {},
  globalLore: 'The harbour trades salt, rope and rumour.',
  retrievedLore: [],
  retrievedMemories: [],
  sceneSummary: null,
  recentEvents: [],
  userMessage: 'I wait by the bar.',
  userSpokenInput: 'I wait by the bar.',
  maxTokens: 9000,
  proseOnly: true,
  narrationPov: 'third',
  chatMode: 'saga',
  narrativeStyle: 'noir',
  narrationTone: 'cinematic',
  toneExampleSeed: 'fixture-instance',
  messageLength: 'medium',
}
const textOf = (input: PromptArgs) => buildPrompt(input).messages.map((message) => message.content).join('\n')
const dynamicOf = (input: PromptArgs) => buildPrompt(input).messages[1]?.content || ''
const has = (text: string, needle: string) => text.includes(needle)

// ── 1. one effective gender per turn ─────────────────────────────────────────
await check('a persona with a gender wins over onboarding', () => {
  assert.equal(effectivePlayerGender({ gender: 'female' }, 'male'), 'female')
})
await check('a male persona wins over a female onboarding answer', () => {
  assert.equal(effectivePlayerGender({ gender: 'male' }, 'female'), 'male')
})
await check('a persona without a gender is unknown, not the onboarding answer', () => {
  assert.equal(effectivePlayerGender({}, 'male'), 'unknown')
})
await check('no persona falls back to onboarding', () => {
  assert.equal(effectivePlayerGender(null, 'non_binary'), 'non_binary')
})
await check('neither is unknown', () => {
  assert.equal(effectivePlayerGender(null, undefined), 'unknown')
})

// ── 2. the narrator line, for every case ─────────────────────────────────────
await check('narrator male: the line states the gender', () => {
  const text = textOf({ ...base, playerGender: 'male' })
  assert.ok(has(text, MALE))
  assert.ok(!has(text, FEMALE) && !has(text, NEUTRAL))
})
await check('narrator female: the line states the gender', () => {
  const text = textOf({ ...base, playerGender: 'female' })
  assert.ok(has(text, FEMALE))
  assert.ok(!has(text, MALE) && !has(text, NEUTRAL))
})
await check('narrator non-binary: the neutral line, no gendered wording', () => {
  const text = textOf({ ...base, playerGender: 'non_binary' })
  assert.ok(has(text, NEUTRAL))
  assert.ok(!has(text, MALE) && !has(text, FEMALE))
})
await check('narrator unknown: the neutral line', () => {
  const text = textOf({ ...base, playerGender: 'unknown' })
  assert.ok(has(text, NEUTRAL))
  assert.ok(!has(text, MALE) && !has(text, FEMALE))
})
await check('narrator persona with a gender: the persona line carries it, no extra line', () => {
  const persona = { name: 'Rin', gender: 'female', age: 29, description: 'A tired tide-watcher.' }
  const text = textOf({ ...base, playerPersona: persona as never, playerGender: 'female' })
  assert.ok(has(text, 'Gender: female'), 'the persona profile must keep the gender')
  assert.ok(!has(text, GENDER_MARKER), 'no second gender line when the persona already states it')
})
await check('narrator persona without a gender: the neutral line', () => {
  const text = textOf({ ...base, playerPersona: { name: 'Rin' } as never, playerGender: 'unknown' })
  assert.ok(has(text, NEUTRAL))
})
await check('narrator persona that is non-binary: the neutral instruction still applies', () => {
  const text = textOf({ ...base, playerPersona: { name: 'Rin', gender: 'non_binary' } as never, playerGender: 'non_binary' })
  assert.ok(has(text, NEUTRAL))
  assert.ok(has(text, 'Gender: non-binary'))
})

// ── 3. the line is dynamic, never cached ─────────────────────────────────────
await check('the gender line sits in the dynamic block, never the static prefix', () => {
  const without = buildPrompt(base)
  const withGender = buildPrompt({ ...base, playerGender: 'female' })
  assert.equal(withGender.parts[0].hash, without.parts[0].hash, 'the static prefix moved')
  assert.ok(!has(withGender.messages[0].content, GENDER_MARKER), 'the line leaked into the static prefix')
  assert.ok(has(withGender.messages[1].content, FEMALE), 'the line is missing from the dynamic block')
  assert.ok(withGender.parts.some((part) => part.name === 'player_gender'), 'no player_gender part')
})

// ── 4. live turn and replay both carry it ────────────────────────────────────
await check('the same line reaches a live turn and a replay', () => {
  const live = textOf({ ...base, playerGender: 'male' })
  const replay = textOf({
    ...base,
    playerGender: 'male',
    sceneSummary: 'Mara counts the till while the lamps gutter.',
    recentEvents: [{ sequence: 1, data: { player_input: 'I ask about the tide.', ai_response: 'She shrugs.' } }],
  })
  assert.ok(has(live, MALE), 'the live narrator prompt lost the line')
  assert.ok(has(replay, MALE), 'the replay narrator prompt lost the line')
})

// ── 5. the choice pass carries the same rule ─────────────────────────────────
const CHOICE_RAW = '{"state_mutations":{},"flag_mutations":{},"scene_tag":"dialogue","emotional_tone":"calm","beat_ledger":{"npc_beats":[],"emotional_shift":null,"setting":null,"consequence":null,"unresolved_hook":null},"choices":[],"milestone":null}'
function captureChoice() {
  const requests: Array<Record<string, any>> = []
  const call = async (request: Record<string, any>) => {
    requests.push(JSON.parse(JSON.stringify(request)))
    return CHOICE_RAW
  }
  return { requests, call }
}
const choiceSystemOf = (requests: Array<Record<string, any>>) =>
  String(requests.find((request) => request.purpose === 'choice_metadata')?.messages?.[0]?.content || '')

await check('choice pass (English): the line names label and send', async () => {
  const { requests, call } = captureChoice()
  const opts: MetadataOpts = { playerGender: 'male', playerInput: 'I wait by the bar.', call }
  await extractChoiceMetadata('The room is quiet.', [], [], opts, { split: false })
  const system = choiceSystemOf(requests)
  assert.ok(has(system, MALE))
  assert.ok(has(system, 'write label and send'))
  assert.ok(!has(system, 'label_local and send_local'))
})
await check('choice pass (non-English): the line names the player copy and leaves English alone', async () => {
  const { requests, call } = captureChoice()
  const opts: MetadataOpts = {
    playerGender: 'unknown',
    playerInput: 'I wait by the bar.',
    choiceLanguage: { name: 'Brazilian Portuguese', narrative: 'A sala está quieta.', playerInput: 'Eu espero no balcão.' },
    call,
  }
  await extractChoiceMetadata('The room is quiet.', [], [], opts, { split: false })
  const system = choiceSystemOf(requests)
  assert.ok(has(system, NEUTRAL))
  assert.ok(has(system, 'label_local and send_local'))
  assert.ok(has(system, 'The English label and send stay as the rules teach.'))
})

// ── 6. where it is read, and what it costs ───────────────────────────────────
const server = new URL('..', import.meta.url).pathname
const read = (relative: string) => readFile(join(server, relative), 'utf8')
const instanceSource = await read('src/services/instance.service.ts')
const loadStart = instanceSource.indexOf('async loadSession(')
const loadEnd = instanceSource.indexOf('async updateSettings(', loadStart)
const loadSession = instanceSource.slice(loadStart, loadEnd)

await check('loadSession reads only the onboarding gender, in the same round trip as the save', () => {
  assert.ok(loadSession.includes("mongoColl.users().findOne({ _id: pid }, { projection: { 'preferences.gender': 1 } })"))
  assert.ok(loadSession.includes('const [instance, player] = await Promise.all(['), 'the read must run beside the save, never serially ahead of it')
  assert.ok(loadSession.includes("player_gender: effectivePlayerGender(instance.persona_snapshot, player?.preferences?.gender)"))
})
await check('the worker adds no database read for gender on the turn path', async () => {
  const generation = await read('worker/processors/generation.processor.ts')
  assert.ok(generation.includes("session.player_gender ?? 'unknown'"), 'the live narrator prompt must read the session')
  assert.equal(generation.includes("preferences.gender"), false, 'the worker must not read the user document')
})
await check('the replay reads the gender from its existing player projection', async () => {
  const memory = await read('src/services/memory.service.ts')
  assert.ok(memory.includes("'preferences.gender': 1"))
  assert.ok(memory.includes('const replayPlayerGender = effectivePlayerGender(instance.persona_snapshot, player?.preferences?.gender)'), 'the replay narrator prompt lost the line')
  assert.ok(memory.includes('playerGender: selectedPlayerGender'), 'a picked version re-extracts choices without the gender')
})

// ── 7. nothing the app receives gains the field ─────────────────────────────
await check('player_gender stays on the internal session, out of every app payload', async () => {
  const outsideSession = instanceSource.slice(0, loadStart) + instanceSource.slice(loadEnd)
  assert.equal(outsideSession.includes('player_gender'), false, 'the session-only field leaked into a public instance payload')
  const controllerDir = join(server, 'src/controllers')
  for (const entry of await readdir(controllerDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.ts')) continue
    const source = await readFile(join(controllerDir, entry.name), 'utf8')
    assert.equal(source.includes('player_gender'), false, `${entry.name} exposes player_gender to the app`)
  }
})

// ── 8. the world decides who authored the protagonist; the role never does ───
// The production card that started this round: a GM save whose protagonist's
// role was edited in the app to "best man". It must still suppress the line.
const GM_CARD = { is_protagonist: true, role: 'best man', canonical_name: 'Elara' }
const LOCKED_CARD = { is_protagonist: true, role: 'protagonist', canonical_name: 'Nell' }
// A sentient world's locked protagonist wearing the GM seed role — the inverse.
const ROLE_EDITED_SENTIENT_CARD = { is_protagonist: true, role: 'protagonist (the player)', canonical_name: 'Nell' }

await check("a GM world's protagonist card is the player's own, whatever its role", () => {
  assert.equal(isPlayerAuthoredProtagonist(GM_CARD, false), true)
  assert.equal(isPlayerAuthoredProtagonist({ is_protagonist: true }, undefined), true)
  assert.equal(isPlayerAuthoredProtagonist({ canonical_name: 'protagonist (the player)' } as never, false), false)
  assert.equal(isPlayerAuthoredProtagonist(null, false), false)
})
await check('a sentient world has no player-authored protagonist, whatever the card role', () => {
  assert.equal(isPlayerAuthoredProtagonist(LOCKED_CARD, true), false)
  assert.equal(isPlayerAuthoredProtagonist(ROLE_EDITED_SENTIENT_CARD, true), false)
  assert.equal(storyPlayerGender('male', LOCKED_CARD, false, true), 'male')
})
await check('the story gender carries no line for a player-authored protagonist', () => {
  assert.equal(storyPlayerGender('male', GM_CARD, false, false), undefined)
})
await check('a persona still wins over a player-authored protagonist', () => {
  assert.equal(storyPlayerGender('female', GM_CARD, true, false), 'female')
})
await check('a save without that card keeps the onboarding line', () => {
  assert.equal(storyPlayerGender('male', LOCKED_CARD, false, true), 'male')
  assert.equal(storyPlayerGender('male', null, false, false), 'male')
})
await check('narrator: a player-authored protagonist gets no gender line', () => {
  const text = textOf({ ...base, playerGender: storyPlayerGender('male', GM_CARD, false, false) })
  assert.equal(has(text, GENDER_MARKER), false)
})
await check('narrator: a sentient world keeps the line over its protagonist card', () => {
  const text = textOf({ ...base, playerGender: storyPlayerGender('male', ROLE_EDITED_SENTIENT_CARD, false, true) })
  assert.ok(has(text, MALE))
})
await check('choice pass: a player-authored protagonist gets no gender line', async () => {
  const { requests, call } = captureChoice()
  await extractChoiceMetadata('The room is quiet.', [], [], {
    playerGender: storyPlayerGender('male', GM_CARD, false, false),
    playerInput: 'I wait by the bar.',
    call,
  }, { split: false })
  assert.equal(has(choiceSystemOf(requests), GENDER_MARKER), false)
})
await check('choice pass: a sentient world keeps the line over its protagonist card', async () => {
  const { requests, call } = captureChoice()
  await extractChoiceMetadata('The room is quiet.', [], [], {
    playerGender: storyPlayerGender('male', ROLE_EDITED_SENTIENT_CARD, false, true),
    playerInput: 'I wait by the bar.',
    call,
  }, { split: false })
  assert.ok(has(choiceSystemOf(requests), MALE))
})
await check('choice pass: a persona keeps the line over that card', async () => {
  const { requests, call } = captureChoice()
  await extractChoiceMetadata('The room is quiet.', [], [], {
    playerGender: storyPlayerGender('male', GM_CARD, true, false),
    playerInput: 'I wait by the bar.',
    call,
  }, { split: false })
  assert.ok(has(choiceSystemOf(requests), MALE))
})

// ── 9. every flow reads the world flag it already has, never the role ───────
const memory = await read('src/services/memory.service.ts')
const editBody = memory.slice(memory.indexOf('async editEvent('), memory.indexOf('async replayEvent('))
const generation = await read('worker/processors/generation.processor.ts')
const genderSource = await read('src/models/player-gender.ts')

await check('the decision never consults the editable role', () => {
  assert.equal(genderSource.includes('.role'), false, 'the role test must be gone, with no fallback')
  assert.equal(genderSource.includes('PLAYER_PROTAGONIST_ROLE'), false)
})
await check("live: the narrator and the choice pass use the packet's protagonist card and the session world", () => {
  assert.ok(generation.includes("const protagonistCard = (characterCodex as any[]).find((c) => c.is_protagonist)"))
  assert.ok(generation.includes(
    "const turnPlayerGender = storyPlayerGender(\n    session.player_gender ?? 'unknown',\n    protagonistCard,\n    !!session.persona_snapshot,\n    !!session.is_sentient,\n  )",
  ), 'the live turn must read the session world flag, not the card role')
  assert.equal((generation.match(/playerGender: turnPlayerGender,/g) || []).length, 2, 'the narrator and the choice pass must both use it')
  assert.equal(generation.includes("playerGender: session.player_gender ?? 'unknown'"), false)
})
await check('replay: the narrator and the choice pass use the codex card and the template world', () => {
  assert.ok(memory.includes(
    'const replayTurnGender = storyPlayerGender(\n      replayPlayerGender,\n      replayCodex.find((card) => card?.is_protagonist),\n      !!instance.persona_snapshot,\n      !!template.is_sentient,\n    )',
  ), 'the replay must read the template world flag, not the card role')
  assert.equal((memory.match(/playerGender: replayTurnGender,/g) || []).length, 2, 'the narrator and the choice pass must both use it')
})
await check('pick: the shared choice projection reads the selected template world', () => {
  assert.ok(memory.includes(
    'const turnPlayerGender = storyPlayerGender(\n    params.playerGender,\n    protagonistCard,\n    !!instance.persona_snapshot,\n    !!template.is_sentient,\n  )',
  ), 'the pick must read the selected template world flag, not the card role')
  assert.ok(memory.includes('...(turnPlayerGender ? { playerGender: turnPlayerGender } : {})'))
  assert.ok(memory.includes('playerGender: selectedPlayerGender,'), 'a picked version no longer passes its gender')
})
await check("edit: the re-extracted chips read the template world and the player's own line", () => {
  assert.ok(editBody.includes("users().findOne({ _id: pid }, { projection: { 'preferences.gender': 1 } })"), 'the onboarding gender read must sit in the existing Promise.all')
  assert.ok(editBody.includes(
    'const editTurnGender = storyPlayerGender(\n        editPlayerGender,\n        editProtagonistCard,\n        !!editInstance?.persona_snapshot,\n        !!editTemplate?.is_sentient,\n      )',
  ), 'the edit must read the template world flag, not the card role')
  assert.ok(editBody.includes('playerGender: editTurnGender,'))
  assert.ok(editBody.includes('playerInput: editViewPlayer,'))
  assert.ok(editBody.includes('...(editAcceptedWitness ? { playerInputEnglish: editAcceptedWitness.player } : {})'))
})

if (fail > 0) {
  console.log(`\nplayer gender audit: ${pass} passed, ${fail} failed`)
  process.exit(1)
}

if (process.argv.includes('--bites')) {
  await runBites()
} else {
  console.log(`\nplayer gender audit: ${pass} passed, 0 failed`)
}

// ── bites ────────────────────────────────────────────────────────────────────
type Edit = [file: string, from: string, to: string]
type Mutation = { name: string; check: string; edits: Edit[] }

async function runBites() {
  const root = await mkdtemp(join(import.meta.dir, '.player-gender-bites-'))
  const server = new URL('..', import.meta.url).pathname
  const AUDIT = 'scripts/player-gender-audit.ts'
  const gender = 'src/models/player-gender.ts'
  const builder = 'src/utils/prompt-builder.ts'
  const extractor = 'worker/lib/metadata-extractor.ts'
  const instance = 'src/services/instance.service.ts'
  const generation = 'worker/processors/generation.processor.ts'
  const memory = 'src/services/memory.service.ts'

  const mutations: Mutation[] = [
    {
      name: 'the persona no longer owns its gender',
      check: 'a persona without a gender is unknown, not the onboarding answer',
      edits: [[gender, '  if (persona) return persona.gender || \'unknown\'', '  if (persona) return onboardingGender || \'unknown\'']],
    },
    {
      name: 'the male line says female',
      check: 'narrator male: the line states the gender',
      edits: [[builder, "return `PLAYER GENDER (canon): the player character is male; use masculine wording for the player wherever the narration or dialogue refers to them.`", "return `PLAYER GENDER (canon): the player character is female; use feminine wording for the player wherever the narration or dialogue refers to them.`"]],
    },
    {
      name: 'the neutral line is dropped',
      check: 'narrator non-binary: the neutral line, no gendered wording',
      edits: [[builder, "  return `PLAYER GENDER (canon): the player character's gender is not stated; never assign one. Refer to the player without gendered words — in languages with grammatical gender, use no gendered pronouns, adjectives, participles or nouns for the player.`", "  return ''"]],
    },
    {
      name: 'a persona with a gender gets a second line',
      check: 'narrator persona with a gender: the persona line carries it, no extra line',
      edits: [[builder, "  if ((gender === 'male' || gender === 'female') && input.playerPersona?.gender) return ''", '  if (false) return \'\'']],
    },
    {
      name: 'the line moves out of the dynamic block',
      check: 'the gender line sits in the dynamic block, never the static prefix',
      edits: [[builder, '    dynamicContent += `${genderLine}', '    staticContent += `${genderLine}']],
    },
    {
      name: 'the choice pass loses the line',
      check: 'choice pass (English): the line names label and send',
      edits: [[extractor, "  const genderRule = opts?.playerGender\n    ? choiceGenderInstruction(opts.playerGender, !!language)\n    : ''", "  const genderRule = ''"]],
    },
    {
      name: 'the live narrator call loses the session gender',
      check: 'the worker adds no database read for gender on the turn path',
      edits: [[generation, "    session.player_gender ?? 'unknown',", "    'unknown',"]],
    },
    {
      name: 'the replay narrator call loses the gender',
      check: 'the replay reads the gender from its existing player projection',
      edits: [[memory, '      playerGender: selectedPlayerGender,', '      playerGender: undefined,']],
    },
    {
      name: 'the session loses the field',
      check: 'loadSession reads only the onboarding gender, in the same round trip as the save',
      edits: [[instance, "      player_gender: effectivePlayerGender(instance.persona_snapshot, player?.preferences?.gender),", '']],
    },
    {
      name: 'the field leaks into the instance payload',
      check: 'player_gender stays on the internal session, out of every app payload',
      edits: [[instance, '    return { ...instance, ...liveFrameLanguage(instance) }', "    return { ...instance, player_gender: 'unknown', ...liveFrameLanguage(instance) }"]],
    },
    {
      name: 'the editable role comes back into the decision',
      check: "a GM world's protagonist card is the player's own, whatever its role",
      edits: [[gender, '  return !isSentient && card?.is_protagonist === true', "  return !isSentient && card?.is_protagonist === true && card.role === 'protagonist (the player)'"]],
    },
    {
      name: "a sentient world's protagonist card starts suppressing the line",
      check: 'a sentient world has no player-authored protagonist, whatever the card role',
      edits: [[gender, '  return !isSentient && card?.is_protagonist === true', '  return card?.is_protagonist === true']],
    },
    {
      name: 'a player-authored protagonist keeps the gender line',
      check: 'the story gender carries no line for a player-authored protagonist',
      edits: [[gender, '  if (!hasPersona && isPlayerAuthoredProtagonist(protagonist, isSentient)) return undefined', '  if (false) return undefined']],
    },
    {
      name: 'a persona no longer wins over that card',
      check: 'a persona still wins over a player-authored protagonist',
      edits: [[gender, '  if (!hasPersona && isPlayerAuthoredProtagonist(protagonist, isSentient)) return undefined', '  if (isPlayerAuthoredProtagonist(protagonist, isSentient)) return undefined']],
    },
    {
      name: 'the choice pass drops the line a persona owns',
      check: 'choice pass: a persona keeps the line over that card',
      edits: [[gender, '  if (!hasPersona && isPlayerAuthoredProtagonist(protagonist, isSentient)) return undefined', '  if (isPlayerAuthoredProtagonist(protagonist, isSentient)) return undefined']],
    },
    {
      name: 'every save loses the gender line, card or not',
      check: 'a save without that card keeps the onboarding line',
      edits: [[gender, '  if (!hasPersona && isPlayerAuthoredProtagonist(protagonist, isSentient)) return undefined\n  return gender', '  return undefined']],
    },
    {
      name: 'the narrator emits a gender line without a gender',
      check: 'narrator: a player-authored protagonist gets no gender line',
      edits: [[builder, "  if (!gender) return ''", "  if (!gender) return `PLAYER GENDER (canon): the player character is male; use masculine wording for the player wherever the narration or dialogue refers to them.`"]],
    },
    {
      name: 'the choice pass emits a line without a gender',
      check: 'choice pass: a player-authored protagonist gets no gender line',
      edits: [[extractor, "  const genderRule = opts?.playerGender\n    ? choiceGenderInstruction(opts.playerGender, !!language)\n    : ''", "  const genderRule = choiceGenderInstruction('male', !!language)"]],
    },
    {
      name: 'the live turn stops reading the packet protagonist card',
      check: "live: the narrator and the choice pass use the packet's protagonist card and the session world",
      edits: [[generation, 'playerGender: turnPlayerGender,', "playerGender: session.player_gender ?? 'unknown',"]],
    },
    {
      name: 'the live turn drops the session world flag',
      check: "live: the narrator and the choice pass use the packet's protagonist card and the session world",
      edits: [[generation, '    !!session.persona_snapshot,\n    !!session.is_sentient,\n  )', '    !!session.persona_snapshot,\n    false,\n  )']],
    },
    {
      name: 'the replay stops reading the codex protagonist card',
      check: 'replay: the narrator and the choice pass use the codex card and the template world',
      edits: [[memory, 'playerGender: replayTurnGender,', 'playerGender: replayPlayerGender,']],
    },
    {
      name: 'the replay drops the template world flag',
      check: 'replay: the narrator and the choice pass use the codex card and the template world',
      edits: [[memory, '      !!instance.persona_snapshot,\n      !!template.is_sentient,', '      !!instance.persona_snapshot,\n      false,']],
    },
    {
      name: 'the shared choice projection stops reading the card',
      check: 'pick: the shared choice projection reads the selected template world',
      edits: [[memory, 'const turnPlayerGender = storyPlayerGender(\n    params.playerGender,\n    protagonistCard,\n    !!instance.persona_snapshot,\n    !!template.is_sentient,\n  )', 'const turnPlayerGender = params.playerGender']],
    },
    {
      name: 'the pick drops the selected template world flag',
      check: 'pick: the shared choice projection reads the selected template world',
      edits: [[memory, '    !!instance.persona_snapshot,\n    !!template.is_sentient,', '    !!instance.persona_snapshot,\n    false,']],
    },
    {
      name: 'the edit path loses the gender and the player line',
      check: "edit: the re-extracted chips read the template world and the player's own line",
      edits: [[memory, '            playerGender: editTurnGender,', '            playerGender: undefined,']],
    },
    {
      name: 'the edit path drops the template world flag',
      check: "edit: the re-extracted chips read the template world and the player's own line",
      edits: [[memory, '        !!editInstance?.persona_snapshot,\n        !!editTemplate?.is_sentient,', '        !!editInstance?.persona_snapshot,\n        false,']],
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
    console.log(`player gender bites: ${bitten}/${mutations.length} mutations rejected; scratch restored and removed`)
    if (bitten !== mutations.length) process.exit(1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}
