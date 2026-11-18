import { readdirSync, readFileSync } from 'node:fs'
import { isIP } from 'node:net'
import { join } from 'node:path'
import { Reader, type CountryResponse } from 'mmdb-lib'
import { log } from '../utils/logger'

/**
 * Country from a connection address, looked up offline.
 *
 * The database is DB-IP's country-only MMDB, shipped in `data/geo/`. It is
 * loaded once at startup and read by the request that has already parsed the
 * address for rate limiting — no address leaves the process and none is stored
 * or logged here. Only the two-letter code travels on.
 *
 * A missing or unreadable file is not a startup failure: country capture is a
 * nice-to-have in analytics, and a bad deploy of a data file must not take the
 * API down. The lookup disables itself with one warning and `countryOf` answers
 * `undefined`, which callers already treat as "unknown".
 */

const DATABASE_FILE = /^dbip-country-lite-\d{4}-\d{2}\.mmdb$/
const ISO_COUNTRY = /^[A-Z]{2}$/
const GEO_DIR = join(import.meta.dir, '..', '..', 'data', 'geo')

let reader: Reader<CountryResponse> | null = null
let attempted = false
let warned = false

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function warnUnavailable(error?: unknown): void {
  if (warned) return
  warned = true
  log.warn('geo: country lookup disabled', error === undefined ? {} : { error: errorMessage(error) })
}

/** Newest month wins, so the monthly file can be replaced without a code change. */
function databaseFile(directory: string): string | null {
  let names: string[]
  try {
    names = readdirSync(directory)
  } catch {
    return null
  }
  const files = names.filter((name) => DATABASE_FILE.test(name)).sort()
  return files.length > 0 ? join(directory, files[files.length - 1]) : null
}

/**
 * Load the lookup, replacing any previous one. Called once from startup; the
 * first `countryOf` call also loads it lazily so scripts and audits that never
 * boot the server still work.
 */
export function loadCountryLookup(directory: string = GEO_DIR): boolean {
  attempted = true
  reader = null

  const file = databaseFile(directory)
  if (!file) {
    warnUnavailable()
    return false
  }

  try {
    const loaded = new Reader<CountryResponse>(readFileSync(file))
    // A truncated or foreign MMDB can construct but answer nothing. One known
    // address is the cheapest proof that this is a usable country database.
    const probe = loaded.get('8.8.8.8')?.country?.iso_code
    if (!ISO_COUNTRY.test(probe ?? '')) throw new Error('database did not resolve a known address')
    reader = loaded
    return true
  } catch (error) {
    warnUnavailable(error)
    return false
  }
}

/**
 * True for addresses that can never name a player's country: private space,
 * loopback, link-local, multicast and the other reserved blocks. Checked before
 * the database so a reserved address never depends on what the file happens to
 * contain.
 */
export function isPrivateOrReserved(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b] = address.split('.').map(Number)
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a >= 224
    )
  }

  const ip = address.split('%')[0].toLowerCase()
  if (ip === '::' || ip === '::1') return true
  const first = Number.parseInt(ip.split(':')[0] || '0', 16)
  return (
    (first & 0xfe00) === 0xfc00 || // fc00::/7 unique local
    (first & 0xffc0) === 0xfe80 || // fe80::/10 link local
    (first & 0xff00) === 0xff00 // ff00::/8 multicast
  )
}

/** A bare, public IP, or null for anything this feature must not look up. */
function publicAddress(raw: string): string | null {
  let address = raw.trim()
  if (address.startsWith('[')) {
    const end = address.indexOf(']')
    if (end < 0) return null
    address = address.slice(1, end)
  } else {
    const withPort = /^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/.exec(address)
    if (withPort) address = withPort[1]
  }

  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address)
  if (mapped) address = mapped[1]

  if (isIP(address) === 0) return null
  if (isPrivateOrReserved(address)) return null
  return address
}

/**
 * The ISO 3166-1 alpha-2 country of a connection address, when it is public and
 * known. Never throws: an unparsable address, a reserved block, a missing entry,
 * a disabled lookup and a corrupt read all answer `undefined`.
 */
export function countryOf(address: string | null | undefined): string | undefined {
  if (!address) return undefined
  if (!attempted) loadCountryLookup()
  const loaded = reader
  if (!loaded) return undefined

  const ip = publicAddress(address)
  if (!ip) return undefined

  try {
    const code = loaded.get(ip)?.country?.iso_code
    return ISO_COUNTRY.test(code ?? '') ? code : undefined
  } catch {
    return undefined
  }
}
