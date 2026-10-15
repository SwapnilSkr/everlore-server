import { mkdir, open, rename, unlink } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { env } from '../src/config/env'
import { synthesizeSpeech } from '../src/ai/tts'
import { CAP_USD, canReserve, checkedCost, exposure, type Charge } from './media-probe/budget'

const OUT = resolve(import.meta.dir, '../../.agents/reports/media-probe')
const API = 'https://openrouter.ai/api/v1/'
const FFMPEG = '/opt/homebrew/bin/ffmpeg'
const FFPROBE = '/opt/homebrew/bin/ffprobe'
const LINES = {
  fight: '[shouting] Get behind me! I said MOVE!',
  tense: "[whispers] Don't breathe. They're right outside the door.",
  grief: '[sighs] He kept your letters. Every single one. He never stopped waiting.',
  intimate: "[breathless] Don't stop… I've wanted you all night. Stay with me.",
}
type Line = keyof typeof LINES
type Json = Record<string, unknown>
interface Measurement extends Charge {
  kind: string
  model: string
  voice?: string
  gender?: string
  line?: string
  input?: string
  status: string
  startedAt: string
  httpStatus?: number
  latencyMs?: number
  durationSeconds?: number
  file?: string
  error?: string
  refusal?: boolean
  transcript?: string
  spokenDirection?: boolean
  media?: Json
  jobId?: string
  queueMs?: number
  renderMs?: number
  jobStatus?: string
  audioSource?: string
  lipSync?: string
  reconciliation?: Json
  initialEstimateUsd?: number
  estimateBasis?: string
  submitted?: boolean
  referenceFile?: string
  audioReferenceFile?: string
}
interface Results { version: number; capUsd: number; startedAt: string; calls: Measurement[]; summary?: Json }
let results: Results
const nativeFetch = globalThis.fetch
let active: Measurement | undefined
// The existing helper discards HTTP status and error generation IDs. Capture only these,
// without persisting request headers, signed URLs, credentials, or provider payloads.
globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
  const response = await nativeFetch(input, init)
  if (active && String(input) === `${API}audio/speech`) {
    active.httpStatus = response.status
    active.generationId = response.headers.get('x-generation-id') ?? undefined
  }
  return response
}) as typeof fetch

