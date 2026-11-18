/**
 * Admin insights (`everlore-docs/phases/admin-insights.md`, part 1): the real
 * worlds, players and billing insight services, and the real admin guard,
 * against a disposable mongod this script starts and owns. No env file, no
 * network, no configured database.
 */
import assert from 'node:assert/strict'
import { mkdtemp, open } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'
import { mock } from 'bun:test'
import { MongoClient, ObjectId } from 'mongodb'

const root = await mkdtemp(join(tmpdir(), 'everlore-admin-insights-audit-'))
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
const client = new MongoClient(`mongodb://127.0.0.1:${port}/admin_insights_audit`, { serverSelectionTimeoutMS: 15_000 })

let passed = 0
async function check(name: string, fn: () => unknown) {
  await fn()
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
  mock.module('../src/config/mongo', () => ({ mongoColl: {
    users: () => c('users'), worldTemplates: () => c('world_templates'), worldInstances: () => c('world_instances'),
    generationLogs: () => c('generation_logs'), events: () => c('events'), memories: () => c('memories'),
    characters: () => c('characters'), appSessions: () => c('app_sessions'), appInstalls: () => c('app_installs'),
    inkLedger: () => c('ink_ledger'), mediaUsage: () => c('media_usage'), billingConfig: () => c('billing_config'),
  } }))
  mock.module('../src/providers/auth.provider', () => ({ normalizePhone: (p: string) => p }))
  mock.module('../src/middleware/rate-limit', () => ({ rateLimit: async () => ({ allowed: true, remaining: 1, retryAfter: 0 }) }))
  mock.module('../src/services/admin-session.service', () => ({
    SESSION_COOKIE: 'everlore_admin_session',
    readSession: async () => null,
    readCookie: () => '',
    constantTimeEqual: (a: string, b: string) => a === b,
  }))
  let summaryCalls = 0
  mock.module('../src/controllers/admin.controller', () => ({ adminController: new Proxy({}, {
    get: (_t, key) => key === 'getBillingSummary' ? () => { summaryCalls++; return { ok: true } } : () => ({}),
  }) }))
  const { Elysia } = await import('elysia')
  mock.module('../src/routes/admin-story-engine.routes', () => ({ adminStoryEngineRoutes: new Elysia() }))
  mock.module('../src/routes/admin-analytics.routes', () => ({ adminAnalyticsRoutes: new Elysia() }))

  const { worldInsights } = await import('../src/services/admin-insights-worlds')
  const { playerInsights, playerInsightsService, signInOf } = await import('../src/services/admin-insights-players')
  const { billingInsights } = await import('../src/services/admin-insights-billing')
  const { resetReviewerScopeCache } = await import('../src/services/reviewer-accounts')
  const { daySeries, utcDay } = await import('../src/services/admin-insights')
  const { HttpError } = await import('../src/utils/http-error')
  const { adminRoutes } = await import('../src/routes/admin.routes')

  const DAY = 86_400_000
  const now = new Date()
  const ago = (days: number) => new Date(now.getTime() - days * DAY)
  const id = () => new ObjectId()

  // People: the official account, a creator, three players and a reviewer.
  const official = id(), carl = id(), alice = id(), bob = id(), sam = id(), rev = id(), goneCreator = id()
  await c('users').insertMany([
    { _id: official, username: 'Everlore', preferences: {} },
    { _id: carl, username: 'carl_writes', preferences: { player_name: 'Carl' } },
    { _id: alice, username: 'alice01', providers: ['google'], preferences: {
      player_name: 'Alice', gender: 'female', interests: ['fantasy', 'romance', 'horror', 'scifi'], nsfw_enabled: true } },
    { _id: bob, username: 'bob', providers: ['phone'], preferences: { gender: 'male' } },
    { _id: sam, username: 'guest_sam', guest: true, providers: ['google'], preferences: { gender: 'non_binary' } },
    { _id: rev, username: 'reviewer', reviewer: true, preferences: { gender: 'male' } },
  ])

  // Worlds: official, community character, an official group, a world whose creator is gone.
  const W1 = id(), W2 = id(), G1 = id(), W3 = id()
  await c('world_templates').insertMany([
    { _id: W1, title: 'Iron Coast', kind: 'world', creator_id: official, image_thumb_url: 'thumb1', image_url: 'img1', created_at: ago(50) },
    { _id: W2, title: 'Mira', kind: 'character', creator_id: carl, image_url: 'img2', created_at: ago(40) },
    { _id: G1, title: 'Dorm Six', kind: 'group', creator_id: official, created_at: ago(30) },
    { _id: W3, title: 'Lost Map', creator_id: goneCreator, created_at: ago(20) },
  ])

  // Saves. The group save carries its own world on template_id and the group on group_template_id.
  const a1 = id(), a2 = id(), b1 = id(), s1 = id(), r1 = id(), g1 = id(), c1 = id()
  await c('world_instances').insertMany([
    { _id: a1, player_id: alice, template_id: W1, meta: { total_events: 30, last_active_at: ago(1) } },
    { _id: a2, player_id: alice, template_id: W1, meta: { total_events: 3, last_active_at: ago(5) } },
    { _id: b1, player_id: bob, template_id: W1, meta: { total_events: 1, last_active_at: ago(2) } },
    { _id: s1, player_id: sam, template_id: W1, meta: { total_events: 0 } },
    { _id: r1, player_id: rev, template_id: W1, meta: { total_events: 100, last_active_at: ago(0) } },
    { _id: g1, player_id: alice, template_id: id(), group_template_id: G1, meta: { total_events: 7, last_active_at: ago(0) } },
    { _id: c1, player_id: bob, template_id: W2, meta: { total_events: 60, last_active_at: ago(0) } },
  ])

  const log = (instance: ObjectId, player: ObjectId, days: number, cost: number) =>
    ({ _id: id(), instance_id: instance, player_id: player, created_at: ago(days), turn_cost_usd: cost })
  await c('generation_logs').insertMany([
    log(a1, alice, 0, 0.01), log(a1, alice, 0, 0.01), log(a1, alice, 3, 0.02), log(a1, alice, 40, 5),
    log(b1, bob, 6, 0.03), log(b1, bob, 8, 0.04),
    ...Array.from({ length: 5 }, () => log(r1, rev, 0, 1)),
    log(g1, alice, 1, 0.05), log(g1, alice, 1, 0.05),
    log(c1, bob, 0, 0.5),
  ])
  await c('media_usage').insertMany([
    { _id: id(), player_id: alice, kind: 'image', day: utcDay(now), status: 'settled', created_at: ago(0) },
    { _id: id(), player_id: alice, kind: 'image', day: utcDay(now), status: 'released', created_at: ago(0) },
  ])
  await c('app_sessions').insertMany([
    { _id: 's-old', install_id: 'i1', user_id: alice, started_at: ago(4), last_at: ago(4), app_version: '1.0.12', build: 15,
      device: { model: 'Old', os_version: '14', form: 'tablet' } },
    { _id: 's-new', install_id: 'i1', user_id: alice, started_at: ago(1), last_at: ago(1), app_version: '1.0.14', build: 17,
      device: { model: 'Pixel', os_version: '15', form: 'phone' } },
  ])
  // Bob's ledger: a welcome grant, two charges and the refund of one of them.
  await c('ink_ledger').insertMany([
    { _id: id(), player_id: bob, delta: 50, reason: 'welcome', idempotency_key: 'w', created_at: ago(20) },
    { _id: id(), player_id: bob, delta: -1, reason: 'reserve', idempotency_key: 'r1', created_at: ago(1) },
    { _id: id(), player_id: bob, delta: -1, reason: 'reserve', idempotency_key: 'r2', created_at: ago(1) },
    { _id: id(), player_id: bob, delta: 1, reason: 'release', idempotency_key: 'x2', created_at: ago(1) },
  ])
  await c('billing_config').insertOne({ _id: 'singleton' as never, promo: { unlimited: true, daily_turn_cap: 200 }, updated_at: ago(2) })
  resetReviewerScopeCache()

  const days7 = daySeries(7, now)
  const close = (a: number, b: number) => Math.abs(a - b) < 1e-9

  console.log('worlds list')
  const list = await worldInsights.list({ limit: 50 })
  const byId = new Map(list.items.map(item => [String(item.id), item]))
  const w1 = byId.get(W1.toHexString())!, w2 = byId.get(W2.toHexString())!, gw = byId.get(G1.toHexString())!, w3 = byId.get(W3.toHexString())!
  await check('creator resolves to a person, official flagged', () => {
    assert.equal(w1.creator?.official, true)
    assert.equal(w1.creator?.name, 'Everlore')
    assert.deepEqual([w2.creator?.name, w2.creator?.username, w2.creator?.official], ['Carl', 'carl_writes', false])
    assert.equal(w3.creator, null)
  })
  await check('cover prefers the thumb, then the image, else null', () => {
    assert.deepEqual([w1.cover_url, w2.cover_url, gw.cover_url], ['thumb1', 'img2', null])
  })
  await check('stats leave the reviewer out and skip nothing else', () => {
    assert.deepEqual([w1.stats.players, w1.stats.saves, w1.stats.turns], [3, 4, 34])
    assert.equal(w1.stats.last_played_at, ago(1).toISOString())
  })
  await check('turns_7d is 7 days oldest first, from logs', () => {
    assert.equal(w1.stats.turns_7d.length, 7)
    assert.deepEqual(w1.stats.turns_7d, [1, 0, 0, 1, 0, 0, 2])
    assert.equal(days7[6], utcDay(now))
  })
  await check('cost is the last 30 days only', () => assert.ok(close(w1.stats.cost_usd_30d, 0.11), String(w1.stats.cost_usd_30d)))
  await check('group world counts saves on group_template_id', () => {
    assert.deepEqual([gw.stats.players, gw.stats.saves, gw.stats.turns], [1, 1, 7])
    assert.deepEqual(gw.stats.turns_7d, [0, 0, 0, 0, 0, 2, 0])
    assert.ok(close(gw.stats.cost_usd_30d, 0.1))
  })
  await check('a world with no saves has zero stats, 7 zero days', () => {
    assert.deepEqual(w3.stats, { players: 0, saves: 0, turns: 0, last_played_at: null, turns_7d: [0, 0, 0, 0, 0, 0, 0], cost_usd_30d: 0 })
  })
  const withReviewers = await worldInsights.list({ limit: 50, reviewers: 'include' })
  const w1r = withReviewers.items.find(item => item.id === W1.toHexString())!
  await check('reviewers=include counts the reviewer', () => {
    assert.deepEqual([w1r.stats.players, w1r.stats.turns], [4, 134])
    assert.ok(close(w1r.stats.cost_usd_30d, 5.11))
  })
  const ids = async (opts: Parameters<typeof worldInsights.list>[0]) => (await worldInsights.list(opts)).items.map(item => item.id)
  await check('filters: creator name, kind, source', async () => {
  assert.deepEqual(await ids({ creator: 'CARL' }), [W2.toHexString()])
  assert.deepEqual(await ids({ creator: 'c.rl' }), [], 'creator text is literal, not a pattern')
  assert.deepEqual(await ids({ kind: 'group' }), [G1.toHexString()])
  assert.deepEqual((await ids({ kind: 'world' })).sort(), [W1, W3].map(x => x.toHexString()).sort(), 'a world with no kind is a world')
  assert.deepEqual((await ids({ source: 'official' })).sort(), [W1, G1].map(x => x.toHexString()).sort())
  assert.deepEqual((await ids({ source: 'community' })).sort(), [W2, W3].map(x => x.toHexString()).sort())
  })
  await check('sorts: created, players, turns; a bad sort is a 400', async () => {
  assert.deepEqual(await ids({}), [W3, G1, W2, W1].map(x => x.toHexString()))
  assert.equal((await ids({ sort: 'players' }))[0], W1.toHexString())
  assert.deepEqual((await ids({ sort: 'turns' })).slice(0, 3), [W2, W1, G1].map(x => x.toHexString()))
  assert.equal((await worldInsights.list({ sort: 'turns', limit: 1, page: 2 })).items[0]?.id, W1.toHexString(), 'stat sort pages')
  await assert.rejects(worldInsights.list({ sort: 'bogus' as never }), (e: unknown) => e instanceof HttpError && e.statusCode === 400)
  })

  console.log('world detail')
  const detail = await worldInsights.get(W1.toHexString())
  await check('daily has every one of 30 days, today last', () => {
    assert.equal(detail.insights.daily.length, 30)
    const today = detail.insights.daily[29]
    assert.deepEqual([today.date, today.turns, today.players], [utcDay(now), 2, 1])
    assert.ok(close(today.cost_usd, 0.02))
  })
  await check('gender split counts distinct players, reviewer out', () =>
    assert.deepEqual(detail.insights.gender, { male: 1, female: 1, nonbinary: 1, unset: 0 }))
  await check('depth buckets leave 0-turn saves out', () =>
    assert.deepEqual(detail.insights.depth.map(d => d.saves), [1, 1, 0, 1, 0]))
  await check('top players by turns, as people', () => {
    assert.deepEqual(detail.insights.top_players.map(p => [p.name, p.turns]), [['Alice', 33], ['bob', 1], ['guest_sam', 0]])
    assert.equal(detail.insights.top_players[0].gender, 'female')
  })
  await check('detail keeps the old counts and adds creator, cover, stats', () => {
    assert.equal(detail.counts.instances, 5)
    assert.equal(detail.creator?.official, true)
    assert.equal(detail.cover_url, 'thumb1')
    assert.equal(detail.stats.turns, 34)
  })
  const groupDetail = await worldInsights.get(G1.toHexString())
  await check('group detail reads the group save', () => {
    assert.equal(groupDetail.insights.top_players[0]?.name, 'Alice')
    assert.equal(groupDetail.insights.daily[28].turns, 2)
  })

  console.log('players')
  const rows = await c('users').find({ _id: { $in: [alice, bob, sam] } }).toArray()
  const players = await playerInsights(rows as never, now)
  const pa = players.get(alice.toHexString())!, pb = players.get(bob.toHexString())!, ps = players.get(sam.toHexString())!
  await check('profile: gender, interests, adult, sign-in', () => {
    assert.deepEqual([pa.profile.gender, pa.profile.interests.length, pa.profile.adult, pa.profile.sign_in], ['female', 4, true, 'google'])
    assert.deepEqual([pb.profile.gender, pb.profile.adult, pb.profile.sign_in], ['male', false, 'phone'])
    assert.deepEqual([ps.profile.gender, ps.profile.sign_in], ['nonbinary', 'guest'])
    assert.equal(signInOf({ providers: [] }), 'other')
  })
  await check('device and app version come from the latest session', () => {
    assert.deepEqual(pa.profile.device, { model: 'Pixel', os_version: '15', form: 'phone' })
    assert.equal(pa.profile.app_version, '1.0.14')
    assert.deepEqual([pb.profile.device, pb.profile.app_version], [null, null])
  })
  await check('30-day cost per player', () => {
    assert.ok(close(pa.cost_usd_30d, 0.14), String(pa.cost_usd_30d))
    assert.ok(close(pb.cost_usd_30d, 0.57), String(pb.cost_usd_30d))
  })
  await check('promo on: Ink reads unlimited with what it would have cost', () => {
    // Alice: 5 turns × 1 + 1 made image × 45; the released image is not counted.
    assert.deepEqual(pa.ink, { mode: 'unlimited_promo', balance: 0, ink_equiv_30d: 50 })
    assert.deepEqual(pb.ink, { mode: 'unlimited_promo', balance: 49, ink_equiv_30d: 3 })
  })
  const page = await playerInsightsService.detail(rows.find(r => r._id.equals(alice)) as never, now)
  await check('player page: 30 days of activity and worlds by last played', () => {
    assert.equal(page.activity.length, 30)
    assert.equal(page.activity[29].turns, 2)
    assert.deepEqual([page.activity[28].turns, close(page.activity[28].cost_usd, 0.1)], [2, true])
    assert.deepEqual(page.worlds.map(w => [w.title, w.turns]), [['Dorm Six', 7], ['Iron Coast', 33]])
    assert.equal(page.worlds[1].cover_url, 'thumb1')
  })

  console.log('billing summary')
  const summary = await billingInsights.summary(undefined, 'exclude', now)
  await check('promo state and window', () => {
    assert.deepEqual([summary.promo.unlimited, summary.promo.daily_turn_cap, summary.days], [true, 200, 30])
    assert.equal(summary.promo.updated_at, ago(2).toISOString())
  })
  await check('cost totals leave the reviewer and old logs out', () => {
    assert.equal(summary.cost.turns, 8)
    assert.ok(close(summary.cost.total_usd, 0.71), String(summary.cost.total_usd))
    assert.equal(summary.cost.active_players, 2)
    assert.ok(close(summary.cost.per_active_player_usd, 0.355))
  })
  await check('daily rows: every day, today priced in Ink', () => {
    assert.equal(summary.daily.length, 30)
    const today = summary.daily[29]
    assert.deepEqual([today.date, today.turns, today.active_players, today.ink_equiv], [utcDay(now), 3, 2, 48])
    assert.ok(close(today.cost_usd, 0.52))
  })
  await check('Ink: what it would have cost, nothing spent during the promo', () =>
    assert.deepEqual(summary.ink, { equiv_total: 53, spent_total: 0 }))
  await check('top players and worlds by cost, with people attached', () => {
    assert.deepEqual(summary.top_players.map(p => p.username), ['bob', 'alice01'])
    assert.equal(summary.top_players[0].ink_equiv, 3)
    assert.deepEqual(summary.top_worlds.map(w => w.title), ['Mira', 'Iron Coast', 'Dorm Six'])
    assert.equal(summary.top_worlds[0].creator?.username, 'carl_writes')
    assert.equal(summary.top_worlds[0].cover_url, 'img2')
  })
  const summary7 = await billingInsights.summary('7', 'exclude', now)
  const summaryRev = await billingInsights.summary('30', 'include', now)
  await check('7-day window and reviewers=include', () => {
    assert.deepEqual([summary7.days, summary7.daily.length, summary7.cost.turns], [7, 7, 7])
    assert.ok(close(summaryRev.cost.total_usd, 5.71))
    assert.equal(summaryRev.cost.active_players, 3)
  })
  await assert.rejects(billingInsights.summary('14'), (e: unknown) => e instanceof HttpError && e.statusCode === 400)

  console.log('promo off (waiting out the 5 s billing config cache)')
  await c('billing_config').updateOne({ _id: 'singleton' as never }, { $set: { 'promo.unlimited': false } })
  await Bun.sleep(5_100)
  const metered = await playerInsights(rows as never, now)
  const off = await billingInsights.summary(undefined, 'exclude', now)
  await check('metered Ink: ledger balance and spend net of the refund', () => {
    assert.deepEqual(metered.get(bob.toHexString())!.ink, { mode: 'metered', balance: 49, spent_30d: 1 })
    assert.deepEqual([off.promo.unlimited, off.ink.spent_total], [false, 1])
  })

  console.log('guard')
  const app = new Elysia().use(adminRoutes)
  const anon = await app.handle(new Request('http://audit.local/admin/billing/summary'))
  await check('summary refuses a caller who is not an admin', () => assert.equal(anon.status, 401))
  assert.equal(summaryCalls, 0)
  const authed = await app.handle(new Request('http://audit.local/admin/billing/summary?days=7', {
    headers: { authorization: `Basic ${Buffer.from(`${ADMIN_USER}:${ADMIN_PASS}`).toString('base64')}` },
  }))
  await check('summary answers an admin', () => { assert.equal(authed.status, 200); assert.equal(summaryCalls, 1) })

  console.log(`admin insights audit: ${passed} checks passed`)
} finally {
  await client.close().catch(() => {})
  mongod.kill()
  await mongod.exited
  await logfile.close()
}
