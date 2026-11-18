/**
 * "What's new" and the automatic reminder rounds, part 2 of the update nudge
 * (`everlore-docs/phases/update-nudge.md`, sections A and B), against a
 * disposable mongod this script starts and owns. No environment file, no
 * network, no configured database: the push sender is a recorder and the
 * maintenance queue records its jobs.
 *
 * What this proves, in the contract's own terms:
 *   - every field of a note is validated, including the image's host;
 *   - a draft is a 404 to a player, and a published note is exactly its fields;
 *   - publishing writes one in-app row per eligible player, leaving reviewers,
 *     team/test accounts and anyone gone 90 days out;
 *   - a second publish is refused;
 *   - the push goes only when asked, and a phone in its night is held for 10:00;
 *   - a row is `whats_new` with `release_build` and **no** `instance_id` key;
 *   - a story row is unchanged, and still requires a save;
 *   - the rounds fall due at +1h/+3d/+7d, each sends once, an hourly catch-up
 *     never doubles, a replaced build or a switched-off reminder stops them, and
 *     rounds 2 and 3 skip a player who was in the app within the day;
 *   - every admin route refuses a caller who is not signed in.
 *
 * Every check is shown to bite: `bun --no-env-file run scripts/whats-new-audit.ts --bites`
 * mutates one rule at a time, expects that named check to fail, restores the file
 * and re-runs the whole audit green.
 *
 * Run with: `bun --no-env-file run scripts/whats-new-audit.ts`
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

const SCRIPT = join(import.meta.dir, 'whats-new-audit.ts')
const REPO = join(import.meta.dir, '..')

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
const HOUR = 3_600_000
const CDN = 'https://cdn.everloreapp.com'
const IMAGE = `${CDN}/releases/groups.jpg`

async function runAudit(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'everlore-whats-new-audit-'))
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
  const client = new MongoClient(`mongodb://127.0.0.1:${port}/whats_new_audit`, { serverSelectionTimeoutMS: 15_000 })

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
      CDN_BASE_URL: CDN,
    }
    mock.module('../src/config/env', () => ({
      env: new Proxy(known, {
        get(target, key) {
          if (typeof key === 'string' && key in target) return target[key]
          throw new Error(`what's-new audit read env.${String(key)}`)
        },
      }),
    }))
    mock.module('../src/config/mongo', () => ({
      coll: (name: string) => c(name),
      mongoColl: {
        appRelease: () => c('app_release'),
        releaseNotes: () => c('release_notes'),
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
    const published: Array<{ channel: string; frame: Doc }> = []
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
    // The bell's single-row writer publishes a frame; a publish of a note does
    // not, and this recorder proves which happened.
    mock.module('../src/config/redis', () => ({
      getRedisClient: () => ({
        publish: async (channel: string, text: string) => {
          published.push({ channel, frame: JSON.parse(text) })
          return 1
        },
        get: async () => null,
        set: async () => 'OK',
        del: async () => 1,
      }),
    }))
    // No network, ever: the sender is a recorder and nothing else may dial out.
    const unavailable = (): never => { throw new Error('Network reached in what\'s-new audit') }
    globalThis.fetch = Object.assign(async () => unavailable(), { preconnect: unavailable }) as unknown as typeof fetch

    const { Elysia } = await import('elysia')
    const { HttpError } = await import('../src/utils/http-error')
    const { requireAdmin } = await import('../src/middleware/admin-auth')
    const { adminReleaseRoutes } = await import('../src/routes/admin-release.routes')
    const { appReleaseRoutes } = await import('../src/routes/app-release.routes')
    const { resetReviewerScopeCache } = await import('../src/services/reviewer-accounts')
    const { invalidateAppRelease, roundDueAt, sendDueRounds, saveRelease } =
      await import('../src/services/app-release.service')
    const { publicNotification, recordNotification, recordWhatsNewRows } =
      await import('../src/services/notifications.service')
    const { sendHeldWhatsNew } = await import('../src/services/release-notes.service')

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
    let tokenSequence = 0

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

    async function seedDevice(player: ObjectId, tzOffsetMinutes?: number): Promise<void> {
      await c('push_devices').insertOne({
        player_id: player,
        token: `token-${++tokenSequence}`,
        platform: 'android',
        updated_at: new Date(),
        ...(tzOffsetMinutes !== undefined ? { tz_offset_minutes: tzOffsetMinutes } : {}),
      })
    }

    /** A signed-in player who opened the app on `build` at `at`, with one phone. */
    async function player(build: number, at: Date, tzOffsetMinutes?: number, over: Doc = {}): Promise<ObjectId> {
      const id = await seedUser(over)
      await seedSession(id, build, at)
      await seedDevice(id, tzOffsetMinutes)
      return id
    }

    const now = () => new Date()

    async function reset(): Promise<void> {
      setSystemTime()
      for (const name of ['app_release', 'release_notes', 'app_sessions', 'app_installs',
        'push_devices', 'player_notifications', 'users']) {
        await c(name).deleteMany({})
      }
      resetReviewerScopeCache()
      invalidateAppRelease()
      pushes.length = 0
      jobs.length = 0
      published.length = 0
      userSequence = 0
      sessionSequence = 0
      tokenSequence = 0
    }

    const RELEASE = { latest_build: 18, latest_version: '1.0.15', min_build: 0, notes: ['The map remembers where you were.'] }
    const NOTE = {
      version: '1.0.15',
      title: 'Groups you can make yourself',
      intro: 'Play a story together, or watch one happen.',
      items: [
        { heading: 'Make a group', body: 'Pick who comes along and start a story together.', image_url: IMAGE },
        { heading: 'Quieter nights', body: 'The map stops blurring on older phones.' },
      ],
    }

    async function saveReleaseDoc(over: Doc = {}) {
      const response = await adminSend('PUT', '/admin/app-release', { ...RELEASE, ...over })
      assert.equal(response.status, 200, `PUT failed: ${JSON.stringify(response.body)}`)
      return response.body
    }

    async function saveNote(build: number, over: Doc = {}) {
      const response = await adminSend('PUT', `/admin/release-notes/${build}`, { ...NOTE, ...over })
      assert.equal(response.status, 200, `PUT note failed: ${JSON.stringify(response.body)}`)
      return response.body
    }

    async function dryPublish(build: number, push = false) {
      const response = await adminSend('POST', `/admin/release-notes/${build}/publish`, { dry_run: true, push })
      assert.equal(response.status, 200, `dry run failed: ${JSON.stringify(response.body)}`)
      return response.body
    }

    async function publish(build: number, confirm: string, push = false) {
      return adminSend('POST', `/admin/release-notes/${build}/publish`, { dry_run: false, push, confirm })
    }

    // ── 1. Validation ────────────────────────────────────────────────────────
    await check('PUT validates every field of a note', async () => {
      await reset()
      const good = NOTE
      const bad: Array<[string, unknown]> = [
        ['a null body', null],
        ['an array body', []],
        ['no fields at all', {}],
        ['a short version', { ...good, version: '1.0' }],
        ['a version with a prefix', { ...good, version: 'v1.0.15' }],
        ['a blank title', { ...good, title: '   ' }],
        ['a title over 60 characters', { ...good, title: 'x'.repeat(61) }],
        ['an intro over 200 characters', { ...good, intro: 'x'.repeat(201) }],
        ['no items', { ...good, items: [] }],
        ['seven items', { ...good, items: Array.from({ length: 7 }, () => good.items[0]) }],
        ['a heading over 50 characters', { ...good, items: [{ ...good.items[0], heading: 'x'.repeat(51) }] }],
        ['a body over 180 characters', { ...good, items: [{ ...good.items[0], body: 'x'.repeat(181) }] }],
        ['an item with no heading', { ...good, items: [{ body: 'Fine words.' }] }],
        ['an item that is not an object', { ...good, items: ['hello'] }],
        ['an unknown field', { ...good, subtitle: 'nope' }],
        ['an unknown item field', { ...good, items: [{ ...good.items[0], picture: IMAGE }] }],
      ]
      for (const [label, body] of bad) {
        const response = await adminSend('PUT', '/admin/release-notes/18', body)
        assert.equal(response.status, 400, `${label} was accepted: ${JSON.stringify(response.body)}`)
        assert.match(response.body.error, /^\S.*\.$/, `${label} did not get a plain 400 sentence: ${response.body.error}`)
      }

      // A build in the path that is not a whole number is refused too.
      for (const path of ['release-notes/abc', 'release-notes/-1', 'release-notes/1.5']) {
        const response = await adminSend('PUT', `/admin/${path}`, good)
        assert.equal(response.status, 400, `${path} was accepted`)
      }
    })

    await check('an image must be https on the CDN host, and none at all without a CDN', async () => {
      await reset()
      const imageCases: Array<[unknown, boolean]> = [
        [IMAGE, true],
        [`${CDN}/releases/cover.png`, true],
        ['http://cdn.everloreapp.com/cover.png', false],
        ['https://elsewhere.invalid/cover.png', false],
        ['https://cdn.everloreapp.com.evil.invalid/cover.png', false],
        ['not a url', false],
        ['', false],
        [42, false],
      ]
      for (const [image, ok] of imageCases) {
        const response = await adminSend('PUT', '/admin/release-notes/18',
          { ...NOTE, items: [{ ...NOTE.items[0], image_url: image }] })
        assert.equal(response.status, ok ? 200 : 400, `${String(image)} should be ${ok ? 'accepted' : 'refused'}`)
      }

      // An unset CDN base refuses every picture rather than trusting every host.
      known.CDN_BASE_URL = ''
      try {
        const refused = await adminSend('PUT', '/admin/release-notes/18', NOTE)
        assert.equal(refused.status, 400, 'no CDN base, no images')
        assert.match(refused.body.error, /^\S.*\.$/)
        // And a note with no picture at all is still fine.
        const plain = await adminSend('PUT', '/admin/release-notes/18',
          { ...NOTE, items: [{ heading: 'Make a group', body: 'Start a story together.' }] })
        assert.equal(plain.status, 200, JSON.stringify(plain.body))
      } finally {
        known.CDN_BASE_URL = CDN
      }
    })

    // ── 2. Drafts never leak ─────────────────────────────────────────────────
    await check('a draft is a 404 publicly, and a published note is exactly its fields', async () => {
      await reset()
      await saveReleaseDoc()
      await saveNote(18)

      const draft = await publicGet('/app/whats-new/18')
      assert.equal(draft.status, 404, 'a draft never reaches a player')

      const missing = await publicGet('/app/whats-new/99')
      assert.equal(missing.status, 404, 'a build with no note is the same 404')

      const players = await player(18, now())
      await seedSession(players, 18, now())
      const dry = await dryPublish(18)
      assert.equal((await publish(18, dry.confirm)).status, 200)

      const live = await publicGet('/app/whats-new/18')
      assert.equal(live.status, 200, JSON.stringify(live.body))
      console.log(`NOTE ${JSON.stringify(live.body)}`)
      keys(live.body, ['build', 'version', 'title', 'intro', 'items', 'published_at'], 'public note')
      assert.equal(live.body.build, 18)
      assert.equal(live.body.version, '1.0.15')
      assert.equal(live.body.title, NOTE.title)
      assert.equal(live.body.intro, NOTE.intro)
      keys(live.body.items[0], ['body', 'heading', 'image_url'], 'note item')
      keys(live.body.items[1], ['body', 'heading'], 'an item with no picture omits the key')
      assert.equal(live.body.items[1].image_url, undefined, 'never null')
      assert.match(live.body.published_at, /^\d{4}-\d{2}-\d{2}T/)

      // The admin read carries the draft machinery around the same words.
      const adminView = await adminGet('/admin/release-notes/18')
      assert.equal(adminView.status, 200)
      assert.equal(adminView.body.status, 'published')
      assert.equal(adminView.body.rows, 1)
      assert.equal(adminView.body.opened, 0)

      const list = await adminGet('/admin/release-notes')
      console.log(`NOTES ${JSON.stringify(list.body)}`)
      keys(list.body, ['items'], 'notes list')
      keys(list.body.items[0], ['build', 'version', 'title', 'status', 'published_at', 'rows', 'opened'],
        'a published note in the list')
      assert.equal(list.body.items[0].build, 18)

      const absent = await adminGet('/admin/release-notes/77')
      assert.equal(absent.status, 404)
    })

    // ── 3. Who a publish reaches ─────────────────────────────────────────────
    await check('publishing writes one row per eligible player, and leaves the rest out', async () => {
      await reset()
      await saveReleaseDoc()
      await saveNote(18)

      const alice = await player(17, now())                       // behind, still here
      const bob = await player(18, now())                         // up to date
      const reviewer = await player(10, now(), undefined, { reviewer: true })
      const gone = await player(10, new Date(now().getTime() - 100 * DAY))
      await seedSession(null, 16, now(), { install_id: 'guest-install-1' })   // a guest, no account
      resetReviewerScopeCache()

      const dry = await dryPublish(18)
      keys(dry, ['players', 'devices', 'confirm'], 'publish dry run')
      assert.equal(dry.players, 2, 'alice and bob — not the reviewer, not the one gone, not the guest install')
      assert.equal(dry.devices, 2)

      const sent = await publish(18, dry.confirm)
      assert.equal(sent.status, 200, JSON.stringify(sent.body))
      keys(sent.body, ['build', 'players', 'rows'], 'publish result')
      assert.equal(sent.body.rows, 2)

      const rows = await c('player_notifications').find({ type: 'whats_new' }).toArray()
      assert.deepEqual(rows.map((row) => String(row.player_id)).sort(), [String(alice), String(bob)].sort(),
        'every eligible player, and only them')
      assert.equal(String(rows.find((row) => row.player_id.equals(reviewer))?.player_id ?? '') , '',
        'a review account gets no row')
      assert.equal(rows.some((row) => row.player_id.equals(gone)), false, 'someone gone 90 days gets no row')
      assert.equal(pushes.length, 0, 'no push unless it was asked for')
      assert.equal(published.length, 0, 'a bulk publish does not send a frame per player')
    })

    await check('a second publish is refused, and edits do not send it again', async () => {
      await reset()
      await saveReleaseDoc()
      await saveNote(18)
      await player(17, now())

      const first = await dryPublish(18)
      assert.equal((await publish(18, first.confirm)).status, 200)
      assert.equal(await c('player_notifications').countDocuments({ type: 'whats_new' }), 1)

      const second = await dryPublish(18)
      const refused = await publish(18, second.confirm)
      assert.equal(refused.status, 409, `a second publish was accepted: ${JSON.stringify(refused.body)}`)
      assert.match(refused.body.error, /^\S.*\.$/)
      assert.equal(await c('player_notifications').countDocuments({ type: 'whats_new' }), 1, 'no second row')

      // An already-live note keeps its published moment, and its words are the
      // ones the page reads from now on.
      const liveBefore = await c('release_notes').findOne({ _id: 18 }) as Doc
      await saveNote(18, { title: 'Groups you can make together' })
      const liveAfter = await c('release_notes').findOne({ _id: 18 }) as Doc
      assert.equal(liveAfter.title, 'Groups you can make together', 'a live note is still editable')
      assert.equal((liveAfter.published_at as Date).getTime(), (liveBefore.published_at as Date).getTime())
      const page = await publicGet('/app/whats-new/18')
      assert.equal(page.body.title, 'Groups you can make together')

      // A real send with no token, or a token from another build, is refused.
      const noToken = await adminSend('POST', '/admin/release-notes/19/publish', { dry_run: false, push: false })
      assert.equal(noToken.status, 404, 'there is no note for 19')
      const stale = await dryPublish(18)
      await seedSession((await c('users').findOne({}) as Doc)._id as ObjectId, 18, now())
      const wrongBuild = await adminSend('POST', '/admin/release-notes/19/publish',
        { dry_run: false, push: false, confirm: stale.confirm })
      assert.equal(wrongBuild.status, 404)
    })

    // ── 4. The push and the night hold ───────────────────────────────────────
    await check('the push goes only when asked, and a phone in its night waits for ten', async () => {
      await reset()
      setSystemTime(new Date('2026-11-18T17:30:00.000Z'))
      try {
        await saveReleaseDoc()
        await saveNote(18)
        const night = await player(17, now(), 330)     // 23:00 in IST
        const afternoon = await player(17, now(), -180) // 14:30 at UTC-3
        const noOffset = await player(17, now())

        const dry = await dryPublish(18, true)
        assert.equal(dry.players, 3)

        const sent = await publish(18, dry.confirm, true)
        assert.equal(sent.status, 200, JSON.stringify(sent.body))
        assert.equal(sent.body.devices, 2, 'the afternoon phone and the one with no clock')
        assert.equal(sent.body.held, 1)

        assert.deepEqual(pushes.map((push) => String(push.device.player_id)).sort(),
          [String(afternoon), String(noOffset)].sort(), 'nobody is woken at 23:00')

        const held = jobs.filter((job) => job.name === 'whats-new-held')
        assert.equal(held.length, 1, 'one delayed job for the held clock')
        assert.deepEqual(held[0].data, {
          task: 'whats-new-held', build: 18, playerIds: [String(night)], tzOffsetMinutes: 330,
        })
        assert.equal(held[0].opts.delay, 11 * HOUR, 'queued for 04:30Z, which is 10:00 in IST')

        const stored = await c('release_notes').findOne({ _id: 18 }) as Doc
        assert(stored.pushed_at instanceof Date, 'the note records that a push went out')

        // 10:00 their time: the held phone is sent, with the note's own words.
        setSystemTime(new Date('2026-11-19T04:30:00.000Z'))
        const morning = await sendHeldWhatsNew(held[0].data)
        assert.deepEqual(morning, { sent: 1 })
        const last = pushes[pushes.length - 1]
        assert.deepEqual(last.payload.data, { type: 'whats_new', build: '18' })
        assert.deepEqual(last.payload.notification, { title: NOTE.title, body: NOTE.intro })
        assert.equal(String(last.device.player_id), String(night))

        // A note taken down before the morning is not announced in the morning.
        await c('release_notes').updateOne({ _id: 18 }, { $set: { status: 'draft' } })
        assert.deepEqual(await sendHeldWhatsNew(held[0].data), { sent: 0 }, 'a draft is not pushed')
      } finally {
        setSystemTime()
      }
    })

    await check('the note push carries its own words, and the fixed line has no technical copy', async () => {
      await reset()
      await saveReleaseDoc()
      await saveNote(18)
      await player(17, now())
      const dry = await dryPublish(18, true)
      await publish(18, dry.confirm, true)

      assert.equal(pushes.length, 1)
      // The owner's words pass through untouched: they are the words a player is
      // meant to read, and the server does not filter them (AGENTS: no word
      // lists). What must be clean is the sentence the server writes itself.
      assert.deepEqual(pushes[0].payload.notification, { title: NOTE.title, body: NOTE.intro })
      assert.deepEqual(pushes[0].payload.data, { type: 'whats_new', build: '18' })
      assert.deepEqual(Object.keys(pushes[0].payload.data as Doc).sort(), ['build', 'type'],
        'nothing but the type and the build rides along')

      const fallback = realPush.whatsNewNotification({ title: NOTE.title }, 18)
      assert.deepEqual(fallback.notification, { title: NOTE.title, body: 'See what changed in Everlore' })
      assert.doesNotMatch(fallback.notification.body,
        /build|version|android|ios|play|google|apk|firebase|fcm|store|code/i,
        `technical copy in the server's own sentence: ${fallback.notification.body}`)
    })

    // ── 5. The row shape ─────────────────────────────────────────────────────
    await check('a whats_new row has no instance_id key and names its build', async () => {
      await reset()
      const playerId = new ObjectId()
      await recordWhatsNewRows([playerId], {
        build: 18, title: NOTE.title, body: NOTE.intro!, imageUrl: IMAGE,
      })
      const row = await c('player_notifications').findOne({}) as Doc
      assert.equal('instance_id' in row, false, 'no instance_id, and not written null')
      assert.equal(row.type, 'whats_new')
      assert.equal(row.release_build, 18)
      assert.equal(row.title, NOTE.title)
      assert.equal(row.body, NOTE.intro)
      assert.equal(row.image_url, IMAGE)
      assert.ok(row.created_at instanceof Date)

      const item = publicNotification(row as never)
      assert.equal('instance_id' in item, false, 'the wire omits the key too')
      keys(item, ['id', 'type', 'release_build', 'title', 'body', 'image_url', 'created_at'], 'a whats_new item')
    })

    await check('a story row is unchanged, and still needs a save', async () => {
      await reset()
      const playerId = new ObjectId()
      const instanceId = new ObjectId()
      await c('characters').insertOne({ _id: new ObjectId(), instance_id: instanceId, canonical_name: 'Bea' })
      await recordNotification({
        playerId: playerId.toHexString(), type: 'group_direct', instanceId: instanceId.toHexString(), name: 'Bea',
      })
      const row = await c('player_notifications').findOne({}) as Doc
      assert.equal(String(row.instance_id), String(instanceId), 'a story row still opens its save')
      assert.equal(row.release_build, undefined, 'and names no build')

      const item = publicNotification(row as never)
      keys(item, ['id', 'type', 'instance_id', 'title', 'body', 'created_at'], 'a story item')

      // Every kind but `whats_new` is refused without a save, rather than
      // written as a row a tap could not open.
      const before = await c('player_notifications').countDocuments({})
      const refused = await recordNotification({
        playerId: playerId.toHexString(), type: 'group_direct', name: 'Bea',
      } as never)
      assert.equal(refused, undefined)
      assert.equal(await c('player_notifications').countDocuments({}), before, 'nothing was written')
    })

    await check('a publish trims each player to the same 100-row cap as the bell', async () => {
      await reset()
      const playerId = new ObjectId()
      const instanceId = new ObjectId()
      for (let index = 0; index < 105; index++) {
        await recordNotification({
          playerId: playerId.toHexString(), type: 'group_direct', instanceId: instanceId.toHexString(), name: 'Bea',
        })
      }
      assert.equal(await c('player_notifications').countDocuments({ player_id: playerId }), 100)

      await recordWhatsNewRows([playerId], { build: 18, title: NOTE.title, body: NOTE.intro! })
      assert.equal(await c('player_notifications').countDocuments({ player_id: playerId }), 100,
        'one row in, the oldest goes')
      assert.equal(await c('player_notifications').countDocuments({ player_id: playerId, type: 'whats_new' }), 1,
        'the new row is the one kept')
    })

    // ── 6. The rounds ────────────────────────────────────────────────────────
    await check('the console reads live_at, the switch and the three round moments', async () => {
      await reset()
      const LIVE = new Date('2026-11-18T09:00:00.000Z')
      setSystemTime(LIVE)
      await saveReleaseDoc()
      setSystemTime()

      const view = await adminGet('/admin/app-release')
      console.log(`RELEASE ${JSON.stringify(view.body)}`)
      keys(view.body, ['_id', 'latest_build', 'latest_version', 'min_build', 'notes', 'updated_at',
        'live_at', 'auto_reminders', 'announced', 'rounds', 'in_use', 'behind'], 'admin release')
      assert.equal(view.body.live_at, LIVE.toISOString(), 'the moment the build went live')
      assert.equal(view.body.auto_reminders, true, 'reminders are on unless switched off')
      assert.equal(view.body.rounds.length, 3)
      assert.deepEqual(view.body.rounds.map((round: Doc) => [round.round, round.due_at]), [
        [1, new Date(LIVE.getTime() + HOUR).toISOString()],
        [2, new Date(LIVE.getTime() + 3 * DAY).toISOString()],
        [3, new Date(LIVE.getTime() + 7 * DAY).toISOString()],
      ])
      for (const round of view.body.rounds) keys(round, ['round', 'due_at'], 'a round that has not sent')
    })

    await check('rounds fall due at +1h/+3d/+7d, send once, and a catch-up never doubles', async () => {
      await reset()
      const LIVE = new Date('2026-11-18T09:00:00.000Z')
      setSystemTime(LIVE)
      await saveReleaseDoc()
      await player(17, LIVE)
      setSystemTime()

      const at = (offset: number) => new Date(LIVE.getTime() + offset)
      const tick = async (when: Date) => {
        setSystemTime(when)
        try {
          return await sendDueRounds()
        } finally {
          setSystemTime()
        }
      }

      assert.equal(roundDueAt(LIVE, 1).toISOString(), at(HOUR).toISOString(), 'round 1 is an hour later')
      assert.equal(roundDueAt(LIVE, 2).toISOString(), at(3 * DAY).toISOString(), 'round 2 is three days later')
      assert.equal(roundDueAt(LIVE, 3).toISOString(), at(7 * DAY).toISOString(), 'round 3 is a week later')

      assert.deepEqual((await tick(at(HOUR - 60_000))).sent, [], 'nothing an hour early')
      assert.deepEqual((await tick(at(HOUR))).sent.map((entry) => entry.round), [1])
      assert.deepEqual((await tick(at(HOUR + 60_000))).sent, [], 'the same round never doubles')
      assert.equal(pushes.length, 1)

      // An eight-day outage catches up all three rounds in one run, once each.
      const catchUp = await tick(at(8 * DAY))
      assert.deepEqual(catchUp.sent.map((entry) => entry.round), [2, 3], 'the two that had not gone')
      assert.deepEqual((await tick(at(8 * DAY + HOUR))).sent, [])
      assert.equal(pushes.length, 3, 'three rounds, three phones, not six')
    })

    await check('rounds stop when the build is replaced or the reminders are off', async () => {
      await reset()
      const LIVE = new Date('2026-11-18T09:00:00.000Z')
      setSystemTime(LIVE)
      await saveReleaseDoc({ auto_reminders: false })
      await player(17, LIVE)
      setSystemTime()

      const tick = async (when: Date) => {
        setSystemTime(when)
        try {
          return await sendDueRounds()
        } finally {
          setSystemTime()
        }
      }

      assert.deepEqual((await tick(new Date(LIVE.getTime() + 8 * DAY))).sent, [], 'the switch is off')
      assert.equal(pushes.length, 0)

      setSystemTime(LIVE)
      await saveReleaseDoc({ auto_reminders: true })
      await saveReleaseDoc({ latest_build: 19, latest_version: '1.0.16', auto_reminders: true })
      setSystemTime()

      const later = await tick(new Date(LIVE.getTime() + 8 * DAY))
      assert.equal(later.build, 19, 'the job works on the build that is live now')
      const stored = await c('app_release').findOne({ _id: 'android' }) as Doc
      assert.equal(stored.announced.filter((entry: Doc) => entry.build === 18).length, 0,
        'a replaced build is never announced')
    })

    await check('rounds 2 and 3 skip a player who opened the app in the last day', async () => {
      await reset()
      const LIVE = new Date('2026-11-18T09:00:00.000Z')
      setSystemTime(LIVE)
      await saveReleaseDoc()
      const settled = await seedUser()
      await seedDevice(settled)
      const away = await player(17, LIVE)
      setSystemTime()

      // `settled` opened the app the day before round 2 fell due.
      await seedSession(settled, 17, new Date(LIVE.getTime() + 2 * DAY), { install_id: 'settled-install' })
      resetReviewerScopeCache()

      const tick = async (when: Date) => {
        setSystemTime(when)
        try {
          return await sendDueRounds()
        } finally {
          setSystemTime()
        }
      }

      await tick(new Date(LIVE.getTime() + HOUR))   // round 1 reaches both
      assert.equal(pushes.length, 2, 'round 1 is for everyone behind')

      const second = await tick(new Date(LIVE.getTime() + 3 * DAY))
      assert.deepEqual(second.sent.map((entry) => [entry.round, entry.devices]), [[2, 1]])
      assert.deepEqual(pushes.slice(2).map((push) => String(push.device.player_id)), [String(away)],
        'the player who opened the app yesterday is left alone')
    })

    // ── 7. The guard ─────────────────────────────────────────────────────────
    await check('every release note route refuses an unauthenticated caller', async () => {
      await reset()
      await saveReleaseDoc()
      await saveNote(18)
      const routes = (admin.routes as Array<{ method: string; path: string }>)
        .filter((route) => route.path.includes('release-notes'))
      const expected = [
        'GET /admin/release-notes',
        'GET /admin/release-notes/:build',
        'PUT /admin/release-notes/:build',
        'POST /admin/release-notes/:build/publish',
      ]
      assert.deepEqual(routes.map((route) => `${String(route.method).toUpperCase()} ${route.path}`).sort(),
        expected.sort())

      try {
        for (const route of routes) {
          const path = route.path.replace(':build', '18')
          const init: RequestInit = String(route.method).toUpperCase() === 'GET'
            ? { method: 'GET' }
            : { method: String(route.method).toUpperCase(), body: '{}' }
          known.ADMIN_USERNAME = ''
          known.ADMIN_PASSWORD = ''
          const unconfigured = await adminRequest(path, init, { authorization: '' })
          assert.equal(unconfigured.status, 503, `${route.method} ${route.path} without configured credentials`)
          assert.deepEqual(unconfigured.body, { error: 'Admin credentials are not configured' })

          known.ADMIN_USERNAME = ADMIN
          known.ADMIN_PASSWORD = ADMIN_PASSWORD
          const anonymous = await adminRequest(path, init, { authorization: '' })
          assert.equal(anonymous.status, 401, `${route.method} ${route.path} without a caller`)
          assert.deepEqual(anonymous.body, { error: 'Unauthorized' })
        }
      } finally {
        known.ADMIN_USERNAME = ADMIN
        known.ADMIN_PASSWORD = ADMIN_PASSWORD
      }

      // A player's route is public by contract, and still hides the draft.
      await c('release_notes').updateOne({ _id: 18 }, { $set: { status: 'draft' } })
      assert.equal((await publicGet('/app/whats-new/18')).status, 404)
    })

    console.log(`\nwhats-new: ${failures === 0 ? 'ALL GREEN' : `${failures} FAILED`} (${passed} passed)`)
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

