/**
 * PROSE FORMAT: a spoken line never sits inside an italic run, and narration
 * never sits outside the markers.
 *
 * The narrator is asked for one shape (`RESPONSE FORMAT` in `prompt-builder`):
 * only the words spoken aloud in double quotes, everything else — scene, action,
 * and the dialogue attribution itself — in single-asterisk italics. The adult
 * narrator drifts from it in two ways that keep the marker count BALANCED and
 * keep quoted speech outside the markers, which is exactly why the hygiene
 * validator never flagged them (it checks global parity, not position):
 *
 *   *I hiss, my fangs grazing your skin. "Mine,"* I snarl, my eyes on yours.
 *   *My grip tightens. "You're eager, aren't you?"*
 *
 * `normalizeProseFormat` moves the markers deterministically (words are never
 * rewritten) and `makeProseStreamFilter` applies it as the words arrive, so the
 * player never sees the broken form and the prose the turn is persisted with is
 * the prose that was shown.
 *
 * This audit pins:
 *   (a) every real adult reply comes out with no quote inside an italic run, no
 *       plain narration outside the markers and no empty `**` pair;
 *   (b) with the markers off, the text is byte-identical — markers move, words
 *       and punctuation never do;
 *   (c) normalising twice equals normalising once;
 *   (d) five house-correct passages built from the prompt's own example are
 *       returned byte-identical;
 *   (e) the edges: apostrophes inside words, nested quotes, a quote opening a
 *       reply, multi-paragraph prose, curly quotes, `**`, a truncated run;
 *   (f) the live stream agrees with the pure function at every chunk size, and
 *       the choices tail it carries is still parseable (formatting must never
 *       touch hidden metadata);
 *   (g) the wiring that puts the fix in front of the player is still there.
 *
 * Every check is shown to bite: each one rejects a tampered input, and four
 * temp-copy mutants of `prose-hygiene.ts` (one rule broken each) must fail
 * exactly the checks that depend on that rule and leave the rest passing.
 *
 *   bun --no-env-file run scripts/prose-format-audit.ts
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeProseFormatNormalizer, normalizeProseFormat } from '../src/utils/prose-hygiene'
import { makeProseStreamFilter } from '../worker/lib/prose-stream-filter'
import { CHOICE_SENTINEL, makeChoiceTailFilter, parseChoiceTail } from '../worker/lib/choice-tail'

const root = new URL('..', import.meta.url).pathname.replace(/\/$/, '')

let failures = 0
function check(name: string, fn: () => void) {
  try {
    fn()
    console.log(`PASS ${name}`)
  } catch (err) {
    failures++
    console.log(`FAIL ${name}: ${(err as Error).message}`)
  }
}

// ── The shape being measured ─────────────────────────────────────────────────

interface Shape {
  quotesInsideItalics: number
  plainNarration: number
  emptyMarkers: number
  openRunAtEnd: boolean
}

/** Structural read of a passage, the same way the app's spans read it. */
function shape(text: string): Shape {
  let italics = false
  let quote = false
  let plain = ''
  let quotesInsideItalics = 0
  let plainNarration = 0
  for (const c of text) {
    if (c === '*') {
      if (plain.trim()) plainNarration++
      plain = ''
      italics = !italics
      continue
    }
    if (c === '"' || c === '“' || c === '”') {
      if (!quote && italics) quotesInsideItalics++
      if (plain.trim()) plainNarration++
      plain = ''
      quote = !quote
      continue
    }
    if (italics || quote) {
      if (plain.trim()) plainNarration++
      plain = ''
      continue
    }
    plain += c
  }
  if (plain.trim()) plainNarration++
  return {
    quotesInsideItalics,
    plainNarration,
    emptyMarkers: (text.match(/\*\*/g) || []).length,
    openRunAtEnd: italics,
  }
}

/**
 * The passage with its markers taken off: asterisks drop out and curly quotes
 * are unified. The normaliser is only allowed to MOVE markers, so this must come
 * out byte-identical — not merely word-identical. Whitespace around a marker is
 * part of what moves (it belongs outside the run), and it survives in order.
 */
function withoutMarkers(text: string): string {
  return text.replace(/\*/gu, '').replace(/[“”]/gu, '"')
}

const fixtures = (JSON.parse(
  readFileSync(join(root, 'corpus/adult-prose-fixtures.json'), 'utf8'),
) as { replies: Array<{ model: string; raw: string }> }).replies

