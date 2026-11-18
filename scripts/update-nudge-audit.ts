/**
 * The update nudge's server half (`everlore-docs/phases/update-nudge.md`, "The
 * rule that shapes everything" and "Server contract"), against a disposable
 * mongod this script starts and owns. No environment file, no network, no
 * configured database: the push sender is a recorder and the maintenance queue
 * records its jobs.
 *
 * What this proves, in the contract's own terms:
 *   - the public payload is exactly its five fields, and carries 5 minutes of
 *     caching;
 *   - a missing document means no nudge at all;
 *   - PUT validates every field, including a floor above the latest build;
 *   - raising the floor is refused with a real count of the players it would
 *     block, and review accounts are not in that count;
 *   - an announcement reaches only devices of players below the live build;
 *   - review accounts and anyone with no session in 90 days are skipped;
 *   - a build is announced once;
 *   - a real send needs a fresh, single-use, ten-minute confirmation;
 *   - a device whose local clock reads 23:00 is held for 10:00 its time, a 14:00
 *     one is sent now, and the held send re-checks the build first;
 *   - the push's words are fixed and carry no technical copy;
 *   - every admin route refuses a caller who is not signed in.
 *
 * Every check is shown to bite: `bun --no-env-file run scripts/update-nudge-audit.ts --bites`
 * mutates one rule at a time, expects that named check to fail, restores the file
 * and re-runs the whole audit green.
 *
 * Run with: `bun --no-env-file run scripts/update-nudge-audit.ts`
 */
