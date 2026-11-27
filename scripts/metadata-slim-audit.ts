/**
 * METADATA-SLIM: the buttons call writes only the buttons. The stat and flag
 * changes, the scene tag and the tone moved to the scene witness call, so the
 * buttons half no longer depends on which model answered it.
 *
 * Covers:
 *   (a) the `choice_metadata` request's system carries none of the four moved
 *       rule lines and its schema none of the four properties (English and
 *       non-English, split and unsplit), and the answer's own copies of the four
 *       are ignored.
 *   (b) the `scene_witness` request's system carries each of the four rule lines
 *       exactly as in METADATA_RULES and the stats/flags handed to it, and its
 *       schema requires the four properties.
 *   (c) `extractSceneMetadata` merges scene tag, mutations and tone from the
 *       witness answer, not the buttons answer.
 *   (d) a witness outage keeps the buttons and the adult `intimate` tag; a
 *       buttons outage keeps the witness's tag and mutations.
 *   (e) the split ledger request is byte-identical to the one pinned before this
 *       change.
 *
 * Pure: every model call is injected. No network, no DB.
 *
 *   bun --no-env-file run scripts/metadata-slim-audit.ts
 *   bun --no-env-file run scripts/metadata-slim-audit.ts --bites
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import {
  extractChoiceMetadata,
  extractSceneMetadata,
  extractSceneWitness,
  type MetadataOpts,
} from '../worker/lib/metadata-extractor'

const EXTRACTOR = new URL('../worker/lib/metadata-extractor.ts', import.meta.url)

const FIXTURE_PROSE = 'Mara steps into the hall and sets her wet coat aside.'
const FIXTURE_STATS = [{ name: 'resolve', min: 0, max: 100, description: 'how steady the protagonist holds' }]
const FIXTURE_FLAGS = ['listened']
const FIXTURE_OPTS: MetadataOpts = {
  isSentient: true,
  currentLocationName: 'the hall',
  priorPresent: ['Mara'],
  protagonist: { name: 'Nell', aliases: ['the visitor'] },
  roster: [{ name: 'Mara', aliases: ['the steward'] }],
  knownPlaces: [{ name: 'the hall', aliases: ['great hall'] }],
  playerInput: '*I wait by the door.*',
  worldContext: 'A quiet manor drama.',
  choiceContext: 'Mara served the household for years.',
  recentChoiceLabels: [],
}

/** The four rule lines, read from the source so the audit compares against the
 *  exact text the prompt carries rather than a copy that can drift. */
const MOVED_RULE_PREFIXES = ['- state_mutations:', '- flag_mutations:', '- scene_tag:', '- emotional_tone:']
const source = await readFile(EXTRACTOR, 'utf8')
const rulesText = source.slice(source.indexOf('const METADATA_RULES = `') + 'const METADATA_RULES = `'.length)
const METADATA_RULES = rulesText.slice(0, rulesText.indexOf('`'))
const MOVED_RULES = MOVED_RULE_PREFIXES.map((prefix) => {
  const lines = METADATA_RULES.split('\n').filter((line) => line.startsWith(prefix))
  assert.equal(lines.length, 1, `METADATA_RULES must carry exactly one "${prefix}" line`)
  return lines[0]
})

const WITNESS_RAW = JSON.stringify({
  present_characters: ['Mara'],
  characters_departed: [],
  physical_state_opened: [],
  physical_state_closed: [],
  current_location: 'the hall',
  player_destination: null,
  player_travel_confirmed: false,
  location_evidence: 'steps into the hall',
  location_evidence_source: 'narrative',
  containment_hint: null,
  movement: 'lateral',
  viewpoint_moved: true,
  time_elapsed: null,
  time_evidence: null,
  location_state_changes: [],
  location_permanent_facts: [],
  state_mutations: { resolve: { op: 'add', value: 2 } },
  flag_mutations: { listened: { op: 'set', value: true } },
  scene_tag: 'intimate',
  emotional_tone: 'tender',
})
const CHOICE_RAW = JSON.stringify({
  beat_ledger: { npc_beats: [], emotional_shift: null, setting: null, consequence: null, unresolved_hook: null },
  choices: [{ label: 'Ask why she left', kind: 'say', send: 'Why did you stay away so long?' }],
  milestone: null,
})
const PAIRED_CHOICE_RAW = JSON.stringify({
  choices: [{
    label: 'Ask why she left',
    kind: 'say',
    send: 'Why did you stay away so long?',
    label_local: 'Perguntar por que ela saiu',
    send_local: 'Por que você ficou tanto tempo fora?',
  }],
  milestone: null,
})
/** A buttons answer that still carries the four moved fields (the old shape):
 *  they must be ignored now that the witness owns them. */