// Five passages in the house format, built from the example the prompt itself
// gives (`RESPONSE FORMAT`, prompt-builder.ts):
//   "You came back," *she whispered, her hand trembling. The hearth crackled
//   between you.* "I didn't think you would."
const CRAFT = [
  '"You came back," *she whispered, her hand trembling. The hearth crackled between you.* "I didn\'t think you would."',
  '*The hearth crackles between you.*',
  '"I missed you," *she says softly.*',
  '"You came back," *she whispered, her hand trembling. The hearth crackled between you.* "I didn\'t think you would."\n\n*She set the cup down and turned away. The fire answered with a soft crack.* "It has been a long winter."',
  '*I reply, my voice steady.* "Stay." *The hearth crackles between you.*',
]

interface Edge {
  name: string
  input: string
  expected: string
}

const EDGES: Edge[] = [
  {
    name: 'speech inside a run, run continues (brief)',
    input: '*A. "Hi," B.*',
    expected: '*A.* "Hi," *B.*',
  },
  {
    name: 'speech inside a run, attribution left plain (brief)',
    input: '*I hiss, my fangs grazing your skin. "Mine,"* I snarl, my eyes locked on yours.',
    expected: '*I hiss, my fangs grazing your skin.* "Mine," *I snarl, my eyes locked on yours.*',
  },
  {
    name: 'apostrophes inside words survive',
    input: '*I don\'t move, my grip tightening. "You\'re not going anywhere," I say.*',
    expected: '*I don\'t move, my grip tightening.* "You\'re not going anywhere," *I say.*',
  },
  {
    name: 'nested single quotes inside a spoken line',
    input: '*He says "she told me \'no\'" and looks away.*',
    expected: '*He says* "she told me \'no\'" *and looks away.*',
  },
  {
    name: 'a quote opening the reply, attribution plain',
    input: '"Stay," she says, and does not let go.',
    expected: '"Stay," *she says, and does not let go.*',
  },
  {
    name: 'multi-paragraph, a quote inside a run in the last paragraph',
    input: '*I hold her gaze.* "You came back," *she whispers.*\n\n*The hearth crackles. I do not answer. She waits, and the waiting says more than either of us.*\n\n*Then, quietly: "I did."*\n\n*She looks up, eyes bright. "Why?"*',
    expected: '*I hold her gaze.* "You came back," *she whispers.*\n\n*The hearth crackles. I do not answer. She waits, and the waiting says more than either of us.*\n\n*Then, quietly:* "I did."\n\n*She looks up, eyes bright.* "Why?"',
  },
  {
    name: 'curly quotes become straight',
    input: '“Mine,” *I snarl.*',
    expected: '"Mine," *I snarl.*',
  },
  {
    name: 'a double-asterisk run is one marker',
    input: '**bold** and *it*',
    expected: '*bold* *and it*',
  },
  {
    name: 'a truncated run is left exactly as the model wrote it',
    input: '*I nip at your earlobe, my teeth grazing the skin as I wait for your',
    expected: '*I nip at your earlobe, my teeth grazing the skin as I wait for your',
  },
]

// ── The checks, over any candidate normaliser ───────────────────────────────

interface Candidate {
  name: string
  normalize(text: string): string
}

const real: Candidate = { name: 'prose-hygiene', normalize: normalizeProseFormat }

const checks: Array<{ key: string; name: string; run: (c: Candidate) => void }> = [
  {
    key: '(a)',
    name: `(a) all ${fixtures.length} real adult replies come out house-clean`,
    run: (c) => {
      for (const [i, fixture] of fixtures.entries()) {
        const s = shape(c.normalize(fixture.raw))
        assert.equal(s.quotesInsideItalics, 0, `#${i + 1} keeps ${s.quotesInsideItalics} quote(s) inside a run`)
        assert.equal(s.plainNarration, 0, `#${i + 1} leaves ${s.plainNarration} plain narration stretch(es)`)
        assert.equal(s.emptyMarkers, 0, `#${i + 1} has an empty ** pair`)
      }
    },
  },
  {
    key: '(b)',
    name: '(b) not one character changes once the markers are off',
    run: (c) => {
      for (const [i, fixture] of fixtures.entries()) {
        assert.equal(
          withoutMarkers(c.normalize(fixture.raw)),
          withoutMarkers(fixture.raw),
          `#${i + 1} changed its text, not just its markers`,
        )
      }
      for (const edge of EDGES) {
        assert.equal(withoutMarkers(c.normalize(edge.input)), withoutMarkers(edge.input), `${edge.name} changed its text`)
      }
    },
  },
  {
    key: '(c)',
    name: '(c) normalising twice equals normalising once',
    run: (c) => {
      for (const [i, fixture] of fixtures.entries()) {
        const once = c.normalize(fixture.raw)
        assert.equal(c.normalize(once), once, `#${i + 1} is not a fixed point`)
      }
      for (const edge of EDGES) {
        const once = c.normalize(edge.input)
        assert.equal(c.normalize(once), once, `${edge.name} is not a fixed point`)
      }
      for (const craft of CRAFT) assert.equal(c.normalize(craft), craft, 'a craft example is not a fixed point')
    },
  },
  {
    key: '(d)',
    name: '(d) house-correct passages from the prompt example are untouched',
    run: (c) => {
      for (const [i, craft] of CRAFT.entries()) {
        assert.equal(c.normalize(craft), craft, `craft example ${i + 1} was rewritten`)
      }
    },
  },
  {
    key: '(e)',
    name: '(e) the edges land on the house format',
    run: (c) => {
      for (const edge of EDGES) assert.equal(c.normalize(edge.input), edge.expected, edge.name)
    },
  },
]

