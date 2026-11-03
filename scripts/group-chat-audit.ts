import assert from 'node:assert/strict'
import { readFile, readdir, rm } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { mock } from 'bun:test'
import { Elysia } from 'elysia'
import { ObjectId } from 'mongodb'
import type { Job } from 'bullmq'
import { rollSpeakers, advanceSilence, pickAddressed, rollBystanders, pickSceneMembers } from '../src/services/group-chat/roll'
import { parseLines, filterLines, timeLines, emptyLineCounts, trimReply } from '../src/services/group-chat/lines'
import { buildGroupStatic, buildGroupDynamic, buildAddressedStatic } from '../src/services/group-chat/prompt'
import { GROUP_SCENE_MAX_WRITERS, GROUP_SCENE_DEADLINE_MS, GROUP_WRITER_TIMEOUT_MS, groupWriterHostFailed, writeGroupReply } from '../src/services/group-chat/reply'
import { missedDetailAtoms, dropAdultWriterClaims, refileSpokenFacts, clearEverydayAdultMarks, uncoveredAdultEvents, adultRetryAtoms, adultLineAtoms } from '../src/services/group-chat/curation'
import { validateGroup } from '../src/services/group-chat/validation'
import { filterGroupAtomAudiences } from '../src/services/group-chat/curation'
import { publicGroupData } from '../src/services/group-chat/public'
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
    { seed_cast: template.seed_cast!.slice(0, 3) },
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
import { ObjectId } from 'mongodb'
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
const eq = (a: unknown, b: unknown) => a instanceof ObjectId && b instanceof ObjectId ? a.equals(b) : a === b
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
let consentReadHook: (() => void) | undefined
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
    async insertOne(row: Row) { rows(name).push(clone(row)); return { insertedId: row._id } },
    async updateOne(filter: Row, update: Row, options?: { upsert?: boolean }) {
      let row = rows(name).find(row => matches(row, filter)); const existed = !!row
      if (!row && options?.upsert) { row = Object.fromEntries(Object.entries(filter).filter(([, value]) => !value || typeof value !== 'object' || value instanceof ObjectId || value instanceof Date)); rows(name).push(row); Object.assign(row, clone(update.$setOnInsert)) }
      if (row) {
        for (const [key, value] of Object.entries((update.$set || {}) as Row)) put(row, key, clone(value))
        for (const [key, value] of Object.entries((update.$inc || {}) as Row)) put(row, key, Number(get(row, key) || 0) + Number(value))
        for (const [key, value] of Object.entries((update.$max || {}) as Row)) if (get(row, key) === undefined || Number(get(row, key)) < Number(value)) put(row, key, value)
        for (const key of Object.keys((update.$unset || {}) as Row)) delete row[key]
      }
      return { matchedCount: existed ? 1 : 0, modifiedCount: existed ? 1 : 0 }
    },
    async updateMany(filter: Row, update: Row) {
      let modifiedCount = 0
      for (const row of rows(name).filter(row => matches(row, filter))) { await this.updateOne({ _id: row._id }, update); modifiedCount++ }
      return { modifiedCount }
    },
    async deleteMany(filter: Row) { const list = rows(name); const kept = list.filter(row => !matches(row, filter)); list.splice(0, list.length, ...kept); return { deletedCount: list.length - kept.length } },
    async deleteOne(filter: Row) { const index = rows(name).findIndex(row => matches(row, filter)); if (index >= 0) rows(name).splice(index, 1); return { deletedCount: index >= 0 ? 1 : 0 } },
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
const auditEnv = { NSFW_SAME_TURN_ROUTER: 'off', NSFW_SAME_TURN_ROUTER_MODEL: 'fake-router', NSFW_SAME_TURN_ROUTER_HOST: 'fixture' }
let routerRequests = 0, routerDelay = 0, routerSexual = true, routerError = false
mock.module('../src/config/env', () => ({ env: { ...auditEnv, get NSFW_SAME_TURN_ROUTER() { return auditEnv.NSFW_SAME_TURN_ROUTER }, CDN_BASE_URL: 'https://fixture.invalid', JWT_SECRET: 'audit-only', MEDIA_VOICE_ENABLED: false } }))
mock.module('../src/config/mongo', () => ({ mongoColl: new Proxy({}, { get: (_target, key) => () => collection(String(key)) }) }))
mock.module('../src/config/redis', () => ({ getRedisClient: () => redis, getQueueRedisClient: unavailable, getRedisSubscriber: unavailable }))
let judgeVerdict: boolean | 'error' | 'malformed' = true, judgeCalls: string[] = [], judgeGate: Promise<void> | undefined
const routerClient = { chat: { completions: { create: async (params: { messages: Array<{ content: string }> }) => {
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
mock.module('../src/services/llm-trace.service', () => ({ flushLLMTracesLater: () => {}, flushLLMTraces: async () => {}, traceStore: () => ({ calls: collection('llmCalls'), bodies: collection('llmBodies') }), runBackgroundLLMTrace: async (scope: Row, fn: () => Promise<unknown>) => { backgroundScopes.push(scope); return fn() } }))
let ragSummaryHits: Array<{ id: string; tier: 'scene' | 'chapter' | 'arc'; text: string; startSequence: number; endSequence: number }> = []
let ragMemoryTexts = ['Remembered group fact.'], ragOpenThreads: string[] = [], ragCalls: unknown[][] = []
mock.module('../src/providers/rag.provider', () => ({ queryRag: async (...args: unknown[]) => { ragCalls.push(args); return { memoryTexts: ragMemoryTexts, openThreads: ragOpenThreads } }, querySummaries: async () => ragSummaryHits }))
mock.module('../src/services/post-process-outbox.service', () => ({ stagePostProcess: async (input: Row) => { outbox.push(input) }, dispatchPostProcessOutbox: async () => 0 }))
mock.module('../src/services/media/attribution', () => ({ ATTRIBUTION_RULE_VERSION: 'audit', mediaRevision: () => 'audit' }))
mock.module('../src/services/moderation.service', () => ({ moderationService: { discoveryFilter: async () => ({}) } }))
const checkLogs: Row[] = [], memoryLogs: Row[] = []
mock.module('../src/utils/logger', () => ({ log: { info: (name: string, data: Row) => { if (name === 'group.reply_checked') checkLogs.push(data); memoryLogs.push({ name, ...data }) }, warn: (name: string, data: Row) => { memoryLogs.push({ name, ...data }) }, error: () => {} } }))
mock.module('../src/services/time.service', () => ({ timeService: { initialAnchor: async (input: Row) => { assert.equal(input.templateId, undefined); return { real_time: new Date(), sequence: 0, timeline_id: 'main' } } } }))
mock.module('../src/services/opening-place.service', () => ({ extractOpeningPlace: unavailable }))
mock.module('../src/services/character-codex.service', () => ({ characterCodexService: { seedProtagonist: unavailable }, foldDelta: unavailable, newFoldState: unavailable, isEphemeralPersonDescriptor: unavailable, isNonPersonRole: unavailable, rankCodexForInjection: unavailable, identityKey: unavailable }))
mock.module('../src/services/kinship-graph.service', () => ({ kinshipGraphService: { seedPremiseKinship: unavailable } }))
mock.module('../src/services/template-cast.service', () => ({ materializeTemplateCast: async (input: { instanceId: string; template: WorldTemplateDoc }) => { const cast = input.template.seed_cast!; rows('characters').push(...cast.map((member, index) => ({ _id: new ObjectId((index + 1).toString(16).padStart(24, '0')), instance_id: new ObjectId(input.instanceId), canonical_name: member.name }))); return cast.length } }))
mock.module('../worker/lib/template-cast-extractor', () => ({ extractTemplateCast: unavailable }))
const vectors = new Map<string, Row>()
mock.module('../src/services/vector-store', () => ({ vectorStore: { replaceLore: unavailable, deleteScope: async () => { vectors.clear() }, fetch: async (_scope: Row, ids: string[]) => ({ records: Object.fromEntries(ids.filter(id => vectors.has(id)).map(id => [id, vectors.get(id)])) }), upsert: async (_scope: Row, values: Row[]) => { for (const value of values) vectors.set(String(value.id), value) }, deleteIds: async (_scope: Row, ids: string[]) => { for (const id of ids) vectors.delete(id) } } }))
mock.module('../src/services/entity-graph.service', () => ({ normalizeEntityName: (text: string) => text.toLowerCase(), entityGraphService: { ensurePlayerEntity: async () => ({ _id: new ObjectId() }), resolveOrCreateEntities: async () => new Map(), upsertNarrativeEdge: async () => {} } }))
mock.module('../src/constants/default-cover', () => ({ isDefaultCoverUrl: () => false, resolveTemplateImageUrl: async () => 'https://fixture.invalid/cover.webp' }))
mock.module('../src/services/media/deletion', () => ({ purgeMedia: async () => {}, purgeCardPortraits: async () => {}, purgeTemplatePortraits: async () => {} }))
mock.module('../src/services/telemetry/ingest.service', () => ({ telemetryService: { purgeUser: async () => {} } }))
mock.module('../src/services/account-references', () => ({ purgeAccountReferences: async () => {} }))
mock.module('../src/services/storage.service', () => ({ storageService: {} }))
mock.module('../src/services/billing-config.service', () => ({ resolveProfile: unavailable, effectiveBilling: async () => ({ promo: { unlimited: true, daily_turn_cap: 500 }, costs: { story_turn: 1 } }) }))
mock.module('../src/services/google-play.service', () => ({ googlePlayService: { configured: () => false } }))
mock.module('../src/services/auth.service', () => ({ authService: { getLiveAccess: async () => ({ tier: 'creator', account_status: 'active' }) }, defaultUserPreferences: () => ({}) }))
let routeUser: { id: string; tier: string } | null = null
mock.module('../src/middleware/auth', () => ({ verifyWsToken: unavailable,
  authPlugin: new Elysia().derive({ as: 'scoped' }, () => ({ user: routeUser })),
}))
mock.module('../src/middleware/rate-limit', () => ({ rateLimit: async () => ({ allowed: true }) }))
mock.module('../src/services/last-active.service', () => ({ recordLastActive: () => {} }))
mock.module('../src/queues', () => ({ getMemoryCurationQueue: unavailable, removeQueuedJobsForInstance: async () => {}, getGenerationQueue: () => ({ add: async (_name: string, data: Row, options: Row) => { queued.push(data); return { id: options.jobId } } }), getSceneSummaryQueue: () => ({ add: async (_name: string, data: Row) => { queued.push(data) } }), QUEUE_RETENTION: { sceneSummary: {}, generation: { removeOnComplete: 10, removeOnFail: 10 } } }))
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
mock.module('../src/ai', () => ({ AI_MODELS: { memoryCuration: 'fixture-curator', sceneSummary: 'fixture-summary', chapterSummary: 'fixture-chapter', arcSummary: 'fixture-arc', narrationSfw: 'fake-safe', narrationNsfw: 'fake-story-adult', groupNsfw: 'fake-adult', groupNsfwFallbacks: ['fake-adult-fallback', 'fake-adult-last'], narrationSfwFallbacks: ['fake-safe-fallback'], narrationNsfwFallbacks: ['fake-adult-fallback'] }, narrationTemperature: () => 0.62, snapshotLLMUsage: () => [],
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
  callLLMWithFallback: async (request: Row) => { writerCalls.push(request); await writerHook?.(request); const response = modelReplies.shift(); if (response instanceof Error) throw response; if (response && typeof response === 'object') return { ...response, model: request.model }; return { content: response ?? `${names[0]}: Fresh response ${turnNumber++}`, model: request.model } }, embedQuery: unavailable, embedBatch: unavailable, callLLMStream: unavailable, callLLMStreamWithFallback: unavailable, isEmbedTimeout: () => false,
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
const { dispatchGroupTurn } = await import('../src/services/group-chat/dispatch')
const { validateEntry } = await import('./seed-catalog')
const originalRandom = Math.random
Math.random = () => 0
const playerId = '300000000000000000000001'
let instanceId = ''
async function start(source = groupTemplate(), player = playerName) {
  bondReply = { changes: [] }; bondRequests = []; bondHook = undefined; ragSummaryHits = []; tables.clear(); vectors.clear(); curatorRequests = []; summaryRequests = []; summaryReply = 'A named summary.'; curatorHook = undefined; summaryHook = undefined; embedHook = undefined; curatorFactory = undefined; ragMemoryTexts = ['Remembered group fact.']; ragOpenThreads = []; ragCalls = []; memoryLogs.length = 0; backgroundScopes.length = 0; frames.length = 0; locks.clear(); queued.length = 0; outbox.length = 0; writerCalls = []; modelReplies = []; writerHook = undefined; consentReadHook = undefined; checkLogs.length = 0; auditEnv.NSFW_SAME_TURN_ROUTER = 'off'; routerRequests = 0; routerDelay = 0; routerSexual = true; routerError = false
  rows('users').push({ _id: new ObjectId(playerId), preferences: { nsfw_enabled: false, player_name: player } })
  rows('worldTemplates').push(clone(source) as unknown as Row)
  const created = await instanceService.create(playerId, template._id.toHexString(), 'creator')
  instanceId = created.instance._id.toHexString()
  return created
}
let backgroundWork: Promise<void>[] = []
async function turn(data: Partial<GroupTurnJob> = {}, rng?: () => number) {
  const id = crypto.randomUUID(); locks.set(`lock:gen:${playerId}:${instanceId}`, JSON.stringify({ owner: id, phase: 'running' }))
  return groupTurnProcessor({ id, data: { instanceId, playerId, userMessage: 'A player message', ...data } } as Job<GroupTurnJob>, { rng, onBackground: work => { backgroundWork.push(work) } })
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
  const line = (frame.lines as Row[])[0]; assert.deepEqual(Object.keys(line).sort(), ['characterId', 'name', 'shownAt', 'text'])
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
  assert.equal(files.length, 3)
  const groups: WorldTemplateDoc[] = []
  for (const file of files) {
    const data = JSON.parse(await readFile(`${dir}/${file}`, 'utf8'))
    validateEntry(data, file)
    groups.push({ ...groupTemplate(), ...data })
  }
  assert.equal(groups.reduce((sum, group) => sum + group.seed_cast!.length, 0), 15)
  return groups
}
await check('authored player placeholders resolve per call for all fifteen addressed prompts', async () => {
  let checked = 0
  for (const group of await authoredGroups()) for (const member of group.seed_cast!) {
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
  assert.equal(checked, 15)
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
      const fresh = `${member.name}: Fresh answer for case ${cases}.`
      const chain = ['fake-adult', 'fake-adult-fallback', 'fake-adult-last']
      modelReplies = scenario === 'empty' ? ['', fresh] : scenario === 'rescue' ? [new Error('writer unavailable'), ...chain.slice(1).map(() => ''), '', '', fresh]
        : scenario === 'voice' ? [`${member.name}: ${member.group!.voice![0]}`, fresh] : [fresh]
      await turn({ userMessage: `@${member.name} answer me` }, () => 0)
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
      if (scenario === 'voice') assert.equal(checkLogs.at(-1)!.copied_example, 1)
      cases++
    }
  }
  assert.equal(cases, 75)
  console.log(`authored tagged reachability: ${cases}/75 cases produced the tagged member's line`)
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
  const world = { ...groupTemplate(), _id: new ObjectId(), kind: 'world', starter: true }; rows('worldTemplates').push(world as unknown as Row)
  rows('worldTemplates')[0].starter = true
  assert.equal((await templateService.listPublished(1, 20, undefined, undefined, { sort: 'new' })).templates.length, 1)
  const groups = await templateService.listPublished(1, 20, undefined, undefined, { kind: 'group', sort: 'new' })
  assert.equal(groups.templates.length, 1); assert.equal(groups.templates[0].kind, 'group')
  assert.equal((await templateService.starter(playerId))?.kind, 'world')
  assert.equal((await templateService.listByCreator(template.creator_id.toHexString())).templates.length, 1)
  const genres = await templateService.listGenres(undefined, Date.now() + 120000)
  assert.equal(genres.genres.reduce((sum, genre) => sum + genre.worlds + genre.characters, 0), 1)
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
    const labels: string[] = []
    for (const file of authored) { const group = JSON.parse(await readFile(`${dataDir}/${file}`, 'utf8')); labels.push(group.title, group.slug, ...group.seed_cast.map((member: { name: string }) => member.name)); validateEntry(group, file) }
    async function visit(path: string) { for (const entry of await readdir(path, { withFileTypes: true })) { const next = `${path}/${entry.name}`; if (entry.isDirectory()) await visit(next); else if (entry.name.endsWith('.ts')) { const source = await readFile(next, 'utf8'); for (const label of labels) assert(!new RegExp(`(?<![A-Za-z])${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z])`).test(source), `${next} names ${label}`) } } }
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
  const everyday = raisedMemories(`what again`, [{ text: 'Priya asked what the noise was again.', importance: 1 }] as never, [])
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
  source.seed_cast![0].name = 'Jess'; source.seed_cast![1].name = 'Priya'
  source.opening_lines = [{ name: 'Jess', text: 'An audience fixture opens.' }]
  await start(source); addEvents(40)
  const cast = members.map((member, index) => ({ ...member, name: source.seed_cast![index].name }))
  return { cast, jess: cast[0], priya: cast[1] }
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
  const { cast, jess, priya } = await audienceFixture()
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
  assert(!(await fixtureDirectPrompt(cast, priya.id, ragMemoryTexts, ragOpenThreads, raisedBy)).includes(text))
  // The same helper is used by ordinary group, addressed and bystander calls.
  for (const speakers of [[jess.name], [priya.name], [jess.name, priya.name]]) {
    const memory = await groupWriterMemory({ instanceId: new ObjectId(instanceId), player: playerName,
      speakers, enabled: true, thread: undefined, memories: ragMemoryTexts, openThreads: ragOpenThreads, raisedBy })
    assert(!JSON.stringify(memory).includes(text))
  }
  writerCalls = []; modelReplies = ['Jess: A fresh shared reply.']
  await turn({ userMessage: '@Jess continue' }, never)
  assert(writerCalls.length); assert(writerCalls.every(request => !requestText(request).includes(text)))
  put(rows('users')[0], 'preferences.nsfw_enabled', true); auditEnv.NSFW_SAME_TURN_ROUTER = 'on'
  writerCalls = []; modelReplies = ['Jess: Another shared reply.', 'Priya: A bystander reply.']
  await turn({ userMessage: '@Jess @Priya albatross' }, never)
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
  const { cast, jess, priya } = await audienceFixture()
  const source = storedEvents().at(-1)!
  source.data.dm_with = jess.id; source.data.player_input = 'Private recent envelope marker.'
  source.data.lines = [{ character_id: jess.id, text: 'Private Jess recent answer.', shown_at: new Date() }]
  const privateSummary = 'Private Jess summary marker.'
  rows('sceneSummaries').push({ _id: new ObjectId(), instance_id: new ObjectId(instanceId), status: 'active', private_to: jess.id, summary_text: privateSummary,
    event_range: { start_sequence: source.sequence, end_sequence: source.sequence } })
  ragSummaryHits = [{ id: 'fixture-private-summary', tier: 'scene', text: privateSummary, startSequence: source.sequence, endSequence: source.sequence }]
  const summaryInput = ragSummaryHits
  assert.deepEqual(await groupWriterSummaries(new ObjectId(instanceId), summaryInput, jess.id), [privateSummary])
  for (const thread of [undefined, priya.id]) {
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
  writerCalls = []; modelReplies = ['Jess: A public addressed answer.', 'Priya: A public bystander answer.']
  await turn({ userMessage: '@Jess @Priya continue' }, never)
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
  const { cast, jess, priya } = await audienceFixture()
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
  assert.deepEqual(await groupWriterSummaries(iid, candidates, priya.id), ['Shared scene summary marker.'])
  const own = await groupWriterSummaries(iid, candidates, jess.id)
  assert.deepEqual(own, ['Private scene summary marker.', 'Shared scene summary marker.'])
  const directRequest = await fixtureDirectPrompt(cast, jess.id, [], [], undefined, own)
  assert(directRequest.includes('Private scene summary marker.'))
  const otherRequest = await fixtureDirectPrompt(cast, priya.id, [], [], undefined, await groupWriterSummaries(iid, candidates, priya.id))
  assert(!otherRequest.includes('Private scene summary marker.'))
  // Move summaries outside the recent window and exercise the real group writer.
  addEvents(35); writerCalls = []; ragSummaryHits = []
  modelReplies = ['Jess: A shared summary answer.']
  await turn({ userMessage: '@Jess continue' }, never)
  assert(writerCalls.some(request => requestText(request).includes('Shared scene summary marker.')))
  assert(writerCalls.every(request => !requestText(request).includes('Private scene summary marker.')))
  // Retrieval cannot invent an audience, text or coverage on a stored row.
  for (const invalid of [null, 'unknown', priya.id]) {
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
await check('direct real Jess and Priya prompts separate history memories summaries retrieval context and group block', async () => {
  const { jess, priya } = await audienceFixture()
  const events = storedEvents()
  const secret = events[2], other = events[3]
  secret.data.dm_with = jess.id; secret.data.player_input = 'Private Jess envelope.'; secret.data.lines![0].text = 'Private Jess reply.'
  other.data.dm_with = priya.id; other.data.player_input = 'Private Priya copper.'; other.data.lines![0].character_id = priya.id; other.data.lines![0].text = 'Private Priya reply.'
  const summaryText = 'Private Jess old summary.'
  rows('sceneSummaries').push({ _id: new ObjectId(), instance_id: new ObjectId(instanceId), private_to: jess.id, summary_text: summaryText,
    event_range: { start_sequence: secret.sequence, end_sequence: secret.sequence }, status: 'active' })
  ragSummaryHits = [{ id: 'stored', tier: 'scene', text: summaryText, startSequence: secret.sequence, endSequence: secret.sequence }]
  const mem = (text: string, source: typeof secret, privateTo?: string) => ({ _id: new ObjectId(), instance_id: new ObjectId(instanceId),
    player_id: new ObjectId(playerId), text, subjects: ['player'], objects: [], is_archived: false, importance: 4,
    source_event_ids: [source._id], ...(privateTo ? { private_to: privateTo } : {}), updated_at: new Date() })
  rows('memories').push(mem('Shared memory marker.', events[1]), mem('Jess memory marker.', secret, jess.id), mem('Priya memory marker.', other, priya.id))
  const expectedBlock = groupMessages(events, playerName, [jess, priya, ...members.slice(2)]).slice(-8).map(line => `${line.name}: ${line.text}`).join('\n')
  modelReplies = ['Jess: A direct reply from her.']; writerCalls = []; ragCalls = []
  await turn({ directWith: jess.id, userMessage: 'Jess current private line.' }, never)
  const body = requestText(writerCalls[0])
  for (const value of ['Private Jess envelope.', 'Private Jess reply.', summaryText, 'Jess memory marker.', 'Shared memory marker.', expectedBlock]) assert(body.includes(value), value)
  for (const value of ['Private Priya copper.', 'Private Priya reply.', 'Priya memory marker.']) assert(!body.includes(value), value)
  assert.deepEqual(ragCalls[0][9], { thread: jess.id })
  assert.equal(ragCalls[0][2], `${playerName}: Private Jess envelope.\nJess: Private Jess reply.\n${playerName}: Jess current private line.`)
  const boundary = storedEvents().length
  addEvents(8, jess)
  for (const event of storedEvents().slice(boundary)) event.data.dm_with = jess.id
  writerCalls = []; ragCalls = []; modelReplies = ['Priya: A direct reply from her.']
  await turn({ directWith: priya.id, userMessage: 'Priya current private line.' }, never)
  const priyaBody = requestText(writerCalls[0])
  assert(priyaBody.includes(expectedBlock))
  for (const value of ['Private Priya copper.', 'Private Priya reply.', 'Priya memory marker.', 'Shared memory marker.']) assert(priyaBody.includes(value), value)
  assert(!/Private Jess|Jess memory marker|Jess current private/.test(priyaBody))
  assert.deepEqual(ragCalls[0][9], { thread: priya.id })
  assert(!String(ragCalls[0][2]).includes('Jess'))
  writerCalls = []; ragCalls = []; modelReplies = ['Jess: A shared fresh reply.']
  await turn({ userMessage: '@Jess Hello group.' }, never)
  assert(writerCalls.every(request => !/Private Jess|Private Priya|memory marker\.|current private|Group chat \(read-only/.test(requestText(request).replace('Shared memory marker.', ''))))
  assert(ragCalls.every(call => !/Private Jess|Private Priya|current private/.test(String(call[2]))))
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
    assert.deepEqual(rows('worldInstances')[0].group_state, before)
    assert.deepEqual(storedEvents().at(-1)!.data.group_state_after, before)
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
  await memoryService.rewindToSequence(instanceId, playerId, 4)
  assert.deepEqual(storedEvents().map(event => event.sequence), [1, 2, 3])
  assert.deepEqual(rows('worldInstances')[0].group_state, keep)
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
    assert(content(writerCalls[index], 1).includes(`This is a scene with ${playerName} and `))
    assert(content(writerCalls[index], 1).includes(`${names[member]} can answer what they just said or did, and can do things with them too.`))
    // The player's line stays last, so the writer answers it and not the instruction.
    assert(content(writerCalls[index], 1).trim().endsWith(order.map(member => `@${names[member]}`).join(' ')))
    for (let prior = 0; prior < index; prior++) for (let line = 0; line < 3; line++) assert(content(writerCalls[index], 1).includes(`Fresh${line} item ${prior}.`))
  }
  assert(!requestText(writerCalls[3]).includes('This is a scene with '))
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
  assert.deepEqual(get(frames.find(frame => frame.type === 'generation_complete')!, 'event.lines'), JSON.parse(JSON.stringify(stored)))
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
  assert(writerCalls.every(call => !requestText(call).includes('This is a scene with ')))
  writerCalls = []; modelReplies = [`${names[0]}: Private answer.`]
  await turn({ directWith: ids[0], userMessage: `@${names[0]} @${names[2]}` }, never)
  assert.equal(writerCalls.length, 1); assert(!Object.hasOwn(lastData(), 'scene_members'))
  assert(!requestText(writerCalls[0]).includes('This is a scene with '))
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
  assert(!requestText(writerCalls[0]).includes('This is a scene with '))
  const trace = { requests: writerCalls.map(call => ({ ...call, sessionId: 'fixture', messages: (call.messages as Row[]).map(message => ({ ...message, content: String(message.content).replace(/It's [^\n]+\./, "It's CLOCK.") })) })),
    data: { ...data, group_state_after: 'fixture', lines: (data.lines as Row[]).map(({ shown_at: _shown, ...line }) => line) },
    shown: shown.map(frame => ({ ...frame, instanceId: 'fixture', eventId: 'fixture', lines: (frame.lines as Row[]).map(({ shownAt: _shown, ...line }) => line) })) }
  const hash = createHash('sha256').update(JSON.stringify(trace)).digest('hex')
  assert.equal(hash, '53dd3535d0a1fdce0b1b88e0784ac2af519fd0d962e0dbf17f1ababdec79bbd0', hash)
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

await check('nway recall plan has mixed eight-turn cast sequence and requested observability without calls', async () => {
  const { nwayTurns } = await import('./group-chat-fixtures')
  const plan = nwayTurns(names)
  assert.equal(plan.length, 8)
  assert.equal(plan.filter(turn => turn.kind === 'action').length, 4)
  assert(plan.every(turn => [2, 3].includes(turn.speakers.length)))
  assert.deepEqual(new Set(plan.flatMap(turn => turn.speakers)), new Set(names))
  const outputDir = `${import.meta.dir}/.nway-plan-${process.pid}`
  try {
    const child = Bun.spawn(['bun', '--no-env-file', 'run', 'scripts/group-memory-recall.ts', '--scene=nway', '--plan'], {
      cwd: new URL('..', import.meta.url).pathname, stdout: 'pipe', stderr: 'pipe', stdin: 'ignore',
      env: { ...process.env, OPENROUTER_API_KEY: 'offline-fixture', OPENAI_API_KEY: 'offline-fixture', JWT_SECRET: 'offline-fixture', GROUP_MEMORY_RECALL_OUTPUT_DIR: outputDir },
    })
    const [output, errors, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    assert.equal(code, 0, output + errors)
    for (const expected of ['plan nway: flat-4b cast', 'untagged continuation', 'one tag', 'one question per member', 'toggle-off', 'each writer and model', 'group_lines payload and elapsed milliseconds', 'full system and per-turn prompts', 'no calls made']) assert(output.includes(expected), expected)
    assert.equal((output.match(/  \d: (message|action):/g) || []).length, 8)
  } finally { await rm(outputDir, { recursive: true, force: true }) }
})

Math.random = originalRandom
console.log(`group-chat audit: ${passed}/${passed} passed (pure; fake writer; no connections or paid calls)`)
