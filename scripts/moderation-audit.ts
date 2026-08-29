/**
 * The reporting and blocking layer — the two things Google Play requires of any
 * app that shows one account's content to another, and the two things whose
 * failure modes are silent.
 *
 * What is actually being pinned here:
 *  - a blocked creator's worlds leave discovery, and only for the blocker
 *  - an admin-hidden world leaves discovery for everyone
 *  - a report survives the reported world being renamed or deleted
 *  - re-reporting cannot flood the queue, but re-reporting after a resolution can
 *  - banning a creator takes their whole catalogue out of circulation
 *
 * Runs against an isolated scratch database on the local mongod, never the
 * configured MONGODB_URI, and drops it on the way out.
 *
 *   bun run audit:moderation
 */
import { MongoClient, ObjectId } from 'mongodb'

const SCRATCH_URI =
  process.env.MODERATION_AUDIT_URI || 'mongodb://127.0.0.1:27017/everlore_moderation_audit'

process.env.MONGODB_URI = SCRATCH_URI

// Drop before the app connects: connectMongo builds indexes on startup, and a
// unique index cannot be built over rows a previous failed run left behind.
{
  const cleaner = new MongoClient(SCRATCH_URI)
  await cleaner.connect()
  await cleaner.db().dropDatabase()
  await cleaner.close()
}

const { connectMongo, mongoColl, getDb } = await import('../src/config/mongo')
const { connectRedis } = await import('../src/config/redis')
const { moderationService } = await import('../src/services/moderation.service')

let passed = 0
const failures: string[] = []