function run(check: (typeof checks)[number], candidate: Candidate): boolean {
  try {
    check.run(candidate)
    return true
  } catch {
    return false
  }
}

for (const c of checks) check(c.name, () => c.run(real))

// ── Each check bites on a tampered input ────────────────────────────────────

check('bite: (a) rejects the raw replies it was written for', () => {
  const dirty = fixtures.filter((fixture) => {
    const s = shape(fixture.raw)
    return s.quotesInsideItalics > 0 || s.plainNarration > 0
  })
  assert.ok(
    dirty.length >= 5,
    `only ${dirty.length} fixtures are dirty, so (a) would pass on the raw text and prove nothing`,
  )
  console.log(`       ${dirty.length} of ${fixtures.length} raw replies are dirty; (a) is not a no-op`)
})

check('bite: (b) rejects a fixed passage with one word dropped', () => {
  const fixed = normalizeProseFormat(fixtures[0].raw)
  const tampered = fixed.replace(/\bhunger\b\s*/, '')
  assert.notEqual(tampered, fixed, 'the tampered passage must actually differ')
  assert.notEqual(withoutMarkers(tampered), withoutMarkers(fixed))
})

check('bite: (c) rejects a normaliser that is not idempotent', () => {
  const twice = (text: string) => `${normalizeProseFormat(text)} *`
  const once = twice(fixtures[1].raw)
  assert.notEqual(twice(once), once)
})

check('bite: (d) rejects a house-correct passage with a marker moved', () => {
  const broken = CRAFT[0].replace('*she whispered', 'she whispered')
  assert.notEqual(normalizeProseFormat(broken), broken)
})

check('bite: (e) rejects the brief\'s second example left as the model wrote it', () => {
  const edge = EDGES[1]
  assert.notEqual(edge.input, edge.expected)
  assert.equal(normalizeProseFormat(edge.input), edge.expected)
})

// ── Four temp-copy mutants: one rule broken each ────────────────────────────

const RULES = [
  {
    label: 'a quote inside a run is not extracted',
    anchor: `      if (quote) {
        out += "*";
        flushHeld();
        out += '"';
        state = "speech";
        reopenAfterQuote = true;
        return;
      }`,
    replacement: `      if (quote && false) {
        out += "*";
        flushHeld();
        out += '"';
        state = "speech";
        reopenAfterQuote = true;
        return;
      }`,
    kills: ['(a)', '(e)'],
  },
  {
    label: 'plain narration is not wrapped',
    anchor: `    if (FORMAT_WORD.test(c)) {
      out += "*";
      state = "auto";
      out += c;
      return;
    }`,
    replacement: `    if (FORMAT_WORD.test(c)) {
      out += c;
      return;
    }`,
    kills: ['(a)', '(e)'],
  },
  {
    label: 'the run reopens through the quote close (empty ** pair)',
    anchor: `    // The run the quote interrupted ends here; its close marker is this one.
    flushHeld();
    state = "outside";
  };`,
    replacement: `    // The run the quote interrupted ends here; its close marker is this one.
    flushHeld();
    out += "*";
    state = "outside";
  };`,
    kills: ['(a)', '(c)', '(e)'],
  },
  {
    label: 'a word is rewritten',
    anchor: `  return normalizer.push(String(narrative || "")) + normalizer.end();`,
    replacement: `  return (normalizer.push(String(narrative || "")) + normalizer.end()).replace(/\\bthe\\b\\s*/gi, "");`,
    kills: ['(b)', '(c)', '(d)', '(e)'],
  },
]

const proseHygienePath = join(root, 'src/utils/prose-hygiene.ts')
const proseHygieneSource = readFileSync(proseHygienePath, 'utf8')

