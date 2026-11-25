/**
 * THE SAME SUGGESTION, OVER AND OVER.
 *
 * Over one live 83-turn save the choice half offered 323 suggestions, 242 of
 * them distinct, and "Challenge Isolde's authority" came up SIXTEEN times
 * across the scene it belonged to — long after the player had declined it. It
 * is not a stuck loop (only 5 of 82 consecutive turn-pairs shared two labels);
 * it is a generator with no memory of its own output re-deriving the same
 * obvious move from the same standing situation.
 *
 * Telling the model about it was tried and MEASURED: listing the labels as "do
 * not repeat these" made repetition worse over the same 20 turns (5 repeats
 * blind, 13 informed) — naming them anchors on them. So it is arithmetic here.
 *
 * Applied to that save's shipped choices: 81 repeats -> 26, worst 16x -> 4x,
 * with all 242 distinct labels retained.
 *
 *   bun run audit:choice-repetition
 *   bun run audit:choice-repetition --bites
 */
import assert from 'node:assert/strict'
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { dropRepeatedChoices, normalizeChoiceText } from '../worker/lib/metadata-extractor'

let pass = 0
let fail = 0
function check(label: string, got: unknown, want: unknown) {
  if (JSON.stringify(got) === JSON.stringify(want)) { pass++; console.log(`  ok   ${label}`) }
  else { fail++; console.log(`  FAIL ${label}\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`) }
}
const c = (...labels: string[]) => labels.map((label) => ({ label }))
const move = (label: string, send: string) => ({ label, send })
const labels = (out: { label?: string }[]) => out.map((x) => x.label)

console.log('\nwhat the player has already passed on:')
check(
  'a repeat is dropped',
  labels(dropRepeatedChoices(c('Challenge Isolde’s authority', 'Read the report aloud', 'Leave the chamber'), ['Challenge Isolde’s authority'])),
  ['Read the report aloud', 'Leave the chamber'],
)
check(
  'casing and punctuation drift do not smuggle it back',
  labels(dropRepeatedChoices(c('challenge isoldes authority!', 'Read the report aloud', 'Leave the chamber'), ['Challenge Isolde’s authority'])),
  ['Read the report aloud', 'Leave the chamber'],
)
check(
  'a duplicate within one turn’s own set goes too',
  labels(dropRepeatedChoices(c('Wait', 'Wait', 'Speak', 'Leave'), [])),
  ['Wait', 'Speak', 'Leave'],
)
check('nothing recent, nothing dropped', labels(dropRepeatedChoices(c('A', 'B'), [])), ['A', 'B'])

console.log('\nthe move the player made THIS turn is not offered back:')
// The two stored turns the 2026-11-25 read found (context/ws-player-read.md).
check(
  'the Spanish storm question the player just sent is not offered back',
  labels(dropRepeatedChoices([
    move('Me inclino hacia adelante', '*Me inclino hacia adelante, curioso.* ¿Qué crees que traerá la tormenta?'),
    move('Esperar en silencio', '*Espero con la mirada fija en la puerta.*'),
    move('Salir de la habitación', '*Salgo sin decir nada.*'),
  ], [], 2, '¿Qué crees que traerá la tormenta?')),
  ['Esperar en silencio', 'Salir de la habitación'],
)
check(
  'the lamp-check move the player just sent is not offered back',
  labels(dropRepeatedChoices([
    move('Revisar el estado de la lámpara', '*Tomo un momento para revisar el estado de la lámpara.*'),
    move('Preguntar por Tomás', '*Pregunto a Mara por Tomás.*'),
    move('Guardar silencio', '*Me quedo callado un momento.*'),
  ], [], 2, '*Tomo un momento para revisar el estado de la lámpara.*')),
  ['Preguntar por Tomás', 'Guardar silencio'],
)
check(
  'an English repeat is dropped',
  labels(dropRepeatedChoices([
    move('Ask about the tide', 'I ask the innkeeper about the tide.'),
    move('Watch the water', '*I watch the water.*'),
    move('Leave', '*I leave the inn.*'),
  ], [], 2, 'I ask the innkeeper about the tide.')),
  ['Watch the water', 'Leave'],
)
check(
  'a spoken line inside a longer action is compared on its speech',
  labels(dropRepeatedChoices([
    move('Ask again', '*I lean closer, lowering my voice.* What are you hiding from me?'),
    move('Wait', '*I wait.*'),
    move('Leave', '*I leave.*'),
  ], [], 2, 'What are you hiding from me?')),
  ['Wait', 'Leave'],
)