import assert from 'node:assert/strict'
import { mkdtemp, open, rm } from 'node:fs/promises'
import { readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'
import { mock, setSystemTime } from 'bun:test'
import { MongoClient, ObjectId } from 'mongodb'

type Doc = Record<string, any>

const SCRIPT = join(import.meta.dir, 'update-nudge-audit.ts')
const REPO = join(import.meta.dir, '..')

// ─────────────────────────────────────────────────────────────────────────────
// Shared bits
// ─────────────────────────────────────────────────────────────────────────────

let passed = 0
let failures = 0

async function check(name: string, run: () => Promise<void> | void): Promise<void> {
  try {
    await run()
    passed++
    console.log(`PASS ${name}`)
  } catch (error) {
    failures++
    console.log(`FAIL ${name}: ${(error as Error).message}`)
  }
}

function keys(doc: Doc, allowed: readonly string[], where: string): void {
  assert.deepEqual(Object.keys(doc).sort(), [...allowed].sort(), `${where} keys: ${Object.keys(doc).join(', ')}`)
}

const DAY = 86_400_000

async function runAudit(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'everlore-update-nudge-audit-'))
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
  const client = new MongoClient(`mongodb://127.0.0.1:${port}/update_nudge_audit`, { serverSelectionTimeoutMS: 15_000 })

  try {
    await client.connect()
    const db = client.db()
    const c = (name: string) => db.collection(name)

    // ── Fakes for everything outside this contract ───────────────────────────
    const ADMIN = 'audit-admin'
    const ADMIN_PASSWORD = crypto.randomUUID()
    const BASIC = `Basic ${Buffer.from(`${ADMIN}:${ADMIN_PASSWORD}`).toString('base64')}`
    const known: Record<string, unknown> = {
      ADMIN_USERNAME: ADMIN, ADMIN_PASSWORD, REVIEW_DEMO_PHONE: undefined, NODE_ENV: 'test',
    }
    mock.module('../src/config/env', () => ({
      env: new Proxy(known, {
        get(target, key) {
          if (typeof key === 'string' && key in target) return target[key]
          throw new Error(`update nudge audit read env.${String(key)}`)
        },
      }),
    }))
    mock.module('../src/config/mongo', () => ({
      coll: (name: string) => c(name),
      mongoColl: {
        appRelease: () => c('app_release'),
        appSessions: () => c('app_sessions'),
        appInstalls: () => c('app_installs'),
        pushDevices: () => c('push_devices'),
        playerNotifications: () => c('player_notifications'),
        users: () => c('users'),
      },
    }))
    mock.module('../src/providers/auth.provider', () => ({ normalizePhone: (phone: string) => phone }))
    mock.module('../src/middleware/rate-limit', () => ({
      rateLimit: async () => ({ allowed: true, remaining: 1_000, retryAfter: 0 }),
    }))
    mock.module('../src/services/admin-session.service', () => ({
      SESSION_COOKIE: 'everlore_admin_session',
      readSession: async () => null,
      readCookie: () => '',
      constantTimeEqual: (left: string, right: string) => left === right,
    }))
    mock.module('../src/utils/logger', () => ({ log: { info() {}, warn() {}, error() {} } }))

    const pushes: Array<{ device: Doc; payload: Doc }> = []
    const jobs: Array<{ name: string; data: Doc; opts: Doc }> = []
    const realPush = await import('../src/services/push/fcm')
    const fakeSender = {
      configured: () => true,
      async send(device: Doc, payload: Doc) {
        pushes.push({ device, payload })
        return true
      },
    }
    mock.module('../src/services/push/fcm', () => ({ ...realPush, fcmSender: fakeSender, createFcmSender: () => fakeSender }))
    mock.module('../src/queues', () => ({
      QUEUE_RETENTION: { maintenance: { removeOnComplete: {}, removeOnFail: {} } },
      getMaintenanceQueue: () => ({
        add: async (name: string, data: Doc, opts: Doc) => {
          jobs.push({ name, data, opts })
          return { id: opts?.jobId }
        },
      }),
    }))
    // No network, ever: the sender is a recorder and nothing else may dial out.
    const unavailable = (): never => { throw new Error('Network reached in update nudge audit') }
    globalThis.fetch = Object.assign(async () => unavailable(), { preconnect: unavailable }) as unknown as typeof fetch

    const { Elysia } = await import('elysia')
    const { HttpError } = await import('../src/utils/http-error')
    const { requireAdmin } = await import('../src/middleware/admin-auth')
    const { adminReleaseRoutes } = await import('../src/routes/admin-release.routes')
    const { appReleaseRoutes } = await import('../src/routes/app-release.routes')
    const { resetReviewerScopeCache } = await import('../src/services/reviewer-accounts')
    const { invalidateAppRelease, sendHeldAppUpdate } = await import('../src/services/app-release.service')

    const errorHandler = ({ error, set }: { error: unknown; set: { status?: number | string } }) => {
      if (error instanceof HttpError) {
        set.status = error.statusCode
        return { error: error.message, ...(error.details ?? {}) }
      }
      if (error instanceof Error) {
        set.status = 500
        return { error: error.message }
      }
    }
    // Mounted exactly the way `admin.routes.ts` mounts it: full paths, the guard
    // scoped onto this instance, nothing else guarding the routes.
    const admin = new Elysia({ prefix: '/admin' })
      .onError(errorHandler)
      .use(requireAdmin)
      .use(adminReleaseRoutes)
    const publicApp = new Elysia().onError(errorHandler).use(appReleaseRoutes)

    async function adminRequest(path: string, init: RequestInit = {}, headers: Record<string, string> = {}) {
      const response = await admin.handle(new Request(`http://localhost${path}`, {
        ...init,
        headers: { authorization: BASIC, ...headers, ...(init.body ? { 'content-type': 'application/json' } : {}) },
      }))
      const body = await response.json().catch(() => null) as Doc
      return { status: response.status, body, headers: response.headers }
    }
    const adminGet = (path: string, headers: Record<string, string> = {}) => adminRequest(path, {}, headers)
    const adminSend = (method: string, path: string, body: unknown) =>
      adminRequest(path, { method, body: JSON.stringify(body) })

    async function publicGet(path: string) {
      const response = await publicApp.handle(new Request(`http://localhost${path}`))
      const body = await response.json().catch(() => null) as Doc
      return { status: response.status, body, headers: response.headers }
    }

    // ── Fixtures ─────────────────────────────────────────────────────────────
    let userSequence = 0
    let sessionSequence = 0

    async function seedUser(over: Doc = {}): Promise<ObjectId> {
      const doc = { _id: new ObjectId(), username: `player${++userSequence}`, preferences: {}, ...over }
      await c('users').insertOne(doc)
      return doc._id as ObjectId
    }

    async function seedSession(player: ObjectId | null, build: number, at: Date, over: Doc = {}): Promise<string> {
      const id = crypto.randomUUID()
      await c('app_sessions').insertOne({
        _id: id,
        install_id: over.install_id ?? `install-${++sessionSequence}`,
        ...(player ? { user_id: player } : {}),
        started_at: at,
        last_at: at,
        app_version: `1.0.${build}`,
        build,
        device: { os: 'android', form: 'phone' },
        screen_path: [],
        counts: { events: 1, errors: 0, actions: 0 },
        ...over,
      })
      return id
    }

    async function seedDevice(player: ObjectId, token: string, tzOffsetMinutes?: number): Promise<void> {
      await c('push_devices').insertOne({
        player_id: player,
        token,
        platform: 'android',
        updated_at: new Date(),
        ...(tzOffsetMinutes !== undefined ? { tz_offset_minutes: tzOffsetMinutes } : {}),
      })
    }

    const now = () => new Date()

    async function reset(): Promise<void> {
      setSystemTime()
      for (const name of ['app_release', 'app_sessions', 'app_installs', 'push_devices', 'player_notifications', 'users']) {
        await c(name).deleteMany({})
      }
      resetReviewerScopeCache()
      invalidateAppRelease()
      pushes.length = 0
      jobs.length = 0
      userSequence = 0
      sessionSequence = 0
    }

    const RELEASE = { latest_build: 18, latest_version: '1.0.15', min_build: 0, notes: ['The map remembers where you were.'] }

    async function saveRelease(over: Doc = {}, headers: Record<string, string> = {}) {
      const response = await adminRequest('/admin/app-release', {
        method: 'PUT', body: JSON.stringify({ ...RELEASE, ...over }),
      }, headers)
      assert.equal(response.status, 200, `PUT failed: ${JSON.stringify(response.body)}`)
      return response.body
    }

    async function dryRun() {
      const response = await adminSend('POST', '/admin/app-release/announce', { dry_run: true })
      assert.equal(response.status, 200, `dry run failed: ${JSON.stringify(response.body)}`)
      return response.body
    }

    async function sendNow(confirm: string) {
      return adminSend('POST', '/admin/app-release/announce', { dry_run: false, confirm })
    }

    /** A player with one device and one session on `build`. */
    async function behindPlayer(build: number, at = now(), tzOffsetMinutes?: number, token?: string) {
      const player = await seedUser()
      await seedSession(player, build, at)
      await seedDevice(player, token ?? crypto.randomUUID(), tzOffsetMinutes)
      return player
    }

    // ── 1. The public payload ────────────────────────────────────────────────
    await check('the public payload has exactly its five fields', async () => {
      await reset()
      await saveRelease()
      const response = await publicGet('/app/release')
      assert.equal(response.status, 200)
      keys(response.body, ['latest_build', 'latest_version', 'min_build', 'notes', 'store_url'], 'public release')
      assert.deepEqual(response.body, {
        latest_build: 18,
        latest_version: '1.0.15',
        min_build: 0,
        notes: ['The map remembers where you were.'],
        store_url: 'https://play.google.com/store/apps/details?id=com.everloreapp',
      })
      assert.equal(response.headers.get('cache-control'), 'max-age=300', 'the app start read is cached for five minutes')
    })

    // ── 2. No document, no nudge ─────────────────────────────────────────────
    await check('a missing document means no nudge', async () => {
      await reset()
      const response = await publicGet('/app/release')
      assert.equal(response.status, 200)
      keys(response.body, ['latest_build', 'latest_version', 'min_build', 'notes', 'store_url'], 'public release')
      assert.equal(response.body.latest_build, 0, 'no document, no build to compare against')
      assert.equal(response.body.min_build, 0, 'no document, no floor')
      assert.deepEqual(response.body.notes, [])

      const adminView = await adminGet('/admin/app-release')
      assert.equal(adminView.status, 200)
      assert.equal(adminView.body.latest_build, 0)
      assert.deepEqual(adminView.body.announced, [])
      assert.deepEqual(adminView.body.in_use, [])
      assert.equal(adminView.body.behind, 0)
      assert.equal(Object.hasOwn(adminView.body, 'updated_at'), false, 'a document that was never saved has no update time')
    })

    // ── 3. PUT validation ────────────────────────────────────────────────────
    await check('PUT refuses bad settings, including a floor above the latest build', async () => {
      await reset()
      const good = { latest_build: 18, latest_version: '1.0.15', min_build: 16, notes: ['  The map remembers where you were.  '] }
      const bad: Array<[string, unknown]> = [
        ['a null body', null],
        ['an array body', []],
        ['no fields at all', {}],
        ['a negative build', { ...good, latest_build: -1 }],
        ['a fractional build', { ...good, latest_build: 18.5 }],
        ['a build as text', { ...good, latest_build: '18' }],
        ['a short version', { ...good, latest_version: '1.0' }],
        ['a prefixed version', { ...good, latest_version: 'v1.0.15' }],
        ['four notes', { ...good, notes: ['a', 'b', 'c', 'd'] }],
        ['an over-long note', { ...good, notes: ['x'.repeat(91)] }],
        ['a blank note', { ...good, notes: ['   '] }],
        ['a note that is not text', { ...good, notes: [7] }],
        ['notes that are not a list', { ...good, notes: 'hello' }],
        ['a floor above the latest build', { ...good, min_build: 19 }],
        ['an unknown field', { ...good, latestBuild: 18 }],
        ['a confirm_block that is text', { ...good, confirm_block: 'yes' }],
      ]
      for (const [label, body] of bad) {
        const response = await adminSend('PUT', '/admin/app-release', body)
        assert.equal(response.status, 400, `${label} was accepted: ${JSON.stringify(response.body)}`)
        assert.match(response.body.error, /^\S.*\.$/, `${label} did not get a plain 400 sentence: ${response.body.error}`)
      }

      const saved = await adminSend('PUT', '/admin/app-release', good)
      assert.equal(saved.status, 200, JSON.stringify(saved.body))
      const stored = await c('app_release').findOne({ _id: 'android' }) as Doc
      assert.deepEqual(Object.keys(stored).sort(),
        ['_id', 'announced', 'latest_build', 'latest_version', 'min_build', 'notes', 'updated_at'].sort(),
        'the stored document has exactly the contract fields')
      assert.deepEqual(stored.notes, ['The map remembers where you were.'], 'notes are trimmed')
    })

    // ── 4. The confirm_block gate ────────────────────────────────────────────
    await check('the confirm_block gate counts real players and leaves review accounts out', async () => {
      await reset()
      await saveRelease({ min_build: 0 })

      await behindPlayer(14)                                  // below a 16 floor, has a phone
      const bob = await seedUser()                            // below it, no phone
      await seedSession(bob, 15, now())
      await seedSession(null, 13, now(), { install_id: 'guest-install-1' })
      await behindPlayer(18)                                  // already on the live build
      const reviewer = await seedUser({ reviewer: true })     // a review account, not a player
      await seedSession(reviewer, 10, now())
      await seedDevice(reviewer, 'reviewer-device')
      resetReviewerScopeCache()

      const refused = await adminSend('PUT', '/admin/app-release', { ...RELEASE, min_build: 16 })
      assert.equal(refused.status, 409, `the floor was raised over live players: ${JSON.stringify(refused.body)}`)
      assert.equal(refused.body.blocked_players, 3, 'alice, bob and the guest install — not the review account')
      assert.match(refused.body.error, /^\S.*\.$/)

      const stillRefused = await adminSend('PUT', '/admin/app-release', { ...RELEASE, min_build: 16, confirm_block: false })
      assert.equal(stillRefused.status, 409, 'false is not a confirmation')

      const confirmed = await adminSend('PUT', '/admin/app-release', { ...RELEASE, min_build: 16, confirm_block: true })
      assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body))
      assert.equal(confirmed.body.min_build, 16)

      const unchanged = await adminSend('PUT', '/admin/app-release', { ...RELEASE, min_build: 16 })
      assert.equal(unchanged.status, 200, 'a floor that does not move needs no confirmation')

      const view = await adminGet('/admin/app-release')
      assert.deepEqual(view.body.in_use, [
        { build: 18, players: 1 },
        { build: 15, players: 1 },
        { build: 14, players: 1 },
        { build: 13, players: 1 },
      ], 'players on each build in the last 30 days, review accounts left out')
      assert.equal(view.body.behind, 1, 'only a signed-in player with a phone is counted as reachable')
    })

    // ── 5. Who an announcement reaches ───────────────────────────────────────
    await check('announce targets only the devices below the new build', async () => {
      await reset()
      await saveRelease()
      const withTwoPhones = await behindPlayer(17)
      await seedDevice(withTwoPhones, 'old-second-device')
      await behindPlayer(16)
      const current = await behindPlayer(18)

      const dry = await dryRun()
      keys(dry, ['build', 'devices', 'players', 'confirm'], 'dry run')
      assert.equal(dry.build, 18)
      assert.equal(dry.devices, 3, 'two phones on 17 and one on 16')
      assert.equal(dry.players, 2)

      const sent = await sendNow(dry.confirm)
      assert.equal(sent.status, 200, JSON.stringify(sent.body))
      assert.deepEqual({ build: sent.body.build, devices: sent.body.devices, held: sent.body.held, players: sent.body.players },
        { build: 18, devices: 3, held: 0, players: 2 })

      assert.equal(pushes.length, 3, 'exactly the three phones below the live build')
      for (const push of pushes) {
        assert.deepEqual(push.payload.data, { type: 'app_update', build: '18' }, 'the phone routes by type and build')
        assert(!push.device.player_id.equals(current), 'a player already on the live build is not nudged')
      }
      assert.equal(await c('player_notifications').countDocuments({}), 0,
        'push only: the bell list holds rows that open a story, and this is not one')

      const stored = await c('app_release').findOne({ _id: 'android' }) as Doc
      assert.equal(stored.announced.length, 1)
      assert.deepEqual(
        { build: stored.announced[0].build, by: stored.announced[0].by, devices: stored.announced[0].devices },
        { build: 18, by: ADMIN, devices: 3 },
      )
      assert(stored.announced[0].at instanceof Date)
    })

    // ── 6. Who is skipped ────────────────────────────────────────────────────
    await check('review and team accounts, and anyone gone 90 days, are skipped', async () => {
      await reset()
      await saveRelease()

      const reviewer = await seedUser({ reviewer: true })
      await seedSession(reviewer, 10, now())
      await seedDevice(reviewer, 'reviewer-device')
      const gone = await seedUser()
      await seedSession(gone, 10, new Date(now().getTime() - 100 * DAY))
      await seedDevice(gone, 'gone-device')
      const here = await behindPlayer(17)
      resetReviewerScopeCache()

      const dry = await dryRun()
      assert.equal(dry.devices, 1, 'only the player who is still here')
      assert.equal(dry.players, 1)

      const view = await adminGet('/admin/app-release')
      assert.equal(view.body.behind, 1, 'the same rule as the console count')

      const sent = await sendNow(dry.confirm)
      assert.equal(sent.status, 200)
      assert.deepEqual(pushes.map((push) => String(push.device.player_id)), [String(here)])
    })

    // ── 7. One announcement per build ────────────────────────────────────────
    await check('a build is announced once', async () => {
      await reset()
      await saveRelease()
      await behindPlayer(17)

      const first = await dryRun()
      assert.equal((await sendNow(first.confirm)).status, 200)
      assert.equal(pushes.length, 1)

      const second = await dryRun()
      const refused = await sendNow(second.confirm)
      assert.equal(refused.status, 409, `the same build was announced twice: ${JSON.stringify(refused.body)}`)
      assert.match(refused.body.error, /^\S.*\.$/)
      assert.equal(pushes.length, 1, 'the second send reached no phone')

      const stored = await c('app_release').findOne({ _id: 'android' }) as Doc
      assert.equal(stored.announced.length, 1, 'one row per build')
    })

    // ── 8. The confirmation token ────────────────────────────────────────────
    await check('a real send needs a fresh, single-use confirmation', async () => {
      await reset()
      await saveRelease()
      await behindPlayer(17)

      const noToken = await adminSend('POST', '/admin/app-release/announce', { dry_run: false })
      assert.equal(noToken.status, 400, 'a send with no confirmation')
      assert.match(noToken.body.error, /^\S.*\.$/)

      const badToken = await sendNow('not-a-real-token')
      assert.equal(badToken.status, 400, 'a send with a made-up confirmation')

      const first = await dryRun()
      assert.equal((await sendNow(first.confirm)).status, 200)
      const replay = await sendNow(first.confirm)
      assert.equal(replay.status, 400, 'a spent confirmation is never accepted twice')

      const expiring = await dryRun()
      setSystemTime(new Date(Date.now() + 11 * 60_000))
      try {
        const expired = await sendNow(expiring.confirm)
        assert.equal(expired.status, 400, 'a confirmation kept past ten minutes')
      } finally {
        setSystemTime()
      }

      // A token is issued for one build only.
      await saveRelease({ latest_build: 19 })
      const forTheOldBuild = await dryRun()
      await saveRelease({ latest_build: 20 })
      const wrongBuild = await sendNow(forTheOldBuild.confirm)
      assert.equal(wrongBuild.status, 400, 'a confirmation from an earlier release')
    })

    // ── 9. The night hold ────────────────────────────────────────────────────
    await check('the night hold sends at ten their time, and only then', async () => {
      await reset()
      setSystemTime(new Date('2026-11-18T17:30:00.000Z'))
      try {
        await saveRelease()
        const night = await behindPlayer(17, now(), 330)   // 23:00 in IST
        const afternoon = await behindPlayer(17, now(), -180) // 14:30 at UTC-3
        const noOffset = await behindPlayer(17)

        const dry = await dryRun()
        assert.equal(dry.devices, 3)

        const sent = await sendNow(dry.confirm)
        assert.equal(sent.status, 200, JSON.stringify(sent.body))
        assert.equal(sent.body.devices, 2, 'the afternoon phone and the one with no clock')
        assert.equal(sent.body.held, 1)

        assert.deepEqual(pushes.map((push) => String(push.device.player_id)).sort(),
          [String(afternoon), String(noOffset)].sort(), 'nobody is woken at 23:00')

        assert.equal(jobs.length, 1, 'one delayed job for the held clock')
        const job = jobs[0]
        assert.equal(job.name, 'app-update-held')
        assert.deepEqual(job.data, {
          task: 'app-update-held',
          build: 18,
          playerIds: [String(night)],
          tzOffsetMinutes: 330,
        })
        assert.equal(job.opts.delay, 11 * 3_600_000, 'queued for 04:30Z, which is 10:00 in IST')
        const target = new Date(Date.now() + job.opts.delay)
        assert.equal(new Date(target.getTime() + 330 * 60_000).toISOString().slice(11, 16), '10:00',
          'the job lands at ten on the phone that was held')

        const stored = await c('app_release').findOne({ _id: 'android' }) as Doc
        assert.equal(stored.announced[0].devices, 3, 'all three phones are part of this announcement')

        // 10:00 their time: the held phone is sent.
        setSystemTime(new Date('2026-11-19T04:30:00.000Z'))
        assert.deepEqual(await sendHeldAppUpdate(job.data), { sent: 1 })
        assert.equal(String(pushes[pushes.length - 1].device.player_id), String(night))

        // But not if they updated overnight.
        await seedSession(night, 18, new Date('2026-11-19T04:00:00.000Z'))
        assert.deepEqual(await sendHeldAppUpdate(job.data), { sent: 0 }, 'an updated player is not nudged')
      } finally {
        setSystemTime()
      }
    })

    // ── 10. The words ────────────────────────────────────────────────────────
    await check('the push words are fixed and carry no technical copy', async () => {
      await reset()
      await saveRelease()
      await behindPlayer(17)

      const first = await dryRun()
      assert.equal((await sendNow(first.confirm)).status, 200)
      assert.deepEqual(pushes[0].payload.notification, {
        title: 'A new Everlore is here',
        body: 'The map remembers where you were.',
      }, 'the first note is the body')

      await saveRelease({ latest_build: 19, notes: [] })
      const second = await dryRun()
      assert.equal((await sendNow(second.confirm)).status, 200)
      assert.deepEqual(pushes[1].payload.notification, {
        title: 'A new Everlore is here',
        body: 'New stories and fixes are waiting',
      }, 'with no notes, the fixed sentence')

      for (const push of pushes) {
        const words = `${push.payload.notification.title} ${push.payload.notification.body}`
        assert.doesNotMatch(words, /build|version|android|ios|play|google|apk|firebase|fcm|store|code/i,
          `technical copy on a phone: ${words}`)
      }
    })

    // ── 11. The guard ────────────────────────────────────────────────────────
    await check('every admin release route refuses an unauthenticated caller', async () => {
      await reset()
      await saveRelease()
      const routes = (admin.routes as Array<{ method: string; path: string }>)
        .filter((route) => route.path.includes('app-release'))
      const expected = ['GET /admin/app-release', 'PUT /admin/app-release', 'POST /admin/app-release/announce']
      assert.deepEqual(
        routes.map((route) => `${String(route.method).toUpperCase()} ${route.path}`).sort(),
        expected.sort(),
      )

      try {
        for (const route of routes) {
          const init: RequestInit = String(route.method).toUpperCase() === 'GET'
            ? { method: 'GET' }
            : { method: String(route.method).toUpperCase(), body: '{}' }
          known.ADMIN_USERNAME = ''
          known.ADMIN_PASSWORD = ''
          const unconfigured = await adminRequest(route.path, init, { authorization: '' })
          assert.equal(unconfigured.status, 503, `${route.method} ${route.path} without configured credentials`)
          assert.deepEqual(unconfigured.body, { error: 'Admin credentials are not configured' })

          known.ADMIN_USERNAME = ADMIN
          known.ADMIN_PASSWORD = ADMIN_PASSWORD
          const anonymous = await adminRequest(route.path, init, { authorization: '' })
          assert.equal(anonymous.status, 401, `${route.method} ${route.path} without a caller`)
          assert.deepEqual(anonymous.body, { error: 'Unauthorized' })
        }
      } finally {
        known.ADMIN_USERNAME = ADMIN
        known.ADMIN_PASSWORD = ADMIN_PASSWORD
      }

      // The app's own route is public by contract: the must-update screen comes
      // before there is an account.
      const release = await publicGet('/app/release')
      assert.equal(release.status, 200)
    })

    console.log(`\nupdate-nudge: ${failures === 0 ? 'ALL GREEN' : `${failures} FAILED`} (${passed} passed)`)
    process.exitCode = failures === 0 ? 0 : 1
  } finally {
    setSystemTime()
    await client.close()
    mongod.kill('SIGTERM')
    await mongod.exited
    await logfile.close()
    await rm(root, { recursive: true, force: true })
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Bite demonstration: mutate one rule, watch the named check fail, restore.
// ─────────────────────────────────────────────────────────────────────────────

const SERVICE = 'src/services/app-release.service.ts'
const FCM = 'src/services/push/fcm.ts'

const MUTATIONS: ReadonlyArray<readonly [string, string, string, string]> = [
  ['the public payload has exactly its five fields', SERVICE,
    '    store_url: STORE_URL,', '    store_url: STORE_URL,\n    updated_at: new Date(),'],
  ['a missing document means no nudge', SERVICE,
    '    latest_build: doc?.latest_build ?? 0,', '    latest_build: doc?.latest_build ?? 1,'],
  ['PUT refuses bad settings, including a floor above the latest build', SERVICE,
    '  if (min_build > latest_build) {', '  if (false) {'],
  ['the confirm_block gate counts real players and leaves review accounts out', SERVICE,
    '  if (scope.userIds.length > 0) userMatch.$nin = scope.userIds\n  if (playerIds) userMatch.$in = playerIds',
    '  if (playerIds) userMatch.$in = playerIds'],
  ['announce targets only the devices below the new build', SERVICE,
    '{ $match: { build: { $lt: latestBuild } } },', '{ $match: { build: { $lte: latestBuild } } },'],
  ['review and team accounts, and anyone gone 90 days, are skipped', SERVICE,
    'const TARGET_DAYS = 90', 'const TARGET_DAYS = 365'],
  ['a build is announced once', SERVICE,
    "{ _id: ANDROID, 'announced.build': { $ne: build } },", "{ _id: ANDROID, 'announced.build': { $ne: build + 1 } },"],
  ['a real send needs a fresh, single-use confirmation', SERVICE,
    '  if (!entry || entry.expires <= now.getTime() || entry.build !== build) {', '  if (false) {'],
  ['the night hold sends at ten their time, and only then', SERVICE,
    'return local >= NIGHT_FROM_HOUR * 60 || local < NIGHT_UNTIL_HOUR * 60',
    'return local >= NIGHT_FROM_HOUR * 60 && local < NIGHT_UNTIL_HOUR * 60'],
  ['the push words are fixed and carry no technical copy', FCM,
    "      title: 'A new Everlore is here',", "      title: 'A new Everlore build is here',"],
] as const

async function runChild(): Promise<{ output: string; code: number }> {
  const proc = Bun.spawn([process.execPath, '--no-env-file', 'run', SCRIPT], {
    stdout: 'pipe', stderr: 'pipe', stdin: 'ignore',
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { output: stdout + stderr, code }
}

async function runBites(): Promise<void> {
  const clean = await runChild()
  assert.equal(clean.code, 0, `The clean audit must pass before any mutation.\n${clean.output}`)
  console.log('CLEAN -> exit 0; every check passed')

  for (const [label, relative, before, after] of MUTATIONS) {
    const file = join(REPO, relative)
    const original = readFileSync(file, 'utf8')
    assert(original.includes(before), `Mutation target missing: ${label}`)
    try {
      // A replacer function, not a string: these sources contain `$` patterns.
      writeFileSync(file, original.replace(before, () => after))
      const result = await runChild()
      assert.notEqual(result.code, 0, `Mutation survived: ${label}\n${result.output}`)
      assert(result.output.includes(`FAIL ${label}:`), `The wrong check bit: ${label}\n${result.output}`)
      console.log(`TAMPER -> exit ${result.code}; FAIL ${label}`)
    } finally {
      writeFileSync(file, original)
    }
    const restored = await runChild()
    assert.equal(restored.code, 0, `The audit failed after restoring ${relative}.\n${restored.output}`)
    console.log('RESTORE -> exit 0; clean audit passed')
  }
  console.log(`Bite demo: ${MUTATIONS.length}/${MUTATIONS.length} rules rejected; every file restored and rechecked.`)
}

if (process.argv.includes('--bites')) await runBites()
else await runAudit()

process.exit(failures === 0 ? 0 : 1)
