import { createHash } from 'node:crypto'
import type { AppErrorClass, NormalizedFrame } from './types'

/**
 * §2.8 — the identity of an error, stable across unrelated edits.
 *
 * The key is the exception type plus the *shape* of the top of the in-app stack:
 * `file#symbol`, no line numbers. Adding a line above the throw site shifts every
 * line in the file and must not create a second group; moving the throw into a
 * different function must.
 *
 * In-app means `package:everlore/`. A stack that never enters our code (a plugin,
 * a framework assertion) has nothing in-app to key on, so it falls back to the
 * top three frames of whatever package it did go through — otherwise every such
 * error would collapse into one group per exception type.
 *
 * `server_5xx` is the exception to the rule (§4.5): a server fault is identified
 * by the route and status the player saw, not by Dart frames, which would put
 * two different failures on the same endpoint into two groups for no reason.
 */
function sha1(input: string): string {
  return createHash('sha1').update(input).digest('hex')
}

/** A frame as `file#symbol`, which is what the fingerprint hashes. */
export function frameKey(frame: NormalizedFrame): string {
  return `${frame.file}#${frame.symbol}`
}

export type FingerprintableError = {
  type: string
  frames: NormalizedFrame[]
  http?: { status: number; route: string }
}

export function fingerprintError(error: FingerprintableError, cls: AppErrorClass): string {
  if (cls === 'server_5xx') {
    return sha1(`server_5xx|${error.http?.route ?? ''}|${error.http?.status ?? 0}`)
  }

  const inApp = error.frames.filter((f) => f.file.startsWith('package:everlore/')).slice(0, 3)
  const frames = (inApp.length > 0 ? inApp : error.frames.slice(0, 3)).map(frameKey)
  return sha1([error.type, ...frames].join('\n'))
}

/** Human-readable "where", shown under the title in the console. */
export function topFrameOf(error: FingerprintableError, cls: AppErrorClass): string | undefined {
  if (cls === 'server_5xx') {
    return error.http ? `${error.http.route} · ${error.http.status}` : undefined
  }
  const inApp = error.frames.find((f) => f.file.startsWith('package:everlore/'))
  const frame = inApp ?? error.frames[0]
  return frame ? frameKey(frame) : undefined
}
