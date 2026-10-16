import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ffmpegPath, ffprobePath } from './config'

/**
 * Scene-cut assembly (contract §3A.3). Shots are generated in parallel where
 * possible; render time is logged on the asset. The whole cut degrades, never
 * breaks: a failed scene shot still delivers the cut, a failed line shot fails
 * the whole video and releases the slot.
 */

export interface CutPart {
  /** Normalized 720x1280 h264 bytes for one shot. */
  video: Buffer
  durationS: number
  /** Scene ambience to bed under the voice, or null (fallback audio dropped). */
  ambience: Buffer | null
}

export interface CutTimeline {
  opening?: CutPart
  line: CutPart & { voiceDelayS: number; voiceDurationS: number }
  closing?: CutPart
  transitionIn: 'cut' | 'dissolve_short'
  transitionOut: 'cut' | 'dissolve_short' | 'dip_to_black'
}

export const cutEffects = {
  run: async (args: string[], stdin: Buffer[]): Promise<Buffer> => {
    const child = Bun.spawn([ffmpegPath(), '-v', 'error', '-y', ...args], {
      stdin: Buffer.concat(stdin),
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [out, err, code] = await Promise.all([
      new Response(child.stdout).arrayBuffer(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    if (code !== 0) throw new Error(`ffmpeg failed: ${err.slice(0, 300)}`)
    return Buffer.from(out)
  },
  runFiles: async (args: string[]): Promise<void> => {
    const child = Bun.spawn([ffmpegPath(), '-v', 'error', '-y', ...args], {
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [err, code] = await Promise.all([new Response(child.stderr).text(), child.exited])
    if (code !== 0) throw new Error(`ffmpeg failed: ${err.slice(0, 300)}`)
  },
  probeDuration: (video: Buffer): Promise<number> => withTempDir('everlore-probe-', async (dir) => {
    const src = join(dir, 'shot.mp4')
    await writeFile(src, video)
    const child = Bun.spawnSync([ffprobePath(), '-v', 'error',
      '-show_entries', 'format=duration:stream=duration', '-of', 'csv=p=0', src],
      { stdout: 'pipe', stderr: 'pipe' })
    const duration = child.stdout.toString().trim().split('\n')
      .map(Number).filter((n) => Number.isFinite(n) && n > 0)
      .reduce((best, n) => Math.max(best, n), -Infinity)
    if (!Number.isFinite(duration) || duration <= 0) throw new Error('Could not read video duration')
    return duration
  }),
  hasAudio: (video: Buffer): Promise<boolean> => withTempDir('everlore-probe-', async (dir) => {
    const src = join(dir, 'shot.mp4')
    await writeFile(src, video)
    const child = Bun.spawnSync([ffprobePath(), '-v', 'error',
      '-select_streams', 'a', '-show_entries', 'stream=index', '-of', 'csv=p=0', src],
      { stdout: 'pipe', stderr: 'pipe' })
    return child.stdout.toString().trim().length > 0
  }),
  /**
   * One JPEG frame of a finished cut, for the Keepsakes feed. Falls back to
   * the first frame when the cut is shorter than the sample point. Throws on
   * any ffmpeg failure — the caller never lets that fail the film.
   */
  extractFrame: (video: Buffer, atS = 0.5): Promise<Buffer> => withTempDir('everlore-poster-', async (dir) => {
    const src = join(dir, 'cut.mp4')
    const out = join(dir, 'poster.jpg')
    await writeFile(src, video)
    await cutEffects.runFiles([
      '-ss', String(atS), '-i', src, '-frames:v', '1', '-q:v', '3', out,
    ])
    return Buffer.from(await readFile(out))
  }),
}

/** ffprobe and mp4+faststart need seekable files, not pipes: a scratch
 * directory per call, always removed, whatever the work threw. */
async function withTempDir<T>(prefix: string, work: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  try {
    return await work(dir)
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

const normVideo = (label: string) =>
  `[${label}:v]scale=720:1280:force_original_aspect_ratio=decrease:force_divisible_by=2,` +
  `pad=720:1280:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=24,format=yuv420p,` +
  `eq=saturation=1.05:contrast=1.02,settb=AVTB,setpts=PTS-STARTPTS[${label}v]`
const normAudio = (label: string) =>
  `[${label}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,asetpts=PTS-STARTPTS[${label}a]`

/**
 * Pure filter-graph builder: N video inputs (opening?, line, closing?) plus
 * one voice track and optional ambience. Cross-fades are 0.25s (6 frames);
 * dip_to_black is a 12-frame fade. Voice at full level, ambience at -18dB
 * fading under the line, loudness about -16 LUFS. Testable without ffmpeg.
 */
export function buildCutGraph(t: {
  hasOpening: boolean
  hasClosing: boolean
  openingS: number
  lineS: number
  closingS: number
  transitionIn: CutTimeline['transitionIn']
  transitionOut: CutTimeline['transitionOut']
  voiceDelayS: number
  voiceS: number
  ambienceS: number | null
  /** Scene shot bedding the ambience ('o' or 'c'); null beds nothing. */
  ambienceLabel: string | null
  /** Input index of the separate voice clip (shots keep play order). */
  voiceLabel: string
}): { filter: string; totalS: number; inputs: number } {
  const labels = [...(t.hasOpening ? ['o'] : []), 'l', ...(t.hasClosing ? ['c'] : [])]
  const durations = [...(t.hasOpening ? [t.openingS] : []), t.lineS, ...(t.hasClosing ? [t.closingS] : [])]
  const parts: string[] = labels.map((l) => normVideo(l))
  // Only the ambience source needs normalized audio: the line's own track is
  // never used (the voice arrives as its own input), and ffmpeg fails on
  // filter outputs nothing consumes.
  if (t.ambienceLabel) parts.push(normAudio(t.ambienceLabel))
  // Whether each join dissolves: into the line iff the director chose
  // `dissolve_short` there, into the closing always. Anything else is a cut.
  const dissolves = labels.slice(1).map((l) =>
    (l === 'l' && t.hasOpening && t.transitionIn === 'dissolve_short') || l === 'c')
  const joins: string[] = []
  let out = `[${labels[0]}v]`
  let offset = durations[0]
  for (let i = 0; i < dissolves.length; i++) {
    const next = `x${i}`
    if (dissolves[i]) {
      const at = (offset - 0.25).toFixed(2)
      joins.push(`${out}[${labels[i + 1]}v]xfade=transition=fade:duration=0.25:offset=${at}[${next}]`)
      offset = offset - 0.25 + durations[i + 1]
    } else {
      joins.push(`${out}[${labels[i + 1]}v]concat=n=2:v=1:a=0[${next}]`)
      offset += durations[i + 1]
    }
    out = `[${next}]`
  }
  const tail = t.transitionOut === 'dip_to_black'
    ? `fade=t=out:st=${(offset - 0.5).toFixed(2)}:d=0.5`
    : 'null'
  joins.push(`${out}${tail}[v]`)
  // Voice: the line's own clip at full level, delayed under the opening tail.
  // It arrives as its own input; the shots' own tracks carry scene sound.
  const totalS = offset
  parts.push(
    `[${t.voiceLabel}:a]atrim=duration=${t.voiceS},aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,asetpts=PTS-STARTPTS,adelay=${Math.round(t.voiceDelayS * 1000)}:all=1,apad,atrim=duration=${totalS.toFixed(2)}[voice]`,
  )
  let audioOut = '[voice]'
  if (t.ambienceS !== null && t.ambienceLabel) {
    // Scene ambience low under the voice, never a voice itself (fallback
    // tracks are dropped before they reach the mixer). The pad is the
    // shot's normalized audio ([oa]/[ca]), never a raw input.
    const ambDur = t.ambienceLabel === 'o' ? t.openingS : t.closingS
    parts.push(
      `[${t.ambienceLabel}a]apad,atrim=duration=${ambDur},asetpts=PTS-STARTPTS,aloop=loop=-1:size=48000,atrim=duration=${totalS.toFixed(2)},volume=0.12589254,afade=t=out:st=${(totalS - t.voiceS).toFixed(2)}:d=${t.voiceS.toFixed(2)}[amb]`,
      '[voice][amb]amix=inputs=2:duration=first:normalize=0[mix]',
    )
    audioOut = '[mix]'
  }
  parts.push(`${audioOut}loudnorm=I=-16:TP=-1.5:LRA=11[a]`)
  const filter = [...parts, ...joins].join(';')
  return { filter, totalS, inputs: labels.length }
}

/** Normalize one shot to the shared cut format (720x1280, 24fps, 48k stereo).
 * A shot with no audio track (Seedance silence) gets a silent bed so every
 * input carries the streams the graph expects. */
export async function normalizeShot(video: Buffer): Promise<Buffer> {
  const [silent, duration] = await Promise.all([
    cutEffects.hasAudio(video).then((has) => !has),
    cutEffects.probeDuration(video),
  ])
  const audioFilter = silent
    ? `anullsrc=r=48000:cl=stereo:d=${duration.toFixed(2)}[a]`
    : '[0:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,asetpts=PTS-STARTPTS[a]'
  const out = await cutEffects.run([
    '-i', 'pipe:0',
    '-filter_complex',
    '[0:v]scale=720:1280:force_original_aspect_ratio=decrease:force_divisible_by=2,' +
    'pad=720:1280:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=24,format=yuv420p,settb=AVTB,setpts=PTS-STARTPTS[v];' +
    audioFilter,
    '-map', '[v]', '-map', '[a]',
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '160k', '-ar', '48000', '-ac', '2',
    '-f', 'mp4', '-movflags', 'frag_keyframe+empty_moov', 'pipe:1',
  ], [video])
  return out
}

/**
 * Assemble the cut from normalized shot buffers plus the voice clip, using
 * the probe's recipe: one resolution, the director's transitions, the J-cut
 * lead-in, our voice full, ambience low and never a voice, ~-16 LUFS, one
 * shared grade. Temp files (mp4+faststart needs a seekable output).
 *
 * Input order is shots in play order, then the voice clip last. Each shot is
 * pre-trimmed to its play duration so joins land where the graph says.
 */
export async function assembleCut(opts: {
  /** Shot videos in play order (opening?, line, closing?), already normalized. */
  shots: Buffer[]
  /** Per-shot play durations; the line entry is pre-trimmed to voice + tail. */
  durations: number[]
  hasOpening: boolean
  hasClosing: boolean
  transitionIn: 'cut' | 'dissolve_short'
  transitionOut: 'cut' | 'dissolve_short' | 'dip_to_black'
  voiceMp3: Buffer
  voiceDelayS: number
  voiceS: number
  /** Which scene shot beds ambience under the voice (null: voice alone). */
  ambienceFrom: 'opening' | 'closing' | null
}): Promise<{ bytes: Buffer; totalS: number }> {
  return withTempDir('everlore-cut-', async (dir) => {
    const args: string[] = []
    for (let i = 0; i < opts.shots.length; i++) {
      const file = join(dir, `shot${i}.mp4`)
      await writeFile(file, opts.shots[i])
      args.push('-t', opts.durations[i].toFixed(2), '-i', file)
    }
    const voiceFile = join(dir, 'voice.mp3')
    await writeFile(voiceFile, opts.voiceMp3)
    args.push('-i', voiceFile)
    const outFile = join(dir, 'cut.mp4')
    const lineIndex = opts.hasOpening ? 1 : 0
    const openingS = opts.hasOpening ? opts.durations[0] : 0
    const lineS = opts.durations[lineIndex]
    const closingS = opts.hasClosing ? opts.durations[opts.durations.length - 1] : 0
    const ambienceLabel = opts.ambienceFrom === 'opening' ? 'o' : opts.ambienceFrom === 'closing' ? 'c' : null
    const { filter, totalS } = buildCutGraph({
      hasOpening: opts.hasOpening,
      hasClosing: opts.hasClosing,
      openingS,
      lineS,
      closingS,
      transitionIn: opts.transitionIn,
      transitionOut: opts.transitionOut,
      voiceDelayS: opts.voiceDelayS,
      voiceS: opts.voiceS,
      ambienceS: ambienceLabel ? (ambienceLabel === 'o' ? openingS : closingS) : null,
      ambienceLabel,
      voiceLabel: String(opts.shots.length),
    })
    args.push(
      '-filter_complex', filter,
      '-map', '[v]', '-map', '[a]', '-t', totalS.toFixed(2),
      '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '160k', '-ar', '48000', '-ac', '2',
      '-movflags', '+faststart', outFile,
    )
    await cutEffects.runFiles(args)
    return { bytes: Buffer.from(await readFile(outFile)), totalS }
  })
}

/** Same normalization, grade, transitions and ambience, without a voice input. */
export async function assembleDialogueFreeCut(opts: {
  shots: Buffer[]
  durations: number[]
  transition: 'cut' | 'dissolve_short' | 'dip_to_black'
}): Promise<{ bytes: Buffer; totalS: number }> {
  if (!opts.shots.length || opts.shots.length > 2) throw new Error('Cut needs one or two shots')
  return withTempDir('everlore-cut-', async (dir) => {
    const args: string[] = [], parts: string[] = []
    for (let i = 0; i < opts.shots.length; i++) {
      const file = join(dir, `shot${i}.mp4`)
      await writeFile(file, opts.shots[i])
      args.push('-t', opts.durations[i].toFixed(2), '-i', file)
      parts.push(normVideo(String(i)), normAudio(String(i)))
    }
    let totalS = opts.durations.reduce((sum, s) => sum + s, 0)
    if (opts.shots.length === 1) {
      parts.push('[0v]null[v]', '[0a]anull[amb]')
    } else if (opts.transition === 'cut') {
      parts.push('[0v][1v]concat=n=2:v=1:a=0[v]', '[0a][1a]concat=n=2:v=0:a=1[amb]')
    } else {
      const fade = opts.transition === 'dip_to_black' ? 0.5 : 8 / 24
      totalS -= fade
      parts.push(`[0v][1v]xfade=transition=${opts.transition === 'dip_to_black' ? 'fadeblack' : 'fade'}:duration=${fade}:offset=${opts.durations[0] - fade}[v]`,
        `[0a][1a]acrossfade=d=${fade}[amb]`)
    }
    parts.push('[amb]volume=0.12589254,loudnorm=I=-16:TP=-1.5:LRA=11[a]')
    const out = join(dir, 'cut.mp4')
    args.push('-filter_complex', parts.join(';'), '-map', '[v]', '-map', '[a]', '-t', totalS.toFixed(2),
      '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '160k', '-ar', '48000', '-ac', '2', '-movflags', '+faststart', out)
    await cutEffects.runFiles(args)
    return { bytes: Buffer.from(await readFile(out)), totalS }
  })
}
