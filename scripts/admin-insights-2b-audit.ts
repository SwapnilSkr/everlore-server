/**
 * Admin insights, part 2b and 2c (`everlore-docs/phases/admin-insights.md`):
 * internal (team) accounts, the country hints for players seen before capture,
 * top and returning players, habits and the player page's 91-day window.
 *
 * Against a disposable mongod this script starts and owns. No env file, no
 * network, no configured database.
 *
 * Every check is written to fail if a field goes missing or a rule changes; the
 * `--bites` mode proves the named ones by mutating a source-only scratch copy
 * and requiring this same audit to fail on that check.
 *
 *   bun --no-env-file run scripts/admin-insights-2b-audit.ts
 *   bun --no-env-file run scripts/admin-insights-2b-audit.ts --bites
 */
import assert from 'node:assert/strict'
import { mkdtemp, open } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'
import { mock } from 'bun:test'
import { MongoClient, ObjectId } from 'mongodb'

// ─────────────────────────────────────────────────────────────────────────────
// Bites: each mutation breaks one rule in a scratch copy of the sources, runs
// this audit there and requires it to fail on the check that names the rule.
// The real files are never touched, and no env file is copied.
// ─────────────────────────────────────────────────────────────────────────────

type Mutation = { name: string; file: string; before: string; after: string; expect: string }

const MUTATIONS: Mutation[] = [
  {
    name: 'owner rule',
    file: 'src/services/internal-accounts.ts',
    before: "if (ownerText(input.email) || ownerText(input.preferences?.player_name)) return 'owner'",
    after: "if (false && (ownerText(input.email) || ownerText(input.preferences?.player_name))) return 'owner'",
    expect: 'each rule tags the right account with the right reason',
  },
  {
    name: 'official rule is whole',
    file: 'src/services/internal-accounts.ts',
    before: "if (typeof input.username === 'string' && input.username.toLowerCase() === 'everlore') return 'official'",
    after: "if (typeof input.username === 'string' && input.username.toLowerCase().includes('everlore')) return 'official'",
    expect: 'a username that merely contains Everlore is not the official account',
  },
  {
    name: 'test phone range',
    file: 'src/services/internal-accounts.ts',
    before: 'return TEST_PHONE_DIGITS.test(nationalDigits(phone))',
    after: 'return Boolean(phone)',
    expect: 'each rule tags the right account with the right reason',
  },
  {
    name: 'sweep keeps its first timestamp',
    file: 'src/services/internal-accounts.ts',
    before: "      internal_at: { $ifNull: ['$internal_at', now] },",
    after: '      internal_at: now,',
    expect: 'a rule change keeps the first timestamp',
  },
  {
    name: 'sweep respects the override',
    file: 'src/services/internal-accounts.ts',
    before: "    internal_override: { $ne: 'off' },\n    $or: [",
    after: "    $or: [",
    expect: 'switching the flag off survives a sweep',
  },
  {
    name: 'manual on keeps a rule reason',
    file: 'src/services/internal-accounts.ts',
    before: "          internal_reason: ruleReason ?? 'manual',",
    after: "          internal_reason: 'manual',",
    expect: 'turning the flag on by hand records manual unless a rule named the reason',
  },
  {
    name: 'person ref carries the flag',
    file: 'src/services/admin-insights.ts',
    before: '    internal: row.internal === true,',
    after: '    internal: false,',
    expect: 'a person reference carries the team flag and its reason',
  },
  {
    name: 'scope covers team accounts',
    file: 'src/services/reviewer-accounts.ts',
    before: '.find({ $or: [{ reviewer: true }, { internal: true }] }, { projection: { _id: 1, install_id: 1 } })',
    after: '.find({ reviewer: true }, { projection: { _id: 1, install_id: 1 } })',
    expect: 'the scope holds team accounts and their installs',
  },
  {
    name: 'part 1 figure drops team accounts',
    file: 'src/services/admin-insights.ts',
    before: "  return userIds.length > 0 ? { player_id: { $nin: userIds } } : {}",
    after: '  return {}',
    expect: 'a part 1 figure leaves a team account out',
  },
  {
    name: 'saves list drops the player scope',
    file: 'src/services/admin.service.ts',
    before: "      ...(opts.player_id ? {} : await playerScope(opts.reviewers ?? 'exclude')),",
    after: '      ...{},',
    expect: 'the saves list hides a team account unless asked, and shows it by player',
  },
  {
    name: 'country falls back to the hint',
    file: 'src/services/admin-insights.ts',
    before: "  if (!hinted) return { country: null, source: null }",
    after: "  if (hinted || !hinted) return { country: null, source: null }",
    expect: "a player's country: the connection first, then the hint",
  },
  {
    name: 'a captured country is never replaced',
    file: 'src/services/admin-insights.ts',
    before: "  if (captured) return { country: captured, source: 'connection' }",
    after: '  if (captured && false) return { country: captured, source: \'connection\' }',
    expect: "a player's country: the connection first, then the hint",
  },
  {
    name: 'phone beats locale',
    file: 'src/services/internal-accounts.ts',
    before: "  const phone = phoneRegion(input.phone)\n  if (phone) return { code: phone, source: 'phone' }\n  const locale = localeRegion(input.locale)\n  if (locale) return { code: locale, source: 'locale' }",
    after: "  const locale = localeRegion(input.locale)\n  if (locale) return { code: locale, source: 'locale' }\n  const phone = phoneRegion(input.phone)\n  if (phone) return { code: phone, source: 'phone' }",
    expect: 'the phone wins over the locale',
  },
  {
    name: 'a +1 Canadian area code is CA',
    file: 'src/services/internal-accounts.ts',
    before: "    return typeof code === 'string' && ISO_COUNTRY.test(code) ? code : null",
    after: "    return typeof code === 'string' && ISO_COUNTRY.test(code) ? (code === 'CA' ? 'US' : code) : null",
    expect: 'a +1 Canadian number is CA',
  },
  {
    name: 'locale hints read as phone_setting',
    file: 'src/services/admin-insights.ts',
    before: "  return { country: hinted, source: user.country_hint?.source === 'phone' ? 'phone' : 'phone_setting' }",
    after: "  return { country: hinted, source: 'phone' }",
    expect: "a player's country: the connection first, then the hint",
  },
  {
    name: 'the daily hint pass is once a day',
    file: 'src/services/internal-accounts.ts',
    before: "        { $or: [{ country_hint_day: { $exists: false } }, { country_hint_day: { $ne: today } }] },",
    after: '        {},',
    expect: 'the hint pass runs once a day',
  },
  {
    name: 'the hint backfill dry run writes nothing',
    file: 'src/services/internal-accounts.ts',
    before: '        if (!opts.apply) continue',
    after: '        if (!opts.apply && false) continue',
    expect: "the backfill's dry run writes nothing",
  },
  {
    name: 'top rows count active days from sessions and turns',
    file: 'src/services/admin-insights-top.ts',
    before: '        active_days: byDay?.size ?? 0,',
    after: '        active_days: 0,',
    expect: 'top players: turns, active days, worlds and cost',
  },
  {
    name: 'top rows count worlds',
    file: 'src/services/admin-insights-top.ts',
    before: '        worlds: worlds.get(key)?.size ?? 0,',
    after: '        worlds: 0,',
    expect: 'top players: turns, active days, worlds and cost',
  },
  {
    name: 'top rows carry cost',
    file: 'src/services/admin-insights-top.ts',
    before: '        cost_usd: money(costs.get(key) ?? 0),',
    after: '        cost_usd: 0,',
    expect: 'top players: turns, active days, worlds and cost',
  },
  {
    name: 'turns come from events',
    file: 'src/services/admin-insights-top.ts',
    before: "      { $group: { _id: { player: '$player_id', day: dayExpression }, turns: { $sum: 1 } } },",
    after: "      { $group: { _id: { player: '$player_id', day: dayExpression }, turns: { $sum: 0 } } },",
    expect: 'top players: turns, active days, worlds and cost',
  },
  {
    name: 'new versus returning split',
    file: 'src/services/admin-insights-top.ts',
    before: '      new: entries.length - returningCohort.length,',
    after: '      new: entries.length,',
    expect: 'returning: the new and returning split',
  },
  {
    name: 'longest streak',
    file: 'src/services/admin-insights-top.ts',
    before: "    if (active.has(day)) {\n      run++\n      if (run > best) best = run",
    after: '    if (active.has(day)) {\n      run++',
    expect: 'returning: longest streak of consecutive days',
  },
  {
    name: 'daily arrays are the whole window',
    file: 'src/services/admin-insights-top.ts',
    before: '  return days.map((date) => ({\n    turns: byDay?.get(date)?.turns ?? 0,',
    after: '  return days.slice(0, 1).map((date) => ({\n    turns: byDay?.get(date)?.turns ?? 0,',
    expect: 'top players: the daily array is the whole window',
  },
  {
    name: 'active-day bucket edge at 3',
    file: 'src/services/admin-insights-top.ts',
    before: "      else if (count <= 3) buckets['2-3']++",
    after: "      else if (count <= 2) buckets['2-3']++",
    expect: 'active days: the 1, 3, 4 and 15 edges land in their buckets',
  },
  {
    name: 'session-minute bucket edge at 1',
    file: 'src/services/admin-insights-top.ts',
    before: "      if (minutes < 1) minutesBuckets['<1']++",
    after: "      if (minutes <= 1) minutesBuckets['<1']++",
    expect: 'session minutes: bucket edges from last_at minus started_at',
  },
  {
    name: 'week_hours is Monday-first',
    file: 'src/services/admin-insights-top.ts',
    before: '      const weekday = (started.getUTCDay() + 6) % 7',
    after: '      const weekday = started.getUTCDay()',
    expect: 'week_hours: Monday is 0 and the hour is UTC',
  },
  {
    name: 'wau is a trailing seven days',
    file: 'src/services/admin-insights-top.ts',
    before: '        if (activeWithin(daysSet, date, TRAILING_WAU_DAYS - 1)) wau++',
    after: '        if (activeWithin(daysSet, date, TRAILING_WAU_DAYS)) wau++',
    expect: 'stickiness: trailing seven and thirty day windows',
  },
  {
    name: 'returning means active in the previous seven days',
    file: 'src/services/admin-insights-top.ts',
    before: '        else if (dayRange(date, 7, -1).some((day) => daysSet.has(day))) returning++',
    after: '        else if (dayRange(date, 5, -1).some((day) => daysSet.has(day))) returning++',
    expect: 'lifecycle: away 6 days is returning, away 8 is resurrected',
  },
  {
    name: 'partial_from follows the 90-day retention',
    file: 'src/services/admin-insights-top.ts',
    before: 'const covered = new Date(today - (SESSION_RETENTION_DAYS - TRAILING_MAU_DAYS + 1) * DAY_MS).toISOString().slice(0, 10)',
    after: 'const covered = new Date(today - (SESSION_RETENTION_DAYS - TRAILING_MAU_DAYS) * DAY_MS).toISOString().slice(0, 10)',
    expect: 'partial_from is the first day with a full trailing window',
  },
  {
    name: 'calendar is 91 days',
    file: 'src/services/admin-insights-players.ts',
    before: 'const CALENDAR_DAYS = 91',
    after: 'const CALENDAR_DAYS = 90',
    expect: 'the player page calendar is 91 days ending today',
  },
  {
    name: 'hours are the session start hour',
    file: 'src/services/admin-insights-players.ts',
    before: '    hours[started.getUTCHours()]++',
    after: '    hours[0]++',
    expect: 'the player page hours ring is 24 UTC hours',
  },
  {
    name: 'median visit length',
    file: 'src/services/admin-insights-players.ts',
    before: '    : round1(minutes.length % 2 === 1 ? minutes[middle] : (minutes[middle - 1] + minutes[middle]) / 2)',
    after: '    : round1(minutes[middle] ?? 0)',
    expect: 'the player page visit lengths: count, median, longest',
  },
]

