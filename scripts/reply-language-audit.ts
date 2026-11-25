/**
 * REPLY LANGUAGE (server half): the registry, save start, settings, the narrator
 * rule, the writing detector and the hygiene filter.
 *
 * Pure: no network, no DB. The detector's model call is injected.
 *
 *   bun --no-env-file run scripts/reply-language-audit.ts
 *   bun --no-env-file run scripts/reply-language-audit.ts --bites
 */
import assert from 'node:assert/strict'
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Elysia } from 'elysia'

import { CreateInstanceBody } from '../src/schemas/instance.schema'
import {
  effectiveReplyLanguage,
  enabledReplyLanguages,
  isReplyLanguageSetting,
  replyLanguageOptions,
  replyLanguageRule,
  spliceReplayDirective,
  startingLanguage,
  type ReplyLanguageEntry,
} from '../src/utils/reply-language'
import {
  decideReplyLanguage,
  matchesOfferedChip,
  normalizeReplyText,
  shouldStartReplyLanguageCheck,
} from '../worker/lib/reply-language-check'
import { buildPrompt } from '../src/utils/prompt-builder'
import { validateProseHygiene } from '../src/utils/prose-hygiene'

const PT: ReplyLanguageEntry = { code: 'pt', name: 'Brazilian Portuguese', label: 'Português' }
const ES: ReplyLanguageEntry = { code: 'es', name: 'Spanish', label: 'Español' }
const ENABLED = ['pt', 'es']

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

function basePromptInput() {
  return {
    seedPrompt: 'A quiet inn at the edge of the pines.',
    isSentient: false,
    worldState: {},
    activeFlags: {},
    globalLore: '',
    retrievedLore: [],
    retrievedMemories: [],
    sceneSummary: null,
    recentEvents: [],
    userMessage: 'I sit down by the fire.',
    maxTokens: 1000,
    proseOnly: true,
  } as const
}

// ── 1. start of a save: setting, then writing, then English ──────────────────
await check('start of a save: setting, then writing, then English; the phone never decides', async () => {
  assert.equal(startingLanguage({ preference: 'es', written: 'pt', enabledCodes: ENABLED }), 'es')
  assert.equal(startingLanguage({ preference: 'en', written: 'pt', enabledCodes: ENABLED }), undefined)
  assert.equal(startingLanguage({ written: 'pt', enabledCodes: ENABLED }), 'pt')
  assert.equal(startingLanguage({ written: 'es', enabledCodes: ENABLED }), 'es')
  assert.equal(startingLanguage({ written: 'en', enabledCodes: ENABLED }), undefined)
  // A setting that is off/unknown behaves as English; the written memory does
  // not get a second chance.
  assert.equal(startingLanguage({ preference: 'fr', written: 'pt', enabledCodes: ENABLED }), undefined)
  assert.equal(startingLanguage({ written: 'fr', enabledCodes: ENABLED }), undefined)
  assert.equal(startingLanguage({ enabledCodes: ENABLED }), undefined)
  assert.equal(startingLanguage({ preference: 'pt', enabledCodes: [] }), undefined)

  // The phone's language is gone from every layer: no locale parameter, no
  // normaliser, no create field, no 'device' source.
  const utility = await readFile(new URL('../src/utils/reply-language.ts', import.meta.url), 'utf8')
  assert.ok(!/deviceLocale|languageFromLocale|normalizeDeviceLocale/.test(utility))
  const service = await readFile(new URL('../src/services/instance.service.ts', import.meta.url), 'utf8')
  assert.ok(!/deviceLocale|device_locale/.test(service))
  assert.ok(service.includes("'preferences.reply_language_written'"))
  const controller = await readFile(new URL('../src/controllers/instance.controller.ts', import.meta.url), 'utf8')
  assert.ok(!controller.includes('body.device_locale'))
  assert.ok(!controller.includes('device_locale?:'))
  const schema = await readFile(new URL('../src/schemas/instance.schema.ts', import.meta.url), 'utf8')
  assert.ok(!/device_locale\s*:/.test(schema))
})

// ── 2. old clients: a create body with device_locale is accepted and ignored ─
await check('create: a body that still carries device_locale is accepted and ignored', async () => {
  const app = new Elysia().post('/instances', ({ body }) => body, { body: CreateInstanceBody })
  const accepted = await app.handle(
    new Request('http://localhost/instances', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ template_id: 't', device_locale: 'pt-BR' }),
    }),
  )
  assert.equal(accepted.status, 200)
  assert.deepEqual(await accepted.json(), { template_id: 't' })
  const missing = await app.handle(
    new Request('http://localhost/instances', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ device_locale: 'pt-BR' }),
    }),
  )
  assert.equal(missing.status, 422)
})