const mutantDir = mkdtempSync(join(tmpdir(), 'prose-format-'))
try {
  symlinkSync(join(root, 'node_modules'), join(mutantDir, 'node_modules'), 'dir')
  for (const [i, rule] of RULES.entries()) {
    assert.equal(
      proseHygieneSource.split(rule.anchor).length,
      2,
      `anchor for "${rule.label}" not found exactly once; update this audit`,
    )
    const file = join(mutantDir, `mutant-${i}.ts`)
    writeFileSync(
      file,
      proseHygieneSource
        .replace('"../ai/client"', `"${root}/src/ai/client"`)
        .replace('"./narrative-styles"', `"${root}/src/utils/narrative-styles"`)
        .replace(rule.anchor, rule.replacement),
    )
    const mutant = (await import(file)) as { normalizeProseFormat: (text: string) => string }
    const candidate: Candidate = { name: `mutant ${i + 1}`, normalize: mutant.normalizeProseFormat }
    for (const c of checks) {
      const passed = run(c, candidate)
      if (rule.kills.includes(c.key)) {
        assert.equal(passed, false, `${c.name} survived the "${rule.label}" bite`)
      } else {
        assert.equal(passed, true, `"${rule.label}" unexpectedly broke ${c.name}`)
      }
    }
    console.log(`PASS bite: "${rule.label}" kills ${rule.kills.join(', ')} and nothing else`)
  }
} finally {
  rmSync(mutantDir, { recursive: true, force: true })
}

// ── (f) the live stream is the same function, and leaves the tail alone ─────

/**
 * Push text through the player-facing pipeline exactly as the processor does:
 * prose filter → choices filter, in chunks.
 */
function streamThrough(text: string, size: number): { prose: string; choiceBlock: string; delta: string } {
  const prose = makeProseStreamFilter()
  const choices = makeChoiceTailFilter()
  let shown = ''
  for (let i = 0; i < text.length; i += size) shown += choices.push(prose.push(text.slice(i, i + size)))
  shown += choices.push(prose.end())
  shown += choices.end()
  return { prose: choices.prose(), choiceBlock: choices.choiceBlock(), delta: shown }
}

check('(f1) every chunking of every reply streams the same text as the pure function', () => {
  for (const size of [1, 2, 3, 5, 7, 11, 40, 1000]) {
    for (const [i, fixture] of fixtures.entries()) {
      const want = normalizeProseFormat(fixture.raw)
      assert.equal(streamThrough(fixture.raw, size).delta, want, `#${i + 1} at ${size} chars`)
    }
    for (const edge of EDGES) {
      assert.equal(streamThrough(edge.input, size).delta, edge.expected, `${edge.name} at ${size} chars`)
    }
  }
  for (const craft of CRAFT) {
    for (const size of [1, 3, 7]) assert.equal(streamThrough(craft, size).delta, craft, `craft at ${size} chars`)
  }
})

check('(f2) streaming pays out the corrections before the turn ends', () => {
  // A dirty reply must show the fixed form on the FIRST chunk that contains the
  // mid-run quote, never the broken one — that is the whole point of doing it in
  // the stream rather than after it.
  const raw = fixtures[2].raw
  const prose = makeProseStreamFilter()
  let shown = ''
  for (let i = 0; i < raw.length; i += 4) {
    shown += prose.push(raw.slice(i, i + 4))
    const s = shape(shown)
    assert.equal(s.quotesInsideItalics, 0, `a quote is inside a run after ${i + 4} characters`)
    assert.ok(!shown.includes('"Mine,"*'), 'the broken close leaked')
  }
})

check('(f3) the choices tail is passed through untouched and still parses', () => {
  const tail = `${CHOICE_SENTINEL}\n[act] Stay put | *I stay exactly where I am.*\n[say] Ask why | Why?`
  for (const raw of [fixtures[0].raw, '*I look up.* You really mean it, don\'t you?']) {
    for (const size of [1, 3, 8, 500]) {
      const out = streamThrough(`${raw}\n\n${tail}`, size)
      assert.ok(!out.prose.includes(CHOICE_SENTINEL), `sentinel leaked into prose at ${size} chars`)
      assert.ok(!out.prose.includes('[act]'), `choices row leaked into prose at ${size} chars`)
      assert.equal(shape(out.prose).quotesInsideItalics, 0)
      assert.equal(shape(out.prose).plainNarration, 0)
      const parsed = parseChoiceTail(out.choiceBlock)
      assert.equal(parsed.length, 2, `tail did not parse at ${size} chars`)
      assert.equal(parsed[0].send, '*I stay exactly where I am.*')
    }
  }
})

