import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { ObjectId } from 'mongodb'
import { fixture, readAuditSource as readFileSync } from './media-audit-fixture'
import { detectSpokenLines } from '../src/services/media/detection'
import { acceptAttribution, attributeEvent, attributionRows, mediaRevision, resolveVoiceSpeaker, attributionEffects } from '../src/services/media/attribution'
import { chooseVoice, filterVoiceTags, filterVoiceTraits, isVerbatim, matureVoiceAllowed, traitsVoiceable, utcMediaDay } from '../src/services/media/policy'
import { requestVoice, mediaEffects, processVoice, failMedia, repairMediaReservations } from '../src/services/media/service'
import { isReferenceAllowed, resolvePortraitHolder, personaFaceForStyle, styleOfPortrait } from '../src/services/media/portraits'
import { makeSceneShot, processPicture, processPortrait, processVideo, ensurePortraitReady, requestPicture, requestPersonaPortrait, requestPortrait, requestVideo, visualEffects, portraitImagePrompt, pictureImagePrompt } from '../src/services/media/visual'
import { checkImage, judgeShotFrames, moderateDescription, safetyEffects, describeMoment, MEDIA_VISUAL_POLICY, buildSafetyPrompts, visualPolicyLine } from '../src/services/media/safety'
import { buildCutGraph, cutEffects } from '../src/services/media/cut'
import { compileLinePrompt, compileMotionPrompt, compileStillPrompt } from '../src/services/media/scene-templates'
import { directScene, directorEffects, validateDirectorPlan, DIRECTOR_SYSTEM_PROMPT, type DirectorInput } from '../src/services/media/director'
import { foldDelta, newFoldState } from '../src/services/character-codex.service'
import { purgeCardPortraits, purgeTemplatePortraits } from '../src/services/media/deletion'
import { reserveMedia, releaseMedia, settleMedia, mediaUsage } from '../src/services/media/usage'
import { purgeMedia } from '../src/services/media/deletion'
import { storageService } from '../src/services/storage.service'
import { publicMediaEvent, wireSpokenLines } from '../src/services/media/events'
import { generateMediaImage } from '../src/services/media/image'
import { imageSafetyTolerance } from '../src/services/media/config'
import { asMediaImageReference, imageExtensionFor, sniffImageContentType, ProviderRefusalError } from '../src/ai/image'
import { submitVideo } from '../src/ai/video'
import { env } from '../src/config/env'
import { castCharacter } from '../src/services/media/casting'
import { COMPOSITION, DEFAULT_HINT, PAINTED_RENDER, PAINTED_STYLE_KEY, STYLE_HINT, decorateImagePrompt, resolveMediaStyle, stripServerDecorations, templateMediaStyle } from '../src/services/image.service'
import { HttpError } from '../src/utils/http-error'
import type { MediaAssetDoc } from '../src/models/media.model'
import type { WorldEventDoc } from '../src/models/world-event.model'

