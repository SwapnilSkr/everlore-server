/** Reversible mutation demonstration. Run only with no other task using these files. */
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'

const mutations = [
  ['config overrides env including false', 'src/services/billing-config.service.ts', 'if (doc.promo) base.promo', 'if (doc.promo?.unlimited) base.promo'],
  ['absent promo uses env and null attribution', 'src/services/billing-config.service.ts', "source: 'env', updated_at: null", "source: 'config', updated_at: null"],
  ['partial first save seeds missing promo values, later saves preserve keys', 'src/services/billing-config.service.ts', 'daily_turn_cap: env.INK_PROMO_DAILY_TURN_CAP,\n    }]', 'daily_turn_cap: env.INK_PROMO_DAILY_TURN_CAP + 1,\n    }]' ],
  ['promo validation rejects strings, nulls, fractions and out of range', 'src/services/billing-config.service.ts', "'unlimited' in promo && typeof promo.unlimited !== 'boolean'", "false && 'unlimited' in promo && typeof promo.unlimited !== 'boolean'"],
  ['reserve promo on is free, idempotent and capped with enforcement off', 'src/services/billing.service.ts', 'const cost = promo ? 0 : config.costs[action]', 'const cost = promo ? 1 : config.costs[action]'],
  ['reserve promo off uses configured cost and tier cap', 'src/services/billing.service.ts', 'const cost = promo ? 0 : config.costs[action]', 'const cost = promo ? 0 : config.costs[action] + 1'],
  ['reserve promo on is free, idempotent and capped with enforcement off', 'src/services/billing.service.ts', '? config.promo.daily_turn_cap', '? config.promo.daily_turn_cap + 1'],
  ['reserve promo off uses configured cost and tier cap', 'src/services/billing.service.ts', '(await profileForPlayer(await tierFor(playerOid), playerOid)).daily_story_safety_cap', '(await profileForPlayer(await tierFor(playerOid), playerOid)).daily_story_safety_cap + 1'],
  ['last active conditional predicate throttles across workers', 'src/services/last-active.service.ts', '5 * 60_000', '4 * 60_000'],
  ['UTC day series includes empty days, month boundary and today', 'src/services/admin-metrics.service.ts', '(days - i - 1) * DAY_MS', '(days - i) * DAY_MS'],
  ['days default, boundaries and invalid values', 'src/services/admin-metrics.service.ts', 'value === undefined) return 30', 'value === undefined) return 31'],
  ['UTF-16LE BOM install CSV handles quotes, commas, CRLF and zero', 'src/services/play-installs.service.ts', "new TextDecoder('utf-16le'", "new TextDecoder('utf-8'"],
  ['installs unavailable never throws and is cached for six hours', 'src/services/play-installs.service.ts', '6 * 60 * 60_000', '1 * 60 * 60_000'],
  ['installs unavailable never throws and is cached for six hours', 'src/services/play-installs.service.ts', '} catch {\n        // Never expose', '} catch (error) {\n        throw error\n        // Never expose'],
  ['installs fetch discovers existing months and contains network failures', 'src/services/play-installs.service.ts', "name === `${prefix}${month}_overview.csv`", "name === `${prefix}${month}_country.csv`"],
  ['story activity includes all generated turn kinds and excludes side chats', 'src/services/admin-activity.ts', "'travel', 'calendar_tick'", "'side_chat', 'calendar_tick'"],
  ['activity compound indexes coexist despite different key order', 'src/config/mongo-indexes.ts', 'ek[i] !== dk[i] || existing[dk[i]] !== desired[dk[i]]', 'existing[dk[i]] !== desired[dk[i]]'],
  ['metrics route is guarded by scoped admin auth', 'src/routes/admin.routes.ts', '.use(requireAdmin)', '/* deliberately removed admin gate */'],
  ['onboarding mapper defaults skipped fields and completion follows name', 'src/services/admin-onboarding.ts', 'player_name || null', "player_name || ''"],
  ['onboarding mapper defaults skipped fields and completion follows name', 'src/services/admin-onboarding.ts', 'completed: Boolean(name)', 'completed: true'],
  ['onboarding gender buckets include skipped and sort by descending count', 'src/services/admin-onboarding.ts', "'$preferences.gender', 'skipped'", "'$preferences.gender', null"],
  ['since validates ISO dates and rejects invalid calendar dates', 'src/services/admin-onboarding.ts', 'validDay.toISOString().slice(0, 10) !== calendarDay', 'false'],
  ['user routes combine since search sort and attach onboarding to list and detail', 'src/controllers/admin.controller.ts', 'since: query.since', 'since: undefined'],
] as const

async function audit() {
  const proc = Bun.spawn([process.execPath, '--no-env-file', 'scripts/audit-admin-ops.ts'], { stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' })
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
