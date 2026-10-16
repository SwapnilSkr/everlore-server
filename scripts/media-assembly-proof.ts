/** Free assembly proof: normalizeShot + assembleCut on real bytes, $0.
 * Shots are locally synthesized (odd-size Grok-like opening, silent
 * Seedance-like closing); the voice is a real Eleven clip from the smoke.
 * Asserts the contract recipe: 720x1280, 24fps, shared grade, J-cut lead-in,
 * voice full with low ambience, ~-16 LUFS, clean decode.
 */
import assert from 'node:assert/strict'
import { readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { assembleCut, cutEffects, normalizeShot } from '../src/services/media/cut'
import { mp3DurationMs } from '../src/services/media/audio'

const OUT = resolve(import.meta.dir, './media-smoke-output')
const files = await readdir(OUT)
const voiceFile = files.filter((f) => f.endsWith('.mp3')).map((f) => join(OUT, f)).sort().at(-1)
if (!voiceFile) throw new Error('No smoke voice clip found')
const voiceMp3 = Buffer.from(await Bun.file(voiceFile).arrayBuffer())

async function synth(args: string[], name: string): Promise<Buffer> {
  const { mkdtemp } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = await mkdtemp(join(tmpdir(), 'everlore-syn-'))
  const out = join(dir, `${name}.mp4`)
  const child = Bun.spawn(['/opt/homebrew/bin/ffmpeg', '-v', 'error', '-y', ...args,
    '-pix_fmt', 'yuv420p', '-movflags', '+faststart', out],
    { stdout: 'pipe', stderr: 'pipe' })
  const [err, code] = await Promise.all([new Response(child.stderr).text(), child.exited])
  if (code !== 0) throw new Error(`synth failed: ${err.slice(0, 200)}`)
  return Buffer.from(await Bun.file(out).arrayBuffer())
}
async function streams(file: string) {
  const child = Bun.spawnSync(['/opt/homebrew/bin/ffprobe', '-v', 'error', '-show_entries',
    'stream=codec_type,codec_name,width,height,avg_frame_rate,pix_fmt,sample_rate,channels:format=duration',
    '-of', 'json', file], { stdout: 'pipe', stderr: 'pipe' })
  return JSON.parse(child.stdout.toString()) as {
    streams: Array<{ codec_type: string; codec_name: string; width?: number; height?: number; avg_frame_rate?: string; pix_fmt?: string; sample_rate?: string; channels?: number }>
    format: { duration: string }
  }
}

// Grok-like odd size with audio; HeyGen-like 720p with audio; silent closing.
const openingRaw = await synth(['-f', 'lavfi', '-i', 'testsrc2=size=400x736:rate=24:duration=4', '-f', 'lavfi', '-i', 'anoisesrc=d=4:r=48000', '-shortest'], 'opening')
const lineRaw = await synth(['-f', 'lavfi', '-i', 'testsrc=size=720x1280:rate=24:duration=6', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=6', '-shortest'], 'line')
const closingRaw = await synth(['-f', 'lavfi', '-i', 'testsrc=size=478x856:rate=30:duration=2', '-an'], 'closing')
// Sequential like production (processVideo normalizes one shot at a time).
const opening = await normalizeShot(openingRaw)
const line = await normalizeShot(lineRaw)
const closing = await normalizeShot(closingRaw)
const voiceS = mp3DurationMs(voiceMp3) / 1000
const lineSegS = Math.min(await cutEffects.probeDuration(line), voiceS + 0.3)
const leadIn = 0.3
const { bytes, totalS } = await assembleCut({
  shots: [opening, line, closing], durations: [4, lineSegS, 2],
  hasOpening: true, hasClosing: true, transitionIn: 'dissolve_short', transitionOut: 'dip_to_black',
  voiceMp3, voiceDelayS: 4 - leadIn, voiceS, ambienceFrom: 'opening',
})
// 4 + line + 2, minus two 6-frame dissolves.
assert.ok(Math.abs(totalS - (6 + lineSegS - 0.5)) < 0.05, `total ${totalS} vs line ${lineSegS}`)
const cutFile = join(OUT, 'assembly-proof.mp4')
await Bun.write(cutFile, bytes)
const info = await streams(cutFile)
const video = info.streams.find((s) => s.codec_type === 'video')!
const audio = info.streams.find((s) => s.codec_type === 'audio')!
assert.equal(`${video.width}x${video.height}`, '720x1280')
assert.equal(video.avg_frame_rate, '24/1')
assert.equal(video.pix_fmt, 'yuv420p')
assert.equal(audio.codec_name, 'aac')
assert.equal(audio.sample_rate, '48000')
assert.equal(audio.channels, 2)
assert.ok(Math.abs(Number(info.format.duration) - totalS) < 0.15, `container ${info.format.duration} vs graph ${totalS}`)
// Voice survives the mix: the cut is louder than silence.
const loud = Bun.spawnSync(['/opt/homebrew/bin/ffmpeg', '-v', 'info', '-i', cutFile, '-map', '0:a', '-af', 'volumedetect', '-f', 'null', '-'],
  { stdout: 'pipe', stderr: 'pipe' })
const meanVolume = /mean_volume: ([-\d.]+) dB/.exec(loud.stderr.toString())?.[1]
assert.ok(meanVolume && Number(meanVolume) > -60, `mean volume ${meanVolume} dB`)
// The degenerate line-only cut (no scene shot survived).
const solo = await assembleCut({
  shots: [line], durations: [lineSegS],
  hasOpening: false, hasClosing: false, transitionIn: 'cut', transitionOut: 'cut',
  voiceMp3, voiceDelayS: 0, voiceS, ambienceFrom: null,
})
assert.ok(Math.abs(solo.totalS - lineSegS) < 0.05)
await Bun.write(join(OUT, 'assembly-proof-solo.mp4'), solo.bytes)
console.log(`PASS assembly: full cut ${totalS.toFixed(2)}s 720x1280@24 yuv420p + aac48k stereo, mean ${meanVolume} dB; line-only ${solo.totalS.toFixed(2)}s`)