check('(f4) the legacy JSON envelope is still recovered, in house format', () => {
  const payload = JSON.stringify({ narrative: '*I hiss. "Mine,"* I snarl.' })
  const filter = makeProseStreamFilter()
  const early = filter.push(payload.slice(0, 18))
  const rest = filter.push(payload.slice(18)) + filter.end()
  assert.equal(early, '')
  assert.equal(rest, '*I hiss.* "Mine," *I snarl.*')
})

// ── (g) the wiring that puts it in front of the player ─────────────────────

const FORMAT_PUSH = 'delta += protocol ? c : format.push(c)'

function wiringProblems(
  streamSource: string,
  processorSource: string,
  replaySource: string = replaySourceText,
): string[] {
  const problems: string[] = []
  if (!/from ['"]\.\.\/\.\.\/src\/utils\/prose-hygiene['"]/.test(streamSource)) {
    problems.push('prose-stream-filter does not import the format normaliser')
  }
  if (!/makeProseFormatNormalizer\(\)/.test(streamSource)) {
    problems.push('prose-stream-filter never builds a normaliser')
  }
  if (!streamSource.includes(FORMAT_PUSH)) {
    problems.push('prose-stream-filter passes the chunk through instead of the normalised text')
  }
  if (!/format\.end\(\)/.test(streamSource)) {
    problems.push('prose-stream-filter never closes the normaliser')
  }
  if (!/publishVisibleDelta\(proseFilter\.push\(chunk\)\)/.test(processorSource)) {
    problems.push('the processor publishes the raw chunk instead of the filtered one')
  }
  if (!/publishVisibleDelta\(proseFilter\.end\(\)\)/.test(processorSource)) {
    problems.push('the processor never flushes the filter at stream end')
  }
  if (!/replayEvent\([^)]*\(chunk\) =>\s*publishReplayDelta\(proseFilter\.push\(chunk\)\)/.test(replaySource)) {
    problems.push('regenerate streams the raw chunk instead of the filtered one')
  }
  if (!/publishReplayDelta\(proseFilter\.end\(\)\)/.test(replaySource)) {
    problems.push('regenerate never flushes the filter at stream end')
  }
  return problems
}

const streamSource = readFileSync(join(root, 'worker/lib/prose-stream-filter.ts'), 'utf8')
const processorSource = readFileSync(join(root, 'worker/processors/generation.processor.ts'), 'utf8')
const replaySourceText = readFileSync(join(root, 'worker/processors/replay.processor.ts'), 'utf8')

check('(g) the fix is wired into the player-facing stream', () => {
  const problems = wiringProblems(streamSource, processorSource)
  assert.deepEqual(problems, [], problems.join('; '))
})

check('bite: (g) rejects the wiring as it was before the fix', () => {
  const unfiltered = processorSource.replace(
    'publishVisibleDelta(proseFilter.push(chunk))',
    'publishVisibleDelta(chunk)',
  )
  assert.notEqual(unfiltered, processorSource, 'the processor anchor moved; update this audit')
  assert.ok(wiringProblems(streamSource, unfiltered).length > 0)
  const noImport = streamSource.replace(/from ['"]\.\.\/\.\.\/src\/utils\/prose-hygiene['"]/, "from './nothing'")
  assert.notEqual(noImport, streamSource, 'the filter import anchor moved; update this audit')
  assert.ok(wiringProblems(noImport, processorSource).length > 0)
})

check('bite: (g) rejects a regenerate that streams the raw chunk', () => {
  const raw = replaySourceText.replace('publishReplayDelta(proseFilter.push(chunk))', 'publishReplayDelta(chunk)')
  assert.notEqual(raw, replaySourceText, 'the replay anchor moved; update this audit')
  assert.ok(wiringProblems(streamSource, processorSource, raw).length > 0)
  const unflushed = replaySourceText.replace('publishReplayDelta(proseFilter.end())', '')
  assert.ok(wiringProblems(streamSource, processorSource, unflushed).length > 0)
})

// A normaliser that is built and closed but never actually applied would leave
// every text check above green, so this is the bite that proves the player sees
// the fix.
check('bite: (g) catches a normaliser built but not applied', () => {
  const unused = streamSource.replace(FORMAT_PUSH, 'delta += c')
  assert.notEqual(unused, streamSource, 'the filter anchor moved; update this audit')
  assert.ok(wiringProblems(unused, processorSource).length > 0)
})

console.log(failures === 0 ? '\nprose-format: ALL GREEN' : `\nprose-format: ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
