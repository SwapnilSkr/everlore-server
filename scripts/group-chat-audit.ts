import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { mock } from 'bun:test'
import { Elysia } from 'elysia'
import { MongoClient, MongoServerError, ObjectId, type Db } from 'mongodb'
import type { Job } from 'bullmq'
import { rollSpeakers, advanceSilence, pickAddressed, rollBystanders, pickSceneMembers } from '../src/services/group-chat/roll'
import { parseLines, filterLines, sceneVoiceLines, timeLines, emptyLineCounts, trimReply } from '../src/services/group-chat/lines'
import { buildGroupStatic, buildGroupDynamic, buildAddressedStatic, sceneExamples } from '../src/services/group-chat/prompt'
import { GROUP_SCENE_MAX_WRITERS, GROUP_SCENE_DEADLINE_MS, GROUP_WRITER_TIMEOUT_MS, groupWriterHostFailed, writeGroupReply } from '../src/services/group-chat/reply'
import { missedDetailAtoms, dropAdultWriterClaims, refileSpokenFacts, clearEverydayAdultMarks, uncoveredAdultEvents, adultRetryAtoms, adultLineAtoms } from '../src/services/group-chat/curation'
import { validateGroup } from '../src/services/group-chat/validation'
import { filterGroupAtomAudiences } from '../src/services/group-chat/curation'
import { publicGroupData } from '../src/services/group-chat/public'
import { GROUP_IDEA_MAX_CHARS, pickStatus, statusPeriod } from '../src/services/group-chat/ideas'
import { beginLLMTrace, settleLLMTrace } from '../src/ai/usage'
import { EmptyLLMResponseError } from '../src/utils/llm-response'
import { members as priorMembers, groupTemplate as priorGroupTemplate, owenReply } from './group-chat-fixtures'
const members = priorMembers.map(member => { const { interested: _old, ...group } = member.group as typeof member.group & { interested?: boolean }; return { ...member, group: { ...group, start_bond: 'acquaintance' as const } } })
function groupTemplate(): WorldTemplateDoc { return { ...priorGroupTemplate(), seed_cast: members.map(({ id, ...member }) => structuredClone(member)) } }
import type { GroupTurnJob } from '../worker/processors/group-turn.processor'
import type { WorldInstanceDoc } from '../src/models/world-instance.model'
import type { WorldTemplateDoc } from '../src/models/world-template.model'

let passed = 0
async function check(label: string, fn: () => unknown) {
  if (process.env.GROUP_AUDIT_ONLY && !label.startsWith(process.env.GROUP_AUDIT_ONLY)) return
  try { await fn() } catch (error) { throw new Error(`FAIL ${label}`, { cause: error }) }
  passed++; console.log(`PASS ${label}`)
}
const ids = members.map(member => member.id)
const names = members.map(member => member.name)
const zero = Object.fromEntries(ids.map(id => [id, 0]))
const never = () => 0.999999
const template = groupTemplate()
const playerName = 'Test Player'
const opts = { members, speakers: ids, origin: 'player' as const, previous: [], openings: template.opening_lines!, blocked: () => false }

await check('roll formula, silence growth and saturation', () => {
  assert.equal(rollSpeakers(members, zero, 'player', '', never).chances[ids[0]], 0.3)
  assert(Math.abs(rollSpeakers(members, { [ids[0]]: 3 }, 'player', '', never).chances[ids[0]] - 0.66) < 1e-12)
  assert.equal(rollSpeakers(members, { [ids[0]]: 100 }, 'player', '', never).chances[ids[0]], 1)
})
await check('tags always included; case-insensitive whole names; plain-name +0.5; tag has no bonus', () => {
  const roll = rollSpeakers(members, zero, 'player', `@${names[3].toLowerCase()} ${names[1]}`, never)
  assert(roll.picked.includes(ids[3])); assert.deepEqual(roll.tags, [ids[3]])
  assert.equal(roll.chances[ids[1]], 0.8); assert.equal(roll.chances[ids[3]], 0.3)
  assert.equal(rollSpeakers(members, zero, 'player', `x${names[0]} ${names[1]}suffix @${names[2]}more`, never).chances[ids[0]], 0.3)
  assert.deepEqual(rollSpeakers(members, zero, 'player', `x@${names[0]} @${names[1]}suffix`, never).tags, [])
})
await check('player minimum one and unprompted/catchup minimum two; highest chance and stable tie', () => {
  assert.deepEqual(rollSpeakers(members, zero, 'player', '', never).picked, [ids[0]])
  assert.deepEqual(rollSpeakers(members, { [ids[2]]: 4 }, 'player', '', never).picked, [ids[2]])
  for (const origin of ['unprompted', 'catchup'] as const) assert.equal(rollSpeakers(members, zero, origin, '', never).picked.length, 2)
})
await check('no member is barred across seeded rolls; silence resets only on actual speech', () => {
  let seed = 91
  const seen = new Set<string>()
  for (let i = 0; i < 500; i++) for (const id of rollSpeakers(members, zero, 'player', '', () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32)).picked) seen.add(id)
  assert.deepEqual([...seen].sort(), [...ids].sort())
  assert.deepEqual(advanceSilence(members, zero, [ids[0]]), Object.fromEntries(ids.map((id, i) => [id, i ? 1 : 0])))
})
await check('parser prefixes, continuation; player and unknown dropped with their continuations', () => {
  const counts = emptyLineCounts()
  const lines = parseLines(`${names[0]}: first\ncontinued\n**${names[1]}:** second\n${playerName}: forbidden\nleaked player continuation\nUnknown Writer: forbidden\nunknown continuation\n**${names[2]}**: third`, members, playerName, counts)
  assert.deepEqual(lines, [{ name: names[0], text: 'first continued' }, { name: names[1], text: 'second' }, { name: names[2], text: 'third' }])
  assert.equal(counts.player, 1); assert.equal(counts.unknown, 3)
})
await check('one speaker: lines with no name are theirs, each its own message', () => {
  const counts = emptyLineCounts()
  assert.deepEqual(parseLines('first\n\nsecond', members, playerName, counts, names[0]), [{ name: names[0], text: 'first' }, { name: names[0], text: 'second' }])
  assert.deepEqual(parseLines(`${names[0]}: first\ncontinued\n${playerName}: forbidden\nleaked\nUnknown Writer: forbidden\nleaked`, members, playerName, counts, names[0]), [{ name: names[0], text: 'first continued' }])
  assert.deepEqual(parseLines('no name', members, playerName, emptyLineCounts()), [])
})
await check('one speaker reply with no name needs one call; two speakers still retry', async () => {
  const input = { members, tags: [], player: playerName, origin: 'player' as const, previous: [], openings: [], blocked: () => false }
  let calls = 0
  const one = await writeGroupReply({ ...input, speakers: [ids[0]], direct: ids[0], write: async () => { calls++; return { content: 'no name here', model: 'fake' } } })
  assert.equal(calls, 1)
  assert.deepEqual(one.lines.map(line => [line.name, line.text]), [[names[0], 'no name here']])
  calls = 0
  await writeGroupReply({ ...input, speakers: [ids[0], ids[1]], write: async () => { calls++; return { content: calls > 1 ? `${names[0]}: named` : 'no name here', model: 'fake' } } })
  assert.equal(calls, 2)
})
await check('reply numbers: a long number nobody was shown is dropped', () => {
  const run = (text: string, knownText?: string) => { const counts = emptyLineCounts(); return [filterLines([{ name: names[0], text }], { ...opts, speakers: [ids[0]], knownText }, counts).length, counts.invented_detail] }
  assert.deepEqual(run('it was 4471', 'nothing here'), [0, 1])
  assert.deepEqual(run('it was 4471', 'the code is 4471'), [1, 0])
  assert.deepEqual(run('see you at 7, or 19:25', 'nothing here'), [1, 0])
  assert.deepEqual(run('it was 4471'), [1, 0])
  assert.equal(emptyLineCounts().invented_detail, 0)
})
await check('a line naming its own speaker is dropped as the writer talking; other names and longer words pass', () => {
  const run = (text: string) => { const counts = emptyLineCounts(); return [filterLines([{ name: names[0], text }], { ...opts, speakers: [ids[0]] }, counts).length, counts.self_named] }
  assert.deepEqual(run(`${names[0]}'s messages will reflect that.`), [0, 1])
  assert.deepEqual(run(`so ${names[0].toLowerCase()} will write this`), [0, 1])
  assert.deepEqual(run(`ask ${names[1]} about it`), [1, 0])
  assert.deepEqual(run(`${names[0]}x is not me`), [1, 0])
  assert.equal(emptyLineCounts().self_named, 0)
})
await check('a repeated sentence is removed from a new line; short sentences, other speakers and fully repeated lines behave', () => {
  const stock = 'I have never felt so alive.'
  const run = (text: string, previous = [{ name: names[0], text: `Well. ${stock} Really.` }]) => { const counts = emptyLineCounts(); const kept = filterLines([{ name: names[0], text }], { ...opts, speakers: [ids[0]], previous }, counts); return [kept[0]?.text, counts.repeated_sentence, counts.duplicate] }
  assert.deepEqual(run(`Yes. ${stock} Put your hands on me.`), ['Yes. Put your hands on me.', 1, 0])
  assert.deepEqual(run(`i have never, felt so alive! Put your hands on me right now, please.`), ['Put your hands on me right now, please.', 1, 0])
  assert.deepEqual(run(`${stock} That is good.`), [undefined, 0, 1])
  assert.deepEqual(run(stock), [undefined, 0, 1])
  assert.deepEqual(run('Really. Put your hands on me.'), ['Really. Put your hands on me.', 0, 0])
  assert.deepEqual(run(`${stock} Put your hands on me.`, [{ name: names[1], text: stock }]), [`${stock} Put your hands on me.`, 0, 0])
  const moved = (text: string, other: string) => { const counts = emptyLineCounts(); return [filterLines([{ name: names[0], text }], { ...opts, speakers: [ids[0]], previous: [{ name: names[0], text: other }] }, counts).length, counts.duplicate] }
  assert.deepEqual(moved('Oh my, yes, that feels good', 'oh my yes. that feels good'), [0, 1])
  assert.deepEqual(moved('😈', '🔥'), [1, 0])
  const within = emptyLineCounts()
  assert.deepEqual(filterLines([{ name: names[0], text: stock }, { name: names[0], text: `${stock} And then a good deal more besides.` }], { ...opts, speakers: [ids[0]] }, within).map(line => line.text), [stock, 'And then a good deal more besides.'])
  assert.equal(emptyLineCounts().repeated_sentence, 0)
})
await check('reply wording: a later message repeating earlier wording is dropped, the first stands', () => {
  const previous = [{ name: names[0], text: 'tongue sliding over clit, fingers gripping thighs' }]
  const run = (lines: string[], extra = {}) => { const counts = emptyLineCounts(); const kept = filterLines(lines.map(text => ({ name: names[0], text })), { ...opts, speakers: [ids[0]], addressed: ids[0], previous, repeatedIdea: true, ...extra }, counts); return [kept.map(line => line.text), counts.repeated_idea] }
  const again = 'your tongue sliding over clit, fingers gripping thighs again'
  assert.deepEqual(run(['something fresh entirely', again]), [['something fresh entirely'], 1])
  assert.deepEqual(run([again, 'something fresh entirely']), [[again, 'something fresh entirely'], 0])
  assert.deepEqual(run(['something fresh entirely', 'another different thought, tongue only']), [['something fresh entirely', 'another different thought, tongue only'], 0])
  assert.deepEqual(run(['something fresh entirely', again], { repeatedIdea: false }), [['something fresh entirely', again], 0])
  // Half the wording is the line: exactly half counts as repeated.
  assert.deepEqual(run(['something fresh entirely', 'tongue clit newword otherword']), [['something fresh entirely'], 1])
})
await check('off-list speakers dropped', () => {
  const counts = emptyLineCounts()
  assert.equal(filterLines([{ name: names[1], text: 'off list' }], { ...opts, speakers: [ids[0]] }, counts).length, 0)
  assert.equal(counts.off_list, 1)
})
await check('two per person, four per catchup after merge', () => {
  const input = members.flatMap(member => [0, 1, 2].map(index => ({ name: member.name, text: `line ${index}` })))
  const counts = emptyLineCounts()
  assert.equal(filterLines(input, opts, counts).length, 8); assert.equal(counts.over_cap, 4)
  assert.equal(filterLines(input, { ...opts, origin: 'catchup' }, emptyLineCounts()).length, 4)
})
await check('duplicates from last five and opening dropped; old sixth line allowed; normalized case and whitespace', () => {
  const previous = Array.from({ length: 6 }, (_, i) => ({ name: names[0], text: `prior ${i}` }))
  const counts = emptyLineCounts()
  const lines = filterLines([{ name: names[0], text: '  PRIOR   5 ' }, { name: names[0], text: 'prior 1' }, ...template.opening_lines!, { name: names[0], text: 'prior 0' }], { ...opts, previous }, counts)
  assert.deepEqual(lines, [{ name: names[0], text: 'prior 0' }]); assert.equal(counts.duplicate, 3)
})
await check('generated unsafe lines dropped', () => {
  const counts = emptyLineCounts()
  assert.equal(filterLines([{ name: names[0], text: 'flagged' }], { ...opts, blocked: () => true }, counts).length, 0)
  assert.equal(counts.unsafe, 1)
})
await check('reveal spacing 1.5–4 seconds from now; catchup times strictly inside gap', () => {
  const now = new Date('2026-11-01T12:00:00Z'), start = new Date('2026-11-01T03:00:00Z')
  const input = ids.map((id, i) => ({ name: names[i], text: `message ${i}` }))
  for (const rng of [() => 0, never]) {
    const lines = timeLines(input, members, now, undefined, rng)
    assert.equal(+lines[0].shown_at, +now)
    for (let i = 1; i < lines.length; i++) assert(+lines[i].shown_at - +lines[i - 1].shown_at >= 1500 && +lines[i].shown_at - +lines[i - 1].shown_at <= 4000)
  }
  const catchup = timeLines(input, members, now, start)
  assert(catchup.every((line, i) => +line.shown_at > +(i ? catchup[i - 1].shown_at : start) && +line.shown_at < +now))
})
await check('static prompt identical across calls; other saves isolated; no choice tail or scene-state instructions', () => {
  const first = buildGroupStatic({ ...template, members, player: playerName })
  const other = buildGroupStatic({ ...template, global_lore: 'Other save private lore', members, player: 'Other Player' })
  assert.equal(first, buildGroupStatic({ ...template, members, player: playerName })); assert(!first.includes('Other save private lore')); assert.notEqual(first, other)
  assert(!/CHOICES_JSON|SCENE STATE|state_mutations|you ARE this entity|present_characters/.test(first))
  for (const text of [template.seed_prompt, 'You write this group chat', 'Messages are short, as texts are', template.global_lore, ...members.map(member => member.group.wants)]) assert(first.includes(text))
  const dynamic = buildGroupDynamic({ memories: ['Save memory'], summaries: ['Save summary'], history: Array.from({ length: 31 }, (_, i) => ({ name: names[0], text: `history-${i}` })), now: new Date('2026-11-01T23:50Z'), offsetMinutes: 90, speakers: [names[1]], situation: 'Situation marker' })
  assert(dynamic.includes('Monday') && dynamic.includes('01:20')); assert(!dynamic.includes('history-0\n')); assert(dynamic.includes('history-30')); assert(dynamic.includes('Save memory') && dynamic.includes('Save summary') && dynamic.endsWith('Situation marker'))
})
await check('tag repair merged; empty primary retries then falls back; complete failure throws', async () => {
  let calls: Array<[string[], boolean]> = []
  const input = { ...opts, player: playerName, tags: [ids[1]], write: async (speakers: string[], fallback: boolean) => { calls.push([speakers, fallback]); return { content: `${calls.length === 1 ? names[0] : names[1]}: reply ${calls.length}`, model: 'fake' } } }
  const repaired = await writeGroupReply(input)
  assert.equal(repaired.lines.length, 2); assert.deepEqual(calls[1][0], [ids[1]]); assert.equal(calls[1][1], false)
  calls = []
  const recovered = await writeGroupReply({ ...input, tags: [], write: async (speakers, fallback) => { calls.push([speakers, fallback]); return { content: fallback ? `${names[0]}: recovered` : '', model: 'fake' } } })
  assert.equal(recovered.lines.length, 1); assert.equal(calls.length, 3); assert.equal(calls[2][1], true)
  await assert.rejects(writeGroupReply({ ...input, write: async () => ({ content: '', model: 'fake' }) }), /could not finish/)
})
await check('group validation rejects unsafe adults, stats, sentience, invalid cast, traits, topics and openings', () => {
  validateGroup(template)
  for (const patch of [
    { is_sentient: true }, { base_stats_template: { score: { default: 0, min: 0, max: 1, description: 'score' } } },
    { seed_cast: template.seed_cast!.slice(0, 1) },
    { seed_cast: template.seed_cast!.map((member, i) => i ? member : { ...member, name: template.seed_cast![1].name.toLowerCase() }) },
    ...[{ age: 17 }, { talkativeness: -0.1 }, { talkativeness: 1.1 }, { speech: ' ' }, { wants: ' ' }].map(patch => ({ seed_cast: template.seed_cast!.map((member, i) => i ? member : { ...member, group: { ...member.group!, ...patch } }) })),
    { topics: [] }, { opening_lines: [{ name: 'Unknown Writer', text: 'bad' }] },
  ]) assert.throws(() => validateGroup({ ...template, ...patch }))
})

await check('addressed pick uses first tag, then first named, then first roll with structural boundaries', () => {
  assert.equal(pickAddressed(members, `@${names[3]} then @${names[0]}`, ids), ids[3])
  assert.equal(pickAddressed(members, `${names[3]}, ${names[0]}`, ids), ids[3])
  assert.equal(pickAddressed(members, `${names[0]} @${names[2]}`, ids), ids[2])
  assert.equal(pickAddressed(members, `x@${names[3]} ${names[0]}suffix`, [ids[1]]), ids[1])
  assert.equal(pickAddressed(members, `@${names[2].toLowerCase()}`, ids), ids[2])
})
await check('adult bystander roll skips half, selects first other roll, and always includes other tags', () => {
  assert.deepEqual(rollBystanders(ids, [], ids[0], () => 0.499), [])
  assert.deepEqual(rollBystanders(ids, [], ids[0], () => 0.5), [ids[1]])
  assert.deepEqual(rollBystanders([ids[0]], [], ids[0], never), [])
  assert.deepEqual(rollBystanders(ids, [ids[0], ids[2], ids[3]], ids[0], () => 0), [ids[2], ids[3]])
})
await check('adult line checks strip paired and unpaired directions before blank, repeat and voice checks; caps gate', () => {
  const counts = emptyLineCounts()
  const raw = `${names[0]}: *laughs* Fresh words
${names[0]}: *only action*
${names[0]}: *unclosed leading
${names[0]}: unclosed trailing*
${names[0]}: *laughs*  AUTHORED   TEXT 0
${names[0]}: *sighs* Prior line
${names[0]}: second
${names[0]}: third
${names[0]}: fourth
${names[1]}: other one
${names[1]}: other two
${names[1]}: other three`
  const result = filterLines(parseLines(raw, members, playerName, counts), { ...opts, addressed: ids[0], previous: [{ name: names[0], text: 'prior line' }] }, counts)
  assert.deepEqual(result.map(line => line.text), ['Fresh words', 'second', 'third', 'other one', 'other two'])
  assert.equal(counts.stage_directions, 6); assert.equal(counts.empty, 3)
  assert.equal(counts.copied_example, 1); assert.equal(counts.duplicate, 1); assert.equal(counts.over_cap, 2)
  assert.equal(filterLines([{ name: names[0], text: 'first' }, { name: names[0], text: 'second' }], { ...opts, oneMessage: true }, emptyLineCounts()).length, 1)
})
await check('repeated openers compare two normalized words within one reply and ignore earlier turns', () => {
  const previous = [
    { name: names[0], text: 'First phrase from three lines ago.' },
    { name: names[1], text: 'Other member says this.' },
    { name: names[0], text: 'Second phrase from the last line.' },
  ]
  const options = { ...opts, previous, addressed: ids[0], repeatedOpener: true }
  const run = (member: string, ...texts: string[]) => {
    const counts = emptyLineCounts()
    return { kept: filterLines(texts.map(text => ({ name: member, text })), options, counts).map(line => line.text), dropped: counts.repeated_opener }
  }
  // Openers from earlier turns no longer remove a line.
  assert.deepEqual(run(names[0], 'FIRST,   phrase is changed.'), { kept: ['FIRST, phrase is changed.'], dropped: 0 })
  assert.deepEqual(run(names[0], 'Other member says this.'), { kept: ['Other member says this.'], dropped: 0 })
  // Within one reply the second is dropped, however it's cased or punctuated.
  assert.deepEqual(run(names[0], 'Fresh start in this reply.', '*waves* “FRESH,   start”—again here.').kept, ['Fresh start in this reply.'])
  assert.equal(run(names[0], 'Fresh start in this reply.', 'Fresh start again.').dropped, 1)
  assert.deepEqual(run(names[0], 'Fresh start here.', 'Later words.', 'Fresh start returns.').kept, ['Fresh start here.', 'Later words.'])
  // Two different second words, a one-word line, and another speaker all stay.
  assert.deepEqual(run(names[0], 'Fresh start here.', 'Fresh idea here.').kept, ['Fresh start here.', 'Fresh idea here.'])
  assert.deepEqual(run(names[0], 'Yes', 'Yes!').kept, ['Yes', 'Yes!'])
  const twoPeople = filterLines([{ name: names[0], text: 'Same words here.' }, { name: names[1], text: 'Same words there.' }], options, emptyLineCounts())
  assert.equal(twoPeople.length, 2)
  const otherIsAddressed = filterLines([{ name: names[1], text: 'Same words here.' }, { name: names[1], text: 'Same words there.' }], options, emptyLineCounts())
  assert.equal(otherIsAddressed.length, 2)
  assert.equal(filterLines([{ name: names[0], text: 'Same words here.' }, { name: names[0], text: 'Same words there.' }], { ...options, repeatedOpener: false }, emptyLineCounts()).length, 2)
  // Exact repeats of earlier lines still gate.
  assert.equal(filterLines([{ name: names[0], text: 'YES' }], { ...options, previous: [{ name: names[0], text: 'yes' }] }, emptyLineCounts()).length, 0)
})
await check('adult validation requires authored intimacy and 1–8 voice lines and rejects unknown shapes even when optional', () => {
  const patch = (group: unknown, capable = true) => ({ ...template, is_nsfw_capable: capable, seed_cast: template.seed_cast!.map((member, index) => index ? member : { ...member, group }) }) as WorldTemplateDoc
  const base = members[0].group
  for (const intimacy of [undefined, null, '', ' ', 42, []]) assert.throws(() => validateGroup(patch({ ...base, intimacy })))
  for (const voice of [undefined, null, '', [], [' '], [1], ['two\nlines'], Array(9).fill('text')]) assert.throws(() => validateGroup(patch({ ...base, voice })))
  assert.throws(() => validateGroup(patch({ ...base, unknown: 'field' })))
  assert.throws(() => validateGroup(patch({ ...base, voice: {} }, false)))
  const { intimacy, voice, ...optional } = base
  validateGroup(patch(optional, false))
  validateGroup(patch({ ...base, voice: Array(8).fill('text') }))
})
await check('addressed prompt is authored per person with player gender sentence and unchanged boundaries', async () => {
  const prompt = buildAddressedStatic({ ...template, members, player: playerName }, { ...members[2], group: { ...members[2].group, start_bond: 'enemy' } })
  for (const text of ['one to three', members[2].group.intimacy!, ...members[2].group.voice!, `${playerName}'s gender isn't stated: use their name`, 'answers what was actually said', 'never whether they say it', "it's happening", 'A flat no is rare', 'Say something new']) assert(prompt.includes(text))
  for (const other of members.filter(member => member.id !== ids[2])) assert(!prompt.includes(other.group.wants) && !prompt.includes(other.group.intimacy!))
  const { NARRATIVE_BOUNDARIES } = await import('../src/utils/prompt-builder')
  assert(prompt.includes(NARRATIVE_BOUNDARIES.trim()))
  assert(!buildGroupStatic({ ...template, members, player: playerName }).includes(members[2].group.intimacy!))
})

await check('starting bond is required and validated for every group member', () => {
  for (const capable of [false, true]) for (const start_bond of [undefined, null, 'unknown', 0, {}, [], 'enemy', 'friend']) {
    const changed = { ...template, is_nsfw_capable: capable, seed_cast: template.seed_cast!.map(member => ({ ...member, group: { ...member.group!, start_bond } })) } as WorldTemplateDoc
    if (start_bond === 'enemy' || start_bond === 'friend') validateGroup(changed)
    else assert.throws(() => validateGroup(changed), /start_bond/)
  }
})
await check('sentence trimming uses structural ends, preserves emoji and limits adult messages only', () => {
  for (const end of ['.', '!', '?', '…', '🙂', '👩🏽‍💻', '🇮🇳', '1️⃣']) {
    assert.equal(trimReply(`Complete${end} unfinished`, true, false), `Complete${end}`)
    assert.equal(trimReply(`Complete${end}`, true, false), `Complete${end}`)
  }
  assert.equal(trimReply('Complete. 🙂 unfinished', true, false), 'Complete. 🙂')
  assert.equal(trimReply('Complete. 👩🏽‍💻 🇮🇳 unfinished', true, false), 'Complete. 👩🏽‍💻 🇮🇳')
  assert.equal(trimReply('version 1.2 unfinished!suffix', true, false), '')
  assert.equal(trimReply('unfinished', true, true), '')
  const long = `Short. ${'long '.repeat(70)}`.trim()
  assert.equal(trimReply(long, false, true), 'Short.')
  assert.equal(trimReply(long, false, false), long)
  assert.equal(trimReply('word '.repeat(70).trim(), false, true), 'word '.repeat(56).trim())
  assert.equal(trimReply('x'.repeat(281), false, true), 'x'.repeat(280))
  const exact = `${'x'.repeat(278)}🙂`
  assert.equal(trimReply(exact, false, true), exact)
  assert.equal(trimReply('x'.repeat(279) + ' 👩🏽‍💻 tail', false, true), 'x'.repeat(279))
  assert.equal(trimReply('Short. ' + 'x'.repeat(268) + ' end. 🙂', false, true), 'Short.')
  const counts = emptyLineCounts()
  const kept = filterLines([{ name: names[0], text: 'Complete. partial' }], { ...opts, finishReason: 'length' }, counts)
  assert.equal(kept[0].text, 'Complete.'); assert.equal(counts.trimmed, 1)
  assert.equal(filterLines([{ name: names[0], text: 'partial' }], { ...opts, finishReason: 'length' }, counts).length, 0)
  assert.equal(counts.empty, 1); assert.equal(counts.trimmed, 2)
  const multi = filterLines([{ name: names[0], text: 'Earlier text' }, { name: names[1], text: 'Last. partial' }], { ...opts, finishReason: 'length' }, emptyLineCounts())
  assert.deepEqual(multi.map(line => line.text), ['Earlier text', 'Last.'])
})
await check('writer finish reason exposed by real transport', async () => {
  const child = Bun.spawn(['bun', '--no-env-file', 'run', 'scripts/group-chat-finish-audit.ts'], { cwd: new URL('..', import.meta.url).pathname, stdout: 'pipe', stderr: 'pipe' })
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  assert.equal(code, 0, out + err)
})

await check('retrieval audience gates every source before ranking and access while story requests stay fixed', async () => {
  // A separate module registry runs the actual provider without the processor's RAG stub.
  const code = String.raw`
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mock } from 'bun:test'
import { MongoClient, ObjectId, type Db } from 'mongodb'
const iid = '100000000000000000000001', tid = '100000000000000000000002'
const own = '200000000000000000000001', other = '200000000000000000000002'
const entity = '300000000000000000000001', location = '300000000000000000000002'
const oid = (n) => new ObjectId(n.toString(16).padStart(24, '0'))
const sources = ['vector', 'keyword', 'entity', 'location', 'threads']
let source = 'vector', requests = [], rankRequests = [], accesses = [], unreadable = false
const docs = [undefined, undefined, own, other, null, 42, [own]].map((privateTo, i) => ({
  _id: oid(i + 1), instance_id: new ObjectId(iid), text: 'MARKER_' + i,
  ...(privateTo === undefined ? {} : { private_to: privateTo }), importance: 3,
  is_archived: false, subject_entity_ids: [new ObjectId(entity)],
}))
const foreign = { ...docs[0], _id: oid(20), instance_id: oid(90), text: 'FOREIGN_INSTANCE' }
const stored = [...docs, foreign]
const forbidden = () => { throw new Error('Unexpected external call') }
globalThis.fetch = Object.assign(async () => forbidden(), { preconnect: forbidden })
const vectorMatches = [...stored.map(doc => ({ id: 'v-' + doc._id, score: 0.9, metadata: {
  mongo_id: String(doc._id), text: doc.text, importance: 3, private_to: own,
} })),
  { id: 'missing', metadata: { mongo_id: String(oid(50)), text: 'MISSING_ROW' } },
  { id: 'no-id', metadata: { text: 'NO_ID' } },
  { id: 'invalid', metadata: { mongo_id: 'bad', text: 'BAD_ID' } },
]
mock.module('./src/config/env', () => ({ env: { RAG_RERANK_ENABLED: true } }))
mock.module('./src/ai', () => ({ AI_MODELS: { cheapRank: 'fixture-rank' },
  embedQuery: async (text) => { requests.push(['embed', text]); return [1, 0] },
  isEmbedTimeout: () => false,
  callLLM: async (request) => { requests.push(['rank', request]); rankRequests.push(request); return '{"scores":[{"id":0,"score":50}]}' },
}))
mock.module('./src/services/vector-store', () => ({ vectorStore: { query: async (scope, query) => {
  requests.push(['vector', scope, query]); return { matches: scope.kind === 'mem' && source === 'vector' ? vectorMatches : [], namespace: '' }
} } }))
mock.module('./src/config/mongo', () => ({ mongoColl: { timelineBranches: () => ({ find: () => ({ toArray: async () => [] }) }), memories: () => ({
  find(filter, options) {
    requests.push(['find', filter, options])
    let values = filter._id ? stored.filter(doc => filter._id.$in.some(id => id.equals(doc._id)) && (!filter.instance_id || filter.instance_id.equals(doc.instance_id)))
      : (filter.$text ? source === 'keyword' : filter.unresolved_thread ? source === 'threads'
        : filter.$or?.some(clause => 'location_entity_id' in clause) ? source === 'location' : source === 'entity') ? docs : []
    const cursor = { sort() { return cursor }, limit(n) { values = values.slice(0, n); return cursor },
      async toArray() {
        if (unreadable && options?.projection?.private_to) throw new Error('Audience read failed')
        if (!options?.projection || options.projection.score) return values
        return values.map(doc => Object.fromEntries(Object.keys(options.projection).filter(key => key in doc).map(key => [key, doc[key]])))
      } }
    return cursor
  },
  async updateMany(filter, update) { requests.push(['access', filter, { ...update, $set: { last_accessed_at: 'DATE' } }]); accesses.push(...filter._id.$in.map(String)) },
}) } }))
const { queryRag } = await import('./src/providers/rag.provider.ts')
async function run(audience) {
  requests = []; rankRequests = []; accesses = []
  return queryRag(tid, iid, 'lookup', 10, 25, [entity], audience ? 'main' : undefined, location, undefined, audience)
}
for (source of sources) {
  for (const thread of [undefined, other, own]) {
    const result = await run({ thread })
    const text = JSON.stringify(rankRequests)
    const allowed = [0, 1, ...(thread === own ? [2] : thread === other ? [3] : [])]
    for (let i = 0; i < docs.length; i++) {
      const permitted = allowed.includes(i)
      if (source !== 'threads') assert.equal(text.includes(docs[i].text), permitted, source + ': reranker audience ' + thread + ' atom ' + i)
      assert.equal(accesses.includes(String(docs[i]._id)), permitted, source + ': access audience ' + thread + ' atom ' + i)
      assert.equal([...result.memoryTexts, ...result.openThreads].includes(docs[i].text), permitted)
    }
    for (const marker of ['FOREIGN_INSTANCE', 'MISSING_ROW', 'NO_ID', 'BAD_ID']) assert(!text.includes(marker))
    assert(!accesses.includes(String(foreign._id))); assert(!accesses.includes(String(oid(50))))
  }
  unreadable = true
  const failed = await run({ thread: own })
  assert.deepEqual(rankRequests, []); assert.deepEqual(accesses, [])
  assert.deepEqual(failed.memoryTexts, []); assert.deepEqual(failed.openThreads, [])
  unreadable = false
}
// Fixed pre-change ordinary-world boundary trace: no audience-specific reads or filtering.
source = 'vector'
vectorMatches.pop() // The legacy provider expects well-formed vector Mongo ids.
const story = await run(undefined)
assert(JSON.stringify(rankRequests).includes('MARKER_2')); assert(accesses.includes(String(docs[2]._id)))
const hash = createHash('sha256').update(JSON.stringify({ requests, memoryTexts: story.memoryTexts, openThreads: story.openThreads,
  retrievedMemoryMongoIds: story.retrievedMemoryMongoIds, retrievedEntityIds: story.retrievedEntityIds })).digest('hex')
assert.equal(hash, '8217af3dea79b781156b7213aed1fbd1b53ed531ec61d89fd90d88e9f2c12f52', 'ordinary queryRag boundary trace changed: ' + hash)
console.log('PASS actual provider audience, fail-closed reads and fixed story request hash')
`
  const child = Bun.spawn(['bun', '--no-env-file', '--eval', code], { cwd: new URL('..', import.meta.url).pathname, stdout: 'pipe', stderr: 'pipe' })
  const timer = setTimeout(() => child.kill(9), 30_000)
  const [out, err, status] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  clearTimeout(timer)
  assert.equal(status, 0, out + err)
})

// A real processor runs below against in-memory documents and a fake writer.
// No Mongo/Redis clients, network transport, timers or paid models are started.
type Row = Record<string, unknown>
const tables = new Map<string, Row[]>()
function rows(name: string) { if (!tables.has(name)) tables.set(name, []); return tables.get(name)! }
function lookup(value: unknown, keys: string[]): unknown {
  if (!keys.length) return value
  if (Array.isArray(value)) return value.flatMap(entry => lookup(entry, keys))
  if (!value || typeof value !== 'object') return undefined
  return lookup((value as Row)[keys[0]], keys.slice(1))
}
const get = (row: Row, path: string) => lookup(row, path.split('.'))
function put(row: Row, path: string, value: unknown) {
  const keys = path.split('.'); let current = row
  for (const key of keys.slice(0, -1)) { current[key] ??= {}; current = current[key] as Row }
  current[keys.at(-1)!] = value
}
const eq = (a: unknown, b: unknown) => a instanceof Date && b instanceof Date ? a.getTime() === b.getTime() : a instanceof ObjectId && b instanceof ObjectId ? a.equals(b) : a === b
function matches(row: Row, filter: Row): boolean {
  return Object.entries(filter).every(([key, expected]) => {
    if (key === '$text') return String(row.text || '').includes(String((expected as Row).$search))
    if (key === '$and') return (expected as Row[]).every(clause => matches(row, clause))
    if (key === '$or') return (expected as Row[]).some(clause => matches(row, clause))
    const value = get(row, key)
    if (expected && typeof expected === 'object' && !(expected instanceof ObjectId) && !(expected instanceof Date)) return Object.entries(expected).every(([op, other]) => {
      if (op === '$ne') return !(Array.isArray(value) ? value.some(entry => eq(entry, other)) : eq(value, other))
      if (op === '$exists') return (value !== undefined) === other
      if (op === '$in') return (other as unknown[]).some(other => Array.isArray(value) ? value.some(entry => eq(entry, other)) : eq(value, other))
      if (op === '$regex') return new RegExp(String(other), String((expected as Row).$options ?? '')).test(String(value ?? ''))
      if (op === '$options') return true
      if (op === '$lte') return Number(value) <= Number(other)
      if (op === '$lt') return Number(value) < Number(other)
      if (op === '$gte') return Number(value) >= Number(other)
      if (op === '$gt') return Number(value) > Number(other)
      throw new Error(`Unsupported audit operator ${op}`)
    })
    return Array.isArray(value) ? value.some(entry => eq(entry, expected)) : eq(value, expected)
  })
}
const clone = <T>(input: T): T => {
  if (!input || typeof input !== 'object' || input instanceof Date || input instanceof ObjectId) return input
  if (Array.isArray(input)) return input.map(clone) as T
  return Object.fromEntries(Object.entries(input).map(([key, value]) => [key, clone(value)])) as T
}
let pushWriteFailure: Error | undefined
let consentReadHook: (() => void) | undefined
let templateFindHook: ((filter: Row) => void) | undefined
let instanceInsertedHook: ((row: Row) => Promise<void>) | undefined
let eventInsertedHook: ((row: Row) => void) | undefined
let mediaUsageInsertedHook: ((row: Row) => Promise<void>) | undefined
function collection(name: string) {
  return {
    aggregate(pipeline: Row[]) {
      if (name === 'events') {
        const latest = new Map<string, Row>()
        for (const event of rows(name).filter(event => matches(event, pipeline[0].$match as Row)).sort((a, b) => Number(b.sequence) - Number(a.sequence))) {
          const key = String(event.instance_id)
          if (!latest.has(key)) latest.set(key, { _id: event.instance_id, preview: (event.data as Row).player_input || (event.data as Row).ai_response })
        }
        return { toArray: async () => [...latest.values()] }
      }
      assert.equal(name, 'worldInstances')
      return { toArray: async () => [{ rows: rows(name).map(latest => ({ latest: clone(latest) })), count: [{ total: rows(name).length }] }] }
    },
    find(filter: Row = {}, options?: { projection?: Record<string, number> }) {
      if (name === 'worldTemplates') templateFindHook?.(filter)
      let values = rows(name).filter(row => matches(row, filter))
      const cursor = {
        sort(order: Record<string, number>) { values.sort((a, b) => { for (const [key, dir] of Object.entries(order)) { const av = get(a, key), bv = get(b, key); if (av !== bv) return ((av instanceof ObjectId ? av.toHexString() : Number(av)) < (bv instanceof ObjectId ? bv.toHexString() : Number(bv)) ? -1 : 1) * dir } return 0 }); return cursor },
        limit(n: number) { values = values.slice(0, n); return cursor }, skip(n: number) { values = values.slice(n); return cursor },
        project(fields: Record<string, number>) { values = values.map(value => Object.fromEntries(Object.keys(fields).filter(key => fields[key] && key in value).map(key => [key, value[key]]))); return cursor }, async toArray() {
          if (!options?.projection) return clone(values)
          if ((options.projection.score as unknown as Row)?.$meta === 'textScore') return values.map(value => ({ ...clone(value), score: 1 }))
          return values.map(value => {
            const projected: Row = options.projection!._id === 0 ? {} : { _id: value._id }
            for (const [key, include] of Object.entries(options.projection!)) if (include && get(value, key) !== undefined) put(projected, key, clone(get(value, key)))
            return projected
          })
        },
      }
      return cursor
    },
    async findOne(filter: Row, options?: { sort?: Record<string, number>; projection?: Row }) { if (name === 'users' && options?.projection) consentReadHook?.(); let cursor = this.find(filter); if (options?.sort) cursor = cursor.sort(options.sort); return (await cursor.toArray())[0] || null },
    async countDocuments(filter: Row) { return rows(name).filter(row => matches(row, filter)).length },
    async insertOne(row: Row) {
      if ((name === 'mediaAssets' && rows(name).some(existing => eq(existing.cache_key, row.cache_key))) ||
          (name === 'mediaUsage' && rows(name).some(existing => eq(existing._id, row._id) || (row.slot !== undefined &&
            ['player_id', 'kind', 'day', 'slot'].every(key => eq(existing[key], row[key])))))) {
        throw new MongoServerError({ code: 11000, message: 'Simulated media unique key' })
      }
      // Simulate driver 11000 for report tests only. This does not prove Mongo index enforcement.
      if (name === 'contentReports') {
        if (rows(name).some(existing => ['open', 'reviewing'].includes(String(existing.status)) &&
          ['reporter_id', 'target_type', 'target_id', 'target_line'].every(key => eq(existing[key], row[key])))) {
          throw Object.assign(new Error('Simulated duplicate report'), { code: 11000 })
        }
        row = { _id: new ObjectId(), ...row }
      }
      if (name === 'events') eventInsertedHook?.(row)
      rows(name).push(clone(row)); if (name === 'worldInstances') await instanceInsertedHook?.(row)
      if (name === 'mediaUsage') await mediaUsageInsertedHook?.(row)
      return { insertedId: row._id } },
    async updateOne(filter: Row, update: Row, options?: { upsert?: boolean }) {
      if (name === 'pushDevices' && pushWriteFailure) throw pushWriteFailure
      let row = rows(name).find(row => matches(row, filter)); const existed = !!row
      if (!row && options?.upsert) { row = Object.fromEntries(Object.entries(filter).filter(([, value]) => !value || typeof value !== 'object' || value instanceof ObjectId || value instanceof Date)); rows(name).push(row); Object.assign(row, clone(update.$setOnInsert)) }
      if (row) {
        for (const [key, value] of Object.entries((update.$set || {}) as Row)) put(row, key, clone(value))
        for (const [key, value] of Object.entries((update.$inc || {}) as Row)) put(row, key, Number(get(row, key) || 0) + Number(value))
        for (const [key, value] of Object.entries((update.$max || {}) as Row)) if (get(row, key) === undefined || Number(get(row, key)) < Number(value)) put(row, key, value)
        for (const key of Object.keys((update.$unset || {}) as Row)) { const parts = key.split('.'); const parent = parts.length > 1 ? get(row, parts.slice(0, -1).join('.')) as Row : row; if (parent) delete parent[parts.at(-1)!] }
      }
      return { matchedCount: existed ? 1 : 0, modifiedCount: existed ? 1 : 0 }
    },
    async findOneAndUpdate(filter: Row, update: Row) {
      const before = await this.findOne(filter)
      if (!before) return null
      await this.updateOne(filter, update)
      return this.findOne({ _id: before._id })
    },
    async updateMany(filter: Row, update: Row) {
      let modifiedCount = 0
      for (const row of rows(name).filter(row => matches(row, filter))) { await this.updateOne({ _id: row._id }, update); modifiedCount++ }
      return { modifiedCount }
    },
    async deleteMany(filter: Row) { const list = rows(name); const kept = list.filter(row => !matches(row, filter)); list.splice(0, list.length, ...kept); return { deletedCount: list.length - kept.length } },
    async deleteOne(filter: Row) { if (name === 'pushDevices' && pushWriteFailure) throw pushWriteFailure; const index = rows(name).findIndex(row => matches(row, filter)); if (index >= 0) rows(name).splice(index, 1); return { deletedCount: index >= 0 ? 1 : 0 } },
  }
}
const frames: Row[] = [], outbox: Row[] = [], locks = new Map<string, string>(), queued: Row[] = []
const redis = {
  async get(key: string) { return locks.get(key) || null },
  async set(key: string, value: string, ...args: unknown[]) { if (args.includes('NX') && locks.has(key)) return null; locks.set(key, value); return 'OK' },
  async del(key: string) { locks.delete(key); return 1 },
  async publish(channel: string, text: string) { assert(channel.startsWith('user:')); frames.push(JSON.parse(text)); return 1 },
  async eval(_script: string, _keys: number, key: string, outcomeKey: string, before: string, after: string, _ttl: string, outcome: string, channel: string, frame: string) {
    if (_keys === 1) { if (locks.get(key) === outcomeKey) { locks.delete(key); return 1 }; return 0 }
    if ((locks.get(key) || '') !== before) return 0
    if (channel) await this.publish(channel, frame)
    if (after) locks.set(key, after); else locks.delete(key)
    if (outcome) locks.set(outcomeKey, outcome)
    return 1
  },
}
const unavailable = (): never => { throw new Error('Unexpected external dependency in group audit') }
globalThis.fetch = Object.assign(async () => unavailable(), { preconnect: unavailable })
const auditEnv = { GROUP_NOTIFICATIONS_ENABLED: false, FCM_SERVICE_ACCOUNT_JSON: '', NSFW_SAME_TURN_ROUTER: 'off', NSFW_SAME_TURN_ROUTER_MODEL: 'fake-router', NSFW_SAME_TURN_ROUTER_HOST: 'fixture' }
let routerRequests = 0, routerDelay = 0, routerSexual = true, routerError = false
mock.module('../src/config/env', () => ({ env: { ...auditEnv, get GROUP_NOTIFICATIONS_ENABLED() { return auditEnv.GROUP_NOTIFICATIONS_ENABLED }, get NSFW_SAME_TURN_ROUTER() { return auditEnv.NSFW_SAME_TURN_ROUTER }, CDN_BASE_URL: 'https://fixture.invalid', JWT_SECRET: 'audit-only', MEDIA_VOICE_ENABLED: false } }))
let reportMongoDb: Db | undefined
mock.module('../src/config/mongo', () => ({ mongoColl: new Proxy({}, { get: (_target, key) => () => key === 'contentReports' && reportMongoDb ? reportMongoDb.collection('content_reports') : collection(String(key)) }) }))
mock.module('../src/config/redis', () => ({ getRedisClient: () => redis, getQueueRedisClient: unavailable, getRedisSubscriber: unavailable }))
let judgeVerdict: boolean | 'error' | 'malformed' = true, judgeCalls: string[] = [], judgeGate: Promise<void> | undefined
let selfieVerdict: unknown = { position: null }, selfieCheckError = false, selfieCheckGate: Promise<void> | undefined
let selfieCheckRequests: Row[] = []
let onSelfieCheck: (() => void) | undefined
const routerClient = { chat: { completions: { create: async (params: { messages: Array<{ content: string }> }) => {
  if (params.messages[0].content.startsWith('Read the player')) {
    selfieCheckRequests.push(params); onSelfieCheck?.(); await selfieCheckGate
    if (selfieCheckError) throw new Error('Fixture picture check unavailable')
    return { choices: [{ message: { content: JSON.stringify(selfieVerdict) } }] }
  }
  if (params.messages[0].content.startsWith('You judge one reply')) {
    judgeCalls.push(params.messages[1].content); await judgeGate
    if (judgeVerdict === 'error') throw new Error('Fixture judge unavailable')
    return { choices: [{ finish_reason: 'stop', message: { content: judgeVerdict === 'malformed' ? 'yes' : JSON.stringify({ explicit: judgeVerdict }) } }] }
  }
  routerRequests++
  if (routerError) throw new Error('Fixture router unavailable')
  await new Promise(resolve => setTimeout(resolve, routerDelay))
  return { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ sexual_intent: routerSexual }) } }] }
} } } }
mock.module('../src/config/openai', () => ({ getOpenRouter: () => ({ withOptions: () => routerClient }), getOpenAI: unavailable }))
const backgroundScopes: Row[] = []
mock.module('../src/services/llm-trace.service', () => ({ flushLLMTracesLater: (records: Row[]) => { flushedTraces.push(records) }, flushLLMTraces: async () => {}, traceStore: () => ({ calls: collection('llmCalls'), bodies: collection('llmBodies') }), runBackgroundLLMTrace: async (scope: Row, fn: () => Promise<unknown>) => { backgroundScopes.push(scope); return fn() } }))
let ragSummaryHits: Array<{ id: string; tier: 'scene' | 'chapter' | 'arc'; text: string; startSequence: number; endSequence: number }> = []
let ragMemoryTexts = ['Remembered group fact.'], ragOpenThreads: string[] = [], ragCalls: unknown[][] = []
mock.module('../src/providers/rag.provider', () => ({ queryRag: async (...args: unknown[]) => { ragCalls.push(args); return { memoryTexts: ragMemoryTexts, openThreads: ragOpenThreads } }, querySummaries: async () => ragSummaryHits }))
mock.module('../src/services/post-process-outbox.service', () => ({ stagePostProcess: async (input: Row) => { outbox.push(input) }, dispatchPostProcessOutbox: async () => 0 }))
mock.module('../src/services/media/attribution', () => ({ ATTRIBUTION_RULE_VERSION: 'audit', mediaRevision: (prose: string, input = '') => createHash('sha256').update(JSON.stringify([prose, input])).digest('hex'), attributeEvent: unavailable, resolveAttributedSpeaker: unavailable }))
// Moderation reports below exercise the real service; discovery is isolated after import.
const checkLogs: Row[] = [], memoryLogs: Row[] = []
mock.module('../src/utils/logger', () => ({ log: { info: (name: string, data: Row) => { if (name === 'group.reply_checked') checkLogs.push(data); memoryLogs.push({ name, ...data }) }, warn: (name: string, data: Row) => { memoryLogs.push({ name, ...data }) }, error: () => {} } }))
mock.module('../src/services/time.service', () => ({ timeService: { initialAnchor: async (input: Row) => { if (input.templateId !== undefined) assert.notEqual(rows('worldTemplates').find(row => String(row._id) === input.templateId)?.kind, 'group'); return { real_time: new Date(), sequence: 0, timeline_id: 'main' } } } }))
mock.module('../src/services/opening-place.service', () => ({ extractOpeningPlace: unavailable }))
mock.module('../src/services/character-codex.service', () => ({ characterCodexService: { seedProtagonist: unavailable }, foldDelta: unavailable, newFoldState: (cards: Array<{ canonical_name: string }>) => ({ byName: new Map(cards.map(card => [card.canonical_name.toLowerCase(), card])) }), isEphemeralPersonDescriptor: unavailable, isNonPersonRole: unavailable, rankCodexForInjection: unavailable, identityKey: (text: string) => text.trim().toLowerCase() }))
mock.module('../src/services/kinship-graph.service', () => ({ kinshipGraphService: { seedPremiseKinship: unavailable } }))
mock.module('../src/services/template-cast.service', () => ({ materializeTemplateCast: async (input: { instanceId: string; template: WorldTemplateDoc }) => { const cast = input.template.seed_cast!; rows('characters').push(...cast.map((member, index) => ({ _id: new ObjectId((index + 1).toString(16).padStart(24, '0')), instance_id: new ObjectId(input.instanceId), canonical_name: member.name }))); return cast.length } }))
let extractCastCalls = 0
mock.module('../worker/lib/template-cast-extractor', () => ({ extractTemplateCast: async () => { extractCastCalls++; return [] } }))
const vectors = new Map<string, Row>()
mock.module('../src/services/vector-store', () => ({ vectorStore: { replaceLore: unavailable, deleteScope: async () => { vectors.clear() }, fetch: async (_scope: Row, ids: string[]) => ({ records: Object.fromEntries(ids.filter(id => vectors.has(id)).map(id => [id, vectors.get(id)])) }), upsert: async (_scope: Row, values: Row[]) => { for (const value of values) vectors.set(String(value.id), value) }, deleteIds: async (_scope: Row, ids: string[]) => { for (const id of ids) vectors.delete(id) } } }))
mock.module('../src/services/entity-graph.service', () => ({ normalizeEntityName: (text: string) => text.toLowerCase(), entityGraphService: { ensurePlayerEntity: async () => ({ _id: new ObjectId() }), resolveOrCreateEntities: async () => new Map(), upsertNarrativeEdge: async () => {} } }))
mock.module('../src/constants/default-cover', () => ({ isDefaultCoverUrl: () => false, resolveTemplateImageUrl: async () => 'https://fixture.invalid/cover.webp' }))

mock.module('../src/services/telemetry/ingest.service', () => ({ telemetryService: { purgeUser: async () => {} } }))
mock.module('../src/services/account-references', () => ({ purgeAccountReferences: async () => {} }))
const storedObjects = new Map<string, Buffer>()
const fixturePng = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')
mock.module('../src/services/storage.service', () => ({ storageService: {
  upload: async (data: Buffer, _type: string, opts: { key: string }) => { storedObjects.set(opts.key, data); return { key: opts.key, url: `https://fixture.invalid/${opts.key}` } },
  deleteStrict: async (key: string) => { storedObjects.delete(key) },
  delete: async (key: string) => { storedObjects.delete(key) },
} }))
mock.module('../src/services/billing-config.service', () => ({ resolveProfile: unavailable, effectiveBilling: async () => ({ promo: { unlimited: true, daily_turn_cap: 500 }, costs: { story_turn: 1 } }) }))
mock.module('../src/services/google-play.service', () => ({ googlePlayService: { configured: () => false } }))
mock.module('../src/services/auth.service', () => ({ authService: { getLiveAccess: async () => ({ tier: 'creator', account_status: 'active' }) }, defaultUserPreferences: () => ({}) }))
let routeUser: { id: string; tier: string } | null = null
let rateLimitReply: (userId: string, action: string) => { allowed: boolean; remaining?: number; retryAfter?: number } = () => ({ allowed: true })
mock.module('../src/middleware/auth', () => ({ verifyWsToken: unavailable,
  authPlugin: new Elysia().derive({ as: 'scoped' }, () => ({ user: routeUser })),
}))
mock.module('../src/middleware/rate-limit', () => ({ rateLimit: async (userId: string, action: string) => rateLimitReply(userId, action) }))
mock.module('../src/services/last-active.service', () => ({ recordLastActive: () => {} }))
let generationAddError: Error | undefined
mock.module('../src/queues', () => ({ getMediaQueue: unavailable, getMemoryCurationQueue: unavailable, removeQueuedJobsForInstance: async () => {}, getGenerationQueue: () => ({ add: async (_name: string, data: Row, options: Row) => { if (generationAddError) throw generationAddError; queued.push(data); return { id: options.jobId } } }), getSceneSummaryQueue: () => ({ add: async (_name: string, data: Row) => { queued.push(data) } }), QUEUE_RETENTION: { sceneSummary: {}, generation: { removeOnComplete: 10, removeOnFail: 10 } } }))
let writerHook: ((request: Row) => void | Promise<void>) | undefined
let bondReply: unknown = { changes: [] }, bondRequests: Row[] = [], bondHook: (() => Promise<void>) | undefined
let curatorReply: unknown = { memories: [] }, curatorRequests: Row[] = [], summaryRequests: Row[] = []
let summaryHook: (() => Promise<void>) | undefined, embedHook: (() => Promise<void>) | undefined
let summaryReply: string | Error = 'A named summary.'
let curatorFactory: ((request: Row) => unknown) | undefined
let curatorHook: (() => Promise<void>) | undefined
// The stub follows the requested atom schema, so omitted citation fields cannot pass unnoticed.
function curatorResponse(request: Row, result: unknown): unknown {
  if (typeof result === 'string') {
    try { result = JSON.parse(result) } catch { return result }
  }
  if (result && typeof result === 'object' && 'closed_threads' in result) {
    const closures = get(request, 'responseSchema.properties.closed_threads.items.properties.source_messages')
    result = { ...result, closed_threads: closures ? (result as Row).closed_threads : [] }
  }
  if (get(request, 'responseSchema.properties.memories.items.properties.source_messages')) return result
  if (!result || typeof result !== 'object' || !Array.isArray((result as Row).memories)) return result
  return { ...result, memories: ((result as Row).memories as Row[]).map(({ source_messages: _citations, ...atom }) => atom) }
}
let modelReplies: Array<string | Error | { content: string; finishReason: string }> = [], writerCalls: Row[] = [], turnNumber = 0
let ideaReplies: Array<string | Error> = [], ideaCalls: Row[] = [], ideaGate: Promise<void> | undefined
let onIdeaCall: (() => void) | undefined, flushedTraces: Row[][] = []
// The draft reads its model from `src/ai/models` directly, so the same fixture
// map is stubbed under both paths; a barrel-only stub would leave it undefined.
const auditModels = { authoring: 'fixture-authoring', memoryCuration: 'fixture-curator', sceneSummary: 'fixture-summary', chapterSummary: 'fixture-chapter', arcSummary: 'fixture-arc', narrationSfw: 'fake-safe', narrationNsfw: 'fake-story-adult', groupNsfw: 'fake-adult', groupNsfwFallbacks: ['fake-adult-fallback', 'fake-adult-last'], narrationSfwFallbacks: ['fake-safe-fallback'], narrationNsfwFallbacks: ['fake-adult-fallback'] }
mock.module('../src/ai/models', () => ({ AI_MODELS: auditModels }))
mock.module('../src/ai', () => ({ AI_MODELS: auditModels, narrationTemperature: () => 0.62, snapshotLLMUsage: () => [],
  embed: async () => { await embedHook?.(); return [1, 0] },
  callLLM: async (request: Row) => {
    if (request.purpose === 'group_bonds') { bondRequests.push(request); await bondHook?.(); if (bondReply instanceof Error) throw bondReply; return typeof bondReply === 'string' ? bondReply : JSON.stringify(bondReply) }
    if (request.purpose !== 'memory_curation') {
      summaryRequests.push(request); await summaryHook?.()
      if (summaryReply instanceof Error) throw summaryReply
      return summaryReply
    }
    curatorRequests.push(request); await curatorHook?.()
    const result = curatorFactory ? curatorFactory(request) : curatorReply
    if (result instanceof Error) throw result
    const response = curatorResponse(request, result)
    return typeof response === 'string' ? response : JSON.stringify(response)
  },
  callLLMWithFallback: async (request: Row) => {
    // The ideas call is its own background pass: it must never take a narration
    // reply from the shared queue, nor count as a writer call.
    if (request.purpose === 'group_reply_ideas') {
      ideaCalls.push(request); onIdeaCall?.(); await ideaGate
      const queued = ideaReplies.shift()
      const content = typeof queued === 'string' ? queued : JSON.stringify({ ideas: [] })
      const trace = beginLLMTrace({ model: String(request.model), purpose: 'group_reply_ideas', streamed: false, messages: request.messages as Row[], params: {} })
      if (trace) { trace.response = content; if (queued instanceof Error) settleLLMTrace(trace, queued) }
      if (queued instanceof Error) throw queued
      return { content, model: request.model }
    }
    writerCalls.push(request); await writerHook?.(request); const response = modelReplies.shift(); if (response instanceof Error) throw response; if (response && typeof response === 'object') return { ...response, model: request.model }; return { content: response ?? `${names[0]}: Fresh response ${turnNumber++}`, model: request.model } }, embedQuery: unavailable, embedBatch: unavailable, callLLMStream: unavailable, callLLMStreamWithFallback: unavailable, generateImage: unavailable, isEmbedTimeout: () => false,
}))
const { memoryProcessor, buildMemoryCurationRequest } = await import('../worker/processors/memory.processor')
const { summaryProcessor } = await import('../worker/processors/summary.processor')
const { loadGroupBatch, groupWriterMemory, groupWriterSummaries, groupMessages, deriveGroupAudience, groupMemoryMayMerge, raisedMemories, GROUP_MEMORY_TEXT_BUDGET, GROUP_ADULT_DIRECT_LINES, groupLineRaisesFact, groupHiddenWords } = await import('../src/services/group-chat/memory')
const { groupTurnProcessor } = await import('../worker/processors/group-turn.processor')
const { instanceService } = await import('../src/services/instance.service')
const { generationService } = await import('../src/services/generation.service')
const { deletionService } = await import('../src/services/deletion.service')
const { templateService } = await import('../src/services/template.service')
const { playWsService } = await import('../src/services/play-ws.service')
const { billingService } = await import('../src/services/billing.service')
const { moderationService } = await import('../src/services/moderation.service')
moderationService.discoveryFilter = async () => ({})
const { dispatchGroupTurn } = await import('../src/services/group-chat/dispatch')
const { validateEntry } = await import('./seed-catalog')
const originalRandom = Math.random
Math.random = () => 0
const playerId = '300000000000000000000001'
let instanceId = ''
async function start(source = groupTemplate(), player = playerName) {
  auditEnv.GROUP_NOTIFICATIONS_ENABLED = false; generationAddError = undefined
  bondReply = { changes: [] }; bondRequests = []; bondHook = undefined; ragSummaryHits = []; tables.clear(); vectors.clear(); curatorRequests = []; summaryRequests = []; summaryReply = 'A named summary.'; curatorHook = undefined; summaryHook = undefined; embedHook = undefined; curatorFactory = undefined; ragMemoryTexts = ['Remembered group fact.']; ragOpenThreads = []; ragCalls = []; memoryLogs.length = 0; backgroundScopes.length = 0; frames.length = 0; locks.clear(); queued.length = 0; outbox.length = 0; writerCalls = []; modelReplies = []; writerHook = undefined; consentReadHook = undefined; checkLogs.length = 0; ideaReplies = []; ideaCalls = []; ideaGate = undefined; onIdeaCall = undefined; flushedTraces = []; auditEnv.NSFW_SAME_TURN_ROUTER = 'off'; routerRequests = 0; routerDelay = 0; routerSexual = true; routerError = false
  rows('users').push({ _id: new ObjectId(playerId), preferences: { nsfw_enabled: false, player_name: player } })
  rows('worldTemplates').push(clone(source) as unknown as Row)
  const created = await instanceService.create(playerId, template._id.toHexString(), 'creator')
  instanceId = created.instance._id.toHexString()
  return created
}
let backgroundWork: Promise<void>[] = []
async function turn(data: Partial<GroupTurnJob> = {}, rng?: () => number, now?: () => Date, selfieRng = never) {
  const id = crypto.randomUUID(); locks.set(`lock:gen:${playerId}:${instanceId}`, JSON.stringify({ owner: id, phase: 'running' }))
  return groupTurnProcessor({ id, data: { instanceId, playerId, userMessage: 'A player message', ...data } } as Job<GroupTurnJob>, { rng, selfieRng, now, onBackground: work => { backgroundWork.push(work) } })
}
function forbidden(value: unknown) {
  if (!value || typeof value !== 'object') return
  for (const [key, entry] of Object.entries(value)) { assert(!['dm_with', 'private_to', 'start_bond', 'intimacy', 'voice', 'wants', 'talkativeness', 'topics', 'group_state', 'group_state_after', 'group_context', 'cost', 'cost_usd', 'tame', 'scene_members', 'tame_members'].includes(key), `leaked ${key}`); forbidden(entry) }
}
await check('group adult model defaults overrides and Euryale temperature are isolated from story narration', async () => {
  const code = `import { mock } from 'bun:test'
import { Elysia } from 'elysia'; mock.module('./src/config/env.ts', () => ({ env: {} })); const { AI_MODELS } = await import('./src/ai/models.ts'); console.log(JSON.stringify({ model: AI_MODELS.groupNsfw, fallbacks: AI_MODELS.groupNsfwFallbacks }));`
  for (const override of [false, true]) {
    const child = Bun.spawn(['bun', '--no-env-file', '-e', code], { cwd: new URL('..', import.meta.url).pathname,
      env: { ...process.env, GROUP_NSFW_MODEL: override ? 'override-adult' : '', GROUP_NSFW_FALLBACK_MODELS: override ? ' first, second , ' : undefined }, stdout: 'pipe', stderr: 'pipe' })
    const [out, errors, result] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    assert.equal(result, 0, errors)
    assert.deepEqual(JSON.parse(out), override ? { model: 'override-adult', fallbacks: ['first', 'second'] } : {
      model: 'sao10k/l3.1-euryale-70b', fallbacks: ['cognitivecomputations/dolphin-mistral-24b-venice-edition', 'thedrummer/skyfall-36b-v2'],
    })
  }
  // In its own process: this file's stand-in for the AI module also carries a temperature.
  const temperature = Bun.spawn(['bun', '--no-env-file', '-e', `const { narrationTemperature } = await import('./src/ai/narration-profile.ts'); console.log(narrationTemperature('sao10k/l3.1-euryale-70b'))`],
    { cwd: new URL('..', import.meta.url).pathname, stdout: 'pipe', stderr: 'pipe' })
  assert.equal((await new Response(temperature.stdout).text()).trim(), '0.62')
})
await check('seed adult schema accepts authored traits and rejects malformed or unknown fields', async () => {
  const { CreateTemplateBody } = await import('../src/schemas/template.schema')
  const { Value } = await import('@sinclair/typebox/value')
  const { _id, creator_id, slug, version, created_at, updated_at, is_published, visibility, review_status, ...body } = template
  assert(Value.Check(CreateTemplateBody, body))
  const groupSchema = CreateTemplateBody.properties.seed_cast.items.properties.group
  for (const patch of [{ start_bond: 23 }, { start_bond: null }, { start_bond: '' }, { interested: true }, { intimacy: 42 }, { voice: 'wrong' }, { voice: [] }, { voice: Array(9).fill('text') }, { voice: [42] }, { extra: 'unknown' }]) {
    assert(!Value.Check(groupSchema, { ...members[0].group, ...patch }))
  }
  for (const patch of [{ intimacy: undefined }, { voice: undefined }, { voice: [' '] }]) assert.throws(() => validateEntry({ ...body, slug, cover: 'fixture.png', seed_cast: body.seed_cast!.map((member, index) => index ? member : { ...member, group: { ...member.group!, ...patch } }) }, 'bad-adult'))
})
await check('seed validation refuses bad group via actual catalog validator', () => {
  const { _id, creator_id, slug, version, created_at, updated_at, is_published, visibility, review_status, ...body } = template
  validateEntry({ ...body, slug, cover: 'fixture.png' }, 'fixture')
  assert.throws(() => validateEntry({ ...body, seed_cast: body.seed_cast!.map(member => ({ ...member, group: { ...member.group!, age: 17 } })), slug, cover: 'fixture.png' }, 'bad-group'))
})
await check('creation seeds cast, state, one opening and no model; guests refused; one existing save reused', async () => {
  const first = await start()
  assert.equal(rows('events').length, 1); assert.equal(writerCalls.length, 0); assert.equal(first.instance.group_state?.topics_used, 0)
  assert.equal((rows('events')[0].data as Row).model_used, 'seed'); assert.equal(((rows('events')[0].data as Row).lines as unknown[]).length, 1)
  assert.equal((await instanceService.create(playerId, template._id.toHexString(), 'creator')).instance._id.toHexString(), instanceId)
  rows('users')[0].guest = true
  await assert.rejects(instanceService.create(playerId, template._id.toHexString(), 'creator'), /sign in/)
})
function limitWorldTemplate(kind: 'world' | 'character' | undefined) {
  const { kind: _groupKind, topics: _topics, opening_lines: _lines, ...source } = groupTemplate()
  const world: WorldTemplateDoc = { ...source, _id: new ObjectId(), is_sentient: false, seed_cast: [], opening_line: '' }
  if (kind !== undefined) world.kind = kind
  rows('worldTemplates').push(clone(world) as unknown as Row)
  return world
}
function limitWorldSaves(count: number, world: WorldTemplateDoc) {
  const { group_template_id: _groupTemplate, group_state: _state, group_context: _context, ...save } = rows('worldInstances')[0]
  return Array.from({ length: count }, () => ({ ...clone(save), _id: new ObjectId(), template_id: world._id }))
}
await check('world limit free player at ordinary capacity can join and rejoin a group', async () => {
  await start()
  const world = limitWorldTemplate('world')
  const worlds = limitWorldSaves(3, world)
  rows('worldInstances').splice(0, rows('worldInstances').length, ...worlds)
  const joined = await instanceService.create(playerId, template._id.toHexString(), 'free')
  assert(joined.instance.group_state); assert(joined.instance.group_template_id?.equals(template._id))
  assert.equal(rows('worldInstances').length, 4); assert.equal(writerCalls.length, 0)
  const reused = await instanceService.create(playerId, template._id.toHexString(), 'free')
  assert(reused.instance._id.equals(joined.instance._id)); assert.equal(rows('worldInstances').length, 4)
})
await check('world limit several groups leave room for every ordinary kind before group state exists', async () => {
  for (const kind of ['world', 'character', undefined] as const) {
    await start()
    for (let i = 0; i < 2; i++) {
      const group = { ...groupTemplate(), _id: new ObjectId() }
      rows('worldTemplates').push(clone(group) as unknown as Row)
      await instanceService.create(playerId, group._id.toHexString(), 'free')
    }
    const world = limitWorldTemplate(kind)
    rows('worldInstances').push(...limitWorldSaves(2, world))
    const [archived, foreign] = limitWorldSaves(2, world)
    put(archived, 'meta.is_archived', true); foreign.player_id = new ObjectId()
    rows('worldInstances').push(archived, foreign)
    const group = { ...groupTemplate(), _id: new ObjectId() }
    rows('worldTemplates').push(clone(group) as unknown as Row)
    let checkedWindow = false
    instanceInsertedHook = async pending => {
      instanceInsertedHook = undefined
      // Exercise the real count between insertOne and seedGroupOpening.
      assert.equal(pending.group_state, undefined)
      assert((pending.group_template_id as ObjectId).equals(group._id))
      const created = await instanceService.create(playerId, world._id.toHexString(), 'free')
      assert(created.instance.template_id.equals(world._id)); assert.equal(created.instance.group_template_id, undefined)
      checkedWindow = true
    }
    try { await instanceService.create(playerId, group._id.toHexString(), 'free') }
    finally { instanceInsertedHook = undefined }
    assert(checkedWindow); assert.equal(writerCalls.length, 0)
    assert.equal(rows('worldInstances').filter(row => row.group_template_id !== undefined).length, 4)
    assert.equal(rows('worldInstances').filter(row => matches(row, { player_id: new ObjectId(playerId), 'meta.is_archived': { $ne: true }, group_template_id: { $exists: false } })).length, 3)
  }
})
await check('world limit ordinary saves still refused at unchanged tier capacities', async () => {
  for (const [tier, limit] of [['free', 3], ['premium', 20], ['creator', 50], ['unknown', 3]] as const) {
    for (const kind of ['world', 'character', undefined] as const) {
      await start()
      const world = limitWorldTemplate(kind)
      rows('worldInstances').push(...limitWorldSaves(limit, world))
      const count = rows('worldInstances').length
      await assert.rejects(instanceService.create(playerId, world._id.toHexString(), tier), error => {
        assert(error instanceof Error && 'statusCode' in error)
        assert.equal(error.statusCode, 403)
        assert.equal(error.message, 'You are already keeping as many worlds as this membership allows.')
        return true
      })
      assert.equal(rows('worldInstances').length, count); assert.equal(writerCalls.length, 0)
    }
  }
})
await check('fake-model player turn writes reply, emits real safe frames and preserves location/travel/presence/choices/stats', async () => {
  await start()
  const save = rows('worldInstances')[0]
  const sentinel = { current_location: { name: 'sentinel place' }, travelling_with: [{ name: 'sentinel companion' }], world_state: { sentinel: 7 }, active_flags: { sentinel: true }, present_characters: ['sentinel presence'], choices: ['sentinel choice'] }
  Object.assign(save, clone(sentinel))
  await turn()
  assert.equal(rows('events').length, 2)
  const event = rows('events')[1]; const data = event.data as Row
  assert.equal(data.player_input, 'A player message'); assert((data.lines as unknown[]).length > 0); assert((data.ai_response as string).includes(':'))
  assert.deepEqual(data.state_mutations, {}); assert.deepEqual(data.flag_mutations, {}); assert.equal(data.choices, undefined)
  for (const [key, value] of Object.entries(sentinel)) assert.deepEqual(save[key], value)
  assert.deepEqual(frames.map(frame => frame.type), ['generation_started', 'group_lines', 'generation_complete'])
  const frame = frames[1]; forbidden(frame)
  assert.deepEqual(Object.keys(frame).sort(), ['eventId', 'instanceId', 'lines', 'type'])
  const line = (frame.lines as Row[])[0]; assert.deepEqual(Object.keys(line).sort(), ['characterId', 'line_id', 'name', 'shownAt', 'text'])
  assert.equal(outbox.length, 0)
})
await check('real processor tagged repair merges and empty output retries before fallback', async () => {
  await start(); modelReplies = [`${names[0]}: first response`, `${names[1]}: tagged response`]
  await turn({ userMessage: `@${names[1]} please answer` })
  assert.equal(((rows('events')[1].data as Row).lines as unknown[]).length, 2)
  assert.equal(writerCalls.length, 2); assert((writerCalls[1].messages as Row[])[1].content!.toString().includes(`Only these people write in this reply: ${names[1]}.`))
  await start(); modelReplies = ['', '', `${names[0]}: fallback response`]
  await turn(); assert.equal(writerCalls.length, 3); assert.equal(writerCalls[2].model, 'fake-safe-fallback')
})
await check('last-five duplicate history extends beyond the recent chat window', async () => {
  await start()
  const seed = rows('events')[0]
  rows('events').push({ ...clone(seed), _id: new ObjectId(), sequence: 2, data: { model_used: 'fake', lines: [{ character_id: ids[0], text: 'Earlier memorable line', shown_at: new Date() }] } })
  for (let sequence = 3; sequence < 38; sequence++) rows('events').push({ ...clone(seed), _id: new ObjectId(), sequence, data: { model_used: 'fake', lines: [{ character_id: ids[1], text: `Other speaker ${sequence}`, shown_at: new Date() }] } })
  modelReplies = [`${names[0]}: Earlier memorable line`, `${names[0]}: A new response instead`]
  await turn()
  assert.equal(writerCalls.length, 2)
  assert((rows('events').at(-1)!.data as Row).ai_response!.toString().includes('A new response instead'))
})
await check('input guard blocks before writer; generated lines screened before persistence', async () => {
  await start()
  await assert.rejects(turn({ userMessage: 'sex with a 12 year old' }), /minors/); assert.equal(writerCalls.length, 0)
  modelReplies = [`${names[0]}: sex with a 12 year old`, `${names[0]}: clean recovered line`]
  await turn(); assert.equal(writerCalls.length, 2)
  assert(!JSON.stringify(frames).includes('12 year old'))
})
await check('unprompted and catchup use group reservation, topics in order, two picks, catchup capped and spread', async () => {
  await start()
  const id = await dispatchGroupTurn({ instanceId, playerId, origin: 'unprompted' })
  assert(id); assert.equal(queued[0].origin, 'unprompted'); assert.equal(rows('inkLedger')[0].delta, 0); assert.equal(rows('inkLedger')[0].reference, 'group_turn')
  modelReplies = members.map(member => `${member.name}: an autonomous line`).join('\n').split('\u0000')
  const random = Math.random; Math.random = never
  try { await turn({ userMessage: '', origin: 'unprompted' }) } finally { Math.random = random }
  assert.equal(((rows('events')[1].data as Row).lines as unknown[]).length, 2)
  assert((writerCalls[0].messages as Row[])[1].content!.toString().includes('First topic'))
  const gapStart = new Date(Date.now() - 9 * 3600_000)
  await dispatchGroupTurn({ instanceId, playerId, origin: 'catchup', gapStart })
  modelReplies = [members.flatMap(member => [0, 1].map(i => `${member.name}: catchup fresh ${i}`)).join('\n')]
  Math.random = () => 0
  try { await turn({ userMessage: '', origin: 'catchup', gapStart: gapStart.toISOString() }) } finally { Math.random = random }
  const lines = (rows('events')[2].data as Row).lines as Array<{ shown_at: Date }>
  assert.equal(lines.length, 4); assert(lines.every(line => +line.shown_at > +gapStart && +line.shown_at < Date.now()))
  assert((writerCalls[1].messages as Row[])[1].content!.toString().includes('Second topic'))
  assert.equal((rows('worldInstances')[0].group_state as Row).topics_used, 2)
  await assert.rejects(dispatchGroupTurn({ instanceId, playerId, origin: 'catchup' }), /start time/)
})
await check('toggle off never picks adult despite recent explicit scene and Ardent mode; autonomy stays normal', async () => {
  for (const enabled of [false, true]) for (const mode of ['free_play', 'ardent']) for (const origin of ['player', 'unprompted'] as const) {
    await start(); put(rows('users')[0], 'preferences.nsfw_enabled', enabled)
    rows('worldInstances')[0].mode = mode
    rows('events').push(...[2, 3].map(sequence => ({ ...clone(rows('events')[0]), _id: new ObjectId(), sequence, type: 'intimate' })))
    await turn({ origin, userMessage: origin === 'player' ? `@${names[0]} morning` : '' }, () => 0)
    assert.equal(writerCalls[0].model, enabled && origin === 'player' ? 'fake-adult' : 'fake-safe')
  }
})
async function adultStart(source = groupTemplate()) {
  await start(source)
  put(rows('users')[0], 'preferences.nsfw_enabled', true)
  auditEnv.NSFW_SAME_TURN_ROUTER = 'on'
}
function content(call: Row, role: number) { return ((call.messages as Row[])[role].content as string) }
function lastData() { return rows('events').at(-1)!.data as Row }
function addEvent(type: string, member: number, sequence = rows('events').length + 1, model = 'fake') {
  rows('events').push({ ...clone(rows('events')[0]), _id: new ObjectId(), sequence, type,
    data: { model_used: model, player_input: '', lines: [{ character_id: ids[member], text: `Prior ${sequence}`, shown_at: new Date() }] } })
}
await check('addressed history keeps exchange and three recent others without seeds in actual writer text', async () => {
  for (const interested of [true, false]) {
    const source = groupTemplate(); source.seed_cast![2].group!.start_bond = interested ? 'friend' : 'enemy'
    await start(source); put(rows('users')[0], 'preferences.nsfw_enabled', true); auditEnv.NSFW_SAME_TURN_ROUTER = 'on'
    for (let i = 1; i <= 5; i++) rows('events').push({ ...clone(rows('events')[0]), _id: new ObjectId(), sequence: i + 1,
      data: { model_used: 'fake', player_input: `player-${i}`, lines: [
        { character_id: ids[2], text: `addressed-${i}`, shown_at: new Date() },
        { character_id: ids[0], text: `other-${i}`, shown_at: new Date() },
      ] } })
    addEvent('narration', 0, 7, 'seed')
    put(rows('events').at(-1)!, 'data.player_input', 'Seed player text')
    modelReplies = [`${names[2]}: Addressed fresh`, `${names[0]}: Bystander fresh`]
    let draw = 0
    const message = `@${names[2]} answer this`
    await turn({ userMessage: message }, () => ++draw <= members.length - 1 ? 0 : 0.75)
    const actual = content(writerCalls[0], 1).split('Recent messages:\n')[1].split('\n\nNow:')[0]
    const expected = [`${names[2]}: addressed-1`, ...[2, 3, 4, 5].flatMap(i => [
      `${playerName}: player-${i}`, `${names[2]}: addressed-${i}`, ...(i >= 3 ? [`${names[0]}: other-${i}`] : []),
    ])].join('\n')
    assert.equal(actual, expected)
    assert(content(writerCalls[0], 1).endsWith(`${playerName}: ${message}`))
    assert(content(writerCalls[0], 0).includes(members[2].group.intimacy!))
    assert(content(writerCalls[0], 0).includes(members[2].group.voice![0]))
    assert(!content(writerCalls[1], 1).includes('Prior 7'))
    assert(content(writerCalls[1], 1).includes('Addressed fresh'))
  }
  await start(); addEvent('narration', 0, 2, 'seed'); await turn()
  assert(content(writerCalls[0], 1).includes('Prior 2'), 'normal history retains seeds')
})
await check('leading player tags strip before empty repeat and copy checks while other and later tags stay', async () => {
  await start(groupTemplate(), 'Sam')
  modelReplies = [`${names[0]}: @sAm, hello\n${names[1]}: @Marco hello`]
  await turn()
  assert.deepEqual((lastData().lines as Row[]).map(line => line.text), ['hello', '@Marco hello'])
  assert(content(writerCalls[0], 0).includes('Never write a message from Sam'))
  for (const [raw, expected] of [['@SAM hello', 'hello'], ['@Sam,hello', 'hello'], ['hello @Sam, friend', 'hello @Sam, friend'], ['@Samwise hello', '@Samwise hello']]) {
    assert.equal(filterLines([{ name: names[0], text: raw }], { ...opts, player: 'Sam' }, emptyLineCounts())[0].text, expected)
  }
  const counts = emptyLineCounts()
  const kept = filterLines([
    { name: names[0], text: '@Sam, ' }, { name: names[0], text: '@Sam, Earlier line' },
    { name: names[0], text: `@Sam, ${members[0].group.voice![0]}` },
  ], { ...opts, player: 'Sam', previous: [{ name: names[0], text: 'Earlier line' }] }, counts)
  assert.deepEqual(kept, []); assert.equal(counts.empty, 1); assert.equal(counts.duplicate, 1); assert.equal(counts.copied_example, 1)
})
await check('repeat check looks back thirty lines for sentences but five for short reactions', () => {
  const counts = emptyLineCounts()
  const older = [{ name: names[0], text: 'A full sentence said earlier today.' }, { name: names[0], text: 'Yes. No. Maybe so. Fine.' }, { name: names[0], text: 'lol' },
    ...Array.from({ length: 6 }, (_, i) => ({ name: names[0], text: `Later line ${i}` }))]
  const kept = filterLines([{ name: names[0], text: 'a full sentence said earlier today.' }, { name: names[0], text: 'yes. no. maybe so. fine.' }, { name: names[0], text: 'lol' }], { ...opts, player: 'Sam', previous: older }, counts)
  assert.deepEqual(kept.map(line => line.text), ['lol']); assert.equal(counts.duplicate, 2)
})
await check('adult carry-over downgrades uninvolved morning tags no names stale participation and autonomy', async () => {
  for (const answer of ['no', 'late', 'error', 'off']) for (const target of ['uninvolved', 'none', 'stale', 'boundary', 'unprompted', 'catchup']) {
    const source = groupTemplate()
    await start(source); put(rows('users')[0], 'preferences.nsfw_enabled', true)
    addEvent('intimate', 0); addEvent('intimate', 1); addEvent('intimate', 1)
    auditEnv.NSFW_SAME_TURN_ROUTER = answer === 'off' ? 'off' : 'on'; routerSexual = false; routerError = answer === 'error'; routerDelay = answer === 'late' ? 2200 : 0
    const origin = target === 'unprompted' || target === 'catchup' ? target : 'player'
    const member = target === 'stale' ? 0 : 2
    const message = target === 'none' ? 'Morning everyone' : target === 'boundary' ? `${names[1]}suffix morning` : `@${names[member]} morning`
    modelReplies = [members.map(member => `${member.name}: Morning reply`).join('\n')]
    await turn({ origin, userMessage: origin === 'player' ? message : '' }, () => 0)
    assert.equal(writerCalls.length, 1); assert.equal(writerCalls[0].model, 'fake-safe'); assert.equal(writerCalls[0].maxTokens, 400)
    assert.equal(content(writerCalls[0], 0), get(rows('worldInstances')[0], 'group_context.static_prompt'))
    assert.equal(rows('events').at(-1)!.type, 'narration')
    assert.equal(checkLogs.at(-1)!.adult_downgrade, origin === 'player' ? 'no_involved_member' : 'autonomous')
    if (answer === 'late' && origin === 'player') await new Promise(resolve => setTimeout(resolve, 250))
  }
})
await check('adult carry-over retains involved tagged or named members and never upgrades or downgrades router yes', async () => {
  for (const answer of ['no', 'late', 'error', 'off', 'yes']) for (const named of [false, true]) {
    await start(); put(rows('users')[0], 'preferences.nsfw_enabled', true)
    addEvent('intimate', 0); addEvent('intimate', 1)
    // Ordinary events after the intimate events must not replace the intimate window.
    addEvent('narration', 2)
    auditEnv.NSFW_SAME_TURN_ROUTER = answer === 'off' ? 'off' : 'on'; routerSexual = answer === 'yes'; routerError = answer === 'error'; routerDelay = answer === 'late' ? 2200 : 0
    const member = answer === 'yes' ? 2 : 0
    modelReplies = [`${names[member]}: Involved response`]
    await turn({ userMessage: `${named ? '' : '@'}${names[member].toLowerCase()}, morning` }, () => 0)
    assert.equal(writerCalls[0].model, 'fake-adult', JSON.stringify({ answer, named, log: checkLogs.at(-1) })); assert.equal(rows('events').at(-1)!.type, 'intimate')
    assert.equal(checkLogs.at(-1)!.adult_downgrade, undefined)
    if (answer === 'late') await new Promise(resolve => setTimeout(resolve, 250))
  }
  await start(); put(rows('users')[0], 'preferences.nsfw_enabled', true)
  addEvent('intimate', 0); auditEnv.NSFW_SAME_TURN_ROUTER = 'on'; routerSexual = false
  modelReplies = [`${names[0]}: Normal response`]
  await turn({ userMessage: `@${names[0]}, morning` }, () => 0)
  assert.equal(writerCalls[0].model, 'fake-safe'); assert.equal(rows('events').at(-1)!.type, 'narration')
})
await check('an action on someone in the last adult turn carries the scene on; a message, someone else, an older turn or toggle off do not', async () => {
  for (const [variant, expected] of [['action', true], ['message', false], ['other', false], ['older', false], ['off', false]] as const) {
    await start(); if (variant !== 'off') put(rows('users')[0], 'preferences.nsfw_enabled', true)
    addEvent('intimate', 0); if (variant === 'older') addEvent('narration', 0)
    auditEnv.NSFW_SAME_TURN_ROUTER = 'on'; routerSexual = false
    const target = variant === 'other' ? 1 : 0
    modelReplies = [`${names[target]}: A reply`]
    await turn({ ...(variant === 'message' ? {} : { kind: 'action' as const }), userMessage: `@${names[target]} I kiss you.` }, () => 0)
    assert.equal(writerCalls[0].model !== 'fake-safe', expected, variant)
    assert.equal(rows('events').at(-1)!.type, expected ? 'intimate' : 'narration', variant)
  }
})
await check('copied addressed example is omitted on same actual writer retry before advancing and normal rescue', async () => {
  for (const transportFallback of [false, true]) {
    const source = groupTemplate(); source.seed_cast![0].group!.voice!.push('Another authored example')
    await adultStart(source)
    const voice = members[0].group.voice![0]
    modelReplies = [...(transportFallback ? [new Error('provider unavailable')] : []), `${names[0]}: @${playerName}, ${voice}`, `${names[0]}: Fresh retry`]
    await turn({ userMessage: `@${names[0]} answer` }, () => 0)
    const copiedAt = transportFallback ? 1 : 0
    assert.equal(writerCalls[copiedAt + 1].model, writerCalls[copiedAt].model)
    assert(content(writerCalls[copiedAt], 0).includes(voice)); assert(!content(writerCalls[copiedAt + 1], 0).includes(voice))
    assert(content(writerCalls[copiedAt + 1], 0).includes('Another authored example'))
    assert(content(writerCalls[copiedAt + 1], 0).includes(members[0].group.intimacy!))
    assert.equal(checkLogs.at(-1)!.copied_example, 1); assert.equal(lastData().ai_response, `${names[0]}: Fresh retry`)
  }
  await adultStart()
  modelReplies = [`${names[0]}: ${members[0].group.voice![0]}`, '', `${names[0]}: Backup fresh`]
  await turn({}, () => 0)
  assert.deepEqual(writerCalls.map(call => call.model), ['fake-adult', 'fake-adult', 'fake-adult-fallback'])
  assert(!content(writerCalls[2], 0).includes(members[0].group.voice![0]))
})
async function authoredGroups(): Promise<WorldTemplateDoc[]> {
  assert(process.env.GROUP_CHAT_DATA_DIR, 'GROUP_CHAT_DATA_DIR is required for authored reachability')
  const dir = process.env.GROUP_CHAT_DATA_DIR
  const files = (await readdir(dir)).filter(file => file.endsWith('.json')).sort()
  // The catalog grows by batches, so the floor is the first three worlds, not a fixed count.
  for (const first of ['alder-lane-watch.json', 'flat-4b.json', 'last-light-guild.json']) assert(files.includes(first), `${first} missing from the catalog`)
  const groups: WorldTemplateDoc[] = []
  for (const file of files) {
    const data = JSON.parse(await readFile(`${dir}/${file}`, 'utf8'))
    validateEntry(data, file)
    groups.push({ ...groupTemplate(), ...data })
  }
  for (const group of groups) assert(group.seed_cast!.length >= 2, `${group.slug} has no real cast`)
  return groups
}
await check('authored player placeholders resolve per call for every addressed prompt', async () => {
  let checked = 0
  const authored = await authoredGroups()
  for (const group of authored) for (const member of group.seed_cast!) {
    for (const player of [playerName, 'Rae $&']) {
      await start(group, player)
      put(rows('users')[0], 'preferences.nsfw_enabled', true)
      auditEnv.NSFW_SAME_TURN_ROUTER = 'on'
      modelReplies = [`${member.name}: A fresh personal answer.`]
      await turn({ userMessage: `@${member.name} answer me` }, never)
      const system = content(writerCalls[0], 0)
      const intimacy = member.group!.intimacy!
      assert(system.includes(`How ${member.name} is about flirting and sex: ${intimacy.replaceAll('{player}', () => player)}`))
      assert(writerCalls.every(call => (call.messages as Row[]).every(message => !String(message.content).includes('{player}'))))
      if (intimacy.includes('{player}')) assert(!system.includes(intimacy), 'unresolved authored address remained')
    }
    checked++
  }
  assert.equal(checked, authored.reduce((sum, group) => sum + group.seed_cast!.length, 0))
  const member = { ...members[0], group: { ...members[0].group, intimacy: 'Interested in {player}; asks {player} directly.' } }
  assert(buildAddressedStatic({ ...template, members, player: 'Rae $&' }, member).includes('Interested in Rae $&; asks Rae $& directly.'))
})
await check('whole Owen message retains a long complete sentence under the adult 280 limit', async () => {
  const group = (await authoredGroups()).find(group => group.seed_cast!.some(member => member.name === 'Owen'))!
  const member = group.seed_cast!.find(member => member.name === 'Owen')!
  await adultStart(group)
  assert(Array.from(owenReply.sentence).length >= 200 && Array.from(owenReply.sentence).length <= 280)
  const full = `${owenReply.sentence} ${owenReply.overflow}`
  assert(Array.from(full).length > 280)
  modelReplies = [{ content: `${member.name}: ${full}`, finishReason: 'stop' }]
  await turn({ userMessage: `@${member.name} answer me` }, never)
  assert.equal(writerCalls[0].maxTokens, 300)
  assert.equal(writerCalls[0].model, 'fake-adult')
  assert.equal((lastData().lines as Row[])[0].text, owenReply.sentence)
  assert((lastData().lines as Row[]).every(line => Array.from(String(line.text)).length <= 280))
  assert.equal(checkLogs.at(-1)!.trimmed, 1)
})
await check('adult repeated opener drops a same-reply line, keeps a match with earlier turns and retries only when empty', async () => {
  for (const scenario of ['remaining', 'retry', 'normal', 'bystander', 'not-interested', 'withdrawn', 'fear']) {
    const source = groupTemplate()
    if (scenario === 'not-interested') source.seed_cast![0].group!.start_bond = 'enemy'
    await adultStart(source)
    addEvent('narration', 0)
    put(rows('events').at(-1)!, 'data.lines', [{ character_id: ids[0], text: 'Familiar start was said before.', shown_at: new Date() }])
    if (scenario === 'normal') auditEnv.NSFW_SAME_TURN_ROUTER = 'off'
    if (scenario === 'fear') { routeUser = { id: playerId, tier: 'creator' }; assert.equal((await bondHttp('PUT', { fear: 70 })).status, 200) }
    if (scenario === 'withdrawn') consentReadHook = () => { put(rows('users')[0], 'preferences.nsfw_enabled', false) }
    const twoLines = `${names[0]}: FAMILIAR, start with different words.
${names[0]}: Familiar start again here.`
    modelReplies = scenario === 'bystander' ? [`${names[1]}: Entirely fresh addressed answer.`, `${names[0]}: Familiar start from the bystander.`]
      : scenario === 'remaining' ? [`${twoLines}
${names[0]}: A complete new answer survives.`]
      : scenario === 'retry' ? [`${names[0]}: Familiar start was said before.`, `${names[0]}: Completely new answer after retry.`]
      : [twoLines]
    if (scenario === 'bystander') put(rows('worldInstances')[0], `group_state.silent_for.${ids[0]}`, 10)
    await turn({ userMessage: scenario === 'bystander' ? `@${names[1]}` : `@${names[0]}` }, never)
    const data = lastData().lines as Row[]
    assert.equal(checkLogs.at(-1)!.repeated_opener, ['remaining', 'not-interested'].includes(scenario) ? 1 : 0, scenario)
    assert.equal(writerCalls.length, scenario === 'retry' || scenario === 'bystander' ? 2 : 1, scenario)
    // The first line matches an earlier turn and stays; only the same-reply repeat goes.
    if (scenario === 'remaining') assert.deepEqual(data.map(line => line.text), ['FAMILIAR, start with different words.', 'A complete new answer survives.'])
    if (['normal', 'withdrawn', 'fear'].includes(scenario)) assert.equal(data.length, 2, scenario)
    if (scenario === 'retry') {
      assert.equal(data[0].text, 'Completely new answer after retry.')
      assert.deepEqual((checkLogs.at(-1)!.writing as Row[]).map(call => call.purpose), ['addressed', 'addressed_retry'])
      assert.equal(writerCalls[1].model, 'fake-adult')
    }
    if (scenario !== 'retry') assert(data.some(line => String(line.text).toLowerCase().includes('familiar')))
  }
})
await check('normal writer seed history expires at two player messages including the current turn across the full chat', async () => {
  for (const origin of ['player', 'unprompted', 'catchup'] as const) for (const priorPlayers of [0, 1, 2]) {
    await start()
    for (let i = 0; i < priorPlayers; i++) {
      addEvent('narration', 1)
      put(rows('events').at(-1)!, 'data.player_input', `Earlier player message ${i}.`)
    }
    await turn({ origin, userMessage: origin === 'player' ? 'Current player message.' : '' }, never)
    const keepsSeed = priorPlayers + (origin === 'player' ? 1 : 0) < 2
    assert.equal(content(writerCalls[0], 1).includes('The authored opening.'), keepsSeed, `${origin}/${priorPlayers}`)
  }
  await start()
  put(rows('events')[0], 'data.player_input', 'Seed player text')
  addEvent('narration', 1)
  addEvent('narration', 1)
  await turn({ userMessage: 'First real player message.' }, never)
  assert(content(writerCalls[0], 1).includes('The authored opening.'), 'seed and nonplayer events do not count as player messages')
  // Player messages may have fallen outside the thirty-event prompt window.
  await start()
  for (let sequence = 2; sequence <= 36; sequence++) {
    addEvent('narration', 1, sequence)
    if (sequence <= 3) put(rows('events').at(-1)!, 'data.player_input', `Old player message ${sequence}.`)
  }
  addEvent('narration', 1, 37, 'seed')
  await turn({ origin: 'unprompted', userMessage: '' }, never)
  assert(!content(writerCalls[0], 1).includes('Prior 37'))
  for (const priorPlayers of [0, 1]) {
    await adultStart()
    if (priorPlayers) { addEvent('narration', 1); put(rows('events').at(-1)!, 'data.player_input', 'Earlier player message.') }
    modelReplies = [`${names[0]}: Fresh addressed answer.`, `${names[1]}: Fresh bystander answer.`]
    put(rows('worldInstances')[0], `group_state.silent_for.${ids[1]}`, 10)
    await turn({ userMessage: `@${names[0]}` }, never)
    assert.equal(content(writerCalls[1], 1).includes('The authored opening.'), priorPlayers === 0)
    assert(content(writerCalls[1], 1).includes('Fresh addressed answer.'))
  }
})
await check('authored tagged reachability covers every member and interest routing through retry rescue and copied voice', async () => {
  let cases = 0
  for (const group of await authoredGroups()) for (const member of group.seed_cast!) {
    for (const scenario of ['normal', 'adult', 'empty', 'rescue', 'voice']) {
      await start(group)
      const adult = scenario !== 'normal'
      put(rows('users')[0], 'preferences.nsfw_enabled', adult)
      auditEnv.NSFW_SAME_TURN_ROUTER = adult ? 'on' : 'off'
      // Kept under three digits: a longer number reads as an invented detail and the line is dropped, rightly.
      const fresh = `${member.name}: Fresh answer for case ${cases % 90}.`
      const chain = ['fake-adult', 'fake-adult-fallback', 'fake-adult-last']
      modelReplies = scenario === 'empty' ? ['', fresh] : scenario === 'rescue' ? [new Error('writer unavailable'), ...chain.slice(1).map(() => ''), '', '', fresh]
        : scenario === 'voice' ? [`${member.name}: ${member.group!.voice![0]}`, fresh] : [fresh]
      await turn({ userMessage: `@${member.name} answer me` }, () => 0).catch(error => { throw new Error(`${group.slug}/${member.name}/${scenario}`, { cause: error }) })
      const card = rows('characters').find(card => card.canonical_name === member.name)!
      assert((lastData().lines as Row[]).some(line => line.character_id === String(card._id)), `${group.slug}/${member.name}/${scenario} never spoke`)
      assert.equal(rows('events').at(-1)!.type, adult ? 'intimate' : 'narration')
      const writing = checkLogs.at(-1)!.writing as Row[]
      const expected = adult ? 'fake-adult' : 'fake-safe'
      assert.equal(writerCalls[0].model, expected)
      if (!adult) {
        assert(writerCalls.every(call => !String(call.model).startsWith('fake-adult')))
        assert(writing.every(call => call.writer === 'normal'))
        assert(String(lastData().model_used).startsWith('fake-safe'))
      }
      if (adult) {
        assert.equal(writerCalls[0].maxTokens, 300)
        assert(content(writerCalls[0], 0).includes(member.group!.intimacy!.replaceAll('{player}', playerName)))
        assert(content(writerCalls[0], 1).includes('Write one to three messages.'))
      }
      if (scenario === 'rescue') {
        const attempts = [chain[0], chain[1], chain[1], chain[2]]
        assert.deepEqual(writerCalls.slice(0, attempts.length).map(call => call.model), attempts)
        assert(writing.some(call => call.purpose === 'addressed_fallback'))
      }
      if (scenario === 'voice') assert.equal(checkLogs.at(-1)!.copied_example, 1, `${group.slug}/${member.name}: ${JSON.stringify(checkLogs.at(-1))}`)
      cases++
    }
  }
  const authored = await authoredGroups()
  assert.equal(cases, 5 * authored.reduce((sum, group) => sum + group.seed_cast!.length, 0))
  console.log(`authored tagged reachability: ${cases}/${cases} cases produced the tagged member's line`)
})
await check('authored untagged reachability picks and speaks every member over 2000 seeded processor rolls per group', async () => {
  let seed = 91
  const rng = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32)
  for (const group of await authoredGroups()) {
    const spoken = new Set<string>()
    for (let roll = 0; roll < 2000; roll++) {
      await start(group)
      modelReplies = [group.seed_cast!.map(member => `${member.name}: A fresh untagged response ${String(roll).replace(/\d/g, digit => 'abcdefghij'[Number(digit)])}.`).join('\n')]
      await turn({ userMessage: 'Anyone around?' }, rng)
      for (const line of lastData().lines as Row[]) {
        const card = rows('characters').find(card => String(card._id) === line.character_id)!
        spoken.add(String(card.canonical_name))
      }
    }
    assert.deepEqual([...spoken].sort(), group.seed_cast!.map(member => member.name).sort(), group.slug)
    console.log(`authored untagged reachability: ${group.slug}, all ${spoken.size} members spoke over 2000 seeded rolls`)
  }
})
await check('processor sentence trim gates token cutoffs normal turns adult addressed and bystanders with counters', async () => {
  await start()
  modelReplies = [{ content: `${names[0]}: Complete. unfinished`, finishReason: 'length' }]
  await turn({ userMessage: `@${names[0]}` })
  assert.equal((lastData().lines as Row[])[0].text, 'Complete.')
  assert.equal(checkLogs.at(-1)!.trimmed, 1)
  await start()
  modelReplies = [{ content: `${names[0]}: unfinished`, finishReason: 'length' }, `${names[0]}: Fresh repair.`]
  await turn({ userMessage: `@${names[0]}` })
  assert.equal((lastData().lines as Row[])[0].text, 'Fresh repair.')
  assert.equal(checkLogs.at(-1)!.trimmed, 1)
  const long = `Short. ${'long '.repeat(70)}`.trim()
  await start(); modelReplies = [`${names[0]}: ${long}`]
  await turn({ userMessage: `@${names[0]}` })
  assert.equal((lastData().lines as Row[])[0].text, long)
  await adultStart()
  modelReplies = [`${names[0]}: ${long}`, `${names[1]}: ${long}`]
  await turn({ userMessage: `@${names[0]} @${names[1]}` })
  assert.deepEqual((lastData().lines as Row[]).map(line => line.text), ['Short.', 'Short.'])
  assert.equal(checkLogs.at(-1)!.trimmed, 2)
})
await check('adult split order models histories budgets records and whole reply; normal turn stays one call', async () => {
  await adultStart()
  const staticBefore = get(rows('worldInstances')[0], 'group_context.static_prompt')
  const seed = rows('events')[0]
  for (let sequence = 2; sequence <= 16; sequence++) rows('events').push({ ...clone(seed), _id: new ObjectId(), sequence,
    data: { model_used: 'fake', player_input: '', lines: [{ character_id: ids[2], text: `history-${sequence}`, shown_at: new Date() }] } })
  modelReplies = [`${names[2]}: Addressed first\n${names[2]}: Addressed second\n${names[2]}: Addressed third`, `${names[0]}: Bystander reply\n${names[0]}: Extra dropped`]
  let rolls = 0
  await turn({ userMessage: `@${names[2]}, answer this` }, () => { rolls++; return rolls <= members.length - 1 ? 0 : 0.75 })
  assert.equal(rolls > 0, true)
  // The first non-addressed rolled speaker is selected by the injected roll.
  assert.deepEqual(writerCalls.map(call => call.model), ['fake-adult', 'fake-safe'])
  assert.deepEqual(writerCalls.map(call => call.maxTokens), [300, 60])
  assert(content(writerCalls[0], 0).includes(members[2].group.intimacy!))
  assert(!content(writerCalls[0], 0).includes(members[1].group.wants))
  assert(!content(writerCalls[0], 1).includes('history-4\n'))
  assert(content(writerCalls[0], 1).includes('history-5\n'))
  assert(!content(writerCalls[1], 1).includes('history-15\n'))
  assert(content(writerCalls[1], 1).includes('history-16\n'))
  assert(content(writerCalls[1], 1).includes('Addressed third'))
  assert.equal((lastData().lines as Row[]).length, 4)
  assert.equal(lastData().model_used, 'fake-adult')
  assert.equal(get(rows('worldInstances')[0], 'group_state.writing_calls'), 2)
  assert.deepEqual(checkLogs.at(-1)!.writing, [
    { writer: 'adult', model: 'fake-adult', purpose: 'addressed' }, { writer: 'normal', model: 'fake-safe', purpose: 'bystander' },
  ])
  assert.equal(checkLogs.at(-1)!.writing_calls, 2)
  assert.equal(get(rows('worldInstances')[0], 'group_context.static_prompt'), staticBefore)
  assert.equal((frames.find(frame => frame.type === 'group_lines')!.lines as Row[]).length, 4)
  await start(); await turn()
  assert.equal(writerCalls.length, 1); assert.equal(writerCalls[0].model, 'fake-safe'); assert.equal(writerCalls[0].maxTokens, 400)
})
await check('adult retry advances only after same writer retries filtered output; empty adult chain reaches normal writer', async () => {
  await adultStart(); modelReplies = [`${names[0]}: *only action*`, `${names[0]}: Retry fresh`]
  await turn({}, () => 0)
  assert.deepEqual(writerCalls.map(call => call.model), ['fake-adult', 'fake-adult'])
  assert.equal(lastData().model_used, 'fake-adult')
  assert.equal(checkLogs.at(-1)!.stage_directions, 1); assert.equal(checkLogs.at(-1)!.empty, 1)
  assert.equal((checkLogs.at(-1)!.writing as Row[])[1].purpose, 'addressed_retry')
  await adultStart(); modelReplies = ['', '', '', `${names[0]}: Normal rescue`]
  await turn({}, () => 0)
  assert.deepEqual(writerCalls.map(call => call.model), ['fake-adult', 'fake-adult', 'fake-adult-fallback', 'fake-safe'])
  assert(lastData().ai_response!.toString().includes('Normal rescue'))
  assert.equal(get(rows('worldInstances')[0], 'group_state.writing_calls'), 4)
  await adultStart(); put(rows('worldTemplates')[0], 'model_preferences.narration_nsfw', ' fake-adult-fallback ')
  modelReplies = ['', '', `${names[0]}: Deduplicated retry`]
  await turn({}, () => 0)
  assert.deepEqual(writerCalls.map(call => call.model), ['fake-adult-fallback', 'fake-adult-fallback', 'fake-adult-last'])
})
await check('adult template preference wins and transport fallbacks are counted with per-call consent', async () => {
  await adultStart(); put(rows('worldTemplates')[0], 'model_preferences.narration_nsfw', 'template-adult')
  modelReplies = [new Error('provider unavailable'), new Error('second unavailable'), `${names[0]}: Last writer fresh`]
  await turn({}, () => 0)
  assert.deepEqual(writerCalls.map(call => call.model), ['template-adult', 'fake-adult-fallback', 'fake-adult-last'])
  assert.equal(lastData().model_used, 'fake-adult-last')
  assert.equal(get(rows('worldInstances')[0], 'group_state.writing_calls'), 3)
  assert.equal((checkLogs.at(-1)!.writing as Row[]).length, 3)
})
await check('adult consent withdrawn before first call, retry or transport fallback never reaches adult again; noncapable stays normal', async () => {
  for (const at of ['first', 'retry', 'transport'] as const) {
    await adultStart()
    if (at === 'first') { let reads = 0; consentReadHook = () => { if (++reads === 2) put(rows('users')[0], 'preferences.nsfw_enabled', false) } }
    else writerHook = () => { put(rows('users')[0], 'preferences.nsfw_enabled', false) }
    modelReplies = at === 'first' ? [`${names[0]}: Normal from start`] : [at === 'transport' ? new Error('unavailable') : '', `${names[0]}: Normal after withdrawal`]
    await turn({}, () => 0)
    assert.deepEqual(writerCalls.map(call => call.model), at === 'first' ? ['fake-safe'] : ['fake-adult', 'fake-safe'])
    assert((checkLogs.at(-1)!.writing as Row[]).slice(at === 'first' ? 0 : 1).every(call => call.writer === 'normal'))
  }
  for (const enabled of [false, true]) {
    await adultStart(); put(rows('users')[0], 'preferences.nsfw_enabled', enabled)
    rows('worldTemplates')[0].is_nsfw_capable = false
    addEvent('intimate', 0); addEvent('intimate', 0)
    await turn({ userMessage: `@${names[0]} morning` }, () => 0); assert(writerCalls.every(call => call.model === 'fake-safe'))
  }
})
for (const interested of [true, false]) await check(`${interested ? 'interested' : 'not-interested'} addressed prompt follows fresh consent before every call`, async () => {
  for (const withdrawn of [false, true]) for (const at of ['first', 'retry', 'transport'] as const) {
    const source = clone(groupTemplate())
    source.seed_cast![0].group!.start_bond = interested ? 'friend' : 'enemy'
    await start(source)
    put(rows('users')[0], 'preferences.nsfw_enabled', true)
    auditEnv.NSFW_SAME_TURN_ROUTER = 'on'
    let reads = 0
    const readsAtCall: number[] = []
    consentReadHook = () => {
      reads++
      if (withdrawn && at === 'first' && reads === 2) put(rows('users')[0], 'preferences.nsfw_enabled', false)
    }
    writerHook = () => {
      readsAtCall.push(reads)
      if (withdrawn && at !== 'first') put(rows('users')[0], 'preferences.nsfw_enabled', false)
    }
    const answer = `${names[0]}: Fresh consent reply.`
    modelReplies = at === 'first' ? [answer] : [at === 'transport' ? new Error('429 unavailable') : '', answer]
    await turn({}, () => 0)
    assert.deepEqual(readsAtCall, at === 'first' ? [2] : [2, 3], 'each call needs a fresh read after the route read')
    assert.deepEqual(writerCalls.map(call => call.model), at === 'first'
      ? [!withdrawn ? 'fake-adult' : 'fake-safe']
      : ['fake-adult', withdrawn ? 'fake-safe' : at === 'transport' ? 'fake-adult-fallback' : 'fake-adult'])
    for (const [index, call] of writerCalls.entries()) {
      const allowed = !withdrawn || (at !== 'first' && index === 0)
      const system = content(call, 0)
      assert.equal(system.includes(`You are writing only ${names[0]}'s messages`), allowed)
      assert.equal(system.includes(`How ${names[0]} is about flirting and sex: ${members[0].group.intimacy}`), allowed)
      assert.equal(system.includes('as explicitly and crudely as'), allowed)
      if (!allowed) {
        assert.equal(system, get(rows('worldInstances')[0], 'group_context.static_prompt'))
        assert(members.every(member => !system.includes(member.group.intimacy!)))
      }
      assert.equal(call.maxTokens, allowed ? 300 : 60)
      assert(content(call, 1).includes(allowed ? 'Write one to three messages.' : 'Each writes one short message.'))
      assert.equal(content(call, 1).includes('Write one to three messages.'), allowed)
      assert(content(call, 1).includes(`${playerName}: A player message`))
    }
    assert.equal(lastData().ai_response, answer)
    assert.equal((frames.find(frame => frame.type === 'group_lines')!.lines as Row[]).length, 1)
  }
})
await check('adult optional failure preserves fresh reply and other tags get repair plus last backup attempt', async () => {
  await adultStart(); modelReplies = [`${names[0]}: Addressed survives`, new Error('429 failed bystander'), new Error('429 failed backup')]
  let draw = 0
  await turn({}, () => ++draw <= members.length ? 0 : 0.9)
  assert(lastData().ai_response!.toString().includes('Addressed survives'))
  assert.equal(writerCalls.length, 3)
  await adultStart(); modelReplies = [`${names[0]}: Another addressed reply`, new Error('optional failure')]
  draw = 0; await turn({}, () => ++draw <= members.length ? 0 : 0.9)
  assert(lastData().ai_response!.toString().includes('Another addressed reply')); assert.equal(writerCalls.length, 2)
  await adultStart(); modelReplies = [`${names[3]}: Addressed tag`, '', '', '', `${names[1]}: Backup tag`]
  await turn({ userMessage: `@${names[3]} then @${names[1]}` }, () => 0)
  assert.deepEqual(writerCalls.map(call => call.model), ['fake-adult', 'fake-adult', 'fake-adult', 'fake-safe', 'fake-safe-fallback'])
  assert(content(writerCalls[0], 0).includes(members[3].group.intimacy!))
  assert(content(writerCalls[1], 1).includes(`Only these people write in this reply: ${names[1]}.`))
  assert.equal((lastData().lines as Row[]).length, 2)
  assert.equal((checkLogs.at(-1)!.writing as Row[]).at(-1)!.purpose, 'tag_backup')
  await adultStart(); modelReplies = [`${names[3]}: First of three tags`, `${names[0]}: First other tag`, `${names[1]}: Second other tag`]
  await turn({ userMessage: `@${names[3]} @${names[0]} @${names[1]}` }, () => 0)
  assert.equal(writerCalls.length, 3); assert.equal(writerCalls[1].maxTokens, 300); assert.equal((lastData().lines as Row[]).length, 3)
  await start(); modelReplies = [`${names[0]}: Normal reply`, '', `${names[1]}: Last chance normal tag`]
  await turn({ userMessage: `@${names[1]}` })
  assert.deepEqual(writerCalls.map(call => call.model), ['fake-safe', 'fake-safe', 'fake-safe-fallback'])
  await start(); modelReplies = [`${names[0]}: Fresh but missing tag`, '', '']
  await assert.rejects(turn({ userMessage: `@${names[1]}` }), /could not finish/)
})
await check('group router waits for player intent and late answers fall through after two seconds; autonomy never asks', async () => {
  await start(); put(rows('users')[0], 'preferences.nsfw_enabled', true)
  auditEnv.NSFW_SAME_TURN_ROUTER = 'on'; routerDelay = 20
  await turn({}, () => 0)
  assert.equal(routerRequests, 1); assert.equal(writerCalls[0].model, 'fake-adult')
  assert.equal((checkLogs.at(-1)!.routing as Row).settled, true)
  await start(); put(rows('users')[0], 'preferences.nsfw_enabled', true)
  auditEnv.NSFW_SAME_TURN_ROUTER = 'on'; routerDelay = 2200
  const began = Date.now()
  await turn({}, () => 0)
  assert(Date.now() - began >= 1950 && Date.now() - began < 2150)
  assert.equal(writerCalls[0].model, 'fake-safe')
  assert.equal((checkLogs.at(-1)!.routing as Row).fallback, 'late')
  await new Promise(resolve => setTimeout(resolve, 250))
  assert.equal((checkLogs.at(-1)!.routing as Row).fallback, 'late')
  for (const [capable, enabled] of [[true, false], [false, true]]) {
    await start(); rows('worldTemplates')[0].is_nsfw_capable = capable; put(rows('users')[0], 'preferences.nsfw_enabled', enabled)
    auditEnv.NSFW_SAME_TURN_ROUTER = 'on'; await turn(); assert.equal(routerRequests, 0); assert.equal(writerCalls[0].model, 'fake-safe')
  }
  for (const origin of ['unprompted', 'catchup'] as const) {
    await start(); put(rows('users')[0], 'preferences.nsfw_enabled', true); auditEnv.NSFW_SAME_TURN_ROUTER = 'on'
    await turn({ origin, userMessage: '' }); assert.equal(routerRequests, 0)
  }
})
await check('private adult traits absent recursively wherever player cast is returned', async () => {
  await start(); await turn()
  const payload = publicGroupData({ seed_cast: template.seed_cast, nested: { cast: members, list: [{ group: members[0].group }] } })
  forbidden(payload)
  const loaded = await generationService.loadInstance(instanceId, playerId); forbidden(loaded)
  forbidden(await instanceService.getById(instanceId, playerId))
  forbidden(await instanceService.listRealms(playerId))
  forbidden(await instanceService.list(playerId))
  for (const frame of frames) forbidden(frame)
})

await check('event cadence stages memory every five and summaries every twelve; history/load leak no internals', async () => {
  await start(); put(rows('worldInstances')[0], 'group_state.writing_calls', 199)
  for (let i = 0; i < 12; i++) await turn()
  assert.deepEqual(outbox.map(row => row.kind), ['memory_curation', 'memory_curation', 'scene_summary'])
  assert.deepEqual(outbox.map(row => get(row, 'payload.eventId')), [rows('events')[5]._id, rows('events')[10]._id, rows('events')[12]._id].map(String))
  assert.equal(get(outbox[0], 'payload.playerInput'), undefined)
  const loaded = await generationService.loadInstance(instanceId, playerId)
  forbidden(loaded); assert(loaded.recentEvents.some(event => event.data.lines?.length))
  assert((await instanceService.getById(instanceId, playerId))?.group_state === undefined)
  forbidden(await instanceService.listRealms(playerId))
  const socketFrames: Row[] = []
  await playWsService.handleMessage({ send: text => { socketFrames.push(JSON.parse(text)) }, close: unavailable,
    data: { _user: { id: playerId, tier: 'creator' }, jwt: { verify: async () => false } } }, { action: 'load_instance', instance_id: instanceId })
  assert.equal(socketFrames[0].type, 'instance_loaded'); forbidden(socketFrames[0])
})
await check('group replay is refused before dispatch; zero-charge reservation is idempotent', async () => {
  await start(); await turn()
  await assert.rejects(generationService.dispatchReplay({ instanceId, playerId, eventId: (rows('events')[1]._id as ObjectId).toHexString() }), /not available/)
  await billingService.reserveGroupTurn(playerId, 'same-request'); await billingService.reserveGroupTurn(playerId, 'same-request')
  assert.equal(rows('inkLedger').length, 1); assert.equal(rows('inkLedger')[0].delta, 0)
})
await check('existing socket chat reserves a story turn and dispatches the group job', async () => {
  await start()
  const reserve = billingService.reserve
  let reservations = 0
  billingService.reserve = async (_player, action) => { assert.equal(action, 'story_turn'); reservations++; return { reservation_id: 'fixture-reservation', cost: 0, balance: null } }
  try {
    const socketFrames: Row[] = []
    await playWsService.handleMessage({ send: text => { socketFrames.push(JSON.parse(text)) }, close: unavailable,
      data: { _user: { id: playerId, tier: 'creator' }, jwt: { verify: async () => false } } }, { action: 'chat', instance_id: instanceId, payload: { message: 'Socket chat message' } })
    assert.equal(reservations, 1); assert.equal(queued.length, 1)
    assert.equal(queued[0].userMessage, 'Socket chat message'); assert.equal((queued[0].session as Row).kind, 'group')
    assert.equal(queued[0].billingReservationId, 'fixture-reservation')
    assert(!socketFrames.some(frame => frame.type === 'error'))
  } finally { billingService.reserve = reserve }
})
await check('save and account deletion clear group events and all private state', async () => {
  await start(); await turn()
  await deletionService.deleteInstance(instanceId, playerId)
  assert.equal(rows('worldInstances').length, 0); assert.equal(rows('events').length, 0)
  await start(); await turn()
  await deletionService.deleteAccount(playerId)
  assert.equal(rows('users').length, 0); assert.equal(rows('worldInstances').length, 0); assert.equal(rows('events').length, 0)
})
await check('real rewind restores group snapshot and preserves historical character ids', async () => {
  const child = Bun.spawn(['bun', '--no-env-file', 'run', 'scripts/codex-media-carryover-audit.ts'], { stdout: 'pipe', stderr: 'pipe', cwd: new URL('..', import.meta.url).pathname })
  const output = await new Response(child.stdout).text(), errors = await new Response(child.stderr).text()
  assert.equal(await child.exited, 0, output + errors)
  assert(output.includes('PASS group rewind restores silence/topic/writing snapshot'))
})
await check('existing discovery, recommendations, genre shelves and starters exclude groups; explicit kind returns them', async () => {
  await start()
  const world = { ...groupTemplate(), _id: new ObjectId(), kind: 'world', starter: true, title: 'An ordinary world' }
  rows('worldTemplates').push(world as unknown as Row)
  rows('worldTemplates')[0].starter = true
  assert.equal((await templateService.listPublished(1, 20, undefined, undefined, { sort: 'new' })).templates.length, 1)
  const groups = await templateService.listPublished(1, 20, undefined, undefined, { kind: 'group', sort: 'new' })
  assert.equal(groups.templates.length, 1); assert.equal(groups.templates[0].kind, 'group')
  assert.equal((await templateService.starter(playerId))?.kind, 'world')
  const creatorId = template.creator_id.toHexString()
  const sent: Row[] = []
  templateFindHook = filter => sent.push(clone(filter))
  let mine, groupsMine
  try {
    mine = await templateService.listByCreator(creatorId)
    groupsMine = await templateService.listByCreator(creatorId, 1, 20, undefined, 'group')
  } finally { templateFindHook = undefined }
  // Without kind the creator's list is unchanged: the group is left out, and the
  // world says what it is. Asking for kind=group returns only the groups.
  assert.equal(mine.templates.length, 1); assert.equal(mine.templates[0].kind, 'world')
  assert.equal(mine.total, 1)
  assert.equal(groupsMine.templates.length, 1); assert.equal(groupsMine.templates[0].kind, 'group')
  assert.equal(groupsMine.total, 1)
  // Both paths send their own filter, so the result comes from the query, not from
  // a post-read filter over everything.
  assert.equal(sent.length, 2)
  assert((sent[0].creator_id as ObjectId).equals(template.creator_id))
  assert.deepEqual(sent[0].kind, { $ne: 'group' })
  assert.equal(sent[1].kind, 'group')
  // Search and paging narrow inside whichever kind was asked for.
  assert.equal((await templateService.listByCreator(creatorId, 1, 20, 'Test Group')).templates.length, 0)
  assert.equal((await templateService.listByCreator(creatorId, 1, 20, 'Test Group', 'group')).templates.length, 1)
  assert.equal((await templateService.listByCreator(creatorId, 1, 20, 'ordinary')).templates.length, 1)
  assert.equal((await templateService.listByCreator(creatorId, 1, 20, 'ordinary', 'group')).templates.length, 0)
  assert.equal((await templateService.listByCreator(creatorId, 2, 1)).templates.length, 0)
  assert.equal((await templateService.listByCreator(creatorId, 2, 1, undefined, 'group')).templates.length, 0)
  const genres = await templateService.listGenres(undefined, Date.now() + 120000)
  assert.equal(genres.genres.reduce((sum, genre) => sum + genre.worlds + genre.characters, 0), 1)
})
await check('creator list route takes kind=group only and leaves groups out without it', async () => {
  await start()
  const world = { ...groupTemplate(), _id: new ObjectId(), kind: 'world', starter: true }
  rows('worldTemplates').push(world as unknown as Row)
  const { templateRoutes } = await import('../src/routes/template.routes')
  const app = new Elysia().use(templateRoutes)
  const list = (query: string) => app.handle(new Request(`http://localhost/templates/mine/list${query}`))
  routeUser = { id: template.creator_id.toHexString(), tier: 'creator' }
  try {
    const plain = await list('')
    assert.equal(plain.status, 200)
    const plainBody = await plain.json() as { templates: Row[] }
    assert.deepEqual(plainBody.templates.map(item => item.kind), ['world'])
    const groups = await list('?kind=group')
    assert.equal(groups.status, 200)
    const groupBody = await groups.json() as { templates: Row[] }
    assert.deepEqual(groupBody.templates.map(item => item.kind), ['group'])
    // The schema is the authority: only the group value exists on this route.
    assert.equal((await list('?kind=world')).status, 422)
    assert.equal((await list('?kind=character')).status, 422)
  } finally { routeUser = null }
})
await check('story prompt fixed fixture hashes unchanged; only group kind hands off; no authored group identities in product code', async () => {
  const story = await readFile(new URL('../worker/processors/generation.processor.ts', import.meta.url), 'utf8')
  assert(story.includes("if (dispatchedSession.kind === 'group')")); assert.equal((story.match(/return groupTurnProcessor\(job\)/g) || []).length, 1)
  const probe = Bun.spawn(['bun', '--no-env-file', 'run', 'scripts/prompt-part-hash-audit.ts'], { stdout: 'pipe', stderr: 'pipe', cwd: new URL('..', import.meta.url).pathname })
  const output = await new Response(probe.stdout).text(), errors = await new Response(probe.stderr).text()
  assert.equal(await probe.exited, 0, output + errors); assert(output.includes('pre-change messages byte for byte'))
  const originalStory = story.replace("import { groupTurnProcessor } from './group-turn.processor'\n", '').replace("  if (dispatchedSession.kind === 'group') {\n    if (!(await liveInstanceExists(parseObjectId(instanceId)))) return\n    return groupTurnProcessor(job)\n  }\n\n", '')
  assert.equal(createHash('sha256').update(originalStory).digest('hex'), '6b9d06b57d646a5e8f8770e4e3ddafe86b270868bca1e830947133a7241bd69e')
  const before = await readFile(new URL('../src/utils/prompt-builder.ts', import.meta.url), 'utf8')
  assert.equal(createHash('sha256').update(before.replace('export const NARRATIVE_BOUNDARIES', 'const NARRATIVE_BOUNDARIES')).digest('hex'), 'b680d417ece807f9a37431ffe195ae3b8f13d93a2567592f157772ec1ede8043')
  console.log(`story builder source sha256 ${createHash('sha256').update(before.replace('export const NARRATIVE_BOUNDARIES', 'const NARRATIVE_BOUNDARIES')).digest('hex')}`)
  // Data is external to this isolated checkout; the caller can supply its path.
  const dataDir = process.env.GROUP_CHAT_DATA_DIR
  if (dataDir) {
    const authored = (await readdir(dataDir)).filter(file => file.endsWith('.json'))
    // Titles, slugs and the first three casts stay barred everywhere. Everyone else's first name is barred
    // in group chat code only: the story engine's prompts use ordinary names (Ash, Bram) as worked examples.
    const FIRST = new Set(['alder-lane-watch', 'flat-4b', 'last-light-guild'])
    const labels: string[] = []
    const groupLabels: string[] = []
    for (const file of authored) { const group = JSON.parse(await readFile(`${dataDir}/${file}`, 'utf8')); const cast = group.seed_cast.map((member: { name: string }) => member.name); labels.push(group.title, group.slug, ...(FIRST.has(group.slug) ? cast : [])); groupLabels.push(...cast); validateEntry(group, file) }
    async function visit(path: string) { for (const entry of await readdir(path, { withFileTypes: true })) { const next = `${path}/${entry.name}`; if (entry.isDirectory()) await visit(next); else if (entry.name.endsWith('.ts')) { const source = await readFile(next, 'utf8'); for (const label of /group-chat|group-|group_/.test(next.split('/').slice(-2).join('/')) ? [...labels, ...groupLabels] : labels) assert(!new RegExp(`(?<![A-Za-z])${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z])`).test(source), `${next} names ${label}`) } } }
    await visit(new URL('../src', import.meta.url).pathname); await visit(new URL('../worker', import.meta.url).pathname)
    console.log(`validated ${authored.length} authored groups; identity scan passed`)
  }
})

// Memory checks inspect the real queued processors, persisted atoms/vectors and writer requests.
function storedEvents() { return rows('events') as unknown as import('../src/models/world-event.model').WorldEventDoc[] }
function numbered(request = curatorRequests.at(-1)!) {
  const body = (request.messages as Array<{ content: string }>)[1].content
  return body.split('\n').flatMap(line => {
    const match = /^(\d+)\. (\{.*\})$/.exec(line)
    return match ? [{ number: Number(match[1]), ...JSON.parse(match[2]) as { speaker: string; text: string } }] : []
  })
}
function atom(text: string, subject: string, citation: number, patch: Row = {}) {
  return { text, type: 'observation', importance: 4, is_nsfw: false, subjects: [subject], objects: [],
    unresolved_thread: false, retrieval_terms: [], source_messages: [citation], ...patch }
}
function memoryJob(event = storedEvents().at(-1)!) {
  return { data: { instanceId, playerId, eventId: String(event._id), groupMemory: true, sceneTag: 'dialogue' } } as Job
}
function addEvents(count: number, speaker = members[0]) {
  const last = storedEvents().at(-1)!
  for (let i = 1; i <= count; i++) rows('events').push({ ...clone(last) as unknown as Row, _id: new ObjectId(), sequence: last.sequence + i,
    data: { player_input: `Filler ${last.sequence + i}`, ai_response: `${speaker.name}: filler ${i}`, model_used: 'fake-safe', origin: 'player',
      lines: [{ character_id: speaker.id, text: `filler ${last.sequence + i}`, shown_at: new Date() }],
      state_mutations: {}, flag_mutations: {}, group_state_after: clone(get(rows('worldInstances')[0], 'group_state')) } })
}
async function identityBatch() {
  await start(); addEvents(5)
  const events = storedEvents()
  events[2].data.lines![0].text = 'My sister is a pilot.'
  events[3].data.lines = [{ character_id: ids[1], text: 'My sister is a painter.', shown_at: new Date() }]
  events[4].data.player_input = 'My sister is getting married in June.'
  curatorFactory = request => ({ memories: numbered(request).filter(message => message.text.startsWith('My sister')).map(message =>
    atom(`${message.speaker}'s sister: ${message.text}`, message.speaker, message.number, { objects: [`${message.speaker}'s sister`] })), entities: [] })
  await memoryProcessor(memoryJob())
  return events
}
await check('memory numbered speakers preserve three sister owners and exact per-atom provenance without ids or player payloads', async () => {
  const events = await identityBatch()
  const body = (curatorRequests[0].messages as Array<{ content: string }>)[1].content
  assert(body.includes(`The human player is "${playerName}"`)); assert(body.includes('"my" belong to the speaker'))
  assert(!body.includes('GM world') && !body.includes('Player (raw input):') && !body.includes('World:'))
  for (const event of events) assert(!JSON.stringify(curatorRequests[0]).includes(String(event._id)))
  assert.deepEqual(rows('memories').map(memory => memory.subjects), [[names[0]], [names[1]], ['player']])
  assert.deepEqual(rows('memories').map(memory => memory.objects), [names[0], names[1], playerName].map(name => [`${name}'s sister`]))
  assert.deepEqual(rows('memories').map(memory => (memory.source_event_ids as ObjectId[]).map(String)), [events[2], events[3], events[4]].map(event => [String(event._id)]))
  assert.equal(vectors.size, 3); assert(!frames.some(frame => frame.type === 'memories_curated'))
  assert.equal(get(rows('worldInstances')[0], 'group_state.curated_through_sequence'), 6)
  assert(backgroundScopes.some(scope => scope.instance_id === instanceId && scope.event_id === String(events[5]._id)))
  assert.equal(curatorRequests[0].purpose, 'memory_curation')
})
await check('memory group prompt and required schema request preserve small personal facts and citations', async () => {
  await identityBatch()
  const request = curatorRequests[0]
  const system = (request.messages as Array<{ content: string }>)[0].content
  assert(system.includes('numbered conversation among several people'))
  assert(system.includes('family, work, health, plans and promises'))
  assert(system.includes('even when it looks small'))
  assert(system.includes('one fact per atom'))
  assert(!system.includes('0-3') && !system.includes('10+ turns') && !system.includes('one exchange'))
  assert(system.includes('"source_messages"'))
  const item = get(request, 'responseSchema.properties.memories.items') as Row
  assert((item.required as string[]).includes('source_messages'))
  assert.equal(get(item, 'properties.source_messages.type'), 'array')
  assert.equal(get(item, 'properties.source_messages.minItems'), 1)
  assert.equal(get(item, 'properties.source_messages.items.type'), 'integer')
  assert.equal(get(item, 'properties.source_messages.items.minimum'), 1)
  const { buildChatRequest } = await import('../src/ai/client')
  const transport = buildChatRequest(request as unknown as Parameters<typeof buildChatRequest>[0]).params
  assert.equal(transport.response_format.type, 'json_schema')
  assert.equal(transport.response_format.json_schema.strict, true)
  assert.deepEqual(transport.response_format.json_schema.schema, request.responseSchema)
  assert.equal(transport.provider.require_parameters, true)
  assert.equal(transport.model, request.model)
  const fixture = { memories: [atom('A cited fact.', playerName, 1)] }
  assert.equal((curatorResponse({ ...request, responseSchema: undefined }, fixture) as { memories: Row[] }).memories[0].source_messages, undefined)
  assert.deepEqual((curatorResponse(request, fixture) as { memories: Row[] }).memories[0].source_messages, [1])
  assert.equal((curatorResponse({ ...request, responseSchema: undefined }, JSON.stringify(fixture)) as { memories: Row[] }).memories[0].source_messages, undefined)
  // Both arrays canonicalize exact names ignoring case; relatives and other people stay distinct.
  await start(); addEvents(5)
  curatorFactory = () => ({ memories: [atom('A personal fact.', playerName.toUpperCase(), 1,
    { objects: [playerName.toLowerCase(), `${playerName}'s sister`, names[0]] })] })
  await memoryProcessor(memoryJob())
  assert.deepEqual(rows('memories')[0].subjects, ['player'])
  assert.deepEqual(rows('memories')[0].objects, ['player', `${playerName}'s sister`, names[0]])
})
await check('memory a player line on an adult turn is kept as an adult fact and hidden when the toggle is off', async () => {
  await start(); addEvents(5); storedEvents()[4].type = 'intimate'
  curatorFactory = request => ({ memories: [atom('Said in the scene.', names[0], numbered(request).find(message => message.text === storedEvents()[4].data.player_input)!.number)] })
  await memoryProcessor(memoryJob())
  assert.equal(rows('memories')[0].text, 'Said in the scene.')
  assert.equal(rows('memories')[0].is_nsfw, true); assert.equal(rows('memories')[0].explicit_fact, undefined)
  await start(); addEvents(5)
  curatorFactory = request => ({ memories: [atom('Asked about his cock.', names[0], numbered(request)[0].number, { is_nsfw: true })] })
  await memoryProcessor(memoryJob()); assert.equal(rows('memories')[0].explicit_fact, true)
  await start(); addEvents(5); storedEvents()[4].type = 'intimate'
  curatorFactory = request => ({ memories: [atom('Said in the scene.', names[0], numbered(request).find(message => message.text === storedEvents()[4].data.player_input)!.number)] })
  await memoryProcessor(memoryJob())
  const hidden = await groupWriterMemory({ instanceId: new ObjectId(instanceId), player: playerName, speakers: [names[0]], enabled: false, memories: [], openThreads: [] })
  assert(!hidden.memories.includes('Said in the scene.'))
  const shown = await groupWriterMemory({ instanceId: new ObjectId(instanceId), player: playerName, speakers: [names[0]], enabled: true, memories: [], openThreads: [] })
  assert(shown.memories.includes('Said in the scene.'))
})
await check('memory invalid citations and malformed atoms are dropped and counted; empty invalid results fail', async () => {
  await start(); addEvents(5)
  curatorFactory = request => ({ memories: [atom('A valid fact.', 'player', numbered(request)[0].number),
    ...[0, -1, 999, 1.5, '1', null].map(citation => atom('Invalid citation.', 'player', citation as number)),
    atom('Malformed atom.', 'player', 1, { importance: '5' })] })
  await memoryProcessor(memoryJob())
  assert.equal(rows('memories').length, 1)
  assert(memoryLogs.some(row => row.name === 'group.memory_batch' && row.invalidCitations === 6 && row.invalidAtoms === 1 && row.success === true))
  for (const bad of ['broken json', { memories: [] }, { memories: [atom('Bad.', 'player', 1000)] }, null, { memories: [null] }]) {
    await start(); addEvents(5); curatorReply = bad
    await assert.rejects(memoryProcessor(memoryJob()), /Group curator/)
    assert.equal(get(rows('worldInstances')[0], 'group_state.curated_through_sequence'), 1)
  }
})
await check('memory exact details: a lost code keeps the player words, a held one does not', async () => {
  const batch = (text: string, name = playerName) => ({ player: playerName, messages: [{ name, text, number: 4, eventId: new ObjectId(), adult: false }] })
  const kept = missedDetailAtoms(batch('my code was ORCHARD'), [{ text: 'Sam was fired.' }], [])
  assert.deepEqual(kept.map(atom => [atom.text, atom.source_messages, atom.subjects, atom.is_nsfw]), [[`${playerName} said: my code was ORCHARD`, [4], ['player'], false]])
  assert.equal(missedDetailAtoms(batch('pin 4471'), [{ text: 'The pin is 4471.' }], []).length, 0)
  assert.equal(missedDetailAtoms(batch('my code was ORCHARD'), [{ text: 'The code is Orchard.' }], []).length, 0)
  assert.equal(missedDetailAtoms(batch('pin 4471'), [], ['The pin is 4471.']).length, 0)
  assert.equal(missedDetailAtoms(batch('see you at 5'), [], []).length, 0)
  assert.equal(missedDetailAtoms(batch('pin 4471', names[0]), [], []).length, 0)
  assert.equal(missedDetailAtoms({ player: playerName, messages: [{ ...batch('fuck me at 2am').messages[0], adult: true }] }, [], [])[0].is_nsfw, true)
  await start(); addEvents(5)
  curatorFactory = request => ({ memories: [atom('A valid fact.', 'player', numbered(request)[0].number)] })
  const last = rows('events').at(-1)!
  last.data.player_input = 'the alarm code is 9317'
  await memoryProcessor(memoryJob())
  assert(rows('memories').some(memory => memory.text === `${playerName} said: the alarm code is 9317` && memory.source_event_ids.some((id: ObjectId) => String(id) === String(last._id))))
  await memoryProcessor(memoryJob())
  assert.equal(rows('memories').filter(memory => String(memory.text).includes('9317')).length, 1)
})
await check('memory exact details: audience and earlier facts decide what is kept', async () => {
  const curated = () => { curatorFactory = request => ({ memories: [atom('A valid fact.', 'player', numbered(request)[0].number)] }) }
  // Told in a direct message: the kept words are private to that thread.
  await start(); addEvents(5); curated()
  for (const event of storedEvents().slice(1)) event.data.dm_with = ids[0]
  storedEvents().at(-1)!.data.player_input = 'the alarm code is 9317'
  await memoryProcessor(memoryJob())
  assert.equal(rows('memories').find(memory => String(memory.text).includes('9317'))!.private_to, ids[0])
  // A fact only one thread holds can't stand in for one the group thread needs.
  await start(); addEvents(5); curated()
  storedEvents().at(-1)!.data.player_input = 'the alarm code is 9317'
  rows('memories').push({ _id: new ObjectId(), instance_id: new ObjectId(instanceId), text: 'A private alarm fact, 9317.', private_to: ids[0], is_archived: false, source_event_ids: [] })
  await memoryProcessor(memoryJob())
  assert(rows('memories').some(memory => memory.text === `${playerName} said: the alarm code is 9317` && !('private_to' in memory)))
  // A shared fact in other words already holds it.
  await start(); addEvents(5); curated()
  storedEvents().at(-1)!.data.player_input = 'the alarm code is 9317'
  rows('memories').push({ _id: new ObjectId(), instance_id: new ObjectId(instanceId), text: 'The flat alarm is 9317.', is_archived: false, source_event_ids: [] })
  await memoryProcessor(memoryJob())
  assert(!rows('memories').some(memory => String(memory.text).includes('said:')))
})
await check('memory adult direct turn gets what the player told her, whatever the wording', async () => {
  await start()
  const thread = ids[0], source = storedEvents()[0]
  source.data.dm_with = thread
  const push = (text: string, subjects: string[], extra: Row = {}) => rows('memories').push({ _id: new ObjectId(), instance_id: new ObjectId(instanceId), player_id: new ObjectId(playerId),
    text, subjects, objects: [], source_event_ids: [source._id], private_to: thread, is_nsfw: false, is_archived: false, importance: 3, updated_at: new Date(), ...extra })
  push('Her cousin lives by the harbour.', ['player'])
  push('Also a fact under the player name.', [playerName])
  push('She spent an hour on the phone.', [names[0]])
  const read = (over: Row = {}) => groupWriterMemory({ instanceId: new ObjectId(instanceId), player: playerName, speakers: [names[0]], enabled: true, thread, memories: [], openThreads: [], raisedBy: 'who else knows', ...over })
  let shown = (await read()).memories
  assert(shown.includes('Her cousin lives by the harbour.')); assert(shown.includes('Also a fact under the player name.'))
  assert(!shown.includes('She spent an hour on the phone.'))
  // The narrow prompt stays narrow: a cap, the most important first, and only on direct turns.
  for (let i = 0; i < GROUP_ADULT_DIRECT_LINES + 2; i++) push(`Filler told fact ${i}.`, ['player'], { importance: 1 })
  push('The most important told fact.', ['player'], { importance: 5, updated_at: new Date(0) })
  shown = (await read()).memories
  assert.equal(shown.length, GROUP_ADULT_DIRECT_LINES); assert.equal(shown[0], 'The most important told fact.')
  assert.deepEqual((await read({ thread: undefined })).memories, [])
  assert.deepEqual((await read({ thread: ids[1] })).memories, [])
  // Everyday prompts still get pins; a shared fact isn't pulled in by this rule.
  rows('memories').forEach(memory => { memory.private_to = undefined })
  source.data.dm_with = undefined
  assert(!(await read()).memories.includes('The most important told fact.'))
})
await check('memory adult scene facts wait until their messages leave the prompt', async () => {
  await start()
  const source = storedEvents()[0]
  rows('memories').push({ _id: new ObjectId(), instance_id: new ObjectId(instanceId), player_id: new ObjectId(playerId), text: `${names[0]} wants a recent thing.`, subjects: [names[0]], objects: [],
    source_event_ids: [source._id], explicit_fact: true, is_nsfw: true, is_archived: false, importance: 3, updated_at: new Date() })
  const read = (recentEvents?: ObjectId[]) => groupWriterMemory({ instanceId: new ObjectId(instanceId), player: playerName, speakers: [names[0]], enabled: true, memories: [], openThreads: [], raisedBy: 'ordinary greeting', recentEvents })
  assert.equal((await read()).memories.length, 1)
  assert.equal((await read([source._id])).memories.length, 0)
  assert.equal((await read([new ObjectId()])).memories.length, 1)
})
await check('curator attribution rule is in the group prompt', async () => {
  await start(); addEvents(5); curatorFactory = request => ({ memories: [atom('A valid fact.', 'player', numbered(request)[0].number)] })
  await memoryProcessor(memoryJob())
  const system = JSON.stringify(curatorRequests.at(-1))
  assert(system.includes('words quoted from someone to the person who said them')); assert(system.includes('not to whoever mentions it'))
})
await check('memory failed batches catch up from watermark with two event overlap and no duplicate atoms or vectors', async () => {
  await start(); addEvents(5); curatorReply = new Error('Stub curator failed')
  await assert.rejects(memoryProcessor(memoryJob()), /Stub curator failed/)
  assert.equal(get(rows('worldInstances')[0], 'group_state.curated_through_sequence'), 1)
  addEvents(5)
  curatorFactory = request => ({ memories: [atom('Fact at the old failed batch edge.', 'player', numbered(request).find(message => message.text === 'Filler 5')!.number),
    atom('Fact at the next overlap.', names[0], numbered(request).find(message => message.text === 'Filler 10')!.number)] })
  await memoryProcessor(memoryJob())
  assert(numbered().some(message => message.text === 'Filler 2')); assert(numbered().some(message => message.text === 'Filler 11'))
  assert.equal(get(rows('worldInstances')[0], 'group_state.curated_through_sequence'), 11)
  addEvents(5)
  curatorFactory = request => ({ memories: [atom('Fact at the next overlap.', names[0], numbered(request).find(message => message.text === 'Filler 10')!.number), atom('An alternate phrasing of the overlap fact.', names[0], numbered(request).find(message => message.text === 'Filler 10')!.number), atom('New fact.', 'player', numbered(request).at(-1)!.number)] })
  await memoryProcessor(memoryJob())
  assert.equal(numbered()[0].text, 'Filler 10'); assert(numbered().some(message => message.text === 'Filler 11'))
  assert.equal(rows('memories').length, 3); assert.equal(vectors.size, 3)
  assert(memoryLogs.some(row => row.name === 'group.memory_batch' && row.duplicates === 2 && row.success === true))
  assert.equal(get(storedEvents().at(-1)! as unknown as Row, 'data.group_state_after.curated_through_sequence'), 16)
})
async function closureBatch() {
  await start(); addEvents(5)
  curatorFactory = request => ({ memories: [atom('A lasting plain fact about the player.', 'player', 1),
    atom('The player promised to return a borrowed item.', 'player', 1, { type: 'promise', unresolved_thread: true,
      source_messages: numbered(request).filter(message => ['Filler 4', 'Filler 6'].includes(message.text)).map(message => message.number) })] })
  await memoryProcessor(memoryJob())
  const thread = clone(rows('memories')[1])
  addEvents(5)
  return thread
}
await check('memory group closure request lists only open threads and forbids copying with cited closure schema', async () => {
  const thread = await closureBatch()
  curatorFactory = request => {
    const messages = request.messages as Row[]
    const list = String(messages[1].content).split('OPEN THREADS:\n')[1].split('\n\nNumbered messages')[0]
    assert.equal(list, `T1: ${thread.text}`)
    assert(!String(messages[1].content).includes('LIVE RELATED FACTS'))
    assert(String(messages[0].content).includes('Atoms come only from the numbered messages, never from that list'))
    assert(!String(messages[0].content).includes('closed_thread_ids') && !String(messages[0].content).includes('resolved_threads'))
    assert.deepEqual(get(request, 'responseSchema.required'), ['memories', 'entities', 'closed_threads'])
    const schema = get(request, 'responseSchema.properties.closed_threads.items') as Row
    assert.equal(schema.additionalProperties, false)
    assert.deepEqual(schema.required, ['thread_id', 'source_messages'])
    assert.deepEqual(get(schema, 'properties.source_messages'), { type: 'array', minItems: 1, items: { type: 'integer', minimum: 1 } })
    const fixture = { memories: [], closed_threads: [{ thread_id: 'T1', source_messages: [1] }] }
    assert.deepEqual((curatorResponse(request, fixture) as Row).closed_threads, fixture.closed_threads)
    assert.deepEqual((curatorResponse({ ...request, responseSchema: undefined }, fixture) as Row).closed_threads, [])
    return { memories: [atom('A new independent fact.', names[1], 1)] }
  }
  await memoryProcessor(memoryJob())
  assert.equal(curatorRequests.length, 2)
})
await check('memory group closure rejects missing earlier same overlap invalid and legacy citations and counts drops', async () => {
  for (const kind of ['missing', 'empty', 'earlier', 'same', 'range', 'fraction', 'string', 'unknown', 'legacy', 'prose', 'missing-source']) {
    const thread = await closureBatch()
    if (kind === 'missing-source') (rows('memories')[1].source_event_ids as ObjectId[]).push(new ObjectId())
    curatorFactory = request => {
      const citation = (text: string) => numbered(request).find(message => message.text === text)!.number
      const closures: Row[] = [{ thread_id: kind === 'unknown' ? 'T9' : 'T1', source_messages:
        kind === 'empty' ? [] : [kind === 'earlier' ? citation('Filler 5') : kind === 'same' ? citation('Filler 6') :
          kind === 'range' ? 999 : kind === 'fraction' ? 1.5 : kind === 'string' ? '1' : citation('Filler 7')] }]
      if (kind === 'missing') delete closures[0].source_messages
      return { memories: [atom('An unrelated new fact.', names[1], 1)],
        closed_threads: ['legacy', 'prose'].includes(kind) ? [] : closures,
        closed_thread_ids: kind === 'legacy' ? ['T1'] : [], resolved_threads: kind === 'prose' ? [String(thread.text)] : [] }
    }
    await memoryProcessor(memoryJob())
    const stored = rows('memories').find(row => eq(row._id, thread._id))!
    assert.equal(stored.unresolved_thread, true, kind); assert.equal(stored.is_archived, false, kind)
    assert(vectors.has(String(thread.pinecone_id)), kind)
    const log = memoryLogs.filter(row => row.name === 'group.memory_batch').at(-1)!
    assert.equal(log.closuresAccepted, 0, kind)
    assert.equal(log.closuresRejected, ['legacy', 'prose'].includes(kind) ? 0 : 1, kind)
  }
})
await check('memory group valid closure keeps atom vector provenance and Memories but leaves Open threads', async () => {
  const thread = await closureBatch(), before = clone(vectors.get(String(thread.pinecone_id)))
  curatorFactory = request => ({ memories: [], closed_threads: [{ thread_id: 'T1',
    source_messages: [numbered(request).find(message => message.text === 'Filler 7')!.number] }] })
  await memoryProcessor(memoryJob())
  const stored = rows('memories').find(row => eq(row._id, thread._id))!
  assert.equal(rows('memories').length, 2); assert.equal(stored.unresolved_thread, false)
  assert.equal(stored.is_archived, false); assert.equal(stored.status, thread.status)
  assert(stored.resolved_at instanceof Date); assert.deepEqual(stored.source_event_ids, thread.source_event_ids)
  assert.equal(stored.pinecone_id, thread.pinecone_id); assert.deepEqual(vectors.get(String(thread.pinecone_id)), before)
  const log = memoryLogs.filter(row => row.name === 'group.memory_batch').at(-1)!
  assert.equal(log.closuresAccepted, 1); assert.equal(log.closuresRejected, 0); assert.equal(log.threadsResolved, 1)
  addEvents(30); ragMemoryTexts = [String(thread.text)]; ragOpenThreads = []
  modelReplies = [`${names[0]}: A fresh response after completion.`]
  await turn({ userMessage: `@${names[0]} remember that?` }, never)
  const body = String((writerCalls.at(-1)!.messages as Row[])[1].content)
  assert(body.split('Memories:\n')[1].split('\n\n')[0].includes(String(thread.text)))
  assert(!body.split('Open threads:\n')[1]?.split('\n\n')[0].includes(String(thread.text)))
})
await check('memory group closed rewind deletes sourced atom and vector while older fact survives', async () => {
  const thread = await closureBatch()
  curatorFactory = request => ({ memories: [], closed_threads: [{ thread_id: 'T1',
    source_messages: [numbered(request).find(message => message.text === 'Filler 7')!.number] }] })
  await memoryProcessor(memoryJob())
  assert.equal(rows('memories')[1].unresolved_thread, false)
  // Rewind itself is real; unrelated card-media and graph work has no bearing on atom provenance.
  mock.module('../src/services/codex-media-carryover', () => ({ snapshotCodexMedia: async () => ({}), restoreCodexMedia: async () => {} }))
  const { characterCodexService } = await import('../src/services/character-codex.service')
  Object.assign(characterCodexService, { applyManualIdentityRevisions: async () => {} })
  const { entityGraphService } = await import('../src/services/entity-graph.service')
  Object.assign(entityGraphService, { repairAfterRewind: async () => {} })
  const { memoryService } = await import('../src/services/memory.service')
  const older = clone(rows('memories')[0])
  rows('events')[4].time_anchor = { real_time: new Date(), sequence: 5, timeline_id: 'main' }
  await memoryService.rewindToSequence(instanceId, playerId, 6)
  assert.deepEqual(rows('memories'), [older])
  assert(!vectors.has(String(thread.pinecone_id))); assert(vectors.has(String(older.pinecone_id)))
  assert(storedEvents().every(event => event.sequence < 6))
})
await check('memory group same normalized text ignores objects subjects and events while distinct people facts remain', async () => {
  await start(); addEvents(5)
  curatorFactory = () => ({ memories: [atom('The player owns a green coat.', 'player', 1),
    atom('  THE player  owns a green coat. ', names[0], 2, { objects: ['coat'] }),
    atom(`${names[0]} owns a blue coat.`, names[0], 3), atom(`${names[1]} owns a red coat.`, names[1], 3)] })
  await memoryProcessor(memoryJob())
  assert.equal(rows('memories').length, 3); assert.equal(vectors.size, 3)
  const older = clone(rows('memories')[0])
  addEvents(5)
  curatorFactory = request => ({ memories: [atom('the player owns a green coat.', names[1], numbered(request).at(-1)!.number, { objects: ['other object'] })] })
  await memoryProcessor(memoryJob())
  assert.equal(rows('memories').length, 3); assert.equal(vectors.size, 3)
  assert.deepEqual(rows('memories')[0], older)
  assert(memoryLogs.filter(row => row.name === 'group.memory_batch').every(row => row.duplicates === 1))
  assert.deepEqual(rows('memories').slice(1).map(row => row.subjects), [[names[0]], [names[1]]])
})
await check('memory catch-up batches are bounded without skipping oldest uncurated events', async () => {
  await start(); addEvents(70)
  const batch = await loadGroupBatch(new ObjectId(instanceId), storedEvents().at(-1)!._id, 'curated_through_sequence')
  assert.equal(batch!.events.length, 27); assert.equal(batch!.events[0].sequence, 2); assert.equal(batch!.through, 28)
})
await check('memory message five and open threads reach normal addressed and bystander actual prompts for a silent member past raw window', async () => {
  await identityBatch()
  const fact = String(rows('memories')[2].text)
  rows('memories').push({ ...clone(rows('memories')[2]), _id: new ObjectId(), text: 'An appointment still awaits the player.', unresolved_thread: true })
  addEvents(40)
  assert(!storedEvents().some(event => event.data.lines?.some(line => line.character_id === ids[3])))
  ragOpenThreads = ['An appointment still awaits the player.']; ragMemoryTexts = [fact]
  modelReplies = [`${names[3]}: A fresh normal reply.`]
  await turn({ userMessage: `@${names[3]} lol ok` }, never)
  assert.equal(writerCalls.length, 1)
  let prompt = String((writerCalls[0].messages as Row[])[1].content)
  assert(prompt.includes(fact) && prompt.includes('Open threads:\nAn appointment still awaits the player.'))
  assert.equal(prompt.split(fact).length - 1, 1); assert(!prompt.split('Recent messages:')[1].includes('My sister is getting married in June.'))
  put(rows('users')[0], 'preferences.nsfw_enabled', true); auditEnv.NSFW_SAME_TURN_ROUTER = 'on'; routerSexual = true
  modelReplies = [`${names[3]}: Fresh addressed response.`, `${names[2]}: Fresh bystander response.`]
  writerCalls = []
  put(rows('worldInstances')[0], `group_state.silent_for.${ids[2]}`, 10)
  await turn({ userMessage: `@${names[3]} keep going, the appointment and married` }, never)
  assert.equal(writerCalls.length, 2)
  // The adult call lists the thread as a plain fact; the bystander keeps the full shape.
  const isAdultCall = (call: Row) => String((call.messages as Row[])[0].content).includes('You are writing only')
  prompt = String((writerCalls.find(isAdultCall)!.messages as Row[])[1].content)
  assert(prompt.includes(fact)); assert(prompt.split('Memories:\n')[1].split('\n\n')[0].includes('An appointment still awaits the player.')); assert(!prompt.includes('Open threads:'))
  assert.equal(prompt.split(fact).length - 1, 1)
  prompt = String((writerCalls.find(call => !isAdultCall(call))!.messages as Row[])[1].content)
  assert(prompt.includes(fact)); assert(prompt.includes('Open threads:\nAn appointment still awaits the player.'))
  assert(prompt.indexOf('Memories:') < prompt.indexOf('Open threads:')); assert(prompt.indexOf('Open threads:') < prompt.indexOf('Recent messages:'))
  assert.equal(prompt.split(fact).length - 1, 1)
  assert.equal(curatorRequests.length, 1)
})
await check('memory query uses last three named messages plus current for player and autonomous turns with member entity ids', async () => {
  await start(); addEvents(3)
  const entities = members.map(member => ({ _id: new ObjectId(), instance_id: new ObjectId(instanceId), character_id: new ObjectId(member.id), type: 'character' }))
  rows('entities').push(...entities)
  modelReplies = [`${names[3]}: A query reply.`]
  await turn({ userMessage: `@${names[3]} ${names[2]} lol ok` }, never)
  assert.equal(ragCalls[0][2], `${names[0]}: filler 3\n${playerName}: Filler 4\n${names[0]}: filler 4\n${playerName}: @${names[3]} ${names[2]} lol ok`)
  assert((ragCalls[0][5] as string[]).includes(String(entities[3]._id))); assert((ragCalls[0][5] as string[]).includes(String(entities[2]._id)))
  // Curated entities can exist by canonical name before a card back-pointer is synced.
  delete rows('entities')[3].character_id; rows('entities')[3].name_normalized = names[3].toLowerCase()
  ragCalls = []; modelReplies = [`${names[3]}: Another query reply.`]
  await turn({ userMessage: `@${names[3]} lol ok` }, never)
  assert((ragCalls[0][5] as string[]).includes(String(entities[3]._id)))
  ragCalls = []; await turn({ origin: 'unprompted', userMessage: '' }, never)
  assert.equal(String(ragCalls[0][2]).split('\n').length, 4); assert(String(ragCalls[0][2]).includes(`${playerName} is quiet. Topic:`))
  assert((ragCalls[0][5] as string[]).length >= 2)
})
await check('memory pins include subject and object for each call speaker with five per person and a total text budget', async () => {
  await start(); addEvents(40)
  const source = storedEvents()[4]._id
  for (const [index, person] of ['player', names[3], names[2]].entries()) for (let i = 0; i < 7; i++) rows('memories').push({
    _id: new ObjectId(), instance_id: new ObjectId(instanceId), player_id: new ObjectId(playerId), text: `Pinned ${person} ${i} ` + 'x'.repeat(570),
    is_archived: false, is_nsfw: false, importance: i, updated_at: new Date(i), subjects: index === 1 ? [] : [person], objects: index === 1 ? [person] : [], source_event_ids: [source],
  })
  modelReplies = [`${names[3]}: A pin reply.\n${names[2]}: Another pin reply.`]
  await turn({ userMessage: `@${names[3]} @${names[2]}` }, never)
  const prompt = String((writerCalls[0].messages as Row[])[1].content)
  for (const person of ['player', names[3], names[2]]) { assert(prompt.includes(`Pinned ${person} 6`)); assert(prompt.includes(`Pinned ${person} 2`)); assert(!prompt.includes(`Pinned ${person} 1`)) }
  const memoryText = prompt.split('Memories:\n')[1].split('\n\n')[0]
  assert(memoryText.length <= GROUP_MEMORY_TEXT_BUDGET)
  for (const person of [names[0], names[1]]) for (let i = 0; i < 7; i++) rows('memories').push({ ...clone(rows('memories')[0]), _id: new ObjectId(),
    text: `Budget ${person} ${i} ` + 'x'.repeat(570), subjects: [person], objects: [], importance: i })
  const bounded = await groupWriterMemory({ instanceId: new ObjectId(instanceId), player: playerName, speakers: names, enabled: false, memories: [], openThreads: [] })
  assert(bounded.memories.join('\n').length <= GROUP_MEMORY_TEXT_BUDGET)
})
await check('explicit check runs after the reply without delaying it and only the adult writer loses tame lines', async () => {
  await start(); addEvents(3); put(rows('users')[0], 'preferences.nsfw_enabled', true); auditEnv.NSFW_SAME_TURN_ROUTER = 'on'; routerSexual = true
  put(rows('worldInstances')[0], `group_state.silent_for.${ids[3]}`, 10)
  judgeVerdict = false; judgeCalls = []; backgroundWork = []
  let release!: () => void; judgeGate = new Promise<void>(resolve => { release = resolve })
  modelReplies = [`${names[1]}: Tame maple reply.`, `${names[3]}: Copper bystander reply.`]; writerCalls = []
  // The turn finishes while the judge is still held, so the player never waits on it.
  const heldTimer = new Promise<never>((_, reject) => { setTimeout(() => reject(new Error('The turn waited on the held judge')), 5_000).unref() })
  await Promise.race([turn({ userMessage: `@${names[1]} first line` }, never), heldTimer])
  const judged = storedEvents().at(-1)!
  assert.equal(judgeCalls.length, 1); assert.equal(judgeCalls[0], 'Tame maple reply.'); assert.equal(judged.data.tame, undefined)
  release(); await Promise.all(backgroundWork); judgeGate = undefined
  assert.equal(judged.data.tame, true)
  assert.equal('tame' in publicGroupData(judged.data), false)
  const isAdultCall = (call: Row) => String((call.messages as Row[])[0].content).includes('You are writing only')
  judgeVerdict = true; writerCalls = []; modelReplies = [`${names[1]}: Violet second reply.`, `${names[3]}: Quiet second bystander.`]
  put(rows('worldInstances')[0], `group_state.silent_for.${ids[3]}`, 10)
  await turn({ userMessage: `@${names[1]} second line` }, never)
  const adult = String((writerCalls.find(isAdultCall)!.messages as Row[])[1].content), bystander = String((writerCalls.find(call => !isAdultCall(call))!.messages as Row[])[1].content)
  assert(!adult.includes('Tame maple reply.')); assert(adult.includes('first line')); assert(bystander.includes('Tame maple reply.'))
  await Promise.all(backgroundWork)
  assert.equal('tame' in storedEvents().at(-1)!.data, false)
  // No verdict never marks a reply.
  for (const [verdict, reply] of [['error', 'Silver orchards bloom.'], ['malformed', 'Crimson bridges sway.']] as const) {
    judgeVerdict = verdict; modelReplies = [`${names[1]}: ${reply}`, `${names[3]}: ${reply} Again and elsewhere.`]; writerCalls = []
    put(rows('worldInstances')[0], `group_state.silent_for.${ids[3]}`, 10)
    await turn({ userMessage: `@${names[1]} another ${verdict}` }, never); await Promise.all(backgroundWork)
    assert.equal('tame' in storedEvents().at(-1)!.data, false)
  }
  judgeVerdict = true; judgeCalls = []
  // Normal turns are never judged; low bonds still reach the adult check.
  auditEnv.NSFW_SAME_TURN_ROUTER = 'off'
  await start(); addEvents(3); modelReplies = [`${names[1]}: An ordinary reply.`]
  await turn({ userMessage: `@${names[1]} ordinary` }, never); assert.equal(judgeCalls.length, 0)
  const source = groupTemplate(); source.seed_cast![1].group!.start_bond = 'enemy'
  await start(source); addEvents(3); put(rows('users')[0], 'preferences.nsfw_enabled', true); auditEnv.NSFW_SAME_TURN_ROUTER = 'on'; routerSexual = true
  modelReplies = [`${names[1]}: A plain no thanks.`]
  await turn({ userMessage: `@${names[1]} line` }, never); await Promise.all(backgroundWork.splice(0)); assert.equal(judgeCalls.length, 1)
  judgeCalls = []; routeUser = { id: playerId, tier: 'creator' }
  assert.equal((await bondHttp('PUT', { fear: 70 }, ids[1])).status, 200)
  modelReplies = [`${names[1]}: A frightened reply.`]
  await turn({ userMessage: `@${names[1]} line again` }, never); await Promise.all(backgroundWork.splice(0))
  assert.equal(judgeCalls.length, 0)
})
await check('adult prompt asks every member for the act itself with the same low bond rule', () => {
  const low = { ...members[2], group: { ...members[2].group, start_bond: 'enemy' as const } }, high = { ...members[2], group: { ...members[2].group, start_bond: 'friend' as const } }
  const yes = buildAddressedStatic({ ...template, members, player: playerName }, low), no = buildAddressedStatic({ ...template, members, player: playerName }, high)
  assert.equal(yes, no)
  for (const rule of ['plain, crude words', 'without putting it off', 'says the act itself', 'Low trust and affection', 'A flat no is rare']) assert(yes.includes(rule))
})
await check('first explicit: a solo adult reply answers the act itself beside the turn', async () => {
  const source = groupTemplate()
  source.seed_cast![0].group!.voice = ['Authored text 0', 'A second authored example line here', 'Third authored example line']
  await adultStart(source)
  addEvent('narration', 0, 2)
  modelReplies = [`${names[0]}: Fresh explicit answer`]
  await turn({ userMessage: `@${names[0]} I wanna fuck you` }, never)
  assert.deepEqual(checkLogs.at(-1)!.writing.map(call => call.purpose), ['addressed'])
  const dynamic = content(writerCalls[0], 1)
  assert(dynamic.includes(`Whatever ${playerName} just said, ${names[0]} answers as if ${playerName} had asked exactly what ${names[0]} wants done: the acts themselves, in the first message. A time, a place, a joke or a yes on its own doesn't answer it.`))
  assert(dynamic.indexOf('Now:') < dynamic.indexOf('answers as if'))
  // This member has spoken before, so the two examples are the next ones along, not the two longest.
  const longest = [...source.seed_cast![0].group!.voice!].sort((a, b) => b.length - a.length)
  assert(dynamic.includes(` ${names[0]} says it the way these sound, in new words: "${longest[1]}" "${longest[2]}"`))
  assert(!dynamic.includes(`"${longest[0]}" "${longest[1]}"`))
})
await check('first explicit: the rule stays off every other writer', async () => {
  const message = `@${names[0]} I wanna fuck you`
  const noRule = (call: Row) => !content(call, 1).includes('answers as if')
  // A normal turn and a turn whose toggle is off mid-scene.
  await start()
  await turn({ userMessage: message }, never)
  assert.equal(checkLogs.at(-1)!.writing.at(-1)!.writer, 'normal')
  assert(writerCalls.every(noRule))
  await adultStart(); addEvent('intimate', 0); addEvent('intimate', 0)
  put(rows('users')[0], 'preferences.nsfw_enabled', false)
  await turn({ userMessage: message }, never)
  assert.equal(checkLogs.at(-1)!.writing.at(-1)!.writer, 'normal')
  assert(writerCalls.every(noRule))
  // Consent withdrawn after the adult call has started: the reply is redirected.
  await adultStart()
  writerHook = () => { put(rows('users')[0], 'preferences.nsfw_enabled', false) }
  modelReplies = ['', `${names[0]}: Normal after withdrawal`]
  await turn({ userMessage: message }, never)
  assert.deepEqual(checkLogs.at(-1)!.writing.map(call => [call.writer, call.purpose]), [['adult', 'addressed'], ['normal', 'addressed_retry']])
  assert(content(writerCalls[0], 1).includes('answers as if'))
  assert(noRule(writerCalls[1]))
  // The adult writer gave nothing: the rescue calls are the normal writer.
  await adultStart()
  modelReplies = ['', '', '', `${names[0]}: Fallback reply`]
  await turn({ userMessage: message }, never)
  assert.deepEqual(checkLogs.at(-1)!.writing.map(call => [call.writer, call.purpose]), [['adult', 'addressed'], ['adult', 'addressed_retry'], ['adult', 'addressed_retry'], ['normal', 'addressed_fallback']])
  assert(writerCalls.slice(0, 3).every(call => content(call, 1).includes('answers as if')))
  assert(noRule(writerCalls[3]))
  // A bystander answering beside the adult reply.
  await adultStart()
  let draw = 0
  modelReplies = [`${names[0]}: Accepted answer`, `${names[1]}: A bystander line`]
  await turn({ userMessage: message }, () => ++draw === 1 ? 0 : 0.9)
  assert.deepEqual(checkLogs.at(-1)!.writing.map(call => [call.writer, call.purpose]), [['adult', 'addressed'], ['normal', 'bystander']])
  assert(noRule(writerCalls[1]))
  // A tag repair after a scene member said nothing.
  await adultStart()
  modelReplies = [`${names[0]}: First in the scene`, '*only action*', '', `${names[1]}: Fresh repair`]
  await turn({ userMessage: `@${names[0]} @${names[1]} I wanna fuck you` }, never)
  assert.deepEqual(checkLogs.at(-1)!.writing.map(call => call.purpose), ['addressed', 'addressed', 'addressed_retry', 'tag_repair'])
  assert(noRule(writerCalls[3]))
})
await check('first explicit: a scene member keeps the scene rule and never the new one', async () => {
  await adultStart()
  modelReplies = [`${names[0]}: First in the scene`, `${names[1]}: Second in the scene`]
  await turn({ userMessage: `@${names[0]} @${names[1]} I wanna fuck you` }, never)
  assert.deepEqual(checkLogs.at(-1)!.writing.map(call => call.purpose), ['addressed', 'addressed'])
  for (const index of [0, 1]) {
    const dynamic = content(writerCalls[index], 1)
    assert(dynamic.includes(`This is a sex scene between ${playerName}, `))
    assert(dynamic.includes(`${names[index]} answers ${playerName} and doesn't organise the others`))
    assert(!dynamic.includes('answers as if'))
    assert(!dynamic.includes("A time, a place, a joke or a yes on its own doesn't answer it."))
  }
})
await check('first explicit: known gender gives its exact line only on the adult writer', async () => {
  const message = `@${names[0]} I wanna fuck you`
  const adultSystem = async (gender?: string) => {
    await adultStart()
    if (gender) put(rows('users')[0], 'preferences.gender', gender)
    modelReplies = [`${names[0]}: Fresh explicit answer`]
    await turn({ userMessage: message }, never)
    return content(writerCalls[0], 0)
  }
  for (const [gender, line] of [
    ['male', `${playerName} is a man. Use their name or "you" in messages.`],
    ['female', `${playerName} is a woman. Use their name or "you" in messages.`],
    ['non_binary', `${playerName} is non-binary. Use their name, "you" or "they", and don't assume their body. Never comment on this.`],
  ] as const) {
    const system = await adultSystem(gender)
    assert(system.includes(line), gender)
    assert(!system.includes(`${playerName}'s gender isn't stated`), gender)
  }
  const unset = await adultSystem()
  assert(unset.includes(`${playerName}'s gender isn't stated: use their name, "you" or "they", never he or she. Never comment on this.`))
  for (const line of ['is a man.', 'is a woman.', 'is non-binary.']) assert(!unset.includes(line))
  // Anything outside the three values is unset, not guessed.
  assert.equal(await adultSystem('goblin'), unset)
  // The normal writer keeps the prompt stored at seeding.
  await start(); put(rows('users')[0], 'preferences.gender', 'female')
  await turn({ userMessage: message }, never)
  assert.equal(content(writerCalls[0], 0), get(rows('worldInstances')[0], 'group_context.static_prompt'))
  for (const line of ['is a man.', 'is a woman.', 'is non-binary.']) assert(!content(writerCalls[0], 0).includes(line))
})
await check('first explicit: a persona gender wins over the user gender', async () => {
  const message = `@${names[0]} I wanna fuck you`
  await adultStart()
  put(rows('users')[0], 'preferences.gender', 'female')
  put(rows('worldInstances')[0], 'persona_snapshot', { name: playerName, gender: 'male' })
  modelReplies = [`${names[0]}: Fresh explicit answer`]
  await turn({ userMessage: message }, never)
  assert(content(writerCalls[0], 0).includes(`${playerName} is a man. Use their name or "you" in messages.`))
  assert(!content(writerCalls[0], 0).includes('is a woman.'))
  // An unusable snapshot value is unset, never the user's own.
  await adultStart()
  put(rows('users')[0], 'preferences.gender', 'female')
  put(rows('worldInstances')[0], 'persona_snapshot', { name: playerName, gender: 'goblin' })
  modelReplies = [`${names[0]}: Fresh explicit answer`]
  await turn({ userMessage: message }, never)
  assert(content(writerCalls[0], 0).includes(`${playerName}'s gender isn't stated`))
  assert(!content(writerCalls[0], 0).includes('is a woman.'))
})
await check('first explicit: the body line sits beside a solo adult reply', async () => {
  const message = `@${names[0]} I wanna fuck you`
  const woman = ` ${playerName} is a woman and has a woman's body, with no cock, and ${names[0]} knows it. Say what's done to her body.`
  const enby = ` ${playerName} is non-binary, and ${names[0]} doesn't assume what ${playerName}'s body is.`
  const dynamicFor = async (gender?: string) => {
    await adultStart()
    if (gender) put(rows('users')[0], 'preferences.gender', gender)
    modelReplies = [`${names[0]}: Fresh explicit answer`]
    await turn({ userMessage: message }, never)
    assert.deepEqual(checkLogs.at(-1)!.writing.map(call => [call.writer, call.purpose]), [['adult', 'addressed']])
    return content(writerCalls[0], 1)
  }
  const female = await dynamicFor('female')
  assert(female.includes(woman))
  assert(female.indexOf(woman) > female.indexOf('answers as if'))
  const nonBinary = await dynamicFor('non_binary')
  assert(nonBinary.includes(enby))
  assert(!nonBinary.includes(`has a woman's body`))
  for (const gender of ['male', undefined]) {
    const dynamic = await dynamicFor(gender)
    assert(!dynamic.includes(`has a woman's body`), gender)
    assert(!dynamic.includes(enby.trim()), gender)
  }
})
await check("first explicit: the body line follows a scene member's request", async () => {
  const woman = (name: string) => ` ${playerName} is a woman and has a woman's body, with no cock, and ${name} knows it. Say what's done to her body.`
  const enby = (name: string) => ` ${playerName} is non-binary, and ${name} doesn't assume what ${playerName}'s body is.`
  const dynamicsFor = async (gender?: string) => {
    await adultStart()
    if (gender) put(rows('users')[0], 'preferences.gender', gender)
    modelReplies = [`${names[0]}: First in the scene`, `${names[1]}: Second in the scene`]
    await turn({ userMessage: `@${names[0]} @${names[1]} I wanna fuck you` }, never)
    assert.deepEqual(checkLogs.at(-1)!.writing.map(call => [call.writer, call.purpose]), [['adult', 'addressed'], ['adult', 'addressed']])
    return [content(writerCalls[0], 1), content(writerCalls[1], 1)]
  }
  const [firstWoman, secondWoman] = await dynamicsFor('female')
  assert(firstWoman.includes(woman(names[0])))
  assert(secondWoman.includes(woman(names[1])))
  const [firstEnby, secondEnby] = await dynamicsFor('non_binary')
  assert(firstEnby.includes(enby(names[0])))
  assert(secondEnby.includes(enby(names[1])))
  for (const gender of ['male', undefined]) {
    for (const dynamic of await dynamicsFor(gender)) {
      assert(!dynamic.includes(`has a woman's body`), gender)
      assert(!dynamic.includes(`doesn't assume what ${playerName}'s body is`), gender)
    }
  }
})
await check('first explicit: the body line never reaches a writer the adult route left', async () => {
  const message = `@${names[0]} I wanna fuck you`
  const woman = ` ${playerName} is a woman and has a woman's body, with no cock, and ${names[0]} knows it. Say what's done to her body.`
  const stated = (call: Row) => content(call, 1).includes(woman)
  // A normal turn from the start.
  await start(); put(rows('users')[0], 'preferences.gender', 'female')
  await turn({ userMessage: message }, never)
  assert.equal(checkLogs.at(-1)!.writing.at(-1)!.writer, 'normal')
  assert(writerCalls.every(call => !stated(call)))
  // The toggle is off mid-scene.
  await adultStart(); addEvent('intimate', 0); addEvent('intimate', 0)
  put(rows('users')[0], 'preferences.gender', 'female')
  put(rows('users')[0], 'preferences.nsfw_enabled', false)
  await turn({ userMessage: message }, never)
  assert.equal(checkLogs.at(-1)!.writing.at(-1)!.writer, 'normal')
  assert(writerCalls.every(call => !stated(call)))
  // Consent withdrawn after the adult call has started: the retry is redirected.
  await adultStart(); put(rows('users')[0], 'preferences.gender', 'female')
  writerHook = () => { put(rows('users')[0], 'preferences.nsfw_enabled', false) }
  modelReplies = ['', `${names[0]}: Normal after withdrawal`]
  await turn({ userMessage: message }, never)
  assert.deepEqual(checkLogs.at(-1)!.writing.map(call => [call.writer, call.purpose]), [['adult', 'addressed'], ['normal', 'addressed_retry']])
  assert(stated(writerCalls[0]))
  assert(!stated(writerCalls[1]))
  // The adult writer gave nothing: the rescue calls are the normal writer.
  await adultStart(); put(rows('users')[0], 'preferences.gender', 'female')
  modelReplies = ['', '', '', `${names[0]}: Fallback reply`]
  await turn({ userMessage: message }, never)
  assert.deepEqual(checkLogs.at(-1)!.writing.map(call => [call.writer, call.purpose]), [['adult', 'addressed'], ['adult', 'addressed_retry'], ['adult', 'addressed_retry'], ['normal', 'addressed_fallback']])
  assert(writerCalls.slice(0, 3).every(stated))
  assert(!stated(writerCalls[3]))
})
await check('close bond statement follows the bond and the copy check finds an example inside a message', () => {
  const base = { memories: [], summaries: [], history: [], now: new Date(0), speakers: [members[2].name], situation: 'x' }
  const said = (relationship: { trust: number; affection: number; fear: number; rivalry: number }) => buildGroupDynamic({ ...base, bonds: [{ ...members[2], relationship }] })
  assert(said({ trust: 70, affection: 60, fear: 0, rivalry: 0 }).includes('is close to the player now'))
  for (const low of [{ trust: 69, affection: 90, fear: 0, rivalry: 0 }, { trust: 90, affection: 59, fear: 0, rivalry: 0 }, { trust: 90, affection: 90, fear: 70, rivalry: 0 }]) assert(!said(low).includes('is close to the player now'))
  assert(!buildGroupDynamic({ ...base, speakers: [members[1].name], bonds: [{ ...members[2], relationship: { trust: 90, affection: 90, fear: 0, rivalry: 0 } }] }).includes('is close to the player now'))
  const voiced = { ...members[2], group: { ...members[2].group, voice: ['leave the door open tonight 😈', 'no'] } }
  const filter = (text: string) => { const counts = emptyLineCounts(); return [filterLines([{ name: voiced.name, text }], { members: [voiced], speakers: [voiced.id], origin: 'player', previous: [], openings: [], blocked: () => false }, counts).length, counts.copied_example] }
  assert.deepEqual(filter('hi. Leave the door open, tonight! and more'), [0, 1])
  assert.deepEqual(filter('no way i am going out in that'), [1, 0])
  const longer = { ...voiced, group: { ...voiced.group, voice: ['fine. shut the door, then your hands and your mouth tonight'] } }
  const part = (text: string) => { const counts = emptyLineCounts(); return filterLines([{ name: longer.name, text }], { members: [longer], speakers: [longer.id], origin: 'player', previous: [], openings: [], blocked: () => false }, counts).length }
  assert.equal(part('then your hands and your mouth tonight'), 0); assert.equal(part('your mouth tonight'), 1)
})
await check('memory adult addressed call is narrow and the bystander keeps full memory', async () => {
  await start(); addEvents(40)
  const source = storedEvents()[4]._id
  const row = (text: string, person: string, importance: number) => ({ _id: new ObjectId(), instance_id: new ObjectId(instanceId), player_id: new ObjectId(playerId), text,
    is_archived: false, is_nsfw: false, importance, updated_at: new Date(importance), subjects: [person], objects: [], source_event_ids: [source] })
  for (let i = 0; i < 7; i++) rows('memories').push(row(`Pin player ${i}`, 'player', i), row(`Pin addressed ${i}`, names[1], i))
  rows('memories').push({ ...row('The player has a family occasion.', 'player', 1), search_terms: 'wedding' }, row('The addressed lost a passport.', names[1], 1),
    row('Someone else has a wedding passport.', names[3], 5), { ...row('Thread: the player owes a passport.', 'player', 0), unresolved_thread: true },
    ...[1, 2, 3, 4].map(i => row(`Common fact ${i} about lanterns.`, 'player', 5)), ...[5, 6].map(i => row(`Extra raised ${i} about ticket.`, 'player', i)), row('Another raised about ticket.', 'player', 1))
  ragMemoryTexts = ['Pin player 6', 'Someone else has a wedding passport.']; ragOpenThreads = ['Thread: the player owes a passport.']
  rows('sceneSummaries').push({ _id: new ObjectId(), instance_id: new ObjectId(instanceId), status: 'ready', summary_text: 'Summary marker', event_range: { start_sequence: 1, end_sequence: 2 } })
  put(rows('users')[0], 'preferences.nsfw_enabled', true); auditEnv.NSFW_SAME_TURN_ROUTER = 'on'; routerSexual = true
  const isAdultCall = (call: Row) => String((call.messages as Row[])[0].content).includes('You are writing only')
  const fresh = [['Maple rivers hum.', 'Copper foxes dance.'], ['Violet trains arrive.', 'Quiet lanterns drift.'], ['Silver orchards bloom.', 'Amber kites wander.'], ['Crimson bridges sway.', 'Golden moths settle.'], ['Indigo clocks chime.', 'Velvet ferries glide.'], ['Scarlet herons wade.', 'Pewter gulls circle.']]
  const send = async (userMessage: string) => {
    // The line checks refuse a repeat, so each turn's fake reply must be new.
    const [adultLine, safeLine] = fresh.shift()!
    modelReplies = [`${names[1]}: ${adultLine}`, `${names[3]}: ${safeLine}`]; writerCalls = []
    put(rows('worldInstances')[0], `group_state.silent_for.${ids[3]}`, 10)
    await turn({ userMessage }, never); assert.equal(writerCalls.length, 2)
    return { adult: String((writerCalls.find(isAdultCall)!.messages as Row[])[1].content), bystander: String((writerCalls.find(call => !isAdultCall(call))!.messages as Row[])[1].content) }
  }
  // Nothing raised: no memory block at all, while the bystander keeps full memory.
  const quiet = await send(`@${names[1]} keep going`)
  for (const absent of ['Memories:', 'Open threads:', 'Summary so far:', 'Summary marker']) assert(!quiet.adult.includes(absent), absent)
  for (const present of ['Extra raised 6 about ticket.', 'Someone else has a wedding passport.', 'Open threads:', 'Summary marker']) assert(quiet.bystander.includes(present), present)
  // Raised: fact found through its retrieval terms, a thread as a plain fact, other people's left out.
  const raised = await send(`@${names[1]} after the wedding I need my passport`)
  const held = raised.adult.split('Memories:\n')[1].split('\n\n')[0].split('\n')
  assert.deepEqual([...held].sort(), ['The addressed lost a passport.', 'The player has a family occasion.', 'Thread: the player owes a passport.'].sort())
  assert(!raised.adult.includes('Open threads:')); assert(!raised.adult.includes('Summary so far:'))
  // A word shared by many facts raises none of them; the cap holds for a rare word.
  const common = await send(`@${names[1]} where are the lanterns`)
  assert(!common.adult.includes('Memories:'))
  const tickets = await send(`@${names[1]} the ticket, the wedding and the passport`)
  assert.equal(tickets.adult.split('Memories:\n')[1].split('\n\n')[0].split('\n').length, 4)
  // Adult facts she's part of always come along, newest first and capped; other people's don't.
  const adultRow = (text: string, subject: string, order: number) => ({ ...row(text, subject, 1), is_nsfw: true, explicit_fact: true, updated_at: new Date(1000 + order) })
  rows('memories').push(...[1, 2, 3, 4, 5, 6, 7].map(i => adultRow(`Adult scene ${i}.`, names[1], i)), { ...adultRow('Adult from the player.', 'player', 20), objects: [names[1]] }, { ...adultRow('Adult with someone else.', 'player', 9), objects: [names[3]] }, { ...adultRow('Plans said on an adult turn.', names[1], 10), explicit_fact: false })
  const scene = await send(`@${names[1]} carry on`)
  const inScene = scene.adult.split('Memories:\n')[1].split('\n\n')[0].split('\n')
  assert.deepEqual(inScene, [7, 6, 5, 4, 3, 2].map(i => `Adult scene ${i}.`))
  // With room to spare, the player's fact with someone else still stays out.
  for (const memory of rows('memories')) if (String(memory.text).startsWith('Adult scene')) memory.explicit_fact = false
  const roomy = await send(`@${names[1]} keep it up`)
  assert.deepEqual(roomy.adult.split('Memories:\n')[1].split('\n\n')[0].split('\n'), ['Adult from the player.'])
  // Short everyday words raise nothing; a capitalized name does.
  const everyday = raisedMemories(`what again`, [{ text: 'Elena asked what the noise was again.', importance: 1 }] as never, [])
  assert.deepEqual(everyday, [])
  assert.equal(raisedMemories(`how is mira`, [{ text: 'The sister Mira is well.', importance: 1 }] as never, []).length, 1)
  // The player's tag and name are never what makes a fact count as raised.
  assert.deepEqual(raisedMemories(`@${names[1]} hello`, [{ text: `${names[1]} has a thing.`, importance: 1 }] as never, [names[1]]), [])
})
await check('memory adult sourced atoms and threads fail closed on fresh toggle off for all writer kinds', async () => {
  await identityBatch()
  const source = storedEvents()[3]; source.type = 'intimate'
  rows('memories')[1].is_nsfw = false // Provenance must beat a misclassified atom.
  rows('memories')[1].unresolved_thread = true
  const adultText = String(rows('memories')[1].text), safeText = String(rows('memories')[2].text)
  ragMemoryTexts = [adultText, safeText]; ragOpenThreads = [adultText]
  addEvents(40)
  modelReplies = [`${names[1]}: A safe memory reply.`]
  await turn({ userMessage: `@${names[1]}` }, never)
  assert(!String((writerCalls[0].messages as Row[])[1].content).includes(adultText))
  put(rows('users')[0], 'preferences.nsfw_enabled', true); auditEnv.NSFW_SAME_TURN_ROUTER = 'on'; routerSexual = true
  let seen = 0
  writerHook = () => { if (++seen === 1) put(rows('users')[0], 'preferences.nsfw_enabled', false) }
  modelReplies = [`${names[1]}: Fresh adult response.`, `${names[2]}: Fresh safe response.`]; writerCalls = []
  await turn({ userMessage: `@${names[1]} @${names[2]} keep going, the painter` }, never)
  assert.equal(writerCalls.length, 2)
  assert(String((writerCalls[0].messages as Row[])[1].content).includes(adultText))
  assert(!String((writerCalls[1].messages as Row[])[1].content).includes(adultText))
  assert(String((writerCalls[1].messages as Row[])[1].content).includes(safeText))
  put(rows('users')[0], 'preferences.nsfw_enabled', true)
  let reads = 0
  consentReadHook = () => { if (++reads === 2) put(rows('users')[0], 'preferences.nsfw_enabled', false) }
  writerHook = undefined; writerCalls = []; modelReplies = [`${names[1]}: Fresh redirected reply.`, `${names[2]}: Fresh redirected bystander.`]
  await turn({ userMessage: `@${names[1]} @${names[2]} keep going again` }, never)
  assert.equal(writerCalls.length, 2)
  for (const call of writerCalls) assert(!String((call.messages as Row[])[1].content).includes(adultText))
  // A stale curator is not allowed to lose the source's adult classification.
  await start(); addEvents(5); storedEvents()[4].type = 'intimate'
  curatorFactory = request => ({ memories: [atom('Adult source fact.', 'player', numbered(request).find(message => message.text === 'Filler 5')!.number)] })
  await memoryProcessor(memoryJob()); assert.equal(rows('memories')[0].is_nsfw, true)
})
await check('memory rewind removes message five atom and vector alone and restores both watermarks', async () => {
  const child = Bun.spawn(['bun', '--no-env-file', 'run', 'scripts/codex-media-carryover-audit.ts'], { stdout: 'pipe', stderr: 'pipe', cwd: new URL('..', import.meta.url).pathname })
  const [output, errors, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  assert.equal(code, 0, output + errors); assert(output.includes('PASS memory group rewind removes only message five atoms and vectors'))
})
await check('memory reset removes atoms and vectors and obsolete in-flight curator cannot repopulate', async () => {
  await identityBatch(); assert(rows('memories').length > 0)
  const old = memoryJob(); await deletionService.resetInstance(instanceId, playerId)
  assert.equal(rows('memories').length, 0); assert.equal(vectors.size, 0)
  await memoryProcessor(old); assert.equal(rows('memories').length, 0)
  addEvents(5); curatorFactory = request => ({ memories: [atom('Late atom.', 'player', numbered(request)[0].number)] })
  curatorHook = async () => { curatorHook = undefined; await deletionService.resetInstance(instanceId, playerId) }
  await assert.rejects(memoryProcessor(memoryJob()), /source events changed/)
  assert.equal(rows('memories').length, 0); assert.equal(vectors.size, 0)
  addEvents(5); embedHook = async () => { embedHook = undefined; await deletionService.resetInstance(instanceId, playerId) }
  await assert.rejects(memoryProcessor(memoryJob()), /source events changed/)
  assert.equal(rows('memories').length, 0); assert.equal(vectors.size, 0)
})
await check('memory group summaries render named messages nonoverlapping ranges and watermarks through existing chapter and arc path', async () => {
  await start(); addEvents(12)
  const job = () => ({ data: { instanceId, playerId, eventId: String(storedEvents().at(-1)!._id), groupSummary: true, sceneTag: 'dialogue' } }) as Job
  await summaryProcessor(job())
  const body = String((summaryRequests[0].messages as Row[])[1].content)
  assert(body.includes(`${playerName}: Filler 2`)); assert(body.includes(`${names[0]}: filler 13`)); assert(!/^(Player:|World:)/m.test(body))
  assert.equal(get(rows('worldInstances')[0], 'group_state.summarized_through_sequence'), 13)
  assert.equal(get(storedEvents().at(-1)! as unknown as Row, 'data.group_state_after.summarized_through_sequence'), 13)
  await summaryProcessor(job()); assert.equal(summaryRequests.length, 1)
  for (let block = 1; block < 8; block++) { addEvents(12); await summaryProcessor(job()) }
  assert.deepEqual(rows('sceneSummaries').map(row => row.event_range), Array.from({ length: 8 }, (_, i) => ({ start_sequence: 2 + 12 * i, end_sequence: 13 + 12 * i })))
  assert.equal(queued.at(-1)!.kind, 'chapter')
  await summaryProcessor({ data: { ...queued.at(-1)!, playerId } } as Job)
  assert.equal(rows('chapterSummaries').length, 1); assert.equal(summaryRequests.at(-1)!.purpose, 'chapter_summary')
  for (let i = 1; i < 4; i++) rows('chapterSummaries').push({ ...clone(rows('chapterSummaries')[0]), _id: new ObjectId(), chapter_index: i + 1,
    event_range: { start_sequence: 2 + 96 * i, end_sequence: 97 + 96 * i } })
  addEvents(288)
  // Rebuilding the fourth chapter exercises the same rollup and arc enqueue seam.
  const scene = rows('sceneSummaries')[0]
  for (let i = 0; i < 8; i++) rows('sceneSummaries').push({ ...clone(scene), _id: new ObjectId(), event_range: { start_sequence: 290 + 12 * i, end_sequence: 301 + 12 * i } })
  await summaryProcessor({ data: { instanceId, playerId, kind: 'chapter', chapterIndex: 4, startSequence: 290, endSequence: 385 } } as Job)
  assert.equal(queued.at(-1)!.kind, 'arc')
  await summaryProcessor({ data: { ...queued.at(-1)!, playerId } } as Job)
  assert.equal(rows('arcSummaries').length, 1); assert.equal(summaryRequests.at(-1)!.purpose, 'arc_summary')
  assert(backgroundScopes.some(scope => scope.instance_id === instanceId && scope.event_id))
  // Ordinary summaries still have the exact existing turn rendering.
  summaryRequests = []; rows('events').forEach(event => { delete (event.data as Row).lines })
  await summaryProcessor({ data: { instanceId, playerId, sceneTag: 'dialogue', startSequence: 2, endSequence: 13 } } as Job)
  assert(String((summaryRequests[0].messages as Row[])[1].content).startsWith('[Turn 2] Player: Filler 2\nWorld:'))
})
await check('memory summary failures retain watermark and next job catches up without overlap', async () => {
  await start(); addEvents(12)
  const job = () => ({ data: { instanceId, playerId, eventId: String(storedEvents().at(-1)!._id), groupSummary: true, sceneTag: 'dialogue' } }) as Job
  summaryReply = new Error('Stub summary failed')
  await assert.rejects(summaryProcessor(job()), /Stub summary failed/)
  assert.equal(get(rows('worldInstances')[0], 'group_state.summarized_through_sequence'), 1)
  summaryReply = '   '; await assert.rejects(summaryProcessor(job()), /Group summary failed/)
  assert.equal(get(rows('worldInstances')[0], 'group_state.summarized_through_sequence'), 1)
  addEvents(12); summaryReply = 'Recovered summary.'; await summaryProcessor(job())
  assert.deepEqual(rows('sceneSummaries')[0].event_range, { start_sequence: 2, end_sequence: 13 })
  await summaryProcessor(job())
  assert.deepEqual(rows('sceneSummaries')[1].event_range, { start_sequence: 14, end_sequence: 25 })
})
await check('memory group summary reset during scene chapter and arc calls leaves no summaries or vectors', async () => {
  for (const kind of ['scene', 'chapter', 'arc']) {
    await start(); addEvents(24)
    for (let i = 0; i < 2; i++) {
      rows(kind === 'chapter' ? 'sceneSummaries' : 'chapterSummaries').push({ _id: new ObjectId(), instance_id: new ObjectId(instanceId), status: 'active',
        summary_text: 'Child summary.', event_range: { start_sequence: 2 + 12 * i, end_sequence: 13 + 12 * i } })
    }
    summaryHook = async () => { summaryHook = undefined; await deletionService.resetInstance(instanceId, playerId) }
    const job = kind === 'scene' ? { groupSummary: true, eventId: String(storedEvents().at(-1)!._id), sceneTag: 'dialogue' }
      : { kind, startSequence: 2, endSequence: 25, chapterIndex: 1, arcIndex: 1 }
    await assert.rejects(summaryProcessor({ data: { instanceId, playerId, ...job } } as Job), /source events changed/)
    for (const table of ['sceneSummaries', 'chapterSummaries', 'arcSummaries']) assert.equal(rows(table).length, 0)
    assert.equal(vectors.size, 0)
    assert.equal(get(rows('worldInstances')[0], 'group_state.summarized_through_sequence'), 1)
  }
})
await check('memory concurrent curator jobs serialize one watermark and model call', async () => {
  await start(); addEvents(5)
  let release!: () => void, entered!: () => void
  const ready = new Promise<void>(resolve => { entered = resolve }), gate = new Promise<void>(resolve => { release = resolve })
  curatorFactory = request => ({ memories: [atom('Concurrent fact.', 'player', numbered(request)[0].number)] })
  curatorHook = async () => { curatorHook = undefined; entered(); await gate }
  const job = memoryJob(), running = memoryProcessor(job)
  await ready
  try { await assert.rejects(memoryProcessor(job), /already running/) } finally { release() }
  await running
  assert.equal(curatorRequests.length, 1); assert.equal(rows('memories').length, 1); assert.equal(vectors.size, 1)
})
await check('memory usage trace stores curator and summary provider costs per chat', async () => {
  const child = Bun.spawn(['bun', '--no-env-file', 'run', 'scripts/group-memory-trace-audit.ts'], { stdout: 'pipe', stderr: 'pipe', cwd: new URL('..', import.meta.url).pathname })
  const [output, errors, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  assert.equal(code, 0, output + errors); assert(output.includes('PASS memory usage trace stores curator and summary calls'))
})
await check('memory scheduled dedup protects group ownership and source events without changing normal dedup', async () => {
  const child = Bun.spawn(['bun', '--no-env-file', 'run', 'scripts/group-memory-dedup-audit.ts'], { stdout: 'pipe', stderr: 'pipe', cwd: new URL('..', import.meta.url).pathname })
  const [output, errors, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  assert.equal(code, 0, output + errors); assert(output.includes('PASS memory scheduled dedup protects group owners'))
})
await check('memory recall script scoring selftest rejects history summary and attribution false positives', async () => {
  const outputDir = `${import.meta.dir}/.recall-selftest-${process.pid}`
  try {
    const child = Bun.spawn(['bun', '--no-env-file', 'run', 'scripts/group-memory-recall.ts', '--selftest'], {
      cwd: new URL('..', import.meta.url).pathname, stdout: 'pipe', stderr: 'pipe', stdin: 'ignore',
      env: { ...process.env, OPENROUTER_API_KEY: 'offline-fixture', OPENAI_API_KEY: 'offline-fixture', JWT_SECRET: 'offline-fixture',
        GROUP_MEMORY_RECALL_OUTPUT_DIR: outputDir },
    })
    const [output, errors, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    assert.equal(code, 0, output + errors)
    assert(output.includes('recall sections, player attribution and allergy scoring'))
  } finally { await rm(outputDir, { recursive: true, force: true }) }
})
await check('memory normal curator requests retain fixed pre-change hashes for GM and sentient identities', () => {
  for (const [isSentient, expected] of [[false, 'c2a93ef57405f0982c5f7df0c2dda009db038ed0a60a076818aad2b465ce7d72'], [true, 'af20a1054a96fa8fc1341b22b1ad14bf73b828d39a5ee8e695f2a92d74f9b4aa']] as const) {
    const request = buildMemoryCurationRequest({ sceneTag: 'dialogue', roster: [{ canonical_name: 'Fixture One', aliases: ['One'], is_protagonist: true }],
      isSentient, protagonistName: 'Fixture One', playerPersonaName: 'Fixture Player', precedingAiResponse: 'Previous words.', playerInput: 'My sister arrives tomorrow.',
      playerSpokenInput: 'My sister arrives tomorrow.', playerNarrationFacts: ['The note is delivered.'], aiResponse: 'A promise is kept.', openThreads: [{ id: 'T1', text: 'Return the letter.' }] })
    assert.equal(createHash('sha256').update(JSON.stringify(request)).digest('hex'), expected)
  }
})
// These fixtures exercise stored audiences independently of turn dispatch.
async function audienceFixture() {
  const source = groupTemplate()
  source.seed_cast![0].name = 'Jess'; source.seed_cast![1].name = 'Elena'
  source.opening_lines = [{ name: 'Jess', text: 'An audience fixture opens.' }]
  await start(source); addEvents(40)
  const cast = members.map((member, index) => ({ ...member, name: source.seed_cast![index].name }))
  return { cast, jess: cast[0], elena: cast[1] }
}
const requestText = (request: Row) => (request.messages as Array<{ content: string }>).map(message => message.content).join('\n')
async function fixtureDirectPrompt(cast: typeof members, thread: string, memories: string[], openThreads: string[], raisedBy?: string, summaries: string[] = []) {
  const speaker = cast.find(member => member.id === thread)!
  const memory = await groupWriterMemory({ instanceId: new ObjectId(instanceId), player: playerName,
    speakers: [speaker.name], enabled: true, thread, memories, openThreads, raisedBy })
  const dynamic = buildGroupDynamic({ ...memory, summaries, history: [], now: new Date(), speakers: [speaker.name], situation: 'Continue.' })
  const { callLLMWithFallback } = await import('../src/ai')
  await callLLMWithFallback({ model: 'fake-direct', messages: [{ role: 'user', content: dynamic }] }, [])
  return requestText(writerCalls.at(-1)!)
}
await check('audience derivation narrows group direct mixed and drops two direct threads', async () => {
  await start(); addEvents(3)
  const [group, direct, other] = storedEvents().slice(1)
  direct.data.dm_with = ids[0]; other.data.dm_with = ids[1]
  assert.deepEqual(deriveGroupAudience([group]), { valid: true })
  assert.deepEqual(deriveGroupAudience([direct]), { valid: true, privateTo: ids[0] })
  assert.deepEqual(deriveGroupAudience([group, direct]), { valid: true, privateTo: ids[0] })
  assert.deepEqual(deriveGroupAudience([direct, other]), { valid: false })
  const groupBatch = { player: playerName, events: [group, direct, other], through: other.sequence,
    messages: [group, direct, other].map((event, index) => ({ number: index + 1, name: playerName, text: event.data.player_input, eventId: event._id, adult: false })) }
  const atoms = [atom('Shared.', 'player', 1), atom('Private.', 'player', 2),
    atom('Narrow mixed.', 'player', 1, { source_messages: [1, 2] }), atom('Rejected mixed.', 'player', 2, { source_messages: [2, 3] })]
  const filtered = filterGroupAtomAudiences(groupBatch, atoms)
  assert.deepEqual(filtered.memories, atoms.slice(0, 3)); assert.equal(filtered.invalidAudiences, 1)

  assert.deepEqual(deriveGroupAudience([]), { valid: false })
  ;(other.data as unknown as Row).dm_with = null
  assert.deepEqual(deriveGroupAudience([other]), { valid: false })
})
for (const channel of ['pins', 'retrieval', 'raised', 'scene', 'open threads']) await check(`audience ${channel} private facts enter only Jess direct requests`, async () => {
  const { cast, jess, elena } = await audienceFixture()
  const source = storedEvents()[2]; source.data.dm_with = jess.id
  const text = 'The albatross keeps a violet envelope.'
  const raisedBy = channel === 'raised' ? 'albatross' : channel === 'scene' ? 'ordinary greeting' : undefined
  rows('memories').push({ _id: new ObjectId(), instance_id: new ObjectId(instanceId), player_id: new ObjectId(playerId),
    text, subjects: ['pins', 'raised', 'scene'].includes(channel) ? [jess.name, 'player'] : [], objects: [],
    source_event_ids: [source._id], private_to: jess.id, explicit_fact: channel === 'scene',
    unresolved_thread: channel === 'open threads', is_nsfw: false, is_archived: false, importance: 5, updated_at: new Date() })
  ragMemoryTexts = channel === 'retrieval' ? [text] : []
  ragOpenThreads = channel === 'open threads' ? [text] : []
  assert((await fixtureDirectPrompt(cast, jess.id, ragMemoryTexts, ragOpenThreads, raisedBy)).includes(text))
  assert(!(await fixtureDirectPrompt(cast, elena.id, ragMemoryTexts, ragOpenThreads, raisedBy)).includes(text))
  // The same helper is used by ordinary group, addressed and bystander calls.
  for (const speakers of [[jess.name], [elena.name], [jess.name, elena.name]]) {
    const memory = await groupWriterMemory({ instanceId: new ObjectId(instanceId), player: playerName,
      speakers, enabled: true, thread: undefined, memories: ragMemoryTexts, openThreads: ragOpenThreads, raisedBy })
    assert(!JSON.stringify(memory).includes(text))
  }
  writerCalls = []; modelReplies = ['Jess: A fresh shared reply.']
  await turn({ userMessage: '@Jess continue' }, never)
  assert(writerCalls.length); assert(writerCalls.every(request => !requestText(request).includes(text)))
  put(rows('users')[0], 'preferences.nsfw_enabled', true); auditEnv.NSFW_SAME_TURN_ROUTER = 'on'
  writerCalls = []; modelReplies = ['Jess: Another shared reply.', 'Elena: A bystander reply.']
  await turn({ userMessage: '@Jess @Elena albatross' }, never)
  assert.equal(writerCalls.length, 2)
  assert(writerCalls.every(request => !requestText(request).includes(text)))
})
await check('audience unknown mismatched mature and missing sources fail closed before prompts', async () => {
  const { cast, jess } = await audienceFixture()
  const source = storedEvents()[2]; source.data.dm_with = jess.id; source.type = 'intimate'
  const base = { _id: new ObjectId(), instance_id: new ObjectId(instanceId), text: 'An unsafe audience marker.', subjects: ['player'], objects: [],
    source_event_ids: [source._id], private_to: jess.id, is_archived: false, is_nsfw: false, importance: 5 }
  rows('memories').push(base)
  const input = { instanceId: new ObjectId(instanceId), player: playerName, speakers: [jess.name], thread: jess.id,
    memories: [base.text, 'Unknown retrieval marker.'], openThreads: [], enabled: false }
  assert.deepEqual(await groupWriterMemory(input), { memories: [], openThreads: [] })
  for (const patch of [{ private_to: undefined }, { private_to: ids[1] }, { private_to: null }, { source_event_ids: [] }, { source_event_ids: [new ObjectId()] }]) {
    Object.assign(base, { source_event_ids: [source._id], private_to: jess.id }, patch)
    assert.deepEqual(await groupWriterMemory({ ...input, enabled: true }), { memories: [], openThreads: [] })
  }
  Object.assign(base, { source_event_ids: [source._id], private_to: jess.id })
  assert((await fixtureDirectPrompt(cast, jess.id, [base.text], [])).includes(base.text))
})
await check('audience recent messages and stored local retrieved summaries stay in their own thread', async () => {
  const { cast, jess, elena } = await audienceFixture()
  const source = storedEvents().at(-1)!
  source.data.dm_with = jess.id; source.data.player_input = 'Private recent envelope marker.'
  source.data.lines = [{ character_id: jess.id, text: 'Private Jess recent answer.', shown_at: new Date() }]
  const privateSummary = 'Private Jess summary marker.'
  rows('sceneSummaries').push({ _id: new ObjectId(), instance_id: new ObjectId(instanceId), status: 'active', private_to: jess.id, summary_text: privateSummary,
    event_range: { start_sequence: source.sequence, end_sequence: source.sequence } })
  ragSummaryHits = [{ id: 'fixture-private-summary', tier: 'scene', text: privateSummary, startSequence: source.sequence, endSequence: source.sequence }]
  const summaryInput = ragSummaryHits
  assert.deepEqual(await groupWriterSummaries(new ObjectId(instanceId), summaryInput, jess.id), [privateSummary])
  for (const thread of [undefined, elena.id]) {
    assert.deepEqual(await groupWriterSummaries(new ObjectId(instanceId), summaryInput, thread), [])
    assert(!JSON.stringify(groupMessages(storedEvents(), playerName, cast, thread)).includes('Private recent envelope marker.'))
  }
  assert(JSON.stringify(groupMessages(storedEvents(), playerName, cast, jess.id)).includes('Private recent envelope marker.'))
  assert.deepEqual(await groupWriterSummaries(new ObjectId(instanceId), [{ text: 'mixed', startSequence: source.sequence - 1, endSequence: source.sequence }], jess.id), [])
  assert.deepEqual(await groupWriterSummaries(new ObjectId(instanceId), [{ text: 'missing', startSequence: 500, endSequence: 501 }]), [])
  // Move private sources out of the raw window so the latest-scene path also selects this row.
  addEvents(35)
  writerCalls = []; modelReplies = ['Jess: An ordinary public answer.']
  await turn({ userMessage: '@Jess continue' }, never)
  assert(writerCalls.every(request => !/Private recent envelope|Private Jess recent|Private Jess summary/.test(requestText(request))))
  assert(ragCalls.every(call => !String(call[2]).includes('Private recent envelope')))
  // A second fixture leaves the direct event inside the adult addressed raw window.
  storedEvents().at(-1)!.data.dm_with = jess.id
  storedEvents().at(-1)!.data.player_input = 'Private recent envelope marker.'
  put(rows('users')[0], 'preferences.nsfw_enabled', true); auditEnv.NSFW_SAME_TURN_ROUTER = 'on'
  writerCalls = []; modelReplies = ['Jess: A public addressed answer.', 'Elena: A public bystander answer.']
  await turn({ userMessage: '@Jess @Elena continue' }, never)
  assert.equal(writerCalls.length, 2)
  assert(writerCalls.every(request => !/Private recent envelope|Private Jess recent|Private Jess summary/.test(requestText(request))))
})
await check('audience curator batches separate messages open threads overlap and watermarks', async () => {
  await start(); addEvents(15)
  const events = storedEvents().slice(1)
  for (const [index, event] of events.entries()) if (index % 3) event.data.dm_with = ids[index % 3 - 1]
  curatorFactory = request => ({ memories: [atom(`Audience fact ${numbered(request)[0].text}`, 'player', 1, { unresolved_thread: true })] })
  for (const thread of [undefined, ids[0], ids[1]]) {
    const own = events.filter(event => event.data.dm_with === thread)
    const before = clone(get(rows('worldInstances')[0], 'group_state')) as Row
    await memoryProcessor(memoryJob(own.at(-1)!))
    const messages = numbered()
    assert.deepEqual(messages.filter(message => message.speaker === playerName).map(message => message.text), own.map(event => event.data.player_input))
    for (const event of events.filter(event => event.data.dm_with !== thread)) assert(!messages.some(message => message.text === event.data.player_input))
    const body = requestText(curatorRequests.at(-1)!)
    for (const old of rows('memories').slice(0, -1)) assert(!body.includes(String(old.text)))
    const atom = rows('memories').at(-1)!
    assert.equal(atom.private_to, thread)
    if (thread === undefined) assert(!('private_to' in atom))
    assert(!body.includes('private_to')); assert(!body.includes('dm_with'))
    const state = get(rows('worldInstances')[0], 'group_state') as Row
    if (thread) {
      assert.equal(state.curated_through_sequence, before.curated_through_sequence)
      assert.equal(get(state, `direct_threads.${thread}.curated_through_sequence`), own.at(-1)!.sequence)
    } else assert.equal(state.curated_through_sequence, own.at(-1)!.sequence)
  }
  assert.equal(rows('memories').length, 3)
  addEvents(15)
  for (const [index, event] of storedEvents().slice(-15).entries()) if (index % 3) event.data.dm_with = ids[index % 3 - 1]
  const batch = await loadGroupBatch(new ObjectId(instanceId), storedEvents().filter(event => event.data.dm_with === ids[0]).at(-1)!._id, 'curated_through_sequence')
  assert.equal(batch!.events.length, 7)
  assert(batch!.events.every(event => event.data.dm_with === ids[0]))
  assert.deepEqual(batch!.events.slice(0, 2).map(event => event.sequence), [12, 15])
})
await check('audience summary jobs store direct scenes private and shared interleaved ranges reach only their audience', async () => {
  const { cast, jess, elena } = await audienceFixture()
  // Start a fresh 24-event window, with twelve messages in each thread.
  rows('events').splice(1); addEvents(24)
  const events = storedEvents().slice(1)
  for (const [index, event] of events.entries()) {
    if (index % 2) event.data.dm_with = jess.id
    event.data.player_input = index % 2 ? 'Private scene input marker.' : 'Shared scene input marker.'
    event.data.lines![0].text = index % 2 ? 'Private scene answer marker.' : 'Shared scene answer marker.'
  }
  for (const trigger of [events.at(-1)!, events.at(-2)!]) {
    summaryReply = trigger.data.dm_with ? 'Private scene summary marker.' : 'Shared scene summary marker.'
    await summaryProcessor({ data: { instanceId, playerId, eventId: String(trigger._id), groupSummary: true, sceneTag: 'dialogue' } } as Job)
  }
  assert.equal(summaryRequests.length, 2); assert.equal(rows('sceneSummaries').length, 2)
  const [direct, shared] = rows('sceneSummaries')
  assert.equal(direct.private_to, jess.id); assert(!('private_to' in shared))
  assert(requestText(summaryRequests[0]).includes('Private scene input marker.'))
  assert(!requestText(summaryRequests[0]).includes('Shared scene input marker.'))
  assert(requestText(summaryRequests[1]).includes('Shared scene input marker.'))
  assert(!/Private scene (input|answer)/.test(requestText(summaryRequests[1])))
  assert(!/dm_with|private_to/.test(JSON.stringify(summaryRequests)))
  assert.equal(get(rows('worldInstances')[0], `group_state.direct_threads.${jess.id}.summarized_through_sequence`), 25)
  assert.equal(get(rows('worldInstances')[0], 'group_state.summarized_through_sequence'), 24)
  const candidates = rows('sceneSummaries').map(row => ({ text: String(row.summary_text),
    startSequence: Number(get(row, 'event_range.start_sequence')), endSequence: Number(get(row, 'event_range.end_sequence')) }))
  const iid = new ObjectId(instanceId)
  assert.deepEqual(await groupWriterSummaries(iid, candidates), ['Shared scene summary marker.'])
  assert.deepEqual(await groupWriterSummaries(iid, candidates, elena.id), ['Shared scene summary marker.'])
  const own = await groupWriterSummaries(iid, candidates, jess.id)
  assert.deepEqual(own, ['Private scene summary marker.', 'Shared scene summary marker.'])
  const directRequest = await fixtureDirectPrompt(cast, jess.id, [], [], undefined, own)
  assert(directRequest.includes('Private scene summary marker.'))
  const otherRequest = await fixtureDirectPrompt(cast, elena.id, [], [], undefined, await groupWriterSummaries(iid, candidates, elena.id))
  assert(!otherRequest.includes('Private scene summary marker.'))
  // Move summaries outside the recent window and exercise the real group writer.
  addEvents(35); writerCalls = []; ragSummaryHits = []
  modelReplies = ['Jess: A shared summary answer.']
  await turn({ userMessage: '@Jess continue' }, never)
  assert(writerCalls.some(request => requestText(request).includes('Shared scene summary marker.')))
  assert(writerCalls.every(request => !requestText(request).includes('Private scene summary marker.')))
  // Retrieval cannot invent an audience, text or coverage on a stored row.
  for (const invalid of [null, 'unknown', elena.id]) {
    direct.private_to = invalid
    assert.deepEqual(await groupWriterSummaries(iid, [candidates[0]], jess.id), [])
  }
  delete direct.private_to
  assert.deepEqual(await groupWriterSummaries(iid, [candidates[0]]), [])
  direct.private_to = jess.id; direct.status = 'stale'
  assert.deepEqual(await groupWriterSummaries(iid, [candidates[0]], jess.id), [])
  direct.status = 'active'
  assert.deepEqual(await groupWriterSummaries(iid, [{ ...candidates[0], text: 'Invented text.' }], jess.id), [])
  rows('events').splice(rows('events').findIndex(row => row.sequence === 25), 1)
  assert.deepEqual(await groupWriterSummaries(iid, [candidates[0]], jess.id), [])
})
await check('audience rollups keep stored children chapter arc jobs and requests in separate audiences', async () => {
  await start(); addEvents(768)
  const events = storedEvents().slice(1)
  for (const [index, event] of events.entries()) {
    if (index % 2) event.data.dm_with = ids[0]
    event.data.player_input = index % 2 ? 'Private rollup source.' : 'Shared rollup source.'
    event.data.lines![0].text = event.data.player_input
  }
  let processed = 0
  for (let block = 0; block < 32; block++) {
    for (const offset of [22, 23]) {
      const trigger = events[block * 24 + offset]
      summaryReply = trigger.data.dm_with ? 'Private rollup summary.' : 'Shared rollup summary.'
      await summaryProcessor({ data: { instanceId, playerId, eventId: String(trigger._id), groupSummary: true, sceneTag: 'dialogue' } } as Job)
      if (!trigger.data.dm_with) rows('sceneSummaries').push({ ...clone(rows('sceneSummaries').at(-1)!),
        _id: new ObjectId(), private_to: ids[1], summary_text: 'Private rollup summary.' })
    }
    while (processed < queued.length) {
      const next = queued[processed++]
      if (!['chapter', 'arc'].includes(String(next.kind))) continue
      summaryReply = next.privateTo ? 'Private rollup summary.' : 'Shared rollup summary.'
      await summaryProcessor({ data: { ...next, playerId } } as Job)
      const request = requestText(summaryRequests.at(-1)!)
      assert(request.includes(next.privateTo ? 'Private rollup summary.' : 'Shared rollup summary.'))
      assert(!request.includes(next.privateTo ? 'Shared rollup summary.' : 'Private rollup summary.'))
      assert(!/private_to|dm_with/.test(request))
    }
  }
  for (const [table, count] of [['chapterSummaries', 8], ['arcSummaries', 2]] as const) {
    assert.equal(rows(table).length, count)
    assert.equal(rows(table).filter(row => row.private_to === ids[0]).length, count / 2)
    assert.equal(rows(table).filter(row => !('private_to' in row)).length, count / 2)
    for (const row of rows(table)) assert.equal(row.summary_text, row.private_to ? 'Private rollup summary.' : 'Shared rollup summary.')
  }
  assert.equal(queued.filter(row => row.kind === 'chapter').length, 8)
  assert.equal(queued.filter(row => row.kind === 'arc').length, 2)
  // Jobs without a thread are shared, even when private stored children overlap.
  // A mislabeled child is excluded even if its range belongs to shared events.
  const first = rows('sceneSummaries')[0]
  first.private_to = ids[1]
  const previous = summaryRequests.length
  await summaryProcessor({ data: { instanceId, playerId, kind: 'chapter', chapterIndex: 1, startSequence: 2, endSequence: 192 } } as Job)
  assert.equal(summaryRequests.length, previous + 1)
  assert(!requestText(summaryRequests.at(-1)!).includes('Private rollup summary.'))
  for (const kind of ['chapter', 'arc']) {
    await assert.rejects(summaryProcessor({ data: { instanceId, playerId, kind, privateTo: null, startSequence: 2, endSequence: 769 } } as Job), /Invalid group summary audience/)
  }
})
await check('audience private thread closure keeps audience and later-event evidence', async () => {
  await start(); addEvents(5)
  for (const event of storedEvents().slice(1)) event.data.dm_with = ids[0]
  curatorFactory = request => ({ memories: [atom('The private envelope promise.', 'player', numbered(request).at(-1)!.number, { unresolved_thread: true })] })
  await memoryProcessor(memoryJob())
  const promise = rows('memories')[0]
  rows('memories').push({ ...clone(promise), _id: new ObjectId(), text: 'A shared promise.', private_to: undefined, source_event_ids: [storedEvents()[0]._id] })
  addEvents(5)
  for (const event of storedEvents().slice(-5)) event.data.dm_with = ids[0]
  curatorFactory = request => {
    assert(requestText(request).includes('T1: The private envelope promise.'))
    assert(!requestText(request).includes('A shared promise.'))
    return { memories: [], closed_threads: [{ thread_id: 'T1', source_messages: [4] }] }
  }
  await memoryProcessor(memoryJob())
  assert.equal(promise.unresolved_thread, true)
  assert(memoryLogs.some(row => row.name === 'group.memory_batch' && row.closuresRejected === 1))
  addEvents(5)
  for (const event of storedEvents().slice(-5)) event.data.dm_with = ids[0]
  curatorFactory = request => ({ memories: [], closed_threads: [{ thread_id: 'T1', source_messages: [numbered(request).at(-1)!.number] }] })
  await memoryProcessor(memoryJob())
  assert.equal(promise.unresolved_thread, false); assert.equal(promise.private_to, ids[0])
  assert.equal(rows('memories')[1].unresolved_thread, true)
})
await check('audience private rewind removes only its sourced atoms and vectors', async () => {
  await start(); addEvents(10)
  const events = storedEvents().slice(1)
  for (const event of events.slice(5)) event.data.dm_with = ids[0]
  curatorFactory = () => ({ memories: [atom('The shared envelope fact.', 'player', 1)] })
  await memoryProcessor(memoryJob(events[4]))
  curatorFactory = request => ({ memories: [atom('The private envelope fact.', 'player', numbered(request).at(-1)!.number)] })
  await memoryProcessor(memoryJob(events[9]))
  const shared = clone(rows('memories')[0]), secret = clone(rows('memories')[1])
  mock.module('../src/services/codex-media-carryover', () => ({ snapshotCodexMedia: async () => ({}), restoreCodexMedia: async () => {} }))
  const { characterCodexService } = await import('../src/services/character-codex.service')
  Object.assign(characterCodexService, { applyManualIdentityRevisions: async () => {} })
  const { entityGraphService } = await import('../src/services/entity-graph.service')
  Object.assign(entityGraphService, { repairAfterRewind: async () => {} })
  const { memoryService } = await import('../src/services/memory.service')
  const snapshotCoverage = { [ids[0]]: { curated_through_sequence: 7, summarized_through_sequence: 6 } }
  put(storedEvents()[7] as unknown as Row, 'data.group_state_after.direct_threads', snapshotCoverage)
  put(rows('worldInstances')[0], 'group_state.direct_threads', { [ids[0]]: { curated_through_sequence: 11, summarized_through_sequence: 11 }, [ids[1]]: { curated_through_sequence: 10 } })
  storedEvents()[7].time_anchor = { real_time: new Date(), sequence: 8, timeline_id: 'main' }
  await memoryService.rewindToSequence(instanceId, playerId, 9)
  assert.deepEqual(rows('memories'), [shared])
  assert(vectors.has(String(shared.pinecone_id))); assert(!vectors.has(String(secret.pinecone_id)))
  assert.deepEqual(get(rows('worldInstances')[0], 'group_state.direct_threads'), snapshotCoverage)
  storedEvents()[5].time_anchor = { real_time: new Date(), sequence: 6, timeline_id: 'main' }
  await memoryService.rewindToSequence(instanceId, playerId, 7)
  assert(!('direct_threads' in (rows('worldInstances')[0].group_state as Row)))
})
await check('audience private relationship facts never become graph edges while shared ones still do', async () => {
  const { entityGraphService } = await import('../src/services/entity-graph.service')
  const graph = entityGraphService as unknown as Row, original = { ...graph }
  const edges: Row[] = [], playerEntity = new ObjectId(), memberEntity = new ObjectId()
  Object.assign(graph, {
    ensurePlayerEntity: async () => ({ _id: playerEntity }),
    resolveOrCreateEntities: async () => new Map([[names[0].toLowerCase(), { _id: memberEntity }]]),
    upsertNarrativeEdge: async (edge: Row) => { edges.push(edge) },
  })
  try {
    for (const direct of [false, true]) {
      edges.length = 0
      await start(); addEvents(5)
      if (direct) for (const event of storedEvents().slice(1)) event.data.dm_with = ids[0]
      curatorFactory = () => ({ memories: [atom('A relationship marker.', 'player', 1, { type: 'relationship', objects: [names[0]], relationship_delta: null })] })
      await memoryProcessor(memoryJob())
      assert.equal(rows('memories')[0].private_to, direct ? ids[0] : undefined)
      assert.deepEqual(edges.map(edge => edge.label), direct ? [] : ['A relationship marker.'])
    }
  } finally { Object.assign(graph, original) }
})
await check('audience duplicate skipping preserves identical text in shared and private stores both directions', async () => {
  for (const privateFirst of [false, true]) {
    await start(); addEvents(10)
    const events = storedEvents().slice(1)
    for (const event of events.slice(0, 5)) if (privateFirst) event.data.dm_with = ids[0]
    for (const event of events.slice(5)) if (!privateFirst) event.data.dm_with = ids[0]
    curatorFactory = () => ({ memories: [atom('The same text in two audiences.', 'player', 1)] })
    await memoryProcessor(memoryJob(events[4])); await memoryProcessor(memoryJob(events[9]))
    assert.equal(rows('memories').length, 2); assert.equal(vectors.size, 2)
    assert.deepEqual(rows('memories').map(memory => memory.private_to), privateFirst ? [ids[0], undefined] : [undefined, ids[0]])
  }
  const source = storedEvents()[1]._id
  assert.equal(groupMemoryMayMerge({ subjects: ['player'], source_event_ids: [source], private_to: ids[0] }, { subjects: ['player'], source_event_ids: [source] }), false)
})
await check('audience model cannot set audience fields and public payload strips both actual fields', async () => {
  await start(); addEvents(5)
  curatorFactory = () => ({ memories: [atom('Allowed fact.', 'player', 1), atom('Spoofed private fact.', 'player', 1, { private_to: ids[0] }), atom('Spoofed thread.', 'player', 1, { dm_with: ids[0] })] })
  await memoryProcessor(memoryJob())
  assert.equal(rows('memories').length, 1)
  assert(memoryLogs.some(row => row.name === 'group.memory_batch' && row.invalidAtoms === 2))
  const event = storedEvents()[2]; event.data.dm_with = ids[0]
  rows('memories')[0].private_to = ids[0]
  const history = await generationService.loadInstance(instanceId, playerId)
  forbidden(history)
  const directHistory = await generationService.loadInstance(instanceId, playerId, ids[0])
  assert.equal(directHistory.recentEvents.length, 1); forbidden(directHistory)
  const loaded = await instanceService.getById(instanceId, playerId)
  forbidden(loaded)
  forbidden(publicGroupData(rows('memories')))
  assert(!JSON.stringify(curatorRequests[0]).includes('private_to'))
  assert(!JSON.stringify(curatorRequests[0]).includes('dm_with'))
})

await check('audience chronicle real event memory and full text payloads strip markers only for groups', async () => {
  await start(); addEvents(2)
  const event = storedEvents()[1]; event.data.dm_with = ids[0]
  rows('memories').push({ _id: new ObjectId(), instance_id: new ObjectId(instanceId), player_id: new ObjectId(playerId),
    text: 'Chronicle private fact.', private_to: ids[0], dm_with: ids[0], is_archived: false, importance: 4 })
  const { memoryService } = await import('../src/services/memory.service')
  const events = await memoryService.getEvents(instanceId, playerId, {})
  assert(events.events.length > 0); forbidden(events)
  const directEvents = await memoryService.getEvents(instanceId, playerId, { directWith: ids[0] })
  assert.equal(directEvents.events.length, 1); forbidden(directEvents)
  for (const opts of [{}, { q: 'Chronicle' }]) {
    const payload = await memoryService.getMemories(instanceId, playerId, opts)
    assert.equal(payload.length, 1); assert.equal(payload[0].text, 'Chronicle private fact.'); forbidden(payload)
  }
  assert.equal(storedEvents()[1].data.dm_with, ids[0]); assert.equal(rows('memories')[0].private_to, ids[0])
  delete rows('worldInstances')[0].group_state
  const normalEvents = await memoryService.getEvents(instanceId, playerId, {})
  assert.equal(normalEvents.events.find(row => row.sequence === 2)!.data.dm_with, ids[0])
  for (const opts of [{}, { q: 'Chronicle' }]) {
    const normal = await memoryService.getMemories(instanceId, playerId, opts)
    assert.equal(normal[0].private_to, ids[0]); assert.equal((normal[0] as unknown as Row).dm_with, ids[0])
  }
})

const socket = (output: Row[], userId = playerId) => ({ send: (text: string) => { output.push(JSON.parse(text)) }, close: unavailable,
  data: { _user: { id: userId, tier: 'creator' }, jwt: { verify: async () => false } } })
const chat = (message: string, directWith?: unknown) => ({ action: 'chat', instance_id: instanceId,
  ...(directWith === undefined ? {} : { direct_with: directWith }), payload: { message } })
await check('direct socket admission validates member ids releases reservations and forwards the job thread', async () => {
  await start()
  const reserve = billingService.reserve, release = billingService.release
  let reservations = 0, releases = 0
  billingService.reserve = async () => ({ reservation_id: `fixture-${++reservations}`, cost: 0, balance: null })
  billingService.release = async (_player, id) => { assert(id); releases++ }
  try {
    const otherId = new ObjectId().toHexString()
    rows('characters').push({ _id: new ObjectId(otherId), instance_id: new ObjectId(), canonical_name: names[1] })
    for (const invalid of [new ObjectId().toHexString(), otherId, '', 'bad', null, {}, 42]) {
      const sent: Row[] = []
      await playWsService.handleMessage(socket(sent), chat('Do you have a moment?', invalid))
      assert.equal(sent.length, 1); assert.equal(sent[0].type, 'error')
      assert.equal(sent[0].message, 'That person is not in this chat.')
      assert.equal(queued.length, 0); assert(!locks.has(`lock:gen:${playerId}:${instanceId}`))
    }
    assert.equal(reservations, 7); assert.equal(releases, reservations)
    const sent: Row[] = []
    await playWsService.handleMessage(socket(sent), chat('A private hello.', ids[1]))
    assert.equal(sent[0].type, 'ack'); assert.equal(queued[0].directWith, ids[1])
    const data = queued[0] as unknown as GroupTurnJob
    modelReplies = [`${names[0]}: Wrong member.`, `${names[1]}: Yes, I am here.`]
    await groupTurnProcessor({ id: sent[0].jobId, data } as Job<GroupTurnJob>, { rng: unavailable })
    assert.equal(writerCalls.length, 2)
    assert.deepEqual(storedEvents().at(-1)!.data.lines!.map(line => line.character_id), [ids[1]])
    assert.equal(storedEvents().at(-1)!.data.dm_with, ids[1])
    assert(!locks.has(`lock:gen:${playerId}:${instanceId}`))
  } finally { billingService.reserve = reserve; billingService.release = release }
})
await check('direct addressed retry caps at three messages drops tags and bystanders and starts without seed history', async () => {
  await start()
  modelReplies = ['', `${names[0]}: Ignore me.\n${names[1]}: One fresh answer.\n${names[1]}: A second response.\n${names[1]}: Third and last.\n${names[1]}: A fourth dropped.`]
  await turn({ directWith: ids[1], userMessage: `@${names[0]} @${names[2]} please answer me` }, never)
  assert.equal(writerCalls.length, 2)
  assert.deepEqual(writerCalls.map(call => call.model), ['fake-safe', 'fake-safe'])
  assert.deepEqual((checkLogs.at(-1)!.writing as Row[]).map(call => call.purpose), ['addressed', 'addressed_retry'])
  const event = storedEvents().at(-1)!
  assert.equal(event.data.lines!.length, 3); assert(event.data.lines!.every(line => line.character_id === ids[1]))
  for (const request of writerCalls) {
    const text = requestText(request)
    assert(text.includes(`private conversation between ${playerName} and ${names[1]}`))
    assert(text.includes('Only these two can see it.'))
    assert(text.includes(`Only these people write in this reply: ${names[1]}.`))
    const history = text.split('Recent messages:\n')[1].split('\n\n')[0]
    assert(!history.includes('The authored opening.'))
    assert(text.includes('Group chat (read-only; everyone saw these messages):\n'))
    assert(text.includes('The authored opening.'))
    assert.equal(request.maxTokens, 300)
  }
  const frame = frames.find(frame => frame.type === 'group_lines')!
  assert.equal(frame.directWith, ids[1]); forbidden(frames)
})
await check('direct reply helper ignores rolled speakers and tags even on adult rescue attempts', async () => {
  const calls: string[][] = []
  const reply = await writeGroupReply({ ...opts, player: playerName, direct: ids[1], tags: [ids[0], ids[2]],
    adult: { addressed: ids[1], rng: () => 0 }, write: async speakers => {
      calls.push(speakers)
      return { content: calls.length === 1 ? '' : `${names[0]}: Bad bystander.\n${names[1]}: Private helper answer.`, model: 'fake-direct' }
    } })
  assert.deepEqual(calls, [[ids[1]], [ids[1]]])
  assert.deepEqual(reply.lines.map(line => line.name), [names[1]])
})
await check('direct actual adult prompts omit group context and normal prompts include it on every retry and fallback', async () => {
  for (const scenario of ['normal', 'adult', 'content retry', 'content fallback', 'transport', 'withdraw retry', 'withdraw transport', 'uninterested', 'fear'] as const) {
    await adultStart()
    if (scenario === 'normal') put(rows('users')[0], 'preferences.nsfw_enabled', false)
    if (scenario === 'fear') { routeUser = { id: playerId, tier: 'creator' }; assert.equal((await bondHttp('PUT', { fear: 70 })).status, 200) }
    if (scenario === 'uninterested') {
      const cast = rows('worldInstances')[0].seed_cast_snapshot as Row[]
      put(cast[0], 'group.start_bond', 'enemy')
    }
    const answer = `${names[0]}: A fresh private answer.`
    const first = scenario.includes('transport') ? new Error('429 unavailable') : ''
    modelReplies = scenario === 'content fallback' ? ['', '', '', answer]
      : ['content retry', 'transport', 'withdraw retry', 'withdraw transport', 'normal', 'uninterested', 'fear'].includes(scenario) ? [first, answer] : [answer]
    if (scenario.startsWith('withdraw')) writerHook = () => put(rows('users')[0], 'preferences.nsfw_enabled', false)
    await turn({ directWith: ids[0], userMessage: 'A private current line.' }, never)
    const writing = checkLogs.at(-1)!.writing as Row[]
    assert.equal(writing.length, writerCalls.length)
    if (scenario === 'content fallback') assert.deepEqual(writing.map(call => call.writer), ['adult', 'adult', 'adult', 'normal'])
    if (scenario.startsWith('withdraw')) assert.deepEqual(writing.map(call => call.writer), ['adult', 'normal'])
    if (scenario === 'normal' || scenario === 'fear') assert(writing.every(call => call.writer === 'normal'))
    for (const [index, request] of writerCalls.entries()) {
      const text = requestText(request), isAdult = writing[index].writer === 'adult'
      assert.equal(text.includes('Group chat (read-only; everyone saw these messages):\n'), !isAdult, scenario + ': group block on ' + index)
      assert.equal(text.includes('The authored opening.'), !isAdult, scenario + ': group text on ' + index)
      assert(text.includes('A private current line.'))
      assert(text.includes(`private conversation between ${playerName} and ${names[0]}`))
    }
  }
})

await check('direct local summaries and adult last twelve history use only their thread', async () => {
  await start(); addEvents(40, members[1])
  const events = storedEvents().slice(1)
  for (const event of events) { event.data.dm_with = ids[1]; event.data.lines![0].text = `Direct history ${event.sequence}.` }
  rows('sceneSummaries').push({ _id: new ObjectId(), instance_id: new ObjectId(instanceId), private_to: ids[1], summary_text: 'Older direct summary marker.',
    event_range: { start_sequence: 2, end_sequence: 10 }, status: 'active' })
  modelReplies = [`${names[1]}: A normal private response.`]
  await turn({ directWith: ids[1] }, never)
  assert(requestText(writerCalls[0]).includes('Older direct summary marker.'))
  put(rows('users')[0], 'preferences.nsfw_enabled', true); auditEnv.NSFW_SAME_TURN_ROUTER = 'on'
  writerCalls = []; modelReplies = [`${names[1]}: A fresh intimate response.`]
  await turn({ directWith: ids[1] }, never)
  const history = requestText(writerCalls[0]).split('Recent messages:\n')[1].split('\n\n')[0]
  assert(history.includes(`${names[1]}: Direct history 37.`)); assert(!history.includes('Direct history 36.'))
  assert(history.includes('A normal private response.'))
  assert(!requestText(writerCalls[0]).includes('Older direct summary marker.'))
  assert(!requestText(writerCalls[0]).includes('filler 1'))
})
await check('direct real Jess and Elena prompts separate history memories summaries retrieval context and group block', async () => {
  const { jess, elena } = await audienceFixture()
  const events = storedEvents()
  const secret = events[2], other = events[3]
  secret.data.dm_with = jess.id; secret.data.player_input = 'Private Jess envelope.'; secret.data.lines![0].text = 'Private Jess reply.'
  other.data.dm_with = elena.id; other.data.player_input = 'Private Elena copper.'; other.data.lines![0].character_id = elena.id; other.data.lines![0].text = 'Private Elena reply.'
  const summaryText = 'Private Jess old summary.'
  rows('sceneSummaries').push({ _id: new ObjectId(), instance_id: new ObjectId(instanceId), private_to: jess.id, summary_text: summaryText,
    event_range: { start_sequence: secret.sequence, end_sequence: secret.sequence }, status: 'active' })
  ragSummaryHits = [{ id: 'stored', tier: 'scene', text: summaryText, startSequence: secret.sequence, endSequence: secret.sequence }]
  const mem = (text: string, source: typeof secret, privateTo?: string) => ({ _id: new ObjectId(), instance_id: new ObjectId(instanceId),
    player_id: new ObjectId(playerId), text, subjects: ['player'], objects: [], is_archived: false, importance: 4,
    source_event_ids: [source._id], ...(privateTo ? { private_to: privateTo } : {}), updated_at: new Date() })
  rows('memories').push(mem('Shared memory marker.', events[1]), mem('Jess memory marker.', secret, jess.id), mem('Elena memory marker.', other, elena.id))
  const expectedBlock = groupMessages(events, playerName, [jess, elena, ...members.slice(2)]).slice(-8).map(line => `${line.name}: ${line.text}`).join('\n')
  modelReplies = ['Jess: A direct reply from her.']; writerCalls = []; ragCalls = []
  await turn({ directWith: jess.id, userMessage: 'Jess current private line.' }, never)
  const body = requestText(writerCalls[0])
  for (const value of ['Private Jess envelope.', 'Private Jess reply.', summaryText, 'Jess memory marker.', 'Shared memory marker.', expectedBlock]) assert(body.includes(value), value)
  for (const value of ['Private Elena copper.', 'Private Elena reply.', 'Elena memory marker.']) assert(!body.includes(value), value)
  assert.deepEqual(ragCalls[0][9], { thread: jess.id })
  assert.equal(ragCalls[0][2], `${playerName}: Private Jess envelope.\nJess: Private Jess reply.\n${playerName}: Jess current private line.`)
  const boundary = storedEvents().length
  addEvents(8, jess)
  for (const event of storedEvents().slice(boundary)) event.data.dm_with = jess.id
  writerCalls = []; ragCalls = []; modelReplies = ['Elena: A direct reply from her.']
  await turn({ directWith: elena.id, userMessage: 'Elena current private line.' }, never)
  const priyaBody = requestText(writerCalls[0])
  assert(priyaBody.includes(expectedBlock))
  for (const value of ['Private Elena copper.', 'Private Elena reply.', 'Elena memory marker.', 'Shared memory marker.']) assert(priyaBody.includes(value), value)
  assert(!/Private Jess|Jess memory marker|Jess current private/.test(priyaBody))
  assert.deepEqual(ragCalls[0][9], { thread: elena.id })
  assert(!String(ragCalls[0][2]).includes('Jess'))
  writerCalls = []; ragCalls = []; modelReplies = ['Jess: A shared fresh reply.']
  await turn({ userMessage: '@Jess Hello group.' }, never)
  assert(writerCalls.every(request => !/Private Jess|Private Elena|memory marker\.|current private|Group chat \(read-only/.test(requestText(request).replace('Shared memory marker.', ''))))
  assert(ragCalls.every(call => !/Private Jess|Private Elena|current private/.test(String(call[2]))))
  assert(ragCalls.every(call => call.length === 10 && (call[9] as Row).thread === undefined))
})
await check('direct repeat histories are isolated both ways including the group block and seed openings', async () => {
  await start()
  modelReplies = [`${names[0]}: The authored opening.`]
  await turn({ directWith: ids[0] }, never)
  assert.equal(writerCalls.length, 1)
  // A group's line and a different thread's line cannot reject a direct reply.
  modelReplies = [`${names[0]}: A shared identical sentence.`]; await turn({}, never)
  modelReplies = [`${names[0]}: A shared identical sentence.`]; writerCalls = []
  await turn({ directWith: ids[0] }, never); assert.equal(writerCalls.length, 1)
  modelReplies = [`${names[1]}: A shared identical sentence.`]; writerCalls = []
  await turn({ directWith: ids[1] }, never); assert.equal(writerCalls.length, 1)
  modelReplies = [`${names[1]}: A shared identical sentence.`, `${names[1]}: A changed private reply.`]; writerCalls = []
  await turn({ directWith: ids[1] }, never); assert.equal(writerCalls.length, 2)
  modelReplies = [`${names[1]}: A shared identical sentence.`]; writerCalls = []
  await turn({ userMessage: `@${names[1]} hello` }, never); assert.equal(writerCalls.length, 1)
  assert(storedEvents().at(-1)!.data.lines!.some(line => line.text === 'A shared identical sentence.'))
})
await check('direct turns preserve all group pacing state while independent thread cadences queue real batches', async () => {
  await start()
  Object.assign(rows('worldInstances')[0].group_state as Row, { silent_for: { ...zero, [ids[0]]: 7 }, unprompted_since_player: 3,
    topics_used: 5, writing_calls: 13 })
  const before = clone(rows('worldInstances')[0].group_state)
  for (let i = 1; i <= 12; i++) {
    modelReplies = [`${names[0]}: Direct event number ${i}.`]
    await turn({ directWith: ids[0], userMessage: `Thread input ${i}` }, never)
    const expected = { ...(before as Row), unprompted_since_player: 0, last_seen_at: get(rows('worldInstances')[0], 'group_state.last_seen_at') }
    assert.deepEqual(rows('worldInstances')[0].group_state, expected)
    assert.deepEqual(storedEvents().at(-1)!.data.group_state_after, expected)
    if (i === 6) { modelReplies = [`${names[1]}: Other thread event.`]; await turn({ directWith: ids[1] }, never) }
  }
  assert.equal(outbox.filter(job => job.kind === 'memory_curation').length, 2)
  assert.equal(outbox.filter(job => job.kind === 'scene_summary').length, 1)
  assert.deepEqual(outbox.map(job => [job.kind, storedEvents().find(event => String(event._id) === (job.payload as Row).eventId)!.sequence]),
    [['memory_curation', 6], ['memory_curation', 12], ['scene_summary', 14]])
  for (const queued of outbox) {
    const payload = queued.payload as Row
    assert.equal(storedEvents().find(event => String(event._id) === payload.eventId)!.data.dm_with, ids[0])
  }
  const batch = await loadGroupBatch(new ObjectId(instanceId), storedEvents().at(-1)!._id, 'curated_through_sequence')
  assert(batch); assert.equal(batch.thread, ids[0]); assert.equal(batch.events.length, 12)
  assert(batch.events.every(event => event.data.dm_with === ids[0] && event.data.model_used !== 'seed'))
  curatorFactory = () => ({ memories: [atom('A direct batch fact.', 'player', 1)] })
  for (const job of outbox.filter(job => job.kind === 'memory_curation')) await memoryProcessor({ data: job.payload } as Job)
  assert.equal(rows('memories')[0].private_to, ids[0])
  assert(!JSON.stringify(curatorRequests).includes('The authored opening.'))
  assert(!JSON.stringify(curatorRequests).includes('Other thread event.'))
  const summaryOutbox = outbox.find(job => job.kind === 'scene_summary')!
  await summaryProcessor({ data: summaryOutbox.payload } as Job)
  assert.equal(rows('sceneSummaries')[0].private_to, ids[0])
  assert(!JSON.stringify(summaryRequests).includes('The authored opening.'))
  assert(!JSON.stringify(summaryRequests).includes('Other thread event.'))
  assert.equal(get(rows('worldInstances')[0], `group_state.direct_threads.${ids[0]}.curated_through_sequence`), 12)
  assert.equal(get(rows('worldInstances')[0], 'group_state.curated_through_sequence'), 1)
})
await check('adult plain question mid-scene gets one message; other lines keep three', async () => {
  await start(); auditEnv.NSFW_SAME_TURN_ROUTER = 'on'; put(rows('users')[0], 'preferences.nsfw_enabled', true)
  judgeVerdict = true; routerSexual = true
  // The scene score counts recent intimate turns, so carryover needs a run of them.
  for (const reply of ['First direct adult answer.', 'Second direct adult answer.']) {
    modelReplies = [`${names[1]}: ${reply}`]
    await turn({ directWith: ids[1], userMessage: 'I want you.' }, never)
  }
  const reply = (first: string, second: string, third: string) => [first, second, third].map(line => `${names[1]}: ${line}`).join('\n')
  routerSexual = false; writerCalls = []; modelReplies = [reply('The answer itself.', 'Pears ripen slowly.', 'Trains arrive late.')]
  await turn({ directWith: ids[1], userMessage: 'what did I tell you earlier?' }, never)
  assert.equal(writerCalls[0].model, 'fake-adult')
  assert(requestText(writerCalls[0]).includes('Write one message, answering what was asked.'))
  assert.deepEqual((lastData().lines as Row[]).map(line => line.text), ['The answer itself.'])
  writerCalls = []; modelReplies = [reply('Clouds gather overhead.', 'Rivers bend southward.', 'Lamps flicker twice.')]
  await turn({ directWith: ids[1], userMessage: 'keep telling me' }, never)
  assert(requestText(writerCalls[0]).includes('Write one to three messages.')); assert.equal((lastData().lines as Row[]).length, 3)
  routerSexual = true; writerCalls = []; modelReplies = [reply('Stones skip nicely.', 'Owls hunt quietly.', 'Ferns uncurl daily.')]
  await turn({ directWith: ids[1], userMessage: 'will you touch me?' }, never)
  assert(requestText(writerCalls[0]).includes('Write one to three messages.')); assert.equal((lastData().lines as Row[]).length, 3)
  auditEnv.NSFW_SAME_TURN_ROUTER = 'off'; routerSexual = false
})
await check('group writer stall moves on to the next model within the limit', async () => {
  assert.equal(groupWriterHostFailed(Object.assign(new Error('x'), { name: 'APIConnectionTimeoutError' })), true)
  assert.equal(groupWriterHostFailed(new Error('Request timed out.')), true)
  assert.equal(groupWriterHostFailed(new Error('Broken response')), false)
  assert.equal(groupWriterHostFailed(Object.assign(new Error('Bad gateway'), { status: 502 })), true)
  assert.equal(groupWriterHostFailed(Object.assign(new Error('Bad request'), { status: 400 })), false)
  await start(); writerCalls = []
  modelReplies = [new Error('Request timed out.'), `${names[0]}: After the stall.`]
  await turn({ userMessage: 'anyone about', directWith: ids[0] }, never)
  assert.deepEqual(writerCalls.map(call => call.timeoutMs), [GROUP_WRITER_TIMEOUT_MS, GROUP_WRITER_TIMEOUT_MS])
  assert.equal(GROUP_WRITER_TIMEOUT_MS, 20_000)
  assert.notEqual(writerCalls[0].model, writerCalls[1].model)
  assert.equal(rows('events').at(-1)!.data.lines?.at(-1)?.text, 'After the stall.')
})
await check('adult fact question goes to the normal writer; an unrelated question stays adult', async () => {
  await start(); auditEnv.NSFW_SAME_TURN_ROUTER = 'on'; put(rows('users')[0], 'preferences.nsfw_enabled', true); judgeVerdict = true; routerSexual = true
  for (const reply of ['First direct adult answer.', 'Second direct adult answer.']) {
    modelReplies = [`${names[1]}: ${reply}`]
    await turn({ directWith: ids[1], userMessage: 'I want you.' }, never)
  }
  const source = storedEvents().at(-1)!
  const fact = (text: string, extra: Row = {}) => rows('memories').push({ _id: new ObjectId(), instance_id: new ObjectId(instanceId), player_id: new ObjectId(playerId), text, subjects: ['player'], objects: [],
    source_event_ids: [source._id], private_to: ids[1], is_nsfw: false, is_archived: false, importance: 3, updated_at: new Date(), ...extra })
  fact('The player keeps a walnut wardrobe.')
  fact('The player craves a velvet blindfold.', { explicit_fact: true, is_nsfw: true })
  routerSexual = false
  const ask = async (userMessage: string, directWith: string | undefined = ids[1]) => {
    writerCalls = []; modelReplies = [`${names[1]}: Answering ${String(rows('events').length).replace(/\d/g, digit => 'abcdefghij'[Number(digit)])}.`]
    await turn({ directWith, userMessage }, never)
    return { model: writerCalls[0].model, type: rows('events').at(-1)!.type }
  }
  assert.deepEqual(await ask('where is my wardrobe?'), { model: 'fake-safe', type: 'narration' })
  routerSexual = true
  assert.equal((await ask('I want you.')).model, 'fake-adult')
  routerSexual = false
  assert.equal((await ask('do you like my blindfold?')).model, 'fake-adult')
  assert.equal((await ask('anything on your mind?')).model, 'fake-adult')
  assert.equal((await ask('tell me about my wardrobe')).model, 'fake-adult')
  // The question after a plain answer is plain too, whatever its words; after an adult turn it isn't.
  assert.equal((await ask('where is my wardrobe?')).model, 'fake-safe')
  assert.deepEqual(await ask('anything on your mind?'), { model: 'fake-safe', type: 'narration' })
  routerSexual = true
  await ask('I want you.')
  assert.equal((await ask('I want you now.')).model, 'fake-adult')
  routerSexual = false
  assert.equal((await ask('anything on your mind?')).model, 'fake-adult')
  // Another thread's private fact can't send a question to the normal writer.
  assert.equal(await groupLineRaisesFact({ instanceId: new ObjectId(instanceId), player: playerName, speakers: [names[0]], thread: ids[0], line: 'where is my wardrobe?' }), false)
  assert.equal(await groupLineRaisesFact({ instanceId: new ObjectId(instanceId), player: playerName, speakers: [names[1]], thread: ids[1], line: 'where is my wardrobe?' }), true)
  auditEnv.NSFW_SAME_TURN_ROUTER = 'off'; routerSexual = false
})
await check('memory adult writer claims: everyday claims go, explicit lines and player lines stay', async () => {
  const eventId = new ObjectId()
  const message = (number: number, name: string, adult: boolean) => ({ number, name, text: 'x', eventId, adult })
  const group = { player: playerName, messages: [message(1, names[0], true), message(2, playerName, true), message(3, names[0], false)] }
  const atom2 = (is_nsfw: boolean, ...source_messages: number[]) => ({ is_nsfw, source_messages })
  const kept = dropAdultWriterClaims(group, [atom2(false, 1), atom2(true, 1), atom2(false, 2), atom2(false, 3), atom2(false, 1, 2)])
  assert.equal(kept.adultClaims, 1)
  assert.deepEqual(kept.memories.map(row => row.source_messages), [[1], [2], [3], [1, 2]])
  assert.equal(kept.memories[0].is_nsfw, true)
  // A batch holding only such claims is finished, not failed, so its watermark moves on.
  await start(); addEvents(5)
  for (const event of storedEvents().slice(1)) event.type = 'intimate'
  curatorFactory = request => { const line = numbered(request).filter(row => row.speaker !== playerName).at(-1)!; return { memories: [atom('Nobody else knows.', names[0], line.number)] } }
  await memoryProcessor(memoryJob())
  assert.equal(rows('memories').filter(row => row.text === 'Nobody else knows.').length, 0)
  // With no player line to fall back on, the batch is still finished rather than failed.
  await start(); addEvents(5)
  for (const event of storedEvents().slice(1)) { event.type = 'intimate'; event.data.player_input = '' }
  curatorFactory = request => { const line = numbered(request).filter(row => row.speaker !== playerName).at(-1)!; return { memories: [atom('Nobody else knows.', names[0], line.number)] } }
  await memoryProcessor(memoryJob())
  assert.equal(rows('memories').length, 0)
  await start(); addEvents(5)
  for (const event of storedEvents().slice(1)) event.type = 'intimate'
  curatorFactory = request => { const line = numbered(request).filter(row => row.speaker !== playerName).at(-1)!; return { memories: [atom('An explicit member line.', names[0], line.number, { is_nsfw: true })] } }
  await memoryProcessor(memoryJob())
  assert.equal(rows('memories').filter(row => row.text === 'An explicit member line.').length, 1)
  await start(); addEvents(5)
  for (const event of storedEvents().slice(1)) event.type = 'intimate'
  curatorFactory = request => { const line = numbered(request).filter(row => row.speaker !== playerName).at(-1)!; return { memories: [atom('Nobody else knows.', names[0], line.number)] } }
  await memoryProcessor(memoryJob())
  assert(get(rows('worldInstances')[0], 'group_state.curated_through_sequence') > 1)
})
await check('direct prompt puts the conversation after the group block and a guessed number never lands', async () => {
  await start()
  writerCalls = []; modelReplies = [`${names[1]}: The code is 8362.\n${names[1]}: No idea, sorry.`]
  await turn({ directWith: ids[1], userMessage: 'what was the code?' }, never)
  const text = requestText(writerCalls[0])
  assert(text.includes('Group chat (read-only')); assert(text.indexOf('Group chat (read-only') < text.indexOf('Recent messages:')); assert(text.indexOf('Recent messages:') < text.indexOf('Now:'))
  assert(text.includes('nothing in it was said here'))
  assert.deepEqual((lastData().lines as Row[]).map(line => line.text), ['No idea, sorry.'])
  writerCalls = []; modelReplies = [`${names[1]}: You just said 7219.`]
  await turn({ directWith: ids[1], userMessage: 'my code is 7219' }, never)
  assert.deepEqual((lastData().lines as Row[]).map(line => line.text), ['You just said 7219.'])
})
await check('adult prompt says who is who', async () => {
  const text = buildAddressedStatic({ seed_prompt: '', global_lore: '', members, player: playerName }, members[0])
  assert(text.includes(`"I" is ${names[0]} and "you" is ${playerName}`))
})
await check('adult scene wiring passes the recent events to memory', async () => {
  await start(); auditEnv.NSFW_SAME_TURN_ROUTER = 'on'; put(rows('users')[0], 'preferences.nsfw_enabled', true); judgeVerdict = true; routerSexual = true
  rows('memories').push({ _id: new ObjectId(), instance_id: new ObjectId(instanceId), player_id: new ObjectId(playerId), text: `${names[1]} has a very recent scene fact.`, subjects: [names[1]], objects: [],
    source_event_ids: [storedEvents().at(-1)!._id], explicit_fact: true, is_nsfw: true, is_archived: false, importance: 3, updated_at: new Date() })
  writerCalls = []; modelReplies = [`${names[1]}: First direct adult answer.`]
  await turn({ userMessage: `@${names[1]} I want you.` }, never)
  assert(!requestText(writerCalls[0]).includes('very recent scene fact'))
  auditEnv.NSFW_SAME_TURN_ROUTER = 'off'; routerSexual = false
})
await check('refile spoken facts under the player', () => {
  const eventA = new ObjectId(), eventB = new ObjectId(), eventC = new ObjectId()
  const message = (number: number, eventId: ObjectId, name: string, text: string, adult = false) => ({ number, eventId, name, text, adult })
  const group = { player: 'Sam', messages: [
    message(1, eventA, 'Sam', 'the only other person who knows is my cousin ines, she lives over in whitby.'),
    message(2, eventA, 'Jess', 'whitby! that is a long way for a secret to travel.'),
    message(3, eventB, 'Sam', 'I want you naked on the kitchen table tonight.', true),
    message(4, eventB, 'Jess', 'my feet hurt and the kitchen is a mess, honestly.', true),
    message(5, eventC, 'Sam', 'is that a tiny tattoo on your arm?'),
    message(6, eventC, 'Jess', 'yes, a tiny tattoo on my arm.'),
  ] } as never
  const atom = (text: string, subjects: string[], source_messages: number[], is_nsfw = false) => ({ text, subjects, objects: [] as string[], source_messages, is_nsfw })
  const wrong = atom('Jess has a cousin named Ines who lives over in Whitby.', ['Jess'], [1, 2])
  const { memories, refiled } = refileSpokenFacts(group, [wrong])
  assert.equal(refiled, 1)
  assert.deepEqual(memories, [{ ...wrong, text: 'Sam said: the only other person who knows is my cousin ines, she lives over in whitby.', is_nsfw: false, subjects: ['player'], objects: ['Jess'], source_messages: [1] }])
  // Citing only the reply still finds the player's line in that turn; a second reading collapses.
  assert.equal(refileSpokenFacts(group, [wrong, atom('Jess has a cousin Ines over in Whitby.', ['Jess'], [2])]).memories.length, 1)
  const adult = refileSpokenFacts(group, [atom('Jess is naked on the kitchen table.', ['Jess'], [3, 4], false)]).memories[0]
  assert.equal(adult.is_nsfw, true)
  const kept = [
    atom('Jess said the kitchen is a mess and her feet hurt.', ['Jess'], [4]),
    atom('Sam has a cousin Ines in Whitby.', ['Sam'], [1]),
    atom('Sam has a cousin Ines in Whitby.', ['player'], [1]),
    atom('Ines lives over in Whitby.', ['Ines'], [1]),
    atom('Jess thinks secrets travel badly.', ['Jess'], [2]),
    atom('Jess whispered about Ines at length.', ['Jess'], [1]),
    atom('Jess has a tiny tattoo.', ['Jess'], [5, 6]),
    atom('Jess heard about the cousin Ines over in Whitby.', ['player', 'Jess'], [1]),
  ]
  const unchanged = refileSpokenFacts(group, kept)
  assert.equal(unchanged.refiled, 0); assert.deepEqual(unchanged.memories, kept)
})
await check('adult marks clear only on everyday lines with no explicit language', () => {
  const eventId = new ObjectId()
  const group = { messages: [{ number: 1, name: names[0], text: 'he lost his job last week', eventId, adult: false }, { number: 2, name: names[0], text: 'hard against the wall', eventId, adult: true }] }
  const cleared = clearEverydayAdultMarks(group as never, [
    { text: 'Sam lost his job.', is_nsfw: true, source_messages: [1] },
    { text: 'Sam lost his job.', is_nsfw: true, source_messages: [2] },
    { text: 'Sam touched her pussy.', is_nsfw: true, source_messages: [1] },
    { text: 'Sam lost his job.', is_nsfw: false, source_messages: [1] },
  ])
  assert.deepEqual(cleared.memories.map(row => row.is_nsfw), [false, true, true, false])
  assert.equal(cleared.cleared, 1)
})
await check('adult gap counts new adult turns no explicit fact cites', () => {
  const ids = [new ObjectId(), new ObjectId(), new ObjectId(), new ObjectId()]
  const events = ids.map(_id => ({ _id }))
  const messages = [...ids.map((eventId, index) => ({ number: index + 1, name: playerName, text: 'x', eventId, adult: index !== 3 }))]
  const group = { messages, events, overlap: 1 } as never
  const atom2 = (is_nsfw: boolean, ...source_messages: number[]) => ({ is_nsfw, source_messages })
  assert.deepEqual([...uncoveredAdultEvents(group, []).uncovered].sort(), [String(ids[1]), String(ids[2])].sort())
  assert.equal(uncoveredAdultEvents(group, []).short, true)
  // One of two covered is not short; a fact on the overlap or the everyday turn covers nothing.
  assert.equal(uncoveredAdultEvents(group, [atom2(true, 2)]).short, false)
  assert.equal(uncoveredAdultEvents(group, [atom2(true, 1), atom2(true, 4)]).short, true)
  assert.equal(uncoveredAdultEvents(group, [atom2(false, 2), atom2(false, 3)]).short, true)
  assert.equal(uncoveredAdultEvents({ messages: [messages[3]], events: [events[3]], overlap: 0 } as never, []).short, false)
})
await check('adult retry keeps only explicit new facts', () => {
  const kept = adultRetryAtoms([{ text: 'Already  held.' }], [
    { text: 'New fact.', is_nsfw: true },
    { text: 'NEW FACT.', is_nsfw: true },
    { text: 'already held.', is_nsfw: true },
    { text: 'Everyday.', is_nsfw: false },
  ])
  assert.deepEqual(kept.map(row => row.text), ['New fact.'])
})
await check('adult line backstop keeps only the player on uncovered turns', () => {
  const ids = [new ObjectId(), new ObjectId()]
  const line = (number: number, name: string, eventId: ObjectId, adult = true) => ({ number, name, text: `line ${number}`, eventId, adult })
  const group = { player: playerName, messages: [line(1, playerName, ids[0]), line(2, names[0], ids[0]), line(3, playerName, ids[1]), line(4, playerName, ids[0], false)] } as never
  const kept = adultLineAtoms(group, new Set([String(ids[0])]))
  assert.deepEqual(kept.map(row => [row.text, row.source_messages, row.is_nsfw, row.subjects]), [[`${playerName} said: line 1`, [1], true, ['player']]])
})
await check('memory short adult batch asks again without threads and keeps the first answer', async () => {
  const thread = (source: Row) => rows('memories').push({ _id: new ObjectId(), instance_id: new ObjectId(instanceId), player_id: new ObjectId(playerId),
    text: 'An open promise.', subjects: ['player'], objects: [], source_event_ids: [source._id], unresolved_thread: true, is_nsfw: false, is_archived: false, importance: 3, updated_at: new Date() })
  const playerLines = (request: Row) => numbered(request).filter(row => row.speaker === playerName)
  await start(); addEvents(5); thread(storedEvents()[0])
  for (const event of storedEvents().slice(1)) event.type = 'intimate'
  curatorFactory = request => curatorRequests.length === 1
    ? { memories: [atom('The first answer.', 'player', playerLines(request)[0].number)] }
    : { memories: playerLines(request).map((line, index) => atom(`Scene fact ${index}.`, 'player', line.number, { is_nsfw: true })) }
  await memoryProcessor(memoryJob())
  assert.equal(curatorRequests.length, 2)
  const prompt = (request: Row) => String((request.messages as Row[])[1].content)
  assert(prompt(curatorRequests[0]).includes('An open promise.'))
  assert(!prompt(curatorRequests[1]).includes('An open promise.'))
  const texts = rows('memories').map(row => row.text)
  assert(texts.includes('The first answer.'))
  assert(texts.some(text => String(text).startsWith('Scene fact')))
  assert(!texts.some(text => String(text).includes(' said: ')))
  assert(memoryLogs.some(row => row.name === 'group.memory_validation' && Number(row.adultRetryFacts) > 0 && row.adultLinesKept === 0))
  assert.equal(get(rows('worldInstances')[0], 'group_state.curated_through_sequence') > 1, true)
  // Facts on only some turns are still facts: the last resort is for an answer with none.
  await start(); addEvents(5)
  for (const event of storedEvents().slice(1)) event.type = 'intimate'
  curatorFactory = request => curatorRequests.length === 1 ? { memories: [] } : { memories: [atom('One scene fact.', 'player', playerLines(request)[1].number, { is_nsfw: true })] }
  await memoryProcessor(memoryJob())
  assert.deepEqual(rows('memories').map(row => row.text).filter(text => String(text).includes(' said: ')), [])
  // A covered batch costs no second call, and neither does an everyday one.
  await start(); addEvents(5)
  for (const event of storedEvents().slice(1)) event.type = 'intimate'
  curatorFactory = request => ({ memories: playerLines(request).map((line, index) => atom(`Covered ${index}.`, 'player', line.number, { is_nsfw: true })) })
  await memoryProcessor(memoryJob()); assert.equal(curatorRequests.length, 1)
  await start(); addEvents(5)
  curatorFactory = request => ({ memories: [atom('Everyday.', 'player', numbered(request)[0].number)] })
  await memoryProcessor(memoryJob()); assert.equal(curatorRequests.length, 1)
  // A failed second try, or one still short, leaves the player's lines word for word.
  for (const second of [new Error('Stub curator failed'), 'broken json', { memories: [] }]) {
    await start(); addEvents(5)
    for (const event of storedEvents().slice(1)) event.type = 'intimate'
    curatorFactory = request => curatorRequests.length === 1 ? { memories: [atom('The first answer.', 'player', playerLines(request)[0].number)] } : second
    await memoryProcessor(memoryJob())
    const kept = rows('memories').map(row => String(row.text))
    assert(kept.includes('The first answer.'))
    assert(kept.some(text => text.startsWith(`${playerName} said: `)))
    assert(rows('memories').filter(row => String(row.text).startsWith(`${playerName} said: `)).every(row => row.is_nsfw === true && row.explicit_fact === true))
  }
  // An empty first answer on an adult batch goes to the second try rather than failing.
  await start(); addEvents(5)
  for (const event of storedEvents().slice(1)) event.type = 'intimate'
  curatorFactory = request => curatorRequests.length === 1 ? { memories: [] } : { memories: playerLines(request).map((line, index) => atom(`Scene fact ${index}.`, 'player', line.number, { is_nsfw: true })) }
  await memoryProcessor(memoryJob()); assert(rows('memories').some(row => String(row.text).startsWith('Scene fact')))
})
await check('memory everyday fact marked adult is stored plain', async () => {
  await start(); addEvents(5)
  curatorFactory = request => ({ memories: [atom('A person lost a job.', 'player', numbered(request)[0].number, { is_nsfw: true })] })
  await memoryProcessor(memoryJob())
  assert.equal(rows('memories')[0].is_nsfw, false); assert.equal(rows('memories')[0].explicit_fact, undefined)
})
await check('refile wiring runs before stored atoms', async () => {
  const source = await Bun.file('worker/processors/memory.processor.ts').text()
  assert(source.indexOf('refileSpokenFacts(group, claims.memories') > source.indexOf('dropAdultWriterClaims(group, marks.memories)'))
  assert(source.indexOf('refileSpokenFacts(group, claims.memories') < source.indexOf('const missedDetails = missedDetailAtoms'))
  assert(source.includes('return spoken.memories'))
})
await check('hidden words filter drops statements and keeps questions', () => {
  const member = { id: 'one', name: 'Anya', group: {} } as never
  const counts = emptyLineCounts()
  const lines = [{ name: 'Anya', text: 'your locker code is your birthday.' }, { name: 'Anya', text: 'what locker?' }, { name: 'Anya', text: 'kettle is on.' }]
  const kept = filterLines(lines, { members: [member], speakers: ['one'], origin: 'player', previous: [], openings: [], blocked: () => false, hiddenWords: ['locker'] }, counts)
  assert.deepEqual(kept.map(line => line.text), ['what locker?', 'kettle is on.'])
  assert.equal(counts.hidden_guess, 1)
})
await check('hidden words lookup comes from private threads only', async () => {
  await start()
  const iid = new ObjectId(instanceId), memory = (text: string, private_to?: string) => ({ _id: new ObjectId(), instance_id: iid, text, is_archived: false, ...(private_to ? { private_to } : {}) })
  rows('memories').push(memory('Sam said: my locker code was PERSIMMON and the badge remains.', ids[0]), memory('Everyone saw the broken boiler downstairs.'))
  const ask = (line: string, thread?: string, known: string[] = [], lines: Array<{ name: string; text: string }> = []) => groupHiddenWords({ instanceId: iid, thread, line, people: names, known, lines })
  assert.deepEqual(await ask('what about the locker badge?'), ['locker', 'badge'])
  assert.deepEqual(await ask('what about the locker badge?', ids[1]), ['locker', 'badge'])
  assert.deepEqual(await ask('what about the locker badge?', ids[0]), [])
  assert.deepEqual(await ask('tell me about the locker badge.'), [])
  assert.deepEqual(await ask('what about the broken boiler?'), [])
  assert.deepEqual(await ask('what about the locker badge?', undefined, ['The badge was lost.']), ['locker'])
  assert.deepEqual(await ask('what about the locker badge?', undefined, [], [{ name: 'Sam', text: 'where is my locker?' }, { name: 'Tom', text: 'the badge was lost.' }]), ['locker'])
})
await check('hidden words turn tells the writer, drops the guess and never fails the reply', async () => {
  await start()
  rows('memories').push({ _id: new ObjectId(), instance_id: new ObjectId(instanceId), text: 'Sam said: my locker code was PERSIMMON, by the orchard.', private_to: ids[0], is_archived: false })
  writerCalls = []; modelReplies = [`${names[1]}: Your locker code is your birthday.`, `${names[1]}: Which locker do you mean?`]
  await turn({ userMessage: `@${names[1]} what was my locker code?` }, never)
  assert(requestText(writerCalls[0]).includes("anything about this: locker"))
  assert(!requestText(writerCalls[0]).includes('PERSIMMON'))
  assert.deepEqual(storedEvents().at(-1)!.data.lines!.map(line => line.text), ['Which locker do you mean?'])
  // Every attempt guesses: the last one stands rather than failing the player's turn.
  modelReplies = [`${names[1]}: The locker is on the left.`, `${names[1]}: The locker is by the door.`, `${names[1]}: The locker is behind the bins.`, `${names[1]}: The locker opens with a key.`]
  await turn({ userMessage: `@${names[1]} where is my locker then?` }, never)
  assert.equal(storedEvents().at(-1)!.data.lines!.length, 1)
  // An adult prompt stays as it was: it only sees what the scene needs.
  auditEnv.NSFW_SAME_TURN_ROUTER = 'on'; put(rows('users')[0], 'preferences.nsfw_enabled', true); judgeVerdict = true; routerSexual = true
  writerCalls = []; modelReplies = [`${names[1]}: Adult answer here.`]
  await turn({ directWith: ids[1], userMessage: 'Do you want my orchard fantasy?' }, never)
  assert.equal(writerCalls[0].model, 'fake-adult')
  assert(!requestText(writerCalls[0]).includes('anything about this'))
  auditEnv.NSFW_SAME_TURN_ROUTER = 'off'; routerSexual = false
})
await check('toggle off keeps adult turns out of writer history, group context and summaries', async () => {
  await start(); auditEnv.NSFW_SAME_TURN_ROUTER = 'on'; put(rows('users')[0], 'preferences.nsfw_enabled', true); judgeVerdict = true; routerSexual = true
  modelReplies = [`${names[1]}: Private adult marker.`]
  await turn({ directWith: ids[1], userMessage: 'I want you privately.' }, never)
  const privateAdult = storedEvents().at(-1)!
  assert.equal(privateAdult.type, 'intimate')
  modelReplies = [`${names[1]}: Group adult marker.`]
  await turn({ userMessage: `@${names[1]} I want you here.` }, never)
  assert.equal(storedEvents().at(-1)!.type, 'intimate')
  await Promise.all(backgroundWork.splice(0))
  auditEnv.NSFW_SAME_TURN_ROUTER = 'off'; routerSexual = false
  // A thread with no scene of its own: the normal writer, with the group block.
  const plainReplies = ['Plain reply about the kettle.', 'Plain note on the bins.', 'Plain word on the rent.', 'Plain thought on dinner.']
  const plainTurn = async (thread: string) => {
    writerCalls = []; modelReplies = [`${names[ids.indexOf(thread)]}: ${plainReplies.shift()}`]
    await turn({ directWith: thread, userMessage: 'Good evening.' }, never)
    assert.equal(writerCalls.length, 1); assert.notEqual(writerCalls[0].model, 'fake-adult')
    return requestText(writerCalls[0])
  }
  assert((await plainTurn(ids[0])).includes('Group adult marker.'), 'the group block is shown with the toggle on')
  // Push the scene out of the thread's recent turns so a summary may cover it.
  rows('sceneSummaries').push({ _id: new ObjectId(), instance_id: new ObjectId(instanceId), private_to: ids[1], status: 'active', summary_text: 'Adult summary marker.',
    event_range: { start_sequence: privateAdult.sequence, end_sequence: privateAdult.sequence } })
  const last = storedEvents().at(-1)!.sequence
  for (let index = 1; index <= 30; index++) rows('events').push({ ...privateAdult, _id: new ObjectId(), sequence: last + index, type: 'narration',
    data: { ...privateAdult.data, player_input: `Filler ${index}.`, ai_response: '', lines: [] } })
  const on = await plainTurn(ids[1])
  assert(on.includes('Adult summary marker.'), 'the summary is shown with the toggle on')
  put(rows('users')[0], 'preferences.nsfw_enabled', false)
  const off = await plainTurn(ids[1])
  assert(!off.includes('Adult summary marker.')); assert(!off.includes('Group adult marker.'))
  // Bring one adult turn back into the thread's recent window.
  rows('events').push({ ...privateAdult, _id: new ObjectId(), sequence: storedEvents().at(-1)!.sequence + 1 })
  const window = await plainTurn(ids[1])
  assert(!window.includes('Private adult marker.')); assert(!window.includes('I want you privately.'))
  put(rows('users')[0], 'preferences.nsfw_enabled', true)
  writerCalls = []; modelReplies = [`${names[1]}: Carrying on.`]
  await turn({ directWith: ids[1], userMessage: 'Good evening again.' }, never)
  assert(requestText(writerCalls[0]).includes('Private adult marker.'), 'the line stays visible with the toggle on')
  const source = { text: 'Adult summary marker.', startSequence: privateAdult.sequence, endSequence: privateAdult.sequence }
  assert.deepEqual(await groupWriterSummaries(new ObjectId(instanceId), [source], ids[1]), ['Adult summary marker.'])
  assert.deepEqual(await groupWriterSummaries(new ObjectId(instanceId), [source], ids[1], false), [])
})
await check('direct adult route reuses consent interest carryover history and tame marking without bystanders', async () => {
  await start(); auditEnv.NSFW_SAME_TURN_ROUTER = 'on'; put(rows('users')[0], 'preferences.nsfw_enabled', true)
  judgeVerdict = false
  modelReplies = [`${names[1]}: First direct adult answer.`]
  await turn({ directWith: ids[1], userMessage: 'Please keep going.' }, never)
  await Promise.all(backgroundWork.splice(0))
  assert.equal(writerCalls.length, 1); assert.equal(writerCalls[0].model, 'fake-adult')
  assert.equal(storedEvents().at(-1)!.data.tame, true)
  assert.equal(storedEvents().at(-1)!.data.dm_with, ids[1])
  writerCalls = []; judgeVerdict = true
  modelReplies = [`${names[1]}: Another direct adult answer.`]
  await turn({ directWith: ids[1], userMessage: 'Still here.' }, never)
  auditEnv.NSFW_SAME_TURN_ROUTER = 'off'; writerCalls = []
  modelReplies = [`${names[1]}: Carrying on privately.`]
  await turn({ directWith: ids[1], userMessage: 'Keep going.' }, never)
  assert.equal(writerCalls.length, 1); assert.equal(writerCalls[0].model, 'fake-adult')
  assert(!requestText(writerCalls[0]).includes('First direct adult answer.'))
  // An adult event in a different thread cannot supply momentum or tame history.
  writerCalls = []; modelReplies = [`${names[0]}: Ordinary other conversation.`]
  await turn({ directWith: ids[0], userMessage: 'Good morning.' }, never)
  assert.equal(writerCalls[0].model, 'fake-safe')
  assert(!requestText(writerCalls[0]).includes('Carrying on privately.'))
  // Fresh toggle off overrides sexual intent, and retains one addressed speaker.
  put(rows('users')[0], 'preferences.nsfw_enabled', false); writerCalls = []; auditEnv.NSFW_SAME_TURN_ROUTER = 'on'
  modelReplies = [`${names[1]}: A safe direct answer.`]
  await turn({ directWith: ids[1], userMessage: 'Please keep going.' }, never)
  assert.equal(writerCalls.length, 1); assert.equal(writerCalls[0].model, 'fake-safe')
  assert(!requestText(writerCalls[0]).includes('How ' + names[1] + ' is about flirting'))
  put(rows('users')[0], 'preferences.nsfw_enabled', true)
  ;((rows('worldInstances')[0].seed_cast_snapshot as Row[])[1].group as Row).start_bond = 'enemy'
  writerCalls = []; modelReplies = [`${names[1]}: My own way to turn that down.`]
  await turn({ directWith: ids[1], userMessage: 'Please keep going.' }, never)
  assert.equal(writerCalls.length, 1); assert.equal(writerCalls[0].model, 'fake-adult')
  assert(requestText(writerCalls[0]).includes('A flat no is rare'))
  assert(!requestText(writerCalls[0]).includes('First direct adult answer.'))
})
await check('direct real load socket and chronicle reads filter thread events totals cursors and private load memories', async () => {
  await start()
  const { memoryService } = await import('../src/services/memory.service')
  for (const [thread, text] of [[ids[0], 'Secret alpha.'], [undefined, 'Shared text.'], [ids[1], 'Secret beta.'], [ids[0], 'Second alpha.']] as const) {
    modelReplies = [`${names[thread === ids[1] ? 1 : 0]}: ${text}`]
    await turn({ directWith: thread, userMessage: text }, never)
  }
  rows('memories').push({ _id: new ObjectId(), instance_id: new ObjectId(instanceId), text: 'Private load memory.', is_archived: false, private_to: ids[0] })
  for (const [thread, sequences] of [[undefined, [1, 3]], [ids[0], [2, 5]], [ids[1], [4]]] as const) {
    const loaded = await generationService.loadInstance(instanceId, playerId, thread)
    assert.deepEqual(loaded.recentEvents.map(event => event.sequence), sequences)
    assert.equal(loaded.eventWindow.total, sequences.length); forbidden(loaded)
    assert.equal(loaded.memories.length, thread === ids[0] ? 1 : 0)
    const sent: Row[] = []
    await playWsService.handleMessage(socket(sent), { action: 'load_instance', instance_id: instanceId, direct_with: thread })
    assert.equal(sent[0].type, 'instance_loaded')
    assert.equal(sent[0].directWith, thread)
    assert.deepEqual(((sent[0].data as Row).recentEvents as Row[]).map(event => event.sequence), sequences); forbidden(sent)
    const feed = await memoryService.getEvents(instanceId, playerId, { directWith: thread, limit: 1 })
    assert.equal(feed.total, sequences.length); assert.equal(feed.events[0].sequence, sequences.at(-1)); forbidden(feed)
    const older = await memoryService.getEvents(instanceId, playerId, { directWith: thread, beforeSequence: sequences.at(-1), limit: 1 })
    assert.deepEqual(older.events.map(event => event.sequence), sequences.slice(0, -1))
  }
  for (const invalid of [new ObjectId().toHexString(), 'bad', null]) {
    await assert.rejects(generationService.loadInstance(instanceId, playerId, invalid), /not in this chat/)
    await assert.rejects(memoryService.getEvents(instanceId, playerId, { directWith: invalid }), /not in this chat/)
    const sent: Row[] = []
    await playWsService.handleMessage(socket(sent), { action: 'load_instance', instance_id: instanceId, direct_with: invalid })
    assert.equal(sent[0].type, 'error'); assert.equal(sent[0].message, 'That person is not in this chat.')
  }
})
await check('direct story list preview selects only the group thread while normal worlds retain their preview', async () => {
  await start()
  modelReplies = [`${names[0]}: A group reply for the preview.`]
  await turn({ userMessage: 'A public preview.' }, never)
  modelReplies = [`${names[1]}: Private preview reply.`]
  await turn({ directWith: ids[1], userMessage: 'Private preview input.' }, never)
  const list = await instanceService.listByTemplate(playerId, template._id.toHexString())
  assert.equal(list.stories.length, 1); assert.equal(list.stories[0].preview, 'A public preview.'); forbidden(list)
  delete rows('worldInstances')[0].group_state
  assert.equal((await instanceService.listByTemplate(playerId, template._id.toHexString())).stories[0].preview, 'Private preview input.')
})
await check('direct recap summaries fallback events and open threads stay in the requested conversation', async () => {
  await start()
  const { memoryService } = await import('../src/services/memory.service')
  modelReplies = [`${names[0]}: Shared recap reply.`]; await turn({ userMessage: 'Shared recap input.' }, never)
  modelReplies = [`${names[1]}: Private recap reply.`]; await turn({ directWith: ids[1], userMessage: 'Private recap input.' }, never)
  for (const [thread, sequence, text] of [[undefined, 2, 'Shared recap summary.'], [ids[1], 3, 'Private recap summary.']] as const) {
    const audience = thread ? { private_to: thread } : {}
    rows('sceneSummaries').push({ _id: new ObjectId(), instance_id: new ObjectId(instanceId), ...audience, summary_text: text,
      event_range: { start_sequence: sequence, end_sequence: sequence }, status: 'active' })
    rows('memories').push({ _id: new ObjectId(), instance_id: new ObjectId(instanceId), player_id: new ObjectId(playerId), ...audience,
      text: text + ' Open thread.', unresolved_thread: true, is_archived: false })
  }
  for (const thread of [undefined, ids[1]]) {
    const recap = await memoryService.buildRecap(instanceId, playerId, thread)
    assert.equal(recap.spine, thread ? 'Private recap summary.' : 'Shared recap summary.')
    assert.deepEqual(recap.open_threads.map(row => row.text), [(thread ? 'Private recap summary.' : 'Shared recap summary.') + ' Open thread.'])
    forbidden(recap)
  }
  rows('sceneSummaries').length = 0
  assert.equal((await memoryService.buildRecap(instanceId, playerId)).spine, `${names[0]}: Shared recap reply.`)
  assert.equal((await memoryService.buildRecap(instanceId, playerId, ids[1])).spine, `${names[1]}: Private recap reply.`)
  await assert.rejects(memoryService.buildRecap(instanceId, playerId, new ObjectId().toHexString()), /not in this chat/)
})
await check('direct threads and chronicle HTTP routes enforce auth ownership validated thread and generic payloads', async () => {
  await start()
  modelReplies = [`${names[1]}: Thread last line.`]; await turn({ directWith: ids[1], userMessage: 'Thread first line.' }, never)
  const { instanceRoutes } = await import('../src/routes/instance.routes')
  const { chronicleRoutes } = await import('../src/routes/chronicle.routes')
  const app = new Elysia().onError(({ error, set }) => {
    set.status = 'statusCode' in error ? Number(error.statusCode) : 500
    return { message: error.message }
  }).use(instanceRoutes).use(chronicleRoutes)
  routeUser = { id: playerId, tier: 'creator' }
  const threads = await app.handle(new Request(`http://localhost/instances/${instanceId}/threads`))
  assert.equal(threads.status, 200)
  const body = await threads.json() as Row[]
  assert.equal(body.length, 1); assert.deepEqual(Object.keys(body[0]).sort(), ['lastAt', 'lastLine', 'memberId', 'messageCount'])
  assert.equal(body[0].memberId, ids[1]); assert.equal(body[0].lastLine, 'Thread last line.'); assert.equal(body[0].messageCount, 2)
  assert(!Number.isNaN(Date.parse(String(body[0].lastAt)))); forbidden(body)
  for (const [thread, sequence] of [[undefined, 1], [ids[1], 2]] as const) {
    const response = await app.handle(new Request(`http://localhost/chronicle/events/${instanceId}${thread ? `?direct_with=${thread}` : ''}`))
    assert.equal(response.status, 200)
    const payload = await response.json() as { events: Array<{ sequence: number }> }
    assert.deepEqual(payload.events.map(event => event.sequence), [sequence]); forbidden(payload)
    const recapResponse = await app.handle(new Request(`http://localhost/chronicle/recap/${instanceId}${thread ? `?direct_with=${thread}` : ''}`))
    assert.equal(recapResponse.status, 200)
    const recap = await recapResponse.json() as Row
    assert.equal(recap.spine, thread ? `${names[1]}: Thread last line.` : `${names[0]}: The authored opening.`); forbidden(recap)
  }
  const invalid = await app.handle(new Request(`http://localhost/chronicle/events/${instanceId}?direct_with=${new ObjectId()}`))
  assert.equal(invalid.status, 400)
  routeUser = { id: new ObjectId().toHexString(), tier: 'creator' }
  assert.equal((await app.handle(new Request(`http://localhost/instances/${instanceId}/threads`))).status, 404)
  const other = await app.handle(new Request(`http://localhost/chronicle/events/${instanceId}?direct_with=${ids[1]}`))
  assert.notEqual(other.status, 200)
  routeUser = null
  assert.equal((await app.handle(new Request(`http://localhost/instances/${instanceId}/threads`))).status, 401)
  assert.equal((await app.handle(new Request(`http://localhost/chronicle/events/${instanceId}`))).status, 401)
})
await check('direct one chat lock rejects cross thread turns until the actual processor releases it', async () => {
  await start()
  const reserve = billingService.reserve
  billingService.reserve = async () => ({ reservation_id: 'lock-test', cost: 0, balance: null })
  try {
  const first: Row[] = []
  await playWsService.handleMessage(socket(first), chat('First turn.', ids[0]))
  assert.equal(first[0].type, 'ack'); assert.equal(queued.length, 1)
  for (const thread of [undefined, ids[1]]) {
    const sent: Row[] = []
    await playWsService.handleMessage(socket(sent), chat('Another thread.', thread))
    assert.equal(sent[0].code, 'GENERATION_IN_PROGRESS'); assert.equal(queued.length, 1)
  }
  modelReplies = [`${names[0]}: First turn complete.`]
  await groupTurnProcessor({ id: first[0].jobId, data: queued[0] } as unknown as Job<GroupTurnJob>)
  assert(!locks.has(`lock:gen:${playerId}:${instanceId}`))
  const next: Row[] = []
  await playWsService.handleMessage(socket(next), chat('Next thread.', ids[1]))
  assert.equal(next[0].type, 'ack'); assert.equal(queued.length, 2)
  modelReplies = [`${names[1]}: Next thread complete.`]
  await groupTurnProcessor({ id: next[0].jobId, data: queued[1] } as unknown as Job<GroupTurnJob>)
  assert(!locks.has(`lock:gen:${playerId}:${instanceId}`))
  } finally { billingService.reserve = reserve }
})
await check('direct rewind removes later real turns from every thread and restores all pacing and thread watermarks', async () => {
  await start()
  // Existing rewind collaborators are local no-op projections; the event/state code is real.
  mock.module('../src/services/codex-media-carryover', () => ({ snapshotCodexMedia: async () => ({}), restoreCodexMedia: async () => {} }))
  const { characterCodexService } = await import('../src/services/character-codex.service')
  Object.assign(characterCodexService, { applyManualIdentityRevisions: async () => {} })
  const { entityGraphService } = await import('../src/services/entity-graph.service')
  Object.assign(entityGraphService, { repairAfterRewind: async () => {} })
  const { memoryService } = await import('../src/services/memory.service')
  await turn({}, never)
  put(rows('worldInstances')[0], `group_state.direct_threads.${ids[0]}.curated_through_sequence`, 2)
  modelReplies = [`${names[0]}: Surviving direct turn.`]; await turn({ directWith: ids[0] }, never)
  const keep = clone(storedEvents().at(-1)!.data.group_state_after)
  storedEvents().at(-1)!.time_anchor = { real_time: new Date(), sequence: 3, timeline_id: 'main' }
  for (const thread of [undefined, ids[1], ids[0]]) {
    modelReplies = [`${names[thread === ids[1] ? 1 : 0]}: Later reply ${storedEvents().length}.`]
    await turn({ directWith: thread, userMessage: `@${names[thread === ids[1] ? 1 : 0]} continue.` }, never)
  }
  put(rows('worldInstances')[0], `group_state.direct_threads.${ids[1]}.curated_through_sequence`, 6)
  const lastSeen = get(rows('worldInstances')[0], 'group_state.last_seen_at')
  await memoryService.rewindToSequence(instanceId, playerId, 4)
  assert.deepEqual(storedEvents().map(event => event.sequence), [1, 2, 3])
  assert.deepEqual(rows('worldInstances')[0].group_state, { ...keep, last_seen_at: lastSeen })
})
await check('rewind floor refuses sequence one on a group save before deleting anything while later turns and normal saves still rewind', async () => {
  // Existing rewind collaborators are local no-op projections; the event/state code is real.
  mock.module('../src/services/codex-media-carryover', () => ({ snapshotCodexMedia: async () => ({}), restoreCodexMedia: async () => {} }))
  const { characterCodexService } = await import('../src/services/character-codex.service')
  Object.assign(characterCodexService, { applyManualIdentityRevisions: async () => {} })
  const { entityGraphService } = await import('../src/services/entity-graph.service')
  Object.assign(entityGraphService, { repairAfterRewind: async () => {} })
  const { memoryService } = await import('../src/services/memory.service')
  const { instanceRoutes } = await import('../src/routes/instance.routes')
  const { chronicleRoutes } = await import('../src/routes/chronicle.routes')
  const app = new Elysia().onError(({ error, set }) => {
    set.status = 'statusCode' in error ? Number(error.statusCode) : 500
    return { message: error.message }
  }).use(instanceRoutes).use(chronicleRoutes)
  const rewind = (sequence: number) => app.handle(new Request(`http://localhost/chronicle/rewind/${instanceId}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sequence }),
  }))
  const sequences = () => storedEvents().map(event => event.sequence)
  routeUser = { id: playerId, tier: 'creator' }

  await start(); addEvents(3)
  storedEvents()[0].time_anchor = { real_time: new Date(), sequence: 1, timeline_id: 'main' }
  const before = clone(storedEvents())
  const refused = await rewind(1)
  assert.equal(refused.status, 400)
  assert.equal((await refused.json() as Row).message, "The start of this chat can't be rewound.")
  assert.deepEqual(storedEvents(), before)
  assert(!locks.has(`lock:gen:${playerId}:${instanceId}`), 'the refused rewind must release the generation lock')
  // A direct caller is stopped at the same place the controller is.
  await assert.rejects(memoryService.rewindToSequence(instanceId, playerId, 1),
    (error: unknown) => (error as { statusCode?: number }).statusCode === 400 && (error as Error).message === "The start of this chat can't be rewound.")
  assert.deepEqual(storedEvents(), before)

  const later = await rewind(2)
  assert.equal(later.status, 200)
  assert.deepEqual(sequences(), [1])

  // An ordinary save has no seeded opening to protect: sequence one rewinds as it always did.
  await start()
  const world = { ...groupTemplate(), _id: new ObjectId(), kind: 'world' as const }
  rows('worldTemplates').push(world as unknown as Row)
  rows('worldInstances')[0].template_id = world._id
  delete rows('worldInstances')[0].group_state
  addEvents(2)
  const normal = await rewind(1)
  assert.equal(normal.status, 200)
  assert.deepEqual(sequences(), [])
})
await check('rewind restores a group save whose template row has no base_stats_template key', async () => {
  // Existing rewind collaborators are local no-op projections; the event/state code is real.
  mock.module('../src/services/codex-media-carryover', () => ({ snapshotCodexMedia: async () => ({}), restoreCodexMedia: async () => {} }))
  const { characterCodexService } = await import('../src/services/character-codex.service')
  Object.assign(characterCodexService, { applyManualIdentityRevisions: async () => {} })
  const { entityGraphService } = await import('../src/services/entity-graph.service')
  Object.assign(entityGraphService, { repairAfterRewind: async () => {} })
  const { instanceRoutes } = await import('../src/routes/instance.routes')
  const { chronicleRoutes } = await import('../src/routes/chronicle.routes')
  const app = new Elysia().onError(({ error, set }) => {
    set.status = 'statusCode' in error ? Number(error.statusCode) : 500
    return { message: error.message }
  }).use(instanceRoutes).use(chronicleRoutes)

  // Group validation forbids stats, and the catalog files carry none, so a
  // seeded row simply has no key at all. Creation must not invent one.
  const noStats = groupTemplate() as Partial<WorldTemplateDoc>
  delete noStats.base_stats_template
  await start(noStats as WorldTemplateDoc)
  assert(!('base_stats_template' in rows('worldTemplates')[0]))
  storedEvents()[0].time_anchor = { real_time: new Date(), sequence: 1, timeline_id: 'main' }
  addEvents(3)
  const keep = clone(storedEvents()[1].data.group_state_after)
  routeUser = { id: playerId, tier: 'creator' }
  const response = await app.handle(new Request(`http://localhost/chronicle/rewind/${instanceId}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sequence: 3 }),
  }))
  assert.equal(response.status, 200)
  assert.deepEqual(storedEvents().map(event => event.sequence), [1, 2])
  assert.deepEqual(rows('worldInstances')[0].group_state, { ...keep as Row, writing_calls: 0 })
  assert.deepEqual(rows('worldInstances')[0].world_state, {})
})

async function bondHttp(method: string, body?: unknown, characterId = ids[0]) {
  const { instanceRoutes } = await import('../src/routes/instance.routes')
  const app = new Elysia().onError(({ error, set }) => {
    set.status = 'statusCode' in error ? Number(error.statusCode) : 500
    return { message: error.message }
  }).use(instanceRoutes)
  return app.handle(new Request(`http://localhost/instances/${instanceId}/bonds${method === 'PUT' ? '/' + characterId : ''}`, {
    method, headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }))
}
function cardMeters(index = 0) { return rows('characters').find(card => String(card._id) === ids[index])!.relationship as Record<string, number> }
async function bondBatch(thread?: string) {
  await start(); addEvents(5)
  if (thread) for (const event of storedEvents().slice(1)) event.data.dm_with = thread
  storedEvents()[1].data.player_input = 'I trust you with my secret.'
  storedEvents()[1].data.lines![0].text = 'I feel closer to you.'
  storedEvents()[2].data.lines = [{ character_id: ids[1], text: 'My own separate words.', shown_at: new Date() }]
  curatorFactory = request => ({ memories: [atom('The player shared a secret.', 'player', numbered(request)[0].number)] })
}
await check('bond batch request evidence attribution caps dedup and retry read stored rows', async () => {
  for (const thread of [undefined, ids[0]]) {
    await bondBatch(thread)
    const make = (patch: Row = {}) => ({ name: names[0], meter: 'trust', delta: 999, evidence: 'trust you', line: 1, ...patch })
    bondReply = { changes: [make(), make({ delta: 5 }),
      make({ name: 'Unknown person', meter: 'fear' }), make({ meter: 'affection', line: 2, evidence: 'trust you' }),
      make({ meter: 'rivalry', line: 4, evidence: 'My own separate words.' }),
      make({ name: names[1], meter: 'affection', line: 4, evidence: 'My own separate words.' }),
      make({ meter: 'fear', delta: -500, evidence: 'feel closer', line: 2 })] }
    const before = clone(cardMeters())
    await memoryProcessor(memoryJob())
    assert.equal(bondRequests.length, 1)
    assert.equal(bondRequests[0].model, 'fixture-curator'); assert.equal(bondRequests[0].purpose, 'group_bonds')
    const text = requestText(bondRequests[0])
    for (const row of [...rows('characters'), ...rows('events'), ...rows('worldInstances')]) assert(!text.includes(String(row._id)))
    assert(!text.includes('The player shared a secret.') && !text.includes('OPEN THREADS') && !text.includes('Remembered group fact.'))
    assert.deepEqual(cardMeters(), { ...before, trust: before.trust + 10, fear: 0 })
    const row = rows('groupBondChanges').find(row => String(row.character_id) === ids[0])!
    assert.deepEqual(row.deltas, { trust: 10, fear: -10 })
    assert.equal(row.reason, 'chat'); assert.equal(row.thread, thread)
    assert.equal(rows('groupBondChanges').length, thread ? 1 : 2)
    const snapshot = clone(rows('groupBondChanges'))
    const path = thread ? `group_state.direct_threads.${thread}.curated_through_sequence` : 'group_state.curated_through_sequence'
    put(rows('worldInstances')[0], path, 1)
    await memoryProcessor(memoryJob())
    assert.deepEqual(rows('groupBondChanges'), snapshot)
    assert.deepEqual(cardMeters(), { ...before, trust: before.trust + 10, fear: 0 })
  }
  // Clamping also holds at both endpoints.
  await bondBatch(); routeUser = { id: playerId, tier: 'creator' }
  assert.equal((await bondHttp('PUT', { trust: 98, fear: 2 })).status, 200)
  bondReply = { changes: [{ name: names[0], meter: 'trust', delta: 10, evidence: 'trust you', line: 1 }, { name: names[0], meter: 'fear', delta: -10, evidence: 'feel closer', line: 2 }] }
  await memoryProcessor(memoryJob()); assert.equal(cardMeters().trust, 100); assert.equal(cardMeters().fear, 0)
})
await check('bond telemetry keeps its own purpose with real background trace storage', async () => {
  const source = await readFile(new URL('./group-memory-trace-audit.ts', import.meta.url), 'utf8')
  const code = source.replaceAll("['memory_curation', 'scene_summary']", "['group_bonds', 'memory_curation', 'scene_summary']")
    .replaceAll('calls.length < 4', 'calls.length < 6').replaceAll('calls.length, 4', 'calls.length, 6').replaceAll('bodies.length, 4', 'bodies.length, 6')
    .replaceAll('0.0004', '3 * 0.0002').replaceAll('), 30)', '), 45)')
  const child = Bun.spawn(['bun', '--no-env-file', '-e', code], { stdout: 'pipe', stderr: 'pipe', cwd: import.meta.dir })
  const [output, errors, status] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  assert.equal(status, 0, output + errors)
})
await check('bond failure preserves curated memories and records empty and failed calls', async () => {
  for (const result of [new Error('Unavailable'), '', 'bad json', { changes: [] }]) {
    await bondBatch(); bondReply = result
    await memoryProcessor(memoryJob())
    assert.equal(rows('memories').length, 1); assert.equal(rows('groupBondChanges').length, 0)
    assert.equal(get(rows('worldInstances')[0], 'group_state.curated_through_sequence'), 6)
    assert(memoryLogs.some(log => log.name === ((result === '' || typeof result === 'object' && !(result instanceof Error)) ? 'group.bond_call_empty' : 'group.bond_call_failed')))
  }
})
await check('bond HTTP ownership validation adult moments and no model calls', async () => {
  await start(); routeUser = { id: playerId, tier: 'creator' }
  for (const body of [{ trust: -1 }, { fear: 101 }, { affection: 1.5 }, { rivalry: '25' }, {}, [], null, { unknown: 3 }]) {
    const response = await bondHttp('PUT', body)
    assert.equal(response.status, 400, JSON.stringify(body)); assert((await response.text()).includes('whole numbers'))
  }
  assert.equal((await bondHttp('PUT', { fear: 10 }, new ObjectId().toHexString())).status, 400)
  routeUser = null; assert.equal((await bondHttp('GET')).status, 401); assert.equal((await bondHttp('PUT', { trust: 50 })).status, 401)
  routeUser = { id: new ObjectId().toHexString(), tier: 'creator' }
  assert.equal((await bondHttp('GET')).status, 404); assert.equal((await bondHttp('PUT', { trust: 50 })).status, 404)
  routeUser = { id: playerId, tier: 'creator' }
  rows('worldTemplates')[0].kind = 'world'
  assert.equal((await bondHttp('GET')).status, 404); assert.equal((await bondHttp('PUT', { trust: 50 })).status, 404)
  rows('worldTemplates')[0].kind = 'group'
  locks.set(`group:projection:bonds:${instanceId}`, 'busy')
  const busy = await bondHttp('PUT', { trust: 80 }); assert.equal(busy.status, 409); assert((await busy.text()).includes('still settling'))
  locks.delete(`group:projection:bonds:${instanceId}`)
  const result = await bondHttp('PUT', { trust: 80 }); assert.equal(result.status, 200); assert.equal((await result.json()).trust, 80)
  assert.equal(rows('groupBondChanges')[0].reason, 'player_set'); assert.equal(writerCalls.length, 0); assert.equal(rows('memories').length, 0)
  for (let n = 0; n < 8; n++) rows('groupBondChanges').push({ _id: new ObjectId(), instance_id: new ObjectId(instanceId), character_id: new ObjectId(ids[0]), reason: 'chat', adult: n % 2 === 0, evidence: `Moment ${n}`, created_at: new Date(Date.now() + n) })
  for (const enabled of [false, true]) {
    put(rows('users')[0], 'preferences.nsfw_enabled', enabled)
    const body = await (await bondHttp('GET')).json() as Row[]
    assert.equal(body.length, 4); assert.deepEqual(Object.keys(body[0]).sort(), ['characterId', 'meters', 'moments', 'name'])
    const moments = body[0].moments as Row[]
    assert.equal(moments.length, enabled ? 5 : 4); assert(moments.every(moment => moment.evidence))
    if (!enabled) for (const n of [0, 2, 4, 6]) assert(!JSON.stringify(moments).includes(`Moment ${n}`))
  }
})
await check('bond fold delta set delta and real rewind keep sets and restore cards', async () => {
  await bondBatch(); routeUser = { id: playerId, tier: 'creator' }
  bondReply = { changes: [{ name: names[0], meter: 'trust', delta: 10, evidence: 'trust you', line: 1 }] }
  await memoryProcessor(memoryJob()); assert.equal(cardMeters().trust, 65)
  assert.equal((await bondHttp('PUT', { trust: 80 })).status, 200)
  addEvents(5)
  storedEvents()[7].data.player_input = 'I trust you again.'
  bondReply = { changes: [{ name: names[0], meter: 'trust', delta: -5, evidence: 'trust you again', line: 3 }] }
  // The two overlap events are omitted from the bond request, so this is new line 3.
  await memoryProcessor(memoryJob()); assert.equal(cardMeters().trust, 75)
  mock.module('../src/services/codex-media-carryover', () => ({ snapshotCodexMedia: async () => ({}), restoreCodexMedia: async () => {} }))
  const { characterCodexService } = await import('../src/services/character-codex.service')
  Object.assign(characterCodexService, { applyManualIdentityRevisions: async () => {} })
  const { entityGraphService } = await import('../src/services/entity-graph.service')
  Object.assign(entityGraphService, { repairAfterRewind: async () => {} })
  const { memoryService } = await import('../src/services/memory.service')
  rows('events')[5].time_anchor = { real_time: new Date(), sequence: 6, timeline_id: 'main' }
  await memoryService.rewindToSequence(instanceId, playerId, 7)
  assert.equal(cardMeters().trust, 80)
  assert.deepEqual(rows('groupBondChanges').map(row => row.reason), ['chat', 'player_set'])
  assert(storedEvents().every(event => event.sequence < 7))
})
await check('bond prompts hold only call speakers meters no evidence and stable static prefixes', async () => {
  await adultStart(); routeUser = { id: playerId, tier: 'creator' }
  const systems = new Map<string, string>()
  for (const trust of [1, 99]) {
    await bondHttp('PUT', { trust })
    rows('groupBondChanges').at(-1)!.evidence = 'Private evidence must never enter a prompt.'
    writerCalls = []; modelReplies = [`${names[0]}: Unique addressed ${trust}.`, `${names[1]}: Unique bystander ${trust}.`]
    put(rows('worldInstances')[0], `group_state.silent_for.${ids[1]}`, 10)
    await turn({ userMessage: `@${names[0]}` }, never)
    for (const call of writerCalls) {
      const system = content(call, 0), dynamic = content(call, 1)
      assert(!system.includes('Bonds toward') && !requestText(call).includes('Private evidence'))
      const bondBlock = dynamic.split('Bonds toward the player (never mention numbers):\n')[1].split('\n\n')[0]
      const selected = (checkLogs.at(-1)!.writing as Row[])[writerCalls.indexOf(call)].writer === 'adult' ? 0 : 1
      assert(bondBlock.includes(names[selected]))
      for (let i = 0; i < names.length; i++) if (i !== selected) assert(!bondBlock.includes(names[i]))
      if (selected === 0) assert(bondBlock.includes(`"trust":${trust}`))
      const prior = systems.get(String(selected)); if (prior) assert.equal(system, prior); else systems.set(String(selected), system)
    }
  }
})
await check('bond fear rereads on every writer attempt and low bonds reach adult with consent', async () => {
  for (const enabled of [true, false]) for (const fear of [69, 70, 100]) {
    await adultStart(); routeUser = { id: playerId, tier: 'creator' }
    put(rows('users')[0], 'preferences.nsfw_enabled', enabled)
    await bondHttp('PUT', { trust: 0, affection: 0, fear })
    modelReplies = [`${names[0]}: Unique fear reply ${fear}.`]
    await turn({ directWith: ids[0], userMessage: 'Keep going.' }, never)
    assert.equal(writerCalls[0].model, enabled && fear === 69 ? 'fake-adult' : 'fake-safe')
    assert.equal(requestText(writerCalls[0]).includes("doesn't want anything sexual"), fear >= 70)
  }
  for (const kind of ['retry', 'transport']) {
    await adultStart(); routeUser = { id: playerId, tier: 'creator' }
    let first = true
    writerHook = async () => { if (first) { first = false; assert.equal((await bondHttp('PUT', { fear: 70 })).status, 200) } }
    modelReplies = [kind === 'retry' ? '' : new Error('429 unavailable'), `${names[0]}: Fresh safe answer.`]
    await turn({ directWith: ids[0], userMessage: 'Keep going.' }, never)
    assert.deepEqual(writerCalls.map(call => call.model), ['fake-adult', 'fake-safe'])
    assert(requestText(writerCalls[1]).includes("doesn't want anything sexual"))
  }
})

await check('bond purge reset save internal template and account deletion remove every row', async () => {
  const failures: string[] = []
  for (const operation of ['reset', 'save', 'internal', 'template', 'account']) {
    await start(); routeUser = { id: playerId, tier: 'creator' }
    assert.equal((await bondHttp('PUT', { trust: 98 })).status, 200)
    assert.equal(rows('groupBondChanges').length, 1)
    if (operation === 'reset') await deletionService.resetInstance(instanceId, playerId)
    if (operation === 'save') await deletionService.deleteInstance(instanceId, playerId)
    if (operation === 'internal') await deletionService.deleteInstanceById(instanceId)
    if (operation === 'template') await deletionService.deleteTemplateById(template._id)
    if (operation === 'account') await deletionService.deleteAccount(playerId)
    if (rows('groupBondChanges').length) failures.push(`${operation}: ${rows('groupBondChanges').length} bond rows remain`)
    if (operation === 'reset' && cardMeters().trust !== 55) failures.push('reset did not restore the starting bond')
  }
  assert.deepEqual(failures, [])
})


// Action checks cross the actual socket, processor, read routes and background writers.
const { GROUP_ACTION_RULE } = await import('../src/services/group-chat/actions')
const { ordinaryActions } = await import('./group-chat-fixtures')
async function actionHttp(query = '') {
  const { instanceRoutes } = await import('../src/routes/instance.routes')
  const app = new Elysia().onError(({ error, set }) => {
    set.status = 'statusCode' in error ? Number(error.statusCode) : 500
    return { message: error.message }
  }).use(instanceRoutes)
  return app.handle(new Request(`http://localhost/instances/${instanceId}/actions${query}`))
}
await check('actions socket refusals leave no reservation lock or job; accepted kind survives to storage', async () => {
  const reserve = billingService.reserve, release = billingService.release
  const pending = new Set<string>()
  billingService.reserve = async () => { const id = crypto.randomUUID(); pending.add(id); return { reservation_id: id, cost: 0, balance: null } }
  billingService.release = async (_player, id) => { if (id) pending.delete(id) }
  try {
    for (const scenario of ['chat world', 'direct', 'empty', 'whitespace', 'too long', 'unknown kind']) {
      await start()
      if (scenario === 'chat world') delete rows('worldInstances')[0].group_state
      const sent: Row[] = []
      await playWsService.handleMessage(socket(sent), { ...chat(scenario === 'empty' ? '' : scenario === 'whitespace' ? '   ' : scenario === 'too long' ? 'x'.repeat(4001) : ordinaryActions[0], scenario === 'direct' ? ids[0] : undefined), kind: scenario === 'unknown kind' ? 'other' : 'action' })
      assert.equal(sent[0].type, 'error', scenario); assert.equal(typeof sent[0].message, 'string', scenario)
      assert.equal(pending.size, 0, scenario); assert.equal(queued.length, 0, scenario)
      assert(!locks.has(`lock:gen:${playerId}:${instanceId}`), scenario)
    }
    await start(); const sent: Row[] = []
    await playWsService.handleMessage(socket(sent), { ...chat(`@${names[1]} ${ordinaryActions[0]}`), kind: 'action' })
    assert.equal(sent[0].type, 'ack'); assert.equal(queued[0].kind, 'action')
    modelReplies = [`${names[1]}: I see what you left.`]
    await groupTurnProcessor({ id: sent[0].jobId, data: queued[0] } as unknown as Job<GroupTurnJob>, { rng: never })
    assert.equal(lastData().player_action, true); assert.equal(lastData().player_input, `@${names[1]} ${ordinaryActions[0]}`)
    assert(storedEvents().at(-1)!.data.lines!.some(line => line.character_id === ids[1]))
    const complete = frames.find(frame => frame.type === 'generation_complete')!
    assert.equal((complete.event as Row).player_action, true)
    assert.equal(storedEvents().at(-1)!.data.group_state_after!.unprompted_since_player, 0)
    for (const payload of [await generationService.loadInstance(instanceId, playerId), await (await import('../src/services/memory.service')).memoryService.getEvents(instanceId, playerId, {})]) {
      assert(JSON.stringify(payload).includes('"player_action":true')); forbidden(payload)
    }
  } finally { billingService.reserve = reserve; billingService.release = release }
})
await check('actions legacy message has no marker or claim rule and keeps exact prompt bytes', async () => {
  await start()
  const now = new Date('2026-11-03T18:00Z')
  const { groupPlayerLine } = await import('../src/services/group-chat/actions')
  const base = { memories: [], summaries: [], now, speakers: [names[0]], situation: `${playerName}: ${ordinaryActions[0]}` }
  assert.deepEqual(groupPlayerLine(playerName, ordinaryActions[0]), { name: playerName, text: ordinaryActions[0] })
  assert.equal(buildGroupDynamic({ ...base, history: [groupPlayerLine(playerName, ordinaryActions[0])] }), buildGroupDynamic({ ...base, history: [{ name: playerName, text: ordinaryActions[0] }] }))
  await generationService.dispatch({ instanceId, playerId, userMessage: ordinaryActions[0] })
  assert(!Object.hasOwn(queued[0], 'kind'))
  await turn({ userMessage: ordinaryActions[0] }, never)
  assert(!Object.hasOwn(lastData(), 'player_action'))
  assert(writerCalls.every(call => !requestText(call).includes(GROUP_ACTION_RULE)))
  assert(content(writerCalls[0], 1).endsWith(`${playerName}: ${ordinaryActions[0]}`))
  await start(); addEvents(5); curatorReply = { memories: [atom('A remembered ordinary fact.', 'player', 1)] }; await memoryProcessor(memoryJob())
  assert(curatorRequests.every(call => !requestText(call).includes(GROUP_ACTION_RULE)))
  assert(bondRequests.every(call => !requestText(call).includes(GROUP_ACTION_RULE)))
})
await check('actions transcript form reaches current history direct block curator bonds and summary', async () => {
  await start()
  for (const text of ordinaryActions) {
    const from = writerCalls.length
    await turn({ kind: 'action', userMessage: text }, () => 0)
    assert(lastData().player_action); assert(storedEvents().at(-1)!.data.lines!.length)
    for (const call of writerCalls.slice(from)) { assert(requestText(call).includes(`${playerName} did this: ${text}`)); assert(requestText(call).includes(GROUP_ACTION_RULE)); assert(!requestText(call).includes(`${playerName}: ${text}`)) }
  }
  const before = writerCalls.length
  modelReplies = [`${names[2]}: I saw the parcel.`]
  await turn({ userMessage: `@${names[2]} what did I leave?` }, never)
  for (const call of writerCalls.slice(before)) { assert(requestText(call).includes(`${playerName} did this: ${ordinaryActions[0]}`)); assert(requestText(call).includes(GROUP_ACTION_RULE)) }
  modelReplies = [`${names[1]}: I saw the lamp too.`]
  await turn({ directWith: ids[1], userMessage: 'Did you see what I did?' }, never)
  const block = requestText(writerCalls.at(-1)!).split('Group chat (read-only; everyone saw these messages):\n')[1].split('\n\n')[0]
  assert(block.includes(`${playerName} did this: ${ordinaryActions[4]}`)); assert(requestText(writerCalls.at(-1)!).includes(GROUP_ACTION_RULE))
  const actions = storedEvents().filter(event => event.data.player_action)
  curatorFactory = request => ({ memories: [atom(`${playerName} left a green parcel labelled PARCEL71 on the table.`, 'player', numbered(request).find(line => line.text.includes('PARCEL71'))!.number)] })
  await memoryProcessor(memoryJob(actions.at(-1)))
  for (const call of [...curatorRequests, ...bondRequests]) {
    assert(requestText(call).includes(GROUP_ACTION_RULE))
    for (const action of actions) assert(requestText(call).includes(`${playerName} did this: ${action.data.player_input}`))
  }
  assert(numbered().some(line => line.speaker === playerName && line.text === `${playerName} did this: ${ordinaryActions[0]}`))
  assert(rows('memories').length); assert(rows('memories').every(row => !Object.hasOwn(row, 'private_to')))
  assert(rows('memories').every(row => (row.subjects as string[]).includes('player')))
  addEvents(7)
  await summaryProcessor({ data: { instanceId, playerId, eventId: String(storedEvents().at(-1)!._id), groupSummary: true, sceneTag: 'dialogue' } } as Job)
  assert(summaryRequests.length)
  assert(requestText(summaryRequests[0]).includes(`${playerName} did this: ${ordinaryActions[0]}`))
  assert(!requestText(summaryRequests[0]).includes(`${playerName}: ${ordinaryActions[0]}`))
  assert(rows('sceneSummaries').every(row => !Object.hasOwn(row, 'private_to')))
  const claim = `@${names[1]} I put down my bag and ${names[1]} promises to carry it.`
  modelReplies = [`${names[1]}: I'll decide whether I carry it.`]
  await turn({ kind: 'action', userMessage: claim }, never)
  assert(requestText(writerCalls.at(-1)!).includes(GROUP_ACTION_RULE))
})
await check('actions adult routing consent fear and hidden adult history memories and direct block', async () => {
  for (const scenario of ['on', 'off', 'fear'] as const) {
    await adultStart()
    if (scenario === 'off') put(rows('users')[0], 'preferences.nsfw_enabled', false)
    if (scenario === 'fear') put(rows('characters').find(row => String(row._id) === ids[0])!, 'relationship.fear', 70)
    await turn({ kind: 'action', userMessage: `@${names[0]} I slide my hand over your cock. ACTIONADULT71` }, never)
    const writing = checkLogs.at(-1)!.writing as Row[]
    assert(writing.length)
    assert.equal(writing[0].writer, scenario === 'on' ? 'adult' : 'normal', scenario)
    assert.equal(writerCalls[0].model, scenario === 'on' ? 'fake-adult' : 'fake-safe', scenario)
    assert(writerCalls.every(call => requestText(call).includes(`${playerName} did this:`)))
    assert(writerCalls.every(call => requestText(call).includes(GROUP_ACTION_RULE)))
  }
  await adultStart()
  await turn({ kind: 'action', userMessage: `@${names[0]} I slide my hand over your cock. ACTIONADULT71` }, never)
  const adult = storedEvents().at(-1)!
  assert.equal(adult.type, 'intimate')
  rows('memories').push({ _id: new ObjectId(), instance_id: new ObjectId(instanceId), player_id: new ObjectId(playerId), text: 'Adult action memory ACTIONMEM71',
    subjects: ['player'], objects: [], source_event_ids: [adult._id], is_nsfw: true, is_archived: false, importance: 4, updated_at: new Date() })
  ragMemoryTexts = ['Adult action memory ACTIONMEM71']
  put(rows('users')[0], 'preferences.nsfw_enabled', false)
  for (const directWith of [undefined, ids[1]]) {
    writerCalls = []; modelReplies = [`${names[directWith ? 1 : 0]}: A fresh everyday reply.`]
    await turn({ directWith, userMessage: `@${names[directWith ? 1 : 0]} How is your morning?` }, never)
    for (const call of writerCalls) { assert.equal(call.model, 'fake-safe'); assert(!/ACTIONADULT71|ACTIONMEM71/.test(requestText(call))); assert(!requestText(call).includes(adult.data.player_input)) }
  }
  routeUser = { id: playerId, tier: 'creator' }
  const page = await actionHttp(); assert.equal(page.status, 200); assert.deepEqual((await page.json()).actions, [])
})
await check('actions HTTP auth ownership world cursor projection default and bounded limits', async () => {
  await start(); addEvents(65)
  for (const event of storedEvents().slice(1)) event.data.player_action = true
  routeUser = null; assert.equal((await actionHttp()).status, 401)
  routeUser = { id: new ObjectId().toHexString(), tier: 'creator' }; assert.equal((await actionHttp()).status, 404)
  routeUser = { id: playerId, tier: 'creator' }
  const first = await (await actionHttp()).json()
  assert.equal(first.actions.length, 30); assert.equal(first.actions[0].sequence, 66); assert.equal(first.next, 37)
  const second = await (await actionHttp(`?before=${first.next}&limit=50`)).json()
  assert.equal(second.actions.length, 35); assert.equal(second.actions[0].sequence, 36); assert.equal(second.next, null)
  assert.deepEqual(Object.keys(first.actions[0]).sort(), ['at', 'eventId', 'sequence', 'text'])
  assert.equal(new Set([...first.actions, ...second.actions].map((entry: Row) => entry.eventId)).size, 65)
  for (const limit of [1, 50]) assert.equal((await (await actionHttp(`?limit=${limit}`)).json()).actions.length, limit)
  for (const query of ['?limit=0', '?limit=51', '?limit=-1', '?limit=1.5', '?limit=bad', '?limit=', '?before=0', '?before=-1', '?before=1.5', '?before=bad', '?before=9007199254740992']) assert.equal((await actionHttp(query)).status, 400, query)
  assert.deepEqual((await (await actionHttp('?before=1')).json()).actions, [])
  storedEvents()[1].type = 'intimate'; storedEvents()[2].data.dm_with = ids[0]; delete storedEvents()[3].data.player_action
  const filtered = await (await actionHttp('?before=6')).json()
  assert.deepEqual(filtered.actions.map((entry: Row) => entry.sequence), [5])
  put(rows('users')[0], 'preferences.nsfw_enabled', true)
  assert.deepEqual((await (await actionHttp('?before=6')).json()).actions.map((entry: Row) => entry.sequence), [5, 2])
  delete rows('worldInstances')[0].group_state; assert.equal((await actionHttp()).status, 404)
})
await check('actions memory fallback attributes to player and rewind removes action event memory and actions read', async () => {
  mock.module('../src/services/codex-media-carryover', () => ({ snapshotCodexMedia: async () => ({}), restoreCodexMedia: async () => {} }))
  await start()
  for (const text of ordinaryActions) await turn({ kind: 'action', userMessage: text }, () => 0)
  curatorReply = { memories: [atom('A remembered ordinary fact.', 'player', 3)] }
  await memoryProcessor(memoryJob())
  assert(rows('memories').some(row => String(row.text).includes(`${playerName} did this: ${ordinaryActions[0]}`)))
  assert(rows('memories').every(row => !Object.hasOwn(row, 'private_to') && (row.subjects as string[]).includes('player')))
  const { memoryService } = await import('../src/services/memory.service')
  const { characterCodexService } = await import('../src/services/character-codex.service')
  Object.assign(characterCodexService, { applyManualIdentityRevisions: async () => {} })
  const { entityGraphService } = await import('../src/services/entity-graph.service')
  Object.assign(entityGraphService, { repairAfterRewind: async () => {} })
  storedEvents()[0].time_anchor = { real_time: new Date(), sequence: 1, timeline_id: 'main' }
  await memoryService.rewindToSequence(instanceId, playerId, 2)
  assert(!storedEvents().some(event => event.data.player_action))
  assert.equal(rows('memories').length, 0)
  routeUser = { id: playerId, tier: 'creator' }
  assert.deepEqual((await (await actionHttp()).json()).actions, [])
})

await check('nway selection covers mentions in textual order continuation narrowing and excluded routes', () => {
  const last = { type: 'intimate', data: { scene_members: [ids[2], ids[0]] } }
  const select = (text: string, extra = {}) => pickSceneMembers(members, text, { adult: true, origin: 'player', last, ...extra })
  assert.deepEqual(select(`@${names[3]} ${names[1]} @${names[0]} ${names[3]}`), [ids[3], ids[1], ids[0]])
  assert.deepEqual(select(`${names[2]} @${names[1]}`), [ids[2], ids[1]])
  assert.deepEqual(select(`x@${names[0]} @${names[1]}suffix`), last.data.scene_members)
  assert.deepEqual(select('carry on'), last.data.scene_members)
  assert.deepEqual(select('carry on', { last: { type: 'narration', data: last.data } }), [])
  assert.deepEqual(select('carry on', { last: { type: 'intimate', data: {} } }), [])
  assert.deepEqual(select('carry on', { last: undefined }), [])
  for (const text of [`@${names[0]}`, names[1]]) assert.deepEqual(select(text), [])
  for (const extra of [{ adult: false }, { origin: 'unprompted' }, { origin: 'catchup' }, { direct: ids[0] }]) {
    assert.deepEqual(select(`@${names[0]} @${names[1]}`, extra), [])
  }
})

await check('a question to one character carries their own lines, scene lines last, only with consent and only on the normal writer', async () => {
  const data = async (enabled: boolean, userMessage: string, kind?: string) => {
    await start(); put(rows('users')[0], 'preferences.nsfw_enabled', enabled)
    const push = (type: string, text: string, member = 0) => { addEvent(type, member); put(rows('events').at(-1)!, 'data.lines', [{ character_id: ids[member], text, shown_at: new Date() }]) }
    push('intimate', 'Scene line old.'); push('narration', 'Other member line.', 1); push('intimate', 'Scene line new.'); push('narration', 'Kitchen line new.')
    writerCalls = []; modelReplies = [0, 1, 2, 3, 4, 5].map(round => members.map((member, at) => `${member.name}: Fresh words ${round} item ${at}.`).join('\n'))
    await turn({ userMessage, ...(kind ? { kind: kind as 'action' } : {}) }, () => 0)
    return { text: content(writerCalls[0], 1), model: writerCalls[0].model }
  }
  const ask = `@${names[0]} what did you say earlier?`
  const on = await data(true, ask)
  assert.equal(on.model, 'fake-safe')
  const block = on.text.slice(on.text.indexOf(`${names[0]}'s own earlier messages, oldest first:`))
  assert(on.text.includes(`is asking ${names[0]} directly, so ${names[0]} writes first`))
  assert(block.indexOf('- Kitchen line new.') >= 0 && block.indexOf('- Kitchen line new.') < block.indexOf('- Scene line old.') && block.indexOf('- Scene line old.') < block.indexOf('- Scene line new.'))
  assert(!block.slice(0, block.indexOf(ask)).includes('Other member line.'))
  assert(on.text.indexOf(`is asking ${names[0]} directly`) > on.text.indexOf('Now:'))
  const off = await data(false, ask)
  assert(off.text.includes('- Kitchen line new.')); assert(!off.text.includes('Scene line old.')); assert(!off.text.includes('Scene line new.'))
  for (const line of [`@${names[0]} tell me what you said.`, `@${names[0]} @${names[1]} what did you say?`, 'what did anyone say?']) assert(!(await data(true, line)).text.includes('own earlier messages'))
  assert(!(await data(true, ask, 'action')).text.includes('own earlier messages'))
  await start(); put(rows('users')[0], 'preferences.nsfw_enabled', true)
  writerCalls = []; modelReplies = [`${names[0]}: The answer.`]
  await turn({ userMessage: ask }, () => 0)
  assert(content(writerCalls[0], 1).includes(`${names[0]} hasn't said anything recently.`))
})

await check('nway scene examples are the longest lines, rotate and skip copied ones', () => {
  const voiced = { ...members[0], group: { ...members[0].group, voice: ['no', 'a much longer example line here', 'the longest example line of them all here', 'a long example line'] } }
  const [one, two, three] = [voiced.group.voice[2], voiced.group.voice[1], voiced.group.voice[3]]
  assert.deepEqual(sceneExamples(voiced, 0), [one, two]); assert.deepEqual(sceneExamples(voiced, 1), [two, three]); assert.deepEqual(sceneExamples(voiced, 2), [three, one])
  assert.deepEqual(sceneExamples(voiced, 0, [one]), [two, three])
  assert.deepEqual(sceneExamples({ ...voiced, group: { ...voiced.group, voice: ['only'] } }, 4), ['only'])
  assert.deepEqual(sceneExamples({ ...voiced, group: { ...voiced.group, voice: [] } }, 0), [])
  const listed = { ...voiced, group: { ...voiced.group, voice: ['1. a long numbered example line here', 'plain example that runs long', 'another plain example here'] } }
  assert(sceneExamples(listed, 0).includes(listed.group.voice[0]))
  for (const seen of [0, 1, 2]) assert(!sceneExamples(listed, seen, [], '3. my last reply').includes(listed.group.voice[0]))
  assert(sceneExamples({ ...listed, group: { ...listed.group, voice: ['1. only numbered'] } }, 0, [], '2. last').includes('1. only numbered'))
})

await check('a scene member may send one of their longest example lines whole, once; everything else is still a copy', () => {
  const long = 'the longest example line that this character has', short = 'no way'
  const voiced = { ...members[2], group: { ...members[2].group, voice: [short, long, 'second longest example line here', 'third longest example line'] } }
  const run = (text: string, previous: { name: string; text: string }[] = [], sceneMembers = [voiced.id]) => { const counts = emptyLineCounts(); const kept = filterLines([{ name: voiced.name, text }], { members: [voiced], speakers: [voiced.id], origin: 'player', previous, openings: [], sceneMembers, blocked: () => false }, counts); return [kept[0]?.text, counts.copied_example] }
  assert.deepEqual(run(long), [long, 0])
  assert.deepEqual(run(long.toUpperCase()), [long.toUpperCase(), 0])
  assert.deepEqual(run(long, [{ name: voiced.name, text: long }]), [undefined, 1])
  assert.deepEqual(run(long, [{ name: names[0], text: long }]), [long, 0])
  assert.deepEqual(run(long, [], []), [undefined, 1])
  assert.deepEqual(run(short), [undefined, 1])
  assert.deepEqual(run(`hello. ${long}`), [undefined, 1])
  const twice = emptyLineCounts()
  assert.deepEqual(filterLines([{ name: voiced.name, text: long }, { name: voiced.name, text: long }], { members: [voiced], speakers: [voiced.id], origin: 'player', previous: [], openings: [], sceneMembers: [voiced.id], blocked: () => false }, twice).length, 1)
  assert.deepEqual(sceneVoiceLines(voiced.group.voice), [long, 'second longest example line here', 'third longest example line'])
})

await check('numbered scraps, near copies and a sentence another character said this turn are caught', () => {
  const voiced = { ...members[2], group: { ...members[2].group, voice: ['fine. hands first, then your mouth, then you fuck me properly tonight'] } }
  const filter = (text: string, thisTurn: { name: string; text: string }[] = []) => { const counts = emptyLineCounts(); const kept = filterLines([{ name: voiced.name, text }], { members: [voiced], speakers: [voiced.id], origin: 'player', previous: [], openings: [], thisTurn, blocked: () => false }, counts); return [kept[0]?.text, counts.copied_example, counts.empty, counts.repeated_sentence, counts.duplicate] }
  assert.deepEqual(filter('1. 2. 3.'), [undefined, 0, 1, 0, 0])
  assert.deepEqual(filter('1. 2. Stop now'), ['2. Stop now', 0, 0, 0, 0])
  assert.deepEqual(filter('1. Stop. 2. Go on.'), ['1. Stop. 2. Go on.', 0, 0, 0, 0])
  assert.deepEqual(filter('hands first, then your mouth, then you can fuck us properly'), [undefined, 1, 0, 0, 0])
  assert.deepEqual(filter('your mouth first, then you fuck me'), ['your mouth first, then you fuck me', 0, 0, 0, 0])
  const stock = 'I want you on the bed.'
  const scene = (text: string, last: string, sceneMembers = [voiced.id]) => filterLines([{ name: voiced.name, text }], { members: [voiced], speakers: [voiced.id], origin: 'player', previous: [{ name: voiced.name, text: last }], openings: [], sceneMembers, blocked: () => false }, emptyLineCounts())[0]?.text
  assert.equal(scene('1. Slowly. 2. Then again.', '1. Earlier list.'), 'Slowly. Then again.')
  assert.equal(scene('1. Slowly. 2. Then again.', 'Earlier plain.'), '1. Slowly. 2. Then again.')
  assert.equal(scene('1. Slowly. 2. Then again.', '1. Earlier list.', []), '1. Slowly. 2. Then again.')
  assert.deepEqual(filter(`${stock} Do it slowly and then come back here again.`, [{ name: names[0], text: stock }]), ['Do it slowly and then come back here again.', 0, 0, 1, 0])
  assert.deepEqual(filter(stock, [{ name: names[0], text: stock }]), [undefined, 0, 0, 0, 1])
  assert.deepEqual(filter(`Now. ${stock}`, [{ name: voiced.name, text: stock }]), [`Now. ${stock}`, 0, 0, 0, 0])
})

await check('nway real prompts own static all earlier lines per-member caps ordered partial payloads and stored times', async () => {
  await adultStart()
  const order = [2, 0, 1]
  for (let index = 0; index < 6; index++) {
    addEvent('narration', 0)
    put(rows('events').at(-1)!, 'data.lines', members.map((member, at) => ({ character_id: member.id, text: `Held${at} at ${index}.`, shown_at: new Date() })))
  }
  modelReplies = order.map((member, index) => [0, 1, 2, 3].map(line => `${names[member]}: Fresh${line} item ${index}.`).join('\n'))
  // An outsider is picked, but at most one normal bystander may answer.
  put(rows('worldInstances')[0], `group_state.silent_for.${ids[3]}`, 10)
  modelReplies.push(`${names[3]}: Outside one.\n${names[3]}: Outside two.`)
  writerHook = () => {
    const count = writerCalls.length
    if (count <= 3) assert.equal(frames.filter(frame => frame.type === 'group_lines' && frame.partial).length, count - 1,
      'earlier partial must publish before the next writer starts')
  }
  await turn({ kind: 'action', userMessage: order.map(member => `@${names[member]}`).join(' ') }, never)
  assert.deepEqual(writerCalls.map(call => call.model), ['fake-adult', 'fake-adult', 'fake-adult', 'fake-safe'])
  for (const [index, member] of order.entries()) {
    assert.equal(content(writerCalls[index], 0), buildAddressedStatic({ ...template, members, player: playerName }, members[member]))
    for (const other of members.filter(other => other.id !== ids[member])) {
      assert(!content(writerCalls[index], 0).includes(other.group.intimacy!)); assert(!content(writerCalls[index], 0).includes(other.group.wants))
    }
    assert(content(writerCalls[index], 1).includes(`Held${member} at 4.`))
    assert(content(writerCalls[index], 1).includes(`This is a sex scene between ${playerName}, ${names[member]} and `))
    assert(content(writerCalls[index], 1).includes(`${names[member]} answers ${playerName} and doesn't organise the others or talk about anything else.`))
    // The examples sit next to the turn, not only in the static prompt, and come from this member's own lines.
    assert(content(writerCalls[index], 1).includes('Write one short message.'))
    assert(!content(writerCalls[index], 1).includes(`Held${member} at 3.`))
    assert(content(writerCalls[index], 1).includes(`Held${member} at 5.`))
    const nearTurn = content(writerCalls[index], 1).slice(content(writerCalls[index], 1).indexOf('Now:'))
    assert(nearTurn.includes('says it the way these sound, in new words, about what\'s happening now: "'))
    assert(members[member].group.voice!.some(example => nearTurn.includes(`"${example}"`)))
    for (const other of members.filter(other => other.id !== ids[member])) assert(!other.group.voice!.some(example => nearTurn.includes(`"${example}"`)))
    const playerAction = order.map(member => `@${names[member]}`).join(' ')
    // First writer: the player's line closes the prompt. Later writers: it comes before this turn's replies.
    if (!index) assert(content(writerCalls[index], 1).trim().endsWith(playerAction))
    else assert(content(writerCalls[index], 1).lastIndexOf(playerAction) < content(writerCalls[index], 1).indexOf('Fresh0 item 0.'))
    if (index) assert.equal(content(writerCalls[index], 1).split(playerAction).length, 2)
    for (let prior = 0; prior < index; prior++) for (let line = 0; line < 3; line++) assert(content(writerCalls[index], 1).includes(`Fresh${line} item ${prior}.`))
  }
  assert(!requestText(writerCalls[3]).includes('This is a sex scene between '))
  const stored = lastData().lines as Array<{ character_id: string; text: string; shown_at: Date }>
  assert.deepEqual(lastData().scene_members, order.map(member => ids[member]))
  for (const member of order) assert.equal(stored.filter(line => line.character_id === ids[member]).length, 3)
  assert.equal(stored.filter(line => line.character_id === ids[3]).length, 1)
  const publishes = frames.filter(frame => frame.type === 'group_lines')
  assert.equal(publishes.length, 4)
  const final = publishes.at(-1)!
  assert.equal(final.partial, undefined); assert.equal((final.lines as Row[]).length, 1)
  assert.equal(final.eventId, String(storedEvents().at(-1)!._id))
  assert(publishes.slice(0, -1).every(frame => frame.partial === true && frame.eventId === undefined && frame.turnId === final.turnId))
  const sent = publishes.flatMap(frame => frame.lines as Row[])
  assert.deepEqual(sent.map(line => [line.characterId, line.text, line.shownAt]), stored.map(line => [line.character_id, line.text, line.shown_at.toISOString()]))
  assert(stored.every((line, index) => !index || line.shown_at > stored[index - 1].shown_at))
  assert.deepEqual(get(frames.find(frame => frame.type === 'generation_complete')!, 'event.lines'), JSON.parse(JSON.stringify(publicGroupData({ lines: stored }).lines)))
  forbidden(publicGroupData(lastData()))
})

await check('nway shown lines are saved when every repair fails, and a silent member costs no check', async () => {
  await adultStart()
  judgeCalls = []; backgroundWork = []
  modelReplies = [`${names[0]}: First checked.`, ...Array.from({ length: 12 }, () => '')]
  await turn({ userMessage: `@${names[0]} @${names[1]} hello` }, never)
  assert.deepEqual((lastData().lines as Array<{ text: string }>).map(line => line.text), ['First checked.'])
  assert.deepEqual(lastData().scene_members, [ids[0], ids[1]])
  await Promise.all(backgroundWork)
  assert.deepEqual(judgeCalls, ['First checked.'])
})
await check('nway cap deadline and empty members retain normal tag repair with two later adult transports', async () => {
  assert.equal(GROUP_SCENE_MAX_WRITERS, 3); assert.equal(GROUP_SCENE_DEADLINE_MS, 30000)
  for (const deadline of [false, true]) {
    await adultStart()
    const realNow = Date.now; let elapsed = 0
    Date.now = () => realNow() + elapsed
    try {
      writerHook = () => { if (deadline && writerCalls.length === 1) elapsed = 30000 }
      modelReplies = deadline ? [`${names[0]}: First checked.`, members.slice(1).map(member => `${member.name}: Repair for the rest.`).join('\n')]
        : [`${names[0]}: First checked.`, `${names[1]}: Second checked.`, `${names[2]}: Third checked.`, `${names[3]}: Repair after cap.`]
      await turn({ userMessage: names.map(name => `@${name}`).join(' ') }, never)
      assert.equal(writerCalls.filter(call => call.model === 'fake-adult').length, deadline ? 1 : 3)
      assert.equal(writerCalls.at(-1)!.model, 'fake-safe')
      assert.equal((checkLogs.at(-1)!.writing as Row[]).at(-1)!.purpose, 'tag_repair')
      assert.deepEqual(new Set((lastData().lines as Row[]).map(line => line.character_id)), new Set(ids))
      assert.deepEqual(lastData().scene_members, ids)
    } finally { Date.now = realNow }
  }
  for (const failure of ['empty', 'transport', 'voice'] as const) {
    await adultStart()
    // A scene member may send a long example once, so this one has been sent already.
    if (failure === 'voice') { addEvent('narration', 1); put(rows('events').at(-1)!, 'data.lines', [{ character_id: ids[1], text: members[1].group.voice![0], shown_at: new Date() }]) }
    const rejected = failure === 'transport' ? new Error('provider failed') : failure === 'voice' ? `${names[1]}: ${members[1].group.voice![0]}` : ''
    modelReplies = [`${names[0]}: First kept.`, rejected, rejected, '', `${names[1]}: Normal backup kept.`]
    await turn({ userMessage: `@${names[0]} @${names[1]}` }, never)
    const later = writerCalls.filter(call => content(call, 1).includes(`Only these people write in this reply: ${names[1]}.`))
    assert.equal(later.filter(call => String(call.model).startsWith('fake-adult')).length, 2)
    assert.deepEqual(later.slice(-2).map(call => call.model), ['fake-safe', 'fake-safe-fallback'])
    if (failure === 'voice') assert(!content(later[1], 0).includes(members[1].group.voice![0]))
    assert((lastData().lines as Row[]).some(line => line.character_id === ids[1]))
  }
  await adultStart(); modelReplies = ['', '', '', `${names[0]}: First normal rescue.`, `${names[1]}: Next adult reply.`]
  await turn({ userMessage: `@${names[0]} @${names[1]}` }, never)
  assert.deepEqual(writerCalls.map(call => call.model), ['fake-adult', 'fake-adult', 'fake-adult-fallback', 'fake-safe', 'fake-adult'])
})

await check('nway fear and consent are reread per member with toggle filtering earlier adult lines', async () => {
  for (const scenario of ['fear', 'toggle', 'retry-fear'] as const) {
    await adultStart()
    if (scenario === 'fear') put(rows('characters').find(row => String(row._id) === ids[1])!, 'relationship.fear', 70)
    writerHook = () => {
      if (scenario === 'toggle' && writerCalls.length === 1) put(rows('users')[0], 'preferences.nsfw_enabled', false)
      if (scenario === 'retry-fear' && writerCalls.length === 2) put(rows('characters').find(row => String(row._id) === ids[1])!, 'relationship.fear', 70)
    }
    modelReplies = [`${names[0]}: ADULTSCENELINE.`, ...(scenario === 'retry-fear' ? [''] : []), `${names[1]}: Steady response.`, `${names[2]}: Final response.`]
    await turn({ userMessage: `@${names[0]} @${names[1]} @${names[2]} ADULTCURRENTLINE` }, never)
    assert.deepEqual(writerCalls.map(call => call.model), scenario === 'toggle' ? ['fake-adult', 'fake-safe', 'fake-safe']
      : scenario === 'fear' ? ['fake-adult', 'fake-safe', 'fake-adult'] : ['fake-adult', 'fake-adult', 'fake-safe', 'fake-adult'])
    if (scenario === 'toggle') for (const call of writerCalls.slice(1)) {
      assert(!requestText(call).includes('ADULTSCENELINE')); assert(!requestText(call).includes('ADULTCURRENTLINE'))
      assert(members.every(member => !content(call, 0).includes(member.group.intimacy!)))
    }
  }
})

await check('nway continuation counts involvement narrowing and direct exclude scene and sentence', async () => {
  await adultStart(); modelReplies = [`${names[2]}: Initial first.`, `${names[0]}: Initial second.`]
  await turn({ userMessage: `@${names[2]} @${names[0]}` }, never)
  auditEnv.NSFW_SAME_TURN_ROUTER = 'off'
  rows('worldInstances')[0].mode = 'ardent'
  writerCalls = []; modelReplies = [`${names[2]}: Continuing first.`, `${names[0]}: Continuing second.`]
  await turn({ userMessage: 'Keep going together.' }, never)
  assert.deepEqual(lastData().scene_members, [ids[2], ids[0]])
  assert.deepEqual(writerCalls.slice(0, 2).map(call => call.model), ['fake-adult', 'fake-adult'])
  assert.equal(checkLogs.at(-1)!.adult_downgrade, undefined)
  writerCalls = []; modelReplies = [`${names[0]}: Narrowed answer.`]
  await turn({ userMessage: `@${names[0]} keep going` }, never)
  assert(!Object.hasOwn(lastData(), 'scene_members'))
  assert(writerCalls.every(call => !requestText(call).includes('This is a sex scene between ')))
  writerCalls = []; modelReplies = [`${names[0]}: Private answer.`]
  await turn({ directWith: ids[0], userMessage: `@${names[0]} @${names[2]}` }, never)
  assert.equal(writerCalls.length, 1); assert(!Object.hasOwn(lastData(), 'scene_members'))
  assert(!requestText(writerCalls[0]).includes('This is a sex scene between '))
})

await check('nway tame members judged after completion and removed only from their own writer view', async () => {
  await adultStart(); judgeVerdict = false; judgeCalls = []; backgroundWork = []
  let release!: () => void; judgeGate = new Promise<void>(resolve => { release = resolve })
  modelReplies = [`${names[0]}: Tame amber.`, `${names[1]}: Tame blue.`]
  await turn({ userMessage: `@${names[0]} @${names[1]} first` }, never)
  const event = storedEvents().at(-1)!
  assert.equal(judgeCalls.length, 2); assert(frames.some(frame => frame.type === 'generation_complete'))
  assert(!Object.hasOwn(event.data, 'tame_members')); assert(!Object.hasOwn(event.data, 'tame'))
  release(); await Promise.all(backgroundWork.splice(0)); judgeGate = undefined
  assert.deepEqual(event.data.tame_members, [ids[0], ids[1]])
  // Only one member is tame: the other writer must still see their line.
  event.data.tame_members = [ids[0]]
  judgeVerdict = true; writerCalls = []; modelReplies = [`${names[0]}: New copper.`, `${names[1]}: New silver.`]
  await turn({ userMessage: `@${names[0]} @${names[1]} next` }, never)
  assert(!content(writerCalls[0], 1).includes('Tame amber.'))
  assert(content(writerCalls[1], 1).includes('Tame amber.'))
  assert(content(writerCalls[0], 1).includes('Tame blue.')); assert(content(writerCalls[1], 1).includes('Tame blue.'))
  await Promise.all(backgroundWork.splice(0))
  assert(!Object.hasOwn(lastData(), 'tame_members')); assert(!Object.hasOwn(lastData(), 'tame'))
  assert.equal('tame_members' in publicGroupData(event.data), false)
  judgeVerdict = true
})

await check('nway legacy adult request publish and event retain pre-scene shape and fixed trace', async () => {
  await adultStart(); modelReplies = [`${names[0]}: Legacy single writer reply.`]
  await turn({ userMessage: `@${names[0]} hello` }, never)
  await Promise.all(backgroundWork.splice(0))
  const data = lastData(), shown = frames.filter(frame => frame.type === 'group_lines')
  assert.equal(shown.length, 1)
  assert.deepEqual(Object.keys(shown[0]).sort(), ['eventId', 'instanceId', 'lines', 'type'])
  for (const key of ['scene_members', 'tame_members']) assert(!Object.hasOwn(data, key))
  assert.equal(content(writerCalls[0], 0), buildAddressedStatic({ ...template, members, player: playerName }, members[0]))
  assert(!requestText(writerCalls[0]).includes('This is a sex scene between '))
  const trace = { requests: writerCalls.map(call => ({ ...call, sessionId: 'fixture', messages: (call.messages as Row[]).map(message => ({ ...message, content: String(message.content).replace(/It's [^\n]+\./, "It's CLOCK.") })) })),
    data: { ...data, group_state_after: 'fixture', lines: (data.lines as Row[]).map(({ shown_at: _shown, ...line }) => line) },
    shown: shown.map(frame => ({ ...frame, instanceId: 'fixture', eventId: 'fixture', lines: (frame.lines as Row[]).map(({ shownAt: _shown, line_id: _identity, ...line }) => line) })) }
  const hash = createHash('sha256').update(JSON.stringify(trace)).digest('hex')
  assert.equal(hash, 'cdf58bcda86cd0b01c9d778d9eae69e642fd7c9419f84da3869b3f3254e57223', hash)
})

await check('nway rewind deletion remove scene fields and real group memory never gains private_to', async () => {
  await adultStart()
  for (let index = 0; index < 5; index++) {
    modelReplies = [`${names[0]}: Scene alpha ${index}.`, `${names[1]}: Scene beta ${index}.`]
    await turn({ userMessage: `@${names[0]} @${names[1]} turn ${index}` }, never)
  }
  curatorFactory = request => ({ memories: [atom('The player remembers the scene.', 'player', numbered(request).at(-1)!.number)] })
  await memoryProcessor(memoryJob())
  assert(rows('memories').length); assert(rows('memories').every(row => !Object.hasOwn(row, 'private_to')))
  storedEvents().at(-1)!.data.tame_members = [ids[0]]
  mock.module('../src/services/codex-media-carryover', () => ({ snapshotCodexMedia: async () => ({}), restoreCodexMedia: async () => {} }))
  const { characterCodexService } = await import('../src/services/character-codex.service')
  Object.assign(characterCodexService, { applyManualIdentityRevisions: async () => {} })
  const { entityGraphService } = await import('../src/services/entity-graph.service')
  Object.assign(entityGraphService, { repairAfterRewind: async () => {} })
  const { memoryService } = await import('../src/services/memory.service')
  storedEvents()[0].time_anchor = { real_time: new Date(), sequence: 1, timeline_id: 'main' }
  await memoryService.rewindToSequence(instanceId, playerId, 2)
  assert(!storedEvents().some(event => event.data.scene_members || event.data.tame_members))
  modelReplies = [`${names[0]}: New scene alpha.`, `${names[1]}: New scene beta.`]
  await turn({ userMessage: `@${names[0]} @${names[1]}` }, never)
  assert(lastData().scene_members)
  await deletionService.deleteInstance(instanceId, playerId)
  assert.equal(rows('events').length, 0)
})

await check('nway recall plan has a steady group of three, mixed turns and requested observability without calls', async () => {
  const { nwayTurns } = await import('./group-chat-fixtures')
  const plan = nwayTurns(names)
  assert.equal(plan.length, 6)
  assert.equal(plan.filter(turn => turn.kind === 'action').length, 3)
  assert.equal(new Set(plan.flatMap(turn => turn.speakers)).size, 3)
  assert(plan.every(turn => turn.speakers.length === 3 && turn.speakers.every(name => turn.player.includes(`@${name}`))))
  const outputDir = `${import.meta.dir}/.nway-plan-${process.pid}`
  try {
    const child = Bun.spawn(['bun', '--no-env-file', 'run', 'scripts/group-memory-recall.ts', '--scene=nway', '--plan'], {
      cwd: new URL('..', import.meta.url).pathname, stdout: 'pipe', stderr: 'pipe', stdin: 'ignore',
      env: { ...process.env, OPENROUTER_API_KEY: 'offline-fixture', OPENAI_API_KEY: 'offline-fixture', JWT_SECRET: 'offline-fixture', GROUP_MEMORY_RECALL_OUTPUT_DIR: outputDir },
    })
    const [output, errors, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    assert.equal(code, 0, output + errors)
    for (const expected of ['plan nway: flat-4b cast', 'untagged continuation', 'one tag', 'one question per member', 'toggle-off', 'each writer and model', 'group_lines payload and elapsed milliseconds', 'full system and per-turn prompts', 'no calls made']) assert(output.includes(expected), expected)
    assert.equal((output.match(/  \d: (message|action):/g) || []).length, 6)
  } finally { await rm(outputDir, { recursive: true, force: true }) }
})

const { scheduleDirectNotifications, openPendingDirect, pendingDirectFrom } = await import('../src/services/group-chat/notifications')
const { eligibleDirectNotification, pickDirectSender, DIRECT_PENDING_MS } = await import('../src/services/group-chat/notification-policy')
const { createFcmSender } = await import('../src/services/push/fcm')
const { registerPushDevice, removePushDevice } = await import('../src/services/push/devices')
const { authController } = await import('../src/controllers/auth.controller')
const { authRoutes: pushAuthRoutes } = await import('../src/routes/auth.routes')
const { instanceRoutes: directInstanceRoutes } = await import('../src/routes/instance.routes')
const { instanceController: notifyController } = await import('../src/controllers/instance.controller')
const notifyNow = new Date('2026-11-04T12:00:00Z')
const notifyTime = () => notifyNow
const notifyToken = 'audit-device-only-never-log'
const fakeSender = (send: () => Promise<boolean> = async () => true) => ({ configured: () => true, send })
async function notifyStart() {
  await start()
  auditEnv.GROUP_NOTIFICATIONS_ENABLED = true
  put(rows('worldInstances')[0], 'group_state.last_seen_at', new Date(notifyNow.getTime() - 4 * 3_600_000))
  await registerPushDevice(playerId, { token: notifyToken, platform: 'android', tz_offset_minutes: 0 }, notifyNow)
}
async function notifyPending() {
  await notifyStart()
  await scheduleDirectNotifications({ now: notifyTime, rng: () => 0, sender: fakeSender() })
  assert.equal(get(rows('worldInstances')[0], 'group_state.pending_direct.member_id'), ids[0])
}
const auditState = () => rows('worldInstances')[0].group_state as unknown as import('../src/services/group-chat/types').GroupState

await check('notify mark 1 zero models throughout schedule and send', async () => {
  await notifyStart()
  let sends = 0
  await scheduleDirectNotifications({ now: notifyTime, rng: () => 0, sender: fakeSender(async () => { sends++; return true }) })
  assert.equal(sends, 1)
  assert.equal(writerCalls.length + routerRequests + curatorRequests.length + summaryRequests.length + bondRequests.length, 0)
  assert.equal(queued.length, 0); assert.equal(ragCalls.length, 0)
  assert.equal(storedEvents().length, 1)
  assert.equal(auditState().unprompted_since_player, 1)
  assert.equal(pickDirectSender(members.map(member => ({ ...member, relationship: { trust: 0, affection: 0, fear: 70 } })), () => 0), undefined)
  assert.equal(pickDirectSender(members.map(member => ({ ...member, relationship: { trust: 0, affection: 0, fear: 0 } })), () => 0.999)?.id, ids.at(-1))
  const weighted = members.map((member, i) => ({ ...member, relationship: { trust: i === 1 ? 100 : 0, affection: 0, fear: 0 } }))
  assert.equal(pickDirectSender(weighted, () => 0.5)?.id, ids[1])
})
await check('notify mark 2 every eligibility gate and chance independently', async () => {
  await notifyStart()
  const baseline = { enabled: true, hasDevice: true, optedOut: false, state: { ...clone(auditState()), tz_offset_minutes: 0 }, now: notifyNow, sentToday: 0, spendToday: 0 }
  assert.equal(eligibleDirectNotification(baseline), true)
  const variants = [
    { enabled: false }, { hasDevice: false }, { optedOut: true }, { sentToday: 3 }, { spendToday: 5 }, { spendToday: NaN },
    ...[
      { last_seen_at: undefined }, { last_seen_at: new Date(NaN) },
      { last_seen_at: new Date(notifyNow.getTime() - 3 * 3_600_000 + 1) },
      { last_seen_at: new Date(notifyNow.getTime() - 14 * 86_400_000 - 1) },
      { tz_offset_minutes: undefined }, { tz_offset_minutes: NaN },
      { tz_offset_minutes: -240 }, { tz_offset_minutes: 600 },
      { pending_direct: { member_id: ids[0], scheduled_at: notifyNow, notified_at: notifyNow } },
      { last_direct_notified_at: new Date(notifyNow.getTime() - 12 * 3_600_000 + 1) },
      { unprompted_since_player: 2 },
    ].map(changes => ({ state: { ...baseline.state, ...changes } })),
  ]
  for (const variant of variants) {
    assert.equal(eligibleDirectNotification({ ...baseline, ...variant }), false, JSON.stringify(variant))
    await notifyStart()
    const input = { ...baseline, ...variant }
    auditEnv.GROUP_NOTIFICATIONS_ENABLED = input.enabled
    if (!input.hasDevice) rows('pushDevices').length = 0
    put(rows('users')[0], 'preferences.group_notifications', !input.optedOut)
    put(rows('users')[0], 'group_notification_usage', { day: '2026-11-04', sent: input.sentToday, calls: 0 })
    rows('worldInstances')[0].group_state = clone(input.state) as unknown as Row
    if (rows('pushDevices')[0]) rows('pushDevices')[0].tz_offset_minutes = input.state.tz_offset_minutes
    if (input.spendToday !== 0) rows('llmCalls').push({ group_origin: 'unprompted', created_at: notifyNow, cost_usd: input.spendToday })
    let attempted = 0
    await scheduleDirectNotifications({ now: notifyTime, rng: () => 0, sender: fakeSender(async () => { attempted++; return true }) })
    assert.equal(attempted, 0, JSON.stringify(variant))
  }
  await notifyStart()
  for (const hours of [3, 14 * 24]) assert(eligibleDirectNotification({ ...baseline, state: { ...baseline.state, last_seen_at: new Date(notifyNow.getTime() - hours * 3_600_000) } }))
  let sends = 0
  await scheduleDirectNotifications({ now: notifyTime, rng: () => 0.25, sender: fakeSender(async () => { sends++; return true }) })
  assert.equal(sends, 0)
  // Enforce the same cap across separate saves, with concurrent scheduler runs.
  const original = rows('worldInstances')[0]
  const cards = clone(rows('characters'))
  for (let i = 0; i < 4; i++) {
    const _id = new ObjectId()
    rows('worldInstances').push({ ...clone(original), _id })
    rows('characters').push(...cards.map(card => ({ ...clone(card), instance_id: _id })))
  }
  await Promise.all([1, 2].map(() => scheduleDirectNotifications({ now: notifyTime, rng: () => 0, sender: fakeSender(async () => { sends++; return true }) })))
  assert.equal(sends, 3)
  assert.equal(get(rows('users')[0], 'group_notification_usage.sent'), 3)
})
await check('notify mark 3 real FCM payload and snapshot never contain planted prose', async () => {
  await notifyStart()
  const planted = 'EXPLICIT_PRIVATE_LINE_NOT_FOR_LOCK_SCREEN'
  put(rows('events')[0], 'data.ai_response', planted)
  put(rows('events')[0], 'data.lines', [{ character_id: ids[0], text: planted, shown_at: notifyNow }])
  rows('memories').push({ text: planted })
  const { generateKeyPairSync, verify } = await import('node:crypto')
  const key = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const payloads: Row[] = [], urls: string[] = []
  const sender = createFcmSender({ enabled: () => true, now: notifyTime,
    credentials: () => JSON.stringify({ project_id: 'audit-project', client_email: 'audit@example.invalid', private_key: key.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString() }),
    fetch: Object.assign(async (url: string | URL | Request, init?: RequestInit) => {
      urls.push(String(url))
      if (String(url).includes('oauth2')) {
        const assertion = new URLSearchParams(String(init?.body)).get('assertion')!
        const parts = assertion.split('.')
        assert(verify('RSA-SHA256', Buffer.from(parts.slice(0, 2).join('.')), key.publicKey, Buffer.from(parts[2], 'base64url')))
        const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString())
        assert.equal(claims.scope, 'https://www.googleapis.com/auth/firebase.messaging')
        assert.equal(claims.exp - claims.iat, 3600)
        return Response.json({ access_token: 'audit-bearer', expires_in: 3600 })
      }
      assert.equal((init?.headers as Row).Authorization, 'Bearer audit-bearer')
      payloads.push(JSON.parse(String(init?.body)))
      return Response.json({ name: 'audit-message' })
    }, { preconnect: unavailable }) as typeof fetch,
  })
  await scheduleDirectNotifications({ now: notifyTime, rng: () => 0, sender })
  assert.deepEqual(urls, ['https://oauth2.googleapis.com/token', 'https://fcm.googleapis.com/v1/projects/audit-project/messages:send'])
  assert.deepEqual(payloads, [{ message: { token: notifyToken,
    notification: { title: template.title, body: `${names[0]} sent you a message` },
    data: { type: 'group_direct', instanceId, characterId: ids[0] } } }])
  assert(!JSON.stringify(payloads).includes(planted))
  assert.equal(writerCalls.length + routerRequests + curatorRequests.length + summaryRequests.length, 0)
  const projected = publicGroupData({ instance: rows('worldInstances')[0] }, notifyNow)
  assert.deepEqual(projected.instance.pending_from, [ids[0]])
  assert(!JSON.stringify(projected).includes('scheduled_at')); assert(!JSON.stringify(projected).includes('notified_at'))
  assert.deepEqual(pendingDirectFrom(auditState(), new Date(notifyNow.getTime() + DIRECT_PENDING_MS)), [])
  const future = new Date(notifyNow.getTime() + DIRECT_PENDING_MS)
  assert.deepEqual(await openPendingDirect(instanceId, playerId, ids[0], future), { writing: false })
  assert.equal(auditState().pending_direct, undefined); assert.equal(queued.length, 0)
})
await check('notify mark 4 open is atomic lock preserving owner only and capped', async () => {
  await notifyPending()
  locks.set(`lock:gen:${playerId}:${instanceId}`, JSON.stringify({ owner: 'other', phase: 'tail' }))
  assert.deepEqual(await openPendingDirect(instanceId, playerId, ids[0], notifyNow), { writing: false })
  assert(auditState().pending_direct)
  locks.delete(`lock:gen:${playerId}:${instanceId}`)
  await assert.rejects(openPendingDirect(instanceId, '300000000000000000000002', ids[0], notifyNow), error => (error as { statusCode: number }).statusCode === 404)
  assert.deepEqual(await openPendingDirect(instanceId, playerId, ids[1], notifyNow), { writing: false })
  const results = await Promise.all([1, 2].map(() => openPendingDirect(instanceId, playerId, ids[0], notifyNow)))
  assert.equal(results.filter(result => result.writing).length, 1)
  assert.equal(queued.length, 1); assert.equal(queued[0].origin, 'unprompted'); assert.equal(queued[0].directWith, ids[0])
  assert.equal(auditState().pending_direct, undefined)
  await notifyPending()
  generationAddError = new Error('Queue unavailable')
  await assert.rejects(openPendingDirect(instanceId, playerId, ids[0], notifyNow))
  generationAddError = undefined
  assert(auditState().pending_direct); assert.equal(get(rows('users')[0], 'group_notification_usage.calls'), 0)
  assert(!locks.has(`lock:gen:${playerId}:${instanceId}`))
  for (const cap of ['calls', 'spend', 'reserved']) {
    await notifyPending()
    if (cap === 'calls') for (let i = 0; i < 30; i++) rows('llmCalls').push({ player_id: new ObjectId(playerId), group_origin: 'unprompted', purpose: 'narration', created_at: notifyNow, cost_usd: 0 })
    if (cap === 'spend') rows('llmCalls').push({ group_origin: 'unprompted', created_at: notifyNow, cost_usd: 5 })
    if (cap === 'reserved') put(rows('users')[0], 'group_notification_usage', { day: '2026-11-04', sent: 1, calls: 30 })
    assert.deepEqual(await openPendingDirect(instanceId, playerId, ids[0], notifyNow), { writing: false })
    assert.equal(auditState().pending_direct, undefined); assert.equal(queued.length, 0)
  }
})
await check('notify mark 5 toggle off open uses only the normal direct writer', async () => {
  await notifyPending()
  await turn({ directWith: ids[0], userMessage: 'A private earlier line.' })
  await turn({ directWith: ids[0], userMessage: 'Another private earlier line.' })
  for (const event of rows('events').slice(-2)) { event.type = 'intimate'; put(event, 'data.dm_with', ids[0]) }
  put(rows('worldInstances')[0], 'group_state.pending_direct', { member_id: ids[0], scheduled_at: notifyNow, notified_at: notifyNow })
  writerCalls = []; routerRequests = 0
  assert.deepEqual(await openPendingDirect(instanceId, playerId, ids[0], notifyNow), { writing: true })
  modelReplies = [`${names[0]}: A fresh private greeting.`]
  await turn({ ...queued[0], userMessage: '' } as Partial<GroupTurnJob>, undefined, notifyTime)
  assert(writerCalls.length > 0); assert(writerCalls.every(call => String(call.model).startsWith('fake-safe')))
  assert.equal(routerRequests, 0)
  assert.equal(lastData().dm_with, ids[0]); assert.equal(lastData().player_input, '')
  assert((lastData().lines as Row[]).every(line => line.character_id === ids[0]))
  put(rows('users')[0], 'preferences.nsfw_enabled', true)
  for (const event of rows('events').slice(-3)) event.type = 'intimate'
  writerCalls = []; modelReplies = [`${names[0]}: A fresh answer from the same scene.`]
  await turn({ origin: 'unprompted', directWith: ids[0], userMessage: '' }, undefined, notifyTime)
  assert.equal(writerCalls[0].model, 'fake-adult'); assert.equal(routerRequests, 0)
})
await check('notify mark 6 real reservation and settlement charge zero Ink', async () => {
  await notifyPending(); rows('users')[0].token_balance = 42
  assert.deepEqual(await openPendingDirect(instanceId, playerId, ids[0], notifyNow), { writing: true })
  const reservation = queued[0].billingReservationId as string
  const ledger = rows('inkLedger')
  assert.equal(ledger.length, 1); assert.equal(ledger[0].delta, 0); assert.equal(ledger[0].reference, 'group_turn')
  const { billingService } = await import('../src/services/billing.service')
const { moderationService } = await import('../src/services/moderation.service')
moderationService.discoveryFilter = async () => ({})
  await billingService.settle(playerId, reservation)
  assert.equal(rows('users')[0].token_balance, 42)
  assert(ledger.every(row => Number(row.delta) === 0))
})
await check('notify mark 7 player writing first cancels pending without an autonomous writer', async () => {
  await notifyPending()
  const bondsBefore = clone(rows('characters'))
  modelReplies = [`${names[0]}: I heard you.`]
  await turn({ directWith: ids[0], userMessage: 'I wrote before opening.' })
  assert.equal(auditState().pending_direct, undefined); assert.equal(auditState().unprompted_since_player, 0)
  assert(auditState().last_seen_at)
  const calls = writerCalls.length
  assert.deepEqual(await openPendingDirect(instanceId, playerId, ids[0], notifyNow), { writing: false })
  assert.equal(queued.length, 0); assert.equal(writerCalls.length, calls)
  assert.equal(rows('events').at(-1)!.data && lastData().origin, 'player')
  assert.deepEqual(rows('characters'), bondsBefore)
  await notifyPending()
  await deletionService.resetInstance(instanceId, playerId)
  assert.equal(auditState().pending_direct, undefined)
})
await check('notify rewind withdraws an unread message', async () => {
  mock.module('../src/services/codex-media-carryover', () => ({ snapshotCodexMedia: async () => ({}), restoreCodexMedia: async () => {} }))
  const { characterCodexService } = await import('../src/services/character-codex.service')
  Object.assign(characterCodexService, { applyManualIdentityRevisions: async () => {} })
  const { entityGraphService } = await import('../src/services/entity-graph.service')
  Object.assign(entityGraphService, { repairAfterRewind: async () => {} })
  const { memoryService } = await import('../src/services/memory.service')
  await notifyStart()
  await turn({}, never)
  modelReplies = [`${names[0]}: Surviving reply.`]; await turn({ userMessage: `@${names[0]} carry on.` }, never)
  storedEvents().at(-1)!.time_anchor = { real_time: new Date(), sequence: 3, timeline_id: 'main' }
  modelReplies = [`${names[0]}: Later reply.`]; await turn({ userMessage: `@${names[0]} continue.` }, never)
  put(rows('worldInstances')[0], 'group_state.pending_direct', { member_id: ids[0], scheduled_at: notifyNow, notified_at: notifyNow })
  await memoryService.rewindToSequence(instanceId, playerId, 4)
  assert.equal(auditState().pending_direct, undefined)
})
await check('notify timezone comes from the newest device and reaches the open turn', async () => {
  await notifyStart()
  await registerPushDevice(playerId, { token: 'second-device', platform: 'android', tz_offset_minutes: 600 }, new Date(notifyNow.getTime() - 3_600_000))
  rows('pushDevices')[0].tz_offset_minutes = 0
  await scheduleDirectNotifications({ now: notifyTime, rng: () => 0, sender: fakeSender() })
  assert(auditState().pending_direct); assert.equal(auditState().tz_offset_minutes, 0)
  await notifyStart()
  await registerPushDevice(playerId, { token: 'second-device', platform: 'android', tz_offset_minutes: 600 }, new Date(notifyNow.getTime() + 3_600_000))
  await scheduleDirectNotifications({ now: notifyTime, rng: () => 0, sender: fakeSender() })
  assert.equal(auditState().pending_direct, undefined)
  await notifyStart()
  await registerPushDevice(playerId, { token: notifyToken, platform: 'android' }, notifyNow)
  assert.equal(rows('pushDevices')[0].tz_offset_minutes, 0)
})
await check('notify mark 8 bad tokens failures disabled switch and missing credentials', async () => {
  await notifyStart()
  let hits = 0
  const missing = createFcmSender({ credentials: () => '', enabled: () => true, fetch: Object.assign(async () => { hits++; throw new Error('must not fetch') }, { preconnect: unavailable }) as typeof fetch })
  const beforeMissing = JSON.stringify(rows('worldInstances'))
  await scheduleDirectNotifications({ now: notifyTime, rng: () => 0, sender: missing })
  await scheduleDirectNotifications({ now: notifyTime, rng: () => 0, sender: missing })
  assert.equal(hits, 0); assert.equal(memoryLogs.filter(log => log.name === 'push.credentials_missing').length, 1)
  assert.equal(JSON.stringify(rows('worldInstances')), beforeMissing)
  await scheduleDirectNotifications({ now: notifyTime, rng: () => 0, sender: fakeSender(async () => false) })
  assert.equal(auditState().pending_direct, undefined); assert.equal(get(rows('users')[0], 'group_notification_usage.sent'), 0)
  assert.equal(auditState().unprompted_since_player, 0); assert.equal(auditState().last_direct_notified_at, undefined)
  auditEnv.GROUP_NOTIFICATIONS_ENABLED = false
  const off = JSON.stringify([...tables])
  await scheduleDirectNotifications({ now: notifyTime, rng: () => 0, sender: fakeSender(async () => { hits++; return true }) })
  assert.equal(JSON.stringify([...tables]), off); assert.equal(hits, 0)
  assert.equal((publicGroupData(rows('worldInstances')[0]) as Row).pending_from, undefined)
  const { generateKeyPairSync } = await import('node:crypto')
  const key = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ format: 'pem', type: 'pkcs8' }).toString()
  await notifyStart()
  let movedRequests = 0
  const moved = createFcmSender({ enabled: () => true, now: notifyTime,
    credentials: () => JSON.stringify({ project_id: 'audit-project', client_email: 'audit@example.invalid', private_key: key }),
    fetch: Object.assign(async () => {
      movedRequests++
      rows('pushDevices')[0].player_id = new ObjectId('300000000000000000000002')
      return Response.json({ access_token: 'audit', expires_in: 3600 })
    }, { preconnect: unavailable }) as typeof fetch,
  })
  await scheduleDirectNotifications({ now: notifyTime, rng: () => 0, sender: moved })
  assert.equal(movedRequests, 1); assert.equal(auditState().pending_direct, undefined)
  for (const errorCode of ['UNREGISTERED', 'INVALID_ARGUMENT', 'UNAVAILABLE']) {
    await notifyStart()
    let requests = 0
    const bad = createFcmSender({ enabled: () => true, now: notifyTime,
      credentials: () => JSON.stringify({ project_id: 'audit-project', client_email: 'audit@example.invalid', private_key: key }),
      fetch: Object.assign(async (url: string | URL | Request) => { requests++; return String(url).includes('oauth2') ? Response.json({ access_token: 'audit', expires_in: 3600 }) : Response.json({ error: { details: [{ '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError', errorCode }] } }, { status: 400 }) }, { preconnect: unavailable }) as typeof fetch,
    })
    await scheduleDirectNotifications({ now: notifyTime, rng: () => 0, sender: bad })
    assert.equal(requests, 2); assert.equal(rows('pushDevices').length, errorCode === 'UNAVAILABLE' ? 1 : 0)
    assert.equal(auditState().pending_direct, undefined); assert.equal(get(rows('users')[0], 'group_notification_usage.sent'), 0)
    assert(!JSON.stringify(memoryLogs).includes(notifyToken))
  }
})
await check('notify mark 9 handler auth validation token ownership and no log leaks', async () => {
  await notifyStart()
  const app = new Elysia().onError(({ error, set }) => {
    set.status = (error as { statusCode?: number }).statusCode ?? 500
    return { message: 'Please try again.' }
  }).use(pushAuthRoutes).use(directInstanceRoutes)
  routeUser = null
  for (const [method, path] of [['POST', '/auth/push-token'], ['DELETE', '/auth/push-token'], ['POST', `/instances/${instanceId}/group/threads/${ids[0]}/open`]]) {
    const response = await app.handle(new Request(`http://localhost${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: notifyToken, platform: 'android' }) }))
    assert.equal(response.status, 401, `${method} ${path}`)
    assert(!await response.text().then(text => text.includes(notifyToken)))
  }
  for (const handler of [authController.registerPushToken, authController.deletePushToken]) await assert.rejects(handler({ user: null, body: { token: notifyToken, platform: 'android' } }), error => (error as { statusCode: number }).statusCode === 401)
  await assert.rejects(notifyController.openDirect({ user: null, params: { id: instanceId, characterId: ids[0] } }), error => (error as { statusCode: number }).statusCode === 401)
  for (const body of [{ token: '', platform: 'android' }, { token: 'x'.repeat(4097), platform: 'android' }, { token: 'two words', platform: 'android' }, { token: notifyToken, platform: 'ios' }, { token: notifyToken, platform: 'android', extra: 1 }, ...['0', 1.5, 841, -841].map(tz_offset_minutes => ({ token: notifyToken, platform: 'android', tz_offset_minutes }))]) await assert.rejects(registerPushDevice(playerId, body))
  rows('users').push({ _id: new ObjectId('300000000000000000000002'), preferences: {} })
  await removePushDevice('300000000000000000000002', { token: notifyToken }); assert.equal(rows('pushDevices').length, 1)
  const response = await authController.registerPushToken({ user: { id: '300000000000000000000002', tier: 'free' }, body: { token: notifyToken, platform: 'android' } })
  assert.equal(rows('pushDevices').length, 1); assert.equal(String(rows('pushDevices')[0].player_id), '300000000000000000000002')
  assert(!JSON.stringify(response).includes(notifyToken))
  await removePushDevice(playerId, { token: notifyToken }); assert.equal(rows('pushDevices').length, 1)
  await authController.deletePushToken({ user: { id: '300000000000000000000002', tier: 'free' }, body: { token: notifyToken } })
  assert.equal(rows('pushDevices').length, 0)
  routeUser = { id: playerId, tier: 'creator' }
  for (const method of ['POST', 'DELETE']) {
    const response = await app.handle(new Request('http://localhost/auth/push-token', { method,
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: notifyToken, ...(method === 'POST' ? { platform: 'android' } : {}) }),
    }))
    assert.equal(response.status, 200); assert.deepEqual(await response.json(), { success: true })
  }
  routeUser = null
  pushWriteFailure = new Error(`Database duplicate key ${notifyToken}`)
  for (const handler of [authController.registerPushToken, authController.deletePushToken]) {
    await assert.rejects(handler({ user: { id: playerId, tier: 'creator' }, body: { token: notifyToken, ...(handler === authController.registerPushToken ? { platform: 'android' } : {}) } }), error => {
      const failure = error as { statusCode?: number; message: string }
      return failure.statusCode === 503 && !failure.message.includes(notifyToken)
    })
  }
  pushWriteFailure = undefined
  rows('users')[0].guest = true
  await assert.rejects(registerPushDevice(playerId, { token: notifyToken, platform: 'android' }))
  assert(!JSON.stringify(memoryLogs).includes(notifyToken))
  const source = await readFile(new URL('../src/services/push/fcm.ts', import.meta.url), 'utf8')
  assert(!/log\.(?:info|warn|error)\([^\n]*device\.token/.test(source))
})

/** A cast the artist has already painted: the first face has its small variant,
 *  the second does not, and the third has no art at all. */
function facedTemplate() {
  const source = groupTemplate()
  source.seed_cast = source.seed_cast!.map((member, index) => index < 2 ? { ...member,
    portrait: {
      asset_key: `castface_${index}.png`, source: 'authored' as const, appearance_version: 1, painted_at: new Date('2026-01-01Z'),
      ...(index === 0 ? { thumb_key: 'castface_0.w320.webp' } : {}),
    },
  } : member)
  return source
}
/** The same cast, with a published cover and its small variant. */
function coveredTemplate() {
  return { ...facedTemplate(), image_url: 'https://fixture.invalid/cover.webp', image_thumb_url: 'https://fixture.invalid/cover.w540.webp' }
}
const faces = ['https://fixture.invalid/castface_0.png', 'https://fixture.invalid/castface_1.png']
const faceThumbs = ['https://fixture.invalid/castface_0.w320.webp']
const coverThumb = 'https://fixture.invalid/cover.w540.webp'
const noAssetKey = (value: unknown) => assert(!/"asset_key"\s*:/.test(JSON.stringify(value)), 'asset key reached the player')
const noNullThumb = (value: unknown) => assert(!/"\w*thumb\w*"\s*:\s*null/.test(JSON.stringify(value)), 'a thumb field was written null')

await check('art room cards carry authored faces and never a stored portrait', async () => {
  await start(facedTemplate())
  rows('characters')[0].portrait = { asset_key: 'save_face.png', source: 'generated', appearance_version: 1, painted_at: new Date() }
  const sent: Row[] = []
  await playWsService.handleMessage(socket(sent), { action: 'load_instance', instance_id: instanceId })
  assert.equal(sent[0].type, 'instance_loaded')
  const cast = (sent[0].data as Row).characters as Row[]
  const card = (name: string) => cast.find(entry => entry.canonical_name === name)!
  assert.equal(card(names[0]).portrait_url, faces[0]); assert.equal(card(names[1]).portrait_url, faces[1])
  assert.equal(card(names[0]).portrait_thumb_url, faceThumbs[0])
  assert(!('portrait_thumb_url' in card(names[1])), 'a face without a small variant must omit its URL')
  assert(!('portrait' in card(names[0])), 'a stored portrait was sent with its asset key')
  assert(!('portrait_url' in card(names[2])))
  assert(!('portrait_thumb_url' in card(names[2])))
  noAssetKey(sent); noNullThumb(sent)
  // The template is read live, so art published later reaches this same save.
  rows('worldTemplates')[0].seed_cast[3].portrait = { asset_key: 'castface_3.png', source: 'authored', appearance_version: 1, painted_at: new Date() }
  const again: Row[] = []
  await playWsService.handleMessage(socket(again), { action: 'load_instance', instance_id: instanceId })
  assert.equal(((again[0].data as Row).characters as Row[]).find(entry => entry.canonical_name === names[3])!.portrait_url, 'https://fixture.invalid/castface_3.png')
})

await check('art public group template lists members with faces and no authored traits', async () => {
  await start(coveredTemplate())
  const { templateController } = await import('../src/controllers/template.controller')
  const preview = await templateController.getById({ params: { id: template._id.toHexString() }, user: null }) as Row
  assert.equal(preview.kind, 'group')
  assert.equal((preview as Row).image_url, 'https://fixture.invalid/cover.webp')
  assert.equal((preview as Row).image_thumb_url, coverThumb)
  assert.deepEqual(preview.members, [
    { name: names[0], role: 'member 0', portrait_url: faces[0], portrait_thumb_url: faceThumbs[0] },
    { name: names[1], role: 'member 1', portrait_url: faces[1] },
    { name: names[2], role: 'member 2' },
    { name: names[3], role: 'member 3' },
  ])
  for (const key of ['persona', 'voice', 'wants', 'intimacy', 'start_bond', 'talkativeness', 'group', 'topics', 'opening_lines', 'seed_cast', 'seed_prompt']) {
    assert(!(key in preview), `preview leaked ${key}`)
  }
  noAssetKey(preview); noNullThumb(preview)
})

await check('art non-group template keeps its exact public shape', async () => {
  const { publicGroupTemplate } = await import('../src/services/group-chat/public')
  const { publicTemplate } = await import('../src/utils/template-public-projection')
  const { seed_cast: _cast, ...world } = { ...groupTemplate(), kind: 'world' as const }
  assert.deepEqual(publicGroupTemplate(world), publicTemplate(world))
  assert(!('members' in publicGroupTemplate(world)))
  // A normal world never gains the group-only small cover.
  assert(!('image_thumb_url' in publicGroupTemplate({ ...world, image_thumb_url: coverThumb })))
})

await check('art small variants reach the chats row and are omitted when absent', async () => {
  await start(coveredTemplate())
  const { buildGroupChatRow } = await import('../src/services/group-chat/chats')
  const buildRow = () => buildGroupChatRow({
    instance: rows('worldInstances')[0] as never,
    template: rows('worldTemplates')[0] as never,
    cards: rows('characters') as never,
    mainEvents: [], threadEvents: [],
    adultAllowed: false,
  }, new Date())
  const row = buildRow()
  assert.equal(row.image_thumb_url, coverThumb)
  const member = (name: string) => row.members.find(entry => entry.name === name)!
  assert.equal(member(names[0]).portrait_url, faces[0])
  assert.equal(member(names[0]).portrait_thumb_url, faceThumbs[0])
  assert(!('portrait_thumb_url' in member(names[1])), 'a face without a small variant must omit its URL')
  assert(!('portrait_thumb_url' in member(names[2])))
  noAssetKey(row); noNullThumb(row)
  // A template that never published small variants omits the keys entirely.
  delete (rows('worldTemplates')[0] as Row).image_thumb_url
  delete (((rows('worldTemplates')[0] as Row).seed_cast as Row[])[0]!.portrait as Row).thumb_key
  const plain = buildRow()
  assert(!('image_thumb_url' in plain))
  assert(!('portrait_thumb_url' in plain.members.find(entry => entry.name === names[0])!))
  noNullThumb(plain)
})

await check('art portrait small variant re-run changes only its key', async () => {
  const { planPortrait, buildEntrySet, assetKeyFor, pngKeyFor, thumbKeyFor } = await import('./ingest-cast-portraits')
  const bytes = Buffer.from('audit-art-bytes')
  const key = assetKeyFor('audit-world', 'Maya Chen', bytes)
  const png = pngKeyFor('audit-world', 'Maya Chen', bytes)
  const thumb = thumbKeyFor('audit-world', 'Maya Chen', bytes)!
  const entry = { appearance_version: 1 }
  const painted = new Date('2026-11-01Z')
  const current = { asset_key: key, source: 'authored' as const, appearance_version: 1, painted_at: painted }
  const plan = planPortrait(current, key, png, thumb, entry, undefined, painted)
  assert.deepEqual(plan, { kind: 'thumb', thumbKey: thumb })
  assert.deepEqual(buildEntrySet('seed_cast.0', null, plan), { 'seed_cast.0.portrait.thumb_key': thumb })
  const again = planPortrait({ ...current, thumb_key: thumb }, key, png, thumb, entry, undefined, painted)
  assert.deepEqual(again, { kind: 'none' })
  assert.deepEqual(buildEntrySet('seed_cast.0', null, again), {})
  const paint = planPortrait(undefined, key, png, thumb, entry, 'noir', painted)
  assert.equal(paint.kind, 'paint')
  assert.equal(paint.kind === 'paint' ? paint.portrait.thumb_key : undefined, thumb)
})

await check('art cover small variant re-run changes only image_thumb_url', async () => {
  const sharp = (await import('sharp')).default
  const { runCatalog, coverThumbUrl } = await import('./seed-catalog')
  const { encodeUserImage } = await import('../src/utils/image-encoding')
  const dir = await mkdtemp(join(import.meta.dir, '.cover-thumb-audit-'))
  try {
    const catalog = join(dir, 'catalog'), covers = join(dir, 'covers')
    await mkdir(catalog, { recursive: true }); await mkdir(covers, { recursive: true })
    const coverPath = join(covers, 'cover.png')
    await sharp({ create: { width: 900, height: 600, channels: 3, background: { r: 40, g: 80, b: 120 } } }).png().toFile(coverPath)
    const normalized = await encodeUserImage(sharp(await readFile(coverPath)))
    const source = groupTemplate()
    const body = {
      title: source.title, description: source.description, kind: 'group' as const, is_sentient: false, is_nsfw_capable: true,
      seed_prompt: source.seed_prompt, global_lore: source.global_lore, narrative_style: source.narrative_style!,
      seed_cast: source.seed_cast!, topics: source.topics!, opening_lines: source.opening_lines!,
      base_stats_template: {}, flag_definitions: {}, scene_tags: [], max_context_memories: 25, max_lore_results: 10,
    }
    await writeFile(join(catalog, 'thumb-group.json'), JSON.stringify({ slug: 'thumb-group', cover: 'cover.png', ...body }))
    const owner = {
      _id: new ObjectId('200000000000000000000001'), username: 'Everlore', password_hash: '', providers: [],
      preferences: { player_name: 'Everlore' }, account_status: 'active',
    }
    const coverUrl = 'https://fixture.invalid/media/cover-audit.webp'
    const thumbUrl = coverThumbUrl(coverUrl)!
    // The literal shape, not just self-consistency: `.w540.webp` beside the full key.
    assert.equal(thumbUrl, 'https://fixture.invalid/media/cover-audit.w540.webp')
    assert.equal(coverThumbUrl('https://fixture.invalid/media/cover-audit.png'), null)
    let stored: Row | null = null
    let templateWrites = 0
    let thumbWrites: Array<string | null> = []
    let thumbBytes: Buffer | null = null
    const runtime = {
      findUsers: async () => [owner],
      insertUser: async () => { throw new Error('the catalog has an owner') },
      findSlug: async () => stored as never,
      findTitle: async () => null,
      readCover: async () => normalized,
      defaults: () => ({}) as never,
      upload: async () => ({ url: coverUrl }),
      uploadThumb: async (fullUrl: string, bytes: Buffer) => { thumbBytes = bytes; return coverThumbUrl(fullUrl)! },
      setImageThumb: async (_id: string, _owner: string, url: string | null) => {
        thumbWrites.push(url)
        if (stored) (stored as Row).image_thumb_url = url ?? undefined
      },
      create: async (_owner: string, data: Row) => {
        stored = { _id: new ObjectId('100000000000000000000001'), creator_id: owner._id, review_status: 'pending', ...data } as Row
        return stored as never
      },
      update: async (_id: string, _owner: string, data: Row) => {
        templateWrites++
        stored = { ...(stored as Row), ...data } as Row
        return stored as never
      },
      setStarter: async () => {},
      publish: async () => { if (stored) (stored as Row).is_published = true; if (stored) (stored as Row).visibility = 'public' },
      approve: async () => { if (stored) (stored as Row).review_status = 'approved' },
      get: async () => stored as never,
    }
    const options = { catalog, covers, apply: true, allowDefaultCover: false }

    const [first] = await runCatalog(options, runtime as never, () => {})
    assert.equal(first!.outcome, 'create')
    assert.equal(first!.image_thumb_url, thumbUrl)
    assert.equal(templateWrites, 1, 'create then the post-create update')
    assert.deepEqual(thumbWrites, [thumbUrl])

    // A second run does nothing: no upload, no write.
    templateWrites = 0; thumbWrites = []; thumbBytes = null
    const [second] = await runCatalog(options, runtime as never, () => {})
    assert.equal(second!.outcome, 'unchanged')
    assert.deepEqual(thumbWrites, [])
    assert.equal(templateWrites, 0, 'an unchanged world must not be rewritten')

    // A published cover that lost its small variant gains only that field.
    ;(stored as Row).image_thumb_url = undefined
    templateWrites = 0; thumbWrites = []; thumbBytes = null
    const [third] = await runCatalog(options, runtime as never, () => {})
    assert.equal(third!.outcome, 'update')
    assert.deepEqual(thumbWrites, [thumbUrl])
    assert.equal(templateWrites, 0, 'a thumb-only re-run must not rewrite the world')
    const meta = await sharp(thumbBytes!).metadata()
    assert.equal(meta.format, 'webp')
    assert.equal(meta.width, 540)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

await check('art future line hidden from chats and threads behind the earlier visible one', async () => {
  await start()
  const now = Date.now(), seed = clone(rows('events')[0])
  rows('events').push({ ...seed, _id: new ObjectId(), sequence: 2, created_at: new Date(now - 60_000), data: {
    player_input: '', model_used: 'fake',
    lines: [
      { character_id: ids[0], text: 'Earlier visible line', shown_at: new Date(now - 55_000) },
      { character_id: ids[1], text: 'Future secret line', shown_at: new Date(now + 3_600_000) },
    ],
  } })
  rows('events').push({ ...seed, _id: new ObjectId(), sequence: 3, created_at: new Date(now - 50_000), data: {
    dm_with: ids[2], player_input: 'Private hello', model_used: 'fake',
    lines: [
      { character_id: ids[2], text: 'Older private reply', shown_at: new Date(now - 45_000) },
      { character_id: ids[2], text: 'Future private reply', shown_at: new Date(now + 3_600_000) },
    ],
  } })
  const { instanceRoutes } = await import('../src/routes/instance.routes')
  const app = new Elysia().onError(({ error, set }) => {
    set.status = 'statusCode' in error ? Number(error.statusCode) : 500
    return { message: error.message }
  }).use(instanceRoutes)
  routeUser = { id: playerId, tier: 'creator' }
  const listResponse = await app.handle(new Request('http://localhost/instances/group-chats'))
  assert.equal(listResponse.status, 200)
  const row = ((await listResponse.json()) as { chats: Row[] }).chats[0]
  assert.equal((row.last as Row).text, 'Earlier visible line')
  assert.equal((row.threads as Row[]).length, 1)
  assert.equal(((row.threads as Row[])[0].last as Row).text, 'Older private reply')
  assert.equal((row.threads as Row[])[0].message_count, 2)
  const threadResponse = await app.handle(new Request(`http://localhost/instances/${instanceId}/threads`))
  assert.equal(threadResponse.status, 200)
  const thread = ((await threadResponse.json()) as Row[])[0]
  assert.equal(thread.lastLine, 'Older private reply'); assert.equal(thread.messageCount, 2)
  assert(!JSON.stringify([row, thread]).includes('Future'), 'a message ahead of the clock was shown')
  assert.deepEqual(row.pending_from, [])
  routeUser = null
  assert.equal((await app.handle(new Request('http://localhost/instances/group-chats'))).status, 401)
  routeUser = { id: new ObjectId().toHexString(), tier: 'creator' }
  assert.deepEqual(await (await app.handle(new Request('http://localhost/instances/group-chats'))).json(), { chats: [] })
  routeUser = { id: playerId, tier: 'creator' }
  put(rows('worldInstances')[0], 'meta.is_archived', true)
  assert.deepEqual(await (await app.handle(new Request('http://localhost/instances/group-chats'))).json(), { chats: [] })
})

await check('art toggle off keeps adult words out of every list preview', async () => {
  await start()
  const now = Date.now(), seed = clone(rows('events')[0])
  const push = (sequence: number, type: string, at: number, data: Row) => rows('events').push({ ...seed, _id: new ObjectId(), sequence,
    created_at: new Date(at), type, data: { model_used: 'fake', player_input: '', ...data } })
  // Room: an ordinary line, then an adult turn whose only words are the player's.
  push(2, 'narration', now - 80_000, { player_input: 'Earlier room input',
    lines: [{ character_id: ids[0], text: 'Earlier room line', shown_at: new Date(now - 79_000) }] })
  push(3, 'intimate', now - 20_000, { player_input: 'Adult room player words', lines: [] })
  // One thread: an ordinary line, then an adult one. Another thread: adult only.
  push(4, 'narration', now - 70_000, { dm_with: ids[1], player_input: 'Earlier private input',
    lines: [{ character_id: ids[1], text: 'Earlier private line', shown_at: new Date(now - 69_000) }] })
  push(5, 'intimate', now - 60_000, { dm_with: ids[1], player_input: 'Adult private player words',
    lines: [{ character_id: ids[1], text: 'Adult private line', shown_at: new Date(now - 59_000) }] })
  push(6, 'intimate', now - 50_000, { dm_with: ids[2], player_input: 'Only adult words',
    lines: [{ character_id: ids[2], text: 'Only adult line', shown_at: new Date(now - 49_000) }] })

  const { instanceRoutes } = await import('../src/routes/instance.routes')
  const app = new Elysia().onError(({ error, set }) => {
    set.status = 'statusCode' in error ? Number(error.statusCode) : 500
    return { message: error.message }
  }).use(instanceRoutes)
  const chatList = async () => {
    const response = await app.handle(new Request('http://localhost/instances/group-chats'))
    assert.equal(response.status, 200)
    return ((await response.json()) as { chats: Row[] }).chats[0]
  }
  const threadList = async () => {
    const response = await app.handle(new Request(`http://localhost/instances/${instanceId}/threads`))
    assert.equal(response.status, 200)
    return (await response.json()) as Row[]
  }
  const threadRow = (row: Row, id: string) => (row.threads as Row[]).find(thread => thread.member_id === id)!
  routeUser = { id: playerId, tier: 'creator' }

  let reads = 0
  consentReadHook = () => { reads++ }
  const off = await chatList()
  assert.equal(reads, 1, 'the chat list must read the toggle once, not once per chat')
  assert.equal((off.last as Row).text, 'Earlier room line')
  assert.equal((threadRow(off, ids[1]).last as Row).text, 'Earlier private line')
  assert.equal(threadRow(off, ids[1]).message_count, 4)
  // The all-adult thread keeps its row, reachable, with nothing to preview.
  assert.equal(threadRow(off, ids[2]).last, undefined)
  assert.equal(threadRow(off, ids[2]).message_count, 2)
  reads = 0
  const offThreads = await threadList()
  assert.equal(reads, 1, 'the thread list must read the toggle once')
  const offLine = (id: string) => offThreads.find(thread => thread.memberId === id)!
  assert.equal(offLine(ids[1]).lastLine, 'Earlier private line'); assert.equal(offLine(ids[1]).messageCount, 4)
  assert.equal(offLine(ids[2]).lastLine, ''); assert.equal(+new Date(String(offLine(ids[2]).lastAt)), now - 50_000)
  assert(!/Adult private line|Only adult line|Adult room player words/.test(JSON.stringify([off, offThreads])))
  consentReadHook = undefined

  put(rows('users')[0], 'preferences.nsfw_enabled', true)
  const on = await chatList()
  assert.equal((on.last as Row).text, 'Adult room player words'); assert.equal((on.last as Row).from, 'player')
  assert.equal((threadRow(on, ids[1]).last as Row).text, 'Adult private line')
  assert.equal((threadRow(on, ids[2]).last as Row).text, 'Only adult line')
  const onThreads = await threadList()
  assert.equal(onThreads.find(thread => thread.memberId === ids[1])!.lastLine, 'Adult private line')
  assert.equal(onThreads.find(thread => thread.memberId === ids[2])!.lastLine, 'Only adult line')
})

await check('art direct message never becomes the room last', async () => {
  const { buildGroupChatRow } = await import('../src/services/group-chat/chats')
  const now = new Date()
  const row = buildGroupChatRow({
    instance: { _id: new ObjectId(), template_id: template._id, seed_cast_snapshot: template.seed_cast },
    template,
    cards: members.map(member => ({ _id: new ObjectId(member.id), canonical_name: member.name })) as never,
    mainEvents: [
      { sequence: 1, created_at: now, data: { lines: [{ character_id: ids[0], text: 'Room line', shown_at: now }] } },
      { sequence: 2, created_at: now, data: { dm_with: ids[1], player_input: 'Private words',
        lines: [{ character_id: ids[1], text: 'Private reply', shown_at: now }] } },
    ],
    threadEvents: [],
    adultAllowed: false,
  }, now)
  assert.equal(row.last?.text, 'Room line')
  assert.deepEqual(row.threads, [])
})

await check('art stored portraits stay valid and a body portrait never reaches storage', async () => {
  const faced = facedTemplate()
  validateGroup(faced)
  const { _id, creator_id, slug: _slug, version: _version, created_at: _created, updated_at: _updated,
    is_published: _published, visibility: _visibility, review_status: _review, ...body } = faced
  validateEntry({ ...body, slug: 'fixture', cover: 'fixture.png' }, 'fixture')
  await start(faced)
  const joined = await instanceService.create(playerId, template._id.toHexString(), 'creator')
  assert.equal(joined.instance._id.toHexString(), instanceId)
  const { CreateTemplateBody } = await import('../src/schemas/template.schema')
  const app = new Elysia().post('/template', ({ body: accepted }) => accepted, { body: CreateTemplateBody })
  const response = await app.handle(new Request('http://localhost/template', { method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, seed_cast: body.seed_cast!.map((member, index) => index ? member
      : { ...member, portrait: { asset_key: 'player_supplied.png', source: 'generated', appearance_version: 1, painted_at: new Date() } }) }),
  }))
  assert.equal(response.status, 200)
  const accepted = (await response.json()) as Row
  assert(!('portrait' in (accepted.seed_cast as Row[])[0]))
  noAssetKey(accepted)
})

await check('art cast size two and six pass while one and seven fail', async () => {
  const base = groupTemplate()
  const cast = (count: number) => ({
    ...base,
    seed_cast: Array.from({ length: count }, (_, index) => ({ ...structuredClone(base.seed_cast![index % 4]), name: `Cast ${index}` })),
    opening_lines: [{ name: 'Cast 0', text: 'The authored opening.' }],
  })
  const { CreateTemplateBody } = await import('../src/schemas/template.schema')
  const app = new Elysia().post('/template', ({ body: accepted }) => accepted, { body: CreateTemplateBody })
  const accepted = async (count: number) => {
    const body = cast(count)
    const response = await app.handle(new Request('http://localhost/template', { method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: body.title, description: body.description, kind: 'group', seed_prompt: body.seed_prompt,
        global_lore: body.global_lore, is_sentient: false, is_nsfw_capable: true, topics: body.topics,
        opening_lines: body.opening_lines, seed_cast: body.seed_cast, base_stats_template: body.base_stats_template }),
    }))
    return response.status === 200
  }
  for (const count of [2, 6]) { validateGroup(cast(count)); assert.equal(await accepted(count), true) }
  for (const count of [1, 7]) { assert.throws(() => validateGroup(cast(count))); assert.equal(await accepted(count), false) }
})

// The group text gate judges every player-written line before anything is
// stored. The model call is stubbed here; the service and validation are real.
const { textGateEffects } = await import('../src/services/group-chat/text-gate')
const { groupTextLines, checkGroupText, groupTextGateModel } = await import('../src/services/group-chat/text-gate')
const originalGateModel = process.env.GROUP_TEXT_GATE_MODEL
process.env.GROUP_TEXT_GATE_MODEL = 'fixture-text-gate-model'
let gateReplies: Array<string | Error> = [], gateRequests: Array<Parameters<typeof textGateEffects.call>[0]> = [], gateWaits = 0
function resetGate(replies: Array<string | Error> = []) {
  gateReplies = [...replies]; gateRequests = []; gateWaits = 0
  textGateEffects.call = async (request) => {
    gateRequests.push(request)
    const reply = gateReplies.shift()
    if (reply instanceof Error) throw reply
    return reply ?? JSON.stringify({ verdict: 'allow', rejected: [] })
  }
  textGateEffects.wait = async () => { gateWaits++ }
}
function gateLines(request: Parameters<typeof textGateEffects.call>[0]) {
  const payload = JSON.parse(request.messages[1].content) as { lines: Array<{ handle: number; text: string }> }
  return payload.lines
}
function handleFor(request: Parameters<typeof textGateEffects.call>[0], text: string) {
  const line = gateLines(request).find((entry) => entry.text === text)
  assert(line, `gate request has no line ${text}`)
  return line!.handle
}
function resetSaveTables() {
  tables.clear()
  rows('users').push({ _id: new ObjectId(playerId), guest: false })
}
/** A save body with every field count known: 67 written lines. */
function groupSaveBody() {
  const source = groupTemplate()
  return {
    title: source.title,
    description: source.description,
    kind: 'group' as const,
    seed_prompt: source.seed_prompt,
    global_lore: source.global_lore,
    is_sentient: false,
    is_nsfw_capable: true,
    narrative_style: source.narrative_style,
    topics: [...source.topics!],
    opening_lines: structuredClone(source.opening_lines!),
    seed_cast: source.seed_cast!.map((member) => ({
      name: member.name,
      role: member.role,
      appearance: `Appearance for ${member.name}.`,
      persona: member.persona,
      group: { ...structuredClone(member.group)!, voice: [`Voice line for ${member.name}.`] },
      first_texts: ['First text one.', 'First text two.', 'First text three.'],
      statuses: { morning: 'Morning line.', afternoon: 'Afternoon line.', evening: 'Evening line.', night: 'Night line.' },
    })),
    base_stats_template: {},
    flag_definitions: {},
    scene_tags: [],
    max_context_memories: 25,
    max_lore_results: 10,
  }
}
const gateStatus = (statusCode: number, message?: string) => (error: unknown) =>
  error instanceof Error && 'statusCode' in error && error.statusCode === statusCode && (message === undefined || error.message === message)

await check('group text gate allows a save and stores the group', async () => {
  resetSaveTables(); resetGate()
  const template = await templateService.create(playerId, groupSaveBody())
  assert.equal(template.kind, 'group')
  assert.equal(rows('worldTemplates').length, 1)
  assert.equal(gateRequests.length, 1)
  assert.equal(gateRequests[0].purpose, 'group_text_gate')
  // The gate's own setting drives the model; the media moderation model is never asked to judge these lines.
  assert.equal(groupTextGateModel(), 'fixture-text-gate-model')
  assert.equal(gateRequests[0].model, groupTextGateModel())
  assert.equal(gateRequests[0].maxTokens, 4096)
  assert.equal(gateRequests[0].timeoutMs, 60000)
  assert.equal(gateRequests[0].temperature, 0)
  assert(gateRequests[0].responseSchema)
  assert.equal((gateRequests[0].messages as Array<{ role: string }>)[0].role, 'system')
})
await check('group text gate rejects only the refused line and writes nothing', async () => {
  resetSaveTables(); resetGate()
  const body = groupSaveBody()
  body.description = 'A line the gate refuses.'
  textGateEffects.call = async (request) => {
    gateRequests.push(request)
    return JSON.stringify({ verdict: 'reject', rejected: [handleFor(request, body.description)] })
  }
  await assert.rejects(templateService.create(playerId, body), (error: unknown) => {
    const failure = error as { statusCode?: number; message?: string; details?: { paths?: string[] } }
    assert.equal(failure.statusCode, 422)
    assert.equal(failure.message, "Some lines in this group can't be saved. Change them and try again.")
    assert.deepEqual(failure.details?.paths, ['description'])
    return true
  })
  assert.equal(rows('worldTemplates').length, 0)
})
await check('group text gate transport failure twice returns 503 and stores nothing', async () => {
  resetSaveTables(); resetGate([
    Object.assign(new Error('Fixture provider failure'), { status: 500 }),
    Object.assign(new Error('Fixture provider failure'), { status: 500 }),
  ])
  await assert.rejects(templateService.create(playerId, groupSaveBody()),
    gateStatus(503, 'Try again in a moment.'))
  assert.equal(gateWaits, 1)
  assert.equal(gateRequests.length, 2)
  assert.equal(rows('worldTemplates').length, 0)
})
await check('group text gate retries a rate limit once and then saves', async () => {
  resetSaveTables(); resetGate([Object.assign(new Error('Fixture rate limit'), { status: 429 })])
  const template = await templateService.create(playerId, groupSaveBody())
  assert.equal(template.kind, 'group')
  assert.equal(gateWaits, 1)
  assert.equal(gateRequests.length, 2)
  assert.equal(rows('worldTemplates').length, 1)
})
await check('group text gate fails closed on a malformed verdict, unknown handle or empty reject list', async () => {
  const body = groupSaveBody()
  const allPaths = groupTextLines(body).map((line) => line.path)
  for (const reply of [
    'not json at all',
    JSON.stringify({ verdict: 'reject', rejected: [999] }),
    JSON.stringify({ verdict: 'reject', rejected: [] }),
    JSON.stringify({ verdict: 'reject' }),
    JSON.stringify({ verdict: 'maybe', rejected: [] }),
    JSON.stringify({ verdict: 'allow', rejected: [1] }),
  ]) {
    resetSaveTables(); resetGate([reply])
    await assert.rejects(templateService.create(playerId, body), (error: unknown) => {
      const failure = error as { statusCode?: number; details?: { paths?: string[] } }
      assert.equal(failure.statusCode, 422)
      assert.deepEqual(failure.details?.paths, allPaths)
      return true
    })
    assert.equal(rows('worldTemplates').length, 0)
  }
})
await check('group text gate request carries every written line and no path', async () => {
  resetSaveTables(); resetGate()
  const body = groupSaveBody()
  await templateService.create(playerId, body)
  const sent = gateLines(gateRequests[0])
  const expected = groupTextLines(body)
  assert.equal(expected.length, 67)
  assert.equal(sent.length, 67)
  assert.deepEqual(sent.map((line) => line.handle), Array.from({ length: 67 }, (_, index) => index + 1))
  assert.deepEqual(sent.map((line) => line.text), expected.map((line) => line.text))
  const requestText = JSON.stringify(gateRequests[0])
  for (const path of expected.map((line) => line.path)) assert(!requestText.includes(path), `gate request leaks ${path}`)
})
await check('group text gate prompt leads with the allowed case', async () => {
  resetSaveTables(); resetGate()
  await templateService.create(playerId, groupSaveBody())
  const system = (gateRequests[0].messages as Array<{ content: string }>)[0].content
  assert(system.startsWith('These lines are written for a fictional adult group chat. Explicit sex between consenting adults is allowed, including crude and graphic language, and is never a reason to reject.'))
  for (const required of ['anyone under 18', 'sex without consent', 'a real, identifiable person', '18 or over']) assert(system.includes(required))
})
await check('group update gates the merged template and stores nothing on a refusal', async () => {
  resetSaveTables(); resetGate()
  const stored = { ...groupTemplate(), _id: new ObjectId(), creator_id: new ObjectId(playerId) }
  rows('worldTemplates').push(stored as unknown as Row)
  textGateEffects.call = async (request) => {
    gateRequests.push(request)
    const lines = gateLines(request)
    assert(lines.some((line) => line.text === stored.global_lore))
    const handle = handleFor(request, 'A later line.')
    return JSON.stringify({ verdict: 'reject', rejected: [handle] })
  }
  await assert.rejects(templateService.update(String(stored._id), playerId, { description: 'A later line.' }), (error: unknown) => {
    const failure = error as { statusCode?: number; details?: { paths?: string[] } }
    assert.equal(failure.statusCode, 422)
    assert.deepEqual(failure.details?.paths, ['description'])
    return true
  })
  assert.deepEqual(rows('worldTemplates')[0], stored)
})
await check('normal world saves never call the group text gate', async () => {
  resetSaveTables(); resetGate()
  const callsBefore = extractCastCalls
  const created = await templateService.create(playerId, {
    title: 'An ordinary world', description: 'A place to travel', kind: 'world',
    seed_prompt: 'A place to travel and see what happens.', global_lore: '', is_sentient: false, is_nsfw_capable: false,
    base_stats_template: { mood: { default: 50, min: 0, max: 100, description: 'Mood' } },
  })
  assert.equal(created.kind, 'world')
  assert.equal(extractCastCalls, callsBefore + 1)
  assert.equal(gateRequests.length, 0)
  await templateService.update(String(created._id), playerId, { max_lore_results: 20 })
  assert.equal(gateRequests.length, 0)
})
await check('group text gate returns one allow without a call for no lines', async () => {
  resetGate()
  assert.deepEqual(await checkGroupText([]), { ok: true })
  assert.equal(gateRequests.length, 0)
})
// The model's reasoning can run past its token budget and come back empty. That
// is transport, not a verdict: the gate asks once more, exactly as for a 429.
const emptyGateAnswer = () => new EmptyLLMResponseError({ finishReason: 'length' })
await check('group text gate retries an empty answer once and then allows', async () => {
  resetGate([emptyGateAnswer()])
  assert.deepEqual(await checkGroupText([{ path: 'description', text: 'A line.' }]), { ok: true })
  assert.equal(gateWaits, 1)
  assert.equal(gateRequests.length, 2)
})
await check('group text gate two empty answers return 503 after two calls', async () => {
  resetGate([emptyGateAnswer(), emptyGateAnswer()])
  await assert.rejects(checkGroupText([{ path: 'description', text: 'A line.' }]),
    gateStatus(503, 'Try again in a moment.'))
  assert.equal(gateWaits, 1)
  assert.equal(gateRequests.length, 2)
})
await check('group text gate an empty answer then a malformed verdict fails closed', async () => {
  resetGate([emptyGateAnswer(), 'not json at all'])
  assert.deepEqual(await checkGroupText([{ path: 'description', text: 'A line.' }]),
    { ok: false, paths: ['description'] })
  assert.equal(gateWaits, 1)
  assert.equal(gateRequests.length, 2, 'a malformed verdict is never asked again')
})
if (originalGateModel === undefined) delete process.env.GROUP_TEXT_GATE_MODEL
else process.env.GROUP_TEXT_GATE_MODEL = originalGateModel

await check('art no asset key reaches the preview or a chats row', async () => {
  await start(facedTemplate())
  const { templateController } = await import('../src/controllers/template.controller')
  const { buildGroupChatRow } = await import('../src/services/group-chat/chats')
  const preview = await templateController.getById({ params: { id: template._id.toHexString() }, user: null })
  const row = buildGroupChatRow({
    instance: rows('worldInstances')[0] as never,
    template: rows('worldTemplates')[0] as never,
    cards: rows('characters') as never,
    mainEvents: [], threadEvents: [],
    adultAllowed: false,
  }, new Date())
  noAssetKey(preview); noAssetKey(row)
})

// Line-report safety checks use saved events and the real moderation service/controller.
async function reportFixture() {
  await start(); addEvents(1)
  const event = storedEvents().at(-1)!
  event.data.player_input = 'PLAYER_INPUT_ONLY'
  event.data.lines = [
    { character_id: ids[0], text: 'Saved first line.', shown_at: new Date() },
    { character_id: ids[1], text: 'Saved second line.', shown_at: new Date() },
  ]
  return { event, input: { reporterId: playerId, targetType: 'group_line' as const, targetId: String(event._id),
    characterId: ids[0], text: event.data.lines[0].text, reason: 'harassment_or_hate' as const } }
}
const reportError = (status: number, message?: string) => (error: unknown) =>
  error instanceof Error && 'statusCode' in error && error.statusCode === status && (message === undefined || error.message === message)
await check('line report saved text snapshot is server owned and response stays private', async () => {
  const { event, input } = await reportFixture()
  // Even the group's catalog owner may report generated words.
  rows('worldTemplates')[0].creator_id = new ObjectId(playerId)
  // Validation reads the string three times; selection reads it once. A later
  // snapshot read of the request must not replace the saved evidence.
  let textReads = 0
  Object.defineProperty(input, 'text', { configurable: true, get: () => ++textReads <= 4 ? 'Saved first line.' : 'FORGED_REQUEST_TEXT' })
  const result = await moderationService.report(input)
  Object.defineProperty(input, 'text', { configurable: true, writable: true, value: 'Saved first line.' })
  assert.deepEqual(Object.keys(result).sort(), ['duplicate', 'report_id', 'reported'])
  assert.equal(result.duplicate, false); assert.equal(result.reported, true)
  const doc = rows('contentReports')[0]
  assert(!('target_creator_id' in doc))
  assert.equal(doc.target_line, createHash('sha256').update(JSON.stringify([ids[0], event.data.lines![0].text])).digest('hex'))
  assert.deepEqual(doc.target_snapshot, { title: template.title, speaker: names[0], description: 'Saved first line.',
    context: [...storedEvents()[0].data.lines!.map(line => `${names[ids.indexOf(line.character_id)]}: ${line.text}`), `${playerName}: PLAYER_INPUT_ONLY`].slice(-6).join('\n'),
    thread: 'group', is_nsfw_capable: Boolean(template.is_nsfw_capable) })
  input.text = 'Changed request after submission'
  event.data.lines![0].text = 'Changed event after submission'
  assert.equal(get(doc, 'target_snapshot.description'), 'Saved first line.')
  const payloads = [await generationService.loadInstance(instanceId, playerId),
    await (await import('../src/services/memory.service')).memoryService.getEvents(instanceId, playerId, {})]
  for (const payload of payloads) for (const key of ['target_snapshot', 'target_line', 'speaker', 'context', 'target_creator_id']) {
    assert(!JSON.stringify(payload).includes(`"${key}":`), `player payload leaked ${key}`)
  }
})
for (const scenario of ['foreign', 'missing', 'wrong character', 'altered text', 'non-group', 'player input'] as const) {
  await check(`line report uniform 404 ${scenario}`, async () => {
    const { event, input } = await reportFixture()
    if (scenario === 'foreign') rows('worldInstances')[0].player_id = new ObjectId()
    if (scenario === 'missing') input.targetId = String(new ObjectId())
    if (scenario === 'wrong character') input.characterId = String(new ObjectId())
    if (scenario === 'altered text') input.text += ' forged'
    if (scenario === 'non-group') { delete rows('worldInstances')[0].group_state; rows('worldTemplates')[0].kind = 'narrator' }
    if (scenario === 'player input') input.text = event.data.player_input!
    await assert.rejects(moderationService.report(input), reportError(404, 'That line could not be found.'))
    assert.equal(rows('contentReports').length, 0)
  })
}
await check('line report distinct lines repeat 11000 and legacy missing line stay duplicate', async () => {
  const { event, input } = await reportFixture()
  const first = await moderationService.report(input)
  const secondInput = { ...input, characterId: ids[1], text: event.data.lines![1].text }
  const second = await moderationService.report(secondInput)
  assert.notEqual(first.report_id, second.report_id)
  rows('contentReports')[0].status = 'reviewing'
  assert.deepEqual(await moderationService.report(input), { ...first, duplicate: true })
  assert.deepEqual(await moderationService.report(secondInput), { ...second, duplicate: true })
  for (const targetType of ['world', 'user'] as const) {
    const targetId = targetType === 'world' ? String(template._id) : String(new ObjectId())
    if (targetType === 'user') rows('users').push({ _id: new ObjectId(targetId), username: 'Reported creator' })
    const legacy = { _id: new ObjectId(), reporter_id: new ObjectId(playerId), target_type: targetType,
      target_id: new ObjectId(targetId), status: 'open' }
    rows('contentReports').push(legacy)
    const duplicate = await moderationService.report({ reporterId: playerId, targetType, targetId, reason: 'spam_or_misleading' })
    assert.equal(duplicate.duplicate, true); assert.equal(duplicate.report_id, String(legacy._id))
    rows('contentReports').splice(rows('contentReports').indexOf(legacy), 1)
    const fresh = await moderationService.report({ reporterId: playerId, targetType, targetId, reason: 'spam_or_misleading' })
    assert.equal(fresh.duplicate, false)
    assert(!('target_line' in rows('contentReports').at(-1)!))
  }
  await assert.rejects(moderationService.report({ reporterId: playerId, targetType: 'user', targetId: playerId, reason: 'spam_or_misleading' }), reportError(400))
  rows('worldTemplates')[0].creator_id = new ObjectId(playerId)
  await assert.rejects(moderationService.report({ reporterId: playerId, targetType: 'world', targetId: String(template._id), reason: 'spam_or_misleading' }), reportError(400))
})
await check('line report context bounded preceding and confined to exact thread', async () => {
  for (const thread of [undefined, ids[0]]) {
    const { event, input } = await reportFixture()
    event.sequence = 20
    if (thread !== undefined) event.data.dm_with = thread
    for (let sequence = 3; sequence < 20; sequence++) rows('events').push({ ...clone(event) as unknown as Row,
      _id: new ObjectId(), sequence, data: { dm_with: sequence % 2 ? thread : ids[2],
        player_input: sequence % 2 ? `prior player ${sequence}` : 'FOREIGN_THREAD',
        lines: [{ character_id: ids[0], text: sequence % 2 ? `prior saved ${sequence}` : 'FOREIGN_THREAD', shown_at: new Date() }],
        tame_members: [ids[0]] } })
    input.characterId = ids[1]; input.text = event.data.lines![1].text
    await moderationService.report(input)
    const snapshot = rows('contentReports')[0].target_snapshot as Row
    assert.equal(snapshot.thread, thread === undefined ? 'group' : 'direct')
    assert.equal(snapshot.context, `${playerName}: prior player 17\n${names[0]}: prior saved 17\n${playerName}: prior player 19\n${names[0]}: prior saved 19\n${playerName}: PLAYER_INPUT_ONLY\n${names[0]}: Saved first line.`)
    assert(!String(snapshot.context).includes('FOREIGN_THREAD')); assert(!String(snapshot.context).includes('Saved second line.'))
  }
})
await check('line report critical snapshot survives event and save deletion', async () => {
  const { input } = await reportFixture()
  const result = await moderationService.report({ ...input, reason: 'sexual_content_involving_minors' })
  assert.equal(rows('contentReports')[0].is_critical, true)
  const before = await moderationService.getReport(result.report_id!)
  assert.equal(before.report.priority, 'CRITICAL'); assert.equal(before.creator, null)
  assert(!('target_creator_id' in before.report))
  assert.equal(before.report.target_snapshot.description, 'Saved first line.')
  assert.equal(before.report.target_snapshot.speaker, names[0])
  await deletionService.deleteInstance(instanceId, playerId)
  assert.equal(storedEvents().length, 0)
  const after = await moderationService.getReport(result.report_id!)
  assert.deepEqual(after.report.target_snapshot, before.report.target_snapshot)
  assert.equal(after.report.target_line, before.report.target_line)
})
await check('line report resolve only none and both terminal statuses work', async () => {
  const { input } = await reportFixture()
  const result = await moderationService.report(input)
  // A malformed/legacy creator field must never authorize a ban for generated words.
  rows('contentReports')[0].target_creator_id = new ObjectId(playerId)
  for (const action of ['content_hidden', 'content_unpublished', 'content_deleted', 'creator_banned'] as const) {
    await assert.rejects(moderationService.resolveReport(result.report_id!, { action }), reportError(400))
    assert.equal(rows('contentReports')[0].status, 'open')
  }
  for (const status of ['actioned', 'dismissed'] as const) {
    const resolved = await moderationService.resolveReport(result.report_id!, { action: 'none', status })
    assert.equal(resolved.report!.status, status); assert.deepEqual(resolved.effects, [])
  }
})
await check('line report HTTP validates bounds required fields refuses world and user extras and block type', async () => {
  const { input } = await reportFixture()
  const { moderationController } = await import('../src/controllers/moderation.controller')
  const { CreateReportBody, BlockBody, AdminReportQuery } = await import('../src/schemas/moderation.schema')
  const app = new Elysia().onError(({ error, set }) => { set.status = 'statusCode' in error ? Number(error.statusCode) : 400; return { error: error.message } })
    .post('/report', ({ body }) => moderationController.createReport({ user: { id: playerId, tier: 'creator' }, body }), { body: CreateReportBody })
    .post('/block', () => ({ blocked: true }), { body: BlockBody })
    .get('/queue', ({ query }) => query, { query: AdminReportQuery })
  const request = (body: Row, path = '/report') => app.handle(new Request(`http://localhost${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }))
  const body = { target_type: 'group_line', target_id: input.targetId, character_id: input.characterId, text: input.text, reason: input.reason }
  assert.equal((await request(body)).status, 200)
  assert.equal((await app.handle(new Request('http://localhost/queue?target_type=group_line'))).status, 200)
  for (const patch of [{ character_id: undefined }, { text: undefined }, { text: '' }, { character_id: '' },
    { text: 'x'.repeat(4001) }, { character_id: 'x'.repeat(65) }, { details: 'x'.repeat(1001) }]) {
    assert.equal((await request({ ...body, ...patch })).status, 400)
  }
  for (const targetType of ['world', 'user'] as const) for (const extra of [{ character_id: ids[0] }, { text: input.text }]) {
    assert.equal((await request({ target_type: targetType, target_id: String(template._id), reason: input.reason, ...extra })).status, 400)
    await assert.rejects(moderationService.report({ ...input, targetType, targetId: String(template._id),
      characterId: extra.character_id, text: extra.text }), reportError(400))
  }
  for (const patch of [{ text: '' }, { text: 'x'.repeat(4001) }, { characterId: '' }, { characterId: 'x'.repeat(65) }, { details: 'x'.repeat(1001) }]) {
    await assert.rejects(moderationService.report({ ...input, ...patch }), reportError(400))
  }
  await assert.rejects(moderationService.report({ ...input, reason: 'other', details: '   ' }), reportError(400))
  assert.equal((await request({ target_type: 'group_line', target_id: input.targetId }, '/block')).status, 400)
  await assert.rejects(moderationController.createReport({ user: null, body }), reportError(401))
})
await check('line report index gains line key new name deprecated old and unresolved scope', async () => {
  const { EVERLORE_INDEXES, DEPRECATED_INDEXES } = await import('../src/config/mongo-indexes')
  const index = EVERLORE_INDEXES.find(index => index.options?.name === 'uniq_content_reports_open_per_reporter_line')!
  assert(index); assert.equal(index.collection, 'content_reports')
  assert.deepEqual(index.key, { reporter_id: 1, target_type: 1, target_id: 1, target_line: 1 })
  assert.equal(index.options!.unique, true)
  assert.deepEqual(index.options!.partialFilterExpression, { status: { $in: ['open', 'reviewing'] } })
  assert(DEPRECATED_INDEXES.some(index => index.collection === 'content_reports' && index.name === 'uniq_content_reports_open_per_reporter'))
})

// Player requests use the actual route; admin requests use the same schema/service
// handlers as the line-report checks above, without importing unrelated admin surfaces.
async function chatReportHttp(path: string, method = 'GET', body?: Row) {
  const { moderationRoutes } = await import('../src/routes/moderation.routes')
  const { AdminReportQuery, AdminResolveReportBody } = await import('../src/schemas/moderation.schema')
  const app = new Elysia().onError(({ error, set }) => {
    set.status = 'statusCode' in error ? Number(error.statusCode) : 400
    return { message: error.message }
  }).use(moderationRoutes)
    .get('/admin/reports', ({ query }) => moderationService.listReports(query), { query: AdminReportQuery })
    .get('/admin/reports/:reportId', ({ params }) => moderationService.getReport(params.reportId))
    .patch('/admin/reports/:reportId', ({ params, body }) => moderationService.resolveReport(params.reportId, body), { body: AdminResolveReportBody })
  return app.handle(new Request(`http://localhost${path}`, {
    method, ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  }))
}
async function chatReportFixture() {
  await start(); addEvents(5)
  const instance = rows('worldInstances')[0]
  for (const key of ['group_template_id', 'group_state', 'group_context']) delete instance[key]
  rows('worldTemplates')[0].kind = 'world'
  // The author may also be the player: generated passages still have no creator.
  rows('worldTemplates')[0].creator_id = new ObjectId(playerId)
  rows('users')[0].username = 'DO_NOT_ATTRIBUTE'
  const events = storedEvents()
  for (const event of events) {
    event.data = { ...event.data, player_input: `Player turn ${event.sequence}`, ai_response: `Response turn ${event.sequence}` }
    event.time_anchor = { real_time: new Date(), sequence: event.sequence, timeline_id: 'main' }
  }
  const event = events.at(-1)!
  event.data.ai_response = `  Full saved passage ${'x'.repeat(5000)}  `
  routeUser = { id: playerId, tier: 'creator' }
  return { event, body: { target_type: 'chat_line', target_id: String(event._id), reason: 'harassment_or_hate' } }
}
async function fileChatReport(body: Row) {
  const response = await chatReportHttp('/moderation/reports', 'POST', body)
  assert.equal(response.status, 200)
  const result = await response.json() as { reported: boolean; report_id: string; duplicate: boolean }
  assert.deepEqual(Object.keys(result).sort(), ['duplicate', 'report_id', 'reported'])
  assert.equal(result.reported, true)
  return result
}
await check('chat report snapshot stores whole saved response and both edit and mature marks without attribution', async () => {
  for (const edited of [false, true]) {
    const { event, body } = await chatReportFixture()
    event.is_user_edited = edited
    rows('worldTemplates')[0].is_nsfw_capable = edited
    const original = event.data.ai_response
    const result = await fileChatReport({ ...body, details: '  Saved evidence  ' })
    assert.equal(result.duplicate, false)
    const doc = rows('contentReports')[0]
    assert.equal(String(doc.reporter_id), playerId); assert.equal(String(doc.target_id), body.target_id)
    assert.equal(doc.target_type, 'chat_line'); assert.equal(doc.reason, body.reason)
    assert.equal(doc.details, 'Saved evidence'); assert.equal(doc.status, 'open'); assert.equal(doc.is_critical, false)
    assert(!('target_line' in doc)); assert(!('target_creator_id' in doc))
    assert.deepEqual(doc.target_snapshot, { title: template.title, description: original,
      context: [3, 4, 5].map(sequence => `Player: Player turn ${sequence}\nResponse: Response turn ${sequence}`).join('\n'),
      is_user_edited: edited, is_nsfw_capable: edited })
    event.data.ai_response = 'Changed after report'
    assert.equal(get(doc, 'target_snapshot.description'), original)
  }
})
await check('chat report context only three earlier turns oldest first each part capped at 1000', async () => {
  const { event, body } = await chatReportFixture()
  const earlier = storedEvents().find(turn => turn.sequence === 4)!
  earlier.data.player_input = 'p'.repeat(1100); earlier.data.ai_response = 'r'.repeat(1200)
  // Deliberately insert out of order, with another save and a future turn.
  rows('events').reverse()
  rows('events').push({ ...clone(event) as unknown as Row, _id: new ObjectId(), instance_id: new ObjectId(), sequence: 5.5,
    data: { player_input: 'FOREIGN_INPUT', ai_response: 'FOREIGN_RESPONSE' } },
  { ...clone(event) as unknown as Row, _id: new ObjectId(), sequence: 7, data: { player_input: 'FUTURE', ai_response: 'FUTURE' } })
  await fileChatReport(body)
  assert.equal(get(rows('contentReports')[0], 'target_snapshot.context'),
    `Player: Player turn 3\nResponse: Response turn 3\nPlayer: ${'p'.repeat(1000)}\nResponse: ${'r'.repeat(1000)}\nPlayer: Player turn 5\nResponse: Response turn 5`)
  // No prior turn is also valid.
  rows('contentReports').length = 0; event.sequence = 1
  await fileChatReport(body)
  assert.equal(get(rows('contentReports')[0], 'target_snapshot.context'), '')
})
for (const scenario of ['foreign', 'missing', 'missing save', 'missing template', 'empty', 'whitespace', 'absent response', 'group', 'group marker', 'group state'] as const) {
  await check(`chat report uniform 404 ${scenario}`, async () => {
    const { event, body } = await chatReportFixture()
    if (scenario === 'foreign') rows('worldInstances')[0].player_id = new ObjectId()
    if (scenario === 'missing') body.target_id = String(new ObjectId())
    if (scenario === 'missing save') rows('worldInstances').length = 0
    if (scenario === 'missing template') rows('worldTemplates').length = 0
    if (scenario === 'empty') event.data.ai_response = ''
    if (scenario === 'whitespace') event.data.ai_response = ' \n\t '
    if (scenario === 'absent response') delete (event.data as Partial<typeof event.data>).ai_response
    if (scenario === 'group') rows('worldTemplates')[0].kind = 'group'
    if (scenario === 'group marker') rows('worldInstances')[0].group_template_id = template._id
    if (scenario === 'group state') rows('worldInstances')[0].group_state = {}
    const response = await chatReportHttp('/moderation/reports', 'POST', body)
    assert.equal(response.status, 404)
    assert.deepEqual(await response.json(), { message: 'That line could not be found.' })
    assert.equal(rows('contentReports').length, 0)
  })
}
await check('chat report HTTP refuses supplied text character bounds and block type and requires sign in', async () => {
  const { body } = await chatReportFixture()
  for (const patch of [{ character_id: ids[0] }, { text: 'FORGED' }, { details: 'x'.repeat(1001) },
    { target_id: '' }, { reason: 'unknown' }, { reason: 'other', details: '   ' }]) {
    assert.equal((await chatReportHttp('/moderation/reports', 'POST', { ...body, ...patch })).status, 400)
  }
  assert.equal((await chatReportHttp('/moderation/blocks', 'POST', { target_type: 'chat_line', target_id: body.target_id })).status, 400)
  routeUser = null
  assert.equal((await chatReportHttp('/moderation/reports', 'POST', body)).status, 401)
})
await check('chat report duplicate missing line key finds same turn open and reviewing', async () => {
  const { body } = await chatReportFixture()
  const first = await fileChatReport(body)
  const earlier = storedEvents()[1]
  const other = await fileChatReport({ ...body, target_id: String(earlier._id) })
  assert.notEqual(first.report_id, other.report_id)
  for (const status of ['open', 'reviewing']) {
    rows('contentReports')[0].status = status
    assert.deepEqual(await fileChatReport(body), { ...first, duplicate: true })
    assert.equal(rows('contentReports').length, 2)
  }
  rows('contentReports')[0].status = 'dismissed'
  const fresh = await fileChatReport(body)
  assert.equal(fresh.duplicate, false); assert.notEqual(fresh.report_id, first.report_id)
})
await check('chat report critical reasons and admin filter preserve evidence without creator output', async () => {
  for (const reason of ['sexual_content_involving_minors', 'non_consensual_sexual_content', 'self_harm']) {
    const { body } = await chatReportFixture()
    const result = await fileChatReport({ ...body, reason })
    assert.equal(rows('contentReports')[0].is_critical, true)
    // Old or malformed attribution cannot expose a creator in the admin detail.
    rows('contentReports')[0].target_creator_id = new ObjectId(playerId)
    const detail = await chatReportHttp(`/admin/reports/${result.report_id}`)
    assert.equal(detail.status, 200)
    const data = await detail.json() as Row
    assert.equal(data.creator, null)
    assert(!('target_creator_id' in (data.report as Row)))
    assert.equal(get(data, 'report.priority'), 'CRITICAL')
    assert.deepEqual(get(data, 'report.target_snapshot'), rows('contentReports')[0].target_snapshot)
    assert(!JSON.stringify(data).includes('creator_username'))
    rows('contentReports').push({ ...clone(rows('contentReports')[0]), _id: new ObjectId(), target_type: 'world' })
    const queue = await chatReportHttp('/admin/reports?target_type=chat_line')
    assert.equal(queue.status, 200)
    const listed = await queue.json() as { total: number; items: Row[] }
    assert.equal(listed.total, 1); assert.equal(listed.items.length, 1)
    assert(!('target_creator_id' in listed.items[0])); assert.equal(listed.items[0].target_type, 'chat_line')
  }
})
await check('chat report resolve refuses every content action even with creator and allows both none statuses', async () => {
  const { body } = await chatReportFixture()
  const result = await fileChatReport(body)
  rows('contentReports')[0].target_creator_id = new ObjectId(playerId)
  for (const action of ['content_hidden', 'content_unpublished', 'content_deleted', 'creator_banned']) {
    const response = await chatReportHttp(`/admin/reports/${result.report_id}`, 'PATCH', { action })
    assert.equal(response.status, 400)
    assert.equal(rows('contentReports')[0].status, 'open')
    assert.equal(rows('worldInstances').length, 1)
    assert(!rows('users')[0].account_status)
  }
  for (const status of ['actioned', 'dismissed']) {
    const response = await chatReportHttp(`/admin/reports/${result.report_id}`, 'PATCH', { action: 'none', status })
    assert.equal(response.status, 200)
    assert.equal(rows('contentReports')[0].status, status)
    assert.equal(rows('contentReports')[0].action_taken, 'none')
  }
})
await check('chat report survives real rewind reset and save deletion with unchanged snapshot', async () => {
  mock.module('../src/services/codex-media-carryover', () => ({ snapshotCodexMedia: async () => ({}), restoreCodexMedia: async () => {} }))
  const { characterCodexService } = await import('../src/services/character-codex.service')
  Object.assign(characterCodexService, { applyManualIdentityRevisions: async () => {} })
  const { entityGraphService } = await import('../src/services/entity-graph.service')
  Object.assign(entityGraphService, { repairAfterRewind: async () => {} })
  const { chronicleRoutes } = await import('../src/routes/chronicle.routes')
  for (const action of ['rewind', 'reset', 'delete']) {
    const { event, body } = await chatReportFixture()
    const result = await fileChatReport(body), before = clone(rows('contentReports')[0])
    if (action === 'rewind') {
      const app = new Elysia().use(chronicleRoutes)
      const response = await app.handle(new Request(`http://localhost/chronicle/rewind/${instanceId}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sequence: event.sequence - 1 }),
      }))
      assert.equal(response.status, 200)
    } else if (action === 'reset') await deletionService.resetInstance(instanceId, playerId)
    else await deletionService.deleteInstance(instanceId, playerId)
    assert(!storedEvents().some(turn => turn._id.equals(event._id)))
    assert.deepEqual(rows('contentReports'), [before])
    const response = await chatReportHttp(`/admin/reports/${result.report_id}`)
    assert.equal(response.status, 200)
    assert.deepEqual(get(await response.json() as Row, 'report.target_snapshot'), before.target_snapshot)
  }
})

if (process.env.GROUP_REPORT_MONGO === '1') await check('line report real Mongo migration duplicate path and legacy reports', async () => {
  // The explicit opt-in is confined to a disposable database on the brief's sole allowed port.
  const client = new MongoClient('mongodb://127.0.0.1:27029', { serverSelectionTimeoutMS: 2000 })
  const db = client.db(`everlore_line_report_audit_${crypto.randomUUID().replaceAll('-', '')}`)
  try {
    await client.connect()
    const { EVERLORE_INDEXES, ensureEverloreIndexes } = await import('../src/config/mongo-indexes')
    const reports = db.collection('content_reports')
    await reports.createIndex({ reporter_id: 1, target_type: 1, target_id: 1 }, {
      name: 'uniq_content_reports_open_per_reporter', unique: true,
      partialFilterExpression: { status: { $in: ['open', 'reviewing'] } },
    })
    const { event, input } = await reportFixture()
    const user = new ObjectId()
    rows('users').push({ _id: user, username: 'Legacy target' })
    const legacy = ['world', 'user'].map(target_type => ({ reporter_id: new ObjectId(playerId), target_type,
      target_id: target_type === 'world' ? template._id : user, status: 'open' }))
    await reports.insertMany(legacy)
    await ensureEverloreIndexes(db)
    await ensureEverloreIndexes(db)
    const indexes = await reports.listIndexes().toArray()
    assert(!indexes.some(index => index.name === 'uniq_content_reports_open_per_reporter'))
    const desired = EVERLORE_INDEXES.find(index => index.options?.name === 'uniq_content_reports_open_per_reporter_line')!
    assert.deepEqual(indexes.find(index => index.name === desired.options!.name)!.key, desired.key)
    reportMongoDb = db
    const first = await moderationService.report(input)
    const secondInput = { ...input, characterId: ids[1], text: event.data.lines![1].text }
    const second = await moderationService.report(secondInput)
    assert.equal(first.duplicate, false); assert.equal(second.duplicate, false); assert.notEqual(first.report_id, second.report_id)
    await reports.updateOne({ _id: new ObjectId(first.report_id!) }, { $set: { status: 'reviewing' } })
    assert.deepEqual(await moderationService.report(input), { ...first, duplicate: true })
    assert.deepEqual(await moderationService.report(secondInput), { ...second, duplicate: true })
    for (const target of legacy) {
      const result = await moderationService.report({ reporterId: playerId, targetType: target.target_type as 'world' | 'user',
        targetId: String(target.target_id), reason: 'spam_or_misleading' })
      assert.equal(result.duplicate, true)
      assert(!('target_line' in (await reports.findOne({ _id: new ObjectId(result.report_id!) }))!))
    }
    await moderationService.resolveReport(first.report_id!, { action: 'none', status: 'actioned' })
    assert.equal((await moderationService.report(input)).duplicate, false)
    console.log('PASS real Mongo: old index migrated; repeated startup; two distinct lines; 11000 open/reviewing; legacy world/user duplicates; resolved re-report')
  } finally {
    reportMongoDb = undefined
    await db.dropDatabase()
    await client.close()
  }
})

// Selfies exercise the real request, worker dispatch, portrait resolver, gates,
// projections and purge. The catalog's actual shape is intentional: it has no stats.
const { requestSelfie, requestOwnSelfie } = await import('../src/services/media/selfie')
const { startGroupSelfies, GROUP_OWN_SELFIE_CHANCE } = await import('../worker/lib/group-selfies')
const { checkGroupSelfie } = await import('../worker/lib/group-selfie-check')
const { groupLineId } = await import('../src/services/group-chat/public')
const { visualEffects, processPicture } = await import('../src/services/media/visual')
const { safetyEffects } = await import('../src/services/media/safety')
const { publicMediaEvent, withTurnMedia } = await import('../src/services/media/events')
const { purgeMedia } = await import('../src/services/media/deletion')
const { ProviderRefusalError } = await import('../src/ai/image')
const { mediaEffects, repairMediaReservations } = await import('../src/services/media/service')
const { mediaProcessor } = await import('../worker/processors/media.processor')
let selfieRequests: import('../src/ai/client').LLMRequest[] = []
let selfiePrompts: string[] = [], selfieDownloads: string[] = [], selfieEnqueued: string[] = []
let selfieImageHook: (() => Promise<void>) | undefined, selfieUploadHook: (() => Promise<void>) | undefined
let selfieImageError: Error | undefined, selfieQueueError: Error | undefined
let selfieDescriptionRefusals = 0
let selfiePreReject: false | 'mood' | 'description' = false, selfiePeople = 1, selfieTextVisible = false, selfieEveryday: boolean[] = []
let selfieMood = 'warm and cheerful'
const fixtureDescription = 'A person smiles in a bright room with covered everyday clothing. Warm light softens the illustrated face.'
safetyEffects.call = async request => {
  selfieRequests.push(request)
  if (request.purpose === 'media_selfie_mood') return selfieMood
  if (request.purpose === 'media_selfie_description') return fixtureDescription
  assert.equal(request.purpose, 'media_safety_pre')
  const reject = selfiePreReject === 'mood' ? request.messages[1].content === `An adult person with this expression: ${selfieMood}` : request.messages[1].content === fixtureDescription && (selfiePreReject === 'description' || selfieDescriptionRefusals-- > 0)
  return JSON.stringify({ verdict: reject ? 'reject' : 'allow', reason_code: reject ? 'sexual_act' : 'ok' })
}
safetyEffects.judge = async (_image, _type, _reference, everyday) => {
  selfieEveryday.push(everyday === true)
  return { verdict: 'allow', reason_code: 'ok', people_count: selfiePeople, face_close_up: true, text_visible: selfieTextVisible }
}
visualEffects.enqueue = async (_kind, asset) => { if (selfieQueueError) throw selfieQueueError; selfieEnqueued.push(String(asset._id)); return {} as never }
visualEffects.download = async url => { selfieDownloads.push(url); return storedObjects.get(url.replace('https://fixture.invalid/', '')) ?? fixturePng }
visualEffects.image = async prompt => { selfiePrompts.push(prompt); await selfieImageHook?.(); if (selfieImageError) throw selfieImageError; return { data: fixturePng, contentType: 'image/png', generationId: null } }
visualEffects.upload = async (data, _type, opts) => {
  const key = opts?.key || 'missing-key'
  await selfieUploadHook?.()
  storedObjects.set(key, data)
  return { key, url: `https://fixture.invalid/${key}` }
}
async function selfieFixture(direct = false) {
  const dir = process.env.GROUP_CHAT_DATA_DIR
  assert(dir, 'GROUP_CHAT_DATA_DIR must point at the real catalog')
  const authored = JSON.parse(await readFile(`${dir}/flat-4b.json`, 'utf8'))
  assert(!('base_stats_template' in authored))
  const source = { ...authored, is_published: true, _id: template._id, creator_id: template.creator_id, created_at: new Date(), updated_at: new Date(),
    seed_cast: authored.seed_cast.map((entry: Row, index: number) => ({ ...entry, portrait: { asset_key: `authored/${index}.png`, source: 'authored', appearance_version: 1, painted_at: new Date() } })) } as WorldTemplateDoc
  await start(source)
  selfieVerdict = { position: null }; selfieCheckError = false; selfieCheckGate = undefined; selfieCheckRequests = []; onSelfieCheck = undefined
  storedObjects.clear(); selfieRequests = []; selfiePrompts = []; selfieDownloads = []; selfieEnqueued = []; selfieEveryday = []
  selfieImageHook = undefined; selfieUploadHook = undefined; selfieImageError = undefined; selfieQueueError = undefined
  selfiePreReject = false; selfiePeople = 1; selfieTextVisible = false; selfieMood = 'warm and cheerful'
  process.env.MEDIA_DAILY_PICTURE = '15'
  const opening = storedEvents()[0]
  opening.time_anchor = { real_time: new Date(), sequence: 1, timeline_id: 'main' }
  const characterId = String(rows('characters')[0]._id)
  const second = String(rows('characters')[1]._id)
  const event = { ...clone(opening), _id: new ObjectId(), sequence: 2,
    data: { ...clone(opening.data), model_used: 'fixture-reply', player_input: 'PLAYER_PRIVATE_DIALOGUE', ai_response: 'SPEAKERS_RESPONSE',
      lines: [{ character_id: characterId, text: 'RAW_DIALOGUE_MUST_NOT_REACH_DESCRIPTION', shown_at: new Date() },
        { character_id: second, text: 'Another speaker in the same turn.', shown_at: new Date() }],
      ...(direct ? { dm_with: characterId } : {}) } }
  rows('events').push(event as unknown as Row)
  const line = event.data.lines[0]
  const ask = () => requestSelfie(playerId, instanceId, String(event._id), line)
  return { event, line, ask, characterId, source }
}
async function rewindSelfie(event: import('../src/models/world-event.model').WorldEventDoc) {
  mock.module('../src/services/codex-media-carryover', () => ({ snapshotCodexMedia: async () => ({}), restoreCodexMedia: async () => {} }))
  const { characterCodexService } = await import('../src/services/character-codex.service')
  Object.assign(characterCodexService, { applyManualIdentityRevisions: async () => {} })
  const { entityGraphService } = await import('../src/services/entity-graph.service')
  Object.assign(entityGraphService, { repairAfterRewind: async () => {} })
  const { memoryService } = await import('../src/services/memory.service')
  await memoryService.rewindToSequence(instanceId, playerId, event.sequence)
}
const selfieRun = (id: string) => mediaProcessor({ name: 'picture', data: { mediaId: id, instanceId } } as Job<{ mediaId: string; instanceId: string }>)
const selfieApp = new Elysia().onError(({ error, set }) => { set.status = 'statusCode' in error ? Number(error.statusCode) : 400; return { message: error.message } })
  .use((await import('../src/routes/media.routes')).mediaRoutes)
const selfieHttp = (eventId: string, body: unknown, save = instanceId) => selfieApp.handle(new Request(`http://localhost/instances/${save}/events/${eventId}/selfie`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
}))
await check('selfie access same 404 and authentication on the real route', async () => {
  const { event, line } = await selfieFixture()
  routeUser = { id: playerId, tier: 'creator' }
  const missing = async (body: unknown, eventId = String(event._id), save = instanceId) => {
    const response = await selfieHttp(eventId, body, save)
    assert.equal(response.status, 404); assert.deepEqual(await response.json(), { message: 'That moment could not be found.' })
  }
  await missing({ ...line, text: 'absent' }); await missing({ ...line, character_id: playerId })
  event.data.lines!.push({ character_id: playerId, text: 'Saved player line', shown_at: new Date() })
  await missing({ character_id: playerId, text: 'Saved player line' })
  await missing(line, String(new ObjectId())); await missing(line, String(event._id), String(new ObjectId()))
  event.player_id = new ObjectId(); await missing(line); event.player_id = new ObjectId(playerId)
  const instance = rows('worldInstances')[0]
  const owner = instance.player_id; instance.player_id = new ObjectId(); await missing(line); instance.player_id = owner
  rows('worldTemplates')[0].kind = 'character'; await missing(line); rows('worldTemplates')[0].kind = 'group'
  rows('characters')[0].is_protagonist = true; await missing(line); delete rows('characters')[0].is_protagonist
  const valid = await selfieHttp(String(event._id), { character_id: line.character_id, text: line.text, nsfw_enabled: true })
  assert.equal(valid.status, 202); assert.equal((await valid.json() as Row).status, 'queued')
  routeUser = null
  assert.equal((await selfieHttp(String(event._id), line)).status, 401)
})
await check('selfie slots shared allowance resting and next tap retry', async () => {
  const { event, line, ask } = await selfieFixture()
  process.env.MEDIA_DAILY_PICTURE = '1'
  rows('mediaUsage').push({ _id: new ObjectId(), player_id: new ObjectId(playerId), kind: 'picture', day: new Date().toISOString().slice(0, 10), slot: 0, status: 'settled' })
  routeUser = { id: playerId, tier: 'creator' }
  const response = await selfieHttp(String(event._id), line)
  assert.equal(response.status, 429)
  const rest = await response.json() as Row
  assert.equal(rest.status, 'resting'); assert.equal(rest.kind, 'picture'); assert.equal(typeof rest.resets_at, 'string')
  assert.deepEqual(event.data.group_selfies?.[groupLineId(line)], { status: 'resting', resets_at: rest.resets_at })
  assert.equal(selfieEnqueued.length, 0); assert.equal(rows('mediaAssets').length, 0)
  assert.equal((frames.at(-1)!.selfie as Row).status, 'resting')
  rows('mediaUsage').length = 0
  const result = await ask(); assert.equal(result.status, 'queued')
  assert.equal(rows('mediaUsage').length, 1); assert.equal(rows('mediaUsage')[0].kind, 'picture'); assert.equal(rows('mediaUsage')[0].status, 'reserved')
  await selfieRun(result.media_id)
  assert.equal(rows('mediaUsage')[0].status, 'settled')
})
await check('selfie idempotence one live image per line retries release failures', async () => {
  const { event, ask } = await selfieFixture()
  const results = await Promise.all([ask(), ask()]); assert.equal(results[0].media_id, results[1].media_id)
  assert.equal(selfieEnqueued.length, 1); assert.equal(rows('mediaUsage').length, 1)
  selfieImageError = new Error('fixture provider failure')
  await selfieRun(results[0].media_id)
  assert.equal(rows('mediaUsage')[0].status, 'released'); assert(!('slot' in rows('mediaUsage')[0]))
  assert.equal(event.data.group_selfies?.[groupLineId(event.data.lines![0])]?.status, 'failed')
  assert.equal(frames.at(-1)!.type, 'media_failed')
  selfieImageError = undefined
  const retry = await ask(); assert.notEqual(retry.media_id, results[0].media_id)
  await selfieRun(retry.media_id)
  const again = await ask(); assert.equal(again.status, 'ready'); assert.equal(again.media_id, retry.media_id)
  const slots = rows('mediaUsage').length; await ask(); assert.equal(rows('mediaUsage').length, slots)
  const other = event.data.lines![1]
  const second = await requestSelfie(playerId, instanceId, String(event._id), other)
  assert.notEqual(second.media_id, retry.media_id)
  selfieQueueError = new Error('fixture queue failure')
  event.data.lines!.push({ character_id: other.character_id, text: 'Third saved line', shown_at: new Date() })
  const third = event.data.lines!.at(-1)!
  await assert.rejects(requestSelfie(playerId, instanceId, String(event._id), third), /fixture queue/)
  assert.equal(event.data.group_selfies?.[groupLineId(third)]?.status, 'failed')
  assert.equal(rows('mediaUsage').at(-1)!.status, 'released')
})
await check('selfie heat server toggle both gates single speaker portrait and isolated mood', async () => {
  for (const [enabled, capable] of [[false, true], [true, false], [true, true]]) {
    const { ask, event, source } = await selfieFixture()
    ;(rows('users')[0].preferences as Row).nsfw_enabled = enabled
    rows('worldTemplates')[0].is_nsfw_capable = capable
    const result = await ask(); await selfieRun(result.media_id)
    const mature = enabled && capable
    assert.equal(rows('mediaAssets')[0].status, 'ready')
    assert.equal(selfiePrompts.length, 1)
    assert(selfiePrompts[0].includes(mature ? 'revealing but covered' : 'Everyday, fully clothed, friendly, not flirty'))
    assert(selfiePrompts[0].includes('arm’s length') && selfiePrompts[0].includes('exactly one person') && selfiePrompts[0].includes('never a photograph'))
    assert(selfiePrompts[0].includes('digital painting') && selfiePrompts[0].includes('Semi-realistic'))
    assert(!selfiePrompts[0].includes('anime'))
    assert.deepEqual(selfieEveryday, [!mature])
    const gates = selfieRequests.filter(request => request.purpose === 'media_safety_pre')
    assert.equal(gates.length, 3)
    assert.equal(gates.at(-1)!.messages[0].content.includes('Additional everyday-selfie rule'), !mature)
    const description = selfieRequests.find(request => request.purpose === 'media_selfie_description')!
    const prompt = JSON.stringify(description.messages)
    const described = JSON.parse(description.messages[1].content)
    assert.equal(described.look, source.seed_cast![0].appearance); assert.equal(described.setting, source.global_lore); assert.equal(described.mood, selfieMood)
    assert(!prompt.includes(event.data.lines![0].text)); assert(!prompt.includes(String(event._id))); assert(!prompt.includes(event.data.lines![0].character_id))
    assert.equal(selfieDownloads.length, 1); assert(selfieDownloads[0].endsWith('authored/0.png'))
    assert.equal(rows('mediaAssets')[0].reference_asset_key, 'authored/0.png')
  }
  for (const at of ['image', 'upload'] as const) {
    const { ask, event, line } = await selfieFixture()
    ;(rows('users')[0].preferences as Row).nsfw_enabled = true
    const revoke = async () => { (rows('users')[0].preferences as Row).nsfw_enabled = false }
    if (at === 'image') selfieImageHook = revoke; else selfieUploadHook = revoke
    const result = await ask(); await selfieRun(result.media_id)
    assert.equal(event.data.group_selfies?.[groupLineId(line)]?.status, 'failed')
    assert.equal(rows('mediaUsage')[0].status, 'released'); assert.equal(storedObjects.size, 0)
    assert(!frames.some(frame => frame.type === 'media_ready'))
  }
  const fallback = await selfieFixture()
  delete (rows('worldTemplates')[0].seed_cast as Row[])[0].portrait
  rows('characters')[0].portrait = { asset_key: 'card/face.png', source: 'generated', appearance_version: 1, painted_at: new Date() }
  const result = await fallback.ask(); await selfieRun(result.media_id)
  assert.equal(rows('mediaAssets')[0].status, 'ready')
  assert.equal(selfieDownloads[0], 'https://fixture.invalid/card/face.png')
})
await check('selfie description refused is written again and a refused one is never painted', async () => {
  const { ask } = await selfieFixture()
  selfieDescriptionRefusals = 2
  const result = await ask(); await selfieRun(result.media_id)
  assert.equal(selfieRequests.filter(request => request.purpose === 'media_selfie_description').length, 3)
  assert.equal(rows('mediaAssets')[0].status, 'ready'); assert.equal(selfiePrompts.length, 1)
  selfieDescriptionRefusals = 0
  const again = await selfieFixture()
  selfiePreReject = 'description'
  const refused = await again.ask(); await selfieRun(refused.media_id)
  assert.equal(selfieRequests.filter(request => request.purpose === 'media_selfie_description').length, 3)
  assert.equal(selfiePrompts.length, 0); assert.equal(rows('mediaAssets')[0].status, 'unseen')
})

await check('selfie mood refused is left out and the picture still comes', async () => {
  const { ask } = await selfieFixture()
  selfiePreReject = 'mood'
  const result = await ask(); await selfieRun(result.media_id)
  const gate = selfieRequests.find(request => request.purpose === 'media_safety_pre')!
  assert(gate.messages[1].content.startsWith('An adult person with this expression: '), 'the gate hears the mood as a face')
  const description = selfieRequests.find(request => request.purpose === 'media_selfie_description')!
  assert(!('mood' in JSON.parse(description.messages[1].content)), 'a refused mood never reaches the description')
  assert(!JSON.stringify(description.messages).includes(selfieMood))
  assert.equal(rows('mediaAssets')[0].status, 'ready')
})

await check('selfie safety rejections unseen release retry and no second person or visible text', async () => {
  for (const failure of ['pre', 'people', 'text', 'provider'] as const) {
    const { ask, event, line } = await selfieFixture()
    const result = await ask()
    if (failure === 'pre') selfiePreReject = 'description'
    if (failure === 'people') selfiePeople = 2
    if (failure === 'text') selfieTextVisible = true
    if (failure === 'provider') selfieImageError = new ProviderRefusalError(400, 'content_filter', 'fixture content refusal')
    await selfieRun(result.media_id)
    assert.equal(event.data.group_selfies?.[groupLineId(line)]?.status, 'unseen')
    assert.equal(rows('mediaUsage')[0].status, 'released'); assert.equal(storedObjects.size, 0)
    if (failure === 'pre') assert.equal(selfiePrompts.length, 0)
    const retry = await ask(); assert.notEqual(retry.media_id, result.media_id)
  }
})
await check('selfie privacy history completion projection and writer transcript', async () => {
  const { ask, event, line } = await selfieFixture()
  const result = await ask(); await selfieRun(result.media_id)
  const lineId = groupLineId(line)
  const projected = publicGroupData(await withTurnMedia([clone(event)]))[0]
  assert.equal(projected.data.lines![0].line_id, lineId)
  assert.deepEqual(projected.data.lines![0].selfie, { media_id: result.media_id, status: 'ready', url: (rows('mediaAssets')[0].url) })
  assert(!('group_selfies' in projected.data)); assert.deepEqual((projected.data as unknown as Row).media, [])
  const eventProjection = publicMediaEvent(clone(event))
  assert.equal(eventProjection.data.lines![0].selfie?.status, 'ready'); assert(!('group_selfies' in eventProjection.data))
  const completion = publicGroupData({ type: 'group_turn_complete', data: clone(event.data) })
  assert.equal(completion.data.lines![0].selfie?.media_id, result.media_id)
  const keepsakes = await (await import('../src/services/media/keepsakes')).listKeepsakes(playerId)
  assert.equal(keepsakes.items[0].media_id, result.media_id)
  const publicData = JSON.stringify([projected, eventProjection, completion, keepsakes, frames])
  assert(!publicData.includes(fixtureDescription)); assert(!publicData.includes('media_selfie_description')); assert(!publicData.includes('group_selfies'))
  const transcript = groupMessages([event], playerName, await (await import('../src/services/group-chat/instance')).loadGroupMembers(rows('worldInstances')[0] as never))
  const writerPrompt = buildGroupDynamic({ history: transcript, memories: [], summaries: [], speakers: [], now: new Date(), offsetMinutes: 0 })
  assert(!writerPrompt.includes(fixtureDescription)); assert(!writerPrompt.includes(result.media_id))
})
await check('selfie direct every lifecycle frame stays in its thread', async () => {
  for (const status of ['ready', 'failed', 'unseen'] as const) {
    const { ask, characterId } = await selfieFixture(true)
    const result = await ask()
    if (status === 'failed') selfieImageError = new Error('fixture failure')
    if (status === 'unseen') selfiePeople = 2
    await selfieRun(result.media_id)
    const selfieFrames = frames.filter(frame => frame.media_id === result.media_id || frame.type === 'selfie_started')
    assert.equal(selfieFrames.length, 2)
    for (const frame of selfieFrames) { assert.equal(frame.directWith, characterId); assert.equal(frame.character_id, characterId); assert.equal(typeof frame.line_id, 'string') }
    assert.equal(selfieFrames[1].type, `media_${status}`)
  }
})
await check('selfie rewind jobs fenced before and after upload and edits', async () => {
  for (const at of ['image', 'upload', 'edit'] as const) {
    const { ask, event } = await selfieFixture()
    const result = await ask()
    const erase = async () => {
      if (at === 'edit') event.data.lines![0].text = 'edited source'
      else {
        await rewindSelfie(event)
      }
    }
    if (at === 'upload') selfieUploadHook = erase; else selfieImageHook = erase
    await selfieRun(result.media_id)
    assert.equal(storedObjects.size, 0)
    assert.equal(rows('mediaAssets').length, 0)
    assert.equal(frames.filter(frame => ['media_ready', 'media_unseen', 'media_failed'].includes(String(frame.type))).length, 0)
    assert(!rows('mediaUsage').some(row => row.status === 'reserved'))
  }
})
await check('selfie edit purge clears ready and resting state with the surviving event', async () => {
  for (const resting of [false, true]) {
    const { ask, event } = await selfieFixture()
    if (resting) { process.env.MEDIA_DAILY_PICTURE = '0'; await assert.rejects(ask(), reportError(429)) }
    else { const result = await ask(); await selfieRun(result.media_id) }
    assert(event.data.group_selfies)
    await purgeMedia({ event_id: event._id })
    assert(!('group_selfies' in event.data))
    assert.equal(storedObjects.size, 0)
  }
})
await check('selfie repair failed state releases reservation and remains retryable', async () => {
  const { ask, event, line } = await selfieFixture(true)
  const first = await ask()
  rows('mediaAssets')[0].created_at = new Date(Date.now() - 600000)
  await repairMediaReservations()
  assert.equal(event.data.group_selfies?.[groupLineId(line)]?.status, 'failed')
  assert.equal(frames.at(-1)!.directWith, line.character_id)
  assert.equal(rows('mediaUsage')[0].status, 'released')
  assert.notEqual((await ask()).media_id, first.media_id)
})
await check('selfie reports ownership snapshot no creator action none and HTTP shape', async () => {
  const { ask, event, line } = await selfieFixture(true)
  const result = await ask(); await selfieRun(result.media_id)
  const input = { reporterId: playerId, targetType: 'group_selfie' as const, targetId: result.media_id, reason: 'harassment_or_hate' as const }
  await assert.rejects(moderationService.report({ ...input, reporterId: String(new ObjectId()) }), reportError(404, 'That line could not be found.'))
  await assert.rejects(moderationService.report({ ...input, targetId: String(event._id) }), reportError(404))
  await assert.rejects(moderationService.report({ ...input, characterId: line.character_id }), reportError(400))
  const first = await moderationService.report(input)
  assert.equal((await moderationService.report(input)).report_id, first.report_id)
  const report = rows('contentReports')[0]
  assert(!('target_creator_id' in report)); assert(!('target_line' in report))
  const snap = report.target_snapshot as Row
  assert.equal(snap.description, line.text); assert.equal(snap.thread, 'direct'); assert.equal(snap.title, rows('worldTemplates')[0].title)
  assert.equal(snap.speaker, rows('characters')[0].canonical_name)
  assert(String(snap.image_url).includes('/moderation/selfies/'))
  assert(!String(snap.context).includes(storedEvents()[0].data.lines![0].text))
  for (const action of ['creator_banned', 'content_deleted', 'content_hidden', 'content_unpublished'] as const) await assert.rejects(moderationService.resolveReport(first.report_id!, { action }), reportError(400))
  await moderationService.resolveReport(first.report_id!, { action: 'none', status: 'actioned' })
  const { CreateReportBody, AdminReportQuery } = await import('../src/schemas/moderation.schema')
  const app = new Elysia().post('/report', ({ body }) => body, { body: CreateReportBody }).get('/queue', ({ query }) => query, { query: AdminReportQuery })
  const body = { target_type: 'group_selfie', target_id: result.media_id, reason: input.reason }
  const send = (value: unknown) => app.handle(new Request('http://localhost/report', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) }))
  assert.equal((await send(body)).status, 200)
  assert.notEqual((await send({ ...body, text: line.text })).status, 200)
  assert.notEqual((await send({ ...body, character_id: line.character_id })).status, 200)
  assert.equal((await app.handle(new Request('http://localhost/queue?target_type=group_selfie'))).status, 200)
})
await check('selfie retention evidence survives rewind reset save and account deletion', async () => {
  for (const scope of ['rewind', 'reset', 'save', 'account'] as const) {
    const { ask, event } = await selfieFixture()
    const result = await ask(); await selfieRun(result.media_id)
    const input = { reporterId: playerId, targetType: 'group_selfie' as const, targetId: result.media_id, reason: 'harassment_or_hate' as const }
    const filed = await moderationService.report(input)
    const evidenceUrl = String((rows('contentReports')[0].target_snapshot as Row).image_url)
    const evidenceKey = evidenceUrl.replace('https://fixture.invalid/', '')
    const sourceKey = String(rows('mediaAssets')[0].asset_key)
    if (scope === 'rewind') await rewindSelfie(event)
    else if (scope === 'reset') await deletionService.resetInstance(instanceId, playerId)
    else if (scope === 'save') await deletionService.deleteInstance(instanceId, playerId)
    else await deletionService.deleteAccount(playerId)
    assert(!storedEvents().some(turn => turn._id.equals(event._id)))
    assert(!storedObjects.has(sourceKey)); assert(storedObjects.has(evidenceKey))
    assert.equal((await moderationService.getReport(filed.report_id!)).report.target_snapshot.image_url, evidenceUrl)
  }
})

await check('selfie-auto frames saved lines use exact identities and whitelist', async () => {
  const { source } = await selfieFixture()
  const cast = source.seed_cast!
  eventInsertedHook = row => {
    const data = row.data as Row
    const saved = data.lines as Array<{ character_id: string; text: string }>
    data.group_selfies = Object.fromEntries(saved.map((line, index) => [groupLineId(line), {
      status: index ? 'resting' : 'ready', media_id: 'fixture-media', url: 'fixture-url', resets_at: 'fixture-reset', description: 'PRIVATE',
    }]))
  }
  modelReplies = [`${cast[0].name}: A fresh greeting.\n${cast[1].name}: A second fresh greeting.`]
  try { await turn({ userMessage: `@${cast[0].name} @${cast[1].name} hello` }, never) }
  finally { eventInsertedHook = undefined }
  await Promise.all(backgroundWork.splice(0))
  const saved = storedEvents().at(-1)!
  const shown = frames.filter(frame => frame.type === 'group_lines').at(-1)!.lines as Row[]
  const complete = get(frames.find(frame => frame.type === 'generation_complete')!, 'event.lines') as Row[]
  assert.equal(shown.length, 2)
  for (let index = 0; index < shown.length; index++) {
    assert.equal(shown[index].line_id, groupLineId(saved.data.lines![index]))
    assert.equal(complete[index].line_id, shown[index].line_id)
    assert.deepEqual(Object.keys(shown[index]).sort(), ['characterId', 'line_id', 'name', 'selfie', 'shownAt', 'text'])
    assert.deepEqual(Object.keys(complete[index]).sort(), ['character_id', 'line_id', 'selfie', 'shown_at', 'text'])
    const expected = { status: index ? 'resting' : 'ready', media_id: 'fixture-media', ...(index ? { resets_at: 'fixture-reset' } : { url: 'fixture-url' }) }
    assert.deepEqual(shown[index].selfie, expected); assert.deepEqual(complete[index].selfie, expected)
  }
  // Exercise the same worker projection with a saved ready/resting state.
  for (const status of ['ready', 'resting'] as const) {
    const projected = publicGroupData({ lines: saved.data.lines, group_selfies: {
      [groupLineId(saved.data.lines![0])]: { status, media_id: 'fixture-media', url: 'fixture-url', resets_at: 'fixture-reset', description: 'PRIVATE' },
    } })
    assert.deepEqual(projected.lines![0].selfie, { status, media_id: 'fixture-media', ...(status === 'ready' ? { url: 'fixture-url' } : { resets_at: 'fixture-reset' }) })
    assert(!JSON.stringify(projected).includes('PRIVATE'))
  }
})

await check('selfie-auto agreement published first and mapped to right speaker and thread', async () => {
  for (const direct of [false, true]) {
    const { source, characterId } = await selfieFixture(direct)
    const cast = source.seed_cast!
    let release!: () => void
    selfieCheckGate = new Promise<void>(resolve => { release = resolve })
    selfieVerdict = { position: direct ? 1 : 2 }
    onSelfieCheck = () => {
      assert(frames.some(frame => frame.type === 'generation_complete'))
      assert(storedEvents().some(event => event.sequence === 3))
    }
    modelReplies = [direct ? `${cast[0].name}: Yes, sending you my picture now.`
      : `${cast[0].name}: Let me look.\n${cast[1].name}: Yes, sending my selfie now.\n${cast[0].name}: Waiting by my phone.`]
    let deadline: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        turn({ userMessage: direct ? 'Send me your picture?' : `@${cast[0].name} @${cast[1].name} send me your picture?`, ...(direct ? { directWith: characterId } : {}) }, never, undefined, () => 0),
        new Promise<never>((_resolve, reject) => { deadline = setTimeout(() => reject(new Error('Reply waited for the picture check')), 2000) }),
      ])
    } finally { clearTimeout(deadline) }
    assert.equal(selfieEnqueued.length, 0, 'the completed reply does not wait for the held check')
    assert.equal(selfieCheckRequests.length, 1)
    const request = selfieCheckRequests[0]
    assert.equal(request.max_tokens, 32)
    assert.equal(request.model, 'fake-router')
    assert.deepEqual(request.provider, { sort: 'throughput', order: ['fixture'], only: ['fixture'], allow_fallbacks: false, require_parameters: true })
    const payload = JSON.parse((request.messages as Row[])[1].content as string)
    assert.deepEqual(Object.keys(payload).sort(), ['lines', 'player'])
    assert(payload.lines.every((line: Row, index: number) => line.position === index + 1 && Object.keys(line).sort().join() === 'position,text'))
    assert(!JSON.stringify(payload).includes(instanceId)); assert(!JSON.stringify(payload).includes(characterId))
    release(); await Promise.all(backgroundWork.splice(0)); onSelfieCheck = undefined
    assert.equal(selfieEnqueued.length, 1, 'an agreement suppresses even a winning own-initiative roll')
    const saved = storedEvents().at(-1)!, selected = saved.data.lines![direct ? 0 : 1]
    const started = frames.find(frame => frame.type === 'selfie_started')!
    assert.equal(started.character_id, selected.character_id); assert.equal(started.line_id, groupLineId(selected))
    assert.equal(started.directWith, direct ? characterId : undefined)
    assert.equal(started.eventId, String(saved._id))
  }
})

await check('selfie-auto no invalid position and failed check start nothing and complete turn', async () => {
  for (const verdict of [{ position: null }, { position: 0 }, { position: 2 }, { position: 1.5 }, { position: '1' }, { position: 1, id: ids[0] }, { character_id: ids[0] }, 'error']) {
    const { source } = await selfieFixture()
    selfieCheckError = verdict === 'error'; selfieVerdict = verdict
    modelReplies = [`${source.seed_cast![0].name}: No, perhaps another day.`]
    await turn({ userMessage: `@${source.seed_cast![0].name} send a picture?` }, never, undefined, verdict && typeof verdict === 'object' && verdict.position === null ? never : () => 0)
    await Promise.all(backgroundWork.splice(0))
    assert(frames.some(frame => frame.type === 'generation_complete'))
    assert.equal(selfieEnqueued.length, 0); assert.equal(rows('mediaUsage').length, 0)
    if (verdict !== selfieVerdict || typeof verdict !== 'object' || !('position' in verdict) || verdict.position !== null) {
      assert(memoryLogs.some(log => log.name === 'group.selfie_start_failed'))
    }
  }
  // Semantic quality is measured later; here the real call's strict parser is exercised.
  for (const position of [-1, 0, 2, 1.25, '1', null]) {
    selfieVerdict = { position }; selfieCheckError = false
    if (position === null) assert.equal(await checkGroupSelfie('a request', ['a reply']), null)
    else await assert.rejects(checkGroupSelfie('a request', ['a reply']))
  }
})

await check('selfie-auto own chance last speaker reference and origins are deterministic', async () => {
  assert.equal(GROUP_OWN_SELFIE_CHANCE, 1 / 25)
  for (const direct of [false, true]) {
    for (const origin of ['player', 'unprompted', 'catchup'] as const) {
      const { event, line } = await selfieFixture(direct)
      if (direct) event.data.lines = [line]
      event.data.origin = origin
      await startGroupSelfies(event, { rng: () => GROUP_OWN_SELFIE_CHANCE })
      assert.equal(selfieEnqueued.length, 0)
      await startGroupSelfies(event, { rng: () => 0 })
      assert.equal(selfieEnqueued.length, 1)
      const selected = event.data.lines.at(-1)!
      assert.equal(frames.at(-1)!.character_id, selected.character_id)
      assert.equal(frames.at(-1)!.directWith, direct ? line.character_id : undefined)
      assert.equal(selfieCheckRequests.length, origin === 'player' ? 2 : 0)
    }
  }
  const { event } = await selfieFixture()
  for (const entry of rows('worldTemplates')[0].seed_cast as Row[]) delete entry.portrait
  for (const card of rows('characters')) delete card.portrait
  await startGroupSelfies(event, { rng: () => 0 })
  assert.equal(selfieEnqueued.length, 0); assert.equal(rows('mediaAssets').length, 0); assert.equal(rows('mediaUsage').length, 0)
})

await check('selfie-auto own daily cap across chats concurrent failures rewind and media day', async () => {
  const { event, line } = await selfieFixture()
  const now = new Date()
  const other = { ...clone(rows('worldInstances')[0]), _id: new ObjectId() }
  rows('worldInstances').push(other)
  rows('characters').push(...rows('characters').filter(card => String(card.instance_id) === instanceId).map(card => ({ ...clone(card), instance_id: other._id })))
  const attempts = Array.from({ length: 8 }, (_, index) => {
    const saved = { ...clone(event), _id: new ObjectId(), instance_id: index % 2 ? other._id : event.instance_id,
      data: { ...clone(event.data), lines: [{ ...line, text: `Own attempt ${index}` }] } }
    rows('events').push(saved as unknown as Row)
    return saved
  })
  // All contend for the same two deterministic daily _ids, in different saves.
  const result = await Promise.all(attempts.map(saved => requestOwnSelfie(playerId, String(saved.instance_id), String(saved._id), saved.data.lines[0], now)))
  const started = result.filter((entry): entry is NonNullable<typeof entry> => !!entry)
  assert.equal(started.length, 2); assert.equal(selfieEnqueued.length, 2)
  assert.equal(rows('mediaUsage').filter(row => row.status === 'reserved').length, 2)
  assert.equal(rows('mediaUsage').filter(row => row.status === 'released').length, 2)
  selfieImageError = new Error('fixture provider unavailable')
  for (const entry of started) await selfieRun(entry.media_id)
  assert.equal(rows('mediaUsage').filter(row => row.status === 'reserved').length, 0)
  const before = rows('mediaUsage').length, framesBefore = frames.length
  assert.equal(await requestOwnSelfie(playerId, instanceId, String(event._id), line, now), undefined)
  assert.equal(rows('mediaUsage').length, before); assert.equal(frames.length, framesBefore)
  await purgeMedia({ event_id: { $in: attempts.map(saved => saved._id) } })
  assert.equal(await requestOwnSelfie(playerId, instanceId, String(event._id), line, now), undefined)
  const tomorrow = new Date(now.getTime() + 86_400_000)
  assert(await requestOwnSelfie(playerId, instanceId, String(event._id), line, tomorrow))
  assert.equal(rows('mediaUsage').filter(row => row.day === tomorrow.toISOString().slice(0, 10)).length, 2)
})

await check('selfie-auto own last three protected under concurrency and no state at limits', async () => {
  for (const remaining of [0, 1, 2, 3, 4, 5]) {
    const { event, line } = await selfieFixture()
    const day = new Date().toISOString().slice(0, 10)
    for (let slot = 0; slot < 15 - remaining; slot++) rows('mediaUsage').push({ _id: new ObjectId(), player_id: new ObjectId(playerId), kind: 'picture', day, slot, status: 'settled', created_at: new Date() })
    const attempts = Array.from({ length: 3 }, (_, index) => {
      const saved = { ...clone(event), _id: new ObjectId(), data: { ...clone(event.data), lines: [{ ...line, text: `Limited attempt ${index}` }] } }
      rows('events').push(saved as unknown as Row); return saved
    })
    const result = await Promise.all(attempts.map(saved => requestOwnSelfie(playerId, instanceId, String(saved._id), saved.data.lines[0])))
    assert(result.filter(Boolean).length <= Math.max(0, remaining - 3))
    const live = rows('mediaUsage').filter(row => row.slot !== undefined)
    assert(live.length <= Math.max(12, 15 - remaining))
    if (remaining <= 3) {
      assert.equal(rows('mediaUsage').length, 15 - remaining); assert.equal(rows('mediaAssets').length, 0)
      assert.equal(frames.filter(frame => frame.type === 'selfie_started').length, 0)
      assert(attempts.every(saved => !storedEvents().find(row => row._id.equals(saved._id))?.data.group_selfies))
    }
  }
  const scarce = await selfieFixture()
  process.env.MEDIA_DAILY_PICTURE = '3'
  assert.equal(await requestOwnSelfie(playerId, instanceId, String(scarce.event._id), scarce.line), undefined)
  assert.equal(rows('mediaUsage').length, 0); assert.equal(rows('mediaAssets').length, 0)
  // A lone eligible reply with exactly four remaining starts and leaves three.
  const { event, line } = await selfieFixture()
  process.env.MEDIA_DAILY_PICTURE = '4'
  assert(await requestOwnSelfie(playerId, instanceId, String(event._id), line))
  assert.equal(rows('mediaUsage').filter(row => row.slot !== undefined).length, 1)
  assert.equal(rows('mediaUsage').length, 2, 'temporary guards are removed')
  process.env.MEDIA_DAILY_PICTURE = '15'
  const repaired = await selfieFixture()
  mediaUsageInsertedHook = async row => {
    if (!row.event_id) return
    // Race the orphan repair sweep against a reservation bundle.
    for (const guard of rows('mediaUsage').filter(entry => entry.status === 'reserved' && !entry.event_id)) {
      guard.status = 'released'; delete guard.slot
    }
  }
  try { assert.equal(await requestOwnSelfie(playerId, instanceId, String(repaired.event._id), repaired.line), undefined) }
  finally { mediaUsageInsertedHook = undefined }
  assert.equal(rows('mediaAssets').length, 0); assert.equal(rows('mediaUsage').length, 0)
})

await check('selfie-auto resting agreement leaves words and turn complete', async () => {
  const { source } = await selfieFixture()
  process.env.MEDIA_DAILY_PICTURE = '0'; selfieVerdict = { position: 1 }
  modelReplies = [`${source.seed_cast![0].name}: Yes, sending my picture now.`]
  await turn({ userMessage: `@${source.seed_cast![0].name} send a picture?` }, never, undefined, () => 0); await Promise.all(backgroundWork.splice(0))
  const saved = storedEvents().at(-1)!, selected = saved.data.lines![0]
  assert.equal(selected.text, 'Yes, sending my picture now.')
  assert(frames.some(frame => frame.type === 'generation_complete'))
  assert.equal(saved.data.group_selfies?.[groupLineId(selected)].status, 'resting')
  assert.equal((frames.at(-1)!.selfie as Row).status, 'resting'); assert.equal(selfieEnqueued.length, 0)
  assert(!memoryLogs.some(log => log.name === 'group.selfie_start_failed'))
  process.env.MEDIA_DAILY_PICTURE = '15'
})

await check('selfie-auto painted prompt ignores romcom narrative render on real catalog', async () => {
  const { source, ask } = await selfieFixture()
  assert.equal(source.narrative_style, 'romcom')
  const result = await ask(); await selfieRun(result.media_id)
  assert.equal(selfiePrompts.length, 1)
  assert(selfiePrompts[0].includes('digital painting') && selfiePrompts[0].includes('Semi-realistic'))
  assert(selfiePrompts[0].includes('Match the reference portrait exactly'))
  assert(selfiePrompts[0].includes('illustration, never a photograph'))
  assert(!selfiePrompts[0].includes('anime'))
  assert(!selfiePrompts[0].includes(source.title))
})

await check('selfie-auto memory ready private audience prompt rewind and curation unchanged', async () => {
  for (const direct of [false, true]) {
    const { event, line, ask, characterId, source } = await selfieFixture(direct)
    const currentMembers = await (await import('../src/services/group-chat/instance')).loadGroupMembers(rows('worldInstances')[0] as unknown as WorldInstanceDoc)
    const result = await ask()
    const transcript = () => groupMessages(storedEvents(), playerName, currentMembers, direct ? characterId : undefined, undefined, true)
    assert(!JSON.stringify(transcript()).includes('sent a picture of themselves'))
    await selfieRun(result.media_id)
    const note = `${source.seed_cast![0].name} sent a picture of themselves ${direct ? `to ${playerName} in this private chat` : 'to the group'}.`
    assert(transcript().some(message => message.text === note))
    assert(!JSON.stringify(transcript()).includes(fixtureDescription))
    assert(!groupMessages(storedEvents(), playerName, currentMembers, direct ? characterId : undefined).some(message => message.text === note), 'curation uses its existing transcript')
    if (direct) assert(!JSON.stringify(groupMessages(storedEvents(), playerName, currentMembers, undefined, undefined, true)).includes('sent a picture of themselves'))
    modelReplies = [`${source.seed_cast![0].name}: A fresh reaction.`]
    await turn({ userMessage: `@${source.seed_cast![0].name} hello again`, ...(direct ? { directWith: characterId } : {}) }, never); await Promise.all(backgroundWork.splice(0))
    assert(requestText(writerCalls.at(-1)!).includes(note))
    assert(!requestText(writerCalls.at(-1)!).includes(fixtureDescription))
    if (direct) {
      ;(rows('users')[0].preferences as Row).nsfw_enabled = true
      for (const tame of ['members', 'single'] as const) {
        if (tame === 'members') event.data.tame_members = [characterId]
        else { delete event.data.tame_members; event.data.tame = true; auditEnv.NSFW_SAME_TURN_ROUTER = 'on' }
        writerCalls = []; modelReplies = [`${source.seed_cast![0].name}: Another warm reaction ${tame}.`]
        await turn({ userMessage: 'Come closer to me', directWith: characterId }, never); await Promise.all(backgroundWork.splice(0))
        assert(writerCalls.some(request => requestText(request).includes(note)), `sent-picture note survives ${tame} prose filtering`)
      }
      auditEnv.NSFW_SAME_TURN_ROUTER = 'off'
      writerCalls = []; modelReplies = [`${source.seed_cast![0].name}: A room reply.`]
      await turn({ userMessage: `@${source.seed_cast![0].name} hello room` }, never); await Promise.all(backgroundWork.splice(0))
      assert(!writerCalls.some(request => requestText(request).includes('sent a picture of themselves')))
    }
    await rewindSelfie(event)
    assert(!transcript().some(message => message.text === note))
    assert(!storedEvents().some(saved => saved._id.equals(event._id)))
    assert.equal(line.character_id, characterId)
  }
})

/** Written lines the catalog has to carry, shaped exactly like the real members. */
function writtenIdeas(name: string) {
  return {
    first_texts: [`Hey, it's ${name}.`, `Are you around later?`, `${name} here, got a minute?`],
    statuses: { morning: `${name} is up early with coffee.`, afternoon: `${name} is out running errands.`,
      evening: `${name} is home and winding down.`, night: `${name} is in bed with the phone.` },
  }
}

/** The real catalog shape — no base_stats_template — with the written lines the
 *  orchestrator is adding to the three authored worlds. */
async function ideasSource(file = 'flat-4b.json'): Promise<WorldTemplateDoc> {
  const dir = process.env.GROUP_CHAT_DATA_DIR
  assert(dir, 'GROUP_CHAT_DATA_DIR must point at the real catalog')
  const authored = JSON.parse(await readFile(`${dir}/${file}`, 'utf8'))
  assert(!('base_stats_template' in authored), 'the fixture must have the real catalog shape')
  return { ...authored, is_published: true, _id: template._id, creator_id: template.creator_id,
    created_at: new Date(), updated_at: new Date(),
    seed_cast: authored.seed_cast.map((entry: Row) => ({ ...entry, ...writtenIdeas(String(entry.name)) })) } as WorldTemplateDoc
}

/** The save's cast with the ids the instance's cards actually got. */
function ideaCast() {
  const snapshot = rows('worldInstances')[0].seed_cast_snapshot as Row[]
  const cards = rows('characters') as Row[]
  return snapshot.map(entry => {
    const card = cards.find(card => String(card.canonical_name).toLowerCase() === String(entry.name).toLowerCase())!
    return { id: String(card._id), name: String(entry.name), first_texts: entry.first_texts as string[], statuses: entry.statuses as Row }
  })
}

/** A fresh catalogue-shaped save with the written lines, and no selfie agreement
 *  left over from an earlier check. */
async function ideasStart(file?: string) {
  selfieVerdict = { position: null }; selfieCheckError = false
  await start(await ideasSource(file))
}

async function ideasTurn(input: { line: string; ideas?: string; data?: Row; ideasReplies?: Array<string | Error>; speaker?: number }) {
  const cast = ideaCast()
  const speaker = cast[input.speaker ?? 0]
  modelReplies = [`${speaker.name}: ${input.line}`]
  ideaReplies = input.ideasReplies ?? (input.ideas ? [JSON.stringify({ ideas: [input.ideas] })] : [])
  await turn(input.data ?? { userMessage: `@${speaker.name} hello` }, never)
  await Promise.all(backgroundWork.splice(0))
  return storedEvents().at(-1)!
}

await check('ideas start after the selfie check and never hold the completion', async () => {
  await ideasStart()
  const cast = ideaCast()
  selfieCheckRequests.length = 0; selfieVerdict = { position: 1 }
  let release!: () => void
  ideaGate = new Promise<void>(resolve => { release = resolve })
  let atCall: { complete: boolean; checks: number } | undefined
  onIdeaCall = () => { atCall = { complete: frames.some(frame => frame.type === 'generation_complete'), checks: selfieCheckRequests.length } }
  ideaReplies = [JSON.stringify({ ideas: ['Ask how her day went.', 'Send a photo back.', 'Say goodnight.'] })]
  modelReplies = [`${cast[0].name}: Yes, sending you my picture now.`]
  let deadline: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([turn({ userMessage: `@${cast[0].name} send me your picture?` }, never, undefined, () => 0),
      new Promise<never>((_resolve, reject) => { deadline = setTimeout(() => reject(new Error('the reply waited for the ideas call')), 2000) })])
  } finally { clearTimeout(deadline) }
  assert(atCall?.complete, 'the completion frame must be out before the ideas call')
  assert.equal(atCall?.checks, 1, 'the selfie check must be started before the ideas call')
  assert.equal(ideaCalls.length, 1)
  release(); await Promise.all(backgroundWork.splice(0)); onIdeaCall = undefined; ideaGate = undefined
  const saved = storedEvents().at(-1)!
  assert.deepEqual(saved.data.reply_ideas, ['Ask how her day went.', 'Send a photo back.', 'Say goodnight.'])
  const frame = frames.filter(row => row.type === 'group_ideas').at(-1)!
  assert.deepEqual(Object.keys(frame).sort(), ['eventId', 'ideas', 'instanceId', 'type'])
  assert.equal(frame.eventId, String(saved._id)); assert.equal(frame.instanceId, instanceId)
})

await check('ideas writer route follows the turn and never reaches adult with the toggle off', async () => {
  const source = await ideasSource()
  selfieVerdict = { position: null }
  await start(source)
  const cast = ideaCast()
  rows('events').push(...[2, 3].map(sequence => ({ ...clone(rows('events')[0]), _id: new ObjectId(), sequence, type: 'intimate' })))
  await ideasTurn({ line: 'A plain reply.', ideas: 'A plain idea.' , data: { userMessage: `@${cast[0].name} hello` } })
  assert.equal(ideaCalls.length, 1)
  assert.equal(ideaCalls[0].purpose, 'group_reply_ideas')
  assert.equal(ideaCalls[0].model, 'fake-safe')
  assert.equal(ideaCalls[0].maxTokens, 200)
  assert.equal(ideaCalls[0].timeoutMs, 8000)
  await adultStart(source)
  const adultCast = ideaCast()
  rows('events').push(...[2, 3].map(sequence => ({ ...clone(rows('events')[0]), _id: new ObjectId(), sequence, type: 'intimate' })))
  await ideasTurn({ line: 'An explicit reply.', ideas: 'An explicit idea.', data: { userMessage: `@${adultCast[0].name} keep going` } })
  assert.equal(ideaCalls.at(-1)!.model, 'fake-adult')
  // Consent withdrawn during the turn: the route the turn actually took is normal.
  await adultStart(source)
  const withdrawnCast = ideaCast()
  rows('events').push(...[2, 3].map(sequence => ({ ...clone(rows('events')[0]), _id: new ObjectId(), sequence, type: 'intimate' })))
  writerHook = () => put(rows('users')[0], 'preferences.nsfw_enabled', false)
  modelReplies = [new Error('unavailable'), `${withdrawnCast[0].name}: Normal after withdrawal`]
  ideaReplies = [JSON.stringify({ ideas: ['A withdrawn idea.'] })]
  await turn({ userMessage: `@${withdrawnCast[0].name} keep going` }, () => 0)
  await Promise.all(backgroundWork.splice(0))
  writerHook = undefined
  assert.equal(ideaCalls.at(-1)!.model, 'fake-safe')
})

await check('ideas call carries a schema and no hidden reasoning only for the normal writer', async () => {
  const { buildChatRequest } = await import('../src/ai/client')
  const transport = (request: Row) => buildChatRequest(request as unknown as Parameters<typeof buildChatRequest>[0]).params as Row
  const source = await ideasSource()
  await ideasStart()
  const cast = ideaCast()
  await ideasTurn({ line: 'A plain reply.', ideas: 'A plain idea.', data: { userMessage: `@${cast[0].name} hello` } })
  assert.equal(ideaCalls.length, 1)
  assert.equal(ideaCalls[0].model, 'fake-safe')
  const normal = transport(ideaCalls[0])
  assert.equal(normal.response_format.type, 'json_schema', 'the normal writer must receive the ideas schema')
  assert.equal(normal.response_format.json_schema.name, 'group_reply_ideas')
  assert.equal(normal.response_format.json_schema.strict, true)
  assert.deepEqual(normal.response_format.json_schema.schema, ideaCalls[0].responseSchema)
  assert.deepEqual(normal.reasoning, { enabled: false }, 'the normal writer must not spend the short budget on hidden reasoning')
  await adultStart(source)
  const adultCast = ideaCast()
  rows('events').push(...[2, 3].map(sequence => ({ ...clone(rows('events')[0]), _id: new ObjectId(), sequence, type: 'intimate' })))
  await ideasTurn({ line: 'An explicit reply.', ideas: 'An explicit idea.', data: { userMessage: `@${adultCast[0].name} keep going` } })
  assert.equal(ideaCalls.at(-1)!.model, 'fake-adult')
  const adult = transport(ideaCalls.at(-1)!)
  assert.equal(Object.hasOwn(adult, 'response_format'), false, 'the adult writer refuses a schema')
  assert.equal(Object.hasOwn(adult, 'reasoning'), false, 'the adult writer refuses a reasoning switch')
})

await check('ideas bad writer output is dropped rather than sent', async () => {
  const source = await ideasSource()
  const cases: Array<[string, string[]]> = [
    ['not json', []],
    ['Here you go: {"ideas":["A wrapped idea."]} Enjoy.', ['A wrapped idea.']],
    ['```json\n{"ideas":["A fenced idea."]}\n```', ['A fenced idea.']],
    ['{"ideas":"one"}', []],
    ['{"ideas":[{"text":"An object."}]}', []],
    ['{"ideas":[""]}', []],
    [`{"ideas":["${'x'.repeat(GROUP_IDEA_MAX_CHARS + 1)}"]}`, []],
    [`{"ideas":["${'x'.repeat(GROUP_IDEA_MAX_CHARS)}"]}`, ['x'.repeat(GROUP_IDEA_MAX_CHARS)]],
    ['{"ideas":["Elena: I do."]}', []],
    ['{"ideas":["  Same   idea.  ","same idea.","Another idea."]}', ['Same idea.', 'Another idea.']],
    ['{"ideas":["One idea.","Two idea.","Three idea.","Four idea."]}', ['One idea.', 'Two idea.', 'Three idea.']],
    ['{"ideas":["Hug my sister tight.","A plain line."]}', ['A plain line.']],
  ]
  selfieVerdict = { position: null }
  for (const [reply, expected] of cases) {
    await start(source)
    try { await ideasTurn({ line: 'A plain reply.', ideasReplies: [reply] }) }
    catch (error) { throw new Error(`writer reply for ${JSON.stringify(reply)}: ${String(error)}`) }
    const saved = storedEvents().at(-1)!
    assert.deepEqual(saved.data.reply_ideas, expected.length ? expected : undefined, reply)
    assert.equal('reply_ideas' in saved.data, expected.length > 0, reply)
    assert.equal(frames.filter(row => row.type === 'group_ideas').length, expected.length ? 1 : 0, reply)
  }
})

await check('ideas failure leaves the turn complete and never stops the selfie', async () => {
  const source = await ideasSource()
  await start(source)
  const cast = ideaCast()
  selfieCheckRequests.length = 0
  ideaReplies = [new Error('writer unavailable')]
  modelReplies = [`${cast[0].name}: A plain reply.`]
  const result = await turn({ userMessage: `@${cast[0].name} hello` }, never)
  await Promise.all(backgroundWork.splice(0))
  assert(result.eventId)
  assert(frames.some(frame => frame.type === 'generation_complete'))
  assert(!('reply_ideas' in storedEvents().at(-1)!.data))
  assert(!frames.some(frame => frame.type === 'group_ideas'))
  assert(memoryLogs.some(entry => entry.name === 'group.ideas_call_failed'))
  assert.equal(selfieCheckRequests.length, 1, 'a failing ideas call never stops the selfie start')
  // The other way round: a failing selfie check leaves the ideas saved.
  await start(source)
  const secondCast = ideaCast()
  selfieCheckError = true; selfieVerdict = { position: 1 }
  await ideasTurn({ line: 'A reply beside a failed check.', ideas: 'Still here.', data: { userMessage: `@${secondCast[0].name} picture?` } })
  selfieCheckError = false
  assert.deepEqual(storedEvents().at(-1)!.data.reply_ideas, ['Still here.'])
  assert(memoryLogs.some(entry => entry.name === 'group.selfie_start_failed'))
})

await check('ideas are sent for the newest event of a thread only, never from the chronicle', async () => {
  await ideasStart()
  await ideasTurn({ line: 'First reply.', ideas: 'First idea.' })
  await ideasTurn({ line: 'Second reply.', ideas: 'Second idea.' })
  const loaded = await generationService.loadInstance(instanceId, playerId)
  assert.equal(loaded.recentEvents.at(-1)!.data.reply_ideas![0], 'Second idea.')
  for (const older of loaded.recentEvents.slice(0, -1)) assert(!('reply_ideas' in older.data))
  const sent: Row[] = []
  await playWsService.handleMessage(socket(sent), { action: 'load_instance', instance_id: instanceId })
  const sentEvents = (sent[0].data as Row).recentEvents as Row[]
  assert.equal((sentEvents.at(-1)!.data as Row).reply_ideas![0], 'Second idea.')
  assert(sentEvents.slice(0, -1).every(event => !('reply_ideas' in (event.data as Row))))
  const { memoryService } = await import('../src/services/memory.service')
  const feed = await memoryService.getEvents(instanceId, playerId, {})
  assert(!JSON.stringify(feed).includes('Second idea.') && !JSON.stringify(feed).includes('First idea.'))
})

await check('ideas in a direct thread name their thread and never reach the room', async () => {
  await ideasStart()
  const cast = ideaCast()
  await ideasTurn({ line: 'A private reply.', ideas: 'A private idea.', data: { directWith: cast[0].id, userMessage: 'hello' } })
  const frame = frames.filter(row => row.type === 'group_ideas').at(-1)!
  assert.equal(frame.directWith, cast[0].id)
  const room = await generationService.loadInstance(instanceId, playerId)
  assert(!JSON.stringify(room).includes('A private idea.'))
  assert(!('reply_ideas' in room.recentEvents.at(-1)!.data))
  const thread = await generationService.loadInstance(instanceId, playerId, cast[0].id)
  assert.equal(thread.recentEvents.at(-1)!.data.reply_ideas![0], 'A private idea.')
})

await check('ideas are labelled for usage and an unprompted turn stamps its origin', async () => {
  await ideasStart()
  const cast = ideaCast()
  flushedTraces = []
  await ideasTurn({ line: 'A player-turn reply.', ideas: 'A player idea.', data: { userMessage: `@${cast[0].name} hello` } })
  const playerTrace = flushedTraces.flat()[0]
  assert(playerTrace, 'the ideas call must be traced')
  assert.equal(playerTrace.call.purpose, 'group_reply_ideas')
  assert.equal(playerTrace.call.phase, 'background')
  assert.equal(String(playerTrace.call.instance_id), instanceId)
  assert.equal(playerTrace.call.group_origin, undefined)
  flushedTraces = []
  modelReplies = [`${cast[0].name}: An unprompted reply.`]
  ideaReplies = [JSON.stringify({ ideas: ['An unprompted idea.'] })]
  await turn({ origin: 'unprompted', userMessage: '' }, () => 0)
  await Promise.all(backgroundWork.splice(0))
  const unprompted = flushedTraces.flat()[0]
  assert.equal(unprompted.call.group_origin, 'unprompted')
  assert.equal(unprompted.call.purpose, 'group_reply_ideas')
})

await check('ideas rewind removes them and a rewound event is never recreated', async () => {
  await ideasStart()
  const cast = ideaCast()
  await ideasTurn({ line: 'First reply.', ideas: 'First idea.' })
  // The surviving turn's own anchor, as the other rewind checks set it.
  storedEvents().at(-1)!.time_anchor = { real_time: new Date(), sequence: 2, timeline_id: 'main' }
  let release!: () => void
  ideaGate = new Promise<void>(resolve => { release = resolve })
  modelReplies = [`${cast[0].name}: Second reply.`]
  ideaReplies = [JSON.stringify({ ideas: ['After the rewind.'] })]
  await turn({ userMessage: `@${cast[0].name} again` }, never)
  const held = storedEvents().at(-1)!
  mock.module('../src/services/codex-media-carryover', () => ({ snapshotCodexMedia: async () => ({}), restoreCodexMedia: async () => {} }))
  const { characterCodexService } = await import('../src/services/character-codex.service')
  Object.assign(characterCodexService, { applyManualIdentityRevisions: async () => {} })
  const { entityGraphService } = await import('../src/services/entity-graph.service')
  Object.assign(entityGraphService, { repairAfterRewind: async () => {} })
  const { memoryService } = await import('../src/services/memory.service')
  await memoryService.rewindToSequence(instanceId, playerId, held.sequence)
  release(); await Promise.all(backgroundWork.splice(0)); ideaGate = undefined
  assert(!storedEvents().some(event => event._id.equals(held._id)))
  assert(!frames.some(frame => frame.type === 'group_ideas' && frame.eventId === String(held._id)))
  const loaded = await generationService.loadInstance(instanceId, playerId)
  assert(!JSON.stringify(loaded).includes('After the rewind.'))
  assert.equal(loaded.recentEvents.at(-1)!.data.reply_ideas![0], 'First idea.')
})

await check('ideas writer is given no id at all', async () => {
  await ideasStart()
  const cast = ideaCast()
  const saved = await ideasTurn({ line: 'A plain reply.', ideas: 'A plain idea.' })
  assert.equal(ideaCalls.length, 1)
  const payload = JSON.stringify(ideaCalls[0])
  for (const id of [instanceId, String(saved._id), ...cast.map(member => member.id)]) assert(!payload.includes(id), 'an id reached the ideas writer')
  assert(!/character_id|instanceId|eventId|dm_with|shown_at/.test(payload))
  const body = JSON.parse(String((ideaCalls[0].messages as Row[])[1].content))
  assert.deepEqual(Object.keys(body).sort(), ['messages', 'player'])
  assert(body.messages.every((message: Row) => Object.keys(message).sort().join() === 'from,text'))
})

await check('ideas first texts only on an empty direct thread, gone after the first line and while one is pending', async () => {
  await ideasStart()
  const cast = ideaCast()
  const empty = await generationService.loadInstance(instanceId, playerId, cast[0].id)
  const card = (empty.characters as Row[]).find(card => String(card.canonical_name) === cast[0].name)!
  assert.deepEqual(card.first_texts, cast[0].first_texts)
  const other = (empty.characters as Row[]).find(card => String(card.canonical_name) === cast[1].name)!
  assert.deepEqual(other.first_texts, cast[1].first_texts)
  // The real socket payload carries them through its own projection.
  const sent: Row[] = []
  await playWsService.handleMessage(socket(sent), { action: 'load_instance', instance_id: instanceId, direct_with: cast[0].id })
  const sentCard = ((sent[0].data as Row).characters as Row[]).find(card => String(card.canonical_name) === cast[0].name)!
  assert.deepEqual(sentCard.first_texts, cast[0].first_texts)
  // The room opens seeded, so it is never empty.
  const room = await generationService.loadInstance(instanceId, playerId)
  const roomText = JSON.stringify(room)
  assert(!roomText.includes('first_texts'), roomText.slice(Math.max(0, roomText.indexOf('first_texts') - 300), roomText.indexOf('first_texts') + 100))
  await ideasTurn({ line: 'A first line.', data: { directWith: cast[0].id, userMessage: 'hi' } })
  assert(!JSON.stringify(await generationService.loadInstance(instanceId, playerId, cast[0].id)).includes('first_texts'))
  await ideasStart()
  const pendingCast = ideaCast()
  auditEnv.GROUP_NOTIFICATIONS_ENABLED = true
  put(rows('worldInstances')[0], 'group_state.pending_direct', { member_id: pendingCast[1].id, scheduled_at: new Date(), notified_at: new Date() })
  assert(!JSON.stringify(await generationService.loadInstance(instanceId, playerId, pendingCast[1].id)).includes('first_texts'))
  assert(!JSON.stringify((await generationService.loadInstance(instanceId, playerId, pendingCast[0].id)).instance.seed_cast_snapshot).includes('first_texts'))
  auditEnv.GROUP_NOTIFICATIONS_ENABLED = false
})

await check('ideas status is picked per read from the newest device zone and never stored', async () => {
  const cast = (await ideasSource()).seed_cast!
  const statuses = cast[0].statuses!
  assert.equal(statusPeriod(0, new Date('2026-11-05T04:59:00Z')), 'night')
  assert.equal(statusPeriod(0, new Date('2026-11-05T05:00:00Z')), 'morning')
  assert.equal(statusPeriod(0, new Date('2026-11-05T11:59:00Z')), 'morning')
  assert.equal(statusPeriod(0, new Date('2026-11-05T12:00:00Z')), 'afternoon')
  assert.equal(statusPeriod(0, new Date('2026-11-05T16:59:00Z')), 'afternoon')
  assert.equal(statusPeriod(0, new Date('2026-11-05T17:00:00Z')), 'evening')
  assert.equal(statusPeriod(0, new Date('2026-11-05T21:59:00Z')), 'evening')
  assert.equal(statusPeriod(0, new Date('2026-11-05T22:00:00Z')), 'night')
  // A local day that has already turned over, and one that has not yet begun.
  assert.equal(statusPeriod(300, new Date('2026-11-05T02:00:00Z')), 'morning')
  assert.equal(statusPeriod(-300, new Date('2026-11-05T02:00:00Z')), 'evening')
  assert.equal(pickStatus(statuses, undefined), undefined)
  assert.equal(pickStatus(undefined, 0), undefined)
  await ideasStart()
  const saved = ideaCast()
  const unknown = await generationService.loadInstance(instanceId, playerId)
  assert(!JSON.stringify(unknown.characters).includes('"status"'), 'no status without a known offset')
  await registerPushDevice(playerId, { token: 'ideas-zone', platform: 'android', tz_offset_minutes: 330 }, new Date())
  // The read before opening a chat freshens the zone from the newest device.
  const { listGroupThreads } = await import('../src/services/group-chat/threads')
  await listGroupThreads(instanceId, playerId)
  const loaded = await generationService.loadInstance(instanceId, playerId)
  const card = (loaded.characters as Row[]).find(card => String(card.canonical_name) === saved[0].name)!
  assert.equal(card.status, pickStatus(saved[0].statuses as never, 330))
  assert(!('status' in rows('worldInstances')[0].group_state), 'the picked line is never stored')
  assert(!JSON.stringify(rows('worldInstances')[0].group_state).includes('is up early'))
  // The second projection (the socket payload) keeps it.
  const sent: Row[] = []
  await playWsService.handleMessage(socket(sent), { action: 'load_instance', instance_id: instanceId })
  const sentCard = ((sent[0].data as Row).characters as Row[]).find(card => String(card.canonical_name) === saved[0].name)!
  assert.equal(sentCard.status, card.status)
})

await check('ideas status reaches only that member\'s direct thread prompt', async () => {
  await ideasStart()
  const cast = ideaCast()
  put(rows('worldInstances')[0], 'group_state.tz_offset_minutes', 0)
  await ideasTurn({ line: 'A room reply.', data: { userMessage: `@${cast[0].name} hello` } })
  assert(!content(writerCalls.at(-1)!, 1).includes("'s status right now says"))
  const first = pickStatus(cast[0].statuses as never, 0)!
  await ideasTurn({ line: 'A direct reply.', data: { directWith: cast[0].id, userMessage: 'hello' } })
  const prompt = content(writerCalls.at(-1)!, 1)
  assert(prompt.includes(`${cast[0].name}'s status right now says: "${first}"`))
  assert(!prompt.includes(`${cast[1].name}'s status right now says`))
  assert(!('status' in (storedEvents().at(-1)!.data as Row)), 'the picked status is never written to a turn')
  assert(!('status' in rows('worldInstances')[0].group_state), 'the picked status is never written to the save')
  const second = pickStatus(cast[1].statuses as never, 0)!
  await ideasTurn({ line: 'Another direct reply.', speaker: 1, data: { directWith: cast[1].id, userMessage: 'hello' } })
  const other = content(writerCalls.at(-1)!, 1)
  assert(other.includes(`${cast[1].name}'s status right now says: "${second}"`))
  assert(!other.includes(`${cast[0].name}'s status right now says`))
  // Unknown zone: no status in the prompt either.
  await ideasStart()
  const noZone = ideaCast()
  await ideasTurn({ line: 'A zone-free reply.', data: { directWith: noZone[0].id, userMessage: 'hello' } })
  assert(!content(writerCalls.at(-1)!, 1).includes("'s status right now says"))
})

function assertWrittenMember(member: Row) {
  const name = String(member.name)
  assert(Array.isArray(member.first_texts) && member.first_texts.length === 3, `${name} needs exactly three first texts`)
  for (const text of member.first_texts as unknown[]) {
    assert(typeof text === 'string' && text.trim() && !/[\r\n]/u.test(text) && Array.from(text).length <= GROUP_IDEA_MAX_CHARS, `${name} first text is not one written line`)
  }
  const statuses = member.statuses as Row
  assert(statuses && typeof statuses === 'object' && !Array.isArray(statuses), `${name} needs statuses`)
  assert.deepEqual(Object.keys(statuses).sort(), ['afternoon', 'evening', 'morning', 'night'], `${name} needs all four parts of the day`)
  for (const period of ['morning', 'afternoon', 'evening', 'night']) {
    const text = statuses[period]
    assert(typeof text === 'string' && text.trim() && !/[\r\n]/u.test(text) && Array.from(text).length <= GROUP_IDEA_MAX_CHARS, `${name}'s ${period} status is not one written line`)
  }
}

await check('ideas catalog requires written first texts and statuses on every member of all three worlds', async () => {
  const dir = process.env.GROUP_CHAT_DATA_DIR
  assert(dir, 'GROUP_CHAT_DATA_DIR must point at the real catalog')
  let counted = 0
  for (const file of ['alder-lane-watch.json', 'flat-4b.json', 'last-light-guild.json']) {
    const authored = JSON.parse(await readFile(`${dir}/${file}`, 'utf8'))
    assert(!('base_stats_template' in authored), `${file} must keep the real catalog shape`)
    const fixture = authored
    for (const member of fixture.seed_cast) { assertWrittenMember(member); counted++ }
    const source = { ...groupTemplate(), ...fixture, base_stats_template: undefined } as WorldTemplateDoc
    validateGroup(source)
    validateEntry(fixture, file)
    const first = fixture.seed_cast[0] as Row
    const broken: Row[] = [
      { ...first, first_texts: (first.first_texts as string[]).slice(0, 2) },
      { ...first, first_texts: [...(first.first_texts as string[]).slice(0, 2), ' '] },
      { ...first, first_texts: [...(first.first_texts as string[]).slice(0, 2), 'x'.repeat(GROUP_IDEA_MAX_CHARS + 1)] },
      { ...first, statuses: { ...(first.statuses as Row), night: '' } },
      { ...first, statuses: { morning: (first.statuses as Row).morning, afternoon: (first.statuses as Row).afternoon, evening: (first.statuses as Row).evening } },
      { ...first, statuses: { ...(first.statuses as Row), dawn: 'An extra part of the day.' } },
    ]
    for (const entry of broken) {
      assert.throws(() => validateGroup({ ...source, seed_cast: [entry, ...fixture.seed_cast.slice(1)] } as unknown as WorldTemplateDoc), file)
    }
  }
  assert.equal(counted, 16)
})

// ── create-a-group drafting (§4) ──────────────────────────────────────────
// The model calls and the text gate are stubbed; the draft service, the body
// schema, the route, the controller and validation are real.
const { draftEffects, draftGroup, GROUP_DRAFT_PROMPT, personDraftPrompt } = await import('../src/services/group-chat/draft')
const { GroupDraftBody, CreateTemplateBody } = await import('../src/schemas/template.schema')
const { Value } = await import('@sinclair/typebox/value')
const { templateRoutes } = await import('../src/routes/template.routes')

const draftApp = new Elysia().onError(({ error, set }) => {
  const failure = error as { statusCode?: unknown; status?: unknown; message?: string }
  set.status = Number(failure.statusCode ?? failure.status ?? 500)
  return { message: failure.message }
}).use(templateRoutes)

// The real create route's schema: a draft must be sendable to it unchanged.
const draftCreateApp = new Elysia().post('/template', ({ body }) => body, { body: CreateTemplateBody })

async function postGroupDraft(body: unknown, headers: Record<string, string> = {}) {
  return draftApp.handle(new Request('http://localhost/templates/group-draft', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  }))
}

const DRAFT_NAMES = ['Ana', 'Ben', 'Cleo', 'Dev', 'Eli', 'Fay']
const DRAFT_CLOSENESS = ['friend', 'rival', 'acquaintance', 'unrequited_attraction', 'friend', 'acquaintance'] as const
function draftForm(count = 2, adult = true) {
  return {
    title: 'The Flat',
    setting: 'Six friends share a flat above a bakery in a wet northern city.',
    adult,
    people: DRAFT_NAMES.slice(0, count).map((name, index) => ({
      name,
      age: 24 + index,
      look: `A short practical haircut, a bakery apron and flour on the sleeves (${name}).`,
      personality: `${name} is dry, practical and quietly kind.`,
      knows_player: `${name} met the player at the bakery counter last winter.`,
      closeness: DRAFT_CLOSENESS[index],
    })),
  }
}
type DraftForm = ReturnType<typeof draftForm>

function groupDraftReply(form: DraftForm) {
  return JSON.stringify({
    description: 'A group chat for the people who share the flat above the bakery.',
    global_lore: 'They have shared the flat for two years, and the fuse box has never worked.',
    seed_prompt: 'You have just moved into the flat above the bakery and been added to the group chat.',
    topics: Array.from({ length: 10 }, (_, index) => `Topic ${index + 1}: the kettle, the fuse box and the rent.`),
    opening_lines: [
      { name: form.people[0]!.name, text: 'The kettle is broken again.' },
      { name: form.people[1]!.name, text: 'I told you it was the fuse.' },
      { name: form.people[0]!.name, text: 'Then fix the fuse.' },
    ],
  })
}
const DRAFT_PLAIN = ['I put the kettle on.', 'The fuse box is in the hall.']
const DRAFT_EXPLICIT = [
  'Put your mouth on my neck and then lower.',
  'Your fingers inside me, now.',
  'I want your cock in my mouth.',
]
function personDraftReply(form: DraftForm, index: number, extra: Row = {}) {
  const person = form.people[index]!
  return JSON.stringify({
    role: `Flatmate ${index + 1}, keeper of the fuse box.`,
    appearance: `${person.age}; short hair, a bakery apron and flour on the sleeves.`,
    persona: `${person.name} is dry, practical and quietly kind, and notices everything.`,
    speech: 'Short sentences, no emoji, a dry turn at the end.',
    wants: 'A quiet morning, a working kettle and someone to share the rent.',
    ...(form.adult ? { intimacy: 'Direct and unhurried, in their own voice, with no embarrassment.' } : {}),
    first_texts: ['Are you up?', 'The kettle is broken.', 'Come down for coffee.'],
    statuses: { morning: 'Up early.', afternoon: 'On shift.', evening: 'Home and tired.', night: 'Still awake.' },
    talkativeness: 0.5,
    voice: { plain: [...DRAFT_PLAIN], ...(form.adult ? { explicit: [...DRAFT_EXPLICIT] } : {}) },
    ...extra,
  })
}
function groupDraftReplyBad(form: DraftForm) {
  const reply = JSON.parse(groupDraftReply(form)) as Row
  reply.topics = (reply.topics as string[]).slice(0, 9)
  return JSON.stringify(reply)
}
function groupDraftReplyMarked(form: DraftForm) {
  const reply = JSON.parse(groupDraftReply(form)) as Row
  reply.description = 'REFUSE this group description.'
  return JSON.stringify(reply)
}
function personDraftWithMarker(form: DraftForm, index: number) {
  const reply = JSON.parse(personDraftReply(form, index)) as Row
  ;(reply.voice as Row).plain = ['REFUSE this line.', 'I put the kettle on.']
  return JSON.stringify(reply)
}
function groupDraftReplyWithStrangers(form: DraftForm, valid: number, strangers: number) {
  const reply = JSON.parse(groupDraftReply(form)) as Row
  const openings = (reply.opening_lines as Row[]).slice(0, valid)
  for (let index = 0; index < strangers; index++) {
    openings.push({ name: `Stranger ${index}`, text: `A stranger line ${index}.` })
  }
  reply.opening_lines = openings
  return JSON.stringify(reply)
}

let draftRequests: Row[] = []
let draftAnswer: (request: Row) => string | Error = () => new Error('unexpected draft call')
draftEffects.call = async (request) => {
  draftRequests.push(request as Row)
  const answer = draftAnswer(request as Row)
  if (answer instanceof Error) throw answer
  return answer
}
function stubDraft(responder: (request: Row) => string | Error) {
  draftRequests = []
  draftAnswer = responder
}
const isGroupCall = (request: Row): boolean => request.purpose === 'group_draft'
function draftPersonIndex(request: Row): number {
  const body = JSON.parse(String((request.messages as Row[])[1]!.content)) as Row
  return DRAFT_NAMES.indexOf(String((body.person as Row).name))
}
function draftPersonName(request: Row): string {
  const body = JSON.parse(String((request.messages as Row[])[1]!.content)) as Row
  return String((body.person as Row).name)
}

function draftGate(responder: (request: Parameters<typeof textGateEffects.call>[0]) => string | Error = () => JSON.stringify({ verdict: 'allow', rejected: [] })) {
  gateRequests = []
  gateWaits = 0
  textGateEffects.call = async (request) => {
    gateRequests.push(request)
    const answer = responder(request)
    if (answer instanceof Error) throw answer
    return answer
  }
  textGateEffects.wait = async () => { gateWaits++ }
}
function rejectMarker(marker: string) {
  draftGate((request) => {
    const handles = gateLines(request).filter((entry) => entry.text.includes(marker)).map((entry) => entry.handle)
    return handles.length
      ? JSON.stringify({ verdict: 'reject', rejected: handles })
      : JSON.stringify({ verdict: 'allow', rejected: [] })
  })
}

const originalReserve = billingService.reserve
const originalRelease = billingService.release
let reserveCalls: Array<[string, string]> = []
let releaseCalls: string[] = []
let reserveFailureAt: number | undefined
function stubBilling() {
  reserveCalls = []
  releaseCalls = []
  reserveFailureAt = undefined
  billingService.reserve = async (_player, action, requestId) => {
    reserveCalls.push([action, requestId])
    if (reserveFailureAt !== undefined && reserveCalls.length === reserveFailureAt) {
      throw Object.assign(new Error('Not enough Story Ink'), { statusCode: 402 })
    }
    return { reservation_id: `reserve:${action}:${requestId}`, cost: 0, balance: null }
  }
  billingService.release = async (_player, reservationId) => {
    if (reservationId) releaseCalls.push(reservationId)
  }
}
function restoreBilling() {
  billingService.reserve = originalReserve
  billingService.release = originalRelease
}
const draftError = (status: number, message?: string) => (error: unknown) =>
  error instanceof Error && 'statusCode' in error && (error as { statusCode: number }).statusCode === status &&
  (message === undefined || error.message === message)
const DRAFT_FAILED = "We couldn't write this group. Try changing the descriptions."

await check('group draft happy path for two and six people', async () => {
  for (const count of [2, 6]) {
    const form = draftForm(count)
    draftGate()
    stubDraft((request) => isGroupCall(request)
      ? groupDraftReply(form)
      : personDraftReply(form, draftPersonIndex(request)))
    const draft = await draftGroup(form)
    const groups = draftRequests.filter(isGroupCall)
    const people = draftRequests.filter((request) => !isGroupCall(request))
    assert.equal(groups.length, 1)
    assert.equal(people.length, count)
    for (const request of [groups[0]!, people[0]!]) {
      assert.equal(request.model, 'fixture-authoring')
      assert.deepEqual(request.responseFormat, { type: 'json_object' })
      assert.equal((request.messages as Row[])[0]!.role, 'system')
    }
    assert.equal(groups[0]!.purpose, 'group_draft')
    assert.equal(people[0]!.purpose, 'group_draft_person')
    assert.deepEqual(people.map(draftPersonName).sort(), form.people.map((person) => person.name).sort())
    const firstPerson = JSON.parse(String((people[0]!.messages as Row[])[1]!.content)) as Row
    assert.deepEqual((firstPerson.others as Row[]).map((other) => other.name), form.people.slice(1).map((person) => person.name))
    assert.equal((firstPerson.group as Row).global_lore, JSON.parse(groupDraftReply(form)).global_lore)
    assert.equal(Value.Check(GroupDraftBody, form), true)
    assert.equal(Value.Check(CreateTemplateBody, draft), true, 'the draft must be a create body unchanged')
    const created = await draftCreateApp.handle(new Request('http://localhost/template', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(draft),
    }))
    assert.equal(created.status, 200, 'the draft must be accepted by the create route schema')
    validateGroup(draft as never)
    assert.equal(gateRequests.length, 1)
    assert.deepEqual(gateLines(gateRequests[0]!).map((line) => line.text), groupTextLines(draft as never).map((line) => line.text))
  }
})

await check('group draft prompts ask for words only and state the authoring rule', () => {
  for (const required of ['EXACTLY 10', '3 to 6', 'global_lore', 'opening_lines', 'The only names you return are the speakers of the opening lines']) {
    assert(GROUP_DRAFT_PROMPT.includes(required), `group prompt is missing ${required}`)
  }
  const adult = personDraftPrompt(true)
  for (const required of [
    'name a sex act',
    'their own body',
    "the player's mouth, hands and fingers",
    "Never assume anything about the player's body",
    'never names its own speaker',
    'EXACTLY 3',
    '2 to 4',
  ]) {
    assert(adult.includes(required), `adult person prompt is missing ${required}`)
  }
  const safe = personDraftPrompt(false)
  assert(!safe.includes('sex act'))
  assert(!safe.includes('explicit'))
  assert(!safe.includes('intimacy'))
  assert(safe.includes('2 to 4'))
})

await check('group draft mints name age bond and talkativeness from the form', async () => {
  const form = draftForm(2)
  draftGate()
  stubDraft((request) => isGroupCall(request)
    ? groupDraftReply(form)
    : personDraftReply(form, draftPersonIndex(request), {
      name: 'Wrong Name',
      id: '000000000000000000000001',
      age: 99,
      start_bond: 'family_warm',
      group: { age: 99, start_bond: 'family_warm' },
      talkativeness: draftPersonIndex(request) === 0 ? 5 : 'lots',
    }))
  const draft = await draftGroup(form)
  const [first, second] = draft.seed_cast
  assert.equal(first!.name, form.people[0]!.name)
  assert.equal(first!.group.age, form.people[0]!.age)
  assert.equal(first!.group.start_bond, form.people[0]!.closeness)
  assert.equal(first!.group.talkativeness, 1)
  assert.equal(second!.group.talkativeness, 0.5)
  assert.deepEqual(first!.aliases, [])
  assert.equal(first!.identity_kind, 'human')
  assert(!('id' in first!), 'the model id must be dropped')
  assert(!JSON.stringify(draft).includes('Wrong Name'))
  assert.equal(draft.kind, 'group')
  assert.equal(draft.title, form.title)
  assert.equal(draft.is_sentient, false)
  for (const key of ['base_stats_template', 'protagonist', 'opening_line', 'image_url']) {
    assert(!(key in draft), `${key} must not be drafted`)
  }
})

await check('group draft adult voice is plain then explicit and a safe group has neither', async () => {
  for (const adult of [true, false]) {
    const form = draftForm(2, adult)
    draftGate()
    stubDraft((request) => isGroupCall(request)
      ? groupDraftReply(form)
      : personDraftReply(form, draftPersonIndex(request), {
        // Returned in both modes: the server drops them when the group is safe.
        intimacy: 'This must be dropped for a safe group.',
        voice: { plain: [...DRAFT_PLAIN], explicit: [...DRAFT_EXPLICIT] },
      }))
    const draft = await draftGroup(form)
    const member = draft.seed_cast[0]!
    assert.equal(draft.is_nsfw_capable, adult)
    if (adult) {
      assert.deepEqual(member.group.voice, [...DRAFT_PLAIN, ...DRAFT_EXPLICIT])
      assert.equal(typeof member.group.intimacy, 'string')
    } else {
      assert.deepEqual(member.group.voice, DRAFT_PLAIN)
      assert(!('intimacy' in member.group), 'a safe group never carries intimacy')
      for (const text of DRAFT_EXPLICIT) assert(!member.group.voice!.includes(text))
      assert(!JSON.stringify(draft).includes('This must be dropped for a safe group.'))
    }
    validateGroup(draft as never)
  }
})

await check('group draft shape failure redrafts once then fails with 422 and releases', async () => {
  const form = draftForm(2)
  draftGate()
  let groupAttempts = 0
  stubDraft((request) => {
    if (!isGroupCall(request)) return personDraftReply(form, draftPersonIndex(request))
    return groupAttempts++ === 0 ? groupDraftReplyBad(form) : groupDraftReply(form)
  })
  const draft = await draftGroup(form)
  assert.equal(groupAttempts, 2)
  assert.equal(draftRequests.filter((request) => !isGroupCall(request)).length, 2)
  validateGroup(draft as never)

  try {
    stubBilling()
    resetSaveTables()
    routeUser = { id: playerId, tier: 'creator' }
    draftGate()
    stubDraft((request) => isGroupCall(request) ? groupDraftReplyBad(form) : personDraftReply(form, draftPersonIndex(request)))
    const response = await postGroupDraft(form, { 'x-idempotency-key': 'shape-key' })
    assert.equal(response.status, 422)
    assert.equal((await response.json() as Row).message, DRAFT_FAILED)
    assert.equal(draftRequests.filter(isGroupCall).length, 2)
    assert.equal(draftRequests.filter((request) => !isGroupCall(request)).length, 0)
    assert.deepEqual(releaseCalls, [
      'reserve:group_draft_person:shape-key:0',
      'reserve:group_draft_person:shape-key:1',
    ])
  } finally {
    restoreBilling()
    routeUser = null
  }
})

await check('group draft a voice line naming its speaker redrafts that person', async () => {
  const form = draftForm(3)
  draftGate()
  let personOne = 0
  stubDraft((request) => {
    if (isGroupCall(request)) return groupDraftReply(form)
    const index = draftPersonIndex(request)
    if (index !== 1) return personDraftReply(form, index)
    personOne++
    if (personOne > 1) return personDraftReply(form, index)
    return personDraftReply(form, index, { voice: { plain: ['Ben should not say this.', 'I put the kettle on.'], explicit: [...DRAFT_EXPLICIT] } })
  })
  const draft = await draftGroup(form)
  assert.equal(personOne, 2)
  assert.equal(draftRequests.filter(isGroupCall).length, 1)
  assert.equal(draftRequests.filter((request) => !isGroupCall(request)).length, 4)
  assert(!JSON.stringify(draft).includes('Ben should not say this.'))
})

await check('group draft gate refuses one person then twice fails and releases', async () => {
  const form = draftForm(3)
  rejectMarker('REFUSE')
  let personOne = 0
  stubDraft((request) => {
    if (isGroupCall(request)) return groupDraftReply(form)
    const index = draftPersonIndex(request)
    if (index !== 1) return personDraftReply(form, index)
    personOne++
    return personOne === 1 ? personDraftWithMarker(form, index) : personDraftReply(form, index)
  })
  const draft = await draftGroup(form)
  assert.equal(personOne, 2)
  assert.equal(draftRequests.filter(isGroupCall).length, 1)
  assert.equal(draftRequests.filter((request) => !isGroupCall(request)).length, 4)
  assert(!JSON.stringify(draft).includes('REFUSE'))

  try {
    stubBilling()
    resetSaveTables()
    routeUser = { id: playerId, tier: 'creator' }
    rejectMarker('REFUSE')
    stubDraft((request) => {
      if (isGroupCall(request)) return groupDraftReply(form)
      const index = draftPersonIndex(request)
      return index === 1 ? personDraftWithMarker(form, index) : personDraftReply(form, index)
    })
    const response = await postGroupDraft(form, { 'x-idempotency-key': 'gate-key' })
    assert.equal(response.status, 422)
    assert.equal((await response.json() as Row).message, DRAFT_FAILED)
    assert.equal(draftRequests.filter((request) => !isGroupCall(request)).length, 4)
    assert.deepEqual(releaseCalls, [
      'reserve:group_draft_person:gate-key:0',
      'reserve:group_draft_person:gate-key:1',
      'reserve:group_draft_person:gate-key:2',
    ])
  } finally {
    restoreBilling()
    routeUser = null
  }
})

// A failed draft says why in the log, in fixed codes: no name, form field,
// model reply or line of text may reach it.
const fixtureTexts = (form: DraftForm) => [
  ...form.people.map((person) => person.name),
  ...form.people.map((person) => person.look),
  ...form.people.map((person) => person.personality),
  ...form.people.map((person) => person.knows_player),
  form.title,
  form.setting,
]
await check('group draft shape miss logs its call and reason then fails', async () => {
  const form = draftForm(3)
  draftGate()
  const selfNaming = (index: number) => personDraftReply(form, index, {
    voice: { plain: [`${form.people[index]!.name} should not say this.`, 'I put the kettle on.'], explicit: [...DRAFT_EXPLICIT] },
  })
  stubDraft((request) => {
    if (isGroupCall(request)) return groupDraftReply(form)
    const index = draftPersonIndex(request)
    return index === 1 ? selfNaming(index) : personDraftReply(form, index)
  })
  const before = memoryLogs.length
  await assert.rejects(draftGroup(form), draftError(422, DRAFT_FAILED))
  const logged = memoryLogs.slice(before)
  assert.deepEqual(logged.map((entry) => entry.name),
    ['group_draft.shape_miss', 'group_draft.shape_miss', 'group_draft.failed'])
  assert.deepEqual(
    logged.slice(0, 2).map(({ call, person, attempt, reason }) => ({ call, person, attempt, reason })),
    [
      { call: 'person', person: 1, attempt: 1, reason: 'person_voice_names_self' },
      { call: 'person', person: 1, attempt: 2, reason: 'person_voice_names_self' },
    ],
  )
  assert.deepEqual(logged[2], { name: 'group_draft.failed', stage: 'person_shape', person: 1 })
  const serialized = JSON.stringify(logged)
  for (const text of [...fixtureTexts(form), 'Ben should not say this.']) {
    assert(!serialized.includes(text), `the log leaks ${text}`)
  }
})
await check('group draft a gate refusal logs its stage and paths', async () => {
  const form = draftForm(2)
  rejectMarker('REFUSE')
  stubDraft((request) => {
    if (isGroupCall(request)) return groupDraftReply(form)
    const index = draftPersonIndex(request)
    return index === 1 ? personDraftWithMarker(form, index) : personDraftReply(form, index)
  })
  const before = memoryLogs.length
  await assert.rejects(draftGroup(form), draftError(422, DRAFT_FAILED))
  const logged = memoryLogs.slice(before)
  assert.deepEqual(logged.map((entry) => entry.name), ['group_draft.failed'])
  assert.deepEqual(logged[0], { name: 'group_draft.failed', stage: 'gate', paths: ['seed_cast.1.group.voice.0'] })
  const serialized = JSON.stringify(logged)
  for (const text of [...fixtureTexts(form), 'REFUSE this line.']) {
    assert(!serialized.includes(text), `the log leaks ${text}`)
  }
})

await check('group draft gate 503 passes through and releases', async () => {
  const form = draftForm(3)
  try {
    stubBilling()
    resetSaveTables()
    routeUser = { id: playerId, tier: 'creator' }
    draftGate(() => Object.assign(new Error('Fixture provider failure'), { status: 503 }))
    stubDraft((request) => isGroupCall(request)
      ? groupDraftReply(form)
      : personDraftReply(form, draftPersonIndex(request)))
    const response = await postGroupDraft(form, { 'x-idempotency-key': 'gate-503' })
    assert.equal(response.status, 503)
    assert.equal((await response.json() as Row).message, 'Try again in a moment.')
    assert.equal(gateRequests.length, 2)
    assert.equal(gateWaits, 1)
    assert.deepEqual(releaseCalls, [
      'reserve:group_draft_person:gate-503:0',
      'reserve:group_draft_person:gate-503:1',
      'reserve:group_draft_person:gate-503:2',
    ])
  } finally {
    restoreBilling()
    routeUser = null
  }
})

await check('group draft a refused group path redrafts the group once', async () => {
  const form = draftForm(2)
  rejectMarker('REFUSE')
  let groupAttempts = 0
  stubDraft((request) => {
    if (isGroupCall(request)) {
      return groupAttempts++ === 0 ? groupDraftReplyMarked(form) : groupDraftReply(form)
    }
    return personDraftReply(form, draftPersonIndex(request))
  })
  const draft = await draftGroup(form)
  assert.equal(groupAttempts, 2)
  assert.equal(draftRequests.filter(isGroupCall).length, 2)
  assert.equal(draftRequests.filter((request) => !isGroupCall(request)).length, 2)
  assert(!JSON.stringify(draft).includes('REFUSE'))
})

await check('group draft opening lines naming strangers are dropped and too few fail', async () => {
  const form = draftForm(2)
  draftGate()
  stubDraft((request) => isGroupCall(request)
    ? groupDraftReplyWithStrangers(form, 3, 2)
    : personDraftReply(form, draftPersonIndex(request)))
  const draft = await draftGroup(form)
  assert.equal(draft.opening_lines.length, 3)
  for (const line of draft.opening_lines) {
    assert(form.people.some((person) => person.name === line.name), `opening line names ${line.name}`)
  }
  assert(!JSON.stringify(draft).includes('Stranger'))

  let groupAttempts = 0
  stubDraft((request) => {
    if (!isGroupCall(request)) return personDraftReply(form, draftPersonIndex(request))
    groupAttempts++
    return groupDraftReplyWithStrangers(form, 2, 2)
  })
  await assert.rejects(draftGroup(form), draftError(422, DRAFT_FAILED))
  assert.equal(groupAttempts, 2)
  assert.equal(draftRequests.filter((request) => !isGroupCall(request)).length, 0)
})

await check('group draft route auth identity tier rate limit and duplicate names', async () => {
  const form = draftForm(2)
  resetSaveTables()
  let rateCalls = 0
  try {
    rateLimitReply = () => { rateCalls++; return { allowed: true } }
    stubBilling()
    draftGate()
    stubDraft(() => { throw new Error('the model must not be called') })
    routeUser = null
    assert.equal((await postGroupDraft(form)).status, 401)
    routeUser = { id: new ObjectId().toHexString(), tier: 'creator' }
    assert.equal((await postGroupDraft(form)).status, 401)
    routeUser = { id: playerId, tier: 'free' }
    const forbidden = await postGroupDraft(form)
    assert.equal(forbidden.status, 403)
    assert.equal((await forbidden.json() as Row).message, 'Forging needs a Premium or Creator membership.')
    routeUser = { id: playerId, tier: 'creator' }

    stubBilling()
    draftGate()
    stubDraft(() => { throw new Error('the model must not be called') })
    const duplicate = draftForm(2)
    duplicate.people[1] = { ...duplicate.people[1]!, name: ' ana ' }
    rateCalls = 0
    const dup = await postGroupDraft(duplicate)
    assert.equal(dup.status, 400)
    assert.equal((await dup.json() as Row).message, 'Each person needs a different name.')
    assert.equal(rateCalls, 0)
    assert.equal(reserveCalls.length, 0)
    assert.equal(draftRequests.length, 0)

    // Unknown keys are stripped before the controller, never carried into a draft.
    draftGate()
    stubDraft((request) => isGroupCall(request) ? groupDraftReply(form) : personDraftReply(form, draftPersonIndex(request)))
    const extra = { ...form, image_url: 'https://fixture.invalid/cover.webp', people: [{ ...form.people[0]!, extra: 'nope' }, form.people[1]!] }
    const accepted = await postGroupDraft(extra)
    assert.equal(accepted.status, 200)
    const acceptedDraft = (await accepted.json() as Row).draft as Row
    assert(!('image_url' in acceptedDraft))
    assert(!JSON.stringify(acceptedDraft).includes('nope'))

    for (const [label, body] of [
      ['age below 18', { ...form, people: [{ ...form.people[0]!, age: 17 }, form.people[1]!] }],
      ['age above 99', { ...form, people: [{ ...form.people[0]!, age: 100 }, form.people[1]!] }],
      ['one person', { ...form, people: [form.people[0]!] }],
      ['seven people', { ...form, people: Array.from({ length: 7 }, (_, index) => ({ ...form.people[0]!, name: `P${index}` })) }],
      ['title too long', { ...form, title: 'x'.repeat(61) }],
    ] as const) {
      // A body the schema refuses never reaches a reservation or a model call.
      stubBilling()
      draftGate()
      stubDraft(() => { throw new Error('the model must not be called') })
      assert.equal((await postGroupDraft(body)).status, 422, label)
      assert.equal(reserveCalls.length, 0, label)
      assert.equal(draftRequests.length, 0, label)
    }

    rateCalls = 0
    rateLimitReply = (_userId, action) => { rateCalls++; return { allowed: action !== 'group_draft' } }
    stubBilling()
    draftGate()
    stubDraft(() => { throw new Error('the model must not be called') })
    const limited = await postGroupDraft(form)
    assert.equal(limited.status, 429)
    assert.equal(rateCalls, 1)
    assert.equal(reserveCalls.length, 0)
    assert.equal(draftRequests.length, 0)
  } finally {
    rateLimitReply = () => ({ allowed: true })
    restoreBilling()
    routeUser = null
  }
})

await check('group draft ink reserves per person and a failing third releases the first two', async () => {
  const { BILLING_CATALOG } = await import('../src/services/billing-catalog')
  assert.equal(BILLING_CATALOG.costs.group_draft_person, 12)
  const form = draftForm(3)
  try {
    stubBilling()
    resetSaveTables()
    routeUser = { id: playerId, tier: 'creator' }
    draftGate()
    stubDraft((request) => isGroupCall(request)
      ? groupDraftReply(form)
      : personDraftReply(form, draftPersonIndex(request)))
    const response = await postGroupDraft(form, { 'x-idempotency-key': 'ink-key' })
    assert.equal(response.status, 200)
    assert.deepEqual(reserveCalls.map(([, requestId]) => requestId), ['ink-key:0', 'ink-key:1', 'ink-key:2'])
    assert(reserveCalls.every(([action]) => action === 'group_draft_person'))
    assert.deepEqual(releaseCalls, [])

    stubBilling()
    reserveFailureAt = 3
    draftGate()
    stubDraft(() => { throw new Error('the model must not be called') })
    const failed = await postGroupDraft(form, { 'x-idempotency-key': 'ink-key' })
    assert.equal(failed.status, 402)
    assert.deepEqual(releaseCalls, [
      'reserve:group_draft_person:ink-key:0',
      'reserve:group_draft_person:ink-key:1',
    ])
    assert.equal(draftRequests.length, 0)

    // Without the header, one random key still names every person's reservation.
    stubBilling()
    draftGate()
    stubDraft((request) => isGroupCall(request)
      ? groupDraftReply(form)
      : personDraftReply(form, draftPersonIndex(request)))
    assert.equal((await postGroupDraft(form)).status, 200)
    assert.equal(reserveCalls.length, 3)
    const prefixes = reserveCalls.map(([, requestId]) => requestId.split(':')[0]!)
    assert.equal(new Set(prefixes).size, 1)
    assert.match(prefixes[0]!, /^[0-9a-f-]{36}$/)
    assert.deepEqual(reserveCalls.map(([, requestId]) => requestId.split(':')[1]), ['0', '1', '2'])
  } finally {
    restoreBilling()
    routeUser = null
  }
})

await check('group draft route never touches world templates', async () => {
  const form = draftForm(2)
  try {
    stubBilling()
    resetSaveTables()
    routeUser = { id: playerId, tier: 'creator' }
    draftGate()
    stubDraft((request) => isGroupCall(request)
      ? groupDraftReply(form)
      : personDraftReply(form, draftPersonIndex(request)))
    templateFindHook = () => { throw new Error('the draft route read worldTemplates') }
    const response = await postGroupDraft(form)
    assert.equal(response.status, 200)
    assert.equal(rows('worldTemplates').length, 0)
  } finally {
    templateFindHook = undefined
    restoreBilling()
    routeUser = null
  }
})

await check('group draft provider failure is a 503 with no redraft and releases', async () => {
  const form = draftForm(2)
  try {
    for (const [label, failure] of [
      ['with a status', () => Object.assign(new Error('Fixture provider failure'), { status: 503 })],
      ['without a status', () => new Error('Fixture provider failure')],
    ] as const) {
      stubBilling()
      resetSaveTables()
      routeUser = { id: playerId, tier: 'creator' }
      draftGate()
      stubDraft(() => failure())
      const response = await postGroupDraft(form, { 'x-idempotency-key': 'provider-key' })
      assert.equal(response.status, 503, label)
      assert.equal((await response.json() as Row).message, 'Try again in a moment.', label)
      // The outage is not the player's words: one call, no redraft, no gate.
      assert.equal(draftRequests.length, 1, `${label}: a provider failure must not be redrafted`)
      assert.equal(gateRequests.length, 0, label)
      assert.deepEqual(releaseCalls, [
        'reserve:group_draft_person:provider-key:0',
        'reserve:group_draft_person:provider-key:1',
      ], label)
    }
  } finally {
    restoreBilling()
    routeUser = null
  }
})

await check('group draft appearance opens with the form age in digits', async () => {
  const wrongAge = (form: DraftForm, index: number) =>
    personDraftReply(form, index, { appearance: `${form.people[index]!.age + 1}, fair hair and a scarf.` })
  const noDigits = (form: DraftForm, index: number) =>
    personDraftReply(form, index, { appearance: 'In her twenties, fair hair and a scarf.' })

  for (const [label, wrong] of [['a different age', wrongAge], ['no digits', noDigits]] as const) {
    const form = draftForm(3)
    draftGate()
    let personOne = 0
    stubDraft((request) => {
      if (isGroupCall(request)) return groupDraftReply(form)
      const index = draftPersonIndex(request)
      if (index !== 1) return personDraftReply(form, index)
      personOne++
      return personOne === 1 ? wrong(form, index) : personDraftReply(form, index)
    })
    const draft = await draftGroup(form)
    assert.equal(personOne, 2, `${label}: the person must be redrafted once`)
    assert.equal(draftRequests.filter((request) => !isGroupCall(request)).length, 4, label)
    assert.equal(/^(\d+)(?!\d)/.exec(draft.seed_cast[1]!.appearance)?.[1], String(form.people[1]!.age), `${label}: the fixed look wins`)
  }

  for (const [label, wrong] of [['a different age', wrongAge], ['no digits', noDigits]] as const) {
    const form = draftForm(2)
    draftGate()
    let personOne = 0
    stubDraft((request) => {
      if (isGroupCall(request)) return groupDraftReply(form)
      const index = draftPersonIndex(request)
      return index === 1 ? (personOne++, wrong(form, index)) : personDraftReply(form, index)
    })
    await assert.rejects(draftGroup(form), draftError(422, DRAFT_FAILED), label)
    assert.equal(personOne, 2, `${label}: a second miss fails the draft`)
  }
})

await check('group draft person prompt pins the age in digits', () => {
  for (const adult of [true, false]) {
    const prompt = personDraftPrompt(adult)
    assert(prompt.includes('opening with their age from the form in digits'), 'the prompt must ask for digits')
    assert(prompt.includes('"27, ..."'), 'the prompt must show the digits example')
    assert(!prompt.includes('in words or digits'), 'the prompt must not allow words')
  }
})

// ── create-a-group faces (§6) ──────────────────────────────────────────────
// The route, the controller, the face service, validation and the review rule
// are real; the image pipeline is stubbed (no paid calls, no network).
const faceApp = new Elysia().onError(({ error, set }) => {
  const failure = error as { statusCode?: unknown; status?: unknown; message?: string }
  set.status = Number(failure.statusCode ?? failure.status ?? 500)
  return { message: failure.message }
}).use(templateRoutes)
const postFace = (id: unknown, index: unknown, query = '') =>
  faceApp.handle(new Request(`http://localhost/templates/${String(id)}/cast/${String(index)}/portrait${query}`, { method: 'POST' }))

function faceCast(names = ['Test Alpha', 'Test Beta', 'Test Gamma']) {
  return names.map((name, index) => ({
    name,
    role: `member ${index}`,
    persona: `Persona ${index}`,
    appearance: `Appearance for ${name}.`,
    group: { start_bond: 'friend', age: 24 + index, talkativeness: 0.5, speech: `Voice ${index}`, wants: `Private motivation ${index}`, intimacy: `Private intimacy ${index}`, voice: [`Authored text ${index}`] },
  }))
}
function faceGroup(patch: Row = {}): Row {
  return { ...groupTemplate(), _id: new ObjectId(), seed_cast: faceCast(), ...patch }
}

await check('group face route refuses before it paints', async () => {
  resetSaveTables()
  const group = faceGroup({ creator_id: new ObjectId(playerId) })
  const world = faceGroup({ _id: new ObjectId(), kind: 'world', creator_id: new ObjectId(playerId) })
  const short = faceGroup({ _id: new ObjectId(), creator_id: new ObjectId(playerId), seed_cast: faceCast().slice(0, 2) })
  const blank = faceGroup({ _id: new ObjectId(), creator_id: new ObjectId(playerId), seed_cast: faceCast().map((member, index) => index === 1 ? { ...member, appearance: '   ' } : member) })
  const stranger = faceGroup({ _id: new ObjectId(), creator_id: new ObjectId() })
  rows('worldTemplates').push(group, world, short, blank, stranger)
  const before = rows('mediaAssets').length + rows('mediaUsage').length
  try {
    routeUser = null
    assert.equal((await postFace(group._id, 0)).status, 401, 'a signed-out call is refused')
    routeUser = { id: new ObjectId().toHexString(), tier: 'creator' }
    assert.equal((await postFace(group._id, 0)).status, 401, 'an identity without a user row is refused')
    routeUser = { id: playerId, tier: 'free' }
    const forbidden = await postFace(group._id, 0)
    assert.equal(forbidden.status, 403)
    assert.equal((await forbidden.json() as Row).message, 'Forging needs a Premium or Creator membership.')
    routeUser = { id: playerId, tier: 'creator' }
    for (const [label, id, index, status, message] of [
      ["a stranger's group", stranger._id, 0, 404, 'That group could not be found.'],
      ['a world', world._id, 0, 404, 'That group could not be found.'],
      ['a missing person', short._id, 2, 404, 'That person could not be found.'],
      ['a look nobody wrote', blank._id, 1, 422, 'This moment stays unseen.'],
    ] as const) {
      const response = await postFace(id, index)
      assert.equal(response.status, status, label)
      assert.equal((await response.json() as Row).message, message, label)
    }
    // The cast positions are the schema's: a seventh person never reaches the service.
    assert.equal((await postFace(short._id, 6)).status, 422)
    // Nothing was queued or counted for any refusal.
    assert.equal(rows('mediaAssets').length + rows('mediaUsage').length, before)
  } finally { routeUser = null }
})

await check('group face request queues one person under a group row', async () => {
  resetSaveTables()
  const group = faceGroup({ creator_id: new ObjectId(playerId) })
  rows('worldTemplates').push(group)
  const { visualEffects } = await import('../src/services/media/visual')
  const { mediaRevision } = await import('../src/services/media/attribution')
  const enqueued: Row[] = []
  const enqueue = visualEffects.enqueue
  visualEffects.enqueue = (async (kind: string, asset: Row, id: string) => { enqueued.push({ kind, asset, id }) }) as never
  try {
    routeUser = { id: playerId, tier: 'creator' }
    const response = await postFace(group._id, 1)
    assert.equal(response.status, 202)
    const reply = await response.json() as Row
    assert.equal(reply.status, 'queued')
    assert.match(String(reply.media_id), /^[a-f0-9]{24}$/)
    const asset = rows('mediaAssets')[0]!
    assert.equal(String(asset.template_id), String(group._id), 'the row names its group')
    assert.equal(asset.cast_name, 'Test Beta', 'the row names its person as stored')
    assert.equal(asset.kind, 'portrait')
    assert.equal(asset.art_style, 'anime')
    assert.equal(asset.source, 'generated')
    assert.equal(asset.status, 'queued')
    assert.equal(asset.line_id, '')
    assert.equal(asset.input, 'Appearance for Test Beta.')
    assert.equal(asset.revision, mediaRevision('Appearance for Test Beta.', 'group-face'))
    assert.ok(String(asset.cache_key).startsWith(`groupface:${group._id.toHexString()}:test beta:`))
    for (const key of ['instance_id', 'character_id', 'persona_id']) {
      assert.equal(key in asset, false, `${key} must be omitted on a group face`)
    }
    assert.equal(rows('mediaUsage').filter((row) => row.status === 'reserved').length, 1)
    assert.equal(rows('mediaUsage')[0]!.kind, 'portrait')
    assert.equal(enqueued.length, 1)
    assert.equal(enqueued[0]!.kind, 'portrait')
    assert.equal(enqueued[0]!.id, group._id.toHexString(), 'the job carries its group')

    // Portraits switched off read as a missing moment, never as a refusal.
    process.env.MEDIA_PORTRAIT_ENABLED = 'false'
    try { assert.equal((await postFace(group._id, 2)).status, 404) } finally { delete process.env.MEDIA_PORTRAIT_ENABLED }
  } finally {
    visualEffects.enqueue = enqueue
    routeUser = null
  }
})

await check('group face keeps a painted person, repaints on ask and rests', async () => {
  resetSaveTables()
  const group = faceGroup({ creator_id: new ObjectId(playerId) })
  const templateId = group._id as ObjectId
  const { mediaRevision } = await import('../src/services/media/attribution')
  const revision = mediaRevision('Appearance for Test Alpha.', 'group-face')
  const cast = group.seed_cast as Row[]
  const kept = { asset_key: 'media/portrait/player-group/o/t/kept.webp', source: 'generated', appearance_version: 1, art_style: 'anime', painted_at: new Date() }
  cast[0]!.portrait = kept
  rows('worldTemplates').push(group)
  rows('mediaAssets').push({
    _id: new ObjectId(), player_id: new ObjectId(playerId), template_id: templateId, cast_name: 'Test Alpha',
    kind: 'portrait', line_id: '', source: 'generated', model: 'fixture-model', cache_key: 'groupface:kept',
    revision, input: 'Appearance for Test Alpha.', cost_usd: 0.009, status: 'ready',
    asset_key: kept.asset_key, url: 'https://fixture.invalid/kept.webp',
  })
  try {
    routeUser = { id: playerId, tier: 'creator' }
    const ready = await postFace(group._id, 0)
    assert.equal(ready.status, 200)
    const body = await ready.json() as Row
    assert.equal(body.status, 'ready')
    assert.equal(body.url, `https://fixture.invalid/${kept.asset_key}`)
    assert.equal(rows('mediaUsage').length, 0, 'a kept face takes no slot')

    const repainted = await postFace(group._id, 0, '?repaint=true')
    assert.equal(repainted.status, 202)
    const rowsAfter = rows('mediaAssets')
    assert.equal(rowsAfter.length, 2)
    const fresh = rowsAfter[1]!
    assert.notEqual(fresh.cache_key, 'groupface:kept')
    assert.match(String(fresh.cache_key), /:r[a-f0-9]{24}$/)
    assert.equal(rows('mediaUsage').filter((row) => row.status === 'reserved').length, 1)

    process.env.MEDIA_DAILY_PORTRAIT = '0'
    try {
      const resting = await postFace(group._id, 2)
      assert.equal(resting.status, 429)
      const restingBody = await resting.json() as Row
      assert.equal(restingBody.status, 'resting')
      assert.equal(restingBody.kind, 'portrait')
      assert.ok(restingBody.resets_at)
      // The refused row is removed: the next tap may try again.
      assert.equal(rows('mediaAssets').length, 2)
      assert.equal(rows('mediaUsage').filter((row) => row.status === 'reserved').length, 1)
    } finally { delete process.env.MEDIA_DAILY_PORTRAIT }
  } finally { routeUser = null }
})

await check('group face edits keep faces and never take one from the body', async () => {
  resetSaveTables(); draftGate()
  const body = groupSaveBody()
  ;(body.seed_cast[0] as Row).portrait = {
    asset_key: 'media/portrait/player-group/body.webp', source: 'generated',
    appearance_version: 1, art_style: 'anime', painted_at: new Date(),
  }
  const created = await templateService.create(playerId, body)
  assert.equal('portrait' in (created.seed_cast![0] as Row), false, 'a saved group never carries a body face')

  const stored = rows('worldTemplates')[0] as Row
  const cast = stored.seed_cast as Row[]
  for (const [index, member] of cast.entries()) {
    member.portrait = {
      asset_key: `media/portrait/player-group/face-${index}.webp`, source: 'generated',
      appearance_version: 1, art_style: 'anime', painted_at: new Date(),
    }
  }
  stored.review_status = 'approved'
  stored.visibility = 'public'
  stored.is_published = true
  const id = String(stored._id)

  // The cast sent back as it was read: every face is kept, and nothing is an edit.
  await templateService.update(id, playerId, { seed_cast: structuredClone(cast) })
  const kept = rows('worldTemplates')[0] as Row
  assert.deepEqual((kept.seed_cast as Row[]).map((member) => member.portrait), cast.map((member) => member.portrait))
  assert.equal(kept.review_status, 'approved', 'an unchanged cast must not go back to review')

  // One look changes: only that person loses their face, and the group returns to review.
  const changed = structuredClone(cast)
  changed[1]!.appearance = 'A changed look.'
  changed[1]!.portrait = { asset_key: 'media/portrait/player-group/body-2.webp', source: 'generated', appearance_version: 1, art_style: 'anime', painted_at: new Date() }
  await templateService.update(id, playerId, { seed_cast: changed })
  const edited = rows('worldTemplates')[0] as Row
  const after = edited.seed_cast as Row[]
  assert.deepEqual(after[0]!.portrait, cast[0]!.portrait, 'an untouched person keeps their face')
  assert.equal('portrait' in after[1]!, false, 'a changed look drops its face')
  assert.deepEqual(after[2]!.portrait, cast[2]!.portrait, 'an untouched person keeps their face')
  assert.equal(edited.review_status, 'pending', 'a changed cast goes back to review')
  assert.equal(edited.ever_approved, true)
})

await check('group face publish needs every person', async () => {
  resetSaveTables(); draftGate()
  const { vectorStore } = await import('../src/services/vector-store')
  const embedLore = vectorStore.replaceLore
  const lore: Row[] = []
  vectorStore.replaceLore = (async (_scope: Row, values: Row[]) => { lore.push(...values) }) as never
  try {
    const created = await templateService.create(playerId, groupSaveBody())
    const id = created._id.toHexString()
    const stored = () => rows('worldTemplates').find((row) => String(row._id) === id)!

    // One person still has no face: nothing is embedded and nothing is written.
    ;(stored().seed_cast as Row[])[0]!.portrait = { asset_key: 'media/portrait/player-group/one.webp', source: 'generated', appearance_version: 1, art_style: 'anime', painted_at: new Date() }
    await assert.rejects(templateService.publish(id, playerId, 'public'), (error: unknown) => {
      const failure = error as { statusCode?: number; message?: string }
      assert.equal(failure.statusCode, 422)
      assert.equal(failure.message, 'Every person needs a face before this group can be shared.')
      return true
    })
    assert.equal(lore.length, 0, 'a refused publish embeds nothing')
    assert.equal(stored().is_published, false)
    assert.equal('visibility' in stored(), false)

    // Every face: it goes to review exactly as a world does.
    for (const [index, member] of (stored().seed_cast as Row[]).entries()) {
      member.portrait = { asset_key: `media/portrait/player-group/all-${index}.webp`, source: 'generated', appearance_version: 1, art_style: 'anime', painted_at: new Date() }
    }
    const shared = await templateService.publish(id, playerId, 'public')
    assert.equal(shared.review_status, 'pending')
    assert.ok(lore.length > 0, 'a shared group embeds its lore')
    assert.equal(stored().is_published, true)
    assert.equal(stored().visibility, 'public')
    assert.equal(stored().review_status, 'pending')

    // A private group needs no faces: only Explore needs them.
    const privateOne = await templateService.create(playerId, groupSaveBody())
    const kept = await templateService.publish(privateOne._id.toHexString(), playerId, 'private')
    assert.equal(kept.visibility, 'private')
    assert.equal('review_status' in kept, false)
  } finally { vectorStore.replaceLore = embedLore }
})

Math.random = originalRandom
console.log(`group-chat audit: ${passed}/${passed} passed (${process.env.GROUP_REPORT_MONGO === '1' ? 'scratch Mongo on 27029; fake writer; no paid calls' : 'pure; fake writer; no connections or paid calls'})`)