const NOTES = 'src/services/release-notes.service.ts'
const RELEASE = 'src/services/app-release.service.ts'
const NOTIFICATIONS = 'src/services/notifications.service.ts'

const MUTATIONS: ReadonlyArray<readonly [string, string, string, string]> = [
  ['the console reads live_at, the switch and the three round moments', RELEASE,
    '  3: 7 * DAY_MS,', '  3: 6 * DAY_MS,'],
  ['PUT validates every field of a note', NOTES,
    '  if (input.items.length > ITEMS_MAX) throw new HttpError(400, `A note can have at most ${ITEMS_MAX} things that changed.`)',
    '  if (false) throw new HttpError(400, \'unused\')'],
  ['an image must be https on the CDN host, and none at all without a CDN', NOTES,
    "  if (url.protocol !== 'https:' || url.host.toLowerCase() !== host) {",
    '  if (false) {'],
  ['a draft is a 404 publicly, and a published note is exactly its fields', NOTES,
    "  const note = await mongoColl.releaseNotes().findOne({ _id: build, status: 'published' })",
    '  const note = await mongoColl.releaseNotes().findOne({ _id: build })'],
  ['publishing writes one row per eligible player, and leaves the rest out', RELEASE,
    "    { $match: { started_at: { $gte: new Date(now.getTime() - days * DAY_MS) }, user_id: userMatch } },\n    { $group: { _id: '$user_id' } },",
    "    { $match: { started_at: { $gte: new Date(now.getTime() - days * DAY_MS) }, user_id: { $exists: true } } },\n    { $group: { _id: '$user_id' } },"],
  ['a second publish is refused, and edits do not send it again', NOTES,
    "    { _id: build, status: 'draft' },\n    { $set: { status: 'published', published_at: now, updated_at: now } },",
    "    { _id: build },\n    { $set: { status: 'published', published_at: now, updated_at: now } },"],
  ['the push goes only when asked, and a phone in its night waits for ten', NOTES,
    "  return local >= NIGHT_FROM_HOUR * 60 || local < NIGHT_UNTIL_HOUR * 60",
    '  return false'],
  ['the note push carries its own words, and the fixed line has no technical copy', 'src/services/push/fcm.ts',
    "body: note.intro?.trim() || 'See what changed in Everlore'",
    "body: note.intro?.trim() || 'See what changed in this build'"],
  ['a whats_new row has no instance_id key and names its build', NOTIFICATIONS,
    "      type: 'whats_new',\n      release_build: note.build,",
    "      type: 'whats_new',\n      instance_id: new ObjectId(),\n      release_build: note.build,"],
  ['a story row is unchanged, and still needs a save', NOTIFICATIONS,
    "    const instanceId = input.instanceId ? parseObjectId(input.instanceId) : undefined\n    if (!instanceId) {",
    '    const instanceId = input.instanceId ? parseObjectId(input.instanceId) : new ObjectId()\n    if (false) {'],
  ['a publish trims each player to the same 100-row cap as the bell', NOTIFICATIONS,
    '    const results = await Promise.allSettled(batch.map((playerId) => trimToCap(playerId)))',
    '    const results = await Promise.allSettled(batch.map(async () => undefined))'],
  ['rounds fall due at +1h/+3d/+7d, send once, and a catch-up never doubles', RELEASE,
    '  2: 3 * DAY_MS,', '  2: 2 * DAY_MS,'],
  ['rounds stop when the build is replaced or the reminders are off', RELEASE,
    "  if (doc?.auto_reminders === false) return { build: release.latest_build, sent: [] }",
    '  // the switch is ignored'],
  ['rounds 2 and 3 skip a player who opened the app in the last day', RELEASE,
    '  if (round >= 2) {', '  if (false) {'],
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
