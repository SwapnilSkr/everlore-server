/**
 * Admin insights, part 2 (`everlore-docs/phases/admin-insights.md`, "Contract,
 * part 2"): the real audience, screen-paths, retention, group-activity and
 * extras services, against a disposable mongod this script starts and owns.
 * No env file, no network, no configured database.
 *
 * Every check is written to fail if its field goes missing or its rule is
 * changed: the counts are derived by hand in the comments beside them, and the
 * `--bites` mode of `scripts/admin-insights-2-audit-bites.ts` proves the named
 * ones by breaking the code.
 */
import assert from 'node:assert/strict'
import { mkdtemp, open } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'
import { mock } from 'bun:test'
import { MongoClient, ObjectId } from 'mongodb'

const root = await mkdtemp(join(tmpdir(), 'everlore-admin-insights-2-audit-'))
const probe = createServer()
await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve))
const address = probe.address()
assert(address && typeof address !== 'string')
const port = address.port
await new Promise<void>((resolve, reject) => probe.close(error => error ? reject(error) : resolve()))
const logfile = await open(join(root, 'mongod.log'), 'w')
const mongod = Bun.spawn(['mongod', '--bind_ip', '127.0.0.1', '--port', String(port), '--dbpath', root, '--nounixsocket'], {
  stdin: 'ignore', stdout: logfile.fd, stderr: logfile.fd,
})
const client = new MongoClient(`mongodb://127.0.0.1:${port}/admin_insights_2_audit`, { serverSelectionTimeoutMS: 15_000 })

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
  const ADMIN_USER = 'audit-admin', ADMIN_PASS = crypto.randomUUID()
  const known: Record<string, unknown> = {
    ADMIN_USERNAME: ADMIN_USER, ADMIN_PASSWORD: ADMIN_PASS, REVIEW_DEMO_PHONE: undefined,
    INK_PROMO_UNLIMITED: false, INK_PROMO_DAILY_TURN_CAP: 0, NODE_ENV: 'test',
  }
  mock.module('../src/config/env', () => ({ env: new Proxy(known, {
    get(target, key) {
      if (typeof key === 'string' && key in target) return target[key]
      throw new Error(`admin insights audit read env.${String(key)}`)
    },
  }) }))
  mock.module('../src/config/mongo', () => ({
    coll: (name: string) => c(name),
    mongoColl: {
      users: () => c('users'), worldTemplates: () => c('world_templates'), worldInstances: () => c('world_instances'),
      events: () => c('events'), appSessions: () => c('app_sessions'), appInstalls: () => c('app_installs'),
      billingConfig: () => c('billing_config'),
    },
  }))
  mock.module('../src/providers/auth.provider', () => ({ normalizePhone: (p: string) => p }))
  mock.module('../src/middleware/rate-limit', () => ({ rateLimit: async () => ({ allowed: true, remaining: 1, retryAfter: 0 }) }))
  mock.module('../src/services/admin-session.service', () => ({
    SESSION_COOKIE: 'everlore_admin_session',
    readSession: async () => null,
    readCookie: () => '',
    constantTimeEqual: (a: string, b: string) => a === b,
  }))

  const { audienceInsights } = await import('../src/services/admin-audience')
  const { pathInsights, collapseRepeats, startSteps, exitSteps } = await import('../src/services/telemetry/paths.service')
  const { retentionInsights } = await import('../src/services/admin-overview-retention.service')
  const { groupInsights } = await import('../src/services/admin-overview-groups.service')
  const { ACCOUNTS_HIDDEN, ACCOUNTS_SHOWN, resetReviewerScopeCache } = await import('../src/services/reviewer-accounts')
  const { HttpError } = await import('../src/utils/http-error')

  const DAY = 86_400_000
  const now = new Date()
  const ago = (days: number) => new Date(now.getTime() - days * DAY)
  const at = (daysAgo: number, hours = 12) => {
    const day = new Date(now.getTime() - daysAgo * DAY)
    const start = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate())
    const wanted = start + hours * 3_600_000
    // Before `hours` UTC, "today at noon" is still in the future and falls out of
    // the window (CI at 06:35 UTC, 2026-11-26): keep it today, but in the past.
    return new Date(wanted < now.getTime() ? wanted : start + (now.getTime() - start) / 2)
  }
  const id = () => new ObjectId()
  const day = (delta: number) => new Date(Date.now() - delta * DAY).toISOString().slice(0, 10)

  // ---- audience -----------------------------------------------------------
  // Four active players in the window (a session started within 30 days), plus
  // a reviewer and one player whose only session is 40 days old (outside it).
  const ina = id(), inb = id(), inc = id(), ind = id(), out = id(), rev = id()
  const reviewerOnly = id()
  await c('users').insertMany([
    { _id: ina, username: 'a', providers: ['google'], country: 'IN', created_at: ago(3),
      preferences: { gender: 'female', interests: ['fantasy', 'romance'], nsfw_enabled: true } },
    { _id: inb, username: 'b', providers: ['phone'], country: 'US', created_at: ago(20),
      preferences: { gender: 'male', interests: ['fantasy'], nsfw_enabled: false } },
    { _id: inc, username: 'c', guest: true, providers: ['google'], created_at: ago(1),
      preferences: { gender: 'non_binary', interests: [], nsfw_enabled: false } },
    // No gender: the `unset` row.
    { _id: ind, username: 'd', providers: [], country: 'IN', created_at: ago(1), preferences: {} },
    { _id: out, username: 'e', providers: ['google'], created_at: ago(40), preferences: { gender: 'male' } },
    { _id: rev, username: 'reviewer', reviewer: true, providers: ['google'], country: 'GB', created_at: ago(2),
      preferences: { gender: 'male', nsfw_enabled: true } },
    { _id: reviewerOnly, username: 'reviewer_install', reviewer: true, providers: ['google'], created_at: ago(2),
      preferences: { gender: 'male' } },
  ])
  const session = (sessionId: string, userId: ObjectId | undefined, started: Date, extra: Record<string, unknown> = {}) =>
    ({ _id: sessionId, install_id: `i-${sessionId}`, ...(userId ? { user_id: userId } : {}), started_at: started, last_at: started,
      app_version: '1.0.14', build: 18, device: { model: 'Pixel', os_version: '15', form: 'phone' }, ...extra })
  await c('app_sessions').insertMany([
    // `ina` opens today but its only session has fewer than 100 steps.
    session('s1', ina, at(0), { screen_path: [{ screen: 'play', duration_ms: 1 }, { screen: 'play', duration_ms: 1 }, { screen: 'realms', duration_ms: 1 }] }),
    // `inb` has two sessions: the tablet one is older, so the phone one must win.
    session('s2', inb, at(6), { device: { model: 'Galaxy', os_version: '14', form: 'tablet' }, app_version: '1.0.12' }),
    session('s2b', inb, at(2), { device: { model: 'Phone', os_version: '16', form: 'phone' }, app_version: '1.0.14' }),
    session('s3', inc, at(1)),
    session('s4', ind, at(1)),
    // A session for `out`, but 40 days ago: outside a 30-day window.
    session('s5', out, at(40)),
    // Reviewer's session on the reviewer's own install.
    session('s6', rev, at(1)),
    // A reviewer install with no account, which must be excluded by install id.
    { _id: 's7', install_id: 'rev-install', started_at: at(0), last_at: at(0), app_version: '1.0.14', build: 18,
      device: { model: 'Pixel', os_version: '15', form: 'phone' } },
  ])
  await c('app_installs').insertMany([
    { _id: 'rev-install', user_ids: [reviewerOnly], first_seen: ago(2), last_seen: ago(0), first_version: '1.0.14', build: 18, device: {} },
  ])

  // Saves, for the genre count and the group panel. `ina` played Iron Coast
  // (fantasy) and a group (genre left out: its template has none).
  const W1 = id(), G1 = id(), G2 = id(), G3 = id()
  await c('world_templates').insertMany([
    { _id: W1, title: 'Iron Coast', kind: 'world', creator_id: ina, genre: 'fantasy', created_at: ago(50) },
    { _id: G1, title: 'Dorm Six', kind: 'group', creator_id: ina, created_at: ago(30) },
    { _id: G2, title: 'No Genre Group', kind: 'group', creator_id: inb, created_at: ago(30) },
    { _id: G3, title: 'Quiet Group', kind: 'group', creator_id: ind, created_at: ago(30) },
  ])
  const save1 = id(), save2 = id(), save3 = id(), gsave = id(), gsave2 = id(), gsave3 = id()
  await c('world_instances').insertMany([
    { _id: save1, player_id: ina, template_id: W1, meta: { last_active_at: ago(1) } },
    { _id: save2, player_id: inb, template_id: W1, meta: { last_active_at: ago(2) } },
    { _id: save3, player_id: out, template_id: W1, meta: { last_active_at: ago(1) } },
    { _id: gsave, player_id: ina, template_id: G1, group_template_id: G1, meta: { last_active_at: ago(0) } },
    { _id: gsave2, player_id: inb, template_id: G2, group_template_id: G2, meta: { last_active_at: ago(4) } },
    // A group with calls but no turn in the window: cost yes, active no.
    { _id: gsave3, player_id: ind, template_id: G3, group_template_id: G3, meta: { last_active_at: ago(9) } },
  ])
  const turn = (instance: ObjectId, player: ObjectId, when: Date, type = 'narration') =>
    ({ _id: id(), instance_id: instance, player_id: player, type, sequence: 1, created_at: when })
  await c('events').insertMany([
    // ina: 2 turns on the world, 1 on the group (counts in `turns`).
    turn(save1, ina, at(1)), turn(save1, ina, at(0)), turn(gsave, ina, at(0)),
    // inb: 3 turns on the world.
    turn(save2, inb, at(2)), turn(save2, inb, at(1)), turn(save2, inb, at(0)),
    // The group without a genre: two turns on `gsave2`.
    turn(gsave2, inb, at(4)), turn(gsave2, inb, at(4)),
    // A non-story type: counts nowhere.
    turn(save2, inb, at(0), 'group_state'),
  ])
  await c('llm_calls').insertMany([
    // Group cost: 0.30 on Dorm Six, 0.10 on the no-genre group.
    { _id: id(), instance_id: gsave, player_id: ina, cost_usd: 0.3, created_at: at(0), prompt_tokens: 10, completion_tokens: 1 },
    { _id: id(), instance_id: gsave2, player_id: inb, cost_usd: 0.1, created_at: at(4), prompt_tokens: 10, completion_tokens: 1 },
    // A group's call with no turn in the window: cost yes, `groups_active` no.
    { _id: id(), instance_id: gsave, player_id: ina, cost_usd: 0.05, created_at: at(0), prompt_tokens: 10, completion_tokens: 1 },
    { _id: id(), instance_id: gsave3, player_id: ind, cost_usd: 0.2, created_at: at(9), prompt_tokens: 10, completion_tokens: 1 },
  ])
  resetReviewerScopeCache()

  console.log('audience')
  const audience = await audienceInsights.audience('30', ACCOUNTS_HIDDEN, now)
  await check('population is the accounts with a session in the window, reviewers out', () =>
    assert.equal(audience.active_players, 4))
  await check('gender split over active players, with an unset row', () =>
    assert.deepEqual(audience.gender, { male: 1, female: 1, nonbinary: 1, unset: 1 }))
  await check('interests count every key held, players desc', () =>
    assert.deepEqual(audience.interests, [{ key: 'fantasy', players: 2 }, { key: 'romance', players: 1 }]))
  await check('adult on/off from preferences.nsfw_enabled', () =>
    assert.deepEqual(audience.adult, { on: 1, off: 3 }))
  await check('sign-in splits google, phone, guest, other', () =>
    assert.deepEqual(audience.sign_in, { google: 1, phone: 1, guest: 1, other: 1 }))
  await check('countries from users.country, unknown counted', () =>
    assert.deepEqual([audience.countries, audience.country_unknown], [[{ code: 'IN', players: 2 }, { code: 'US', players: 1 }], 1]))
  await check('devices use each player\'s latest session in the window', () => {
    // ina, inc, ind on a Pixel phone; inb's *latest* session is a phone too, so
    // the older Galaxy tablet must not count at all.
    assert.deepEqual(audience.devices.form, { phone: 4, tablet: 0, unknown: 0 })
    assert.deepEqual(audience.devices.models, [{ model: 'Pixel', players: 3 }, { model: 'Phone', players: 1 }])
    assert.deepEqual(audience.devices.os_versions, [{ version: '15', players: 3 }, { version: '16', players: 1 }])
    assert.deepEqual(audience.devices.app_versions, [{ version: '1.0.14', players: 4 }])
  })
  await check('engagement is always the four rows, in order', () =>
    assert.deepEqual(audience.engagement.map(row => row.gender), ['male', 'female', 'nonbinary', 'unset']))
  await check('engagement: players and turns per gender, 1 decimal', () => {
    const byGender = new Map(audience.engagement.map(row => [row.gender, row]))
    assert.deepEqual([byGender.get('female')!.players, byGender.get('female')!.turns, byGender.get('female')!.turns_per_player], [1, 3, 3])
    // inb: 3 world turns plus 2 on the group without a genre = 5.
    assert.deepEqual([byGender.get('male')!.players, byGender.get('male')!.turns], [1, 5])
    assert.deepEqual([byGender.get('unset')!.players, byGender.get('unset')!.turns, byGender.get('unset')!.turns_per_player], [1, 0, 0])
  })
  await check('engagement: genres are the world\'s genre, a world without one left out', () => {
    const byGender = new Map(audience.engagement.map(row => [row.gender, row]))
    assert.deepEqual(byGender.get('female')!.genres, [{ genre: 'fantasy', players: 1 }])
    assert.deepEqual(byGender.get('male')!.genres, [{ genre: 'fantasy', players: 1 }])
    assert.deepEqual(byGender.get('nonbinary')!.genres, [])
  })
  await check('return_d1: signup today is not eligible; a next-day session returns', () => {
    // `ina` signed up 3 days ago and has a session today only: eligible, not returned.
    // `inb` 20 days ago, `ind` yesterday, `inc` yesterday: none returned.
    const female = audience.engagement.find(row => row.gender === 'female')!
    assert.deepEqual(female.return_d1, { eligible: 1, returned: 0 })
    // Everyone in the window signed up before today except `ind`? `ind` is 1 day
    // ago, so eligible. `male` here is `inb` (20 days) → eligible, not returned.
    const male = audience.engagement.find(row => row.gender === 'male')!
    assert.deepEqual(male.return_d1, { eligible: 1, returned: 0 })
  })
  await check('a reviewer-heavy window with reviewers=include changes the population', async () => {
    // The four players plus the reviewer account with a session; the flagged
    // install with no account is a session too, but has no account to count.
    const included = await audienceInsights.audience('30', ACCOUNTS_SHOWN, now)
    assert.equal(included.active_players, 5)
    assert.deepEqual(included.gender, { male: 2, female: 1, nonbinary: 1, unset: 1 })
  })
  for (const bad of ['14', '0', 'x', '7.5']) {
    await assert.rejects(
      audienceInsights.audience(bad),
      (e: unknown) => e instanceof HttpError && e.statusCode === 400 && e.message === 'Days must be 7, 30 or 90.',
      bad,
    )
  }

  console.log('paths')
  // The rules as functions first, so a change to any one is visible.
  await check('consecutive repeats collapse to one step', () =>
    assert.deepEqual(collapseRepeats(['a', 'a', 'b', 'b', 'b', 'a']), ['a', 'b', 'a']))
  await check('a start is the first four screens, and a 100-step session has none', () => {
    assert.deepEqual(startSteps(['a', 'b', 'c', 'd', 'e']), ['a', 'b', 'c', 'd'])
    assert.equal(startSteps(Array.from({ length: 100 }, (_, i) => `s${i}`)), null)
  })
  await check('an exit is the last three screens', () =>
    assert.deepEqual(exitSteps(['a', 'b', 'c', 'd', 'e']), ['c', 'd', 'e']))
  await check('a one-screen session is a path of one', () =>
    assert.deepEqual([startSteps(['play']), exitSteps(['play'])], [['play'], ['play']]))
  const paths = await pathInsights.paths('30', undefined, ACCOUNTS_HIDDEN, now)
  // s1, s2, s2b, s3, s4 are inside 30 days and are not reviewers; s5 is 40 days
  // old, s6 is the reviewer's account and s7 their install.
  await check('paths read sessions by last_at in the window, reviewers out', () =>
    assert.equal(paths.sessions, 5))
  await check('starts: the repeated screens collapse to one', () => {
    // s1 is play,play,realms → [play, realms].
    const start = paths.starts.find(entry => entry.steps[0] === 'play' && entry.steps[1] === 'realms')
    assert.ok(start, JSON.stringify(paths.starts))
    assert.equal(start!.sessions, 1)
    assert.equal(paths.days, 30)
  })
  await check('exits are the last screens, and a start is suppressed past 100 steps', async () => {
    // A second set of sessions with explicit ends and one long session.
    await c('app_sessions').insertMany([
      { _id: 'p-long', install_id: 'pl', user_id: ina, started_at: at(1), last_at: at(1), app_version: '9.9.9', build: 1,
        device: { form: 'phone' },
        // 100 steps: the start is gone, so it contributes to `exits` only.
        screen_path: Array.from({ length: 100 }, (_, index) => ({ screen: `x${index}`, duration_ms: 1 })) },
      { _id: 'p-exit', install_id: 'pe', user_id: inb, started_at: at(1), last_at: at(1), app_version: '9.9.9', build: 1,
        device: { form: 'phone' },
        screen_path: [{ screen: 'play' }, { screen: 'realms' }, { screen: 'realms' }, { screen: 'keepsakes' }, { screen: 'profile' }] },
    ])
    const filtered = await pathInsights.paths('30', '9.9.9', ACCOUNTS_SHOWN, now)
    assert.equal(filtered.sessions, 2)
    // The 100-step session contributes no start; the short one contributes both.
    assert.equal(filtered.starts.length, 1)
    assert.deepEqual(filtered.starts[0].steps, ['play', 'realms', 'keepsakes', 'profile'])
    // The long session ends at x99; the short one ends profile → the collapsed
    // tail is play,realms,keepsakes,profile's last three.
    const exitFor = (steps: string[]) => filtered.exits.find(entry => entry.steps.join('|') === steps.join('|'))
    assert.ok(exitFor(['realms', 'keepsakes', 'profile']), JSON.stringify(filtered.exits))
    assert.ok(exitFor(['x97', 'x98', 'x99']), JSON.stringify(filtered.exits))
    await c('app_sessions').deleteMany({ _id: { $in: ['p-long', 'p-exit'] } })
  })
  await check('a version filter narrows the sessions', async () => {
    // 1.0.14 only: s1, s3, s4 and s2b for the players, s6 (reviewer) and s7
    // (reviewer install, included); s2 is 1.0.12 and must not appear.
    const v1 = await pathInsights.paths('30', '1.0.14', ACCOUNTS_SHOWN, now)
    assert.equal(v1.sessions, 6)
    const v12 = await pathInsights.paths('30', '1.0.12', ACCOUNTS_SHOWN, now)
    assert.equal(v12.sessions, 1)
  })
  for (const bad of ['3', '91', 'x']) {
    await assert.rejects(
      pathInsights.paths(bad),
      (e: unknown) => e instanceof HttpError && e.statusCode === 400 && e.message === 'Days must be 7, 30 or 90.',
      bad,
    )
  }

  console.log('retention')
  // A fixed clock so the Monday boundaries are exact: 2026-11-18 is a Wednesday.
  // The audience's accounts are cleared first so this fixture is the only set of
  // signups in the window.
  await c('users').deleteMany({})
  await c('app_sessions').deleteMany({})
  const clock = new Date('2026-11-18T09:00:00.000Z')
  await c('users').insertMany([
    // Two signups in the week of Mon 2026-11-16, one active in its signup week.
    { _id: id(), username: 'r1', created_at: new Date('2026-11-16T10:00:00.000Z'), preferences: {} },
    { _id: id(), username: 'r2', created_at: new Date('2026-11-17T10:00:00.000Z'), preferences: {} },
    // One signup in the week of Mon 2026-11-09, active in week 0 and week 1.
    { _id: id(), username: 'r3', created_at: new Date('2026-11-10T10:00:00.000Z'), preferences: {} },
    // One signup in the week of Mon 2026-10-26 (3 weeks back), active only in
    // week 0.
    { _id: id(), username: 'r4', created_at: new Date('2026-10-28T10:00:00.000Z'), preferences: {} },
  ])
  const [r1, r2, r3, r4] = (await c('users').find({ username: { $in: ['r1', 'r2', 'r3', 'r4'] } }).toArray())
  await c('app_sessions').insertMany([
    { _id: 'rt1', install_id: 'ri1', user_id: r1._id, started_at: new Date('2026-11-16T11:00:00.000Z'), last_at: new Date('2026-11-16T11:00:00.000Z'), app_version: '1.0.14', build: 18, device: {} },
    { _id: 'rt3a', install_id: 'ri3', user_id: r3._id, started_at: new Date('2026-11-10T11:00:00.000Z'), last_at: new Date('2026-11-10T11:00:00.000Z'), app_version: '1.0.14', build: 18, device: {} },
    { _id: 'rt3b', install_id: 'ri3', user_id: r3._id, started_at: new Date('2026-11-17T11:00:00.000Z'), last_at: new Date('2026-11-17T11:00:00.000Z'), app_version: '1.0.14', build: 18, device: {} },
    { _id: 'rt4', install_id: 'ri4', user_id: r4._id, started_at: new Date('2026-10-28T11:00:00.000Z'), last_at: new Date('2026-10-28T11:00:00.000Z'), app_version: '1.0.14', build: 18, device: {} },
    // r2 never opens the app: a signup with no activity.
  ])
  resetReviewerScopeCache()
  const retention = await retentionInsights.retention('4', clock)
  await check('retention: four Monday cohorts, oldest first', () => {
    assert.equal(retention.weeks, 4)
    assert.deepEqual(retention.cohorts.map(row => row.week), ['2026-10-26', '2026-11-02', '2026-11-09', '2026-11-16'])
  })
  await check('retention: signups per week and active per week', () => {
    const [w0, w1, w2, w3] = retention.cohorts
    assert.deepEqual([w0.signups, w0.active[0]], [1, 1])
    assert.deepEqual([w1.signups, w1.active[0]], [0, 0])
    assert.deepEqual([w2.signups, w2.active[0], w2.active[1]], [1, 1, 1])
    assert.deepEqual([w3.signups, w3.active[0]], [2, 1])
  })
  await check('retention: a week not yet reached is null, not zero', () => {
    const w3 = retention.cohorts[3]
    // The current week is 0; weeks 1-3 have not begun.
    assert.deepEqual(w3.active.slice(1), [null, null, null])
  })
  await check('retention: a bad weeks value is a 400 sentence', async () => {
    for (const bad of ['3', '13', 'x', '7.5']) {
      await assert.rejects(retentionInsights.retention(bad, clock), (e: unknown) => e instanceof HttpError && e.statusCode === 400, bad)
    }
  })

  console.log('return cohorts (d1/d7 edges)')
  // The same fixed clock, and a cohort built to sit exactly on every boundary.
  await c('users').deleteMany({})
  await c('app_sessions').deleteMany({})
  const signupDay = new Date('2026-11-04T10:00:00.000Z')
  const people = {
    d7In: id(), farBound: id(), pastBound: id(), d1In: id(), yesterday: id(), today: id(),
  }
  await c('users').insertMany(Object.entries(people).map(([name, userId]) => ({
    _id: userId, username: name, providers: ['google'],
    created_at: name === 'yesterday' ? new Date('2026-11-17T10:00:00.000Z')
      : name === 'today' ? new Date('2026-11-18T08:00:00.000Z') : signupDay,
    preferences: { gender: 'female', interests: [] },
  })))
  const opened = (userId: ObjectId, at: string, sessionId: string) => ({
    _id: sessionId, install_id: `i-${sessionId}`, user_id: userId, started_at: new Date(at), last_at: new Date(at),
    app_version: '1.0.14', build: 18, device: { model: 'Pixel', os_version: '15', form: 'phone' },
  })
  await c('app_sessions').insertMany([
    // signup + 7 exactly: inside the day-7 window.
    opened(people.d7In, '2026-11-11T10:00:00.000Z', 'd7-in'),
    // signup + 13 exactly: the last day the day-7 window counts.
    opened(people.farBound, '2026-11-17T10:00:00.000Z', 'far-bound'),
    // signup + 14: just past it, so it must not count as a return.
    opened(people.pastBound, '2026-11-18T07:00:00.000Z', 'past-bound'),
    // signup + 1: returns day-1.
    opened(people.d1In, '2026-11-05T10:00:00.000Z', 'd1-in'),
    // Yesterday's account, today: eligible for d1, but today is not the next day.
    opened(people.yesterday, '2026-11-17T11:00:00.000Z', 'yesterday-same-day'),
    // Today's account, today: eligible for nothing.
    opened(people.today, '2026-11-18T08:30:00.000Z', 'today-same-day'),
  ])
  resetReviewerScopeCache()
  const returns = await audienceInsights.audience('30', ACCOUNTS_HIDDEN, clock)
  const female = returns.engagement.find(row => row.gender === 'female')!
  await check('return_d1: eligible from the day after signup, returned on signup + 1', () =>
    // d7In, farBound, pastBound, d1In and yesterday are before today; only d1In
    // opened on its own signup + 1.
    assert.deepEqual(female.return_d1, { eligible: 5, returned: 1 }))
  await check('return_d7: eligible from signup + 7, returned in signup + 7..+13 only', () =>
    // d7In (+7) and farBound (+13) return; pastBound (+14) is outside the window
    // even though it did open the app.
    assert.deepEqual(female.return_d7, { eligible: 4, returned: 2 }))
  await check('a signup today is not eligible for day-1 or day-7', async () => {
    const earlier = new Date('2026-11-18T00:00:01.000Z')
    const sameDay = await audienceInsights.audience('30', ACCOUNTS_HIDDEN, earlier)
    const row = sameDay.engagement.find(entry => entry.gender === 'female')!
    assert.equal(row.players, 6)
    // `today` signed up on this very day, so eligible counts exclude it.
    assert.equal(row.return_d1.eligible, 5)
    assert.equal(row.return_d7.eligible, 4)
  })

  console.log('group activity')
  const groups = await groupInsights.groups('30', ACCOUNTS_HIDDEN, now)
  await check('groups: totals over group saves in the window', () => {
    // Dorm Six has 1 turn today; the no-genre group has 2, four days ago.
    assert.deepEqual(groups.days, 30)
    assert.equal(groups.totals.players, 2)
    assert.equal(groups.totals.turns, 3)
    // 0.30 + 0.05 (Dorm Six, two calls) + 0.10 (no-genre group) + 0.20 (Quiet
    // Group, which has no turn but did spend) = 0.65.
    assert.ok(Math.abs(groups.totals.cost_usd - 0.65) < 1e-9, String(groups.totals.cost_usd))
  })
  await check('groups: every day present, today belongs to one group', () => {
    assert.equal(groups.daily.length, 30)
    const today = groups.daily[29]
    assert.deepEqual([today.date, today.turns, today.groups_active, today.players], [day(0), 1, 1, 1])
  })
  await check('groups: top_groups by turns, with covers and last played', () => {
    // By turns: the no-genre group (2), Dorm Six (1), then Quiet Group (0 but
    // real cost, so it is still a row).
    assert.deepEqual(groups.top_groups.map(group => [group.title, group.turns]), [['No Genre Group', 2], ['Dorm Six', 1], ['Quiet Group', 0]])
    const dorm = groups.top_groups.find(group => group.id === G1.toHexString())!
    assert.ok(dorm.last_played_at)
    assert.ok(Math.abs(dorm.cost_usd - 0.35) < 1e-9, String(dorm.cost_usd))
  })
  await check('groups: a group whose only window calls had no turn is not active', () => {
    // Quiet Group has cost and no turn, so `groups_active` stays 2 while the
    // cost total counts it: the two numbers answer different questions.
    assert.equal(groups.totals.groups_active, 2)
    assert.equal(groups.top_groups.length, 3)
  })
  for (const bad of ['14', '0', 'abc']) {
    await assert.rejects(
      groupInsights.groups(bad),
      (e: unknown) => e instanceof HttpError && e.statusCode === 400 && e.message === 'Days must be 7, 30 or 90.',
      bad,
    )
  }

  console.log('samples (one JSON line per endpoint, for the report)')
  console.log('audience', JSON.stringify(audience))
  console.log('paths', JSON.stringify(paths))
  console.log('retention', JSON.stringify(retention))
  console.log('groups', JSON.stringify(groups))
  console.log(`admin insights 2 audit: ${passed} checks passed`)
} finally {
  await client.close().catch(() => {})
  mongod.kill()
  await mongod.exited
  await logfile.close()
}