const realFrameJudge = safetyEffects.judge

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
check('schema_echo', () => {
  const rows = [{ line_id: 'l0', is_speech: true, speaker_name: 'Mara', spoken_text: 'Hold on', tags: [] }]
  assert.deepEqual(attributionRows({ lines: rows }), rows)
  assert.deepEqual(attributionRows({ type: 'object', properties: { lines: rows } }), rows)
  assert.deepEqual(attributionRows({ type: 'object', properties: {} }), [])
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
  await failMedia(a, { stage: 'test', message: 'test release' })
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
function portraitRow(f: ReturnType<typeof fixture>, extra: Partial<MediaAssetDoc> = {}): MediaAssetDoc {
  return { _id: new ObjectId(), player_id: f.player, instance_id: f.instance, character_id: f.character,
    kind: 'portrait', line_id: '', source: 'generated', model: 'black-forest-labs/flux-3-image-klein',
    cache_key: `portrait:${f.character}:v1:flux`, revision: 'r', input: 'Grey eyes, dark braids.', cost_usd: 0.009, status: 'queued', created_at: new Date(), ...extra }
}
// Fixture bytes with real magic: Flux 3 Klein returns JPEG, kept portraits are
// PNG. Downloads model the kept (PNG) face; generations model the new (JPEG) one.
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00])
const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x00])
const WEBP_BYTES = Buffer.from([0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50])
function stubPortraitPipeline(f: ReturnType<typeof fixture>, judge: () => unknown) {
  f.card.appearance = 'Grey eyes, dark braids, leather collar'
  f.card.portrait = { asset_key: 'media/portrait/old.png', source: 'generated', appearance_version: 1, painted_at: new Date() }
  safetyEffects.call = async (req) => (req as { responseSchema?: unknown }).responseSchema
    ? JSON.stringify({ verdict: 'allow', reason_code: 'ok' })
    : 'A calm head-and-shoulders portrait description.'
  safetyEffects.judge = judge as never
  visualEffects.fill = async () => 'Filled look'
  visualEffects.download = async () => Buffer.from(PNG_BYTES)
  visualEffects.upload = async (_data, _type, opts) => ({ key: opts?.key || '', url: 'https://example.test/new.jpg' })
  mediaEffects.remove = async () => {}
}
check('reference_gate', () => {
  assert.equal(isReferenceAllowed('generated'), true)
  assert.equal(isReferenceAllowed('authored'), true)
  // Uploads are never faces; a missing record counts as uploaded.
  assert.equal(isReferenceAllowed('uploaded'), false)
  assert.equal(isReferenceAllowed(undefined), false)
  assert.equal(isReferenceAllowed(''), false)
})
check('cover_never_face', async () => {
  const f = fixture()
  f.db.worldTemplates.rows[0].image_url = 'https://example.test/cover.png'
  stubPortraitPipeline(f, async () => ({ verdict: 'allow', reason_code: 'ok', people_count: 1, face_close_up: true, text_visible: false }))
  const seen: string[] = []
  visualEffects.download = async (url) => { seen.push(url); return Buffer.from(PNG_BYTES) }
  visualEffects.image = async () => ({ data: Buffer.from(JPEG_BYTES), contentType: 'image/jpeg', generationId: null, costUsd: 0.009 })
  const a = portraitRow(f)
  f.db.mediaAssets.rows.push(a as unknown as Record<string, unknown>)
  await reserveMedia(a)
  await processPortrait(String(a._id))
  assert.equal(seen.length, 1)
  assert.ok(seen[0].endsWith('media/portrait/old.png'))
  assert.ok(!seen[0].includes('cover'))
})
check('pregate_blocks', async () => {
  const f = fixture()
  stubPortraitPipeline(f, async () => { throw new Error('vision must never run after a pre-gate rejection') })
  safetyEffects.call = async (req) => (req as { responseSchema?: unknown }).responseSchema
    ? JSON.stringify({ verdict: 'reject', reason_code: 'explicit_minor' })
    : 'A portrait description.'
  let painted = 0
  visualEffects.image = async () => { painted++; throw new Error('generation must never run after a pre-gate rejection') }
  const published: Array<Record<string, unknown>> = []
  mediaEffects.publish = async (_player, message) => { published.push(message) }
  const a = portraitRow(f)
  f.db.mediaAssets.rows.push(a as unknown as Record<string, unknown>)
  await reserveMedia(a)
  await processPortrait(String(a._id))
  assert.equal(painted, 0)
  assert.equal(f.db.mediaAssets.rows[0].status, 'unseen')
  assert.equal(f.db.mediaUsage.rows[0].status, 'released')
  assert.equal('slot' in f.db.mediaUsage.rows[0], false)
  assert.equal(f.db.mediaRejections.rows.length, 1)
  assert.equal((f.db.mediaRejections.rows[0] as { stage: string }).stage, 'pre')
  assert.equal(published.filter((m) => m.type === 'media_unseen').length, 1)
})
check('postgate_deletes', async () => {
  const f = fixture()
  stubPortraitPipeline(f, async () => ({ verdict: 'reject', reason_code: 'explicit_nudity', people_count: 1, face_close_up: true, text_visible: false }))
  visualEffects.image = async () => ({ data: Buffer.from(JPEG_BYTES), contentType: 'image/jpeg', generationId: null, costUsd: 0.009 })
  let uploaded = '', removed = ''
  visualEffects.upload = async (_data, _type, opts) => { uploaded = opts?.key || ''; return { key: uploaded, url: 'https://example.test/new.jpg' } }
  mediaEffects.remove = async (key) => { removed = key }
  // A rejected scene shot takes its already-uploaded still with it.
  const frames = safetyEffects.frames
  safetyEffects.frames = async () => [Buffer.from('f0'), Buffer.from('f1'), Buffer.from('f2')]
  try {
    let calls = 0
    safetyEffects.judge = (async (image: Buffer, _type: string, reference?: unknown) => reference
      ? { verdict: 'reject', reason_code: 'explicit_nudity', people_count: 1, face_close_up: false, text_visible: false }
      : { verdict: 'allow', reason_code: 'ok', people_count: 1, face_close_up: false, text_visible: false }) as never
    visualEffects.submit = async () => { calls++; return { jobId: 'job', status: 'pending' } }
    visualEffects.wait = async () => ({ jobId: 'job', status: 'completed', generationId: null, costUsd: 0.09 })
    visualEffects.fetch = async () => Buffer.from('video')
    visualEffects.download = async () => Buffer.from(PNG_BYTES)
    const shot = await makeSceneShot({
      role: 'opening',
      continuity: { wardrobe: 'Dark cloak', hair: 'Braids', props: 'none', time_of_day: 'Night', weather: 'Dry', light: 'Lamp', palette: 'Amber, black' },
      shot: { role: 'opening', evidence: 'Rain hit the gutter.', framing: 'wide', people_in_still: [{ name: 'Tomas', placement: 'door', facing: 'away' }], still: 'A figure at a door.', camera_move: 'static', subject_action: 'none', environment_motion: 'rain', duration_s: 2 },
      speakerPortrait: Buffer.from(PNG_BYTES),
      playerId: f.player,
      instanceId: f.instance,
    })
    assert.equal(shot.status, 'dropped')
    assert.equal(calls, 2)
    assert.ok(uploaded.startsWith('media/still/'))
    assert.equal(removed, uploaded)
    // The portrait path never uploads before its post-gate: nothing to delete.
    safetyEffects.judge = (async () => ({ verdict: 'reject', reason_code: 'explicit_nudity', people_count: 1, face_close_up: true, text_visible: false })) as never
    const a = portraitRow(f)
    f.db.mediaAssets.rows.push(a as unknown as Record<string, unknown>)
    await reserveMedia(a)
    await processPortrait(String(a._id))
    assert.equal(f.db.mediaAssets.rows[0].status, 'unseen')
    assert.equal('asset_key' in f.db.mediaAssets.rows[0], false)
    assert.equal(f.db.mediaUsage.rows[0].status, 'released')
  } finally {
    safetyEffects.frames = frames
  }
})
check('lasting_evidence', () => {
  const now = new Date()
  const card = { _id: new ObjectId(), canonical_name: 'Speaker', appearance: 'Grey eyes, dark braids', appearance_version: 1 }
  // "A quoted sentence from the turn" is a sentence copied verbatim from the
  // turn's prose — narration counts, not only dialogue in quotes.
  const prose = 'Her hair had gone white overnight. “I shaved my head this morning,” she said. Then she was gone.'
  const ctx = { iid: new ObjectId(), pid: new ObjectId(), now, prose }
  // A turn with no evidence: the change is ignored, version untouched.
  foldDelta(newFoldState([card] as never), { name: 'Speaker', appearance: 'Bald, grey eyes' }, 2, ctx)
  assert.equal(card.appearance, 'Grey eyes, dark braids')
  assert.equal(card.appearance_version, 1)
  // A sentence fragment covers no whole sentence: ignored.
  foldDelta(newFoldState([card] as never), { name: 'Speaker', appearance: 'Bald, grey eyes', appearance_evidence: 'gone white' }, 2, ctx)
  assert.equal(card.appearance, 'Grey eyes, dark braids')
  assert.equal(card.appearance_version, 1)
  // Fabricated evidence is ignored.
  foldDelta(newFoldState([card] as never), { name: 'Speaker', appearance: 'Bald, grey eyes', appearance_evidence: 'She grew three feet tall.' }, 2, ctx)
  assert.equal(card.appearance, 'Grey eyes, dark braids')
  assert.equal(card.appearance_version, 1)
  // The narration sentence: applied, version bumped, verdict stamped for replay.
  const delta = { name: 'Speaker', appearance: 'Bald, grey eyes', appearance_evidence: 'Her hair had gone white overnight.' }
  foldDelta(newFoldState([card] as never), delta, 2, ctx)
  assert.equal(card.appearance, 'Bald, grey eyes')
  assert.equal(card.appearance_version, 2)
  assert.equal(delta.appearance_evidence_verified, true)
  // Rebuild replays the stamped verdict without prose.
  const rebuilt = { _id: new ObjectId(), canonical_name: 'Speaker', appearance: 'Grey eyes, dark braids', appearance_version: 1 }
  foldDelta(newFoldState([rebuilt] as never), delta, 2, { iid: ctx.iid, pid: ctx.pid, now })
  assert.equal(rebuilt.appearance, 'Bald, grey eyes')
  assert.equal(rebuilt.appearance_version, 2)
})
check('repaint_on_tap', async () => {
  const f = fixture()
  f.card.appearance = 'Grey eyes, dark braids'
  f.card.portrait = { asset_key: 'media/portrait/k.png', source: 'generated', appearance_version: 1, painted_at: new Date() }
  // Current portrait: the tap costs nothing and reserves nothing.
  const ready = await requestPortrait(String(f.player), String(f.instance), String(f.character))
  assert.equal(ready.status, 'ready')
  assert.equal(f.db.mediaUsage.inserts, 0)
  // A lasting change marks it out of date: the next tap queues the repaint.
  f.card.appearance_version = 2
  const queued = await requestPortrait(String(f.player), String(f.instance), String(f.character))
  assert.equal(queued.status, 'queued')
  assert.equal(f.db.mediaUsage.rows.filter((r) => (r as { status: string }).status === 'reserved').length, 1)
})
check('placement', async () => {
  const f = fixture()
  const instance = f.db.worldInstances.rows[0] as never
  const face = { asset_key: 'media/portrait/w.png', source: 'generated' as const, appearance_version: 1, painted_at: new Date() }
  f.db.worldTemplates.rows[0].seed_cast = [{ name: 'Speaker', portrait: face, appearance: 'Grey eyes', appearance_version: 1 }]
  assert.equal((await resolvePortraitHolder(instance, f.card, { isSentient: false })).kind, 'world_cast')
  // A first painting of a cast member with no portrait yet still lives on the world.
  f.db.worldTemplates.rows[0].seed_cast = [{ name: 'Speaker', appearance: 'Grey eyes', appearance_version: 1 }]
  assert.equal((await resolvePortraitHolder(instance, f.card, { isSentient: false })).kind, 'world_cast')
  f.db.worldTemplates.rows[0].seed_cast = []
  assert.equal((await resolvePortraitHolder(instance, f.card, { isSentient: false })).kind, 'save_card')
  const persona = new ObjectId()
  f.db.personas.rows.push({ _id: persona, player_id: f.player, portrait: face, appearance_version: 1 } as unknown as Record<string, unknown>)
  const protagonist = { ...f.card, is_protagonist: true }
  assert.equal((await resolvePortraitHolder(instance, protagonist as never, { isSentient: false, personaId: persona })).kind, 'persona')
})
check('purge_portraits', async () => {
  const f = fixture()
  f.card.portrait = { asset_key: 'media/portrait/card.png', source: 'generated', appearance_version: 1, painted_at: new Date() }
  f.db.worldTemplates.rows[0].seed_cast = [{ name: 'Speaker', portrait: { asset_key: 'media/portrait/world.png', source: 'generated', appearance_version: 1, painted_at: new Date() } }]
  f.db.mediaRejections.rows.push({ _id: new ObjectId(), player_id: f.player, instance_id: f.instance } as unknown as Record<string, unknown>)
  const removed: string[] = []
  storageService.deleteStrict = async (key) => { removed.push(key) }
  const { delete: del } = storageService
  storageService.delete = async (key) => { removed.push(key) }
  try {
    await purgeMedia({ instance_id: f.instance })
    assert.equal(f.db.mediaRejections.rows.length, 0)
    await purgeCardPortraits(f.instance)
    assert.ok(removed.includes('media/portrait/card.png'))
    await purgeTemplatePortraits(f.template)
    assert.ok(removed.includes('media/portrait/world.png'))
    const service = readFileSync('src/services/deletion.service.ts', 'utf8')
    assert.ok(service.includes('await purgeCardPortraits(instanceId)'))
    assert.ok(service.includes('await purgeTemplatePortraits(tid)'))
  } finally {
    storageService.delete = del
  }
})
function directorInput(): DirectorInput {
  return {
    art_style: 'semi-realistic cinematic digital painting, warm rim light',
    narration_before: 'Rain hammered the gutter. She watched the door in the brass of the lamp.',
    line: { speaker_name: 'Seren', spoken_text: 'Stay close.', duration_s: 2 },
    narration_after: 'A floorboard sighed beyond the shutters.',
    speaker: { appearance: 'Grey eyes, dark braids', passing_look: 'Soaked coat' },
    others_present: [{ name: 'Tomas', appearance: 'A boy' }],
    place: 'An alley',
  }
}
function goodPlan() {
  return {
    continuity: { wardrobe: 'Dark cloak', hair: 'Braids', props: 'none', time_of_day: 'Night', weather: 'Dry', light: 'Lamp right', palette: 'Amber, black' },
    shots: [
      { role: 'opening', evidence: 'She watched the door in the brass of the lamp.', framing: 'insert_detail', people_in_still: [], still: 'A brass lamp.', camera_move: 'slow_push_in', subject_action: 'none', environment_motion: 'flame trembles', duration_s: 3 },
      { role: 'closing', evidence: 'A floorboard sighed beyond the shutters.', framing: 'wide', people_in_still: [{ name: 'Tomas', placement: 'door', facing: 'away' }], still: 'A door.', camera_move: 'static', subject_action: 'none', environment_motion: 'dust', duration_s: 2 },
    ],
    line_shot: { transition_in: 'cut', voice_lead_in_s: 0.3 },
    ending: { transition_out: 'dip_to_black' },
    ambient: 'Rain on stone.',
  }
}
check('director_validates', () => {
  const input = directorInput()
  assert.deepEqual(validateDirectorPlan(goodPlan(), input), [])
  const two = goodPlan() as ReturnType<typeof goodPlan>
  two.shots.push({ ...two.shots[0] })
  assert.ok(validateDirectorPlan(two, input).some((e) => e.includes('more than one opening')))
  const framing = goodPlan() as ReturnType<typeof goodPlan>
  framing.shots[0].framing = 'face_close_up'
  assert.ok(validateDirectorPlan(framing, input).some((e) => e.includes('framing')))
  const evidence = goodPlan() as ReturnType<typeof goodPlan>
  evidence.shots[0].evidence = 'An invented sentence.'
  assert.ok(validateDirectorPlan(evidence, input).some((e) => e.includes('verbatim')))
  const stranger = goodPlan() as ReturnType<typeof goodPlan>
  stranger.shots[1].people_in_still = [{ name: 'Nobody', placement: 'door', facing: 'away' }]
  assert.ok(validateDirectorPlan(stranger, input).some((e) => e.includes('unknown person')))
  const cut = goodPlan() as ReturnType<typeof goodPlan>
  cut.line_shot.transition_in = 'wipe'
  assert.ok(validateDirectorPlan(cut, input).some((e) => e.includes('transition_in')))
})
check('director_repair_once', async () => {
  const input = directorInput()
  let calls = 0
  const bad = { ...goodPlan(), shots: [] as unknown[] }
  delete (bad as { continuity?: unknown }).continuity
  directorEffects.call = async () => { calls++; return JSON.stringify(calls === 1 ? bad : goodPlan()) }
  const fixed = await directScene('test-model', input)
  assert.equal(calls, 2)
  assert.equal(fixed.repaired, true)
  assert.ok(fixed.plan)
  assert.deepEqual(fixed.errors, [])
  directorEffects.call = async () => { calls++; return JSON.stringify(bad) }
  const broken = await directScene('test-model', input)
  assert.equal(broken.plan, null)
  assert.ok(broken.errors.length > 0)
})
check('shot_judgement', () => {
  const frame = (extra: Record<string, unknown> = {}) => ({
    verdict: 'allow' as const, reason_code: 'ok', people_count: 0, face_close_up: false, text_visible: false, ...extra,
  })
  assert.equal(judgeShotFrames([], 0), false)
  // Nobody visible: wardrobe has nothing to compare, the shot stands.
  assert.equal(judgeShotFrames([frame(), frame(), frame({ wardrobe_match: false })], 0), true)
  // Someone visible in changed clothes: the shot falls.
  assert.equal(judgeShotFrames([frame({ people_count: 1, wardrobe_match: true }), frame({ people_count: 1, wardrobe_match: false })], 1), false)
  assert.equal(judgeShotFrames([frame({ people_count: 1, wardrobe_match: true }), frame({ people_count: 1, wardrobe_match: true })], 1), true)
  // A second person walks in mid-shot: the counts must match the plan.
  assert.equal(judgeShotFrames([frame({ people_count: 0 }), frame({ people_count: 1 })], 0), false)
  assert.equal(judgeShotFrames([frame({ verdict: 'reject', reason_code: 'x' })], 0), false)
  assert.equal(judgeShotFrames([frame({ face_close_up: true })], 0), false)
  assert.equal(judgeShotFrames([frame({ text_visible: true })], 0), false)
})
check('picture_resting', async () => {
  const f = fixture()
  const prior = process.env.MEDIA_DAILY_PICTURE
  process.env.MEDIA_DAILY_PICTURE = '0'
  try {
    await assert.rejects(requestPicture(String(f.player), String(f.instance), String(f.event)),
      (e: unknown) => e instanceof HttpError && e.statusCode === 429 && e.details?.status === 'resting')
    assert.equal(f.db.mediaUsage.inserts, 0)
  } finally {
    if (prior === undefined) delete process.env.MEDIA_DAILY_PICTURE
    else process.env.MEDIA_DAILY_PICTURE = prior
  }
})
check('video_resting', async () => {
  const f = fixture()
  const prior = process.env.MEDIA_DAILY_VIDEO
  process.env.MEDIA_DAILY_VIDEO = '0'
  try {
    await assert.rejects(requestVideo(String(f.player), String(f.instance), String(f.event), 'l0'),
      (e: unknown) => e instanceof HttpError && e.statusCode === 429 && e.details?.status === 'resting')
    assert.equal(f.db.mediaUsage.inserts, 0)
    assert.equal(f.calls(), 1)
  } finally {
    if (prior === undefined) delete process.env.MEDIA_DAILY_VIDEO
    else process.env.MEDIA_DAILY_VIDEO = prior
  }
})
check('video_unvoiceable', async () => {
  const f = fixture()
  f.db.events.rows[0].nsfw_intent = true
  await assert.rejects(requestVideo(String(f.player), String(f.instance), String(f.event), 'l0'),
    (e: unknown) => e instanceof HttpError && e.statusCode === 422)
  assert.equal(f.calls(), 0)
  assert.equal(f.db.mediaUsage.inserts, 0)
})
check('portrait_resting', async () => {
  const f = fixture()
  const prior = process.env.MEDIA_DAILY_PORTRAIT
  process.env.MEDIA_DAILY_PORTRAIT = '0'
  try {
    // Portraits rest silently: the resting details, no player-facing sentence.
    await assert.rejects(requestPortrait(String(f.player), String(f.instance), String(f.character)),
      (e: unknown) => e instanceof HttpError && e.statusCode === 429 && e.details?.status === 'resting' && (e as Error).message === '')
    assert.equal(f.db.mediaUsage.inserts, 0)
  } finally {
    if (prior === undefined) delete process.env.MEDIA_DAILY_PORTRAIT
    else process.env.MEDIA_DAILY_PORTRAIT = prior
  }
})
check('cut_graph', () => {
  const full = buildCutGraph({ hasOpening: true, hasClosing: true, openingS: 4, lineS: 6, closingS: 2, transitionIn: 'cut', transitionOut: 'dip_to_black', voiceDelayS: 3.75, voiceS: 6, ambienceS: 4, ambienceLabel: 'o', voiceLabel: '3' })
  // Cut in (4+6), dissolve into the close (2-0.25): 11.75 seconds.
  assert.equal(full.totalS, 11.75)
  assert.equal(full.inputs, 3)
  assert.ok(full.filter.includes('concat=n=2'))
  assert.ok(full.filter.includes('xfade=transition=fade'))
  assert.ok(full.filter.includes('[3:a]'))
  assert.ok(full.filter.includes('[oa]apad'))
  assert.ok(full.filter.includes('loudnorm=I=-16'))
  assert.ok(full.filter.includes('volume=0.12589254'))
  const solo = buildCutGraph({ hasOpening: false, hasClosing: false, openingS: 0, lineS: 5, closingS: 0, transitionIn: 'cut', transitionOut: 'cut', voiceDelayS: 0, voiceS: 5, ambienceS: null, ambienceLabel: null, voiceLabel: '1' })
  assert.equal(solo.totalS, 5)
  assert.equal(solo.inputs, 1)
  assert.ok(!solo.filter.includes('xfade'))
})
check('compile_prompts', () => {  const plan = goodPlan() as unknown as Parameters<typeof compileStillPrompt>[0]
  const shot = (goodPlan().shots[0]) as unknown as Parameters<typeof compileStillPrompt>[1]
  const still = compileStillPrompt(plan, shot, 'x-ai/grok-imagine-video-1.5-lite')
  assert.ok(still.includes('Dark cloak'))
  assert.ok(still.includes('A brass lamp.'))
  assert.ok(still.includes('No text'))
  const motion = compileMotionPrompt(plan, shot, 'alibaba/wan-3.0')
  assert.ok(motion.includes('slow_push_in') || motion.includes('drifts slowly closer'))
  assert.ok(motion.includes('No other people appear'))
  assert.ok(motion.includes('Dark cloak'))
})
// ── media-server-2-fix-1 ──