console.log('\nthe set may shrink, never disappear:')
// A turn where the model produced only repeats must still offer the player
// something. Two is the floor, and the restored options are the ones it ranked
// first, not an arbitrary pair.
check(
  'a floor of two holds when every option is a repeat',
  labels(dropRepeatedChoices(c('A', 'B', 'C'), ['A', 'B', 'C'])),
  ['A', 'B'],
)
check(
  'a single fresh option is topped up to two',
  labels(dropRepeatedChoices(c('A', 'B', 'Fresh'), ['A', 'B'])),
  ['Fresh', 'A'],
)
check('a set already at the floor is untouched', labels(dropRepeatedChoices(c('A', 'B'), ['A', 'B'])), ['A', 'B'])
check('an empty set stays empty', labels(dropRepeatedChoices([], ['A'])), [])
check(
  'the floor of two holds when every option repeats the player line',
  labels(dropRepeatedChoices([
    move('Ask the innkeeper about the tide', 'I ask the innkeeper about the tide.'),
    move('Repeat the question', 'I ask the innkeeper about the tide.'),
    move('Press for an answer', 'I ask the innkeeper about the tide.'),
  ], [], 2, 'I ask the innkeeper about the tide.')),
  ['Ask the innkeeper about the tide', 'Repeat the question'],
)

console.log('\nit never invents or reorders the survivors:')
check(
  'surviving order is preserved',
  labels(dropRepeatedChoices(c('A', 'Keep1', 'B', 'Keep2'), ['A', 'B'])),
  ['Keep1', 'Keep2'],
)
check(
  'a blank label is not treated as a repeat of another blank',
  labels(dropRepeatedChoices([{ label: '' }, { label: '' }], [])),
  ['', ''],
)

console.log('\nlabels in any script, not only ASCII:')
check('accents fold rather than vanish', normalizeChoiceText('lâmpada'), 'lampada')
check('a Cyrillic label is not empty', normalizeChoiceText('Подождать'), 'подождать')
check(
  'a repeat with an accented label is now caught',
  labels(dropRepeatedChoices(c('Revisar a lampada', 'Wait', 'Leave'), ['Revisar a lâmpada'])),
  ['Wait', 'Leave'],
)
check(
  'a repeat with a Cyrillic label is now caught',
  labels(dropRepeatedChoices(c('подождать', 'Уйти', 'Смотреть'), ['Подождать'])),
  ['Уйти', 'Смотреть'],
)
// The old ASCII normaliser, kept here as the pre-change reference.
const oldNormalise = (value: string): string =>
  String(value || '').toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim()
const englishLabels = [
  'Challenge Isolde’s authority',
  'challenge isoldes authority!',
  'Take her hand',
  "Ask what she's hiding",
  'Draw your blade',
  'Wait',
  'Read the report aloud',
  'A1: go to the 2nd floor',
  '  spaced   out  ',
  'No trailing punctuation',
]
check(
  'every English label normalises exactly as before',
  englishLabels.map(normalizeChoiceText),
  englishLabels.map(oldNormalise),
)

if (fail > 0) {
  console.log(`\nchoice repetition audit: ${pass} passed, ${fail} failed`)
  process.exit(1)
}

if (process.argv.includes('--bites')) {
  await runBites()
} else {
  console.log(`\nchoice repetition audit: ${pass} passed, 0 failed`)
}

// ── bites ────────────────────────────────────────────────────────────────────
type Edit = [file: string, from: string, to: string]
type Mutation = { name: string; check: string; edits: Edit[] }

async function runBites() {
  const root = await mkdtemp(join(import.meta.dir, '.repetition-bites-'))
  const server = new URL('..', import.meta.url).pathname
  const AUDIT = 'scripts/choice-repetition-audit.ts'
  const extractor = 'worker/lib/metadata-extractor.ts'

  const mutations: Mutation[] = [
    {
      name: 'accents stop folding',
      check: 'a repeat with an accented label is now caught',
      edits: [[extractor, "    .normalize('NFKD')", "    .normalize('NFC')"]],
    },
    {
      name: 'the normaliser is ASCII again',
      check: 'a repeat with a Cyrillic label is now caught',
      edits: [[extractor, ".replace(/[^\\p{L}\\p{N} ]+/gu, '')", ".replace(/[^a-z0-9 ]/g, '')"]],
    },
    {
      name: 'the player’s own line is not compared',
      check: 'the Spanish storm question the player just sent is not offered back',
      edits: [[extractor, '    if (choiceRepeatsPlayerLine(choice, playerInput)) repeat = true', '    if (false) repeat = true']],
    },
    {
      name: 'the send is not compared',
      check: 'the lamp-check move the player just sent is not offered back',
      edits: [[extractor, '  for (const field of [choice?.label, choice?.send]) {', '  for (const field of [choice?.label]) {']],
    },
    {
      name: 'the floor is removed',
      check: 'the floor of two holds when every option repeats the player line',
      edits: [[extractor, '  while (kept.length < floor && dropped.length) {', '  while (false && kept.length < floor && dropped.length) {']],
    },
    {
      name: 'spaces stop being preserved',
      check: 'every English label normalises exactly as before',
      edits: [[extractor, ".replace(/\\s+/g, ' ')", ".replace(/\\s+/g, '')"]],
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
    console.log(`choice repetition bites: ${bitten}/${mutations.length} mutations rejected; scratch restored and removed`)
    if (bitten !== mutations.length) process.exit(1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}