const STALE_CHOICE_RAW = JSON.stringify({
  state_mutations: { resolve: { op: 'subtract', value: 9 } },
  flag_mutations: { listened: { op: 'set', value: false } },
  scene_tag: 'combat',
  emotional_tone: 'furious',
  choices: [{ label: 'Ask why she left', kind: 'say', send: 'Why did you stay away so long?' }],
  milestone: null,
})

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

const byPurpose = (requests: Array<Record<string, any>>, purpose: string) =>
  requests.filter((request) => request.purpose === purpose)

/**
 * A stubbed transport. `throws` lists the purposes that fail; every other
 * purpose answers its purpose's fixture.
 */
function stub(options: { throws?: string[]; choice?: string } = {}) {
  const requests: Array<Record<string, any>> = []
  const call = async (request: Record<string, any>) => {
    requests.push(JSON.parse(JSON.stringify(request)))
    if (options.throws?.includes(request.purpose)) throw new Error(`stub failure: ${request.purpose}`)
    if (request.purpose === 'choice_metadata') return options.choice ?? CHOICE_RAW
    if (request.purpose === 'scene_witness') return WITNESS_RAW
    return '{"beat_ledger":{"npc_beats":[],"emotional_shift":null,"setting":null,"consequence":null,"unresolved_hook":null}}'
  }
  return { requests, call }
}

const MOVED_PROPERTIES = ['state_mutations', 'flag_mutations', 'scene_tag', 'emotional_tone']

// ── (a) the buttons half no longer asks for the four ────────────────────────
await check('(a) the choice request carries no moved rule line or property, and ignores the answer\'s own four (English and non-English, split and unsplit)', async () => {
  for (const language of [undefined, { name: 'Brazilian Portuguese', narrative: FIXTURE_PROSE, playerInput: 'Quanto tempo você ficou fora?' }]) {
    for (const split of [false, true]) {
      const { requests, call } = stub({ choice: language ? PAIRED_CHOICE_RAW : CHOICE_RAW })
      const opts: MetadataOpts = { ...FIXTURE_OPTS, call, ...(language ? { choiceLanguage: language } : {}) }
      const result = await extractChoiceMetadata(FIXTURE_PROSE, FIXTURE_STATS, FIXTURE_FLAGS, opts, { split })
      const request = byPurpose(requests, 'choice_metadata')[0]
      const where = `language=${language ? language.name : 'none'} split=${split}`
      const system = request.messages[0].content as string
      for (const rule of MOVED_RULES) {
        assert.equal(system.includes(rule), false, `${where}: the choice system still teaches "${rule.slice(0, 20)}"`)
      }
      const schema = request.responseSchema as { properties: Record<string, unknown>; required: string[] }
      for (const property of MOVED_PROPERTIES) {
        assert.equal(property in schema.properties, false, `${where}: the choice schema still declares ${property}`)
        assert.equal(schema.required.includes(property), false, `${where}: the choice schema still requires ${property}`)
      }

      // The old shape's four fields must be ignored, not merged back in.
      const stale = stub({ choice: language ? PAIRED_CHOICE_RAW : STALE_CHOICE_RAW })
      const staleResult = await extractChoiceMetadata(FIXTURE_PROSE, FIXTURE_STATS, FIXTURE_FLAGS, { ...opts, call: stale.call }, { split })
      assert.equal(staleResult.scene_tag, 'dialogue', `${where}: the buttons answer must not set the scene tag`)
      assert.equal(staleResult.emotional_tone, 'neutral', `${where}: the buttons answer must not set the tone`)
      assert.deepEqual(staleResult.state_mutations, {}, `${where}: the buttons answer must not set stats`)
      assert.deepEqual(staleResult.flag_mutations, {}, `${where}: the buttons answer must not set flags`)
      assert.ok(result.choices.length > 0, `${where}: the buttons must survive`)
    }
  }
})

