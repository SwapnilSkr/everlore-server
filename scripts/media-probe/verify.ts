import assert from 'node:assert/strict'
import { resolve, join } from 'node:path'
import { canReserve, checkedCost, exposure } from './budget'

function budgetAudit(reserve: typeof canReserve) {
  const pending = [{ id: 'pending', estimateUsd: 2.9 }]
  assert.equal(reserve(pending, 0.11), false, 'An unresolved request must block an over-cap call')
  assert.equal(reserve(pending, 0.09), true)
  assert.equal(reserve(pending, NaN), false)
  assert.equal(reserve(pending, -1), false)
  assert.equal(reserve([{ id: 'settled', estimateUsd: 2.9, costUsd: 0.2 }], 2.7), true)
}
budgetAudit(canReserve)
let bit = false
try { budgetAudit(() => true) } catch { bit = true }
assert.ok(bit, 'Budget audit must fail when its gate is bypassed')
assert.equal(checkedCost(-1), undefined)
assert.equal(checkedCost(Infinity), undefined)
assert.equal(checkedCost(0), 0)
console.log('PASS budget gate; mutation to always-allow was caught')

const out = resolve(import.meta.dir, '../../../.agents/reports/media-probe')
const results = await Bun.file(join(out, 'results.json')).json()
const calls = results.calls as Array<{ id: string; estimateUsd: number; costUsd?: number; kind: string; file?: string; status: string }>
assert.equal(new Set(calls.map(row => row.id)).size, calls.length, 'No duplicate paid operation IDs')
assert.ok(exposure(calls) <= 3, 'Reservations plus confirmed charges stay under cap')
assert.equal(calls.filter(row => row.kind === 'voice' && row.status === 'completed').length, 24, 'All requested voice clips exist')
const jobs = results.calls as Array<{ kind: string; model: string; jobId?: string }>
for (const model of ['heygen/avatar-iv', 'bytedance/seedance-2.0-mini', 'google/veo-3.1-lite']) {
  assert.equal(new Set(jobs.filter(row => row.model === model && row.jobId).map(row => row.jobId)).size, 1, `Exactly one generated video for ${model}`)
}
const html = await Bun.file(join(out, 'listen.html')).text()
let decoded = 0
for (const row of calls) {
  if (!row.file) continue
  assert.ok(html.includes(row.file), `Missing HTML media reference: ${row.file}`)
  assert.ok(await Bun.file(join(out, row.file)).exists(), `Missing file: ${row.file}`)
  const child = Bun.spawn(['/opt/homebrew/bin/ffmpeg', '-v', 'error', '-i', join(out, row.file), '-f', 'null', '-'], { stdout: 'pipe', stderr: 'pipe' })
  const error = await new Response(child.stderr).text()
  assert.equal(await child.exited, 0, `Cannot fully decode ${row.file}: ${error}`)
  decoded++
}
for (const kind of ['voice', 'portrait', 'picture', 'video']) {
  const group = calls.filter(row => row.kind === kind)
  console.log(`${kind}: ${group.filter(row => row.status === 'completed').length}/${group.length} completed`)
}
console.log(`PASS ${decoded} media files fully decoded; HTML references exist; unique call IDs; exposure $${exposure(calls).toFixed(6)} <= $3.00`)
console.log('Browser playback and subjective quality require the owner; computer access was denied.')