// ── 3. off = English ─────────────────────────────────────────────────────────
await check('off = English: disabled/unknown/en codes are undefined', () => {
  assert.equal(effectiveReplyLanguage('pt', []), undefined)
  assert.equal(effectiveReplyLanguage('fr', ENABLED), undefined)
  assert.equal(effectiveReplyLanguage('en', ENABLED), undefined)
  assert.equal(effectiveReplyLanguage(undefined, ENABLED), undefined)
  assert.deepEqual(enabledReplyLanguages([]), [])
  assert.deepEqual(replyLanguageOptions([]), [])
  assert.deepEqual(replyLanguageOptions(ENABLED), [
    { code: 'en', label: 'English' },
    { code: 'pt', label: 'Português' },
    { code: 'es', label: 'Español' },
  ])
  // The rule is the contract's exact text, with the registry name.
  const rule = replyLanguageRule(PT)
  assert.ok(rule.startsWith('REPLY LANGUAGE (hard rule, overrides everything above about wording): write the ENTIRE reply in Brazilian Portuguese:'))
  assert.ok(rule.includes('every line of narration, dialogue and attribution. No English sentence anywhere.'))
  assert.ok(rule.includes('Keep the names of people and places exactly as given.'))
  assert.ok(rule.endsWith('The format is unchanged: dialogue in double quotes, every other visible word in single-asterisk italics.'))
})

// ── 4a. prompt byte-identity when absent ─────────────────────────────────────
await check('prompt: absent is byte-identical and adds no part', () => {
  const explicit = buildPrompt({ ...basePromptInput(), replyLanguage: undefined })
  const omitted = buildPrompt(basePromptInput())
  assert.deepEqual(explicit.messages, omitted.messages)
  assert.deepEqual(explicit.parts, omitted.parts)
  assert.ok(!omitted.parts.some((part) => part.name === 'reply_language'))
})

// ── 4b. prompt rule position (solo) ──────────────────────────────────────────
await check('prompt: the rule is the last system message before the user turn', () => {
  const base = buildPrompt(basePromptInput())
  const withRule = buildPrompt({ ...basePromptInput(), replyLanguage: PT })
  const last = withRule.messages[withRule.messages.length - 1]
  const before = withRule.messages[withRule.messages.length - 2]
  assert.equal(last.role, 'user')
  assert.equal(before.role, 'system')
  assert.equal(before.content, replyLanguageRule(PT))
  // The rule is the only addition: the rest of the prompt is unchanged.
  assert.deepEqual(withRule.messages.slice(0, -2), base.messages.slice(0, -1))
  assert.ok(withRule.parts.some((part) => part.name === 'reply_language'))
})

// ── 4c. prompt rule position (replay splice) ─────────────────────────────────
await check('prompt: replay keeps the rule last, after the directive', () => {
  const base = buildPrompt(basePromptInput())
  const messages = spliceReplayDirective(base.messages, 'REPLAY DIRECTIVE', PT)
  const last = messages[messages.length - 1]
  const rule = messages[messages.length - 2]
  const directive = messages[messages.length - 3]
  assert.equal(last.role, 'user')
  assert.equal(rule.content, replyLanguageRule(PT))
  assert.equal(directive.content, 'REPLAY DIRECTIVE')
  const plain = spliceReplayDirective(base.messages, 'REPLAY DIRECTIVE')
  assert.equal(plain[plain.length - 2].content, 'REPLAY DIRECTIVE')
  assert.equal(plain[plain.length - 1].role, 'user')
})

await check('detector decision: settling, requests, and no change', () => {
  const decide = (written_in: string, asks_for: string | null, checks: number, replyLanguage?: string) =>
    decideReplyLanguage({ result: { written_in, asks_for }, checks, replyLanguage })
  assert.deepEqual(decide('pt', null, 0), { code: 'pt' })
  assert.deepEqual(decide('en', null, 1, 'pt'), {})
  assert.equal(decide('en', null, 0), null, 'English on an English save writes nothing')
  assert.equal(decide('pt', null, 0, 'pt'), null)
  assert.equal(decide('other', null, 0), null)
  assert.deepEqual(decide('es', null, 9), { code: 'es' })
  assert.equal(decide('en', null, 3, 'pt'), null, 'one English line must not turn a settled save')
  assert.deepEqual(decide('pt', 'es', 9, 'pt'), { code: 'es' })
  assert.deepEqual(decide('pt', 'en', 9, 'pt'), {})
})

