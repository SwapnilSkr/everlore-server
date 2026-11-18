/**
 * Refresh the country database by hand, monthly.
 *
 * DB-IP publishes one MMDB per month under CC BY 4.0. This fetches the newest
 * available month, proves the download is a usable country database (it opens
 * and resolves one known public address to the expected country), and only then
 * replaces the file the server reads. A download that is incomplete, corrupt or
 * the wrong product leaves the current database untouched.
 *
 * Run: `bun --no-env-file run scripts/update-geo-db.ts`
 */
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { Reader, type CountryResponse } from 'mmdb-lib'

const GEO_DIR = join(import.meta.dir, '..', 'data', 'geo')
const SOURCE = 'https://download.db-ip.com/free/dbip-country-lite'
/** The same pair `scripts/geo-country-audit.ts` relies on. */
const KNOWN_ADDRESS = '8.8.8.8'
const EXPECTED_COUNTRY = 'US'
const DATABASE_FILE = /^dbip-country-lite-\d{4}-\d{2}\.mmdb$/
/** Walk back this far when the current month has not been published yet. */
const MONTHS_TO_TRY = 6

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function recentMonths(now = new Date()): string[] {
  return Array.from({ length: MONTHS_TO_TRY }, (_, back) => {
    const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 1))
    return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`
  })
}

/** The reason the file is unusable, or null when it passes. */
function verify(data: Buffer): string | null {
  try {
    const reader = new Reader<CountryResponse>(data)
    if (reader.metadata?.databaseType !== 'DBIP-Country-Lite') {
      return `not a DB-IP country database (${String(reader.metadata?.databaseType)})`
    }
    const code = reader.get(KNOWN_ADDRESS)?.country?.iso_code
    return code === EXPECTED_COUNTRY
      ? null
      : `${KNOWN_ADDRESS} resolved to ${code ?? 'nothing'}, expected ${EXPECTED_COUNTRY}`
  } catch (error) {
    return `does not open: ${message(error)}`
  }
}

async function download(month: string): Promise<Buffer | null> {
  const url = `${SOURCE}-${month}.mmdb.gz`
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(120_000) })
    if (!response.ok) {
      console.log(`geo: ${month} unavailable (${response.status})`)
      return null
    }
    return gunzipSync(new Uint8Array(await response.arrayBuffer()))
  } catch (error) {
    console.log(`geo: ${month} download failed: ${message(error)}`)
    return null
  }
}

async function main(): Promise<void> {
  let month: string | undefined
  let data: Buffer | undefined

  for (const candidate of recentMonths()) {
    const downloaded = await download(candidate)
    if (downloaded) {
      month = candidate
      data = downloaded
      break
    }
  }

  if (!month || !data) {
    console.error(`geo: no database available in the last ${MONTHS_TO_TRY} months; keeping the current file`)
    process.exit(1)
  }

  const problem = verify(data)
  if (problem) {
    console.error(`geo: refusing ${month}: ${problem}; keeping the current file`)
    process.exit(1)
  }

  mkdirSync(GEO_DIR, { recursive: true })
  const target = join(GEO_DIR, `dbip-country-lite-${month}.mmdb`)
  const temporary = `${target}.tmp-${process.pid}`
  try {
    writeFileSync(temporary, data)
    // Read it back from disk: the server will, so a bad write must be caught here.
    const written = verify(readFileSync(temporary))
    if (written) throw new Error(written)
    renameSync(temporary, target)
  } catch (error) {
    rmSync(temporary, { force: true })
    console.error(`geo: could not install ${month}: ${message(error)}; keeping the current file`)
    process.exit(1)
  }

  for (const name of readdirSync(GEO_DIR)) {
    if (DATABASE_FILE.test(name) && name !== basename(target)) {
      rmSync(join(GEO_DIR, name), { force: true })
      console.log(`geo: removed ${name}`)
    }
  }

  console.log(`geo: installed ${basename(target)} (${data.byteLength} bytes); ${KNOWN_ADDRESS} → ${EXPECTED_COUNTRY}`)
}

await main()
