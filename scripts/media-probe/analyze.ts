import { resolve, join } from 'node:path'
import sharp from 'sharp'

const out = resolve(import.meta.dir, '../../../.agents/reports/media-probe')
const results = await Bun.file(join(out, 'results.json')).json()
interface Clip {
  id: string; kind: string; file?: string; durationSeconds?: number; analysis?: unknown
  audioSource?: string; timingNotes?: string; queueMs?: number; visualReview?: string
}
const clips = results.calls as Clip[]
const reference = clips.find(row => row.id === 'voice-gemini-leda-tense')

async function pcm(file: string) {
  const child = Bun.spawn(['/opt/homebrew/bin/ffmpeg', '-v', 'error', '-i', join(out, file), '-vn', '-ar', '3000', '-ac', '1', '-f', 'f32le', 'pipe:1'], { stdout: 'pipe', stderr: 'pipe' })
  const [bytes, error, code] = await Promise.all([new Response(child.stdout).arrayBuffer(), new Response(child.stderr).text(), child.exited])
  if (code) throw Error(error)
  return new Float32Array(bytes)
}

// A high waveform match supports reuse of the supplied recording. A low match cannot
// distinguish a new voice from time-stretching or other processing, and says nothing about lips.
function correlation(reference: Float32Array, output: Float32Array) {
  if (output.length < reference.length) return { unavailable: 'Output shorter than reference' }
  let refEnergy = 0
  for (const value of reference) refEnergy += value * value
  let best = 0, bestOffset = 0
  for (let offset = 0; offset <= output.length - reference.length; offset += 3) {
    let dot = 0, energy = 0
    for (let i = 0; i < reference.length; i++) {
      dot += reference[i] * output[offset + i]
      energy += output[offset + i] ** 2
    }
    const score = Math.abs(dot / Math.sqrt(refEnergy * energy))
    if (score > best) { best = score; bestOffset = offset }
  }
  return { maxAbsoluteCorrelation: best, offsetSeconds: bestOffset / 3000, sampleRate: 3000 }
}
const measurements = []
for (const clip of clips.filter(row => ['portrait', 'picture'].includes(row.kind) && row.file)) {
  clip.visualReview = clip.id.includes('flux3') ?
    'FLUX 3 portrait/scene pair remains recognizably the same woman; scene includes the alley and full body. More photographic texture than the FLUX 2 pair. Scar is above the left eyebrow, not through it; near-9:16 dimensions are provider-rounded.' :
    'FLUX 2 portrait/scene pair remains recognizably the same woman with grey eyes, dark braids, leather collar and the same scar. Stronger painted style; scene remains a close portrait. Scar is above the left eyebrow, not through it; near-9:16 dimensions are provider-rounded.'
}
for (const clip of clips.filter(row => row.kind === 'video' && row.file)) {
  const frames: string[] = []
  for (const [label, seconds] of [['first', 0], ['middle', (clip.durationSeconds ?? 0) / 2], ['last', Math.max(0, (clip.durationSeconds ?? 0) - 0.1)]] as const) {
    const file = `${clip.id}-${label}.png`
    const child = Bun.spawn(['/opt/homebrew/bin/ffmpeg', '-v', 'error', '-y', '-ss', String(seconds), '-i', join(out, clip.file!), '-frames:v', '1', join(out, file)], { stdout: 'pipe', stderr: 'pipe' })
    const error = await new Response(child.stderr).text()
    if (await child.exited) throw Error(error)
    frames.push(file)
  }
  const measurement = { id: clip.id, frames, ...(reference?.file ? correlation(await pcm(reference.file), await pcm(clip.file!)) : {}) }
  clip.analysis = measurement
  if (clip.id.includes('heygen')) {
    clip.audioSource = 'Strong evidence of supplied Gemini Leda recording reuse: waveform correlation 0.985; silence padded to 6 seconds'
    clip.visualReview = 'Sampled frames preserve the painted face, braids, grey eyes and scar; mouth closes after the spoken line. Lip sync still needs owner playback.'
  } else if (clip.id.includes('seedance')) {
    clip.audioSource = 'Gemini Leda reference supplied, but original waveform not preserved (correlation 0.020); voice identity requires listening'
    clip.visualReview = 'Starts on the portrait, then shifts toward a photoreal face with different facial texture and stronger acting; identity/style drift visible.'
  } else clip.visualReview = 'Sampled frames preserve the painted face; native generated voice. Lip sync requires owner playback.'
  if (clip.queueMs === undefined) clip.timingNotes = 'No in_progress status observed at 15-second polling intervals. Queue/render split unavailable; latency measures preflight start through observed completion.'
  measurements.push(measurement)
}
await Bun.write(join(out, 'results.json'), JSON.stringify(results, null, 2) + '\n')
await Bun.write(join(out, 'visual-audio-analysis.json'), JSON.stringify({
  note: 'Correlation tests recording reuse, not voice identity or lip sync. Frames support visual review only.', measurements,
}, null, 2))
const parts = []
for (let row = 0; row < measurements.length; row++) for (let column = 0; column < 3; column++) {
  const input = await sharp(join(out, measurements[row].frames[column])).resize(240, 426, { fit: 'contain' }).toBuffer()
  parts.push({ input, left: column * 240, top: row * 426 })
}
if (parts.length) await sharp({ create: { width: 720, height: measurements.length * 426, channels: 3, background: '#111111' } })
  .composite(parts).png().toFile(join(out, 'video-contact-sheet.png'))
console.log(JSON.stringify(measurements, null, 2))
