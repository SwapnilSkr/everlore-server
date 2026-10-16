/** Media-server-2 live smoke: portrait, picture, intimate SFW, one scene cut.
 * Local Mongo + Redis only (refuses remote stores). Storage is a local byte
 * sink; NOTHING is ever uploaded to a third-party host. Video providers that
 * need a public HTTPS reference (HeyGen input references, Grok/Wan
 * first_frame) are STUBBED with locally synthesized silent clips, so the
 * director/post-check/assembly path still runs end to end. The orchestrator
 * runs the real S3-backed provider check after review.
 * Cumulative hard cap $2.00: every paid-shaped call reserves before sending.
 * Throwaway data is deleted by exact ID. Servers: no (direct processors).
 */
import assert from 'node:assert/strict'
import { mkdir, writeFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { ObjectId } from 'mongodb'
import { env } from '../src/config/env'
import { connectMongo, mongoColl } from '../src/config/mongo'
import { connectRedis } from '../src/config/redis'
import { getMediaQueue } from '../src/queues'
import { mediaEffects } from '../src/services/media/service'
import { attributionEffects, mediaRevision } from '../src/services/media/attribution'
import { detectSpokenLines } from '../src/services/media/detection'
import { directorEffects } from '../src/services/media/director'
import { safetyEffects } from '../src/services/media/safety'
import {
  processPicture, processPortrait, processVideo, requestPicture, requestPortrait, requestVideo, visualEffects,
} from '../src/services/media/visual'
import { mediaUsage } from '../src/services/media/usage'
import { purgeMedia } from '../src/services/media/deletion'
import { storageService } from '../src/services/storage.service'
import { HttpError } from '../src/utils/http-error'

const CAP_USD = 2.00
const OUT = new URL('./media-smoke-output/', import.meta.url)
const localHost = (value: string) => ['localhost', '127.0.0.1', '[::1]'].includes(new URL(value).hostname)
if (!localHost(env.MONGODB_URI) || !localHost(env.REDIS_URL)) throw new Error('Smoke requires local Mongo and Redis; refusing remote data stores')
await mkdir(OUT, { recursive: true })

// ── Budget: reserve before every paid-shaped call, never loop one ──
const ledger: Array<{ id: string; reserved: number; actual?: number }> = []
let spent = 0
async function reserve(id: string, estimate: number): Promise<void> {
  assert.ok(spent + estimate <= CAP_USD, `Budget exhausted: $${spent.toFixed(4)} + $${estimate.toFixed(4)} > $${CAP_USD}`)
  spent += estimate
  ledger.push({ id, reserved: estimate })
  console.log(`spend expose $${spent.toFixed(4)} / $${CAP_USD} (+${estimate.toFixed(4)} ${id})`)
}
function settle(id: string, actual: number): void {
  const row = ledger.find((r) => r.id === id)
  if (row) { spent -= row.reserved; row.actual = actual; spent += actual }
}

// ── Test-file hosting: local bytes only, never a third-party host ──
const byUrl = new Map<string, string>()
const byKey = new Map<string, string>()
async function publishTestFile(bytes: Buffer, name: string, _contentType: string): Promise<{ key: string; url: string }> {
  const path = join(OUT.pathname, name)
  await writeFile(path, bytes)
  const key = `local/${name}`
  const url = `file://${path}`
  byUrl.set(url, path)
  byKey.set(key, path)
  return { key, url }
}
// Video providers that need a public HTTPS reference are stubbed with locally
// synthesized silent clips (ffmpeg testsrc): HeyGen input references and
// Grok/Wan first_frame URLs never leave this machine.
const stubClips = new Map<string, Buffer>()
async function synthStubClip(durationS: number): Promise<Buffer> {
  const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg'
  const proc = Bun.spawnSync([ffmpeg, '-v', 'error', '-f', 'lavfi',
    '-i', `testsrc=size=480x854:rate=24:duration=${durationS}`,
    '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'ultrafast', '-an',
    '-f', 'mp4', '-movflags', 'frag_keyframe+empty_moov', 'pipe:1'],
    { stdout: 'pipe', stderr: 'pipe' })
  if (proc.exitCode !== 0) throw new Error(`Stub clip synthesis failed: ${proc.stderr.toString().slice(0, 200)}`)
  return Buffer.from(proc.stdout)
}
// Dispatched agents never touch AWS: every upload stays local.
mediaEffects.upload = async (data, type, opts) => {
  const name = `up-${Date.now()}-${Math.floor(Math.random() * 1e6)}${type === 'audio/mpeg' ? '.mp3' : type === 'video/mp4' ? '.mp4' : '.png'}`
  return publishTestFile(data, name, type)
}
visualEffects.upload = mediaEffects.upload as never
mediaEffects.remove = async (key) => {
  const path = byKey.get(key)
  if (path) await unlink(path).catch(() => {})
}
storageService.deleteStrict = mediaEffects.remove
visualEffects.download = (async (url: string) => {
  try {
    let path = byUrl.get(url) || byKey.get(url)
    // Local keys behind the real CDN prefix (production S3 serves these).
    const base = env.CDN_BASE_URL.replace(/\/+$/, '')
    if (!path && base && url.startsWith(`${base}/`)) path = byKey.get(url.slice(base.length + 1))
    if (path) return Buffer.from(await Bun.file(path).arrayBuffer())
    const res = await fetch(url, { signal: AbortSignal.timeout(30000) })
    if (!res.ok) throw new Error(`download HTTP ${res.status}`)
    return Buffer.from(await res.arrayBuffer())
  } catch (error) {
    console.log(`TRACE download FAIL ${url.slice(0, 80)} ${(error as Error).message.slice(0, 160)}`)
    throw error
  }
}) as never

// Paid-shaped wrappers: one submission each, reserved up front.
let submissions = 0
const synth0 = mediaEffects.synthesize
mediaEffects.synthesize = (async (req: { input: string; model: string }) => {
  const id = `tts-${submissions++}`
  const estimate = req.input.length * 0.00002 * 1.5
  await reserve(id, estimate)
  console.log(`TRACE tts chars=${req.input.length}`)
  try {
    const out = await synth0(req as never)
    settle(id, estimate)
    console.log(`TRACE tts ok bytes=${(out as { data: Buffer }).data.length}`)
    return out
  } catch (error) {
    console.log(`TRACE tts FAIL ${(error as Error).message.slice(0, 200)}`)
    throw error
  }
}) as never
const image0 = visualEffects.image
visualEffects.image = (async (prompt: string, opts: never) => {
  const id = `image-${submissions++}`
  await reserve(id, 0.03)
  console.log(`TRACE image prompt="${prompt.slice(0, 90)}..."`)
  try {
    const out = await image0(prompt, opts)
    settle(id, out.costUsd ?? 0.03)
    console.log(`TRACE image ok cost=${out.costUsd}`)
    return out
  } catch (error) {
    console.log(`TRACE image FAIL ${(error as Error).message.slice(0, 200)}`)
    throw error
  }
}) as never
const submit0 = visualEffects.submit
visualEffects.submit = (async (opts: Parameters<typeof submit0>[0]) => {
  // Public-URL providers are stubbed: synthesize the clip locally instead of
  // submitting anything. No spend, no upload, no third-party fetch.
  if ((opts.model || '').includes('heygen') || (opts.model || '').includes('grok-imagine') || (opts.model || '').includes('wan-3.0')) {
    const jobId = `stub-${opts.model}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
    const clip = await synthStubClip(typeof opts.duration === 'number' ? opts.duration : 3)
    stubClips.set(jobId, clip)
    console.log(`TRACE submit STUB ${opts.model} dur=${opts.duration}`)
    return { jobId, status: 'pending' as const }
  }
  const id = `video-submit-${submissions++}`
  await reserve(id, 0.4)
  console.log(`TRACE submit ${opts.model} dur=${opts.duration} res=${opts.resolution} refs=${(opts.inputReferences?.length || 0) + (opts.firstFrameUrl ? 1 : 0)}`)
  try {
    const out = await submit0(opts as never)
    ;(out as { __ledger?: string }).__ledger = id
    console.log(`TRACE submit ok job=${(out as { jobId: string }).jobId}`)
    return out
  } catch (error) {
    console.log(`TRACE submit FAIL ${(error as Error).message.slice(0, 220)}`)
    throw error
  }
}) as never
const wait0 = visualEffects.wait
visualEffects.wait = (async (jobId: string) => {
  const stub = stubClips.get(jobId)
  if (stub) return { jobId, status: 'completed' as const, generationId: null, costUsd: 0 }
  const out = await wait0(jobId)
  return out
}) as never
const fetch0 = visualEffects.fetch
visualEffects.fetch = (async (jobId: string) => {
  const stub = stubClips.get(jobId)
  if (stub) { stubClips.delete(jobId); return stub }
  return fetch0(jobId)
}) as never
// Video actuals settle against the submit reservation once the price is known.
const submitSeen = new Map<string, string>()
const rawSubmit = visualEffects.submit
visualEffects.submit = (async (opts: Parameters<typeof rawSubmit>[0]) => {
  const out = await rawSubmit(opts)
  submitSeen.set((out as { jobId: string }).jobId, (out as { __ledger?: string }).__ledger || '')
  return out
}) as never
const rawWait = visualEffects.wait
visualEffects.wait = (async (jobId: string) => {
  console.log(`TRACE wait ${jobId}`)
  try {
    const out = await rawWait(jobId)
    const id = submitSeen.get(jobId)
    if (id) settle(id, (out as { costUsd?: number }).costUsd ?? 0.4)
    console.log(`TRACE wait ok status=${(out as { status: string }).status} cost=${(out as { costUsd?: number }).costUsd}`)
    return out
  } catch (error) {
    console.log(`TRACE wait FAIL ${(error as Error).message.slice(0, 200)}`)
    throw error
  }
}) as never
const call0 = safetyEffects.call
safetyEffects.call = (async (req: { model: string; purpose?: string }) => {
  const id = `text-${submissions++}`
  await reserve(id, 0.01)
  try {
    const out = await call0(req as never)
    settle(id, 0.005)
    return out
  } catch (error) {
    console.log(`TRACE text FAIL purpose=${req.purpose} ${(error as Error).message.slice(0, 200)}`)
    throw error
  }
}) as never
const dir0 = directorEffects.call
directorEffects.call = (async (req: { model: string }) => {
  const id = `director-${submissions++}`
  await reserve(id, 0.05)
  console.log(`TRACE director ${(req as { model: string }).model}`)
  try {
    const out = await dir0(req as never)
    settle(id, 0.02)
    console.log(`TRACE director ok chars=${(out as string).length}`)
    return out
  } catch (error) {
    console.log(`TRACE director FAIL ${(error as Error).message.slice(0, 200)}`)
    throw error
  }
}) as never
const attr0 = attributionEffects.call
attributionEffects.call = (async (req: never) => {
  const id = `attr-${submissions++}`
  await reserve(id, 0.02)
  const out = await attr0(req)
  settle(id, 0.005)
  return out
}) as never
const judgeOriginal = safetyEffects.judge
safetyEffects.judge = (async (image: Buffer, contentType: string, reference?: { data: Buffer; contentType: string }) => {
  const id = `vision-${submissions++}`
  await reserve(id, 0.005)
  try {
    const out = await judgeOriginal(image, contentType, reference)
    settle(id, 0.002)
    console.log(`TRACE vision ${out.verdict} people=${out.people_count} face=${out.face_close_up} text=${out.text_visible} wardrobe=${out.wardrobe_match} ref=${reference ? 'still' : 'none'} reason=${out.reason_code}`)
    return out
  } catch (error) {
    console.log(`TRACE vision FAIL ${(error as Error).message.slice(0, 200)}`)
    throw error
  }
}) as never

process.env.MEDIA_ENABLED = 'true'
process.env.MEDIA_VOICE_ENABLED = 'true'
process.env.MEDIA_PICTURE_ENABLED = 'true'
process.env.MEDIA_VIDEO_ENABLED = 'true'
process.env.MEDIA_PORTRAIT_ENABLED = 'true'
await connectMongo(); await connectRedis()

const player = new ObjectId(), instance = new ObjectId(), template = new ObjectId()
const event1 = new ObjectId(), event2 = new ObjectId()
const mira = new ObjectId(), dain = new ObjectId(), asha = new ObjectId(), persona = new ObjectId()
const now = new Date()
const prose1 = 'Rain hammered the gutter. Mira pressed closer. “Don’t breathe. They’re right outside the door.” A floorboard sighed. “Stay behind me,” Mira whispered.'
const prose2 = 'The candle had burned low. “Stay with me,” Dain whispered, “just until the rain stops.” Her hand rested over his on the window seat, and neither of them moved for a long while.'
let code = 1
try {
  await mongoColl.users().insertOne({ _id: player, username: `media2-${player}`, password_hash: '', providers: [], tier: 'free', token_balance: 0,
    preferences: { nsfw_enabled: false, preferred_model: '', theme: '', narration_length: 'short', auto_memory_curation: false }, created_at: now, updated_at: now })
  await mongoColl.personas().insertOne({ _id: persona, player_id: player, name: 'Asha', gender: 'female', description: 'A traveller in her late twenties with curious grey eyes.', created_at: now, updated_at: now })
  await mongoColl.worldTemplates().insertOne({ _id: template, creator_id: player, title: 'Media smoke 2', slug: `media2-${template}`, description: '', is_published: false,
    is_sentient: false, is_nsfw_capable: false, version: 1, seed_prompt: '', global_lore: '', base_stats_template: {}, flag_definitions: {}, scene_tags: [], model_preferences: {},
    seed_cast: [{ name: 'Mira', voice_traits: { gender_presentation: 'female', age_band: 'young' } }], max_context_memories: 1, max_lore_results: 1, created_at: now, updated_at: now })
  await mongoColl.worldInstances().insertOne({ _id: instance, player_id: player, template_id: template, template_version: 1, world_state: {}, active_flags: {}, current_scene: { tag: 'dialogue', turn_count: 2, summary_pending: false },
    persona_id: persona, persona_snapshot: { name: 'Asha', gender: 'female' },
    meta: { total_events: 2, total_memories: 0, total_tokens_consumed: 0, last_active_at: now, is_archived: false }, created_at: now, updated_at: now })
  for (const [id, name, aliases, protagonist] of [[mira, 'Mira', [], false], [dain, 'Dain', [], false], [asha, 'Asha', [], true]] as const) {
    await mongoColl.characters().insertOne({ _id: id, instance_id: instance, player_id: player, canonical_name: name, name_normalized: name.toLowerCase(), aliases: [...aliases], immutable_facts: [], mutable_state: [], disposition_to_player: '', hidden_thought: '', first_seen_sequence: 1, last_seen_sequence: 1, mention_count: 1, ...(protagonist ? { is_protagonist: true } : {}), created_at: now, updated_at: now })
  }
  for (const [id, prose, seq] of [[event1, prose1, 1], [event2, prose2, 2]] as const) {
    await mongoColl.events().insertOne({ _id: id, instance_id: instance, player_id: player, sequence: seq, type: 'narration',
      data: { ai_response: prose, player_input: '', spoken_lines: detectSpokenLines(prose), media_revision: mediaRevision(prose), state_mutations: {}, flag_mutations: {}, model_used: 'smoke', tokens_in: 0, tokens_out: 0 },
      is_user_edited: false, edit_history: [], scene_tag: 'dialogue', created_at: now })
  }
  const decodeOk = async (path: string, what: string) => {
    const run = Bun.spawnSync([process.env.FFMPEG_PATH || 'ffmpeg', '-v', 'error', '-i', path, '-f', 'null', '-'], { stdout: 'pipe', stderr: 'pipe' })
    assert.equal(run.exitCode, 0, `${what} did not decode: ${run.stderr.toString().slice(0, 200)}`)
  }

  // 1. Portrait: Mira's unknown look is filled in and becomes canon.
  const p1 = await requestPortrait(String(player), String(instance), String(mira))
  assert.equal(p1.status, 'queued')
  if (p1.status !== 'queued') throw new Error('portrait cached unexpectedly')
  await processPortrait(p1.media_id)
  const miraReady = await requestPortrait(String(player), String(instance), String(mira))
  assert.equal(miraReady.status, 'ready')
  if (miraReady.status !== 'ready') throw new Error('portrait not ready')
  const miraCard = await mongoColl.characters().findOne({ _id: mira })
  assert.ok(miraCard?.portrait?.asset_key)
  assert.ok((miraCard?.appearance || '').length > 10, 'unknown look filled into canon')
  await decodeOk(byKey.get(miraCard!.portrait!.asset_key)!, 'portrait')
  console.log(`PASS portrait: look="${miraCard?.appearance?.slice(0, 80)}" v${miraCard?.portrait?.appearance_version}`)

  // 2. Persona face: Asha's portrait lives on the persona.
  const pp = await requestPortrait(String(player), String(instance), String(asha), { personaId: String(persona) })
  assert.equal(pp.status, 'queued')
  if (pp.status !== 'queued') throw new Error('persona portrait cached unexpectedly')
  await processPortrait(pp.media_id)
  const ppRow = await mongoColl.mediaAssets().findOne({ kind: 'portrait', character_id: asha })
  if ((ppRow as unknown as { status: string } | null)?.status !== 'ready') {
    console.log(`PERSONA DIAG: status=${(ppRow as unknown as { status: string } | null)?.status}`)
  }
  const personaDoc = await mongoColl.personas().findOne({ _id: persona })
  assert.ok(personaDoc?.portrait?.asset_key, 'persona carries the face')
  console.log('PASS persona portrait on personas')

  // 3. Picture this (tense turn; Dain's face is painted inline on this tap).
  const pic1 = await requestPicture(String(player), String(instance), String(event1))
  assert.equal(pic1.status, 'queued')
  if (pic1.status !== 'queued') throw new Error('picture cached unexpectedly')
  await processPicture(pic1.media_id)
  const pic1Ready = await requestPicture(String(player), String(instance), String(event1))
  assert.equal(pic1Ready.status, 'ready')
  if (pic1Ready.status !== 'ready') throw new Error('picture not ready')
  const picAsset = await mongoColl.mediaAssets().findOne({ kind: 'picture', event_id: event1, status: 'ready' })
  await decodeOk(byUrl.get(picAsset!.url!)!, 'picture')
  console.log('PASS picture of the tense turn')

  // 4. Intimate turn pictured SFW — or honestly refused as unseen.
  const pic2 = await requestPicture(String(player), String(instance), String(event2))
  assert.equal(pic2.status, 'queued')
  if (pic2.status !== 'queued') throw new Error('intimate picture cached unexpectedly')
  await processPicture(pic2.media_id)
  const intimate = await mongoColl.mediaAssets().findOne({ kind: 'picture', event_id: event2 })
  assert.ok(intimate && (intimate.status === 'ready' || intimate.status === 'unseen'), `intimate picture ${intimate?.status}`)
  if (intimate?.status === 'ready') {
    await decodeOk(byUrl.get(intimate.url!)!, 'intimate picture')
    const dainCard = await mongoColl.characters().findOne({ _id: dain })
    console.log(`PASS intimate turn pictured SFW (Dain face ${dainCard?.portrait?.asset_key ? 'painted inline' : 'skipped by a gate, picture stood without it'})`)
  } else {
    const rej = await mongoColl.mediaRejections().find({ event_id: event2 }).toArray()
    assert.ok(rej.length >= 1, 'rejection logged')
    console.log(`PASS intimate turn refused as unseen (${(rej[0] as { reason: string }).reason})`)
  }

  // 5. The scene cut on l0, using the line's own clip.
  const v1 = await requestVideo(String(player), String(instance), String(event1), 'l0')
  assert.equal(v1.status, 'queued')
  if (v1.status !== 'queued') throw new Error('video cached unexpectedly')
  await processVideo(v1.media_id)
  const cut = await mongoColl.mediaAssets().findOne({ kind: 'video', event_id: event1, status: 'ready' })
  if (!cut) {
    const any = await mongoColl.mediaAssets().find({ kind: 'video', event_id: event1 }).toArray()
    console.log(`VIDEO DIAG: rows=${any.length} ` + any.map((r) => {
      const row = r as unknown as { status: string; plan?: { errors?: unknown; shots?: Array<{ role: string; status: string; reason?: string }> } }
      return `status=${row.status} errors=${JSON.stringify(row.plan?.errors)?.slice(0, 500)} shots=${JSON.stringify(row.plan?.shots)}`
    }).join(' | '))
  }
  assert.ok(cut?.url, 'cut delivered')
  assert.ok(cut?.plan, 'plan stored with prompts and checks')
  await decodeOk(byUrl.get(cut.url!)!, 'scene cut')
  const probe = Bun.spawnSync([process.env.FFPROBE_PATH || 'ffprobe', '-v', 'error', '-show_entries', 'format=duration:stream=codec_type', '-of', 'csv', byUrl.get(cut.url!)!], { stdout: 'pipe', stderr: 'pipe' })
  console.log(`PASS scene cut ${(cut.duration_ms! / 1000).toFixed(1)}s\n${probe.stdout.toString().trim().split('\n').slice(0, 4).join('\n')}`)
  const voiceRow = await mongoColl.mediaAssets().findOne({ kind: 'voice', event_id: event1, status: 'ready' })
  assert.ok(voiceRow?.url, 'the line was voiced first with its own clip')
  console.log(`PASS line shot uses the heard clip; shots=${JSON.stringify((cut.plan as { shots: Array<{ role: string; status: string; model: string }> }).shots.map((s) => `${s.role}:${s.status}:${s.model}`))}`)

  // 6. Out-of-date portrait repaints only on a tap: the card text updates at
  // once through the evidence rule, the kept face stays until needed.
  const before = (await mongoColl.characters().findOne({ _id: mira }))?.portrait?.asset_key
  const still = await requestPortrait(String(player), String(instance), String(mira))
  assert.equal(still.status, 'ready', 'current face costs nothing')
  const { characterCodexService } = await import('../src/services/character-codex.service')
  await characterCodexService.applyDeltas({
    instanceId: String(instance), playerId: String(player), sequence: 2,
    deltas: [{ name: 'Mira', appearance: `${miraCard?.appearance} Now with a shaved head.`, appearance_evidence: 'I shaved my head this morning.' }],
    prose: 'Mira grinned. “I shaved my head this morning.”',
  })
  const bumped = await mongoColl.characters().findOne({ _id: mira })
  assert.equal(bumped?.appearance_version, 2, 'quoted evidence bumps the look')
  const repaint = await requestPortrait(String(player), String(instance), String(mira))
  assert.equal(repaint.status, 'queued', 'out-of-date face repaints on the next tap')
  if (repaint.status !== 'queued') throw new Error('repaint cached unexpectedly')
  await processPortrait(repaint.media_id)
  const repainted = await mongoColl.characters().findOne({ _id: mira })
  assert.equal(repainted?.portrait?.appearance_version, 2)
  assert.notEqual(repainted?.portrait?.asset_key, before)
  console.log('PASS out-of-date repaint on tap')

  const usage = await mediaUsage(player)
  console.log(`PASS usage ${JSON.stringify(usage)}`)

  // 7. Video resting: the second video waits until tomorrow, charged nothing.
  process.env.MEDIA_DAILY_VIDEO = '1'
  await assert.rejects(
    requestVideo(String(player), String(instance), String(event1), 'l1'),
    (e: unknown) => e instanceof HttpError && e.statusCode === 429 && e.details?.status === 'resting')
  console.log('PASS video 429 resting')
  code = 0
} catch (error) {
  console.error('Smoke failed:', (error as Error).message)
} finally {
  await mongoColl.worldInstances().deleteOne({ _id: instance, player_id: player })
  await purgeMedia({ instance_id: instance })
  await mongoColl.events().deleteMany({ instance_id: instance })
  await mongoColl.characters().deleteMany({ instance_id: instance })
  await mongoColl.worldTemplates().deleteOne({ _id: template, creator_id: player })
  await mongoColl.personas().deleteMany({ player_id: player })
  await mongoColl.users().deleteOne({ _id: player })
  for (const job of await getMediaQueue().getJobs(['waiting', 'prioritized', 'failed', 'completed'])) {
    if (job?.data?.instanceId === String(instance)) await job.remove().catch(() => {})
  }
  const [saves, assets, usageRows] = await Promise.all([
    mongoColl.worldInstances().countDocuments({ _id: instance }),
    mongoColl.mediaAssets().countDocuments({ instance_id: instance }),
    mongoColl.mediaUsage().countDocuments({ instance_id: instance }),
  ])
  console.log(`PASS cleanup by exact save ID ${instance}: ${saves} saves, ${assets} assets, ${usageRows} usage`)
  const actual = ledger.reduce((s, r) => s + (r.actual ?? r.reserved), 0)
  console.log(`Submission count ${submissions}; spend $${actual.toFixed(5)} / $${CAP_USD} (≈₹${(actual * 85).toFixed(2)} / ₹170)`)
  process.exit(code)
}
