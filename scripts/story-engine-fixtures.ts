import { mkdtemp, rm } from 'node:fs/promises'
import { cpSync, readFileSync, writeFileSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'
import { MongoClient } from 'mongodb'

/** Only the mongod this audit starts is ever written to or stopped. */
export async function startTraceAuditMongo() {
  const port = await new Promise<number>(resolve => {
    const server = createServer().listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port
      server.close(() => resolve(port))
    })
  })
  const scratch = await mkdtemp(join(tmpdir(), 'everlore-story-trace-'))
  const process = Bun.spawn(['mongod', '--port', String(port), '--bind_ip', '127.0.0.1', '--dbpath', scratch,
    '--logpath', join(scratch, 'mongo.log')], { stdout: 'ignore', stderr: 'ignore' })
  const uri = `mongodb://127.0.0.1:${port}/trace_audit?directConnection=true`
  let client: MongoClient | undefined
  try {
    const deadline = Date.now() + 10000
    while (Date.now() < deadline) {
      const candidate = new MongoClient(uri, { serverSelectionTimeoutMS: 150 })
      try { await candidate.connect(); client = candidate; break } catch { await candidate.close(); await Bun.sleep(50) }
    }
    if (!client) throw new Error('Isolated mongod did not start')
    const connected = client
    return { db: client.db(), async close() {
      await connected.close()
      process.kill('SIGTERM')
      await process.exited
      await rm(scratch, { recursive: true, force: true })
    } }
  } catch (error) {
    await client?.close()
    process.kill('SIGTERM')
    await process.exited
    await rm(scratch, { recursive: true, force: true })
    throw error
  }
}

export interface TraceAuditMutation { name: string; file: string; before: string; after: string }
/** Mutations run in a source-only scratch copy: shared live files are never
 * temporarily broken, and no env file or credential is copied. */
export async function runTraceAuditBites(audit: string, mutations: TraceAuditMutation[]) {
  const scratch = await mkdtemp(join(tmpdir(), 'everlore-trace-bites-'))
  try {
    for (const dir of ['src', 'worker', 'scripts']) cpSync(dir, join(scratch, dir), {
      recursive: true, filter: path => !path.split('/').at(-1)!.startsWith('.env'),
    })
    cpSync('package.json', join(scratch, 'package.json'))
    symlinkSync(join(process.cwd(), 'node_modules'), join(scratch, 'node_modules'), 'dir')
    for (const mutation of mutations) {
      const path = join(scratch, mutation.file)
      const original = readFileSync(path, 'utf8')
      if (!original.includes(mutation.before)) throw new Error(`Missing bite target: ${mutation.name}`)
      writeFileSync(path, original.replace(mutation.before, mutation.after))
      try {
        const child = Bun.spawn(['bun', '--no-env-file', 'run', audit], { cwd: scratch, stdout: 'pipe', stderr: 'pipe' })
        const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
        if (code === 0) throw new Error(`Bite did not fail: ${mutation.name}`)
        const diagnostic = (stdout + stderr).split('\n').filter(line => /AssertionError|SyntaxError|actual:|expected:|operator:/.test(line)).slice(0, 4).map(line => line.slice(0, 240)).join(' | ')
        if (!diagnostic.includes('AssertionError')) throw new Error(`Bite failed for an unexpected reason: ${mutation.name}\n${stdout}\n${stderr}`)
        console.log(`BITE ${mutation.name}: exit ${code}; ${diagnostic}`)
      } finally { writeFileSync(path, original) }
    }
    console.log(`${mutations.length}/${mutations.length} mutations rejected; scratch sources restored and removed`)
  } finally { await rm(scratch, { recursive: true, force: true }) }
}