check('route_boot', async () => {
  // The real boot composition in src/index.ts order. Two param names on one
  // segment crash the server, so the audit builds it and serves one request:
  // a 404 proves the router compiled instead of throwing.
  const { Elysia } = await import('elysia')
  const { authRoutes } = await import('../src/routes/auth.routes')
  const { adminSessionRoutes } = await import('../src/routes/admin-session.routes')
  const { adminRoutes } = await import('../src/routes/admin.routes')
  const { templateRoutes } = await import('../src/routes/template.routes')
  const { moderationRoutes } = await import('../src/routes/moderation.routes')
  const { instanceRoutes } = await import('../src/routes/instance.routes')
  const { mediaRoutes } = await import('../src/routes/media.routes')
  const { personaRoutes } = await import('../src/routes/persona.routes')
  const { chronicleRoutes } = await import('../src/routes/chronicle.routes')
  const { billingRoutes } = await import('../src/routes/billing.routes')
  const { webEventRoutes } = await import('../src/routes/web-event.routes')
  const { wsRoutes } = await import('../src/routes/ws.routes')
  const app = new Elysia()
    .use(authRoutes)
    .use(adminSessionRoutes)
    .use(adminRoutes)
    .use(templateRoutes)
    .use(moderationRoutes)
    .use(instanceRoutes)
    .use(mediaRoutes)
    .use(personaRoutes)
    .use(chronicleRoutes)
    .use(billingRoutes)
    .use(webEventRoutes)
    .use(wsRoutes)
  const res = await app.handle(new Request('http://localhost/__audit_missing'))
  assert.equal(res.status, 404)
})
check('pregate_malformed', async () => {
  // The gates fail closed: a missing, misspelt or malformed verdict never
  // passes. It throws — the image is never shown, nothing is stored.
  safetyEffects.call = async () => JSON.stringify({ reason_code: 'ok' })
  await assert.rejects(moderateDescription('A calm tavern.'), /no verdict/)
  safetyEffects.call = async () => JSON.stringify({ verdict: 'allow' })
  await assert.rejects(moderateDescription('A calm tavern.'), /no reason/)
  safetyEffects.call = async () => JSON.stringify({ verdict: 'maybe', reason_code: 'ok' })
  await assert.rejects(moderateDescription('A calm tavern.'), /no verdict/)
  safetyEffects.call = async () => 'not json at all'
  await assert.rejects(moderateDescription('A calm tavern.'))
})
check('postgate_malformed', async () => {
  safetyEffects.judge = (async () => ({ verdict: 'allow', reason_code: 'ok' })) as never
  await assert.rejects(checkImage(Buffer.from('img'), 'image/png'), /people count/)
  safetyEffects.judge = (async () => ({ verdict: 'allow', reason_code: 'ok', people_count: 1, face_close_up: true })) as never
  await assert.rejects(checkImage(Buffer.from('img'), 'image/png'), /malformed frame/)
  safetyEffects.judge = (async () => ({ verdict: 'maybe', reason_code: 'x', people_count: 1, face_close_up: false, text_visible: false })) as never
  await assert.rejects(checkImage(Buffer.from('img'), 'image/png'), /no verdict/)
  safetyEffects.judge = (async () => ({ verdict: 'allow', reason_code: 'ok', people_count: 1, face_close_up: false, text_visible: 'no' })) as never
  await assert.rejects(checkImage(Buffer.from('img'), 'image/png'), /malformed frame/)
})
// The stub supplies a semantic verdict; the real pipeline must enforce it,
// release the allowance, and never upload a rejected image, for either opt-in.
const visualCases = [
  { key: 'kiss', description: 'Two fictional adults, both 35, kiss and embrace in covered evening clothes.', reason: 'ok' },
  { key: 'nudity', description: 'An adult with exposed genitals, female nipples and buttocks.', reason: 'nudity' },
  { key: 'sexual_act', description: 'Two adults engaged in a sexual act.', reason: 'sexual_act' },
  { key: 'underage', description: 'An anime character who looks adolescent poses suggestively, despite a label claiming age 30.', reason: 'underage_suggestive' },
  { key: 'gore', description: 'A battlefield with graphic gore.', reason: 'graphic_gore' },
  { key: 'real_person', description: 'An illustrated likeness of an actual public figure.', reason: 'real_person' },
  { key: 'boundary', description: 'Adult siblings portrayed romantically.', reason: 'narrative_boundary' },
] as const
for (const side of ['text', 'vision'] as const) {
  for (const example of visualCases) check(`visual_${side}_${example.key}`, async () => {
    for (const optedIn of [false, true]) {
      const f = fixture()
      ;(f.db.users.rows[0].preferences as { nsfw_enabled: boolean }).nsfw_enabled = optedIn
      const allow = example.reason === 'ok'
      const verdict = allow ? 'allow' : 'reject'
      let painted = 0, uploaded = 0
      stubPortraitPipeline(f, async () => ({ verdict: side === 'vision' ? verdict : 'allow', reason_code: side === 'vision' ? example.reason : 'ok', people_count: 1, face_close_up: true, text_visible: false }))
      safetyEffects.call = async (req) => {
        const prompt = req.messages[0].content
        const expected = req.purpose === 'media_describe' ? buildSafetyPrompts().description : buildSafetyPrompts().moderation
        assert.equal(prompt, expected)
        return req.purpose === 'media_describe' ? example.description : JSON.stringify({ verdict: side === 'text' ? verdict : 'allow', reason_code: side === 'text' ? example.reason : 'ok' })
      }
      visualEffects.image = async () => { painted++; return { data: Buffer.from(JPEG_BYTES), contentType: 'image/jpeg', generationId: null } }
      visualEffects.upload = async (_data, _type, opts) => { uploaded++; return { key: opts?.key || '', url: 'https://example.test/allowed.jpg' } }
      const asset = portraitRow(f)
      f.db.mediaAssets.rows.push(asset as unknown as Record<string, unknown>)
      await reserveMedia(asset)
      await processPortrait(String(asset._id))
      assert.equal(f.db.mediaAssets.rows[0].status, allow ? 'ready' : 'unseen')
      assert.equal(painted, allow || side === 'vision' ? 1 : 0)
      assert.equal(uploaded, allow ? 1 : 0)
      assert.equal(f.db.mediaUsage.rows[0].status, allow ? 'settled' : 'released')
      if (!allow) {
        assert.equal(f.db.mediaRejections.rows[0].reason, example.reason)
        assert.equal(f.db.mediaRejections.rows[0].stage, side === 'text' ? 'pre' : 'post')
        assert.equal(f.db.mediaAssets.rows[0].asset_key, undefined)
      }
    }
  })
}
check('visual_shared_policy', async () => {
  const original = buildSafetyPrompts()
  for (const prompt of Object.values(original)) {
    assert.ok(prompt.includes(visualPolicyLine()))
    for (const allowed of MEDIA_VISUAL_POLICY.allowed) assert.ok(prompt.includes(allowed))
    for (const rule of MEDIA_VISUAL_POLICY.blocked) assert.ok(prompt.includes(rule.content) && prompt.includes(rule.reason_code))
    assert.ok(!/SFW|fully clothed|reject sexual content|sexualized posing/i.test(prompt))
  }
  assert.ok(original.description.includes('Preserve an allowed suggestive moment as suggestive'))
  assert.ok(original.description.includes('A person without a portrait is still present'))
  assert.ok(original.description.includes('When the moment crosses the BLOCKED line, describe only what surrounds it'))
  const realFetch = globalThis.fetch
  const key = env.OPENROUTER_API_KEY
  const seen: string[] = []
  try {
    // Change both lists, then capture what all three real prompt consumers send.
    MEDIA_VISUAL_POLICY.allowed.push('audit allowed sentinel')
    MEDIA_VISUAL_POLICY.blocked.push({ reason_code: 'audit_block', content: 'audit blocked sentinel' })
    safetyEffects.call = async (req) => {
      seen.push(req.messages[0].content)
      return req.purpose === 'media_describe' ? 'A kiss.' : JSON.stringify({ verdict: 'allow', reason_code: 'ok' })
    }
    await describeMoment({ prose: 'A kiss.', present: [], passing_look: '', framing: 'scene', place: '' })
    await moderateDescription('A kiss.')
    env.OPENROUTER_API_KEY = 'audit'
    globalThis.fetch = (async (_url, init) => {
      const body = JSON.parse(String(init?.body))
      seen.push(body.messages[0].content[0].text)
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ verdict: 'allow', reason_code: 'ok', people_count: 2, face_close_up: false, text_visible: false }) } }] }))
    }) as typeof fetch
    safetyEffects.judge = realFrameJudge
    await checkImage(Buffer.from(PNG_BYTES), 'image/png')
    assert.equal(seen.length, 3)
    for (const prompt of seen) {
      assert.ok(prompt.includes('audit allowed sentinel'), 'allowed list did not reach every prompt')
      assert.ok(prompt.includes('audit blocked sentinel'), 'blocked list did not reach every prompt')
    }
  } finally {
    MEDIA_VISUAL_POLICY.allowed.pop()
    MEDIA_VISUAL_POLICY.blocked.pop()
    globalThis.fetch = realFetch
    env.OPENROUTER_API_KEY = key
  }
})
check('visual_complete_description', async () => {
  const description = 'A covered adult in a room. '.repeat(100) + 'An adolescent poses suggestively.'
  safetyEffects.call = async (req) => {
    assert.equal(req.messages[1].content, description, 'the gate must see the entire description that will be painted')
    return JSON.stringify({ verdict: 'reject', reason_code: 'underage_suggestive' })
  }
  assert.deepEqual(await moderateDescription(description), { verdict: 'reject', reason_code: 'underage_suggestive' })
})
check('visual_prompt_line', () => {
  const portrait = portraitImagePrompt('A covered adult', 'a render')
  const picture = pictureImagePrompt('Two adults kiss', 'a render', 0, '')
  for (const prompt of [portrait, picture, compileLinePrompt('Speaker', 'Stay close.')]) assert.ok(!/SFW|fully clothed/i.test(prompt))
  for (const phrase of ['head-and-shoulders portrait', 'clearly an illustration of a fictional person, never a photograph', 'no text, no lettering, no signage']) assert.ok(portrait.includes(phrase))
  assert.ok(picture.includes('no nudity, no sexual act'))
  const plan = goodPlan() as unknown as Parameters<typeof compileStillPrompt>[0]
  for (const model of ['x-ai/grok-imagine-video-1.5-lite', 'alibaba/wan-3.0']) {
    const shot = plan.shots[0]
    for (const prompt of [compileStillPrompt(plan, shot, model), compileMotionPrompt(plan, shot, model)]) {
      assert.ok(prompt.includes('No nudity, no sexual act'))
      assert.ok(prompt.includes('no suggestive depictions of anyone who looks underage'))
    }
  }
})
check('image_safety_tolerance', async () => {
  const saved = process.env.MEDIA_IMAGE_SAFETY_TOLERANCE
  const realFetch = globalThis.fetch
  const key = env.OPENROUTER_API_KEY
  try {
    delete process.env.MEDIA_IMAGE_SAFETY_TOLERANCE
    assert.equal(imageSafetyTolerance(), 2)
    for (const invalid of ['garbage', '-1', '6', '3.5', '']) {
      process.env.MEDIA_IMAGE_SAFETY_TOLERANCE = invalid
      assert.equal(imageSafetyTolerance(), 2)
    }
    env.OPENROUTER_API_KEY = 'audit'
    const bodies: Array<Record<string, unknown>> = []
    globalThis.fetch = (async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)))
      return new Response(JSON.stringify({ data: [{ b64_json: Buffer.from(JPEG_BYTES).toString('base64') }], usage: { cost: 0.009 } }))
    }) as typeof fetch
    for (const tolerance of [0, 3, 5]) {
      process.env.MEDIA_IMAGE_SAFETY_TOLERANCE = String(tolerance)
      assert.equal(imageSafetyTolerance(), tolerance)
      await generateMediaImage('A covered adult')
      assert.equal(bodies.at(-1)?.safety_tolerance, tolerance)
    }
    await generateMediaImage('A covered adult', { safetyTolerance: null })
    assert.equal('safety_tolerance' in bodies.at(-1)!, false)
    await generateMediaImage('A covered adult', { safetyTolerance: 4 })
    assert.equal(bodies.at(-1)?.safety_tolerance, 4)
    await assert.rejects(generateMediaImage('A covered adult', { safetyTolerance: 6 }), /Invalid/)
  } finally {
    if (saved === undefined) delete process.env.MEDIA_IMAGE_SAFETY_TOLERANCE
    else process.env.MEDIA_IMAGE_SAFETY_TOLERANCE = saved
    globalThis.fetch = realFetch
    env.OPENROUTER_API_KEY = key
  }
})

check('director_verbatim', () => {
  // The director prompt is the contract text, byte for byte, so it can't drift.
  const md = readFileSync(new URL('../../everlore-docs/server/MEDIA_DIRECTOR_PROMPT.md', import.meta.url), 'utf8')
  const raw = md.split('```\n')[1]
  const block = raw.endsWith('\n') ? raw.slice(0, -1) : raw
  assert.equal(DIRECTOR_SYSTEM_PROMPT, block)
})

const VIDEO_PROSE = 'Rain hammered the gutter. She watched the door. "Come with me," she whispered. A floorboard sighed beyond the shutters.'

function videoBase() {
  const f = fixture()
  f.card.appearance = 'Grey eyes, dark braids'
  f.card.appearance_version = 1
  const event = f.db.events.rows[0] as unknown as WorldEventDoc
  event.data.ai_response = VIDEO_PROSE
  event.data.spoken_lines = detectSpokenLines(VIDEO_PROSE)
  attributionEffects.call = async () => JSON.stringify({
    lines: [{ line_id: 'l0', is_speech: true, speaker_name: 'Alias', spoken_text: 'Come with me,', tags: [] }],
  })
  return f
}

interface VideoRun {
  events: string[]
  uploaded: string[]
  removed: string[]
  published: Array<Record<string, unknown>>
  sceneSubmits: string[]
}