// ── 5. pickup gate truth table (what is known before the packet) ─────────────
await check('pickup gate: truth table', () => {
  const base = {
    enabledCodes: ENABLED,
    isTyped: true,
    source: 'writing' as string | undefined,
    checks: 0,
    text: 'Olá, como você está?',
  }
  assert.equal(shouldStartReplyLanguageCheck({ ...base, enabledCodes: [] }), false)
  assert.equal(shouldStartReplyLanguageCheck(base), true)
  assert.equal(shouldStartReplyLanguageCheck({ ...base, isTyped: false }), false)
  assert.equal(shouldStartReplyLanguageCheck({ ...base, source: 'player' }), false)
  assert.equal(shouldStartReplyLanguageCheck({ ...base, source: undefined }), true)
  assert.equal(shouldStartReplyLanguageCheck({ ...base, text: '   ' }), false)
  // Past three checks an English save is read only with a non-ASCII letter.
  assert.equal(shouldStartReplyLanguageCheck({ ...base, checks: 3, text: 'The room is quiet.' }), false)
  assert.equal(shouldStartReplyLanguageCheck({ ...base, checks: 3, text: 'Olá.' }), true)
  // A non-English save is always read, so a player can ask for another language.
  assert.equal(shouldStartReplyLanguageCheck({ ...base, checks: 3, text: 'Please write in English.', replyLanguage: 'pt' }), true)
})

// ── 6. the packet-time half: a tap on an offered chip is discarded ────────────
await check('chip test: applies after the packet and matches send or label', () => {
  const offered = [{ send: '*take his hand*', label: 'Take his hand.' }]
  assert.equal(matchesOfferedChip('Take his hand.', offered), true)
  // A chip's formatting differs from its label; both are still the chip.
  assert.equal(matchesOfferedChip('take his hand', offered), true)
  assert.equal(matchesOfferedChip('I take his hand', offered), false)
  assert.equal(matchesOfferedChip('Take his hand.', []), false)
  assert.equal(matchesOfferedChip('', offered), false)
  assert.equal(normalizeReplyText('  Take   his hand. '), normalizeReplyText('*take his hand*'))
})

// ── 7. hygiene filter ────────────────────────────────────────────────────────
await check('hygiene: a non-English turn keeps only language-neutral codes', () => {
  const input = {
    narrative: '"The player should rest," he says',
    characterNames: ['Mara'],
    messageLength: 'medium' as const,
  }
  const english = validateProseHygiene(input)
  assert.ok(english.some((issue) => issue.code === 'player_label_leak'))
  assert.ok(english.some((issue) => issue.code === 'incomplete_ending'))

  const native = validateProseHygiene({ ...input, replyLanguage: 'pt' })
  assert.ok(!native.some((issue) => issue.code === 'player_label_leak'))
  assert.ok(native.some((issue) => issue.code === 'incomplete_ending'))

  const shared = '*We work together.*'
  assert.ok(validateProseHygiene({ narrative: shared }).some((issue) => issue.code === 'possible_unsupported_shared_history'))
  assert.ok(!validateProseHygiene({ narrative: shared, replyLanguage: 'pt' }).some((issue) => issue.code === 'possible_unsupported_shared_history'))

  const repeated = '*Mara walks to the window.* "Mara waits," Mara says.'
  assert.ok(validateProseHygiene({ narrative: repeated, characterNames: ['Mara'] }).some((issue) => issue.code === 'repeated_full_character_name'))
  assert.ok(!validateProseHygiene({ narrative: repeated, characterNames: ['Mara'], replyLanguage: 'pt' }).some((issue) => issue.code === 'repeated_full_character_name'))

  // Opening-name codes are language-neutral and survive.
  const opening = validateProseHygiene({
    narrative: 'Mara waits.',
    characterNames: ['Mara'],
    previousOpeningNames: ['Mara'],
    replyLanguage: 'pt',
  })
  assert.ok(opening.some((issue) => issue.code === 'repeated_opening_character_name'))

  // Structural formatting codes survive too.
  const unbalanced = '*Ela espera pela noite.'
  assert.ok(validateProseHygiene({ narrative: unbalanced }).some((issue) => issue.code === 'unbalanced_italics'))
  assert.ok(validateProseHygiene({ narrative: unbalanced, replyLanguage: 'pt' }).some((issue) => issue.code === 'unbalanced_italics'))

  // Absent is unchanged: the same input with and without an explicit undefined.
  assert.deepEqual(validateProseHygiene(input), validateProseHygiene({ ...input, replyLanguage: undefined }))
})

