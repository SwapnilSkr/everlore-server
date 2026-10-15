/** Direct local service smoke. Default storage is a local byte sink: dispatched agents never use AWS.
 * The orchestrator may pass --s3 only after the owner's AWS login/identity checks in AGENTS.md.
 * Exactly one paid speech submission, guarded by a durable cumulative $0.10 budget.
 */
import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises'
import { ObjectId } from 'mongodb'
import { env } from '../src/config/env'
import { connectMongo, mongoColl } from '../src/config/mongo'
import { connectRedis } from '../src/config/redis'
import { getMediaQueue } from '../src/queues'
import { requestVoice, processVoice, mediaEffects } from '../src/services/media/service'
import { detectSpokenLines } from '../src/services/media/detection'
import { mediaRevision } from '../src/services/media/attribution'
import { mediaUsage } from '../src/services/media/usage'
import { purgeMedia } from '../src/services/media/deletion'
import { storageService } from '../src/services/storage.service'
import { HttpError } from '../src/utils/http-error'
import { voiceCatalogue } from '../src/services/media/config'

const localHost = (value: string) => ['localhost', '127.0.0.1', '[::1]'].includes(new URL(value).hostname)
if (!localHost(env.MONGODB_URI) || !localHost(env.REDIS_URL)) throw new Error('Smoke requires local Mongo and Redis; refusing remote data stores')
const dir = new URL('./media-voice-smoke-output/', import.meta.url)
await mkdir(dir, { recursive: true })
const budgetFile = new URL('budget.json', dir)
const budget = await readFile(budgetFile, 'utf8').then((s) => JSON.parse(s) as { reserved_usd: number; submissions: number }).catch((error: NodeJS.ErrnoException) => {
  if (error.code !== 'ENOENT') throw error
  return { reserved_usd: 0, submissions: 0 }
})
assert.ok(Number.isFinite(budget.reserved_usd) && budget.reserved_usd >= 0)
const originalSynthesize = mediaEffects.synthesize
let submissions = 0
mediaEffects.synthesize = async (req) => {
  assert.equal(submissions, 0, 'No paid-call loops or retries in smoke')
  const estimated = req.input.length * voiceCatalogue(req.model).rate_usd_per_character
  assert.ok(budget.reserved_usd + estimated <= 0.10, 'Cumulative speech budget exhausted')
  budget.reserved_usd += estimated; budget.submissions++; submissions++
  // Reserve before sending. Even an ambiguous network failure keeps its exposure.
  await writeFile(budgetFile, JSON.stringify(budget, null, 2) + '\n', { mode: 0o600 })
  console.log(`Speech spend exposure: $${budget.reserved_usd.toFixed(6)} / $0.10 (₹${(budget.reserved_usd * 85).toFixed(3)} / ₹8.50)`)
  return originalSynthesize(req)
}
const useS3 = process.argv.includes('--s3')
const localAudio = new URL('clip.mp3', dir)
if (!useS3) {
  mediaEffects.upload = async (data, _type, opts) => {
    await writeFile(localAudio, data)
    return { key: opts?.key || '', url: 'https://local-storage.invalid/clip.mp3' }
  }
  mediaEffects.remove = async () => { await unlink(localAudio).catch(() => {}) }
  storageService.deleteStrict = mediaEffects.remove
  console.log('Storage adapter: local bytes; no AWS request. CDN/S3 proof requires orchestrator --s3 run.')
}
process.env.MEDIA_ENABLED = 'true'; process.env.MEDIA_VOICE_ENABLED = 'true'; process.env.MEDIA_DAILY_VOICE = '2'
await connectMongo(); await connectRedis()
const player = new ObjectId(), instance = new ObjectId(), template = new ObjectId(), event = new ObjectId(), character = new ObjectId()
const prose = 'Mira says, “Stay close.” Then she adds, “Follow me.”'
const now = new Date()
let code = 1
try {
  await mongoColl.users().insertOne({ _id: player, username: `media-smoke-${player}`, password_hash: '', providers: [], tier: 'free', token_balance: 0,
    preferences: { nsfw_enabled: false, preferred_model: '', theme: '', narration_length: 'short', auto_memory_curation: false }, created_at: now, updated_at: now })
  await mongoColl.worldTemplates().insertOne({ _id: template, creator_id: player, title: 'Media smoke', slug: `media-smoke-${template}`, description: '', is_published: false,
    is_sentient: false, is_nsfw_capable: false, version: 1, seed_prompt: '', global_lore: '', base_stats_template: {}, flag_definitions: {}, scene_tags: [], model_preferences: {},
    seed_cast: [{ name: 'Mira', voice_traits: { gender_presentation: 'female', age_band: 'young' } }], max_context_memories: 1, max_lore_results: 1, created_at: now, updated_at: now })
  await mongoColl.worldInstances().insertOne({ _id: instance, player_id: player, template_id: template, template_version: 1, world_state: {}, active_flags: {}, current_scene: { tag: 'dialogue', turn_count: 1, summary_pending: false },
    meta: { total_events: 1, total_memories: 0, total_tokens_consumed: 0, last_active_at: now, is_archived: false }, created_at: now, updated_at: now })
  await mongoColl.characters().insertOne({ _id: character, instance_id: instance, player_id: player, canonical_name: 'Mira', name_normalized: 'mira', aliases: [], immutable_facts: [], mutable_state: [], disposition_to_player: '', hidden_thought: '', first_seen_sequence: 1, last_seen_sequence: 1, mention_count: 1, created_at: now, updated_at: now })
  await mongoColl.events().insertOne({ _id: event, instance_id: instance, player_id: player, sequence: 1, type: 'narration',
    data: { ai_response: prose, player_input: '', spoken_lines: detectSpokenLines(prose), media_revision: mediaRevision(prose), state_mutations: {}, flag_mutations: {}, model_used: 'smoke', tokens_in: 0, tokens_out: 0 },
    is_user_edited: false, edit_history: [], scene_tag: 'dialogue', created_at: now })
  const stored = await mongoColl.events().findOne({ _id: event })
  assert.equal(stored?.data.spoken_lines?.length, 2)
  console.log(`PASS stored detection: ${JSON.stringify(stored?.data.spoken_lines)}`)
  const first = await requestVoice(String(player), String(instance), String(event), 'l0')
  assert.equal(first.status, 'queued')
  if (first.status !== 'queued') throw new Error('Unexpected cached throwaway')
  const job = await getMediaQueue().getJob(first.media_id)
  assert.ok(job, 'real BullMQ job was enqueued')
  await processVoice(first.media_id)
  const ready = await requestVoice(String(player), String(instance), String(event), 'l0')
  assert.equal(ready.status, 'ready')
  if (ready.status !== 'ready') throw new Error('Speech did not finish')
  if (useS3) {
    const response = await fetch(ready.url)
    assert.equal(response.status, 200)
    await writeFile(localAudio, Buffer.from(await response.arrayBuffer()))
  }
  const decode = Bun.spawnSync(['ffmpeg', '-v', 'error', '-i', localAudio.pathname, '-f', 'null', '-'], { stdout: 'pipe', stderr: 'pipe' })
  assert.equal(decode.exitCode, 0, decode.stderr.toString())
  assert.ok(ready.duration_ms > 0)
  console.log(`PASS voice ready and ffmpeg decoded: ${ready.duration_ms}ms, submissions=${submissions}`)
  const before = await mongoColl.mediaUsage().countDocuments({ player_id: player })
  const cached = await requestVoice(String(player), String(instance), String(event), 'l0')
  assert.equal(cached.status, 'ready')
  assert.equal(await mongoColl.mediaUsage().countDocuments({ player_id: player }), before)
  assert.equal(submissions, 1)
  console.log(`PASS cached replay reserves nothing: ${before} row before/after`)
  process.env.MEDIA_DAILY_VOICE = '1'
  await assert.rejects(requestVoice(String(player), String(instance), String(event), 'l1'), (error: unknown) => error instanceof HttpError && error.statusCode === 429 && error.details?.status === 'resting')
  console.log(`PASS lowered limit returns 429: ${JSON.stringify(await mediaUsage(player))}`)
  const delivered = await mongoColl.mediaAssets().findOne({ _id: new ObjectId(first.media_id) })
  console.log(`Speech charge: $${delivered?.cost_usd.toFixed(6)}; generation lookup ${delivered?.cost_source === 'catalogue' ? 'unavailable; catalogue estimate retained' : 'actual generation cost'}`)
  await job?.remove()
  code = 0
} catch (error) {
  console.error('Smoke failed:', (error as Error).message)
} finally {
  // All destructive selectors are exact throwaway IDs, never names or broad prefixes.
  await mongoColl.worldInstances().deleteOne({ _id: instance, player_id: player })
  await purgeMedia({ instance_id: instance })
  await mongoColl.events().deleteMany({ instance_id: instance })
  await mongoColl.characters().deleteMany({ instance_id: instance })
  await mongoColl.worldTemplates().deleteOne({ _id: template, creator_id: player })
  await mongoColl.users().deleteOne({ _id: player })
  for (const job of await getMediaQueue().getJobs(['waiting', 'prioritized', 'failed', 'completed'])) {
    if (job?.data?.instanceId === String(instance)) await job.remove()
  }
  console.log(`PASS cleanup by exact save ID ${instance}: ${await mongoColl.worldInstances().countDocuments({ _id: instance })} saves, ${await mongoColl.mediaAssets().countDocuments({ instance_id: instance })} assets, ${await mongoColl.mediaUsage().countDocuments({ instance_id: instance })} usage`)
  console.log(`Cumulative speech exposure $${budget.reserved_usd.toFixed(6)}; submissions this run ${submissions}`)
  process.exit(code)
}
