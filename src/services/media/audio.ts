/** Sum MPEG audio frames; avoids a transcoding/runtime ffmpeg dependency. */
export function mp3DurationMs(data: Buffer): number {
  let offset = data.subarray(0, 3).toString() === 'ID3' ? 10 + ((data[6] & 127) << 21 | (data[7] & 127) << 14 | (data[8] & 127) << 7 | data[9] & 127) : 0
  let seconds = 0
  while (offset + 4 <= data.length) {
    const h = data.readUInt32BE(offset)
    const version = (h >>> 19) & 3
    const layer = (h >>> 17) & 3
    const bitrateIndex = (h >>> 12) & 15
    const sampleIndex = (h >>> 10) & 3
    if ((h >>> 21) !== 2047 || version === 1 || layer !== 1 || !bitrateIndex || bitrateIndex === 15 || sampleIndex === 3) { offset++; continue }
    const bitrate = (version === 3 ? [0,32,40,48,56,64,80,96,112,128,160,192,224,256,320] : [0,8,16,24,32,40,48,56,64,80,96,112,128,144,160])[bitrateIndex] * 1000
    const sampleRate = [44100,48000,32000][sampleIndex] / (version === 3 ? 1 : version === 2 ? 2 : 4)
    const length = Math.floor((version === 3 ? 144 : 72) * bitrate / sampleRate) + ((h >>> 9) & 1)
    if (offset + length > data.length) break
    seconds += (version === 3 ? 1152 : 576) / sampleRate
    offset += length
  }
  if (!seconds) throw new Error('Invalid speech audio')
  return Math.round(seconds * 1000)
}

export interface SentenceTiming {
  index: number
  text: string
  start_s: number
  end_s: number
  duration_s: number
}
export type SentenceTimingMethod = 'silence_pauses' | 'proportional_characters'
export const LINE_TAIL_S = 0.3

/** Terminal punctuation only: no language-specific abbreviations or word lists. */
export function splitLineSentences(text: string): string[] {
  return (text.match(/[^.!?。！？…]+(?:[.!?。！？…]+["'”’»)]*|$)/gu) || [])
    .map((sentence) => sentence.trim()).filter(Boolean)
}

export const audioEffects = {
  inspect: async (bytes: Buffer): Promise<{ durationS: number; pauses: Array<{ start: number; end: number }> }> => {
    const { cutEffects } = await import('./cut')
    const { ffmpegPath } = await import('./config')
    const durationS = await cutEffects.probeDuration(bytes)
    const child = Bun.spawn([ffmpegPath(), '-hide_banner', '-i', 'pipe:0',
      '-af', 'silencedetect=noise=-35dB:d=0.15', '-f', 'null', '-'],
    { stdin: bytes, stdout: 'pipe', stderr: 'pipe' })
    const [err, code] = await Promise.all([new Response(child.stderr).text(), child.exited])
    if (code !== 0) throw new Error('Could not measure speech pauses')
    const pauses: Array<{ start: number; end: number }> = []
    let start: number | undefined
    for (const match of err.matchAll(/silence_(start|end):\s*([\d.]+)/g)) {
      if (match[1] === 'start') start = Number(match[2])
      else if (start !== undefined) { pauses.push({ start, end: Number(match[2]) }); start = undefined }
    }
    return { durationS, pauses }
  },
  slice: async (bytes: Buffer, startS: number, endS: number): Promise<Buffer> => {
    const { cutEffects } = await import('./cut')
    // PCM avoids MP3 encoder padding, and padding adds silence, never the next sentence.
    return cutEffects.run(['-i', 'pipe:0', '-af',
      `atrim=start=${startS}:end=${endS},asetpts=PTS-STARTPTS,apad=pad_dur=${LINE_TAIL_S}`,
      '-c:a', 'pcm_s16le', '-f', 'wav', 'pipe:1'], [bytes])
  },
}

export async function measureLineSentences(text: string, bytes: Buffer): Promise<{
  sentences: SentenceTiming[]; method: SentenceTimingMethod; durationS: number
}> {
  const texts = splitLineSentences(text)
  if (!texts.length) throw new Error('Line has no sentences')
  const { durationS, pauses } = await audioEffects.inspect(bytes)
  if (!Number.isFinite(durationS) || durationS <= 0) throw new Error('Invalid speech duration')
  // Ignore leading/trailing silence. Interior pause midpoints partition the
  // entire clip, so even its quiet edges stay accounted for exactly once.
  const interior = pauses.filter((p) => p.start > 0.02 && p.end < durationS - 0.02)
  const matched = interior.length === texts.length - 1
  const boundaries = [0]
  const characters = texts.reduce((sum, sentence) => sum + sentence.length, 0)
  let used = 0
  for (let i = 0; i < texts.length - 1; i++) {
    used += texts[i].length
    boundaries.push(matched ? (interior[i].start + interior[i].end) / 2 : durationS * used / characters)
  }
  boundaries.push(durationS)
  return {
    method: matched ? 'silence_pauses' : 'proportional_characters', durationS,
    sentences: texts.map((sentence, index) => ({ index, text: sentence,
      start_s: boundaries[index], end_s: boundaries[index + 1], duration_s: boundaries[index + 1] - boundaries[index] })),
  }
}
