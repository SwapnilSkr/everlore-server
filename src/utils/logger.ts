/** Single place for server logging; extend with levels / sinks later. */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const jsonLines = process.env.LOG_FORMAT === 'json'

function serialize(level: LogLevel, msg: string, fields: Record<string, unknown>): string {
  const ts = new Date().toISOString()
  if (jsonLines) {
    return JSON.stringify({ ts, level, msg, ...fields })
  }
  const extra = Object.entries(fields)
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
    .join(' ')
  return extra ? `${ts} [${level}] ${msg} ${extra}` : `${ts} [${level}] ${msg}`
}

export const log = {
  debug(msg: string, fields: Record<string, unknown> = {}) {
    if (process.env.LOG_LEVEL === 'debug') {
      console.debug(serialize('debug', msg, fields))
    }
  },
  info(msg: string, fields: Record<string, unknown> = {}) {
    console.log(serialize('info', msg, fields))
  },
  warn(msg: string, fields: Record<string, unknown> = {}) {
    console.warn(serialize('warn', msg, fields))
  },
  error(msg: string, fields: Record<string, unknown> = {}) {
    console.error(serialize('error', msg, fields))
  },
}

/** Headers safe to log (no secrets). */
export function publicRequestMeta(request: Request): Record<string, string> {
  const h = request.headers
  const out: Record<string, string> = {}
  const ua = h.get('user-agent')
  if (ua) out.userAgent = ua
  const fwd = h.get('x-forwarded-for')
  if (fwd) out.forwardedFor = fwd
  const auth = h.get('authorization')
  if (auth) out.authorization = auth.startsWith('Bearer ') ? 'Bearer …' : 'present'
  return out
}