// ── (b) the witness half now asks for them ──────────────────────────────────
await check('(b) the witness request teaches the four rules, names the stats and flags, and requires the four properties', async () => {
  const { requests, call } = stub()
  await extractSceneWitness(FIXTURE_PROSE, { ...FIXTURE_OPTS, call }, FIXTURE_STATS, FIXTURE_FLAGS)
  const request = byPurpose(requests, 'scene_witness')[0]
  const system = request.messages[0].content as string
  for (const rule of MOVED_RULES) {
    assert.ok(system.includes(rule), `the witness system is missing "${rule.slice(0, 20)}"`)
  }
  assert.ok(system.includes('Tracked stats (only these names may appear in state_mutations): resolve [0–100]: how steady the protagonist holds'), 'the witness must be given the tracked stats')
  assert.ok(system.includes('Tracked flags (only these names may appear in flag_mutations): listened'), 'the witness must be given the tracked flags')
  const schema = request.responseSchema as { properties: Record<string, unknown>; required: string[] }
  for (const property of MOVED_PROPERTIES) {
    assert.equal(property in schema.properties, true, `the witness schema must declare ${property}`)
    assert.equal(schema.required.includes(property), true, `the witness schema must require ${property}`)
  }
  assert.equal(request.maxTokens, 720)
})

// ── (c) the merge takes them from the witness ───────────────────────────────
await check('(c) the merged result carries scene tag, mutations and tone from the witness answer', async () => {
  const { call } = stub()
  const merged = await extractSceneMetadata(FIXTURE_PROSE, FIXTURE_STATS, FIXTURE_FLAGS, { ...FIXTURE_OPTS, call })
  assert.equal(merged.scene_tag, 'intimate', 'the scene tag must come from the witness')
  assert.equal(merged.emotional_tone, 'tender', 'the tone must come from the witness')
  assert.deepEqual(merged.state_mutations, { resolve: { op: 'add', value: 2 } }, 'the stat changes must come from the witness')
  assert.deepEqual(merged.flag_mutations, { listened: { op: 'set', value: true } }, 'the flag changes must come from the witness')
  assert.ok(merged.choices.length > 0, 'the buttons must still be there')
})

// ── (d) one half failing never takes the other's fields with it ─────────────
await check('(d) a witness outage keeps the buttons and the adult intimate tag; a buttons outage keeps the witness\'s tag and mutations', async () => {
  const witnessDown = stub({ throws: ['scene_witness'] })
  const withoutWitness = await extractSceneMetadata(FIXTURE_PROSE, FIXTURE_STATS, FIXTURE_FLAGS, { ...FIXTURE_OPTS, call: witnessDown.call })
  assert.ok(withoutWitness.choices.length > 0, 'the witness outage must not lose the buttons')
  assert.equal(withoutWitness.scene_tag, 'intimate', 'a witness outage keeps the adult momentum')
  assert.deepEqual(withoutWitness.state_mutations, {}, 'a witness outage reports no stat change')

  const witnessSays = JSON.parse(WITNESS_RAW)
  witnessSays.scene_tag = 'romantic'
  witnessSays.state_mutations = { heat: { op: 'add', value: 3 } }
  const choiceDown = async (request: Record<string, any>) => {
    if (request.purpose === 'choice_metadata') throw new Error('stub failure: choice_metadata')
    return JSON.stringify(witnessSays)
  }
  const withoutButtons = await extractSceneMetadata(FIXTURE_PROSE, FIXTURE_STATS, FIXTURE_FLAGS, { ...FIXTURE_OPTS, call: choiceDown })
  assert.deepEqual(withoutButtons.choices, [], 'a buttons outage leaves no buttons')
  assert.equal(withoutButtons.scene_tag, 'romantic', 'the witness tag survives a buttons outage')
  assert.deepEqual(withoutButtons.state_mutations, { heat: { op: 'add', value: 3 } }, 'the witness mutations survive a buttons outage')
})

// ── (e) the ledger request is untouched ─────────────────────────────────────
// Pinned from the tree BEFORE this change. The ledger is built from `system`
// and the ledger rule alone, so a moved field or a rewritten buttons system must
// not reach it.
const LEDGER_PIN = '7b8c9a00c833aa5e888335ea55cb2463b2bda29b7e513527200244db0c970e5a'
await check('(e) the split ledger request is byte-identical to the pre-change pin', async () => {
  const requests: Array<Record<string, any>> = []
  const call = async (request: Record<string, any>) => {
    requests.push(JSON.parse(JSON.stringify(request)))
    if (request.purpose === 'beat_ledger') return JSON.stringify({ beat_ledger: { npc_beats: [], emotional_shift: null, setting: null, consequence: null, unresolved_hook: null } })
    return JSON.stringify({ choices: [{ label: 'Ask why', kind: 'say', send: 'Why?' }], milestone: null })
  }
  // Exactly the inputs the pin was taken with.
  await extractChoiceMetadata('Mara steps into the hall.', ['resolve'], ['listened'], { call, playerInput: '*I wait*' }, { split: true })
  const ledger = requests.find((request) => request.purpose === 'beat_ledger')
  assert.ok(ledger, 'the split must make its ledger call')
  const hash = createHash('sha256').update(JSON.stringify({
    system: ledger.messages[0].content,
    schema: ledger.responseSchema,
    maxTokens: ledger.maxTokens,
    model: ledger.model,
    temperature: ledger.temperature,
  })).digest('hex')
  assert.equal(hash, LEDGER_PIN, 'the ledger request moved')
})

