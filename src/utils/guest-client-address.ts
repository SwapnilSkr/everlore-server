import { isIP } from 'node:net'

/** Only the local reverse proxy may supply a client address. Its appended
 * rightmost hop wins, so a client-supplied forwarded prefix cannot rotate it. */
export function guestClientAddress(peer: string | undefined, forwarded: string | undefined): string {
  const localProxy = peer === '127.0.0.1' || peer === '::1' || peer === '::ffff:127.0.0.1'
  const lastHop = forwarded?.split(',').at(-1)?.trim()
  return localProxy && lastHop && isIP(lastHop) ? lastHop : peer || 'unknown'
}
