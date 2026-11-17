/**
 * Show every important check in world-open-audit.ts BITES.
 *
 * Each mutation is a plausible way the fix could be got wrong; the audit must
 * fail on the intended check, not merely fail. Mutants live in a scratch copy
 * of `src`/`worker` — never in the working tree — and are discarded afterwards.
 *
 *   bun --no-env-file run scripts/world-open-audit-bites.ts
 */
import assert from 'node:assert/strict'
import { cp, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

type Edit = [file: string, from: string, to: string]
type Mutation = { name: string; check: string; edits: Edit[] }

const root = await mkdtemp(join(import.meta.dir, '.world-open-bites-'))
const server = new URL('..', import.meta.url).pathname
const AUDIT = 'scripts/world-open-audit.ts'

const schema = 'src/schemas/ws-message.schema.ts'
const derivations = 'src/services/world-derivations.service.ts'
const timeService = 'src/services/time.service.ts'
const openingPlace = 'src/services/opening-place.service.ts'
const instanceService = 'src/services/instance.service.ts'

const mutations: Mutation[] = [
  {
    name: 'presence: the lifecycle frame is not in the union',
    check: 'A presence frame passes the schema',
    edits: [[schema, '  WsPresenceTypeMessage,\n', '']],
  },
  {
    name: 'presence: the frame accepts extra keys',
    check: 'A a bad presence frame is still rejected',
    edits: [[schema, "{ type: t.Literal('presence'), foreground: t.Boolean() },\n  { additionalProperties: false },", "{ type: t.Literal('presence'), foreground: t.Boolean() },\n  { additionalProperties: true },"]],
  },
  {
    name: 'cache: a hit is ignored and everything recomputes',
    check: 'B first derivation computes once and stores; the second is free',
    edits: [[derivations, 'if (hit) return hit.value as T', 'if (hit && false) return hit.value as T']],
  },
  {
    name: 'cache: junk is stored as if it were an answer',
    check: 'B a non-cacheable compute is not stored and the next call retries',
    edits: [[derivations, 'if (!cacheable) return value', 'if (false) return value']],
  },
  {
    name: 'calendar: every answer is treated as deliberate',
    check: 'B calendar: junk is not cached and is retried',
    edits: [[timeService, 'return { spec, cacheable: deliberateModern || deliberateFantasy }', 'return { spec, cacheable: true }']],
  },
  {
    name: 'opening place: a verified refusal is not kept',
    check: 'B opening place: a verified refusal is cached',
    edits: [[openingPlace, 'return { value: verdict.place, cacheable: true }', 'return { value: verdict.place, cacheable: verdict.place !== null }']],
  },
  {
    name: 'create: the two calls are serialised again',
    check: 'B a cold new save overlaps its two model calls and writes the same documents',
    edits: [[instanceService, 'const openingPlacePromise = openingLine\n      ? extractOpeningPlace({ openingLine, instanceId: idString(_id) })\n      : null', 'const openingPlacePromise = null']],
  },
  {
    name: 'recalibration: repaired saves read the cache they should bypass',
    check: 'B recalibration calls the model even when the cache holds the key',
    edits: [[timeService, 'if (template) spec = (await deriveCalendarFromPremise(calendarPremiseOf(template))).spec', "if (template) spec = await cachedDerivation('calendar', calendarPremiseOf(template), async () => { const { spec: d, cacheable } = await deriveCalendarFromPremise(calendarPremiseOf(template)); return { value: d, cacheable } })"]],
  },
]

try {
  await cp(join(server, 'src'), join(root, 'src'), { recursive: true })
  await cp(join(server, 'worker'), join(root, 'worker'), { recursive: true })
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
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    clearTimeout(timer)
    return { stdout, stderr, code }
  }

  // A clean run must pass, so a later failure is the mutation's and not the copy's.
  const clean = await runAudit()
  assert.equal(clean.code, 0, `the unmutated copy must pass:\n${clean.stdout}\n${clean.stderr}`)
  console.log(`baseline: clean copy passes (${(clean.stdout.match(/^PASS /gm) ?? []).length} checks)`)

  let bitten = 0
  for (const mutation of mutations) {
    const originals = new Map<string, string>()
    try {
      for (const [file, from, to] of mutation.edits) {
        const path = join(root, file)
        const text = originals.get(path) ?? await readFile(path, 'utf8')
        originals.set(path, text)
        assert.ok(text.includes(from), `${mutation.name}: mutation anchor missing: ${from}`)
        await writeFile(path, text.replaceAll(from, to))
      }
      const result = await runAudit()
      assert.notEqual(result.code, 0, `${mutation.name}: the audit accepted the broken behaviour\n${result.stdout}`)
      assert.ok(`${result.stdout}${result.stderr}`.includes(`FAIL ${mutation.check}`), `${mutation.name}: failed outside the intended check\n${result.stdout}\n${result.stderr}`)
      bitten++
      console.log(`BITE ${mutation.name}: exit ${result.code}; FAIL ${mutation.check}`)
    } finally {
      for (const [path, original] of originals) await writeFile(path, original)
    }
  }
  console.log(`world-open bites: ${bitten}/${mutations.length} mutations rejected; scratch restored and removed`)
  if (bitten !== mutations.length) process.exit(1)
} finally {
  await rm(root, { recursive: true, force: true })
}