// ── 8. settings validation ───────────────────────────────────────────────────
await check('settings: only en or an enabled code is accepted', () => {
  assert.equal(isReplyLanguageSetting('en', []), true)
  assert.equal(isReplyLanguageSetting('pt', ENABLED), true)
  assert.equal(isReplyLanguageSetting('es', ENABLED), true)
  assert.equal(isReplyLanguageSetting('pt', []), false)
  assert.equal(isReplyLanguageSetting('fr', ENABLED), false)
  assert.equal(isReplyLanguageSetting('', ENABLED), false)
  assert.equal(isReplyLanguageSetting(null, ENABLED), false)
  assert.equal(isReplyLanguageSetting(7, ENABLED), false)
})

// ── 9. processor wiring (source pin) ─────────────────────────────────────────
await check('processor: starts at pickup with no wait, waits at the prompt, applies after the stream', async () => {
  const source = await readFile(new URL('../worker/processors/generation.processor.ts', import.meta.url), 'utf8')
  const intent = source.indexOf('const intentRouter = startIntentRouter')
  const start = source.indexOf('const replyLanguageCheck = startReplyLanguageCheck')
  const packet = source.indexOf('const packet = await buildContextPacket')
  const wait = source.indexOf('await replyLanguageCheck.waitAtPrompt(replyLanguagePrepEndedAt)')
  const prompt = source.indexOf('const prompt = buildPrompt')
  assert.ok(intent > 0, 'the adult check start is missing')
  assert.ok(start > intent, 'the language check must start beside the adult check, at pickup')
  assert.ok(packet > start, 'the language check must start before the packet loads')
  assert.ok(wait > packet && prompt > wait, 'the prompt wait must sit after prep and before the prompt')
  // The chip test uses the packet and discards both the answer and the count.
  assert.ok(source.includes('replyLanguageCheck.isOfferedChip(offered)'))
  assert.ok(source.includes('replyLanguageCheck.discard()'))
  assert.ok(
    source.includes('replyLanguageCheck.started && !replyLanguageApplied && !replyLanguageCheck.discarded()'),
    'a discarded chip must not be applied or counted',
  )
  assert.ok(source.includes("'preferences.reply_language_written'"), 'the writing memory is not set')
  const streamEnd = source.indexOf('const streamEndedAt = Date.now()')
  const lateApply = source.indexOf('const replyLanguageApply')
  assert.ok(streamEnd > 0 && lateApply > streamEnd, 'the late apply must start after the stream')
  assert.ok(source.includes("reply_language_source: { $ne: 'player' }"), 'the player-choice guard is missing')
  assert.ok(source.includes('await replyLanguageApply'), 'the end-of-turn apply is not awaited')
  assert.ok(source.includes('replyLanguageCheck.cancel()'), 'the check must be cancelled when the turn ends')
})

if (fail > 0) {
  console.log(`\nreply-language audit: ${pass} passed, ${fail} failed`)
  process.exit(1)
}

if (process.argv.includes('--bites')) {
  await runBites()
} else {
  console.log(`\nreply-language audit: ${pass} passed, 0 failed`)
}

// ── bites ────────────────────────────────────────────────────────────────────
type Edit = [file: string, from: string, to: string]
type Mutation = { name: string; check: string; edits: Edit[] }

