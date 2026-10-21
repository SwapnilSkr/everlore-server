/** Isolated HTTP smoke test. Own loopback databases, synthetic accounts, no providers. */
import assert from 'node:assert/strict'
import { mkdtempSync, openSync, closeSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { MongoClient, ObjectId } from 'mongodb'
import { userActivityStages } from '../src/services/admin-activity'
import { onboardingFacets } from '../src/services/admin-onboarding'
import { SignJWT } from 'jose'

const localEnv = {
  PATH: '/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin',
  NODE_ENV: 'test', PORT: '8081',
  MONGODB_URI: 'mongodb://127.0.0.1:27029/admin_ops_smoke', REDIS_URL: 'redis://127.0.0.1:6399',
  JWT_SECRET: randomBytes(32).toString('hex'),
  ADMIN_USERNAME: 'local-smoke-admin', ADMIN_PASSWORD: randomBytes(32).toString('hex'),
  OPENAI_API_KEY: 'offline-fixture', OPENROUTER_API_KEY: 'offline-fixture', PINECONE_API_KEY: 'offline-fixture',
  INK_PROMO_UNLIMITED: 'true', INK_PROMO_DAILY_TURN_CAP: '500',
  BILLING_ENFORCEMENT_ENABLED: 'true',
}
for (const port of [8081, 27029, 6399]) {
  const check = Bun.spawn(['lsof', '-nP', `-iTCP:${port}`, '-sTCP:LISTEN'], { stdout: 'ignore', stderr: 'ignore', env: { PATH: localEnv.PATH } })
  assert.equal(await check.exited, 1, `Port ${port} is occupied; refusing to start or stop anyone else's server`)
}
const scratch = mkdtempSync(join(tmpdir(), 'everlore-admin-smoke-'))
const processes: ReturnType<typeof Bun.spawn>[] = []
const logs: number[] = []
const client = new MongoClient(localEnv.MONGODB_URI, { serverSelectionTimeoutMS: 1000 })
function spawn(cmd: string[], name: string) {
  const fd = openSync(join(scratch, name), 'w'); logs.push(fd)
  const proc = Bun.spawn(cmd, { env: localEnv, stdout: fd, stderr: fd, stdin: 'ignore' })
  processes.push(proc)
  return proc
}
async function eventually(run: () => Promise<unknown>, label: string) {
  const until = Date.now() + 30_000
  while (true) {
    try { return await run() }
    catch (error) {
      if (Date.now() > until) throw new Error(`${label} did not become ready`)
      await Bun.sleep(100)
    }
  }
}
async function curl(path: string, options: { body?: unknown; token?: string; anonymous?: boolean } = {}) {
  const args = ['curl', '--silent', '--show-error', '--max-time', '15', '-w', '\n%{http_code}', `http://localhost:8081${path}`]
  if (!options.anonymous) args.push('-H', options.token ? `Authorization: Bearer ${options.token}` : `Authorization: Basic ${Buffer.from(`${localEnv.ADMIN_USERNAME}:${localEnv.ADMIN_PASSWORD}`).toString('base64')}`)
  if (options.body !== undefined) args.push('-X', 'PUT', '-H', 'Content-Type: application/json', '--data', JSON.stringify(options.body))
  const proc = Bun.spawn(args, { stdout: 'pipe', stderr: 'pipe', env: { PATH: localEnv.PATH } })
  const output = await new Response(proc.stdout).text()
  assert.equal(await proc.exited, 0, 'curl exit')
  const lines = output.trim().split('\n')
  const status = Number(lines.pop())
  return { status, body: JSON.parse(lines.join('\n')) }
}
try {
  spawn(['/opt/homebrew/bin/mongod', '--bind_ip', '127.0.0.1', '--port', '27029', '--dbpath', scratch, '--logpath', join(scratch, 'mongod.log')], 'mongo-output.log')
  spawn(['/opt/homebrew/bin/redis-server', '--bind', '127.0.0.1', '--port', '6399', '--save', '', '--appendonly', 'no'], 'redis.log')
  await eventually(() => client.connect(), 'MongoDB')
  const db = client.db()
  const now = new Date()
  const daysAgo = (days: number) => new Date(now.getTime() - days * 86400_000)
  const player = new ObjectId(), legacy = new ObjectId(), dormant = new ObjectId(), never = new ObjectId()
  await db.collection('users').insertMany([
    { _id: player, username: 'request-player', tier: 'free', providers: ['phone', 'google'], password_hash: 'synthetic-hash', preferences: { player_name: 'Mira', gender: 'female', interests: ['noir', 'epic_fantasy', 'noir'], nsfw_enabled: false }, created_at: daysAgo(2), updated_at: now },
    { _id: legacy, username: 'legacy-story-player', tier: 'free', providers: ['phone'], password_hash: 'synthetic-hash', created_at: daysAgo(3), updated_at: now },
    { _id: dormant, username: 'dormant-player', tier: 'free', providers: ['password'], password_hash: 'synthetic-hash', preferences: { player_name: 'Old', gender: 'male', interests: ['historical'] }, created_at: daysAgo(40), updated_at: now },
    { _id: never, username: 'never-played', tier: 'free', providers: ['google'], password_hash: 'synthetic-hash', preferences: { player_name: 'Ivo', interests: ['noir'], nsfw_enabled: true }, created_at: now, updated_at: now },
  ])
  const save = new ObjectId()
  await db.collection('world_instances').insertOne({ _id: save, player_id: player, created_at: now })
  await db.collection('events').insertMany([
    ...['narration', 'travel', 'calendar_tick', 'intimate'].map((type, i) => ({ _id: new ObjectId(), instance_id: save, player_id: player, sequence: i + 1, type, created_at: now })),
    { _id: new ObjectId(), instance_id: save, player_id: never, sequence: 5, type: 'side_chat', created_at: now },
    { _id: new ObjectId(), instance_id: save, player_id: legacy, sequence: 6, type: 'narration', created_at: daysAgo(2) },
    { _id: new ObjectId(), instance_id: save, player_id: dormant, sequence: 7, type: 'travel', created_at: daysAgo(40) },
  ])
  spawn([process.execPath, '--no-env-file', 'run', 'src/index.ts'], 'server.log')
  await eventually(async () => {
    const response = await fetch('http://localhost:8081/health')
    assert.equal(response.status, 200)
  }, 'Server')
  console.log('Own server ready on 8081; isolated MongoDB 27029 and Redis 6399; no .env loaded.')
  let response = await curl('/admin/billing/config')
  assert.equal(response.status, 200)
  assert.equal(response.body.promo.source, 'env')
  console.log('GET /admin/billing/config', JSON.stringify(response.body.promo))
  await Promise.all([
    curl('/admin/billing/config', { body: { promo: { unlimited: false } } }),
    curl('/admin/billing/config', { body: { promo: { daily_turn_cap: 123 } } }),
  ])
  response = await curl('/admin/billing/config')
  assert.equal(response.body.promo.unlimited, false)
  assert.equal(response.body.promo.daily_turn_cap, 123)
  await curl('/admin/billing/config', { body: { promo: { daily_turn_cap: 500 } } })
  console.log('Concurrent first partial promo saves preserve both supplied keys: PASS')
  const token = await new SignJWT({ id: player.toHexString(), username: 'request-player', email: '', tier: 'free' })
    .setProtectedHeader({ alg: 'HS256' }).setExpirationTime('5m').sign(new TextEncoder().encode(localEnv.JWT_SECRET))
  for (const unlimited of [false, true]) {
    const started = Date.now()
    response = await curl('/admin/billing/config', { body: { promo: { unlimited } } })
    assert.equal(response.status, 200)
    assert.equal(response.body.promo.unlimited, unlimited)
    assert.equal(response.body.promo.source, 'config')
    console.log('PUT /admin/billing/config', JSON.stringify(response.body.promo))
    response = await curl('/billing/me', { token })
    assert.equal(response.status, 200)
    assert.equal(response.body.unlimited_ink, unlimited)
    console.log('GET /billing/me', JSON.stringify({ unlimited_ink: response.body.unlimited_ink, balance: response.body.balance, elapsed_ms: Date.now() - started }))
  }
  const cacheStarted = Date.now()
  await db.collection('billing_config').updateOne({ _id: 'singleton' } as never, { $set: { 'promo.unlimited': false } })
  assert.equal((await curl('/billing/me', { token })).body.unlimited_ink, true)
  await Bun.sleep(5100)
  assert.equal((await curl('/billing/me', { token })).body.unlimited_ink, false)
  await curl('/admin/billing/config', { body: { promo: { unlimited: true } } })
  console.log(`External config writer reaches /billing/me after cache expiry: ${Date.now() - cacheStarted} ms; PASS`)
  response = await curl('/admin/metrics?days=30')
  assert.equal(response.status, 200)
  assert.equal(response.body.series.length, 30)
  assert.deepEqual(response.body.totals, { users: 4, players_ever: 3, saves: 1, story_turns: 6 })
  assert.deepEqual(response.body.active, { dau: 1, wau: 2, mau: 2 })
  assert.equal(response.body.installs.available, false)
  assert(response.body.series.every((day: { installs: unknown }) => day.installs === null))
  const today = response.body.series.at(-1)
  assert.equal(today.active_players, 1)
  assert.equal(today.story_turns, 4)
  assert.equal(today.signups, 1)
  assert.equal(today.new_saves, 1)
  assert.equal(response.body.series.at(-2).story_turns, 0)
  assert.deepEqual(response.body.onboarding, {
    new_users: 3, completed: 2, with_interests: 2,
    interests: [{ key: 'noir', count: 2 }, { key: 'epic_fantasy', count: 1 }],
    gender: [{ key: 'skipped', count: 2 }, { key: 'female', count: 1 }],
    sign_in: [{ key: 'google', count: 2 }, { key: 'phone', count: 2 }],
  })
  console.log('GET /admin/metrics?days=30', JSON.stringify({ ...response.body, series: [response.body.series[0], '...27 rows omitted...', response.body.series.at(-2), today] }))
  response = await curl('/admin/users?sort=last_active')
  assert.equal(response.status, 200)
  const first = response.body.items[0]
  assert.equal(first.id, player.toHexString())
  assert.equal(first.last_active_source, 'request')
  assert.equal(first.story_turns, 4)
  assert.equal(response.body.items[1].last_active_source, 'story')
  assert.equal(response.body.items.at(-1).last_active_at, null)
  assert.equal(response.body.items.at(-1).last_active_source, null)
  assert(response.body.items.every((user: Record<string, unknown>) => user.onboarding && !('password_hash' in user)))
  console.log('GET /admin/users?sort=last_active first', JSON.stringify({ id: first.id, last_active_at: first.last_active_at, last_active_source: first.last_active_source, story_turns: first.story_turns }))
  response = await curl(`/admin/users/${legacy.toHexString()}`)
  assert.equal(response.body.user.last_active_source, 'story')
  assert.equal(response.body.user.story_turns, 1)
  const skipped = { name: null, gender: null, interests: [], sign_in: ['phone'], mature_enabled: false, completed: false }
  assert.deepEqual(response.body.user.onboarding, skipped)
  assert(!('password_hash' in response.body.user))
  console.log('GET /admin/users/:id legacy story fallback: PASS')
  const since = daysAgo(7).toISOString()
  response = await curl(`/admin/users?since=${since}`)
  assert.equal(response.status, 200)
  assert.equal(response.body.total, 3)
  assert(response.body.items.every((user: { created_at: string; onboarding: unknown; password_hash?: unknown }) => new Date(user.created_at) >= new Date(since) && user.onboarding && !('password_hash' in user)))
  assert.deepEqual(response.body.items[0].onboarding, { name: 'Ivo', gender: null, interests: ['noir'], sign_in: ['google'], mature_enabled: true, completed: true })
  console.log(`GET /admin/users?since=${since}`, JSON.stringify({ total: response.body.total, first: { created_at: response.body.items[0].created_at, onboarding: response.body.items[0].onboarding } }))
  for (const sort of ['created', 'last_active']) {
    response = await curl(`/admin/users?since=${since}&search=Mira&sort=${sort}&limit=1`)
    assert.equal(response.status, 200)
    assert.equal(response.body.total, 1)
    assert.equal(response.body.items[0].id, player.toHexString())
    const detail = await curl(`/admin/users/${player.toHexString()}`)
    assert.equal(detail.status, 200)
    assert.deepEqual(detail.body.user.onboarding, response.body.items[0].onboarding)
    assert(!('password_hash' in detail.body.user))
  }
  console.log('since combines with name search, both sorts, pagination, and list/detail onboarding agrees: PASS')
  response = await curl(`/admin/users?since=${now.toISOString()}`)
  assert.equal(response.status, 200)
  assert.equal(response.body.total, 1)
  assert.equal(response.body.items[0].id, never.toHexString())
  console.log('since includes user created exactly at boundary: PASS')
  const before = await db.collection('users').findOne({ _id: player })
  await curl('/billing/me', { token })
  await Bun.sleep(20)
  const after = await db.collection('users').findOne({ _id: player })
  assert.equal(before!.last_active_at.getTime(), after!.last_active_at.getTime())
  await db.collection('users').updateOne({ _id: player }, { $set: { last_active_at: daysAgo(1) } })
  await curl('/billing/me', { token })
  await Bun.sleep(20)
  assert((await db.collection('users').findOne({ _id: player }))!.last_active_at > daysAgo(0.01))
  console.log('last_active_at: second request throttled; old timestamp refreshed: PASS')
  for (const path of ['/admin/metrics?days=6', '/admin/metrics?days=181', '/admin/metrics?days=no', '/admin/metrics?days=7.5', '/admin/users?sort=wrong', '/admin/users?since=bad', '/admin/users?since=', '/admin/users?since=2026-02-30']) {
    response = await curl(path)
    assert.equal(response.status, 400)
    console.log(`GET ${path}`, response.status, JSON.stringify(response.body))
  }
  for (const promo of [{ unlimited: 'false' }, { unlimited: null }, { daily_turn_cap: 0 }, { daily_turn_cap: 1.5 }, { daily_turn_cap: '500' }, null]) {
    response = await curl('/admin/billing/config', { body: { promo } })
    assert.equal(response.status, 400)
    console.log('PUT invalid promo', response.status, JSON.stringify(response.body))
  }
  response = await curl('/admin/metrics', { anonymous: true })
  assert.equal(response.status, 401)
  console.log('Unauthenticated /admin/metrics: 401; all HTTP checks PASS')
  const explain = await db.collection('events').aggregate([
    { $match: { type: { $in: ['narration', 'travel', 'intimate', 'calendar_tick'] }, created_at: { $gte: daysAgo(30) } } },
    { $group: { _id: '$player_id', count: { $sum: 1 } } },
  ], { hint: 'idx_events_type_created_player' }).explain('executionStats')
  assert(JSON.stringify(explain).includes('IXSCAN'))
  console.log('Story metrics aggregation explain: IXSCAN using idx_events_type_created_player')
  const activityExplain = await db.collection('users').aggregate([
    { $match: { _id: legacy } }, ...userActivityStages(),
  ]).explain('executionStats')
  assert(JSON.stringify(activityExplain).includes('idx_events_player_type_created'))
  console.log('User activity lookup explain: idx_events_player_type_created')
  const sinceExplain = await db.collection('users').aggregate([
    { $match: { created_at: { $gte: daysAgo(7) } } },
    { $sort: { created_at: -1, _id: -1 } }, { $limit: 1 }, ...userActivityStages(),
  ]).explain('executionStats')
  assert(JSON.stringify(sinceExplain).includes('idx_users_created'))
  console.log('since user query explain: idx_users_created')
  const windowStart = new Date(new Date(now).toISOString().slice(0, 10))
  windowStart.setUTCDate(windowStart.getUTCDate() - 29)
  const onboardingExplain = await db.collection('users').aggregate([
    { $match: { created_at: { $gte: windowStart, $lte: now } } },
    { $facet: onboardingFacets() },
  ], { hint: 'idx_users_created' }).explain('executionStats')
  assert(JSON.stringify(onboardingExplain).includes('IXSCAN'))
  console.log('Onboarding aggregation explain: IXSCAN using idx_users_created')
  await db.collection('users').deleteMany({ _id: { $in: [player, legacy, dormant, never] } })
  const boundary = new ObjectId(), beforeBoundary = new ObjectId(), future = new ObjectId()
  await db.collection('users').insertMany([
    { _id: boundary, username: 'window-start', created_at: windowStart, preferences: { player_name: 'Boundary' } },
    { _id: beforeBoundary, username: 'before-window', created_at: new Date(windowStart.getTime() - 1), preferences: { gender: 'male' } },
    { _id: future, username: 'future-player', created_at: new Date(Date.now() + 86400_000), preferences: { gender: 'female' } },
  ])
  response = await curl('/admin/metrics?days=30')
  assert.equal(response.status, 200)
  assert.deepEqual(response.body.onboarding, { new_users: 1, completed: 1, with_interests: 0, interests: [], gender: [{ key: 'skipped', count: 1 }], sign_in: [] })
  assert.equal(response.body.series[0].signups, 1)
  console.log('Onboarding UTC window includes its first instant, excludes older and future users: PASS')
  await db.collection('users').deleteMany({ _id: { $in: [boundary, beforeBoundary, future] } })
  response = await curl('/admin/metrics?days=30')
  assert.equal(response.status, 200)
  assert.deepEqual(response.body.onboarding, { new_users: 0, completed: 0, with_interests: 0, interests: [], gender: [], sign_in: [] })
  console.log('Empty onboarding window returns zero counts and empty buckets: PASS')
} catch (error) {
  // All child environments contain only synthetic local values.
  const logPath = join(scratch, 'server.log')
  try { console.error(readFileSync(logPath, 'utf8')) } catch {}
  throw error
} finally {
  await client.close()
  for (const proc of processes.reverse()) {
    if (proc.exitCode === null) proc.kill('SIGTERM')
    await proc.exited
  }
  for (const fd of logs) closeSync(fd)
  rmSync(scratch, { recursive: true, force: true })
  console.log('Stopped all three owned processes and removed the isolated fixture database.')
}
