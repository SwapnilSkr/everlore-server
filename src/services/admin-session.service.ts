import { createHash, randomBytes, timingSafeEqual } from 'crypto'
import { getRedisClient } from '../config/redis'

/**
 * Server-side sessions for the admin console.
 *
 * The console used to hold the Basic-auth username and password in
 * `sessionStorage` and attach them to every request. That works, but it means
 * the credential itself is sitting in a place JavaScript can read: any script
 * injection on the console's origin — a compromised dependency, a stored value
 * rendered as markup — walks off with the *permanent* admin password, not a
 * revocable handle to one session.
 *
 * A session token in an httpOnly cookie inverts that. The browser attaches it
 * automatically and no script on the page can read it, so injected code can at
 * most act as the admin for as long as that one session lives, and the session
 * can be revoked without changing the password everywhere it is configured.
 */

export const SESSION_COOKIE = 'everlore_admin_session'

/** Sessions expire this long after their last use. */
const IDLE_TTL_SECONDS = 2 * 60 * 60

/**
 * And this long after they were created, no matter how active they are, so a
 * stolen cookie cannot be kept alive indefinitely by using it.
 */
const ABSOLUTE_TTL_SECONDS = 12 * 60 * 60

type SessionRecord = {
  username: string
  createdAt: number
}

/**
 * Redis stores the SHA-256 of the token, never the token itself.
 *
 * The raw token is a bearer credential: anyone holding it is the admin. Keying
 * by its hash means a leaked Redis dump — a backup, an errant `KEYS *`, a
 * misconfigured instance — yields no usable sessions, the same reason password
 * digests are stored rather than passwords.
 */
function keyFor(token: string): string {
  return `admin:session:${createHash('sha256').update(token).digest('hex')}`
}

export async function createSession(username: string): Promise<string> {
  const token = randomBytes(32).toString('base64url')
  const record: SessionRecord = { username, createdAt: Date.now() }
  await getRedisClient().set(keyFor(token), JSON.stringify(record), 'EX', IDLE_TTL_SECONDS)
  return token
}

/**
 * Returns the session's username, or null if the token is unknown, expired, or
 * past its absolute deadline. Refreshes the idle window on success.
 */
export async function readSession(token: string): Promise<string | null> {
  if (!token) return null
  const redis = getRedisClient()
  const key = keyFor(token)
  const raw = await redis.get(key)
  if (!raw) return null

  let record: SessionRecord
  try {
    record = JSON.parse(raw)
  } catch {
    await redis.del(key)
    return null
  }

  const age = (Date.now() - record.createdAt) / 1000
  if (age > ABSOLUTE_TTL_SECONDS) {
    await redis.del(key)
    return null
  }

  // Sliding idle window, clamped so it can never push past the absolute
  // deadline: an active operator is not logged out mid-task, and a session
  // still dies at a fixed, knowable time.
  const remaining = Math.floor(ABSOLUTE_TTL_SECONDS - age)
  await redis.expire(key, Math.min(IDLE_TTL_SECONDS, Math.max(remaining, 1)))
  return record.username
}

export async function destroySession(token: string): Promise<void> {
  if (!token) return
  await getRedisClient().del(keyFor(token))
}

/** Reads one cookie out of a raw `Cookie` header. */
export function readCookie(header: string | undefined, name: string): string {
  if (!header) return ''
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq < 0) continue
    if (part.slice(0, eq).trim() !== name) continue
    return decodeURIComponent(part.slice(eq + 1).trim())
  }
  return ''
}

/**
 * `Secure` is decided from the request rather than a config flag.
 *
 * A `Secure` cookie is silently dropped over plain HTTP, which would make local
 * development mysteriously unable to stay signed in; hardcoding it off would
 * ship a session cookie that travels in the clear. The proxy header is checked
 * first because TLS terminates ahead of this process in production.
 */
export function isSecureRequest(headers: Record<string, string | undefined>, request: Request): boolean {
  const proto = headers['x-forwarded-proto']?.split(',')[0]?.trim()
  if (proto) return proto === 'https'
  return new URL(request.url).protocol === 'https:'
}

export function sessionCookie(token: string, secure: boolean): string {
  return [
    `${SESSION_COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    secure ? 'Secure' : '',
    `Max-Age=${IDLE_TTL_SECONDS}`,
  ]
    .filter(Boolean)
    .join('; ')
}

export function clearedSessionCookie(secure: boolean): string {
  return [
    `${SESSION_COOKIE}=`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    secure ? 'Secure' : '',
    'Max-Age=0',
  ]
    .filter(Boolean)
    .join('; ')
}

export function constantTimeEqual(a: string, b: string): boolean {
  const left = createHash('sha256').update(a).digest()
  const right = createHash('sha256').update(b).digest()
  return timingSafeEqual(left, right)
}