async function runBites() {
  const root = await mkdtemp(join(import.meta.dir, '.reply-language-bites-'))
  const server = new URL('..', import.meta.url).pathname
  const AUDIT = 'scripts/reply-language-audit.ts'

  const replyLanguage = 'src/utils/reply-language.ts'
  const promptBuilder = 'src/utils/prompt-builder.ts'
  const detector = 'worker/lib/reply-language-check.ts'
  const hygiene = 'src/utils/prose-hygiene.ts'
  const processor = 'worker/processors/generation.processor.ts'
  const schema = 'src/schemas/instance.schema.ts'
  const service = 'src/services/instance.service.ts'

  const mutations: Mutation[] = [
    {
      name: 'start: the written memory overrides the setting',
      check: 'start of a save: setting, then writing, then English; the phone never decides',
      edits: [[replyLanguage, '  if (preference) return effectiveReplyLanguage(preference, enabledCodes)?.code', '  if (false) return effectiveReplyLanguage(preference, enabledCodes)?.code']],
    },
    {
      name: 'off: a disabled code still resolves',
      check: 'off = English: disabled/unknown/en codes are undefined',
      edits: [[replyLanguage, '  return enabledReplyLanguages(enabledCodes).find((entry) => entry.code === code)', '  return REGISTRY.find((entry) => entry.code === code)']],
    },
    {
      name: 'phone: the create schema takes the phone language again',
      check: 'start of a save: setting, then writing, then English; the phone never decides',
      edits: [[schema, '  persona_id: t.Optional(t.String()),\n}', '  persona_id: t.Optional(t.String()),\n  device_locale: t.Optional(t.String()),\n}']],
    },
    {
      name: 'start: the service stops reading the written memory',
      check: 'start of a save: setting, then writing, then English; the phone never decides',
      edits: [[service, "{ projection: { 'preferences.reply_language': 1, 'preferences.reply_language_written': 1 } }", "{ projection: { 'preferences.reply_language': 1 } }"]],
    },
    {
      name: 'prompt: an absent language still pushes a rule',
      check: 'prompt: absent is byte-identical and adds no part',
      edits: [[promptBuilder, '  if (input.replyLanguage) {', '  if (input.replyLanguage !== null) {']],
    },
    {
      name: 'prompt: the rule is not last',
      check: 'prompt: the rule is the last system message before the user turn',
      edits: [[promptBuilder, "    messages.push({ role: 'system', content: replyLanguageRule(input.replyLanguage) })", "    messages.unshift({ role: 'system', content: replyLanguageRule(input.replyLanguage) })"]],
    },
    {
      name: 'replay: the rule is not last after the directive',
      check: 'prompt: replay keeps the rule last, after the directive',
      edits: [[replyLanguage, "    ...headWithoutRule,\n    { role: 'system', content: directive },\n    ...(rule ? [{ role: 'system', content: rule }] : []),", "    ...headWithoutRule,\n    ...(rule ? [{ role: 'system', content: rule }] : []),\n    { role: 'system', content: directive },"]],
    },
    {
      name: 'gate: an explicit player choice does not stop detection',
      check: 'pickup gate: truth table',
      edits: [[detector, "  if (input.source === 'player') return false", '  if (false) return false']],
    },
    {
      name: 'decision: one English line turns a settled save',
      check: 'detector decision: settling, requests, and no change',
      edits: [[detector, 'const counts = checks < SETTLING_CHECKS || !replyLanguage', 'const counts = true']],
    },
    {
      name: 'hygiene: non-English keeps English-worded codes',
      check: 'hygiene: a non-English turn keeps only language-neutral codes',
      edits: [[hygiene, '  return input.replyLanguage\n    ? issues.filter((issue) => LANGUAGE_NEUTRAL_CODES.has(issue.code))\n    : issues;', '  return issues;']],
    },
    {
      name: 'settings: an invalid language is accepted',
      check: 'settings: only en or an enabled code is accepted',
      edits: [[replyLanguage, "  if (value === ENGLISH_REPLY_LANGUAGE.code) return true\n  return enabledReplyLanguages(enabledCodes).some((entry) => entry.code === value)", '  return true']],
    },
    {
      name: 'processor: the chip is no longer discarded',
      check: 'processor: starts at pickup with no wait, waits at the prompt, applies after the stream',
      edits: [[processor, '    if (replyLanguageCheck.isOfferedChip(offered)) replyLanguageCheck.discard()', '    if (false) replyLanguageCheck.discard()']],
    },
    {
      name: 'processor: the prompt wait is removed',
      check: 'processor: starts at pickup with no wait, waits at the prompt, applies after the stream',
      edits: [[processor, 'await replyLanguageCheck.waitAtPrompt(replyLanguagePrepEndedAt)', 'await replyLanguageCheck.waitAtPrompt(0)']],
    },
    {
      name: 'processor: a discarded chip is still applied',
      check: 'processor: starts at pickup with no wait, waits at the prompt, applies after the stream',
      edits: [[processor, 'replyLanguageCheck.started && !replyLanguageApplied && !replyLanguageCheck.discarded()', 'replyLanguageCheck.started && !replyLanguageApplied']],
    },
    {
      name: 'processor: the writing memory is not set',
      check: 'processor: starts at pickup with no wait, waits at the prompt, applies after the stream',
      edits: [[processor, "'preferences.reply_language_written'", "'preferences.reply_language_writtenX'"]],
    },
    {
      name: 'processor: the check is not cancelled at turn end',
      check: 'processor: starts at pickup with no wait, waits at the prompt, applies after the stream',
      edits: [[processor, '    replyLanguageCheck.cancel()', '    void 0']],
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
        stdout: 'pipe',
        stderr: 'pipe',
        stdin: 'ignore',
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
    console.log(`reply-language bites: ${bitten}/${mutations.length} mutations rejected; scratch restored and removed`)
    if (bitten !== mutations.length) process.exit(1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}