/** Full stub pipeline for one video: director, gates, providers, ffmpeg. */
function stubVideoRun(f: ReturnType<typeof videoBase>, opts: {
  /** People the vision gate reports on the line shot's frames (default 1). */
  linePeople?: number
  /** Override the moderation verdict by description text. */
  moderate?: (text: string) => { verdict: 'allow' | 'reject'; reason_code: string }
  /** Scene stills: succeed, or throw like a provider filter 400. */
  stillImage?: 'ok' | 'throw'
  /** The face portrait: succeed, or refuse like a provider content filter. */
  portraitImage?: 'ok' | 'refuse'
} = {}): VideoRun {
  const run: VideoRun = { events: [], uploaded: [], removed: [], published: [], sceneSubmits: [] }
  let lineSubmitted = false
  // The kept face downloads as PNG; generations come back JPEG (Flux 3 Klein).
  const portraitBytes = Buffer.from(PNG_BYTES)
  const stillBytes = Buffer.from(JPEG_BYTES)
  const sceneVideo = Buffer.from('scene-video')
  const lineVideo = Buffer.from('line-video')
  const sceneFrames = [Buffer.from('sf0'), Buffer.from('sf1'), Buffer.from('sf2')]
  const lineFrames = [Buffer.from('lf0'), Buffer.from('lf1'), Buffer.from('lf2')]
  const linePeople = opts.linePeople ?? 1
  safetyEffects.call = async (req) => {
    const r = req as { responseSchema?: unknown; purpose?: string; messages?: Array<{ content?: string }> }
    if (r.responseSchema) {
      const text = (r.messages || []).map((m) => m.content || '').join('\n')
      if (opts.moderate) return JSON.stringify(opts.moderate(text))
      return JSON.stringify({ verdict: 'allow', reason_code: 'ok' })
    }
    return r.purpose === 'media_passing_look' ? 'none' : 'A calm illustrated description naming who is present.'
  }
  safetyEffects.judge = (async (image: Buffer) => {
    if (lineFrames.includes(image)) {
      return { verdict: 'allow', reason_code: 'ok', people_count: linePeople, face_close_up: false, text_visible: false }
    }
    if (sceneFrames.includes(image)) {
      return { verdict: 'allow', reason_code: 'ok', people_count: 1, face_close_up: false, text_visible: false, wardrobe_match: true }
    }
    return { verdict: 'allow', reason_code: 'ok', people_count: 1, face_close_up: false, text_visible: false }
  }) as never
  safetyEffects.frames = (async (video: Buffer) => video.equals(lineVideo) ? [...lineFrames] : [...sceneFrames]) as never
  visualEffects.image = (async (prompt: string) => {
    if (prompt.includes('head-and-shoulders portrait')) {
      if (opts.portraitImage === 'refuse') throw new ProviderRefusalError(400, '400', 'Image generation refused (400:400)')
      return { data: Buffer.from(JPEG_BYTES), contentType: 'image/jpeg', generationId: null, costUsd: 0.009 }
    }
    run.events.push('image-call')
    if (opts.stillImage === 'throw') {
      // Wait for the line submit: with the line shot parallel this resolves
      // at once; serialized behind the scenes it times out and the order
      // assertion below fails.
      const start = Date.now()
      while (!lineSubmitted && Date.now() - start < 8000) await Bun.sleep(10)
      run.events.push('image-throw')
      throw new Error('Image generation failed (400): graphic violence')
    }
    return { data: stillBytes, contentType: 'image/jpeg', generationId: null, costUsd: 0.009 }
  }) as never
  visualEffects.submit = (async (req: { model: string }) => {
    run.events.push('submit')
    if (req.model === 'heygen/avatar-iv') lineSubmitted = true
    else run.sceneSubmits.push(req.model)
    return { jobId: `job-${req.model}`, status: 'pending' }
  }) as never
  visualEffects.wait = (async (jobId: string) => ({ jobId, status: 'completed', generationId: null, costUsd: 0.3 })) as never
  visualEffects.fetch = (async (jobId: string) => jobId.includes('heygen') ? lineVideo : sceneVideo) as never
  visualEffects.upload = (async (_data: Buffer, _type: string, o?: { key?: string }) => {
    const key = o?.key || ''
    run.uploaded.push(key)
    return { key, url: `https://example.test/${key}` }
  }) as never
  visualEffects.download = (async () => portraitBytes) as never
  visualEffects.prices = (async () => ({ prompt: 0.000002, completion: 0.00001 })) as never
  directorEffects.call = (async (req: { messages: Array<{ role: string; content: string }> }) => {
    const input = JSON.parse(req.messages.find((m) => m.role === 'user')!.content) as DirectorInput
    const sentence = (s: string) => s.match(/[^.!?]+[.!?]+["'”’]*/)![0].trim()
    return JSON.stringify({
      continuity: { wardrobe: 'Dark cloak', hair: 'Braids', props: 'none', time_of_day: 'Night', weather: 'Dry', light: 'Lamp right', palette: 'Amber, black' },
      shots: [{
        role: 'opening', evidence: sentence(input.narration_before), framing: 'wide',
        people_in_still: [{ name: input.line.speaker_name, placement: 'by the door', facing: 'away' }],
        still: 'A rain-slicked door under a gutter.', camera_move: 'static',
        subject_action: 'none', environment_motion: 'rain runs off the gutter', duration_s: 2,
      }],
      line_shot: { transition_in: 'cut', voice_lead_in_s: 0 },
      ending: { transition_out: 'cut' },
      ambient: 'Rain on stone.',
    })
  }) as never
  mediaEffects.synthesize = (async () => ({ data: mp3(), contentType: 'audio/mpeg', generationId: null })) as never
  mediaEffects.upload = visualEffects.upload as never
  mediaEffects.cost = (async () => undefined) as never
  mediaEffects.remove = (async (key: string) => { run.removed.push(key) }) as never
  mediaEffects.publish = (async (_player: string, message: Record<string, unknown>) => { run.published.push(message) }) as never
  cutEffects.hasAudio = async () => false
  cutEffects.probeDuration = async () => 3
  cutEffects.run = async () => Buffer.from('norm')
  cutEffects.runFiles = async (args: string[]) => { await writeFile(args[args.length - 1], Buffer.from('cut')) }
  return run
}

async function queueVideo(f: ReturnType<typeof videoBase>): Promise<MediaAssetDoc> {
  const asset: MediaAssetDoc = {
    _id: new ObjectId(), player_id: f.player, instance_id: f.instance, event_id: f.event, character_id: f.character,
    kind: 'video', line_id: 'l0', source: 'generated', model: 'heygen/avatar-iv', voice_id: 'george',
    cache_key: `video:${new ObjectId().toHexString()}`, revision: mediaRevision(VIDEO_PROSE, ''), input: 'Come with me,',
    cost_usd: 0.65, status: 'queued', created_at: new Date(),
  }
  f.db.mediaAssets.rows.push(asset as unknown as Record<string, unknown>)
  await reserveMedia(asset)
  return asset
}

check('line_only_cut', async () => {
  // A still generation that throws still delivers a line-only cut — and the
  // HeyGen line shot started while the scene still was still pending.
  const f = videoBase()
  const run = stubVideoRun(f, { stillImage: 'throw' })
  const asset = await queueVideo(f)
  await processVideo(String(asset._id))
  const row = f.db.mediaAssets.rows[0] as unknown as MediaAssetDoc
  assert.equal(row.status, 'ready')
  assert.ok(row.url)
  const shots = (row.plan as unknown as { shots: Array<{ status: string; checks: unknown[] }> }).shots
  assert.equal(shots.length, 1)
  assert.equal(shots[0].status, 'dropped')
  assert.deepEqual(shots[0].checks, [])
  assert.ok(run.events.indexOf('submit') !== -1 && run.events.indexOf('submit') < run.events.indexOf('image-throw'))
  assert.ok(!('still_keys' in row))
})
check('line_postcheck', async () => {
  // The line shot gets the same first/middle/last-frame post-check: a failure
  // makes the whole video unseen, deletes the scene stills, releases the
  // slot and logs the rejection.
  const f = videoBase()
  const run = stubVideoRun(f, { linePeople: 2 })
  const asset = await queueVideo(f)
  await processVideo(String(asset._id))
  const row = f.db.mediaAssets.rows[0] as unknown as MediaAssetDoc
  assert.equal(row.status, 'unseen')
  assert.equal(f.db.mediaUsage.rows[0].status, 'released')
  assert.equal(f.db.mediaRejections.rows.length, 1)
  assert.equal((f.db.mediaRejections.rows[0] as { stage: string }).stage, 'post')
  const stills = run.uploaded.filter((k) => k.startsWith('media/still/'))
  assert.ok(stills.length > 0)
  for (const key of stills) assert.ok(run.removed.includes(key))
  assert.ok(run.published.some((m) => m.type === 'media_unseen'))
  assert.ok(!('still_keys' in row))
})
check('prompt_moderated', async () => {
  // The compiled still and motion prompts are moderated before any paid
  // generation: a rejected shot prompt drops that shot, and nothing is spent.
  const f = videoBase()
  const run = stubVideoRun(f, {
    moderate: (text) => text.includes('Painted film still') || text.includes('Animate this exact still')
      ? { verdict: 'reject', reason_code: 'prompt_unsafe' }
      : { verdict: 'allow', reason_code: 'ok' },
  })
  const asset = await queueVideo(f)
  await processVideo(String(asset._id))
  const row = f.db.mediaAssets.rows[0] as unknown as MediaAssetDoc
  assert.equal(row.status, 'ready')
  const shots = (row.plan as unknown as { shots: Array<{ status: string; reason?: string }> }).shots
  assert.equal(shots[0].status, 'dropped')
  assert.equal(shots[0].reason, 'still_prompt_rejected')
  assert.deepEqual(run.sceneSubmits, [])
})
check('still_cleanup', async () => {
  // A video that fails after its shots still deletes their stills.
  const f = videoBase()
  const run = stubVideoRun(f)
  cutEffects.runFiles = async () => { throw new Error('ffmpeg failed') }
  const asset = await queueVideo(f)
  await processVideo(String(asset._id))
  const row = f.db.mediaAssets.rows[0] as unknown as MediaAssetDoc
  assert.equal(row.status, 'failed')
  const stills = run.uploaded.filter((k) => k.startsWith('media/still/'))
  assert.ok(stills.length > 0)
  for (const key of stills) assert.ok(run.removed.includes(key))
  assert.ok(!('still_keys' in row))
  // When the deletion itself throws, the keys stay recorded — and purgeMedia
  // removes them.
  const g = videoBase()
  const run2 = stubVideoRun(g)
  cutEffects.runFiles = async () => { throw new Error('ffmpeg failed') }
  mediaEffects.remove = (async () => { throw new Error('storage outage') }) as never
  const asset2 = await queueVideo(g)
  await processVideo(String(asset2._id))
  const row2 = g.db.mediaAssets.rows[0] as unknown as MediaAssetDoc
  assert.deepEqual(row2.still_keys, run2.uploaded.filter((k) => k.startsWith('media/still/')))
  const purged: string[] = []
  storageService.deleteStrict = (async (key: string) => { purged.push(key) }) as never
  await purgeMedia({ instance_id: g.instance })
  for (const key of row2.still_keys || []) assert.ok(purged.includes(key))
})
check('persona_standalone', async () => {
  // "Give yourself a face" paints from the persona's description and stores on
  // the persona — with no save at all, and never touching a card.
  const f = fixture()
  f.db.worldInstances.rows = []
  const personaId = new ObjectId()
  f.db.personas.rows.push({
    _id: personaId, player_id: f.player, name: 'Asha',
    description: 'A traveller in her late twenties with curious grey eyes.',
    appearance_version: 1, created_at: new Date(), updated_at: new Date(),
  } as unknown as Record<string, unknown>)
  safetyEffects.call = async (req) => (req as { responseSchema?: unknown }).responseSchema
    ? JSON.stringify({ verdict: 'allow', reason_code: 'ok' })
    : 'A calm head-and-shoulders portrait description.'
  safetyEffects.judge = (async () => ({ verdict: 'allow', reason_code: 'ok', people_count: 1, face_close_up: true, text_visible: false })) as never
  visualEffects.image = (async () => ({ data: Buffer.from(JPEG_BYTES), contentType: 'image/jpeg', generationId: null, costUsd: 0.009 })) as never
  visualEffects.upload = (async (_data: Buffer, _type: string, o?: { key?: string }) => ({ key: o?.key || '', url: `https://example.test/${o?.key}` })) as never
  mediaEffects.remove = (async () => {}) as never
  const published: Array<Record<string, unknown>> = []
  mediaEffects.publish = (async (_player: string, message: Record<string, unknown>) => { published.push(message) }) as never
  const reply = await requestPersonaPortrait(String(f.player), String(personaId))
  assert.equal(reply.status, 'queued')
  if (reply.status !== 'queued') throw new Error('persona portrait cached unexpectedly')
  await processPortrait(String(reply.media_id))
  const persona = f.db.personas.rows[0] as unknown as { portrait?: { asset_key: string } }
  assert.ok(persona.portrait?.asset_key.startsWith('media/persona/'))
  const asset = f.db.mediaAssets.rows[0] as unknown as MediaAssetDoc
  assert.equal(asset.status, 'ready')
  assert.ok(asset.persona_id?.equals(personaId))
  assert.ok(!('instance_id' in asset))
  assert.ok(!asset.character_id)
  // Counted against the portrait allowance, with no save on the reservation.
  const usage = f.db.mediaUsage.rows[0] as unknown as { kind: string; status: string }
  assert.equal(usage.kind, 'portrait')
  assert.equal(usage.status, 'settled')
  assert.ok(!('instance_id' in usage))
  // No card was resolved or painted.
  assert.ok(!('portrait' in f.db.characters.rows[0]))
  assert.ok(published.some((m) => m.type === 'media_ready' && (m as { persona_id?: string }).persona_id === String(personaId)))
  // The kept face costs nothing and reserves nothing.
  const again = await requestPersonaPortrait(String(f.player), String(personaId))
  assert.equal(again.status, 'ready')
  assert.equal(f.db.mediaUsage.inserts, 1)
})
check('reference_key', async () => {
  // processPicture stores the reference portrait's asset key, never its name.
  const f = fixture()
  f.card.appearance = 'Grey eyes, dark braids'
  f.card.appearance_version = 1
  f.card.portrait = { asset_key: 'media/portrait/keep.png', source: 'generated', appearance_version: 1, painted_at: new Date() }
  const prose = 'Speaker leaned closer. "Come with me."'
  const event = f.db.events.rows[0] as unknown as WorldEventDoc
  event.data.ai_response = prose
  event.data.spoken_lines = detectSpokenLines(prose)
  safetyEffects.call = async (req) => (req as { responseSchema?: unknown }).responseSchema
    ? JSON.stringify({ verdict: 'allow', reason_code: 'ok' })
    : 'Speaker in a tavern. Wide view, calm mood.'
  safetyEffects.judge = (async () => ({ verdict: 'allow', reason_code: 'ok', people_count: 0, face_close_up: false, text_visible: false })) as never
  visualEffects.download = (async () => Buffer.from(PNG_BYTES)) as never
  visualEffects.image = (async () => ({ data: Buffer.from(JPEG_BYTES), contentType: 'image/jpeg', generationId: null, costUsd: 0.009 })) as never
  visualEffects.upload = (async (_data: Buffer, _type: string, o?: { key?: string }) => ({ key: o?.key || '', url: `https://example.test/${o?.key}` })) as never
  mediaEffects.remove = (async () => {}) as never
  mediaEffects.publish = (async () => {}) as never
  const reply = await requestPicture(String(f.player), String(f.instance), String(f.event))
  assert.equal(reply.status, 'queued')
  if (reply.status !== 'queued') throw new Error('picture cached unexpectedly')
  await processPicture(String(reply.media_id))
  const row = f.db.mediaAssets.rows.find((r) => (r.kind as string) === 'picture') as unknown as MediaAssetDoc
  assert.equal(row.status, 'ready')
  assert.equal(row.reference_asset_key, 'media/portrait/keep.png')
})
// ── media-picture-parallel-faces ──

// Extra unpainted faces for multi-face picture checks. The fixture's Speaker
// stays first (first_seen_sequence 1) so the present order is deterministic.
function addUnpaintedCards(f: ReturnType<typeof fixture>, names: string[]) {
  let seq = 2
  for (const name of names) {
    f.db.characters.rows.push({
      _id: new ObjectId(), instance_id: f.instance, player_id: f.player,
      canonical_name: name, name_normalized: name.toLowerCase(), aliases: [],
      appearance: `${name} with a weathered face and steady eyes`, appearance_version: 1,
      immutable_facts: [], mutable_state: [], disposition_to_player: '', hidden_thought: '',
      first_seen_sequence: seq, last_seen_sequence: seq, mention_count: 1,
      created_at: new Date(), updated_at: new Date(),
    } as unknown as Record<string, unknown>)
    seq++
  }
  f.card.appearance = 'Grey eyes, dark braids'
  f.card.appearance_version = 1
}

/** Full stub pipeline for a picture with unpainted faces. The vision verdict
 * (one face, no close-up, no text) satisfies the portrait post-gate and the
 * picture post-gate alike. */
function stubPictureFaces(f: ReturnType<typeof fixture>) {
  safetyEffects.call = async (req) => (req as { responseSchema?: unknown }).responseSchema
    ? JSON.stringify({ verdict: 'allow', reason_code: 'ok' })
    : 'Faces in a tavern. Wide view, calm mood.'
  safetyEffects.judge = (async () => ({ verdict: 'allow', reason_code: 'ok', people_count: 1, face_close_up: false, text_visible: false })) as never
  visualEffects.fill = (async () => 'Filled look') as never
  visualEffects.download = (async () => Buffer.from(PNG_BYTES)) as never
  visualEffects.upload = (async (_data: Buffer, _type: string, o?: { key?: string }) => ({ key: o?.key || '', url: `https://example.test/${o?.key}` })) as never
  mediaEffects.remove = (async () => {}) as never
  mediaEffects.publish = (async () => {}) as never
}

function pictureProse(f: ReturnType<typeof fixture>, prose: string) {
  const event = f.db.events.rows[0] as unknown as WorldEventDoc
  event.data.ai_response = prose
}

async function queuePicture(f: ReturnType<typeof fixture>): Promise<MediaAssetDoc> {
  const reply = await requestPicture(String(f.player), String(f.instance), String(f.event))
  assert.equal(reply.status, 'queued')
  if (reply.status !== 'queued') throw new Error('picture cached unexpectedly')
  await processPicture(String(reply.media_id))
  const row = f.db.mediaAssets.rows.find((r) => (r.kind as string) === 'picture') as unknown as MediaAssetDoc
  return row
}

check('picture_faces_parallel', async () => {
  // Three unpainted faces paint at the same time: all three paint calls have
  // started before any finishes, the picture still renders, the reference is
  // the first present card's face, and one timing line accounts the phase.
  const f = fixture()
  addUnpaintedCards(f, ['Mara', 'Tomas'])
  pictureProse(f, 'Mara, Tomas and Speaker gathered by the door. "Come with me."')
  stubPictureFaces(f)
  const events: string[] = []
  let started = 0
  visualEffects.image = (async (prompt: string) => {
    if (prompt.includes('head-and-shoulders portrait')) {
      events.push('start'); started++
      const begin = Date.now()
      while (started < 3 && Date.now() - begin < 3000) await Bun.sleep(20)
      events.push('finish')
    }
    return { data: Buffer.from(JPEG_BYTES), contentType: 'image/jpeg', generationId: null, costUsd: 0.009 }
  }) as never
  const logged: string[] = []
  const origLog = console.log
  console.log = ((...args: unknown[]) => { logged.push(args.map(String).join(' ')) }) as typeof console.log
  try {
    const row = await queuePicture(f)
    assert.equal(row.status, 'ready')
  } finally {
    console.log = origLog
  }
  assert.deepEqual(events.filter((e) => e === 'start'), ['start', 'start', 'start'])
  const thirdStart = events.indexOf('start', events.indexOf('start', events.indexOf('start') + 1) + 1)
  assert.ok(thirdStart !== -1 && thirdStart < events.indexOf('finish'), 'all three paints started before any finished')
  const row = f.db.mediaAssets.rows.find((r) => (r.kind as string) === 'picture') as unknown as MediaAssetDoc
  const firstPortrait = (f.db.characters.rows[0] as unknown as { portrait: { asset_key: string } }).portrait
  assert.equal(row.reference_asset_key, firstPortrait.asset_key)
  const line = logged.find((l) => l.includes('media.picture_rendered'))
  assert.ok(line, 'one timing line per finished picture')
  for (const field of ['outcome=ready', 'faces_requested=3', 'faces_painted=3', 'faces_reused=0', 'faces_dropped=0']) {
    assert.ok(line!.includes(field), `timing line carries ${field}`)
  }
  assert.ok(/render_ms=\d+/.test(line!) && /face_ms=\d+/.test(line!))
})
check('picture_faces_single_paint', async () => {
  // Two concurrent paints of one face, plus a picture naming it, end with one
  // image call, one settled portrait slot, and one asset key everywhere.
  const f = fixture()
  f.card.appearance = 'Grey eyes, dark braids'
  f.card.appearance_version = 1
  pictureProse(f, 'Speaker leaned closer. "Come with me."')
  stubPictureFaces(f)
  let portraitCalls = 0
  visualEffects.image = (async (prompt: string) => {
    if (prompt.includes('head-and-shoulders portrait')) portraitCalls++
    return { data: Buffer.from(JPEG_BYTES), contentType: 'image/jpeg', generationId: null, costUsd: 0.009 }
  }) as never
  const reply = await requestPicture(String(f.player), String(f.instance), String(f.event))
  assert.equal(reply.status, 'queued')
  if (reply.status !== 'queued') throw new Error('picture cached unexpectedly')
  const [a, b] = await Promise.all([
    ensurePortraitReady(String(f.player), String(f.instance), f.card),
    ensurePortraitReady(String(f.player), String(f.instance), f.card),
    processPicture(String(reply.media_id)),
  ])
  assert.equal(portraitCalls, 1)
  assert.equal(a.assetKey, b.assetKey)
  assert.equal(f.db.mediaUsage.rows.filter((r) => (r.kind as string) === 'portrait' && (r.status as string) === 'settled').length, 1)
  const row = f.db.mediaAssets.rows.find((r) => (r.kind as string) === 'picture') as unknown as MediaAssetDoc
  assert.equal(row.status, 'ready')
  assert.equal(row.reference_asset_key, a.assetKey)
})
check('picture_face_failure_releases', async () => {
  // The winner's paint is refused: its claim is gone, its slot is released,
  // the waiter rejects (that face stays out of frame), and the next tap
  // paints normally.
  const f = fixture()
  f.card.appearance = 'Grey eyes, dark braids'
  f.card.appearance_version = 1
  pictureProse(f, 'Speaker leaned closer. "Come with me."')
  stubPictureFaces(f)
  const prior = process.env.MEDIA_PORTRAIT_WAIT_MS
  process.env.MEDIA_PORTRAIT_WAIT_MS = '3000'
  let hold = true, refuse = false
  visualEffects.image = (async (prompt: string) => {
    if (prompt.includes('head-and-shoulders portrait')) {
      while (hold) await Bun.sleep(20)
      if (refuse) throw new ProviderRefusalError(400, '400', 'Image generation refused (400:400)')
    }
    return { data: Buffer.from(JPEG_BYTES), contentType: 'image/jpeg', generationId: null, costUsd: 0.009 }
  }) as never
  try {
    const winner = ensurePortraitReady(String(f.player), String(f.instance), f.card)
    while (f.db.mediaAssets.rows.length === 0) await Bun.sleep(20)
    const waiter = ensurePortraitReady(String(f.player), String(f.instance), f.card)
    await Bun.sleep(150) // Let the waiter lose the claim and start polling.
    refuse = true
    hold = false
    const [won, waited] = await Promise.allSettled([winner, waiter])
    assert.equal(won.status, 'rejected')
    assert.equal(waited.status, 'rejected')
    assert.equal(f.db.mediaAssets.rows.filter((r) => (r.kind as string) === 'portrait').length, 0)
    assert.equal(f.db.mediaUsage.rows.length, 1)
    assert.equal((f.db.mediaUsage.rows[0] as { status: string }).status, 'released')
    assert.ok(!('slot' in f.db.mediaUsage.rows[0]))
    refuse = false
    const retry = await ensurePortraitReady(String(f.player), String(f.instance), f.card)
    assert.ok(retry.url)
    assert.equal(f.db.mediaUsage.rows.filter((r) => (r.status as string) === 'settled').length, 1)
  } finally {
    if (prior === undefined) delete process.env.MEDIA_PORTRAIT_WAIT_MS
    else process.env.MEDIA_PORTRAIT_WAIT_MS = prior
  }
})
check('picture_faces_allowance_edge', async () => {
  // One portrait slot left and three faces: one paints, two stay out of
  // frame, and the picture itself still renders.
  const f = fixture()
  addUnpaintedCards(f, ['Mara', 'Tomas'])
  pictureProse(f, 'Mara, Tomas and Speaker gathered by the door. "Come with me."')
  stubPictureFaces(f)
  visualEffects.image = (async () => ({ data: Buffer.from(JPEG_BYTES), contentType: 'image/jpeg', generationId: null, costUsd: 0.009 })) as never
  const prior = process.env.MEDIA_DAILY_PORTRAIT
  process.env.MEDIA_DAILY_PORTRAIT = '1'
  try {
    const row = await queuePicture(f)
    assert.equal(row.status, 'ready')
    assert.equal(f.db.mediaUsage.rows.filter((r) => (r.kind as string) === 'portrait' && (r.status as string) === 'settled').length, 1)
    assert.equal(f.db.characters.rows.filter((r) => 'portrait' in r).length, 1)
  } finally {
    if (prior === undefined) delete process.env.MEDIA_DAILY_PORTRAIT
    else process.env.MEDIA_DAILY_PORTRAIT = prior
  }
})
// ── media-server-2-fix-2 ──
check('portrait_prompt_gated', async () => {
  // What is gated is what is painted: the exact string sent to the image
  // model is the moderated description plus the fixed style suffix — the raw
  // look (with its scar) never reaches the provider.
  const f = fixture()
  stubPortraitPipeline(f, async () => ({ verdict: 'allow', reason_code: 'ok', people_count: 1, face_close_up: true, text_visible: false }))
  let prompt = ''
  visualEffects.image = (async (p: string) => {
    prompt = p
    return { data: Buffer.from(JPEG_BYTES), contentType: 'image/jpeg', generationId: null, costUsd: 0.009 }
  }) as never
  const a = portraitRow(f)
  f.db.mediaAssets.rows.push(a as unknown as Record<string, unknown>)
  await reserveMedia(a)
  await processPortrait(String(a._id))
  assert.equal(f.db.mediaAssets.rows[0].status, 'ready')
  assert.ok(prompt.includes('A calm head-and-shoulders portrait description.'), 'paints the moderated description')
  assert.ok(!prompt.includes('Grey eyes, dark braids, leather collar'), 'no raw look in the prompt')
})
check('picture_prompt_gated', async () => {
  // The picture prompt is the moderated description plus fixed framing — the
  // raw turn prose is never sent to the image model.
  const f = fixture()
  f.card.appearance = 'Grey eyes, dark braids'
  f.card.appearance_version = 1
  f.card.portrait = { asset_key: 'media/portrait/keep.png', source: 'generated', appearance_version: 1, painted_at: new Date() }
  const prose = 'Speaker leaned closer. "Come with me."'
  const event = f.db.events.rows[0] as unknown as WorldEventDoc
  event.data.ai_response = prose
  event.data.spoken_lines = detectSpokenLines(prose)
  safetyEffects.call = async (req) => (req as { responseSchema?: unknown }).responseSchema
    ? JSON.stringify({ verdict: 'allow', reason_code: 'ok' })
    : 'Speaker in a tavern. Wide view, calm mood.'
  safetyEffects.judge = (async () => ({ verdict: 'allow', reason_code: 'ok', people_count: 0, face_close_up: false, text_visible: false })) as never
  visualEffects.download = (async () => Buffer.from(PNG_BYTES)) as never
  let prompt = ''
  visualEffects.image = (async (p: string) => {
    prompt = p
    return { data: Buffer.from(JPEG_BYTES), contentType: 'image/jpeg', generationId: null, costUsd: 0.009 }
  }) as never
  visualEffects.upload = (async (_data: Buffer, _type: string, o?: { key?: string }) => ({ key: o?.key || '', url: `https://example.test/${o?.key}` })) as never
  mediaEffects.remove = (async () => {}) as never
  mediaEffects.publish = (async () => {}) as never
  const reply = await requestPicture(String(f.player), String(f.instance), String(f.event))
  assert.equal(reply.status, 'queued')
  if (reply.status !== 'queued') throw new Error('picture cached unexpectedly')
  await processPicture(String(reply.media_id))
  const row = f.db.mediaAssets.rows.find((r) => (r.kind as string) === 'picture') as unknown as MediaAssetDoc
  assert.equal(row.status, 'ready')
  assert.ok(prompt.includes('Speaker in a tavern. Wide view, calm mood.'), 'paints the moderated description')
  assert.ok(!prompt.includes(prose), 'no raw prose in the prompt')
})
check('provider_refusal_detected', async () => {
  // Structural refusal detection: an HTTP 400/422 carrying the provider's
  // error envelope is a refusal — never matched on message words. Recorded
  // shape (OpenRouter, Oct 16 2026 live run): 400 + {"error": {...}}. A 400
  // without that envelope, a 429 and a 5xx stay plain failures.
  const realFetch = globalThis.fetch
  const realKey = env.OPENROUTER_API_KEY
  env.OPENROUTER_API_KEY = 'audit'
  const refusalBody = { error: { message: 'Black Forest Labs blocked this request: it was flagged for graphic violence.', code: 400 } }
  const stub = (status: number, body: unknown) => (async () => ({
    ok: false, status, statusText: 'error', headers: { get: () => null }, json: async () => body,
  })) as unknown as typeof fetch
  try {
    globalThis.fetch = stub(400, refusalBody)
    await assert.rejects(generateMediaImage('a calm portrait'),
      (e: unknown) => e instanceof ProviderRefusalError && e.status === 400 && e.code === '400')
    globalThis.fetch = stub(422, refusalBody)
    await assert.rejects(submitVideo({ prompt: 'say it', inputReferences: [] }),
      (e: unknown) => e instanceof ProviderRefusalError && e.status === 422)
    globalThis.fetch = stub(400, {})
    await assert.rejects(generateMediaImage('a calm portrait'),
      (e: unknown) => !(e instanceof ProviderRefusalError) && (e as Error).message.includes('Image generation failed (400)'))
    globalThis.fetch = stub(429, refusalBody)
    await assert.rejects(generateMediaImage('a calm portrait'),
      (e: unknown) => !(e instanceof ProviderRefusalError))
  } finally {
    globalThis.fetch = realFetch
    env.OPENROUTER_API_KEY = realKey
  }
})
check('provider_refusal_unseen', async () => {
  // A provider content refusal is a rejection, not a failure: the slot is
  // released, media_rejections logs stage provider, and media_unseen is sent.
  // The reason is never lost: the sanitised provider message lands on the
  // unseen row, on the rejection row and in one provider_refused warn line.
  const f = fixture()
  stubPortraitPipeline(f, async () => ({ verdict: 'allow', reason_code: 'ok', people_count: 1, face_close_up: true, text_visible: false }))
  visualEffects.image = (async () => { throw new ProviderRefusalError(400, '400', 'Black Forest Labs blocked this request https://cdn.example.test/still.png?token=secret-token-value filler') }) as never
  const published: Array<Record<string, unknown>> = []
  mediaEffects.publish = (async (_player: string, message: Record<string, unknown>) => { published.push(message) }) as never
  const warned: string[] = []
  const origWarn = console.warn
  console.warn = ((...args: unknown[]) => { warned.push(args.map(String).join(' ')) }) as typeof console.warn
  const a = portraitRow(f)
  f.db.mediaAssets.rows.push(a as unknown as Record<string, unknown>)
  await reserveMedia(a)
  try {
    await processPortrait(String(a._id))
  } finally {
    console.warn = origWarn
  }
  assert.equal(f.db.mediaAssets.rows[0].status, 'unseen')
  assert.equal(f.db.mediaUsage.rows[0].status, 'released')
  assert.equal(f.db.mediaRejections.rows.length, 1)
  assert.equal((f.db.mediaRejections.rows[0] as { stage: string }).stage, 'provider')
  assert.equal((f.db.mediaRejections.rows[0] as { reason: string }).reason, 'provider_400')
  assert.ok(published.some((m) => m.type === 'media_unseen'))
  const row = f.db.mediaAssets.rows[0] as unknown as MediaAssetDoc
  assert.deepEqual(Object.keys(row.error || {}).sort(), ['message', 'stage'])
  assert.equal(row.error!.stage, 'provider')
  assert.ok(row.error!.message.includes('Black Forest Labs blocked'), 'provider message kept on the unseen row')
  assert.ok(!row.error!.message.includes('http'), 'no URLs in the stored message')
  assert.ok(!row.error!.message.includes('secret-token-value'))
  assert.ok(row.error!.message.length <= 300)
  const rejection = f.db.mediaRejections.rows[0] as unknown as { message?: string }
  assert.equal(rejection.message, row.error!.message, 'rejection row carries the same message')
  assert.ok(!rejection.message!.includes('secret-token-value'))
  assert.equal(warned.filter((l) => l.includes('media.provider_refused')).length, 1, 'exactly one provider_refused line')
  const line = warned.find((l) => l.includes('media.provider_refused'))!
  assert.ok(line.includes('kind=portrait'))
  assert.ok(line.includes(`media_id=${String(a._id)}`))
  assert.ok(line.includes('status=400'))
  assert.ok(line.includes('Black Forest Labs blocked'))
  assert.ok(!line.includes('secret-token-value'))
})
check('shot_refusal_logged', async () => {
  // A refused scene still drops the shot but still counts: a rejection row
  // with the sanitised message, kept on the shot's telemetry as well.
  const f = fixture()
  f.card.appearance = 'Grey eyes, dark braids'
  safetyEffects.call = async (req) => (req as { responseSchema?: unknown }).responseSchema
    ? JSON.stringify({ verdict: 'allow', reason_code: 'ok' })
    : 'A calm illustrated description naming who is present.'
  visualEffects.image = (async () => { throw new ProviderRefusalError(400, '400', 'Flux blocked this still https://cdn.example.test/still.png?token=shot-secret filler') }) as never
  visualEffects.upload = (async () => { throw new Error('upload must never run after a refused still') }) as never
  visualEffects.download = (async () => Buffer.from(PNG_BYTES)) as never
  const shot = await makeSceneShot({
    role: 'opening',
    continuity: { wardrobe: 'Dark cloak', hair: 'Braids', props: 'none', time_of_day: 'Night', weather: 'Dry', light: 'Lamp', palette: 'Amber, black' },
    shot: { role: 'opening', evidence: 'Rain hit the gutter.', framing: 'wide', people_in_still: [{ name: 'Tomas', placement: 'door', facing: 'away' }], still: 'A figure at a door.', camera_move: 'static', subject_action: 'none', environment_motion: 'rain', duration_s: 2 },
    speakerPortrait: Buffer.from(PNG_BYTES),
    playerId: f.player,
    instanceId: f.instance,
  })
  assert.equal(shot.status, 'dropped')
  assert.equal(shot.reason, 'still_provider_refused')
  assert.ok(shot.message?.includes('Flux blocked this still'), 'shot telemetry keeps the message')
  assert.ok(!shot.message!.includes('http'), 'no URLs in the shot message')
  assert.ok(!shot.message!.includes('shot-secret'))
  assert.equal(f.db.mediaRejections.rows.length, 1)
  const rejection = f.db.mediaRejections.rows[0] as unknown as { stage: string; reason: string; message?: string; kind: string }
  assert.equal(rejection.stage, 'provider')
  assert.equal(rejection.reason, 'still_provider_refused')
  assert.equal(rejection.kind, 'video')
  assert.equal(rejection.message, shot.message, 'rejection row carries the same message')
})
check('provider_refusal_video_face', async () => {
  // A video whose face cannot be painted goes wholly unseen.
  const f = videoBase()
  const run = stubVideoRun(f, { portraitImage: 'refuse' })
  const asset = await queueVideo(f)
  await processVideo(String(asset._id))
  const row = f.db.mediaAssets.rows[0] as unknown as MediaAssetDoc
  assert.equal(row.status, 'unseen')
  assert.equal(f.db.mediaUsage.rows[0].status, 'released')
  assert.equal(f.db.mediaRejections.rows.length, 1)
  assert.equal((f.db.mediaRejections.rows[0] as { stage: string }).stage, 'provider')
  assert.ok(run.published.some((m) => m.type === 'media_unseen'))
  assert.ok(!run.uploaded.some((k) => k.startsWith('media/still/')), 'no scene still outlived the unseen video')
})
check('failed_row_error', async () => {
  // No silent failures: the catch logs one line (kind, media id, stage,
  // message) and the failed row carries error.{stage,message} — with no URLs.
  const f = fixture(), a = asset(f)
  f.db.mediaAssets.rows.push(a as unknown as Record<string, unknown>)
  await reserveMedia(a)
  mediaEffects.synthesize = async () => { throw new Error('provider blew up https://cdn.example.test/clip.mp3?token=secret-token-value plus filler') }
  const warned: string[] = []
  const origWarn = console.warn
  console.warn = ((...args: unknown[]) => { warned.push(args.map(String).join(' ')) }) as typeof console.warn
  try {
    await processVoice(String(a._id))
  } finally {
    console.warn = origWarn
  }
  const row = f.db.mediaAssets.rows[0] as unknown as MediaAssetDoc
  assert.equal(row.status, 'failed')
  assert.deepEqual(Object.keys(row.error || {}).sort(), ['message', 'stage'])
  assert.equal(row.error!.stage, 'synthesize')
  assert.ok(!row.error!.message.includes('http'), 'no URLs in the stored message')
  assert.ok(!row.error!.message.includes('secret-token-value'))
  assert.ok(row.error!.message.length <= 300)
  assert.equal(warned.length, 1, 'exactly one log line')
  const line = warned[0]
  assert.ok(line.includes('media.process_failed'))
  assert.ok(line.includes('kind=voice'))
  assert.ok(line.includes('stage=synthesize'))
  assert.ok(line.includes(`media_id=${String(a._id)}`))
  assert.ok(!line.includes('secret-token-value'))
})
check('casting_traits', () => {
  // Voice casting by traits against the catalogue's own labels: an old woman
  // gets an older feminine voice, a deep-voiced man a masculine one.
  assert.equal(chooseVoice({ gender_presentation: 'feminine', age_band: 'elderly' }, []), 'lily')
  assert.equal(chooseVoice({ gender_presentation: 'masculine', timbre: 'deep' }, []), 'adam')
  // Authored seed traits in catalogue labels keep working.
  assert.equal(chooseVoice({ gender_presentation: 'female' }, []), 'sarah')
})
check('attribution_traits', () => {
  const f = fixture()
  const line = detectSpokenLines(f.prose)[0]
  const good = { is_speech: true, speaker_name: 'Alias', spoken_text: 'Come with me.', tags: [],
    gender_presentation: 'feminine', age_band: 'older', timbre: 'warm' }
  const accepted = acceptAttribution(line, f.prose, good, () => f.card)
  if (accepted.voice?.status !== 'voiceable') throw new Error('expected voiceable')
  assert.deepEqual(accepted.voice.voice_traits, { gender_presentation: 'feminine', age_band: 'older', timbre: 'warm' })
  // An invalid trait is ignored; the valid ones stand.
  const mixed = acceptAttribution(line, f.prose, { ...good, gender_presentation: 'robot', timbre: 42 }, () => f.card)
  if (mixed.voice?.status !== 'voiceable') throw new Error('expected voiceable')
  assert.deepEqual(mixed.voice.voice_traits, { age_band: 'older' })
  assert.deepEqual(filterVoiceTraits('not an object'), {})
  assert.equal(traitsVoiceable({}), true)
  // A child or unclear-gender speaker stays unvoiceable.
  assert.equal(acceptAttribution(line, f.prose, { ...good, age_band: 'child' }, () => f.card).voice?.status, 'unvoiceable')
  assert.equal(acceptAttribution(line, f.prose, { ...good, gender_presentation: 'unclear' }, () => f.card).voice?.status, 'unvoiceable')
  // An unclear timbre only withholds the timbre vote: still voiceable.
  assert.equal(acceptAttribution(line, f.prose, { ...good, timbre: 'unclear' }, () => f.card).voice?.status, 'voiceable')
})
check('casting_traits_persist', async () => {
  // The first cast persists the traits it cast by; later casts never
  // overwrite them, so casting is stable once persisted.
  const f = fixture()
  const traits = { gender_presentation: 'feminine', age_band: 'elderly' }
  const voice = await castCharacter(f.db.worldInstances.rows[0] as never, f.card, traits)
  assert.equal(voice.voice_id, 'lily')
  assert.deepEqual(f.db.characters.rows[0].voice_traits, traits)
  const again = await castCharacter(f.db.worldInstances.rows[0] as never, f.card, { gender_presentation: 'masculine' })
  assert.deepEqual(again, voice)
  assert.deepEqual(f.db.characters.rows[0].voice_traits, traits)
})

check('jpeg_portrait_stored', async () => {
  // Flux 3 Klein returns JPEG: the portrait is stored with image/jpeg and a
  // .jpg key — the upload carries the image's own type, never a PNG default.
  const f = fixture()
  stubPortraitPipeline(f, async () => ({ verdict: 'allow', reason_code: 'ok', people_count: 1, face_close_up: true, text_visible: false }))
  visualEffects.image = (async () => ({ data: Buffer.from(JPEG_BYTES), contentType: 'image/jpeg', generationId: 'gen-1', costUsd: 0.009 })) as never
  let uploadedType = '', uploadedKey = ''
  visualEffects.upload = (async (_data: Buffer, type: string, o?: { key?: string }) => {
    uploadedType = type; uploadedKey = o?.key || ''
    return { key: uploadedKey, url: `https://example.test/${uploadedKey}` }
  }) as never
  mediaEffects.remove = (async () => {}) as never
  mediaEffects.publish = (async () => {}) as never
  const a = portraitRow(f)
  f.db.mediaAssets.rows.push(a as unknown as Record<string, unknown>)
  await reserveMedia(a)
  await processPortrait(String(a._id))
  const row = f.db.mediaAssets.rows[0] as unknown as MediaAssetDoc
  assert.equal(row.status, 'ready')
  assert.equal(uploadedType, 'image/jpeg')
  assert.ok(uploadedKey.endsWith('.jpg'), `key carries the jpeg extension: ${uploadedKey}`)
  assert.ok((row.asset_key as string).endsWith('.jpg'))
  assert.equal(row.cost_usd, 0.009)
})
check('png_reference_sniffed', async () => {
  // The kept (older PNG) face downloads as PNG and goes out as an image/png
  // reference — sniffed from the bytes, never assumed from the model.
  const f = fixture()
  stubPortraitPipeline(f, async () => ({ verdict: 'allow', reason_code: 'ok', people_count: 1, face_close_up: true, text_visible: false }))
  visualEffects.download = (async () => Buffer.from(PNG_BYTES)) as never
  let refType = ''
  visualEffects.image = (async (_prompt: string, opts?: { reference?: { contentType: string } }) => {
    refType = opts?.reference?.contentType || ''
    return { data: Buffer.from(JPEG_BYTES), contentType: 'image/jpeg', generationId: null, costUsd: 0.009 }
  }) as never
  visualEffects.upload = (async (_data: Buffer, _type: string, o?: { key?: string }) => ({ key: o?.key || '', url: `https://example.test/${o?.key}` })) as never
  mediaEffects.remove = (async () => {}) as never
  mediaEffects.publish = (async () => {}) as never
  const a = portraitRow(f)
  f.db.mediaAssets.rows.push(a as unknown as Record<string, unknown>)
  await reserveMedia(a)
  await processPortrait(String(a._id))
  assert.equal(f.db.mediaAssets.rows[0].status, 'ready')
  assert.equal(refType, 'image/png')
})
check('unknown_image_rejected', async () => {
  // Magic-byte sniffing: JPEG, PNG and WebP are recognised; anything else is
  // an error, never a guess — in the helper and on the transport.
  assert.equal(sniffImageContentType(Buffer.from(JPEG_BYTES)), 'image/jpeg')
  assert.equal(sniffImageContentType(Buffer.from(PNG_BYTES)), 'image/png')
  assert.equal(sniffImageContentType(Buffer.from(WEBP_BYTES)), 'image/webp')
  assert.equal(imageExtensionFor('image/jpeg'), '.jpg')
  assert.equal(imageExtensionFor('image/png'), '.png')
  assert.equal(imageExtensionFor('image/webp'), '.webp')
  assert.throws(() => sniffImageContentType(Buffer.from('not an image')), /unknown type/)
  assert.throws(() => asMediaImageReference(Buffer.from('not an image')), /unknown type/)
  const realFetch = globalThis.fetch
  const realKey = env.OPENROUTER_API_KEY
  env.OPENROUTER_API_KEY = 'audit'
  globalThis.fetch = (async () => ({
    ok: true, status: 200, statusText: 'ok', headers: { get: () => 'gen-x' },
    json: async () => ({ data: [{ b64_json: Buffer.from('not an image at all').toString('base64') }] }),
  })) as unknown as typeof fetch
  try {
    await assert.rejects(generateMediaImage('a calm portrait'), /unknown type/)
  } finally {
    globalThis.fetch = realFetch
    env.OPENROUTER_API_KEY = realKey
  }
})

function mp3() { const frame = Buffer.alloc(417); frame.writeUInt32BE(0xfffb9000); return frame }
// ── media-world-style: every image in the world's own art style ──

// Today's cover phrases, verbatim (image.service.ts before the render/mood
// split). decorateImagePrompt must reproduce them byte for byte.
const ORIGINAL_HINTS: Record<string, string> = {
  anime: 'vibrant anime illustration, clean linework, expressive eyes',
  tsundere: 'vibrant anime illustration, expressive, lively',
  romcom: 'bright modern anime illustration, warm and charming',
  flirty: 'sensual anime illustration, warm intimate lighting',
  noir: 'moody cinematic noir illustration, high contrast, muted palette',
  slice_of_life: 'soft cozy anime illustration, gentle pastel lighting',
  whimsical: 'whimsical storybook illustration, soft luminous colors',
  epic_fantasy: 'epic painterly fantasy concept art, dramatic lighting',
  grimdark: 'dark grim fantasy concept art, desaturated, ominous mood',
  modern_casual: 'clean contemporary illustration, natural lighting',
  yandere: 'vibrant anime illustration, intense expressive eyes, unsettling intimate mood',
  dark_romance: 'moody cinematic illustration, dramatic chiaroscuro lighting, sensual dangerous mood',
  shonen: 'dynamic shonen anime illustration, bold action linework, dramatic energy',
  cyberpunk: 'neon-soaked cyberpunk illustration, rain-slick reflections, holographic glow, high contrast',
  kdrama: 'soft cinematic illustration, warm romantic lighting, tender mood',
  cozy_comfort: 'soft warm illustration, gentle golden lighting, cozy comforting atmosphere',
  dark_academia: 'moody dark-academia illustration, candlelit gothic interior, muted vintage palette',
  regency: 'elegant period-romance illustration, soft painterly lighting, regency-era setting',
  horror: 'eerie horror illustration, deep shadows, unsettling atmosphere, desaturated dread',
  litrpg: 'vibrant fantasy game-art illustration, heroic adventurer, glowing magical effects',
  chaotic_comedy: 'lively colorful cartoon illustration, exaggerated expressive comedy, dynamic energy',
}
const ORIGINAL_DEFAULT = 'high-quality character illustration, cinematic lighting'
// The allure words that must never reach a media prompt. Exactly the two such
// words the style table carries today (flirty's cover render; the flirty and
// yandere moods) — both members of VISUAL_SEXUAL_TERMS in input-guard.ts,
// which the image guard counts as sexualized-appearance signals. Per-key mood
// halves come from the table itself (checked above); this list only covers
// words a cover render can smuggle past a mood-phrase check. It lives in the
// audit, never in logic: production picks the authored `media` render as-is.
const MEDIA_FORBIDDEN_WORDS = ['sensual', 'intimate']
const hasMoodWord = (text: string, word: string) => new RegExp(`\\b${word}\\b`, 'i').test(text)
check('cover_identical', () => {
  const core = 'A dragon over a misty city'
  for (const [key, hint] of Object.entries(ORIGINAL_HINTS)) {
    assert.equal(decorateImagePrompt(core, key), `${core}. ${hint}. ${COMPOSITION}.`)
  }
  assert.equal(decorateImagePrompt(core, undefined), `${core}. ${ORIGINAL_DEFAULT}. ${COMPOSITION}.`)
  assert.equal(decorateImagePrompt(core, 'no-such-style'), `${core}. ${ORIGINAL_DEFAULT}. ${COMPOSITION}.`)
  // The table the audit loops is the table covers use.
  assert.deepEqual(Object.keys(STYLE_HINT).sort(), Object.keys(ORIGINAL_HINTS).sort())
  assert.equal(`${DEFAULT_HINT.render}, ${DEFAULT_HINT.mood}`, ORIGINAL_DEFAULT)
})
check('cover_strip', () => {
  // Screening still reads only what a human asked for: our own decorations,
  // flirty mood included, strip out.
  const stripped = stripServerDecorations(decorateImagePrompt('A quiet tavern', 'flirty'))
  assert.ok(stripped.includes('A quiet tavern'))
  assert.ok(!stripped.includes('sensual'))
  assert.ok(!stripped.includes('warm intimate lighting'))
})
check('no_mood_in_media', () => {
  // No media prompt may contain a mood phrase, for any key. Media uses the
  // media render only (the per-key override when a cover render carries a mood
  // word itself, as flirty's "sensual" does) — and no allure word from the
  // closed list, which is what catches a smuggled word a mood-phrase check
  // cannot see.
  for (const [key, entry] of Object.entries(STYLE_HINT)) {
    const mediaRender = resolveMediaStyle(key).render
    const plan = goodPlan() as unknown as Parameters<typeof compileStillPrompt>[0]
    const shot = (goodPlan().shots[0]) as unknown as Parameters<typeof compileStillPrompt>[1]
    const prompts = [
      portraitImagePrompt('A calm face', mediaRender),
      pictureImagePrompt('A tavern scene', mediaRender, 1, ''),
      compileStillPrompt(plan, shot, 'x-ai/grok-imagine-video-1.5-lite', mediaRender),
      mediaRender,
    ]
    for (const prompt of prompts) assert.ok(prompt.includes(mediaRender), `${key} render missing`)
    if (entry.mood) {
      for (const prompt of prompts) assert.ok(!prompt.includes(entry.mood), `${key} mood leaks: ${entry.mood}`)
    }
    for (const word of MEDIA_FORBIDDEN_WORDS) {
      for (const prompt of prompts) assert.ok(!hasMoodWord(prompt, word), `${key} mood word leaks: ${word}`)
    }
  }
  // The known smuggler, pinned: flirty's cover render carries "sensual", so
  // its media render must not.
  assert.ok(!hasMoodWord(resolveMediaStyle('flirty').render, 'sensual'))
  assert.equal(resolveMediaStyle('no-such-style').render, PAINTED_RENDER)
  assert.equal(resolveMediaStyle(undefined).key, PAINTED_STYLE_KEY)
})
check('anime_media_style', () => {
  // An anime world's portrait, picture, still and director input all carry
  // the anime render phrase.
  const anime = resolveMediaStyle('anime')
  assert.equal(anime.key, 'anime')
  const render = 'vibrant anime illustration, clean linework, expressive eyes'
  assert.equal(anime.render, render)
  assert.ok(portraitImagePrompt('A face', anime.render).includes(render))
  assert.ok(pictureImagePrompt('A scene', anime.render, 2, '').includes(render))
  const plan = goodPlan() as unknown as Parameters<typeof compileStillPrompt>[0]
  const shot = (goodPlan().shots[0]) as unknown as Parameters<typeof compileStillPrompt>[1]
  assert.ok(compileStillPrompt(plan, shot, 'x-ai/grok-imagine-video-1.5-lite', anime.render).includes(render))
  assert.equal(templateMediaStyle({ narrative_style: 'anime' }).render, render)
})
check('override_ignored', async () => {
  // The save's per-conversation voice override never changes the art style:
  // the queued portrait carries the template's key, not the override's.
  const f = fixture()
  f.db.worldTemplates.rows[0].narrative_style = 'noir'
  f.db.worldInstances.rows[0].narrative_style_override = 'anime'
  f.card.appearance = 'Grey eyes, dark braids'
  f.card.appearance_version = 1
  assert.equal(templateMediaStyle({ narrative_style: 'noir' }).key, 'noir')
  assert.equal(templateMediaStyle({}).key, PAINTED_STYLE_KEY)
  assert.equal(templateMediaStyle(null).key, PAINTED_STYLE_KEY)
  const queued = await requestPortrait(String(f.player), String(f.instance), String(f.character))
  assert.equal(queued.status, 'queued')
  const row = f.db.mediaAssets.rows[0] as unknown as MediaAssetDoc
  assert.equal(row.art_style, 'noir')
  assert.ok(row.cache_key.includes(':noir:'))
})
check('style_repaint', async () => {
  // A portrait whose key differs from the world's current key is out of date.
  // Nothing paints without the tap; the tap repaints with the old face as the
  // reference and the new style in the prompt.
  const f = fixture()
  f.db.worldTemplates.rows[0].narrative_style = 'anime'
  stubPortraitPipeline(f, async () => ({ verdict: 'allow', reason_code: 'ok', people_count: 1, face_close_up: true, text_visible: false }))
  f.card.portrait = { asset_key: 'media/portrait/old.png', source: 'generated', appearance_version: 1, art_style: 'noir', painted_at: new Date() }
  assert.equal(f.db.mediaAssets.rows.length, 0)
  const queued = await requestPortrait(String(f.player), String(f.instance), String(f.character))
  assert.equal(queued.status, 'queued')
  assert.equal(f.db.mediaUsage.rows.filter((r) => (r as { status: string }).status === 'reserved').length, 1)
  const seen: string[] = []
  visualEffects.download = async (url) => { seen.push(url); return Buffer.from(PNG_BYTES) }
  let prompt = ''
  visualEffects.image = (async (p: string) => {
    prompt = p
    return { data: Buffer.from(JPEG_BYTES), contentType: 'image/jpeg', generationId: null, costUsd: 0.009 }
  }) as never
  const a = portraitRow(f)
  f.db.mediaAssets.rows.push(a as unknown as Record<string, unknown>)
  await reserveMedia(a)
  await processPortrait(String(a._id))
  const done = f.db.mediaAssets.rows.find((r) => (r._id as ObjectId).equals(a._id)) as unknown as MediaAssetDoc
  assert.equal(done.status, 'ready')
  assert.equal(seen.length, 1)
  assert.ok(seen[0].endsWith('media/portrait/old.png'))
  assert.ok(prompt.includes('vibrant anime illustration, clean linework, expressive eyes'))
  assert.ok(!prompt.includes('warm intimate lighting'))
  const stored = (f.db.characters.rows[0] as unknown as { portrait: { art_style?: string } }).portrait
  assert.equal(stored.art_style, 'anime')
})
check('legacy_painted_current', async () => {
  // A legacy portrait without art_style counts as the painted default, so a
  // painted world does not repaint it: the tap costs nothing.
  const f = fixture()
  f.card.appearance = 'Grey eyes, dark braids'
  f.card.appearance_version = 1
  f.card.portrait = { asset_key: 'media/portrait/old.png', source: 'generated', appearance_version: 1, painted_at: new Date() }
  assert.equal(styleOfPortrait(f.card.portrait), PAINTED_STYLE_KEY)
  const ready = await requestPortrait(String(f.player), String(f.instance), String(f.character))
  assert.equal(ready.status, 'ready')
  assert.ok((ready as { url: string }).url.endsWith('media/portrait/old.png'))
  assert.equal(f.db.mediaUsage.inserts, 0)
})
check('persona_per_style', async () => {
  // The persona keeps separate faces per style. The legacy single portrait
  // reads as the painted entry; an anime save paints the anime entry on tap.
  const f = fixture()
  f.db.worldTemplates.rows[0].narrative_style = 'anime'
  const personaId = new ObjectId()
  f.db.personas.rows.push({
    _id: personaId, player_id: f.player, name: 'Asha',
    description: 'A traveller in her late twenties with curious grey eyes.',
    appearance_version: 1,
    portrait: { asset_key: 'media/persona/painted.png', source: 'generated', appearance_version: 1, painted_at: new Date() },
    created_at: new Date(), updated_at: new Date(),
  } as unknown as Record<string, unknown>)
  const persona = () => f.db.personas.rows[0] as unknown as {
    portrait: { asset_key: string }; portraits?: Record<string, { asset_key: string; art_style?: string }>; last_art_style?: string
  }
  assert.equal(personaFaceForStyle(persona() as never, PAINTED_STYLE_KEY)?.asset_key, 'media/persona/painted.png')
  assert.equal(personaFaceForStyle(persona() as never, 'anime'), undefined)
  safetyEffects.call = async (req) => (req as { responseSchema?: unknown }).responseSchema
    ? JSON.stringify({ verdict: 'allow', reason_code: 'ok' })
    : 'A calm head-and-shoulders portrait description.'
  safetyEffects.judge = (async () => ({ verdict: 'allow', reason_code: 'ok', people_count: 1, face_close_up: true, text_visible: false })) as never
  visualEffects.download = (async () => Buffer.from(PNG_BYTES)) as never
  visualEffects.image = (async () => ({ data: Buffer.from(JPEG_BYTES), contentType: 'image/jpeg', generationId: null, costUsd: 0.009 })) as never
  visualEffects.upload = (async (_data: Buffer, _type: string, o?: { key?: string }) => ({ key: o?.key || '', url: `https://example.test/${o?.key}` })) as never
  mediaEffects.remove = (async () => {}) as never
  const published: Array<Record<string, unknown>> = []
  mediaEffects.publish = (async (_player: string, message: Record<string, unknown>) => { published.push(message) }) as never
  const reply = await requestPersonaPortrait(String(f.player), String(personaId), { instanceId: String(f.instance) })
  assert.equal(reply.status, 'queued')
  if (reply.status !== 'queued') throw new Error('persona portrait cached unexpectedly')
  const asset = f.db.mediaAssets.rows[0] as unknown as MediaAssetDoc
  assert.equal(asset.art_style, 'anime')
  await processPortrait(String(reply.media_id))
  assert.equal(f.db.mediaAssets.rows[0].status, 'ready')
  assert.ok(persona().portraits?.anime?.asset_key.startsWith('media/persona/'))
  assert.equal(persona().portraits?.anime?.art_style, 'anime')
  assert.equal(persona().last_art_style, 'anime')
  assert.equal(persona().portrait.asset_key, 'media/persona/painted.png')
  // Again from the same style: ready, nothing reserved. And the save-less tap
  // uses the last-used style: ready too.
  const again = await requestPersonaPortrait(String(f.player), String(personaId), { instanceId: String(f.instance) })
  assert.equal(again.status, 'ready')
  const plain = await requestPersonaPortrait(String(f.player), String(personaId))
  assert.equal(plain.status, 'ready')
  assert.equal(f.db.mediaUsage.inserts, 1)
})
check('picture_persona_style', async () => {
  // The player is in frame but has no face for this world's style: the tap
  // paints it inside the portrait allowance and uses it as the reference.
  const f = fixture()
  f.db.worldTemplates.rows[0].narrative_style = 'anime'
  const personaId = new ObjectId()
  f.db.personas.rows.push({
    _id: personaId, player_id: f.player, name: 'Asha',
    description: 'A traveller in her late twenties with curious grey eyes.',
    appearance_version: 1, created_at: new Date(), updated_at: new Date(),
  } as unknown as Record<string, unknown>)
  f.db.worldInstances.rows[0].persona_id = personaId
  f.db.worldInstances.rows[0].persona_snapshot = { name: 'Asha' }
  const prose = 'Asha leaned closer. Neon buzzed beyond the shutters.'
  const event = f.db.events.rows[0] as unknown as WorldEventDoc
  event.data.ai_response = prose
  safetyEffects.call = async (req) => (req as { responseSchema?: unknown }).responseSchema
    ? JSON.stringify({ verdict: 'allow', reason_code: 'ok' })
    : 'Asha in a neon alley. Wide view, calm mood.'
  let judges = 0
  safetyEffects.judge = (async () => {
    judges++
    // First the portrait post-gate (exactly one face), then the picture's.
    return judges === 1
      ? { verdict: 'allow', reason_code: 'ok', people_count: 1, face_close_up: true, text_visible: false }
      : { verdict: 'allow', reason_code: 'ok', people_count: 0, face_close_up: false, text_visible: false }
  }) as never
  visualEffects.download = (async () => Buffer.from(PNG_BYTES)) as never
  const prompts: string[] = []
  visualEffects.image = (async (p: string) => {
    prompts.push(p)
    return { data: Buffer.from(JPEG_BYTES), contentType: 'image/jpeg', generationId: null, costUsd: 0.009 }
  }) as never
  visualEffects.upload = (async (_data: Buffer, _type: string, o?: { key?: string }) => ({ key: o?.key || '', url: `https://example.test/${o?.key}` })) as never
  mediaEffects.remove = (async () => {}) as never
  mediaEffects.publish = (async () => {}) as never
  const reply = await requestPicture(String(f.player), String(f.instance), String(f.event))
  assert.equal(reply.status, 'queued')
  if (reply.status !== 'queued') throw new Error('picture cached unexpectedly')
  await processPicture(String(reply.media_id))
  const row = f.db.mediaAssets.rows.find((r) => (r.kind as string) === 'picture') as unknown as MediaAssetDoc
  assert.equal(row.status, 'ready')
  assert.ok((row.reference_asset_key as string).startsWith('media/persona/'))
  assert.equal(prompts.length, 2)
  assert.ok(prompts[0].includes('vibrant anime illustration, clean linework, expressive eyes'))
  assert.ok(prompts[1].includes('vibrant anime illustration, clean linework, expressive eyes'))
  const persona = f.db.personas.rows[0] as unknown as { portraits?: Record<string, { asset_key: string }> }
  assert.ok(persona.portraits?.anime?.asset_key.startsWith('media/persona/'))
  const kinds = f.db.mediaUsage.rows.map((r) => (r as { kind: string }).status === 'settled' ? (r as { kind: string }).kind : '')
  assert.ok(kinds.includes('portrait'), 'the persona face counted against the portrait allowance')
  assert.ok(kinds.includes('picture'))
})
check('vision_drawn_styles', () => {
  // The vision gate must not penalise drawn styles: anime and cartoon faces
  // are allowed illustrations, never photographs.
  assert.ok(buildSafetyPrompts().vision.includes('anime'))
  assert.ok(buildSafetyPrompts().vision.includes('cartoon'))
  assert.ok(buildSafetyPrompts().vision.includes('A fictional illustrated face is ALLOWED'))
})
// ── media-world-style-fix-1 ──
check('portrait_no_text', async () => {
  // A live portrait once painted signage spelling the character's name. The
  // prompt asks for no text, and the post-gate rejects a face that drew any —
  // the way the picture gate already does.
  assert.ok(portraitImagePrompt('A calm face', 'a render').includes('no text, no lettering, no signage'))
  const f = fixture()
  stubPortraitPipeline(f, async () => ({ verdict: 'allow', reason_code: 'ok', people_count: 1, face_close_up: true, text_visible: true }))
  visualEffects.image = (async () => ({ data: Buffer.from(JPEG_BYTES), contentType: 'image/jpeg', generationId: null, costUsd: 0.009 })) as never
  const published: Array<Record<string, unknown>> = []
  mediaEffects.publish = (async (_player: string, message: Record<string, unknown>) => { published.push(message) }) as never
  const a = portraitRow(f)
  f.db.mediaAssets.rows.push(a as unknown as Record<string, unknown>)
  await reserveMedia(a)
  await processPortrait(String(a._id))
  assert.equal(f.db.mediaAssets.rows[0].status, 'unseen')
  assert.equal((f.db.mediaAssets.rows[0] as { reason?: string }).reason, undefined)
  assert.equal('asset_key' in f.db.mediaAssets.rows[0], false)
  assert.equal(f.db.mediaUsage.rows[0].status, 'released')
  assert.equal(f.db.mediaRejections.rows.length, 1)
  assert.equal((f.db.mediaRejections.rows[0] as { stage: string }).stage, 'post')
  assert.equal((f.db.mediaRejections.rows[0] as { reason: string }).reason, 'portrait_text_visible')
  assert.ok(published.some((m) => m.type === 'media_unseen'))
})
check('persona_route_takes_save', async () => {
  // The persona portrait route lives under /personas, never under /instances,
  // and an optional save rides the query into requestPersonaPortrait. An
  // unknown or foreign save is a 404 from the service.
  const source = readFileSync('src/routes/media.routes.ts', 'utf8')
  assert.ok(source.includes("'/personas/:personaId/portrait'"))
  assert.ok(!source.includes('/instances/:id/personas'))
  assert.ok(source.includes('query?.instance_id'))
  assert.ok(source.includes('requestPersonaPortrait(user.id, params.personaId'))
  // Registered under the persona param name: an unauthenticated tap proves the
  // path compiled (the route's own 401, via the boot's HttpError mapping)
  // instead of missing (404).
  const { Elysia } = await import('elysia')
  const { mediaRoutes } = await import('../src/routes/media.routes')
  const app = new Elysia()
    .onError(({ error, set }) => {
      if (error instanceof HttpError) { set.status = error.statusCode; return { error: error.message } }
    })
    .use(mediaRoutes)
  const post = (path: string) => app.handle(new Request(`http://localhost${path}`, { method: 'POST' }))
  const res = await post('/personas/aaaaaaaaaaaaaaaaaaaaaaaa/portrait')
  assert.equal(res.status, 401)
  // The save rides a 24-hex query: anything else never reaches the service.
  assert.equal((await post('/personas/aaaaaaaaaaaaaaaaaaaaaaaa/portrait?instance_id=nothex')).status, 422)
  assert.equal((await post('/personas/zzz/portrait')).status, 422)
  // And personas are never under a save's path.
  assert.equal((await post('/instances/aaaaaaaaaaaaaaaaaaaaaaaa/personas/bbbbbbbbbbbbbbbbbbbbbbbb/portrait')).status, 404)
  const f = fixture()
  const personaId = new ObjectId()
  f.db.personas.rows.push({
    _id: personaId, player_id: f.player, name: 'Asha',
    description: 'A traveller in her late twenties with curious grey eyes.',
    appearance_version: 1, created_at: new Date(), updated_at: new Date(),
  } as unknown as Record<string, unknown>)
  await assert.rejects(
    requestPersonaPortrait(String(f.player), String(personaId), { instanceId: String(new ObjectId()) }),
    (e: unknown) => e instanceof HttpError && e.statusCode === 404)
  const foreign = new ObjectId(), foreignInstance = new ObjectId()
  f.db.worldInstances.rows.push({ _id: foreignInstance, player_id: foreign, template_id: f.template })
  await assert.rejects(
    requestPersonaPortrait(String(f.player), String(personaId), { instanceId: String(foreignInstance) }),
    (e: unknown) => e instanceof HttpError && e.statusCode === 404)
})
check('persona_delete_cleans_faces', async () => {
  // Deleting a persona deletes its kept portrait, every per-style face and
  // every persona portrait row — and nothing of anyone else's.
  const { personaService } = await import('../src/services/persona.service')
  const f = fixture()
  const personaId = new ObjectId(), otherId = new ObjectId()
  f.db.personas.rows.push({
    _id: personaId, player_id: f.player, name: 'Asha', gender: 'female', age: null,
    description: 'A traveller.', other_info: '', appearance_version: 2,
    portrait: { asset_key: 'media/persona/painted.png', source: 'generated', appearance_version: 2, painted_at: new Date() },
    portraits: {
      anime: { asset_key: 'media/persona/anime.png', source: 'generated', appearance_version: 2, art_style: 'anime', painted_at: new Date() },
    },
    created_at: new Date(), updated_at: new Date(),
  } as unknown as Record<string, unknown>)
  const row = (key: string, pid: ObjectId, owner: ObjectId): MediaAssetDoc => ({
    _id: new ObjectId(), player_id: pid, persona_id: owner, kind: 'portrait', line_id: '',
    source: 'generated', model: 'black-forest-labs/flux-3-image-klein',
    cache_key: `persona:${owner.toHexString()}:painted:v2:${key}`,
    revision: 'r', input: 'A traveller.', cost_usd: 0.009, status: 'ready',
    asset_key: key, url: `https://example.test/${key}`, created_at: new Date(),
  })
  f.db.mediaAssets.rows.push(row('media/persona/row.png', f.player, personaId) as unknown as Record<string, unknown>)
  f.db.mediaAssets.rows.push(row('media/persona/other.png', f.player, otherId) as unknown as Record<string, unknown>)
  const removed: string[] = []
  const origDelete = storageService.delete
  storageService.delete = (async (key: string) => { removed.push(key) }) as never
  try {
    await personaService.delete(String(f.player), String(personaId))
  } finally {
    storageService.delete = origDelete
  }
  assert.equal(f.db.personas.rows.length, 0)
  assert.equal(f.db.mediaAssets.rows.length, 1)
  assert.equal((f.db.mediaAssets.rows[0] as { asset_key: string }).asset_key, 'media/persona/other.png')
  assert.ok(removed.includes('media/persona/painted.png'))
  assert.ok(removed.includes('media/persona/anime.png'))
  assert.ok(removed.includes('media/persona/row.png'))
  assert.ok(!removed.includes('media/persona/other.png'))
  await assert.rejects(personaService.delete(String(f.player), String(personaId)),
    (e: unknown) => e instanceof HttpError && e.statusCode === 404)
})
function mp3() { const frame = Buffer.alloc(417); frame.writeUInt32BE(0xfffb9000); return frame }
if (process.argv.includes('--check') && !checks.some(([name]) => name === process.argv[process.argv.indexOf('--check') + 1])) throw new Error('Unknown audit check')
let failures = 0
for (const [name, fn] of checks) {
  if (process.argv.includes('--check') && process.argv[process.argv.indexOf('--check') + 1] !== name) continue
  try { await fn(); console.log(`PASS ${name}`) } catch (error) { failures++; console.error(`FAIL ${name}:`, (error as Error).message) }
}
console.log(`media audit: ${failures ? `${failures} FAILED` : 'ALL GREEN'}`)
process.exit(failures ? 1 : 0)