function check(name: string, condition: boolean, detail = '') {
  if (condition) {
    passed += 1
    console.log(`  ok   ${name}`)
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`)
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

async function makeUser(username: string) {
  const now = new Date()
  const result = await mongoColl.users().insertOne({
    username,
    password_hash: 'x',
    tier: 'free',
    providers: ['password'],
    preferences: {
      nsfw_enabled: false,
      preferred_model: '',
      theme: 'dark',
      narration_length: 'detailed',
      auto_memory_curation: true,
    },
    token_balance: 0,
    created_at: now,
    updated_at: now,
  } as never)
  return result.insertedId
}

async function makeWorld(creatorId: ObjectId, title: string) {
  const now = new Date()
  const result = await mongoColl.worldTemplates().insertOne({
    creator_id: creatorId,
    title,
    slug: title.toLowerCase().replace(/\s+/g, '-'),
    description: `${title} description`,
    is_published: true,
    is_sentient: false,
    is_nsfw_capable: false,
    version: 1,
    seed_prompt: '',
    global_lore: '',
    base_stats_template: {},
    flag_definitions: {},
    scene_tags: [],
    model_preferences: {},
    max_context_memories: 25,
    max_lore_results: 10,
    created_at: now,
    updated_at: now,
  } as never)
  return result.insertedId
}

/** Everything discovery would show this player, using the real filter. */
async function discoverable(userId: ObjectId | null): Promise<string[]> {
  const filter = {
    is_published: true,
    ...(await moderationService.discoveryFilter(userId ? userId.toHexString() : null)),
  }
  const rows = await mongoColl.worldTemplates().find(filter).toArray()
  return rows.map((row) => row.title).sort()
}

async function main() {
  await connectMongo()
  const db = getDb()
  // connectMongo already built the indexes on the empty database. The report
  // dedup is enforced by a unique partial index, so an audit running without it
  // would silently pass a case the real system fails — assert it is there.
  const indexNames = (await db.collection('content_reports').indexes()).map((i) => i.name)
  check(
    'the report dedup index exists',
    indexNames.includes('uniq_content_reports_open_per_reporter'),
    indexNames.join(','),
  )
  // Template deletion publishes an invalidation over Redis.
  await connectRedis()

  const alice = await makeUser('alice')
  const bob = await makeUser('bob')
  const mallory = await makeUser('mallory')

  const aliceWorld = await makeWorld(alice, 'Alice World')
  const malloryWorld = await makeWorld(mallory, 'Mallory World')
  const malloryOther = await makeWorld(mallory, 'Mallory Second')

  console.log('\nblocking')

  check(
    'everything is discoverable before any block',
    (await discoverable(bob)).join(',') === 'Alice World,Mallory Second,Mallory World',
    (await discoverable(bob)).join(','),
  )

  await moderationService.blockUser(bob.toHexString(), mallory.toHexString())
  check(
    "blocking a creator removes that creator's whole catalogue",
    (await discoverable(bob)).join(',') === 'Alice World',
    (await discoverable(bob)).join(','),
  )
  check(
    'the block is private to the blocker',
    (await discoverable(alice)).length === 3,
  )
  check('an anonymous browser is unaffected', (await discoverable(null)).length === 3)

  await moderationService.blockUser(bob.toHexString(), mallory.toHexString())
  const blocksAfterRepeat = await moderationService.blocksFor(bob.toHexString())
  check('blocking twice does not duplicate the entry', blocksAfterRepeat.users.length === 1)

  await moderationService.unblockUser(bob.toHexString(), mallory.toHexString())
  check('unblocking restores the catalogue', (await discoverable(bob)).length === 3)

  await moderationService.blockTemplate(bob.toHexString(), malloryWorld.toHexString())
  check(
    'blocking one world leaves the creator’s other worlds visible',
    (await discoverable(bob)).join(',') === 'Alice World,Mallory Second',
    (await discoverable(bob)).join(','),
  )

  let selfBlockRefused = false
  try {
    await moderationService.blockTemplate(alice.toHexString(), aliceWorld.toHexString())
  } catch {
    selfBlockRefused = true
  }
  check('a creator cannot block their own world', selfBlockRefused)

  const listed = await moderationService.listBlocks(bob.toHexString())
  check('blocked worlds are listed back with their titles', listed.worlds[0]?.title === 'Mallory World')

  await moderationService.unblockTemplate(bob.toHexString(), malloryWorld.toHexString())

  console.log('\nreporting')

  const first = await moderationService.report({
    reporterId: bob.toHexString(),
    targetType: 'world',
    targetId: malloryWorld.toHexString(),
    reason: 'harassment_or_hate',
    details: 'targeted abuse',
  })
  check('a report is filed', first.reported && !first.duplicate)

  const second = await moderationService.report({
    reporterId: bob.toHexString(),
    targetType: 'world',
    targetId: malloryWorld.toHexString(),
    reason: 'harassment_or_hate',
  })
  check('re-reporting the same target is deduplicated', second.duplicate === true)
  check(
    'the duplicate resolves to the original report',
    second.report_id === first.report_id,
  )

  let selfReportRefused = false
  try {
    await moderationService.report({
      reporterId: mallory.toHexString(),
      targetType: 'world',
      targetId: malloryWorld.toHexString(),
      reason: 'spam_or_misleading',
    })
  } catch {
    selfReportRefused = true
  }
  check('a creator cannot report their own world', selfReportRefused)

  let blankOtherRefused = false
  try {
    await moderationService.report({
      reporterId: alice.toHexString(),
      targetType: 'world',
      targetId: malloryWorld.toHexString(),
      reason: 'other',
      details: '   ',
    })
  } catch {
    blankOtherRefused = true
  }
  check('"other" without an explanation is refused', blankOtherRefused)

  const critical = await moderationService.report({
    reporterId: alice.toHexString(),
    targetType: 'world',
    targetId: malloryOther.toHexString(),
    reason: 'sexual_content_involving_minors',
  })
  const queue = await moderationService.listReports({ status: 'unresolved' })
  check(
    'a critical report sorts to the top of the queue',
    queue.items[0]?.id === critical.report_id,
    queue.items.map((item) => item.reason).join(','),
  )
  check('the queue counts both open reports', queue.total === 2)

  const stats = await moderationService.queueStats()
  check('queue stats count the critical report', stats.critical_reports === 1)

  console.log('\nsnapshots survive the content')

  await mongoColl
    .worldTemplates()
    .updateOne({ _id: malloryWorld }, { $set: { title: 'Renamed Innocuous' } })
  const afterRename = await moderationService.getReport(first.report_id!)
  check(
    'the report still shows the title as it was when reported',
    afterRename.report.target_snapshot.title === 'Mallory World',
    String(afterRename.report.target_snapshot.title),
  )
  check('the live target reflects the rename', afterRename.target?.title === 'Renamed Innocuous')
  check('the reporter is resolved', afterRename.reporter?.username === 'bob')
  check('the creator is resolved', afterRename.creator?.username === 'mallory')

  console.log('\nmoderator actions')

  await moderationService.resolveReport(first.report_id!, {
    action: 'content_hidden',
    note: 'hidden pending review',
    resolved_by: 'auditor',
  })
  check(
    'hiding a world removes it from discovery for everyone',
    !(await discoverable(alice)).includes('Renamed Innocuous'),
    (await discoverable(alice)).join(','),
  )
  check(
    'the world is hidden from an anonymous browser too',
    !(await discoverable(null)).includes('Renamed Innocuous'),
  )

  const resolved = await moderationService.getReport(first.report_id!)
  check('the report records who acted', resolved.report.resolved_by === 'auditor')
  check('the report records the action', resolved.report.action_taken === 'content_hidden')
  check('the report is marked actioned', resolved.report.status === 'actioned')

  const reReport = await moderationService.report({
    reporterId: bob.toHexString(),
    targetType: 'world',
    targetId: malloryWorld.toHexString(),
    reason: 'illegal_content',
    details: 'still up',
  })
  check(
    'the same reporter may file again once the first is resolved',
    reReport.duplicate === false,
  )

  await moderationService.setWorldModeration(
    malloryWorld.toHexString(),
    'active',
    '',
    'auditor',
  )
  check(
    'un-hiding restores discovery',
    (await discoverable(alice)).includes('Renamed Innocuous'),
  )

  const dismissed = await moderationService.resolveReport(reReport.report_id!, {
    action: 'none',
    resolved_by: 'auditor',
  })
  check('an action of none dismisses rather than actions', dismissed.report?.status === 'dismissed')

  await moderationService.reopenReport(reReport.report_id!)
  const reopened = await moderationService.getReport(reReport.report_id!)
  check('a resolved report can be reopened', reopened.report.status === 'open')
  check('reopening clears the previous decision', reopened.report.action_taken === null)

  console.log('\nbanning a creator')

  await moderationService.resolveReport(critical.report_id!, {
    action: 'creator_banned',
    note: 'prohibited content',
    resolved_by: 'auditor',
  })
  const bannedUser = await mongoColl.users().findOne({ _id: mallory })
  check('the creator is banned', bannedUser?.account_status === 'banned')
  check(
    "the banned creator's entire catalogue leaves discovery",
    (await discoverable(alice)).join(',') === 'Alice World',
    (await discoverable(alice)).join(','),
  )

  console.log('\ndeletion')

  const deletionReport = await moderationService.report({
    reporterId: bob.toHexString(),
    targetType: 'world',
    targetId: aliceWorld.toHexString(),
    reason: 'illegal_content',
    details: 'remove it',
  })
  await moderationService.resolveReport(deletionReport.report_id!, {
    action: 'content_deleted',
    resolved_by: 'auditor',
  })
  const gone = await mongoColl.worldTemplates().findOne({ _id: aliceWorld })
  check('the world is actually deleted', gone === null)
  const afterDelete = await moderationService.getReport(deletionReport.report_id!)
  check(
    'the report outlives the deleted world',
    afterDelete.report.target_snapshot.title === 'Alice World',
  )
  check('the live target reads as gone', afterDelete.target === null)

  await db.dropDatabase()

  console.log(`\n${passed} passed, ${failures.length} failed`)
  if (failures.length > 0) {
    for (const failure of failures) console.log(`  - ${failure}`)
    process.exit(1)
  }
}

await main()
