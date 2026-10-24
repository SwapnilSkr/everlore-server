/** Reversible mutation demonstration. Run only with no other task using these files. */
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'

/**
 * Each mutation strips the auth gate from a router, which must make the guard
 * audit fail; the file is then restored byte-for-byte and the audit must pass
 * again.
 *
 * `admin.routes.ts` belongs to another session, so its mutation is a read and a
 * restore: the restored bytes are compared before anything else runs.
 */
const mutations = [
  {
    label: 'persona routes are gated by requireAdmin',
    file: 'src/routes/admin-persona.routes.ts',
    before: '.use(requireAdmin)',
    after: '/* deliberately removed admin gate */',
    expect: 'FAIL GET /admin/personas/ rejects an unconfigured server with 503',
  },
  {
    label: 'admin routes are gated by requireAdmin',
    file: 'src/routes/admin.routes.ts',
    before: '.use(requireAdmin)',
    after: '/* deliberately removed admin gate */',
    expect: 'FAIL GET /admin/metrics rejects an unconfigured server with 503',
  },
] as const

async function audit() {
  const proc = Bun.spawn([process.execPath, '--no-env-file', 'scripts/admin-route-guard-audit.ts'], {
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: 'ignore',
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { output: stdout + stderr, code }
}

assert.equal((await audit()).code, 0, 'Clean audit must pass before mutation')
for (const { label, file, before, after, expect } of mutations) {
  const original = readFileSync(file, 'utf8')
  assert(original.includes(before), `Mutation target missing: ${label}`)
  try {
    writeFileSync(file, original.replace(before, after))
    const result = await audit()
    assert.notEqual(result.code, 0, `Mutation survived: ${label}`)
    assert(result.output.includes(expect), `Expected check did not bite: ${label}\n${result.output}`)
    console.log(`TAMPER -> exit ${result.code}; ${expect}`)
  } finally {
    writeFileSync(file, original)
  }
  assert.equal(readFileSync(file, 'utf8'), original, `Restore was not byte-for-byte: ${file}`)
  assert.equal((await audit()).code, 0, `Audit failed after restoring: ${label}`)
  console.log(`RESTORE -> ${file} byte-for-byte; exit 0; clean audit passed`)
}
console.log(
  `Bite demo: ${mutations.length}/${mutations.length} mutations rejected; every original restored and rechecked.`,
)