if (fail > 0) {
  console.log(`\nmetadata-slim audit: ${pass} passed, ${fail} failed`)
  process.exit(1)
}

if (process.argv.includes('--bites')) {
  await runBites()
} else {
  console.log(`\nmetadata-slim audit: ${pass} passed, 0 failed`)
}

// ── bites ────────────────────────────────────────────────────────────────────
type Edit = [file: string, from: string, to: string]
type Mutation = { name: string; check: string; edits: Edit[] }

async function runBites() {
  const root = await mkdtemp(join(import.meta.dir, '.metadata-slim-bites-'))
  const server = new URL('..', import.meta.url).pathname
  const AUDIT = 'scripts/metadata-slim-audit.ts'
  const extractor = 'worker/lib/metadata-extractor.ts'

  const mutations: Mutation[] = [
    {
      name: 'the four rule lines put back into the buttons system',
      check: "(a) the choice request carries no moved rule line or property, and ignores the answer's own four (English and non-English, split and unsplit)",
      edits: [[extractor,
        "  const buttonsBase = MOVED_RULES.reduce((base, rule) => base.replace(rule + '\\n', ''), strippedChoiceBase)",
        '  const buttonsBase = strippedChoiceBase']],
    },
    {
      name: 'the four properties put back into the buttons schema',
      check: "(a) the choice request carries no moved rule line or property, and ignores the answer's own four (English and non-English, split and unsplit)",
      edits: [[extractor,
        "  properties: {\n    beat_ledger: {\n      type: 'object',",
        "  properties: {\n    ...MOVED_FIELDS_SCHEMA_PROPERTIES,\n    beat_ledger: {\n      type: 'object',"]],
    },
    {
      name: 'the buttons half writes the four again',
      check: "(a) the choice request carries no moved rule line or property, and ignores the answer's own four (English and non-English, split and unsplit)",
      edits: [[extractor,
        '          scene_tag: WITNESS_FALLBACK.scene_tag,',
        "          scene_tag: v.scene_tag ?? 'dialogue',"]],
    },
    {
      name: 'the witness system loses the stats and flags',
      check: '(b) the witness request teaches the four rules, names the stats and flags, and requires the four properties',
      edits: [[extractor,
        'buildMetadataSystem(opts, normalizeStats(stats ?? []), flagKeys ?? [])',
        'buildMetadataSystem(opts, [], [])']],
    },
    {
      name: 'the witness schema drops the four properties',
      check: '(b) the witness request teaches the four rules, names the stats and flags, and requires the four properties',
      edits: [[extractor, '    ...MOVED_FIELDS_SCHEMA_PROPERTIES,\n  },', '  },']],
    },
    {
      name: 'the merge takes the tag from the buttons half',
      check: '(c) the merged result carries scene tag, mutations and tone from the witness answer',
      edits: [[extractor, '    scene_tag: witness.scene_tag,', '    scene_tag: choice.scene_tag,']],
    },
    {
      name: 'a witness outage stops keeping the adult tag',
      check: "(d) a witness outage keeps the buttons and the adult intimate tag; a buttons outage keeps the witness's tag and mutations",
      edits: [[extractor, "  } catch {\n    return { ...WITNESS_FALLBACK, scene_tag: 'intimate' }", '  } catch {\n    return WITNESS_FALLBACK']],
    },
    {
      name: 'the ledger token budget drifts',
      check: '(e) the split ledger request is byte-identical to the pre-change pin',
      edits: [[extractor, '        maxTokens: 450,', '        maxTokens: 460,']],
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
          assert.equal(text.split(from).length, 2, `${mutation.name}: one target for ${from}`)
          await writeFile(path, text.replace(from, to))
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
    console.log(`metadata-slim bites: ${bitten}/${mutations.length} mutations rejected; scratch restored and removed`)
    if (bitten !== mutations.length) process.exit(1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}
