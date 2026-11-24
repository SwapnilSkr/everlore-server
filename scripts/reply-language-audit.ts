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

import {
  effectiveReplyLanguage,
  enabledReplyLanguages,
  isReplyLanguageSetting,
  languageFromLocale,
  normalizeDeviceLocale,
  replyLanguageOptions,
  replyLanguageRule,
  spliceReplayDirective,
  startingLanguage,
  type ReplyLanguageEntry,
} from '../src/utils/reply-language'
import {
  checkReplyLanguage,
  decideReplyLanguage,
  normalizeReplyText,
  shouldCheckReplyLanguage,
  type ReplyLanguageCheckRequest,
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

// ── 1. locale mapping ────────────────────────────────────────────────────────
await check('locale mapping: primary subtag, underscore form and enabled-only', () => {
  assert.equal(languageFromLocale('pt-BR', ENABLED), 'pt')
  assert.equal(languageFromLocale('pt_BR', ENABLED), 'pt')
  assert.equal(languageFromLocale('es-419', ENABLED), 'es')
  assert.equal(languageFromLocale('EN-us', ENABLED), undefined)
  assert.equal(languageFromLocale('fr-FR', ENABLED), undefined)
  assert.equal(languageFromLocale('pt-BR', []), undefined)
  assert.equal(languageFromLocale(undefined, ENABLED), undefined)
})

// ── 2. precedence ────────────────────────────────────────────────────────────
await check('precedence: preference, explicit en, device, English', () => {
  assert.equal(startingLanguage({ preference: 'es', deviceLocale: 'pt-BR', enabledCodes: ENABLED }), 'es')
  assert.equal(startingLanguage({ preference: 'en', deviceLocale: 'pt-BR', enabledCodes: ENABLED }), undefined)
  assert.equal(startingLanguage({ deviceLocale: 'pt-BR', enabledCodes: ENABLED }), 'pt')
  // A stored preference that is off/unknown behaves as English; the device does
  // not get a second chance.
  assert.equal(startingLanguage({ preference: 'fr', deviceLocale: 'pt-BR', enabledCodes: ENABLED }), undefined)
  assert.equal(startingLanguage({ enabledCodes: ENABLED }), undefined)
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

// ── 5. detector gate truth table ─────────────────────────────────────────────
await check('detector gate: truth table', () => {
  const base = {
    enabledCodes: ENABLED,
    isTyped: true,
    source: 'device' as string | undefined,
    checks: 0,
    text: 'Olá, como você está?',
    offered: [] as Array<{ send?: string; label?: string }>,
  }
  assert.equal(shouldCheckReplyLanguage({ ...base, enabledCodes: [] }), false)
  assert.equal(shouldCheckReplyLanguage(base), true)
  assert.equal(shouldCheckReplyLanguage({ ...base, isTyped: false }), false)
  assert.equal(shouldCheckReplyLanguage({ ...base, source: 'player' }), false)
  assert.equal(shouldCheckReplyLanguage({ ...base, text: '   ' }), false)
  assert.equal(
    shouldCheckReplyLanguage({ ...base, text: 'Take his hand.', offered: [{ send: '*take his hand*', label: 'Take his hand.' }] }),
    false,
  )
  // A chip's formatting differs from its label; both are still the chip.
  assert.equal(
    shouldCheckReplyLanguage({ ...base, text: 'take his hand', offered: [{ send: '*take his hand*', label: 'Take his hand.' }] }),
    false,
  )
  assert.equal(shouldCheckReplyLanguage({ ...base, source: 'writing' }), true)
  // Past three checks an English save is read only with a non-ASCII letter.
  assert.equal(shouldCheckReplyLanguage({ ...base, checks: 3, text: 'The room is quiet.' }), false)
  assert.equal(shouldCheckReplyLanguage({ ...base, checks: 3, text: 'Olá.' }), true)
  // A non-English save is always read, so a player can ask for another language.
  assert.equal(shouldCheckReplyLanguage({ ...base, checks: 3, text: 'Please write in English.', replyLanguage: 'pt' }), true)
  assert.equal(normalizeReplyText('  Take   his hand. '), normalizeReplyText('*take his hand*'))
})

// ── 6. detector call, prompt and failure ─────────────────────────────────────
await check('detector: strict request, prompt rules and parsing', async () => {
  const requests: ReplyLanguageCheckRequest[] = []
  const result = await checkReplyLanguage('Olá, quero falar em espanhol.', {
    enabledCodes: ENABLED,
    call: async (request) => {
      requests.push(request)
      return '{"written_in":"pt","asks_for":"es"}'
    },
  })
  assert.deepEqual(result, { written_in: 'pt', asks_for: 'es' })
  assert.equal(requests.length, 1)
  const request = requests[0]
  assert.equal(request.temperature, 0)
  assert.equal(request.timeoutMs, 8000)
  assert.ok(request.maxTokens > 0 && request.maxTokens <= 128)
  assert.equal(request.purpose, 'reply_language_check')
  assert.equal((request.responseSchema as { type?: string }).type, 'object')
  const system = request.messages[0].content
  assert.ok(/character|quotes?/.test(system))
  assert.ok(/not a request/i.test(system))
  assert.ok(/Names of people and places do not decide the language/i.test(system))
  assert.ok(/Very short/i.test(system) && /mixed/i.test(system) && /"other"/i.test(system))

  const asksOnly = await checkReplyLanguage('Please write in Spanish.', {
    enabledCodes: ENABLED,
    call: async () => '{"written_in":"en","asks_for":"es"}',
  })
  assert.deepEqual(asksOnly, { written_in: 'en', asks_for: 'es' })
})

await check('detector: codes outside enabled + en are other/null', async () => {
  const result = await checkReplyLanguage('Bonjour, je parle français.', {
    enabledCodes: ENABLED,
    call: async () => '{"written_in":"fr","asks_for":"fr"}',
  })
  assert.deepEqual(result, { written_in: 'other', asks_for: null })
})

await check('detector failure: never throws, null on error or bad JSON', async () => {
  const thrown = await checkReplyLanguage('Olá.', {
    enabledCodes: ENABLED,
    call: async () => {
      throw new Error('provider down')
    },
  })
  assert.equal(thrown, null)
  const bad = await checkReplyLanguage('Olá.', {
    enabledCodes: ENABLED,
    call: async () => 'not json',
  })
  assert.equal(bad, null)
  const empty = await checkReplyLanguage('Olá.', { enabledCodes: [] })
  assert.equal(empty, null)
  let calls = 0
  const off = await checkReplyLanguage('Olá.', {
    enabledCodes: [],
    call: async () => {
      calls++
      return '{"written_in":"pt","asks_for":null}'
    },
  })
  assert.equal(off, null)
  assert.equal(calls, 0)
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

await check('create: device locale is bounded and ignored when malformed', () => {
  assert.equal(normalizeDeviceLocale('pt-BR'), 'pt-BR')
  assert.equal(normalizeDeviceLocale('pt_BR'), 'pt_BR')
  assert.equal(normalizeDeviceLocale('x'.repeat(36)), undefined)
  assert.equal(normalizeDeviceLocale('not a locale!'), undefined)
  assert.equal(normalizeDeviceLocale(42), undefined)
})

// ── 9. processor wiring (source pin) ─────────────────────────────────────────
await check('processor: detector starts before the prompt and applies after the stream', async () => {
  const source = await readFile(new URL('../worker/processors/generation.processor.ts', import.meta.url), 'utf8')
  const start = source.indexOf('replyLanguageCheckPromise = checkReplyLanguage')
  const prompt = source.indexOf('const prompt = buildPrompt')
  assert.ok(start > 0, 'the detector start is missing')
  assert.ok(prompt > start, 'the detector must start before the prompt is built')
  const streamEnd = source.indexOf('const streamEndedAt = Date.now()')
  const lateApply = source.indexOf('const replyLanguageApply')
  assert.ok(streamEnd > 0 && lateApply > streamEnd, 'the late apply must start after the stream')
  assert.ok(source.includes("reply_language_source: { $ne: 'player' }"), 'the player-choice guard is missing')
  assert.ok(source.includes('await replyLanguageApply'), 'the end-of-turn apply is not awaited')
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

  const mutations: Mutation[] = [
    {
      name: 'locale: underscore form is not normalised',
      check: 'locale mapping: primary subtag, underscore form and enabled-only',
      edits: [[replyLanguage, "replace(/_/g, '-')", "replace(/__never__/g, '-')"]],
    },
    {
      name: 'precedence: the device overrides the preference',
      check: 'precedence: preference, explicit en, device, English',
      edits: [[replyLanguage, '  if (typeof params.preference === \'string\' && params.preference.trim()) {', '  if (false) {']],
    },
    {
      name: 'off: a disabled code still resolves',
      check: 'off = English: disabled/unknown/en codes are undefined',
      edits: [[replyLanguage, '  return enabledReplyLanguages(enabledCodes).find((entry) => entry.code === code)', '  return REGISTRY.find((entry) => entry.code === code)']],
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
      check: 'detector gate: truth table',
      edits: [[detector, "  if (input.source === 'player') return false", '  if (false) return false']],
    },
    {
      name: 'decision: one English line turns a settled save',
      check: 'detector decision: settling, requests, and no change',
      edits: [[detector, 'const counts = checks < SETTLING_CHECKS || !replyLanguage', 'const counts = true']],
    },
    {
      name: 'detector: a failure throws instead of returning null',
      check: 'detector failure: never throws, null on error or bad JSON',
      edits: [[detector, '  } catch {\n    return null\n  }\n}', '  } catch (err) {\n    throw err\n  }\n}']],
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
