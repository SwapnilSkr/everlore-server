/** Reversible mutation demonstration. Run only with no other task using these files. */
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'

const mutations = [
  ['both overview routes are guarded when admin credentials are unset', 'src/routes/admin-overview.routes.ts', '.use(requireAdmin)', '/* deliberately removed admin gate */'],
  ['an upstream error message never reaches the body', 'src/services/admin-health.service.ts', "} catch {\n    return { ...identity, status: 'down', detail: DOWN_DETAIL }", "} catch (error) {\n    return { ...identity, status: 'down', detail: String(error) }"],
  ['live players counts only the last ten minutes', 'src/services/admin-overview-summary.service.ts', '10 * 60_000', '12 * 60_000'],
  ["spend sums today's traced calls, and no calls is no figure, not $0", 'src/services/admin-overview-summary.service.ts', 'if (spend.calls === 0) return', 'if (spend.calls < 0) return'],
  // Grade the cold pair instead of the warm second call.
  ['a cold first pinecone ping does not make the check down', 'src/services/admin-health.service.ts', '      await ping()\n      const started = performance.now()\n      await ping()', '      const started = performance.now()\n      await ping()\n      await ping()'],
  // A failed ping reports healthy.
  ['a throwing pinecone ping is down with the fixed sentence', 'src/services/admin-health.service.ts', "    return { ...identity, status: 'down', detail: DOWN_DETAIL }\n  }\n  return { ...identity, status: measured", "    return { ...identity, status: 'ok', detail: DOWN_DETAIL }\n  }\n  return { ...identity, status: measured"],
  // No deadline over the pair.
  ['a pinecone pair over its deadline is down', 'src/services/admin-health.service.ts', '    }, timeoutMs)', '    }, 1e9)'],
  // A slow warm call is not allowed to be slow.
  ['a warm pinecone ping over 1.5 s is degraded', 'src/services/admin-health.service.ts', 'const PINECONE_DEGRADED_MS = 1500', 'const PINECONE_DEGRADED_MS = 150_000'],
  // Ignore the completed scan: an old failure reads as current trouble.
  ['a job name that completed again is not failing now', 'src/services/admin-health.service.ts', 'for (const job of completed) note(job, false)', 'void completed'],
  // Ignore the failure scan: nothing fails now.
  ['a job name whose newest run failed is failing now', 'src/services/admin-health.service.ts', 'for (const job of failed) note(job, true)', 'void failed'],
  // Count failures instead of distinct job names.
  ['failing now counts names, not failures', 'src/services/admin-health.service.ts', 'return [...newest.values()].filter((run) => run.failed).length', 'return failed.filter((job) => typeof job.finishedOn === \'number\' && job.finishedOn >= since).length'],
] as const

async function audit() {
  const proc = Bun.spawn([process.execPath, '--no-env-file', 'scripts/audit-admin-overview.ts'], { stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' })
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
  return { output: stdout + stderr, code }
}

assert.equal((await audit()).code, 0, 'Clean audit must pass before mutation')
for (const [label, file, before, after] of mutations) {
  const original = readFileSync(file, 'utf8')
  assert(original.includes(before), `Mutation target missing: ${label}`)
  try {
    writeFileSync(file, original.replace(before, after))
    const result = await audit()
    assert.notEqual(result.code, 0, `Mutation survived: ${label}`)
    assert(result.output.includes(`FAIL ${label}:`), `Expected check did not bite: ${label}\n${result.output}`)
    console.log(`TAMPER -> exit ${result.code}; FAIL ${label}`)
  } finally {
    writeFileSync(file, original)
  }
  assert.equal((await audit()).code, 0, `Audit failed after restoring: ${label}`)
  console.log('RESTORE -> exit 0; clean audit passed')
}
console.log(`Bite demo: ${mutations.length}/${mutations.length} mutations rejected; every original restored and rechecked.`)
