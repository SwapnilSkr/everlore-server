/**
 * Proves `scripts/admin-insights-2-audit.ts` catches a broken part 2.
 *
 * Each mutation breaks one rule in a source-only scratch copy (never the live
 * tree, and no env file or credential is copied), runs the audit there, and
 * requires it to fail on its own assertion. The scratch copy is removed at the
 * end; the real files are never touched.
 *
 * Run: `bun --no-env-file run scripts/admin-insights-2-audit-bites.ts`.
 */
import assert from 'node:assert/strict'
import { cpSync, readFileSync, writeFileSync, symlinkSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

type Mutation = {
  name: string
  file: string
  before: string
  after: string
  expect: string
  /** Which audit must fail; part 1 by default is part 2's script. */
  audit?: string
}

const MUTATIONS: Mutation[] = [
  {
    name: 'audience gender split',
    file: 'src/services/admin-audience.ts',
    before: "gender[playerGender ?? 'unset']++",
    after: "gender[playerGender ?? 'unset'] += 0",
    expect: 'gender split over active players',
  },
  {
    name: 'audience population window',
    file: 'src/services/admin-audience.ts',
    before: 'const match: Record<string, unknown> = { started_at: { $gte: from }, user_id: { $exists: true } }',
    after: 'const match: Record<string, unknown> = { user_id: { $exists: true } }',
    expect: 'population is the accounts with a session in the window',
  },
  {
    name: 'latest session wins',
    file: 'src/services/admin-audience.ts',
    before: "{ $sort: { started_at: -1 } },\n    { $group: { _id: '$user_id', app_version: { $first: '$app_version' }, device: { $first: '$device' } } },",
    after: "{ $sort: { started_at: 1 } },\n    { $group: { _id: '$user_id', app_version: { $first: '$app_version' }, device: { $first: '$device' } } },",
    expect: 'devices use each player',
  },
  {
    name: 'interests counts',
    file: 'src/services/admin-audience.ts',
    before: 'interests.set(interest, (interests.get(interest) ?? 0) + 1)',
    after: 'interests.set(interest, interests.get(interest) ?? 1)',
    expect: 'interests count every key held',
  },
  {
    name: 'adult from preferences',
    file: 'src/services/admin-audience.ts',
    before: 'if (user.preferences?.nsfw_enabled === true) adult.on++',
    after: 'if (user.preferences?.nsfw_enabled === false) adult.on++',
    expect: 'adult on/off',
  },
  {
    name: 'genre of the played world',
    file: 'src/services/admin-audience.ts',
    before: 'const genre = genreByTemplate.get(idString(templateId))\n    if (!genre) continue',
    after: 'const genre = genreByTemplate.get(idString(templateId)) ?? "unset"',
    expect: 'genres are the world',
  },
  {
    name: 'day-1 eligibility edge',
    file: 'src/services/admin-audience.ts',
    before: '    if (since >= 1) {\n      d1.eligible++',
    after: '    if (since >= 0) {\n      d1.eligible++',
    expect: 'return_d1: eligible from the day after signup',
  },
  {
    name: 'day-7 window upper bound',
    file: 'src/services/admin-audience.ts',
    before: 'for (let offset = 7; offset <= 13 && offset <= since; offset++) {',
    after: 'for (let offset = 7; offset <= 14 && offset <= since; offset++) {',
    expect: 'return_d7',
  },
  {
    name: 'repeat collapsing',
    file: 'src/services/telemetry/paths.service.ts',
    before: 'return steps.filter((step, index) => step !== steps[index - 1])',
    after: 'return steps',
    expect: 'consecutive repeats collapse',
  },
  {
    name: '100-step start rule',
    file: 'src/services/telemetry/paths.service.ts',
    before: '  if (path.length >= MAX_STEPS) return null',
    after: '  if (path.length >= MAX_STEPS + 1) return null',
    expect: '100-step session',
  },
  {
    name: 'exit depth',
    file: 'src/services/telemetry/paths.service.ts',
    before: 'collapsed.slice(-EXIT_DEPTH)',
    after: 'collapsed.slice(-EXIT_DEPTH - 1)',
    expect: 'an exit is the last three screens',
  },
  {
    name: 'paths reviewer scope',
    file: 'src/services/telemetry/paths.service.ts',
    before: 'const filter = scope.length > 0 ? { $and: [match, ...scope] } : match',
    after: 'const filter = match',
    expect: 'paths read sessions by last_at',
  },
  {
    name: 'retention Monday boundary',
    file: 'src/services/admin-insights.ts',
    before: 'const offset = (new Date(day).getUTCDay() + 6) % 7',
    after: 'const offset = new Date(day).getUTCDay()',
    expect: 'retention: four Monday cohorts',
  },
  {
    name: 'retention future week null',
    file: 'src/services/admin-overview-retention.service.ts',
    before: '        if (start > todayStart) {\n          active.push(null)\n          continue\n        }',
    after: '        if (start > todayStart + 365 * DAY_MS) {\n          active.push(null)\n          continue\n        }',
    expect: 'a week not yet reached is null',
  },
  {
    name: 'groups active means a turn',
    file: 'src/services/admin-overview-groups.service.ts',
    before: 'groups_active: turnedGroups.size,',
    after: 'groups_active: perGroup.size,',
    expect: 'a group whose only window calls had no turn is not active',
  },
  {
    name: 'part 1 turns skip group saves',
    file: 'src/services/admin-insights-billing.ts',
    before: "  const turns = turnRows.reduce((sum, row) => sum + Number(row.turns ?? 0), 0)",
    after: "  const turns = solo_turns",
    expect: 'group world counts saves on group_template_id',
    audit: 'scripts/admin-insights-audit.ts',
  },
  {
    name: 'part 1 world cost from generation_logs field',
    file: 'src/services/admin-insights-worlds.ts',
    before: "      { $group: { _id: '$instance_id', cost_usd: { $sum: { $ifNull: ['$cost_usd', 0] } } } },",
    after: "      { $group: { _id: '$instance_id', cost_usd: { $sum: { $ifNull: ['$turn_cost_usd', 0] } } } },",
    expect: 'cost is the last 30 days of model calls only',
    audit: 'scripts/admin-insights-audit.ts',
  },
  {
    name: 'groups turns from events',
    file: 'src/services/admin-overview-groups.service.ts',
    before: '      group.turns += turns\n',
    after: '      group.turns += 0\n',
    expect: 'groups: totals over group saves',
  },
  {
    name: 'group cost from calls',
    file: 'src/services/admin-overview-groups.service.ts',
    before: 'groupEntry(template).cost += Number(row.cost_usd ?? 0)',
    after: 'groupEntry(template).cost += 0',
    expect: 'groups: totals over group saves',
  },
]

const root = await mkdtemp(join(tmpdir(), 'everlore-admin-insights-2-bites-'))
try {
  for (const dir of ['src', 'worker', 'scripts']) {
    cpSync(dir, join(root, dir), {
      recursive: true,
      filter: (path) => !path.split('/').at(-1)!.startsWith('.env'),
    })
  }
  cpSync('package.json', join(root, 'package.json'))
  symlinkSync(join(process.cwd(), 'node_modules'), join(root, 'node_modules'), 'dir')

  let failed = 0
  for (const mutation of MUTATIONS) {
    const path = join(root, mutation.file)
    const original = readFileSync(path, 'utf8')
    assert.equal(original.split(mutation.before).length, 2, `exactly one target for: ${mutation.name}`)
    writeFileSync(path, original.replace(mutation.before, mutation.after))
    try {
      const child = Bun.spawn(['bun', '--no-env-file', 'run', mutation.audit ?? 'scripts/admin-insights-2-audit.ts'], {
        cwd: root, stdout: 'pipe', stderr: 'pipe', stdin: 'ignore',
      })
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ])
      const output = stdout + stderr
      if (code === 0) throw new Error(`Bite did not fail: ${mutation.name}`)
      const bitten = output.includes(mutation.expect)
      if (!bitten) {
        throw new Error(`Bite failed for the wrong reason: ${mutation.name}\n${output.split('\n').slice(-30).join('\n')}`)
      }
      console.log(`BITE ${mutation.name}: exit ${code}; ${mutation.expect}`)
    } catch (error) {
      failed++
      console.error((error as Error).message)
    } finally {
      writeFileSync(path, original)
    }
  }

  if (failed > 0) {
    console.error(`\n${failed}/${MUTATIONS.length} bites did not land`)
    process.exitCode = 1
  } else {
    console.log(`\n${MUTATIONS.length}/${MUTATIONS.length} mutations rejected; scratch sources restored and removed`)
  }
} finally {
  await rm(root, { recursive: true, force: true })
}