function obj(value: unknown): Json {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Json : {}
}
function clean(value: unknown): string {
  return String(value).replace(/sk-[\w-]+/g, '[redacted]')
    .replace(/data:[^\s"']+/g, '[media omitted]').replace(/https?:\/\/[^\s"']+/g, '[URL omitted]').slice(0, 600)
}
async function save() {
  results.summary = {
    realCostUsd: results.calls.reduce((sum, row) => sum + (row.costUsd ?? 0), 0),
    reservedExposureUsd: exposure(results.calls),
    unreconciled: results.calls.filter(row => row.status !== 'skipped' && row.costUsd === undefined).map(row => row.id),
  }
  await Bun.write(join(OUT, 'results.json.tmp'), JSON.stringify(results, null, 2) + '\n')
  await rename(join(OUT, 'results.json.tmp'), join(OUT, 'results.json'))
}
async function api(path: string, init: RequestInit = {}) {
  const url = new URL(path, API)
  if (url.origin !== 'https://openrouter.ai' || !url.pathname.startsWith('/api/v1/')) throw Error('Untrusted API URL')
  const headers = new Headers(init.headers)
  headers.set('Authorization', `Bearer ${env.OPENROUTER_API_KEY}`)
  headers.set('X-Title', 'Everlore media probe')
  return nativeFetch(url, { ...init, headers, redirect: 'error', signal: AbortSignal.timeout(180_000) })
}
async function jsonCall(row: Measurement, path: string, body: Json | FormData): Promise<Json> {
  const multipart = body instanceof FormData
  row.submitted = true
  const response = await api(path, {
    method: 'POST', headers: multipart ? {} : { 'Content-Type': 'application/json' },
    body: multipart ? body : JSON.stringify(body),
  })
  row.httpStatus = response.status
  row.generationId = response.headers.get('x-generation-id') ?? row.generationId
  const data = obj(await response.json())
  if (typeof data.id === 'string' && data.id.startsWith('gen-') && path !== 'videos') row.generationId = data.id
  if (typeof data.generation_id === 'string') row.generationId = data.generation_id
  const cost = checkedCost(obj(data.usage).cost)
  if (cost !== undefined) { row.costUsd = cost; row.costSource = 'response.usage.cost' }
  if (!response.ok || data.error) throw Error(`HTTP ${response.status}: ${clean(JSON.stringify(data.error ?? data))}`)
  return data
}
async function reconcile(row: Measurement, retry = true) {
  if (!row.generationId) return
  for (const delay of retry ? [0, 1500, 3000, 5000] : [0]) {
    if (delay) await Bun.sleep(delay)
    const response = await api(`generation?id=${encodeURIComponent(row.generationId)}`)
    row.reconciliation = { httpStatus: response.status, checkedAt: new Date().toISOString() }
    if (!response.ok) continue
    const data = obj(obj(await response.json()).data)
    const cost = checkedCost(data.total_cost)
    if (cost !== undefined) {
      row.costUsd = cost
      row.costSource = '/generation.data.total_cost'
      await save()
      return
    }
  }
  await save()
}
async function attempt(id: string, kind: string, model: string, estimate: number, details: Partial<Measurement>, run: (row: Measurement) => Promise<void>) {
  const old = results.calls.find(row => row.id === id)
  if (old) return old
  const row: Measurement = { id, kind, model, estimateUsd: estimate, startedAt: new Date().toISOString(), status: 'reserved', ...details }
  if (!canReserve(results.calls, estimate)) {
    row.status = 'skipped'; row.error = `Budget: exposure $${exposure(results.calls).toFixed(6)} + estimate $${estimate.toFixed(6)} exceeds $3.00`
    row.costUsd = 0; row.costSource = 'not submitted'
    results.calls.push(row); await save(); return row
  }
  results.calls.push(row)
  // Persist the reservation before network I/O. A restart never resubmits this ID.
  await save()
  const start = Date.now()
  try { await run(row); row.status = 'completed' }
  catch (error) {
    row.status = 'error'; row.error = clean(error instanceof Error ? error.message : error)
    row.refusal = /safety|policy|moderation|refus|blocked|inappropriate|content.?filter/i.test(row.error)
    if (row.submitted === false) { row.costUsd = 0; row.costSource = 'No AI request: local preflight failed' }
  }
  row.latencyMs ??= Date.now() - start
  await reconcile(row).catch(() => {})
  await save()
  console.log(`${row.id}: ${row.status} HTTP=${row.httpStatus ?? 'none'} cost=${row.costUsd === undefined ? 'unreconciled (reservation retained)' : '$' + row.costUsd.toFixed(6)}${row.error ? ' ' + row.error : ''}`)
  if (exposure(results.calls) > CAP_USD) throw Error('Cost exceeded reservation: stopping all submissions')
  return row
}
async function command(args: string[]) {
  const child = Bun.spawn(args, { stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  if (code) throw Error(clean(stderr))
  return stdout
}
async function inspect(row: Measurement) {
  if (!row.file) return
  const data = obj(JSON.parse(await command([FFPROBE, '-v', 'error', '-show_entries', 'format=duration:stream=codec_type,codec_name,width,height,sample_rate,channels', '-of', 'json', join(OUT, row.file)])))
  row.media = data
  row.durationSeconds = Number(obj(data.format).duration)
  if (!Number.isFinite(row.durationSeconds)) throw Error('Missing media duration')
}
async function transcribe(source: Measurement) {
  if (!source.file || !source.durationSeconds) return
  const row = await attempt(`stt-${source.id}`, 'transcription', 'openai/whisper-large-v3',
    // Groq is dearer than the catalogue's headline rate and bills at least 10 seconds.
    Math.max(10, Math.ceil(source.durationSeconds) + 1) * 0.0000308333333333 * 2, {}, async row => {
      const form = new FormData()
      form.set('model', row.model); form.set('file', Bun.file(join(OUT, source.file!)), source.file!)
      form.set('response_format', 'json'); form.set('language', 'en')
      // No transcript hint: the recognizer must not be primed with our expected words.
      const data = await jsonCall(row, 'audio/transcriptions', form)
      if (typeof data.text !== 'string') throw Error('Transcription missing text')
      row.transcript = data.text
    })
  source.transcript = row.transcript
  source.spokenDirection = row.transcript ? /\b(shout(?:ing)?|whisper(?:s|ing)?|sigh(?:s|ing)?|breathless)\b/i.test(row.transcript) : undefined
  if (row.transcript && /\b(cannot|can't|unable to) (?:help|comply|generate)|content policy|inappropriate content/i.test(row.transcript)) source.refusal = true
  await save()
}
async function voices() {
  const profiles = [
    { model: 'google/gemini-3.8-flash-tts', short: 'gemini', voices: [['Leda', 'female'], ['Charon', 'male']], format: 'pcm' as const },
    { model: 'fish-audio/drama-3', short: 'fish', voices: [['c70cfb98867a4bfb9ae20d2401257b92', 'female'], ['bf322df2096a46f18c579d0baa36f41d', 'male']], format: 'mp3' as const },
    { model: 'elevenlabs/eleven-v4-turbo', short: 'eleven', voices: [['sarah', 'female'], ['george', 'male']], format: 'mp3' as const },
  ]
  for (const profile of profiles) for (const [voice, gender] of profile.voices) for (const line of Object.keys(LINES) as Line[]) {
    const input = LINES[line]
    const label = profile.short === 'fish' ? (gender === 'female' ? 'delia' : 'adrian') : voice.toLowerCase()
    // Gemini reservation covers the catalogue's entire maximum audio output, not a guessed short duration.
    const estimate = profile.short === 'gemini' ? 16384 * 0.000009 + input.length * 0.0000005 :
      input.length * (profile.short === 'fish' ? 0.000002 : 0.00002) * 1.1
    const row = await attempt(`voice-${profile.short}-${label}-${line}`, 'voice', profile.model, estimate,
      { voice, gender, line, input }, async row => {
        active = row
        row.submitted = true
        const start = Date.now()
        let speech: Awaited<ReturnType<typeof synthesizeSpeech>>
        try { speech = await synthesizeSpeech({ model: profile.model, input, voice, responseFormat: profile.format, signal: AbortSignal.timeout(120_000) }) }
        finally { active = undefined }
        row.latencyMs = Date.now() - start
        row.generationId = speech.generationId ?? row.generationId
        if (profile.format === 'pcm') {
          const raw = `${row.id}.pcm`
          await Bun.write(join(OUT, raw), speech.data)
          row.file = `${row.id}.m4a`
          await command([FFMPEG, '-v', 'error', '-y', '-f', 's16le', '-ar', '24000', '-ac', '1', '-i', join(OUT, raw), '-c:a', 'aac', '-b:a', '48k', '-movflags', '+faststart', join(OUT, row.file)])
        } else { row.file = `${row.id}.mp3`; await Bun.write(join(OUT, row.file), speech.data) }
        await inspect(row)
      })
    await transcribe(row)
  }
}
const APPEARANCE = 'Seren, a woman in her late twenties, sharp grey eyes, dark braided hair, a thin scar through her left eyebrow, worn leather collar, semi-realistic cinematic digital painting, warm rim light'
async function dataUrl(file: string, mime: string) {
  const actualMime = /\.jpe?g$/i.test(file) ? 'image/jpeg' : /\.webp$/i.test(file) ? 'image/webp' : mime
  return `data:${actualMime};base64,${Buffer.from(await Bun.file(join(OUT, file)).arrayBuffer()).toString('base64')}`
}
const referenceUrls = new Map<string, string>()
async function uploadReference(file: string) {
  const cached = referenceUrls.get(file)
  if (cached) return cached
  // Video references require public HTTPS. These are synthetic probe assets only;
  // the anonymous host deletes them after one hour. Never send it an API credential.
  const form = new FormData()
  form.set('file', Bun.file(join(OUT, file)), file); form.set('expire', '3600')
  const response = await nativeFetch('https://tmpfiles.org/api/v1/upload', { method: 'POST', body: form, redirect: 'error', signal: AbortSignal.timeout(60_000) })
  if (!response.ok) throw Error(`Reference upload HTTP ${response.status}`)
  const data = obj(await response.json())
  const location = obj(data.data).url
  if (data.status !== 'success' || typeof location !== 'string') throw Error('Reference upload returned no URL')
  const url = new URL(location)
  if (url.hostname !== 'tmpfiles.org' || !/^\/[A-Za-z0-9_-]+\/[^/]+$/.test(url.pathname)) throw Error('Untrusted reference upload URL')
  url.protocol = 'https:'
  const landing = await nativeFetch(url, { redirect: 'error', signal: AbortSignal.timeout(60_000) })
  if (!landing.ok) throw Error(`Reference landing HTTP ${landing.status}`)
  const page = await landing.text()
  const download = /href="(https:\/\/tmpfiles\.org\/dl\/[^"<>\s]+)"/.exec(page)?.[1]
  if (!download) throw Error('Reference landing has no HTTPS download link')
  const check = await nativeFetch(download, { redirect: 'error', signal: AbortSignal.timeout(60_000) })
  if (!check.ok || !Buffer.from(await check.arrayBuffer()).equals(Buffer.from(await Bun.file(join(OUT, file)).arrayBuffer()))) throw Error('Public reference bytes did not match uploaded asset')
  referenceUrls.set(file, download)
  return download
}
async function images() {
  let portrait: Measurement | undefined
  for (const kind of ['portrait', 'picture']) {
    for (const [model, short] of [['black-forest-labs/flux-3-image-klein', 'flux3'], ['black-forest-labs/flux.2-klein-4b', 'flux2']]) {
      const prompt = kind === 'portrait' ? `${APPEARANCE}. SFW head-and-shoulders portrait, plain dark background, vertical 9:16.` :
        `${APPEARANCE}. The same woman as the reference portrait, in a rainy alley at night, fully clothed, SFW. Preserve her facial identity, braided hair and eyebrow scar. Vertical 9:16.`
      const baseId = `${kind}-${short}-seren-${kind === 'portrait' ? 'headshot' : 'alley'}`
      const wrongEndpoint = results.calls.find(row => row.id === baseId && row.httpStatus === 404 && row.error?.includes('cannot be used with the chat/completions endpoint'))
      const endpointId = wrongEndpoint ? `${baseId}-images` : baseId
      const unsupportedFormat = results.calls.find(row => row.id === endpointId && row.httpStatus === 400 && row.error?.includes('does not support: output_format'))
      const row = await attempt(unsupportedFormat ? `${baseId}-native` : endpointId, kind, model, 0.25,
        { input: prompt }, async row => {
          if (kind === 'picture' && !portrait?.file) throw Error('Portrait unavailable; reference scene cannot be generated')
          if (kind === 'picture') row.referenceFile = portrait!.file
          const body: Json = { model, prompt, aspect_ratio: '9:16', n: 1 }
          if (short === 'flux3') body.resolution = '1K'
          else body.output_format = 'png'
          if (kind === 'picture') body.input_references = [{ type: 'image_url', image_url: { url: await dataUrl(portrait!.file!, 'image/png') } }]
          const data = await jsonCall(row, 'images', body)
          const image = obj((data.data as unknown[] | undefined)?.[0])
          if (typeof image.b64_json !== 'string' || !/^[A-Za-z0-9+/=]+$/.test(image.b64_json)) throw Error('Expected inline image bytes')
          const sharp = (await import('sharp')).default
          const bytes = Buffer.from(image.b64_json, 'base64')
          const metadata = await sharp(bytes).metadata()
          if (!['png', 'jpeg', 'webp'].includes(metadata.format ?? '')) throw Error('Unsupported image encoding')
          row.file = `${row.id}.${metadata.format === 'jpeg' ? 'jpg' : metadata.format}`
          await Bun.write(join(OUT, row.file), bytes)
          row.media = { width: metadata.width, height: metadata.height, format: metadata.format }
        })
      if (row.status === 'completed') { if (kind === 'portrait') portrait = row; break }
    }
  }
}
async function pollVideo(row: Measurement) {
  if (!row.jobId) throw Error('Missing job ID')
  const started = Date.parse(row.startedAt)
  for (let i = 0; i < 60; i++) {
    const response = await api(`videos/${encodeURIComponent(row.jobId)}`)
    if (!response.ok) throw Error(`Poll HTTP ${response.status}`)
    const data = obj(await response.json())
    row.jobStatus = typeof data.status === 'string' ? data.status : 'unknown'
    if (typeof data.generation_id === 'string') row.generationId = data.generation_id
    const cost = checkedCost(obj(data.usage).cost)
    if (cost !== undefined) { row.costUsd = cost; row.costSource = 'video.usage.cost' }
    if (row.jobStatus === 'in_progress' && row.queueMs === undefined) row.queueMs = Date.now() - started
    await save()
    if (row.jobStatus === 'completed') {
      row.latencyMs = Date.now() - started
      if (row.queueMs !== undefined) row.renderMs = row.latencyMs - row.queueMs
      const download = await api(`videos/${encodeURIComponent(row.jobId)}/content?index=0`)
      if (!download.ok) throw Error(`Download HTTP ${download.status}`)
      row.file = `${row.id}.mp4`; await Bun.write(join(OUT, row.file), await download.arrayBuffer())
      await inspect(row); return
    }
    if (['failed', 'cancelled', 'expired'].includes(row.jobStatus)) throw Error(`Video ${row.jobStatus}: ${clean(data.error)}`)
    await Bun.sleep(15_000)
  }
  throw Error('Polling deadline; reservation retained; resume by rerunning')
}
async function videos() {
  const portrait = results.calls.find(row => row.kind === 'portrait' && row.file && row.status === 'completed')
  const speech = results.calls.find(row => row.id === 'voice-gemini-leda-tense')
  for (const [model, short, duration, resolution, estimate] of [
    ['heygen/avatar-iv', 'heygen', 6, '720p', 0.50],
    ['bytedance/seedance-2.0-mini', 'seedance', 5, '480p', 0.30],
    ['google/veo-3.1-lite', 'veo', 4, '720p', 0.32],
  ] as const) {
    const baseId = `video-${short}-seren-tense`
    const rejected = results.calls.find(row => row.id === baseId && row.httpStatus === 400 && !row.jobId &&
      (row.error?.includes('does not support first_frame') || row.error?.includes('Only HTTPS URLs are allowed')))
    // A schema rejection created no job. Preserve that attempt, then submit at most
    // one corrected job; a job ID always prevents any second generation for the model.
    const correctedId = rejected ? `${baseId}-https` : baseId
    const localFailure = results.calls.find(row => row.id === correctedId && !row.httpStatus && !row.jobId && row.error === 'Untrusted reference upload URL')
    const publicId = localFailure ? `${baseId}-public` : correctedId
    const redirectFailure = results.calls.find(row => row.id === publicId && !row.httpStatus && !row.jobId && row.error?.startsWith('UnexpectedRedirect fetching'))
    const id = redirectFailure ? `${baseId}-download` : publicId
    const existing = results.calls.find(row => row.id === id)
    if (existing) {
      existing.referenceFile ??= portrait?.file
      existing.audioReferenceFile ??= short === 'heygen' ? 'reference-gemini-leda-tense-padded.m4a' : short === 'seedance' ? speech?.file : undefined
    }
    if (existing?.jobId && existing.jobStatus && !['completed', 'failed', 'cancelled', 'expired'].includes(existing.jobStatus)) {
      try { await pollVideo(existing); existing.status = 'completed' } catch (error) { existing.error = clean(error) }
      await reconcile(existing); await save()
    }
    await attempt(id, 'video', model, estimate, {
      submitted: false, referenceFile: portrait?.file,
      audioReferenceFile: short === 'heygen' ? 'reference-gemini-leda-tense-padded.m4a' : short === 'seedance' ? speech?.file : undefined,
      line: 'tense', audioSource: short === 'veo' ? 'native generated voice (not Leda)' : 'Gemini Leda reference supplied; preservation unverified',
      lipSync: 'Owner must judge playback; no automatic lip-sync claim',
    }, async row => {
      if (!portrait?.file) throw Error('Portrait unavailable')
      if (short !== 'veo' && !speech?.file) throw Error('Gemini female tense audio unavailable')
      const prompt = `Seren, the adult woman in the portrait, whispers urgently: "Don't breathe. They're right outside the door." Subtle fear, still camera, SFW, no captions.${short === 'veo' ? ' Generate synchronized speech and sound.' : ' Match her lips precisely to the supplied audio reference, preserving its voice and words.'}`
      row.input = prompt
      const body: Json = { model, prompt, duration, resolution, aspect_ratio: '9:16', generate_audio: short !== 'heygen' }
      if (short === 'veo') body.frame_images = [{ type: 'image_url', image_url: { url: await dataUrl(portrait.file, 'image/png') }, frame_type: 'first_frame' }]
      else {
        const portraitUrl = await uploadReference(portrait.file)
        let audioFile = speech!.file!
        if (short === 'heygen') {
          audioFile = 'reference-gemini-leda-tense-padded.m4a'
          await command([FFMPEG, '-v', 'error', '-y', '-i', join(OUT, speech!.file!), '-af', 'apad', '-t', String(duration), '-c:a', 'aac', '-b:a', '48k', join(OUT, audioFile)])
        }
        body.input_references = [{ type: 'audio_url', audio_url: { url: await uploadReference(audioFile) } }]
        if (short === 'heygen') (body.input_references as Json[]).unshift({ type: 'image_url', image_url: { url: portraitUrl } })
        else body.frame_images = [{ type: 'image_url', image_url: { url: portraitUrl }, frame_type: 'first_frame' }]
      }
      const data = await jsonCall(row, 'videos', body)
      if (typeof data.id !== 'string') throw Error('Missing video job ID')
      row.jobId = data.id; row.jobStatus = String(data.status)
      await save(); await pollVideo(row)
    })
  }
}
function escape(value: unknown) { return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!) }
async function html() {
  const card = (row: Measurement) => {
    const video = (row.media?.streams as Json[] | undefined)?.find(stream => stream.codec_type === 'video')
    const dimensions = video ? `${video.width}×${video.height}` : row.media?.width ? `${row.media.width}×${row.media.height}` : ''
    return `<article><h3>${escape(row.model)} · ${escape(row.voice ?? 'Seren')}</h3>${row.file ? row.kind === 'voice' ? `<audio controls preload="metadata" src="${escape(row.file)}"></audio>` : row.kind === 'video' ? `<video controls preload="metadata" src="${escape(row.file)}"></video>` : `<img src="${escape(row.file)}" alt="${escape(row.kind)} of Seren">` : ''}<p>${escape(row.transcript ?? row.error ?? 'No transcript')}</p><p>${escape(row.status)} · HTTP ${row.httpStatus ?? '—'} · ${row.durationSeconds?.toFixed(2) ?? '—'}s · ${escape(dimensions)} · latency ${row.latencyMs ?? '—'}ms · $${row.costUsd?.toFixed(6) ?? 'unreconciled'}</p>${row.spokenDirection ? '<strong>Direction word or sound annotation detected; listen to distinguish them</strong>' : ''}${row.kind === 'video' ? `<p>${escape(row.audioSource)}. ${escape(row.lipSync)}. Queue ${row.queueMs ?? 'unknown'}ms; render ${row.renderMs ?? 'unknown'}ms.</p>` : ''}</article>`
  }
  await Bun.write(join(OUT, 'listen.html'), `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Everlore media probe</title><style>body{font:16px system-ui;background:#11151b;color:#eae6de;max-width:1500px;margin:auto;padding:24px}section{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:16px}article{background:#202630;border-radius:12px;padding:16px}audio{width:100%}img,video{max-width:100%;max-height:600px}h3{font-size:16px;overflow-wrap:anywhere}p{line-height:1.5}strong{color:#ffc974}</style><h1>Everlore media probe</h1><p>Confirmed charges $${results.summary?.realCostUsd}; exposure including unreconciled calls $${exposure(results.calls).toFixed(6)}; cap $3.00 (≈₹255). No autoplay. Transcripts detect spoken words; the owner judges performance and lip sync.</p>${(Object.keys(LINES) as Line[]).map(line => `<h2>${line}</h2><p>${escape(LINES[line])}</p><section>${results.calls.filter(row => row.kind === 'voice' && row.line === line).map(card).join('')}</section>`).join('')}<h2>Portrait and picture</h2><section>${results.calls.filter(row => ['portrait', 'picture'].includes(row.kind) && row.file).map(card).join('')}</section><h2>Video</h2><section>${results.calls.filter(row => row.kind === 'video' && row.file).map(card).join('')}</section><details><summary>Request and preflight failures</summary><section>${results.calls.filter(row => row.status === 'error').map(card).join('')}</section></details></html>`)
}
async function main() {
  await mkdir(OUT, { recursive: true })
  const lockPath = join(OUT, 'run.lock')
  const lock = await open(lockPath, 'wx')
  try {
    await lock.writeFile(String(process.pid))
    results = await Bun.file(join(OUT, 'results.json')).exists() ? await Bun.file(join(OUT, 'results.json')).json() as Results :
      { version: 1, capUsd: CAP_USD, startedAt: new Date().toISOString(), calls: [] }
    if (!env.OPENROUTER_API_KEY) throw Error('OpenRouter not configured')
    for (const row of results.calls) {
      if (row.kind === 'picture' && row.model === 'black-forest-labs/flux.2-klein-4b' && row.file) row.referenceFile ??= 'portrait-flux2-seren-headshot.png'
      if (!row.generationId && !row.jobId &&
        ((row.httpStatus === 400 && (row.error?.includes('does not support first_frame') || row.error?.includes('Only HTTPS URLs are allowed'))) ||
          (row.httpStatus === 404 && row.error?.includes('cannot be used with the chat/completions endpoint')))) {
        row.costUsd = 0
        row.costSource = 'Router rejected before generation; zero inferred from validation error, not returned usage.cost'
      }
      if (!row.httpStatus && !row.jobId && (row.error === 'Untrusted reference upload URL' || (row.id.endsWith('-public') && row.error?.startsWith('UnexpectedRedirect fetching')))) {
        row.costUsd = 0; row.costSource = 'No AI request: local reference URL validation failed before submission'
      }
      if (row.model !== 'google/gemini-3.8-flash-tts' || row.kind !== 'voice' || row.status !== 'completed' || !row.durationSeconds) continue
      row.initialEstimateUsd ??= row.estimateUsd
      // Once PCM exists, its measured duration replaces the preflight maximum-output
      // reservation. This remains an estimate until OpenRouter returns its real cost.
      row.estimateUsd = row.durationSeconds * 32 * 0.000009 * 1.5 + (row.input?.length ?? 0) * 0.0000005
      row.estimateBasis = 'Observed PCM duration × 32 audio tokens/s × catalogue $9/M, plus 50% margin and character upper bound for input tokens; not reconciled cost'
    }
    for (const row of results.calls.filter(row => row.costUsd === undefined && row.generationId)) await reconcile(row, false)
    if (!process.argv.includes('--reconcile-only')) { await voices(); await images(); await videos() }
    await save(); await html()
    console.log(`FINAL SPEND: confirmed $${Number(results.summary!.realCostUsd).toFixed(6)} (≈₹${(Number(results.summary!.realCostUsd) * 85).toFixed(2)}); exposure including unresolved reservations $${exposure(results.calls).toFixed(6)} / $3.00; unreconciled calls ${(results.summary!.unreconciled as string[]).length}`)
  } finally { await lock.close(); await unlink(lockPath); globalThis.fetch = nativeFetch }
}
main().catch(error => { console.error(clean(error instanceof Error ? error.message : error)); process.exitCode = 1 })
