import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { ObjectId } from 'mongodb'
import { fixture } from './media-audit-fixture'
import { detectSpokenLines } from '../src/services/media/detection'
import { acceptAttribution, attributeEvent, mediaRevision, resolveVoiceSpeaker, attributionEffects } from '../src/services/media/attribution'
import { chooseVoice, filterVoiceTags, isVerbatim, matureVoiceAllowed, utcMediaDay } from '../src/services/media/policy'
import { requestVoice, mediaEffects, processVoice, failMedia, repairMediaReservations } from '../src/services/media/service'
import { reserveMedia, releaseMedia, settleMedia, mediaUsage } from '../src/services/media/usage'
import { purgeMedia } from '../src/services/media/deletion'
import { storageService } from '../src/services/storage.service'
import { publicMediaEvent, wireSpokenLines } from '../src/services/media/events'
import { castCharacter } from '../src/services/media/casting'
import { HttpError } from '../src/utils/http-error'
import type { MediaAssetDoc } from '../src/models/media.model'
import type { WorldEventDoc } from '../src/models/world-event.model'

const checks: Array<[string, () => unknown | Promise<unknown>]> = []
const check = (name: string, fn: () => unknown | Promise<unknown>) => checks.push([name, fn])
const lines = (s: string, player = '') => detectSpokenLines(s, player).map((l) => s.slice(l.start, l.end))
check('apostrophes', () => {
  assert.deepEqual(lines("Don't worry, it's fine. 'tis late."), [])
  assert.deepEqual(lines("‘Don't go now,’ she says."), ['‘Don\'t go now,’'])
})
check('unclosed', () => {
  assert.deepEqual(lines('“Never closed'), [])
  assert.deepEqual(lines('“Never closed\n\n“Still here.”'), ['“Still here.”'])
  assert.deepEqual(lines('A closing ” orphan. “Stay here.”'), ['“Stay here.”'])
})
check('nested', () => {
  assert.deepEqual(lines('“They called it "the end" yesterday.”'), ['“They called it "the end" yesterday.”'])
  assert.deepEqual(lines('"They called it “the end” yesterday."'), ['"They called it “the end” yesterday."'])
  assert.deepEqual(lines('“They called it ‘the end’ yesterday.”'), ['“They called it ‘the end’ yesterday.”'])
})
check('bounds', () => {
  assert.deepEqual(lines('A "hero" walks past.'), [])
  assert.equal(lines(`“${'x '.repeat(201)}”`).length, 0)
  assert.equal(lines(`“${'x '.repeat(200)}”`).length, 1)
  assert.equal(lines('— Come here. *Stay close.*').length, 0)
  assert.equal(lines('“— —”').length, 0)
  const prose = '🌙 “Stay close.”'
  assert.equal(detectSpokenLines(prose)[0].start, 3)
})
check('paragraph', () => assert.deepEqual(lines('"Lost here\n\nnext paragraph."'), []))
check('single_only', () => {
  assert.deepEqual(lines("'Stay close.' Then 'Come along.'"), ["'Stay close.'", "'Come along.'"])
  assert.deepEqual(lines("'Stay close.' Then 'unclosed"), [])
  assert.deepEqual(lines('"Double speech." Then \'Single speech.\''), ['"Double speech."'])
})
check('player_echo', () => {
  assert.deepEqual(lines('“Keep moving.” “Stay here.”', 'Keep moving.'), ['“Stay here.”'])
  assert.deepEqual(lines('“Don’t go now.”', 'Don’t go now.'), [])
})
check('verbatim', () => {
  assert.equal(isVerbatim("I'm fine, she lied, really.", "I'm fine"), true)
  assert.equal(isVerbatim('Stay  close now.', 'Stay\nclose now.'), true)
  assert.equal(isVerbatim('Stay here.', 'Go away.'), false)
  assert.equal(isVerbatim('Stay here.', ''), false)
})
check('speaker', () => {
  const f = fixture()
  assert.equal(resolveVoiceSpeaker('Alias', [f.card], false)?._id.equals(f.character), true)
  assert.equal(resolveVoiceSpeaker('Nobody', [f.card], false), undefined)
  assert.equal(resolveVoiceSpeaker('Alias', [{ ...f.card, is_protagonist: true }], false), undefined)
  assert.equal(resolveVoiceSpeaker('Alias', [f.card], true, 'Alias'), undefined)
  assert.ok(resolveVoiceSpeaker('Alias', [{ ...f.card, is_protagonist: true }], true))
  const line = detectSpokenLines(f.prose)[0]
  assert.equal(acceptAttribution(line, f.prose, { is_speech: true, speaker_name: 'Nobody', spoken_text: 'Come with me.' }, () => undefined).voice?.status, 'unvoiceable')
  assert.equal(acceptAttribution(line, f.prose, { is_speech: true, speaker_name: 'Speaker', spoken_text: 'Invented words.' }, () => f.card).voice?.status, 'unvoiceable')
})
check('tags', () => {
  assert.deepEqual(filterVoiceTags(['[other]', '[whispers]', '[sighs]']), ['[whispers]'])
  assert.deepEqual(filterVoiceTags('[shouting]'), [])
  const f = fixture(), line = detectSpokenLines('“[other] Come here.”')[0]
  assert.equal(acceptAttribution(line, '“[other] Come here.”', { is_speech: true, speaker_name: 'Speaker', spoken_text: '[other] Come here.' }, () => f.card).voice?.status, 'unvoiceable')
})
check('attribution_once', async () => {
  const f = fixture(), event = f.db.events.rows[0] as unknown as WorldEventDoc
  const [a, b] = await Promise.all([attributeEvent(event, false), attributeEvent(event, false)])
  assert.equal(f.calls(), 1); assert.deepEqual(a, b); assert.equal(a[0].voice?.status, 'voiceable')
  const g = fixture(), bad = g.db.events.rows[0] as unknown as WorldEventDoc
  attributionEffects.call = async () => { throw new Error('provider failed') }
  assert.equal((await attributeEvent(bad, false))[0].voice?.status, 'unvoiceable')
  attributionEffects.call = async () => { throw new Error('must never retry') }
  assert.equal((await attributeEvent(bad, false))[0].voice?.status, 'unvoiceable')
})
check('casting', () => {
  assert.equal(chooseVoice({}, []), 'george')
  assert.equal(chooseVoice({}, [{ voice_id: 'george' }]), 'sarah')
  assert.equal(chooseVoice({ gender_presentation: 'female' }, []), 'sarah')
  assert.equal(chooseVoice({ gender_presentation: 'male', age_band: 'young', timbre: 'bright', temperament: 'playful' }, []), 'will')
  assert.equal(chooseVoice({ gender_presentation: 'male' }, [{ voice_id: 'george' }]), 'adam')
})
check('reuse', () => {
  const voices = [
    { id: 'one', traits: { gender_presentation: ['neutral'], age_band: [], timbre: [], temperament: [] } },
    { id: 'two', traits: { gender_presentation: ['neutral'], age_band: [], timbre: [], temperament: [] } },
  ]
  assert.equal(chooseVoice({}, [{ voice_id: 'one', last_spoken_at: new Date(20) }, { voice_id: 'two', last_spoken_at: new Date(10) }], voices), 'two')
  assert.equal(chooseVoice({}, [{ voice_id: 'one', last_spoken_at: new Date(1) }, { voice_id: 'one', last_spoken_at: new Date(30) }, { voice_id: 'two', last_spoken_at: new Date(10) }], voices), 'two')
})
check('cast_persistence', async () => {
  const f = fixture()
  f.db.worldTemplates.rows[0].seed_cast = [{ name: 'Speaker', voice_traits: { gender_presentation: 'female' } }, { name: 'Other' }]
  const voice = await castCharacter(f.db.worldInstances.rows[0] as never, f.card)
  assert.equal(voice.voice_id, 'sarah')
  const stored = f.db.worldTemplates.rows[0].seed_cast as Array<{ voice: { voice_id: string } }>
  assert.equal(stored[0].voice.voice_id, 'sarah'); assert.equal(stored[1].voice, undefined)
  assert.equal((f.db.characters.rows[0].voice as { voice_id: string }).voice_id, 'sarah')
  process.env.MEDIA_VOICE_MODEL = 'unconfigured'
  assert.deepEqual(await castCharacter(f.db.worldInstances.rows[0] as never, f.card), voice)
  delete process.env.MEDIA_VOICE_MODEL
  const g = fixture()
  const assigned = await castCharacter(g.db.worldInstances.rows[0] as never, g.card)
  delete g.db.characters.rows[0].voice
  assert.deepEqual(await castCharacter(g.db.worldInstances.rows[0] as never, g.card), assigned)
  assert.deepEqual(g.db.characters.rows[0].voice, assigned)
})
check('mature', async () => {
  assert.equal(matureVoiceAllowed(true, false), false); assert.equal(matureVoiceAllowed(true, true), true)
  const f = fixture(); f.db.events.rows[0].nsfw_intent = true
  await assert.rejects(requestVoice(String(f.player), String(f.instance), String(f.event), 'l0'), (e: unknown) => e instanceof HttpError && e.statusCode === 422)
  assert.equal(f.db.mediaUsage.inserts, 0); assert.equal(f.calls(), 0)
  const g = fixture(), a = asset(g)
  g.db.events.rows[0].nsfw_intent = true
  g.db.mediaAssets.rows.push(a as unknown as Record<string, unknown>); await reserveMedia(a)
  let submitted = false
  mediaEffects.synthesize = async () => { submitted = true; throw new Error('must not call') }
  await processVoice(String(a._id))
  assert.equal(submitted, false); assert.equal(g.db.mediaUsage.rows[0].status, 'released')
})
check('cache_free', async () => {
  const f = fixture()
  f.db.mediaAssets.rows.push(asset(f, { status: 'ready', url: 'https://example.test/clip.mp3', duration_ms: 500 }) as unknown as Record<string, unknown>)
  const reply = await requestVoice(String(f.player), String(f.instance), String(f.event), 'l0')
  assert.equal(reply.status, 'ready'); assert.equal(f.db.mediaUsage.inserts, 0)
})
check('release', async () => {
  const f = fixture(), a = asset(f)
  assert.equal(await reserveMedia(a), true)
  await failMedia(a)
  assert.equal(f.db.mediaUsage.rows[0].status, 'released'); assert.equal('slot' in f.db.mediaUsage.rows[0], false)
  assert.equal(await reserveMedia(asset(f)), true)
})
check('limit_reset', async () => {
  const f = fixture(), now = new Date('2026-10-16T23:59:59Z')
  const rows = [asset(f), asset(f), asset(f)]
  const results = await Promise.all(rows.map((r) => reserveMedia(r, now)))
  assert.equal(results.filter(Boolean).length, 2)
  assert.equal(await reserveMedia(asset(f), new Date('2026-10-17T00:00:00Z')), true)
  assert.equal(utcMediaDay(now).resets_at, '2026-10-17T00:00:00.000Z')
  await settleMedia(rows[0]._id); await releaseMedia(rows[0]._id)
  assert.equal(f.db.mediaUsage.rows.find((r) => (r._id as ObjectId).equals(rows[0]._id))?.status, 'settled')
  assert.equal((await mediaUsage(f.player, now)).voice && ((await mediaUsage(f.player, now)).voice as { used: number }).used, 2)
})
check('http_limit', async () => {
  const f = fixture(); process.env.MEDIA_DAILY_VOICE = '0'
  await assert.rejects(requestVoice(String(f.player), String(f.instance), String(f.event), 'l0'), (e: unknown) => e instanceof HttpError && e.statusCode === 429 && e.details?.status === 'resting')
  assert.equal(f.db.mediaUsage.inserts, 0)
})
check('auth_switch', async () => {
  const f = fixture()
  await assert.rejects(requestVoice(String(new ObjectId()), String(f.instance), String(f.event), 'l0'), (e: unknown) => e instanceof HttpError && e.statusCode === 404)
  process.env.MEDIA_ENABLED = 'false'
  await assert.rejects(requestVoice(String(f.player), String(f.instance), String(f.event), 'l0'), (e: unknown) => e instanceof HttpError && e.statusCode === 404)
  assert.equal(f.calls(), 0)
  process.env.MEDIA_ENABLED = 'true'; process.env.MEDIA_VOICE_ENABLED = 'false'
  await assert.rejects(requestVoice(String(f.player), String(f.instance), String(f.event), 'l0'), (e: unknown) => e instanceof HttpError && e.statusCode === 404)
})
check('wire_switch', () => {
  // Contract §6: switched off, no spoken lines reach the app, so nothing looks tappable.
  const prior = { enabled: process.env.MEDIA_ENABLED, voice: process.env.MEDIA_VOICE_ENABLED }
  const lines = [{ line_id: 'l0', start: 0, end: 12 }]
  const event = () => ({ data: { ai_response: '"Hold the line," she said.', spoken_lines: lines }, edit_history: [] }) as unknown as WorldEventDoc
  try {
    process.env.MEDIA_ENABLED = 'false'
    assert.equal(wireSpokenLines(lines), undefined)
    assert.equal(publicMediaEvent(event()).data.spoken_lines, undefined)
    process.env.MEDIA_ENABLED = 'true'; process.env.MEDIA_VOICE_ENABLED = 'false'
    assert.equal(wireSpokenLines(lines), undefined)
    process.env.MEDIA_VOICE_ENABLED = 'true'
    assert.deepEqual(wireSpokenLines(lines), lines)
    assert.deepEqual(publicMediaEvent(event()).data.spoken_lines, lines)
  } finally {
    process.env.MEDIA_ENABLED = prior.enabled; process.env.MEDIA_VOICE_ENABLED = prior.voice
  }
})
check('delivery', async () => {
  const f = fixture(), a = asset(f); f.db.mediaAssets.rows.push(a as unknown as Record<string, unknown>); await reserveMedia(a)
  let submitted = 0, notified = 0
  mediaEffects.synthesize = async () => { submitted++; return { data: mp3(), contentType: 'audio/mpeg', generationId: 'generation' } }
  mediaEffects.upload = async (_data, _type, opts) => ({ key: opts?.key || '', url: 'https://example.test/clip.mp3' })
  mediaEffects.cost = async () => 0.0005
  mediaEffects.publish = async (_player, message) => { if (message.type === 'media_ready') notified++ }
  await processVoice(String(a._id)); await processVoice(String(a._id))
  assert.equal(submitted, 1); assert.equal(notified, 1)
  assert.equal(f.db.mediaAssets.rows[0].status, 'ready'); assert.equal(f.db.mediaAssets.rows[0].cost_usd, 0.0005)
  assert.equal(f.db.mediaUsage.rows[0].status, 'settled')
  const g = fixture(), b = asset(g); g.db.mediaAssets.rows.push(b as unknown as Record<string, unknown>); await reserveMedia(b)
  mediaEffects.synthesize = async () => ({ data: mp3(), contentType: 'audio/mpeg', generationId: null })
  mediaEffects.upload = async (_data, _type, opts) => ({ key: opts?.key || '', url: 'https://example.test/clip.mp3' })
  mediaEffects.publish = async () => { throw new Error('pubsub outage') }
  await processVoice(String(b._id))
  assert.equal(g.db.mediaAssets.rows[0].status, 'ready')
  let repaired = false
  mediaEffects.publish = async () => { repaired = true }
  await repairMediaReservations()
  assert.equal(repaired, true)
})
check('provider_failure', async () => {
  const f = fixture(), a = asset(f); f.db.mediaAssets.rows.push(a as unknown as Record<string, unknown>); await reserveMedia(a)
  let submitted = 0
  mediaEffects.synthesize = async () => { submitted++; throw new Error('provider') }
  await processVoice(String(a._id)); await processVoice(String(a._id))
  assert.equal(submitted, 1); assert.equal(f.db.mediaUsage.rows[0].status, 'released')
})
check('late_result', async () => {
  const f = fixture(), a = asset(f); f.db.mediaAssets.rows.push(a as unknown as Record<string, unknown>); await reserveMedia(a)
  let deleted = 0
  mediaEffects.synthesize = async () => ({ data: mp3(), contentType: 'audio/mpeg', generationId: null })
  mediaEffects.upload = async (_data, _type, opts) => { await f.db.mediaAssets.deleteMany({ event_id: f.event }); return { key: opts?.key || '', url: 'https://example.test/clip.mp3' } }
  mediaEffects.remove = async () => { deleted++ }
  await processVoice(String(a._id))
  assert.equal(deleted, 1); assert.equal(f.db.mediaAssets.rows.length, 0)
})
check('repair', async () => {
  const f = fixture(), a = asset(f, { created_at: new Date(0), status: 'processing' }); f.db.mediaAssets.rows.push(a as unknown as Record<string, unknown>); await reserveMedia(a)
  await repairMediaReservations()
  assert.equal(f.db.mediaUsage.rows[0].status, 'released'); assert.equal(f.db.mediaAssets.rows[0].status, 'failed')
})
check('deletion', async () => {
  const f = fixture(), a = asset(f, { asset_key: 'media/voice/clip.mp3' }); f.db.mediaAssets.rows.push(a as unknown as Record<string, unknown>); await reserveMedia(a)
  let removed = ''
  storageService.deleteStrict = async (key) => { removed = key }
  await purgeMedia({ event_id: f.event })
  assert.equal(removed, a.asset_key); assert.equal(f.db.mediaAssets.rows.length, 0); assert.equal(f.db.mediaUsage.rows.length, 0)
  const deletion = readFileSync('src/services/deletion.service.ts', 'utf8'), memory = readFileSync('src/services/memory.service.ts', 'utf8')
  assert.ok(deletion.includes('await purgeMedia({ instance_id: instanceId })'))
  assert.ok(deletion.includes('await purgeMedia({ player_id: pid })'))
  assert.ok(deletion.includes('await this.deleteInstanceById(instance._id)'))
  assert.ok(memory.includes('await purgeMedia({ instance_id: iid, event_id: { $in: doomedIds } })'))
})
check('revisions_payload', () => {
  const f = fixture(), event = f.db.events.rows[0] as unknown as WorldEventDoc
  event.data.spoken_lines![0].voice = { status: 'voiceable', speaker_name: 'Speaker', character_id: String(f.character), spoken_text: 'Come with me.', tags: [] }
  assert.equal(publicMediaEvent(event).data.spoken_lines![0].voice, undefined)
  assert.equal(mediaRevision(f.prose, 'a') === mediaRevision(f.prose, 'b'), false)
  const source = readFileSync('src/services/memory.service.ts', 'utf8')
  assert.equal((source.match(/\.\.\.spokenLineUpdate\(/g) || []).length, 3)
  assert.ok(readFileSync('worker/processors/generation.processor.ts', 'utf8').includes('spoken_lines: detectSpokenLines(parsed.narrative, storedPlayerSpokenInput)'))
})
function asset(f: ReturnType<typeof fixture>, extra: Partial<MediaAssetDoc> = {}): MediaAssetDoc {
  return { _id: new ObjectId(), player_id: f.player, instance_id: f.instance, event_id: f.event, character_id: f.character,
    kind: 'voice', line_id: 'l0', source: 'generated', model: 'elevenlabs/eleven-v4-turbo', voice_id: 'george',
    cache_key: `${f.event}:l0:george:elevenlabs/eleven-v4-turbo`, revision: f.revision, input: 'Come with me.', cost_usd: 0.00026, status: 'queued', created_at: new Date(), ...extra }
}
function mp3() { const frame = Buffer.alloc(417); frame.writeUInt32BE(0xfffb9000); return frame }
if (process.argv.includes('--check') && !checks.some(([name]) => name === process.argv[process.argv.indexOf('--check') + 1])) throw new Error('Unknown audit check')
let failures = 0
for (const [name, fn] of checks) {
  if (process.argv.includes('--check') && process.argv[process.argv.indexOf('--check') + 1] !== name) continue
  try { await fn(); console.log(`PASS ${name}`) } catch (error) { failures++; console.error(`FAIL ${name}:`, (error as Error).message) }
}
console.log(`media audit: ${failures ? `${failures} FAILED` : 'ALL GREEN'}`)
process.exit(failures ? 1 : 0)