async function runBites() {
  const { cpSync, readFileSync, writeFileSync, symlinkSync } = await import('node:fs')
  const { rm } = await import('node:fs/promises')
  const scratch = await mkdtemp(join(tmpdir(), 'everlore-admin-insights-2b-bites-'))
  let failed = 0
  try {
    for (const dir of ['src', 'worker', 'scripts']) {
      cpSync(dir, join(scratch, dir), {
        recursive: true,
        filter: (path) => !path.split('/').at(-1)!.startsWith('.env'),
      })
    }
    cpSync('package.json', join(scratch, 'package.json'))
    symlinkSync(join(process.cwd(), 'node_modules'), join(scratch, 'node_modules'), 'dir')

    for (const mutation of MUTATIONS) {
      const path = join(scratch, mutation.file)
      const original = readFileSync(path, 'utf8')
      assert.equal(original.split(mutation.before).length, 2, `exactly one target for: ${mutation.name}`)
      writeFileSync(path, original.replace(mutation.before, mutation.after))
      try {
        const child = Bun.spawn(['bun', '--no-env-file', 'run', 'scripts/admin-insights-2b-audit.ts'], {
          cwd: scratch, stdout: 'pipe', stderr: 'pipe', stdin: 'ignore',
        })
        const [stdout, stderr, code] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ])
        const output = stdout + stderr
        if (code === 0) throw new Error(`Bite did not fail: ${mutation.name}`)
        if (!output.includes(mutation.expect)) {
          throw new Error(`Bite failed for the wrong reason: ${mutation.name}\n${output.split('\n').slice(-25).join('\n')}`)
        }
        console.log(`BITE ${mutation.name}: exit ${code}; ${mutation.expect}`)
      } catch (error) {
        failed++
        console.error((error as Error).message)
      } finally {
        writeFileSync(path, original)
      }
    }
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
  if (failed > 0) {
    console.error(`\n${failed}/${MUTATIONS.length} bites did not land`)
    process.exitCode = 1
  } else {
    console.log(`\n${MUTATIONS.length}/${MUTATIONS.length} mutations rejected; scratch sources restored and removed`)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// The audit
// ─────────────────────────────────────────────────────────────────────────────

async function runAudit() {
  const root = await mkdtemp(join(tmpdir(), 'everlore-admin-insights-2b-audit-'))
  const probe = createServer()
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const address = probe.address()
  assert(address && typeof address !== 'string')
  const port = address.port
  await new Promise<void>((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()))
  const logfile = await open(join(root, 'mongod.log'), 'w')
  const mongod = Bun.spawn(['mongod', '--bind_ip', '127.0.0.1', '--port', String(port), '--dbpath', root, '--nounixsocket'], {
    stdin: 'ignore', stdout: logfile.fd, stderr: logfile.fd,
  })
  const client = new MongoClient(`mongodb://127.0.0.1:${port}/admin_insights_2b_audit`, { serverSelectionTimeoutMS: 15_000 })

  let passed = 0
  async function check(name: string, fn: () => unknown) {
    try {
      await fn()
    } catch (error) {
      // The label goes into the failure so a bites run can name the check that
      // caught the broken rule rather than only its line number.
      throw new Error(`${name}: ${(error as Error).message}`)
    }
    passed++
    console.log(`  ok  ${name}`)
  }

  try {
    await client.connect()
    const db = client.db()
    const c = (name: string) => db.collection(name)

    const ADMIN_USER = 'audit-admin'
    const ADMIN_PASS = crypto.randomUUID()
    const known: Record<string, unknown> = {
      ADMIN_USERNAME: ADMIN_USER,
      ADMIN_PASSWORD: ADMIN_PASS,
      REVIEW_DEMO_PHONE: undefined,
      INK_PROMO_UNLIMITED: false,
      INK_PROMO_DAILY_TURN_CAP: 0,
      NODE_ENV: 'test',
    }
    // Any other env read answers undefined rather than throwing: the route graph
    // touches services this audit does not seed, and none of them may read a
    // real `.env`.
    mock.module('../src/config/env', () => ({
      env: new Proxy(known, {
        get(target, key) {
          return typeof key === 'string' && key in target ? target[key] : undefined
        },
      }),
    }))
    const mongoMock = new Proxy({}, {
      get: (_target, key) => {
        if (key === 'then') return undefined
        return () => c(String(key).replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`))
      },
    })
    mock.module('../src/config/mongo', () => ({
      coll: (name: string) => c(name),
      mongoColl: mongoMock,
      accountTransaction: async <T>(work: () => Promise<T>) => work(),
    }))
    mock.module('../src/providers/auth.provider', () => ({ normalizePhone: (value: string) => value }))
    mock.module('../src/middleware/rate-limit', () => ({
      rateLimit: async () => ({ allowed: true, remaining: 1, retryAfter: 0 }),
    }))
    mock.module('../src/services/admin-session.service', () => ({
      SESSION_COOKIE: 'everlore_admin_session',
      readSession: async () => null,
      readCookie: () => '',
      constantTimeEqual: (left: string, right: string) => left === right,
    }))
    const { Elysia } = await import('elysia')
    mock.module('../src/routes/admin-story-engine.routes', () => ({ adminStoryEngineRoutes: new Elysia() }))
    mock.module('../src/routes/admin-analytics.routes', () => ({ adminAnalyticsRoutes: new Elysia() }))
    mock.module('../src/routes/admin-release.routes', () => ({ adminReleaseRoutes: new Elysia() }))

    const { adminRoutes } = await import('../src/routes/admin.routes')
    const { adminService } = await import('../src/services/admin.service')
    const { reviewerAccounts, resetReviewerScopeCache } = await import('../src/services/reviewer-accounts')
    const { internalAccounts, countryHintOf, internalReasonOf } = await import('../src/services/internal-accounts')
    const { audienceInsights } = await import('../src/services/admin-audience')
    const { pathInsights } = await import('../src/services/telemetry/paths.service')
    const { playerHabitInsights } = await import('../src/services/admin-insights-top')
    const { playerInsights, playerInsightsService } = await import('../src/services/admin-insights-players')
    const { worldInsights } = await import('../src/services/admin-insights-worlds')
    const { countriesOfPlayers, countryOfUser, personRefsByIds } = await import('../src/services/admin-insights')
    const { parseBackfillArgs } = await import('./backfill-country-hint')
    const { HttpError } = await import('../src/utils/http-error')

    const DAY = 86_400_000
    const now = new Date('2026-11-18T12:00:00.000Z')
    const at = (iso: string) => new Date(iso)
    const id = () => new ObjectId()
    const day = (iso: string) => iso.slice(0, 10)
    const BASIC = `Basic ${Buffer.from(`${ADMIN_USER}:${ADMIN_PASS}`).toString('base64')}`
    const app = new Elysia().onError(({ error, set, code }) => {
      if (error instanceof HttpError) {
        set.status = error.statusCode
        return { error: error.message }
      }
      if (code === 'VALIDATION') {
        set.status = 422
        return { error: 'Some of the details sent weren\'t valid. Please check them and try again.' }
      }
    }).use(adminRoutes)

    async function request(path: string, init: { method?: string; body?: unknown; auth?: boolean } = {}) {
      const response = await app.handle(new Request(`http://localhost${path}`, {
        method: init.method ?? 'GET',
        headers: {
          ...(init.auth === false ? {} : { authorization: BASIC }),
          ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
      }))
      let body: any = null
      try { body = await response.json() } catch { body = null }
      return { status: response.status, body }
    }

    const COLLECTIONS = [
      'users', 'app_installs', 'app_sessions', 'events', 'world_instances', 'world_templates',
      'llm_calls', 'ink_ledger', 'media_usage', 'billing_config',
    ]
    async function reset() {
      for (const name of COLLECTIONS) await c(name).deleteMany({})
      resetReviewerScopeCache()
    }

    function user(overrides: Record<string, unknown> = {}) {
      return {
        _id: id(), username: `player_${Math.random().toString(16).slice(2, 8)}`,
        providers: ['google'], preferences: { nsfw_enabled: false },
        created_at: at('2026-11-01T10:00:00.000Z'), updated_at: at('2026-11-01T10:00:00.000Z'),
        ...overrides,
      }
    }
    const session = (sessionId: string, userId: ObjectId | undefined, startedAt: string, extra: Record<string, unknown> = {}) => ({
      _id: sessionId, install_id: `i-${sessionId}`, ...(userId ? { user_id: userId } : {}),
      started_at: at(startedAt), last_at: at(startedAt), app_version: '1.0.14', build: 18,
      device: { os: 'android', form: 'phone', os_version: '15', model: 'Pixel' }, screen_path: [],
      ...extra,
    })
    const turn = (instanceId: ObjectId, playerId: ObjectId, createdAt: string, type = 'narration') => ({
      _id: id(), instance_id: instanceId, player_id: playerId, type, sequence: 1, created_at: at(createdAt),
    })
    const call = (instanceId: ObjectId, playerId: ObjectId, createdAt: string, cost: number) => ({
      _id: id(), instance_id: instanceId, player_id: playerId, cost_usd: cost, created_at: at(createdAt),
      prompt_tokens: 10, completion_tokens: 1,
    })

    let internalSample: unknown = null
    let userRowSample: unknown = null
    let detailSample: unknown = null
    let audienceSample: unknown = null

    // ── Internal accounts: the rules, the sweep, the manual switch ──────────
    console.log('internal accounts')
    await reset()
    const ownerEmail = user({ email: 'swapnil@everloreapp.com', preferences: { player_name: 'Sana' } })
    const ownerName = user({ preferences: { player_name: 'Swapnil K' } })
    const official = user({ username: 'Everlore', email: 'hello@everloreapp.com' })
    const lookalike = user({ username: 'EverloreFan', email: 'fan@example.com', preferences: { player_name: 'Fan' } })
    const testPhone = user({ phone: '+1 (555) 010-0123', preferences: { player_name: 'Test' } })
    // Two rules on one account: the owner rule wins, and the phone rule must not
    // select it again on the next sweep (the filter's precedence clauses).
    const multi = user({ username: 'multi', email: 'swapnil@example.com', phone: '+1 555 010 2222' })
    const jon = user({ username: 'jon', email: 'jon.doe@gmail.com', phone: '+1 828 555 0199', preferences: { player_name: 'Jon' } })
    const mira = user({ username: 'mira', email: 'mira@gmail.com', preferences: { player_name: 'Mira' } })
    await c('users').insertMany([ownerEmail, ownerName, official, lookalike, testPhone, multi, jon, mira])

    await check('each rule tags the right account with the right reason', async () => {
      assert.equal(await internalAccounts.sweep(now), 5)
      const stored = new Map((await c('users').find({}).toArray()).map((row) => [String(row._id), row]))
      assert.deepEqual(
        [stored.get(String(ownerEmail._id))!.internal_reason, stored.get(String(ownerName._id))!.internal_reason,
          stored.get(String(official._id))!.internal_reason, stored.get(String(testPhone._id))!.internal_reason,
          stored.get(String(multi._id))!.internal_reason],
        ['owner', 'owner', 'official', 'test_phone', 'owner'],
      )
      for (const row of [ownerEmail, ownerName, official, testPhone, multi]) {
        const doc = stored.get(String(row._id))!
        assert.equal(doc.internal, true)
        assert.ok(doc.internal_at instanceof Date)
      }
      // The real player is left alone: no key at all, never `false`.
      for (const row of [jon, mira, lookalike]) {
        const doc = stored.get(String(row._id))!
        assert.equal('internal' in doc, false, `tagged ${doc.username}`)
        assert.equal('internal_reason' in doc, false)
      }
    })

    await check('a username that merely contains Everlore is not the official account', async () => {
      const doc = await c('users').findOne({ _id: lookalike._id })
      assert.equal(doc!.internal, undefined)
      assert.equal(internalReasonOf({ username: 'EverloreFan' }), null)
      assert.equal(internalReasonOf({ username: 'everlore' }), 'official')
    })

    await check('the pure rule and the sweep agree on a phone number', () => {
      assert.equal(internalReasonOf({ phone: '+1 555 010 0123' }), 'test_phone')
      assert.equal(internalReasonOf({ phone: '+15550100123' }), 'test_phone')
      assert.equal(internalReasonOf({ phone: '+18285550199' }), null)
      assert.equal(internalReasonOf({ email: 'Swapnil@x.com' }), 'owner')
      assert.equal(internalReasonOf({ preferences: { player_name: 'SWAPNIL' } }), 'owner')
      // Precedence: owner first, then the official username, then the test phone.
      assert.equal(internalReasonOf({ email: 'swapnil@x.com', username: 'Everlore', phone: '+1 555 010 1111' }), 'owner')
      assert.equal(internalReasonOf({ username: 'Everlore', phone: '+1 555 010 1111' }), 'official')
    })

    await check("a player's country: the connection first, then the hint", () => {
      assert.deepEqual(countryOfUser({ country: 'US', country_hint: { code: 'IN', source: 'phone' } }),
        { country: 'US', source: 'connection' })
      assert.deepEqual(countryOfUser({ country_hint: { code: 'IN', source: 'phone' } }), { country: 'IN', source: 'phone' })
      assert.deepEqual(countryOfUser({ country_hint: { code: 'DZ', source: 'locale' } }), { country: 'DZ', source: 'phone_setting' })
      assert.deepEqual(countryOfUser({}), { country: null, source: null })
    })

    await check('a second sweep changes nothing and keeps the first timestamp', async () => {
      const before = (await c('users').findOne({ _id: ownerEmail._id }))!.internal_at as Date
      assert.equal(await internalAccounts.sweep(now), 0)
      const after = (await c('users').findOne({ _id: ownerEmail._id }))!.internal_at as Date
      assert.equal(after.toISOString(), before.toISOString())
    })

    await check('a rule change keeps the first timestamp', async () => {
      const first = (await c('users').findOne({ _id: testPhone._id }))!.internal_at as Date
      // The test phone now carries the owner's name: the sweep re-stamps the
      // reason on a row it already flagged, and the first timestamp must hold.
      // The clock is a minute later than the first sweep, so a `now` write is
      // visible rather than being the same instant by luck.
      await c('users').updateOne({ _id: testPhone._id }, { $set: { 'preferences.player_name': 'Swapnil Q' } })
      assert.equal(await internalAccounts.sweep(new Date(now.getTime() + 60_000)), 1)
      const doc = await c('users').findOne({ _id: testPhone._id })
      assert.equal(doc!.internal_reason, 'owner')
      assert.equal((doc!.internal_at as Date).toISOString(), first.toISOString())
    })

    await check('the team flag is switched off and on through the admin route, and a non-admin is refused', async () => {
      const off = await request(`/admin/users/${ownerEmail._id}/internal`, { method: 'PATCH', body: { internal: false } })
      assert.equal(off.status, 200)
      assert.equal(off.body.user.internal_override, 'off')
      assert.equal(off.body.user.internal, undefined)
      assert.equal(off.body.user.internal_reason, undefined)

      const denied = await request(`/admin/users/${ownerEmail._id}/internal`, {
        method: 'PATCH', body: { internal: true }, auth: false,
      })
      assert.equal(denied.status, 401)

      const invalid = await request(`/admin/users/${mira._id}/internal`, {
        method: 'PATCH', body: { internal: 'yes' },
      })
      assert.equal(invalid.status, 422)

      const on = await request(`/admin/users/${mira._id}/internal`, { method: 'PATCH', body: { internal: true } })
      assert.equal(on.status, 200)
      assert.equal(on.body.user.internal, true)
      assert.equal(on.body.user.internal_reason, 'manual')
      assert.equal(on.body.user.internal_override, 'on')
      internalSample = on.body
    })

    await check('switching the flag off survives a sweep', async () => {
      // `ownerEmail` still matches the owner rule, but the operator said no.
      assert.equal(await internalAccounts.sweep(now), 0)
      const doc = await c('users').findOne({ _id: ownerEmail._id })
      assert.equal(doc!.internal, undefined)
      assert.equal(doc!.internal_reason, undefined)
      assert.equal(doc!.internal_override, 'off')
    })

    await check('turning the flag on by hand records manual unless a rule named the reason', async () => {
      const on = await request(`/admin/users/${official._id}/internal`, { method: 'PATCH', body: { internal: true } })
      assert.equal(on.status, 200)
      assert.equal(on.body.user.internal_reason, 'official')
      assert.equal((await c('users').findOne({ _id: mira._id }))!.internal_reason, 'manual')
    })

    await check('a person reference carries the team flag and its reason', async () => {
      const refs = await (await import('../src/services/admin-insights')).personRefsByIds([official._id, mira._id, jon._id])
      assert.equal(refs.get(String(official._id))!.internal, true)
      assert.equal(refs.get(String(official._id))!.internal_reason, 'official')
      assert.equal(refs.get(String(mira._id))!.internal_reason, 'manual')
      assert.equal(refs.get(String(jon._id))!.internal, false)
      assert.equal(refs.get(String(jon._id))!.internal_reason, null)
    })

    // ── The scope: team users and their installs leave every player number ──
    await check('the scope holds team accounts and their installs', async () => {
      await c('app_installs').insertMany([
        { _id: 'official-install', user_ids: [official._id], first_seen: now, last_seen: now },
        { _id: 'mira-install', user_ids: [mira._id], first_seen: now, last_seen: now },
        { _id: 'jon-install', user_ids: [jon._id], first_seen: now, last_seen: now },
      ])
      // One account's own install id lives on the user document.
      await c('users').updateOne({ _id: testPhone._id }, { $set: { install_id: 'phone-own-install' } })
      resetReviewerScopeCache()
      const scope = await reviewerAccounts.scope()
      const ids = scope.userIds.map(String)
      assert.ok(ids.includes(String(official._id)))
      assert.ok(ids.includes(String(mira._id)))
      assert.ok(ids.includes(String(testPhone._id)))
      assert.ok(!ids.includes(String(jon._id)))
      assert.ok(scope.installIds.includes('official-install'))
      assert.ok(scope.installIds.includes('phone-own-install'))
    })

    await check('a part 1 figure leaves a team account out', async () => {
      const world = { _id: id(), title: 'Iron Coast', kind: 'world', creator_id: jon._id, created_at: at('2026-10-01T00:00:00.000Z') }
      await c('world_templates').insertOne(world)
      const officialSave = id()
      const jonSave = id()
      await c('world_instances').insertMany([
        { _id: officialSave, player_id: official._id, template_id: world._id, meta: { total_events: 5, last_active_at: at('2026-11-17T00:00:00.000Z') } },
        { _id: jonSave, player_id: jon._id, template_id: world._id, meta: { total_events: 2, last_active_at: at('2026-11-17T00:00:00.000Z') } },
      ])
      const list = await worldInsights.list({ reviewers: 'exclude', page: 1, limit: 10 })
      assert.equal(list.items.length, 1)
      assert.equal(list.items[0].stats.players, 1, 'only the real player')
      assert.equal(list.items[0].stats.saves, 1)
      const included = await worldInsights.list({ reviewers: 'include', page: 1, limit: 10 })
      assert.equal(included.items[0].stats.players, 2)
    })

    await check('a part 2 figure leaves a team account and a team install out', async () => {
      await c('app_sessions').insertMany([
        session('s-mira', mira._id, '2026-11-17T09:00:00.000Z', { install_id: 'mira-install' }),
        session('s-jon', jon._id, '2026-11-17T09:00:00.000Z', { install_id: 'jon-install' }),
        // No account at all, on a team member's install: excluded by install.
        session('s-ghost', undefined, '2026-11-17T09:00:00.000Z', { install_id: 'official-install' }),
      ])
      const excluded = await pathInsights.paths('30', undefined, 'exclude', now)
      assert.equal(excluded.sessions, 1)
      const included = await pathInsights.paths('30', undefined, 'include', now)
      assert.equal(included.sessions, 3)
    })

    await check('/admin/users hides team accounts by default and reviewers=only shows them', async () => {
      const hidden = await request('/admin/users?limit=50')
      assert.equal(hidden.status, 200)
      const names = hidden.body.items.map((item: { username: string }) => item.username)
      assert.ok(names.includes('jon'))
      assert.ok(names.includes('mira') === false, 'manual team account hidden')
      assert.ok(names.includes('Everlore') === false, 'official account hidden')

      const only = await request('/admin/users?reviewers=only&limit=50')
      assert.equal(only.status, 200)
      const onlyNames = only.body.items.map((item: { username: string }) => item.username)
      assert.ok(onlyNames.includes('Everlore'))
      assert.ok(!onlyNames.includes('jon'))
      const row = only.body.items.find((item: { username: string }) => item.username === 'Everlore')
      assert.equal(row.internal, true)
      assert.equal(row.internal_reason, 'official')
      userRowSample = row
    })

    // ── The Saves list: team accounts are not saves to browse ───────────────
    console.log('saves list')
    await reset()
    const savesWorld = { _id: id(), title: 'Iron Coast', kind: 'world', created_at: at('2026-10-01T00:00:00.000Z') }
    await c('world_templates').insertOne(savesWorld)
    const teamPlayer = user({ username: 'team_saves', internal: true, internal_reason: 'manual' })
    const realPlayer = user({ username: 'player_saves' })
    await c('users').insertMany([teamPlayer, realPlayer])
    const teamSave = id()
    const realSave = id()
    await c('world_instances').insertMany([
      { _id: teamSave, player_id: teamPlayer._id, template_id: savesWorld._id, meta: { total_events: 3 } },
      { _id: realSave, player_id: realPlayer._id, template_id: savesWorld._id, meta: { total_events: 2 } },
    ])
    resetReviewerScopeCache()

    await check('the saves list hides a team account unless asked, and shows it by player', async () => {
      const idsOf = (list: { items: Array<{ id: string }> }) => list.items.map((row) => row.id).sort()
      const hidden = await adminService.listInstances({ page: 1, limit: 10 })
      assert.equal(hidden.total, 1)
      assert.deepEqual(idsOf(hidden), [String(realSave)], "the default list is the players' saves")
      const included = await adminService.listInstances({ page: 1, limit: 10, reviewers: 'include' })
      assert.deepEqual(idsOf(included), [String(realSave), String(teamSave)].sort())
      const only = await adminService.listInstances({ page: 1, limit: 10, reviewers: 'only' })
      assert.deepEqual(idsOf(only), [String(teamSave)])
      // Asking for one player's saves always answers: that page is about them,
      // team account or not.
      const byPlayer = await adminService.listInstances({ page: 1, limit: 10, player_id: String(teamPlayer._id) })
      assert.deepEqual(idsOf(byPlayer), [String(teamSave)])
      // The route parses `reviewers` with the same rule as Players.
      const route = await request('/admin/instances?reviewers=only')
      assert.equal(route.status, 200)
      assert.deepEqual(route.body.items.map((row: { id: string }) => row.id), [String(teamSave)])
      const bad = await request('/admin/instances?reviewers=nope')
      assert.equal(bad.status, 400)
      assert.equal(bad.body.error, 'Reviewers must be exclude, include or only.')
    })

    // ── Top players and returning players ───────────────────────────────────
    console.log('top and returning players')
    await reset()
    const W1 = id(), W2 = id()
    await c('world_templates').insertMany([
      { _id: W1, title: 'Iron Coast', kind: 'world', created_at: at('2026-10-01T00:00:00.000Z') },
      { _id: W2, title: 'Mira', kind: 'character', created_at: at('2026-10-01T00:00:00.000Z') },
    ])
    const alice = user({ username: 'alice', preferences: { player_name: 'Alice', gender: 'female' }, created_at: at('2026-11-01T10:00:00.000Z'), last_active_at: at('2026-11-15T10:00:00.000Z'), country_hint: { code: 'IN', source: 'phone' } })
    const bob = user({ username: 'bob', preferences: { player_name: 'Bob', gender: 'male' }, created_at: at('2026-11-16T10:00:00.000Z'), last_active_at: at('2026-11-18T09:00:00.000Z'), country: 'GB' })
    const carol = user({ username: 'carol', preferences: { player_name: 'Carol' }, created_at: at('2026-11-02T10:00:00.000Z') })
    const frank = user({ username: 'frank', preferences: { player_name: 'Frank' }, created_at: at('2026-11-10T10:00:00.000Z') })
    const gina = user({ username: 'gina', preferences: { player_name: 'Gina' }, created_at: at('2026-11-10T10:00:00.000Z') })
    const revUser = user({ username: 'reviewer1', reviewer: true, preferences: { player_name: 'Rev' } })
    const teamUser = user({ username: 'team1', internal: true, internal_reason: 'manual', preferences: { player_name: 'Team' } })
    await c('users').insertMany([alice, bob, carol, frank, gina, revUser, teamUser])

    const sA1 = id(), sA2 = id(), sB1 = id(), sC1 = id(), sG1 = id()
    await c('world_instances').insertMany([
      { _id: sA1, player_id: alice._id, template_id: W1 },
      { _id: sA2, player_id: alice._id, template_id: W2 },
      { _id: sB1, player_id: bob._id, template_id: W1 },
      { _id: sC1, player_id: carol._id, template_id: W1 },
      { _id: sG1, player_id: gina._id, template_id: W1 },
    ])
    await c('app_sessions').insertMany([
      session('b-a1', alice._id, '2026-11-12T09:00:00.000Z'),
      session('b-a2', alice._id, '2026-11-13T09:00:00.000Z'),
      session('b-a3', alice._id, '2026-11-14T09:00:00.000Z'),
      session('b-b1', bob._id, '2026-11-18T09:00:00.000Z'),
      session('b-f1', frank._id, '2026-11-17T09:00:00.000Z'),
      session('b-rev', revUser._id, '2026-11-18T09:00:00.000Z'),
      session('b-team', teamUser._id, '2026-11-18T09:00:00.000Z'),
    ])
    await c('events').insertMany([
      turn(sA1, alice._id, '2026-11-12T09:01:00.000Z'),
      turn(sA1, alice._id, '2026-11-12T09:02:00.000Z'),
      turn(sA2, alice._id, '2026-11-13T09:01:00.000Z'),
      turn(sA1, alice._id, '2026-11-15T09:01:00.000Z'),
      turn(sB1, bob._id, '2026-11-18T09:01:00.000Z'),
      turn(sB1, bob._id, '2026-11-18T09:02:00.000Z'),
      turn(sB1, bob._id, '2026-11-18T09:03:00.000Z'),
      turn(sC1, carol._id, '2026-11-18T09:01:00.000Z'),
      // Outside the 7-day window.
      turn(sG1, gina._id, '2026-11-10T09:01:00.000Z'),
      // Excluded by the scope.
      turn(sB1, revUser._id, '2026-11-18T09:01:00.000Z'),
      turn(sB1, teamUser._id, '2026-11-18T09:01:00.000Z'),
    ])
    await c('llm_calls').insertMany([
      call(sA1, alice._id, '2026-11-12T09:02:00.000Z', 0.2),
      call(sA1, alice._id, '2026-11-15T09:02:00.000Z', 0.05),
      call(sB1, bob._id, '2026-11-18T09:02:00.000Z', 0.1),
      call(sB1, revUser._id, '2026-11-18T09:02:00.000Z', 5),
      call(sB1, teamUser._id, '2026-11-18T09:02:00.000Z', 6),
    ])
    resetReviewerScopeCache()

    const top7 = await playerHabitInsights.top('7', 'exclude', now)
    await check('top players: turns, active days, worlds and cost', () => {
      assert.equal(top7.days, 7)
      assert.deepEqual(top7.top.map((row) => [row.username, row.turns]), [['alice', 4], ['bob', 3], ['carol', 1], ['frank', 0]])
      const first = top7.top[0]
      assert.equal(first.active_days, 4, 'three session days plus one turn-only day')
      assert.equal(first.worlds, 2)
      assert.equal(first.cost_usd, 0.25)
      assert.equal(first.created_at, '2026-11-01T10:00:00.000Z')
      assert.equal(first.last_active_at, '2026-11-15T10:00:00.000Z')
      assert.equal(first.country, 'IN', 'the hint fills in for a player seen before capture')
      assert.equal(first.country_source, 'phone')
      assert.equal(top7.top[1].country, 'GB')
      assert.equal(top7.top[1].country_source, 'connection')
      assert.equal(top7.top[0].internal, false)
      assert.equal(top7.top[0].internal_reason, null)
    })

    await check('top players: the daily array is the whole window', () => {
      assert.equal(top7.top[0].daily.length, 7)
      assert.deepEqual(top7.top[0].daily[0], { turns: 2, sessions: 1 }, 'oldest day 2026-11-12')
      assert.deepEqual(top7.top[0].daily[3], { turns: 1, sessions: 0 }, '2026-11-15 is a turn only')
      assert.deepEqual(top7.top[1].daily[6], { turns: 3, sessions: 1 }, 'newest day is bob')
    })

    await check('returning: the new and returning split', () => {
      assert.deepEqual(
        [top7.returning.active, top7.returning.new, top7.returning.returning],
        [4, 1, 3],
      )
      assert.deepEqual(top7.returning.players.map((row) => row.username), ['alice', 'carol', 'frank'])
    })

    await check('returning: longest streak of consecutive days', () => {
      assert.equal(top7.returning.players[0].active_days, 4)
      assert.equal(top7.returning.players[0].streak_days, 4, '2026-11-12..15 are consecutive')
      assert.equal(top7.returning.players[1].streak_days, 1)
      assert.equal(top7.returning.players[0].daily.length, 7)
      // The returning row is the contract's narrower one: no worlds or cost.
      assert.deepEqual(
        Object.keys(top7.returning.players[0]).sort(),
        ['active_days', 'created_at', 'daily', 'gender', 'id', 'internal', 'internal_reason',
          'last_active_at', 'name', 'official', 'reviewer', 'streak_days', 'turns', 'username'],
      )
    })

    await check('reviewer and team accounts are left out unless asked for', async () => {
      assert.deepEqual(top7.top.map((row) => row.username), ['alice', 'bob', 'carol', 'frank'])
      const included = await playerHabitInsights.top('7', 'include', now)
      assert.equal(included.top.length, 6)
      assert.ok(included.top.some((row) => row.username === 'reviewer1'))
      assert.ok(included.returning.players.every((row) => row.username !== 'team1' || row.internal === true))
    })

    await check('a bad days or reviewers value is a plain 400 sentence', async () => {
      for (const bad of ['14', '0', 'x', '7.5']) {
        await assert.rejects(
          playerHabitInsights.top(bad),
          (error: unknown) => error instanceof HttpError && error.statusCode === 400 && error.message === 'Days must be 7, 30 or 90.',
          bad,
        )
      }
      const badReviewers = await request('/admin/players/top?reviewers=nope')
      assert.equal(badReviewers.status, 400)
      assert.equal(badReviewers.body.error, 'Reviewers must be exclude, include or only.')
    })

    await check('the players routes are guarded and answer an admin', async () => {
      const denied = await request('/admin/players/top', { auth: false })
      assert.equal(denied.status, 401)
      const topRoute = await request('/admin/players/top?days=30')
      assert.equal(topRoute.status, 200)
      assert.equal(topRoute.body.days, 30)
      const frequencyRoute = await request('/admin/players/frequency?days=7')
      assert.equal(frequencyRoute.status, 200)
      assert.equal(frequencyRoute.body.days, 7)
    })

    // ── Country hints ────────────────────────────────────────────────────────
    console.log('country hints')
    await reset()
    const phoneUser = user({ username: 'phone_user', phone: '+91 98765 43210' })
    const caUser = user({ username: 'ca_user', phone: '+1 416 555 1234' })
    const gbUser = user({ username: 'gb_user', phone: '+44 20 7946 0958' })
    const localeUser = user({ username: 'locale_user' })
    const keepCountry = user({ username: 'kept', phone: '+91 98765 43211', country: 'US' })
    const noSignal = user({ username: 'silent' })
    await c('users').insertMany([phoneUser, caUser, gbUser, localeUser, keepCountry, noSignal])
    await c('app_sessions').insertMany([
      session('h-phone', phoneUser._id, '2026-11-17T09:00:00.000Z', { device: { os: 'android', form: 'phone', locale: 'en-GB' } }),
      session('h-ca', caUser._id, '2026-11-17T09:00:00.000Z', { device: { os: 'android', form: 'phone', locale: 'en-GB' } }),
      session('h-gb', gbUser._id, '2026-11-17T09:00:00.000Z'),
      // The older locale must lose to the newer one.
      session('h-loc-old', localeUser._id, '2026-11-10T09:00:00.000Z', { device: { os: 'android', form: 'phone', locale: 'en-GB' } }),
      session('h-loc-new', localeUser._id, '2026-11-17T09:00:00.000Z', { device: { os: 'android', form: 'phone', locale: 'ar-DZ' } }),
      session('h-kept', keepCountry._id, '2026-11-17T09:00:00.000Z'),
      session('h-silent', noSignal._id, '2026-11-17T09:00:00.000Z'),
    ])

    await check('the phone wins over the locale', () => {
      assert.deepEqual(countryHintOf({ phone: '+919876543210', locale: 'en-GB' }), { code: 'IN', source: 'phone' })
      assert.deepEqual(countryHintOf({ phone: undefined, locale: 'ar-DZ' }), { code: 'DZ', source: 'locale' })
      assert.equal(countryHintOf({ locale: 'en' }), null)
      assert.equal(countryHintOf({ phone: '+1 555 010 0123' }), null, 'a fictional number names no region')
    })

    await check('a +1 Canadian number is CA, a +44 number is GB', () => {
      assert.equal(countryHintOf({ phone: '+1 416 555 1234' })?.code, 'CA')
      assert.equal(countryHintOf({ phone: '+44 20 7946 0958' })?.code, 'GB')
      assert.equal(countryHintOf({ phone: '+91 98765 43210' })?.code, 'IN')
    })

    await check('the hint pass writes the latest locale and the phone region', async () => {
      const first = await internalAccounts.hintCountries(now)
      assert.deepEqual(first, { checked: 6, changed: 5 })
      const stored = new Map((await c('users').find({}).toArray()).map((row) => [String(row._id), row]))
      assert.deepEqual(stored.get(String(phoneUser._id))!.country_hint, { code: 'IN', source: 'phone' })
      assert.deepEqual(stored.get(String(caUser._id))!.country_hint, { code: 'CA', source: 'phone' })
      assert.deepEqual(stored.get(String(gbUser._id))!.country_hint, { code: 'GB', source: 'phone' })
      assert.deepEqual(stored.get(String(localeUser._id))!.country_hint, { code: 'DZ', source: 'locale' })
      assert.equal('country_hint' in stored.get(String(noSignal._id))!, false, 'no signal, no key')
    })

    await check('a captured country is never overwritten by a hint', async () => {
      const doc = await c('users').findOne({ _id: keepCountry._id })
      assert.equal(doc!.country, 'US')
      assert.deepEqual(doc!.country_hint, { code: 'IN', source: 'phone' })
      const profile = (await playerInsights([doc as never], now)).get(String(keepCountry._id))!
      assert.equal(profile.profile.country, 'US')
      assert.equal(profile.profile.country_source, 'connection')
    })

    await check('the hint pass runs once a day', async () => {
      assert.deepEqual(await internalAccounts.hintCountries(now), { checked: 0, changed: 0 })
      const tomorrow = new Date(now.getTime() + DAY)
      assert.equal((await internalAccounts.hintCountries(tomorrow)).checked, 6)
    })

    await check('profile.country falls back to the hint with its source', async () => {
      const rows = await c('users').find({}).toArray()
      const profiles = await playerInsights(rows as never[], now)
      assert.deepEqual(
        [profiles.get(String(phoneUser._id))!.profile.country, profiles.get(String(phoneUser._id))!.profile.country_source],
        ['IN', 'phone'],
      )
      assert.deepEqual(
        [profiles.get(String(localeUser._id))!.profile.country, profiles.get(String(localeUser._id))!.profile.country_source],
        ['DZ', 'phone_setting'],
      )
      assert.deepEqual(
        [profiles.get(String(noSignal._id))!.profile.country, profiles.get(String(noSignal._id))!.profile.country_source],
        [null, null],
      )
    })

    await check('audience splits the sources it read the country from', async () => {
      const audience = await audienceInsights.audience('30', 'exclude', now)
      audienceSample = audience
      assert.deepEqual(audience.country_sources, { connection: 1, phone: 3, phone_setting: 1, unknown: 1 })
      assert.equal(audience.country_unknown, 1)
      const codes = Object.fromEntries(audience.countries.map((row) => [row.code, row.players]))
      assert.deepEqual(codes, { IN: 1, CA: 1, GB: 1, DZ: 1, US: 1 })
    })

    await check('worlds and the top list read the hint too', async () => {
      const world = { _id: id(), title: 'Hinted', kind: 'world', created_at: at('2026-10-01T00:00:00.000Z') }
      await c('world_templates').insertOne(world)
      const save = id()
      await c('world_instances').insertOne({ _id: save, player_id: phoneUser._id, template_id: world._id, meta: { last_active_at: at('2026-11-17T00:00:00.000Z') } })
      await c('events').insertOne(turn(save, phoneUser._id, '2026-11-17T09:01:00.000Z'))
      const detail = await worldInsights.get(String(world._id))
      assert.deepEqual(detail.insights.countries, [{ code: 'IN', players: 1 }])
      assert.equal(detail.insights.country_unknown, 0)

      const places = await countriesOfPlayers([phoneUser._id, noSignal._id])
      assert.deepEqual(places, { countries: [{ code: 'IN', players: 1 }], unknown: 1 })

      const top = await playerHabitInsights.top('7', 'exclude', now)
      const row = top.top.find((entry) => entry.username === 'phone_user')!
      assert.deepEqual([row.country, row.country_source], ['IN', 'phone'])
    })

    await check("the backfill's dry run writes nothing, apply writes", async () => {
      // Clear the hints so the run has work to do.
      await c('users').updateMany({}, { $unset: { country_hint: '', country_hint_day: '' } })
      const dry = await internalAccounts.backfillCountryHints({ apply: false, now })
      assert.equal(dry.changed, 5)
      assert.equal(await c('users').countDocuments({ country_hint: { $exists: true } }), 0)
      assert.equal(await c('users').countDocuments({ country_hint_day: { $exists: true } }), 0)

      const applied = await internalAccounts.backfillCountryHints({ apply: true, now })
      assert.equal(applied.changed, 5)
      assert.equal(await c('users').countDocuments({ country_hint: { $exists: true } }), 5)
      assert.equal((await c('users').findOne({ _id: keepCountry._id }))!.country, 'US')
    })

    await check('the backfill arguments are --dry-run or --apply only', () => {
      assert.deepEqual(parseBackfillArgs([]), { apply: false })
      assert.deepEqual(parseBackfillArgs(['--dry-run']), { apply: false })
      assert.deepEqual(parseBackfillArgs(['--apply']), { apply: true })
      assert.throws(() => parseBackfillArgs(['--apply', '--dry-run']))
      assert.throws(() => parseBackfillArgs(['--nope']), /Unknown argument/)
    })

    // ── Frequency: how often, how long, when, stickiness, lifecycle ──────────
    console.log('frequency')
    await reset()
    {
      const spans = { p1: ['2026-11-18'], p2: ['2026-11-16', '2026-11-17', '2026-11-18'], p3: ['2026-11-15', '2026-11-16', '2026-11-17', '2026-11-18'] }
      const p4Days = Array.from({ length: 15 }, (_, index) => new Date(at('2026-11-18T09:00:00.000Z').getTime() - (14 - index) * DAY).toISOString())
      const people = [
        user({ username: 'p1', created_at: at('2026-10-01T00:00:00.000Z') }),
        user({ username: 'p2', created_at: at('2026-10-01T00:00:00.000Z') }),
        user({ username: 'p3', created_at: at('2026-10-01T00:00:00.000Z') }),
        user({ username: 'p4', created_at: at('2026-10-01T00:00:00.000Z') }),
      ]
      await c('users').insertMany(people)
      const sessions = [
        ...spans.p1.map((at) => session(`f-p1-${at}`, people[0]._id, at)),
        ...spans.p2.map((at) => session(`f-p2-${at}`, people[1]._id, at)),
        ...spans.p3.map((at) => session(`f-p3-${at}`, people[2]._id, at)),
        ...p4Days.map((at, index) => session(`f-p4-${index}`, people[3]._id, at)),
      ]
      await c('app_sessions').insertMany(sessions)
    }
    const frequency30 = await playerHabitInsights.frequency('30', 'exclude', now)

    await check('active days: the 1, 3, 4 and 15 edges land in their buckets', () => {
      assert.deepEqual(
        frequency30.active_days.map((row) => [row.bucket, row.players]),
        [['1', 1], ['2-3', 1], ['4-7', 1], ['8-14', 0], ['15+', 1]],
      )
    })

    await reset()
    {
      const q1 = user({ username: 'q1' })
      const q2 = user({ username: 'q2' })
      await c('users').insertMany([q1, q2])
      const minute = 60_000
      const visit = (sessionId: string, player: ObjectId, start: string, minutes: number) => ({
        _id: sessionId, install_id: `i-${sessionId}`, user_id: player,
        started_at: at(start), last_at: new Date(at(start).getTime() + minutes * minute),
        app_version: '1.0.14', build: 18, device: { os: 'android', form: 'phone' }, screen_path: [],
      })
      await c('app_sessions').insertMany([
        visit('m1', q1._id, '2026-11-16T09:00:00.000Z', 0.5),
        visit('m2', q1._id, '2026-11-16T10:00:00.000Z', 1),
        visit('m3', q1._id, '2026-11-16T11:00:00.000Z', 2),
        visit('m4', q1._id, '2026-11-16T12:00:00.000Z', 10),
        visit('m5', q1._id, '2026-11-16T13:00:00.000Z', 20),
        visit('m6', q1._id, '2026-11-16T14:00:00.000Z', 45),
        visit('m7', q1._id, '2026-11-16T15:00:00.000Z', 90),
        visit('m8', q2._id, '2026-11-15T23:00:00.000Z', 5),
        visit('m9', q2._id, '2026-11-16T00:30:00.000Z', 5),
      ])
    }
    const frequencyEdge = await playerHabitInsights.frequency('30', 'exclude', now)

    await check('session minutes: bucket edges from last_at minus started_at', () => {
      // 0.5 · (1, 2) · (5, 5, 10) · 20 · 45 · 90.
      assert.deepEqual(
        frequencyEdge.session_minutes.map((row) => [row.bucket, row.sessions]),
        [['<1', 1], ['1-5', 2], ['5-15', 3], ['15-30', 1], ['30-60', 1], ['60+', 1]],
      )
    })

    await check('week_hours: Monday is 0 and the hour is UTC', () => {
      assert.equal(frequencyEdge.week_hours.length, 7)
      assert.equal(frequencyEdge.week_hours[0].length, 24)
      // 2026-11-16 is a Monday; the visits start at 09..15.
      assert.equal(frequencyEdge.week_hours[0][9], 1)
      assert.equal(frequencyEdge.week_hours[0][15], 1)
      assert.equal(frequencyEdge.week_hours[0][0], 1, 'Monday 00:30 UTC')
      // 2026-11-15 is a Sunday: weekday 6, hour 23.
      assert.equal(frequencyEdge.week_hours[6][23], 1)
      assert.equal(frequencyEdge.week_hours[1][23], 0)
    })

    await reset()
    {
      const todayUser = user({ username: 'today', created_at: at('2026-11-01T00:00:00.000Z') })
      const oldUser = user({ username: 'old', created_at: at('2026-11-01T00:00:00.000Z') })
      const olderUser = user({ username: 'older', created_at: at('2026-11-01T00:00:00.000Z') })
      await c('users').insertMany([todayUser, oldUser, olderUser])
      await c('app_sessions').insertMany([
        session('l-today', todayUser._id, '2026-11-12T09:00:00.000Z'),
        session('l-old', oldUser._id, '2026-11-11T09:00:00.000Z'),
        session('l-older', olderUser._id, '2026-11-05T09:00:00.000Z'),
      ])
    }
    const week = await playerHabitInsights.frequency('7', 'exclude', now)

    await check('stickiness: trailing seven and thirty day windows', () => {
      assert.equal(week.stickiness.length, 7)
      assert.equal(week.stickiness[0].date, '2026-11-12')
      // On 2026-11-12: `today` is active; `old` (11-11) is inside the trailing
      // week; `older` (11-05) is seven clear days back, so only `mau` holds it.
      assert.deepEqual(
        [week.stickiness[0].dau, week.stickiness[0].wau, week.stickiness[0].mau],
        [1, 2, 3],
      )
    })

    await check('partial_from is the first day with a full trailing window', async () => {
      assert.equal(week.partial_from, null, 'seven days never reaches past the 90-day retention')
      const long = await playerHabitInsights.frequency('90', 'exclude', now)
      assert.equal(long.partial_from, '2026-09-18')
      assert.equal(long.stickiness.length, 90)
    })

    await reset()
    {
      const newToday = user({ username: 'new_today', created_at: at('2026-11-18T08:00:00.000Z') })
      const returning6 = user({ username: 'returning6', created_at: at('2026-11-01T00:00:00.000Z') })
      const resurrected8 = user({ username: 'resurrected8', created_at: at('2026-11-01T00:00:00.000Z') })
      const neverBefore = user({ username: 'never_before', created_at: at('2026-11-02T00:00:00.000Z') })
      await c('users').insertMany([newToday, returning6, resurrected8, neverBefore])
      await c('app_sessions').insertMany([
        session('l-new', newToday._id, '2026-11-18T08:30:00.000Z'),
        session('l-ret6-a', returning6._id, '2026-11-12T09:00:00.000Z'),
        session('l-ret6-b', returning6._id, '2026-11-18T09:00:00.000Z'),
        session('l-res8-a', resurrected8._id, '2026-11-10T09:00:00.000Z'),
        session('l-res8-b', resurrected8._id, '2026-11-18T09:00:00.000Z'),
        session('l-never', neverBefore._id, '2026-11-18T09:00:00.000Z'),
      ])
    }
    const life = await playerHabitInsights.frequency('7', 'exclude', now)

    await check('lifecycle: away 6 days is returning, away 8 is resurrected', () => {
      const last = life.lifecycle[6]
      assert.equal(last.date, '2026-11-18')
      assert.deepEqual([last.new, last.returning, last.resurrected], [1, 1, 2])
      const dau = life.stickiness[6].dau
      assert.equal(last.new + last.returning + last.resurrected, dau, 'the three buckets are the active players')
    })

    // ── The player page's 91-day window ─────────────────────────────────────
    console.log('player price habits')
    await reset()
    {
      const calUser = user({ username: 'cal' })
      await c('users').insertOne(calUser)
      const save = id()
      await c('world_instances').insertOne({ _id: save, player_id: calUser._id, template_id: new ObjectId() })
      const visit = (sessionId: string, start: string, minutes: number) => ({
        _id: sessionId, install_id: `i-${sessionId}`, user_id: calUser._id,
        started_at: at(start), last_at: new Date(at(start).getTime() + minutes * 60_000),
        app_version: '1.0.14', build: 18, device: { os: 'android', form: 'phone' }, screen_path: [],
      })
      await c('app_sessions').insertMany([
        visit('c1', '2026-11-17T10:00:00.000Z', 30),
        visit('c2', '2026-11-17T18:00:00.000Z', 10),
        visit('c3', '2026-11-18T09:00:00.000Z', 60),
        visit('c4', '2026-11-18T11:00:00.000Z', 45),
      ])
      await c('events').insertMany([
        turn(save, calUser._id, '2026-11-18T09:01:00.000Z'),
        turn(save, calUser._id, '2026-11-18T09:02:00.000Z'),
      ])
      const detail = await playerInsightsService.detail(calUser as never, now)
      await check('the player page calendar is 91 days ending today', () => {
        assert.equal(detail.calendar.length, 91)
        assert.equal(detail.calendar[0].date, '2026-08-20')
        assert.equal(detail.calendar[90].date, '2026-11-18')
        assert.deepEqual(detail.calendar[90], { date: '2026-11-18', turns: 2, sessions: 2 })
      })
      await check('the player page hours ring is 24 UTC hours', () => {
        assert.equal(detail.hours.length, 24)
        assert.deepEqual([detail.hours[9], detail.hours[10], detail.hours[11], detail.hours[18], detail.hours[0]], [1, 1, 1, 1, 0])
      })
      await check('the player page visit lengths: count, median, longest', () => {
        assert.deepEqual(detail.sessions_91d, { count: 4, median_minutes: 37.5, longest_minutes: 60 })
      })
      detailSample = {
        profile: detail.profile,
        calendar: detail.calendar.slice(-2),
        hours: detail.hours,
        sessions_91d: detail.sessions_91d,
      }
    }

    console.log('samples (one JSON line per endpoint, for the report)')
    console.log('internal-patch', JSON.stringify(internalSample))
    console.log('users-row', JSON.stringify(userRowSample))
    console.log('top', JSON.stringify(top7))
    console.log('frequency', JSON.stringify(frequency30))
    console.log('frequency-week', JSON.stringify(week))
    console.log('player-detail', JSON.stringify(detailSample))
    console.log('audience', JSON.stringify(audienceSample))
    console.log(`admin insights 2b audit: ${passed} checks passed`)
  } finally {
    await client.close().catch(() => {})
    mongod.kill()
    await mongod.exited
    await logfile.close()
  }
}

if (process.argv.includes('--bites')) {
  await runBites()
} else {
  await runAudit()
}
