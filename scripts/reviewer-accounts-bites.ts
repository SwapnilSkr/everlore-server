/** Reversible mutation demonstration. Run only with no other task using these files. */
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'

const mutations = [
  // A loosened rule: a six-digit name starts matching.
  ['a phone-shaped name matches and a name with a letter never does', 'src/services/reviewer-accounts.ts',
    'const MIN_NUMBER_NAME_DIGITS = 7', 'const MIN_NUMBER_NAME_DIGITS = 6'],
  // The rule accepts a name with a letter in it.
  ['a phone-shaped name matches and a name with a letter never does', 'src/services/reviewer-accounts.ts',
    "const NUMBER_NAME_CHARS = /^[+\\d\\s\\-.()]+$/", "const NUMBER_NAME_CHARS = /^[+\\d\\s\\-.()A-Za-z]+$/"],
  // The filter and the pure rule disagree: the regex loses its digit guard.
  ['the Mongo filter and the pure rule agree on the whole sample', 'src/services/reviewer-accounts.ts',
    'const NUMBER_NAME_PATTERN = `^\\\\s*(?=(?:\\\\D*\\\\d){${MIN_NUMBER_NAME_DIGITS}})[+\\\\d\\\\s\\\\-.()]+\\\\s*$`',
    'const NUMBER_NAME_PATTERN = `^[+\\\\d\\\\s\\\\-.()]+$`'],
  // The Players list stops dropping the flagged rows.
  ['/admin/users hides a flagged account by default, total follows, and the switch works',
    'src/services/admin.service.ts',
    "if (reviewers === 'exclude') filter.reviewer = { $ne: true }", "if (reviewers === 'exclude') void 0"],
  // The daily rollup stops leaving reviewer events out.
  ["computeDay leaves a reviewer install's events out but still counts their crash",
    'src/services/telemetry/rollup.service.ts',
    '.find({ at: inDay, ...eventMatch }, {', '.find({ at: inDay }, {'],
  // Metrics stop filtering events by player.
  ['metrics leave a reviewer\'s turns out of players_ever, story_turns and dau',
    'src/services/admin-metrics.service.ts',
    'const storyMatch = { type: { $in: STORY_TURN_TYPES }, ...playerMatch }',
    'const storyMatch = { type: { $in: STORY_TURN_TYPES } }'],
  // The sweep stops asking for the number-name rule.
  ['the sweep flags exactly the matching unflagged rows once', 'src/services/reviewer-accounts.ts',
    '$or: phone ? [phone, numberNameFilter()] : [numberNameFilter()],',
    '$or: phone ? [phone] : [],'],
  // updatePreferences stops flagging a phone-shaped name.
  ['updatePreferences flags a phone-shaped name and not a normal one', 'src/services/auth.service.ts',
    "if (typeof body.player_name === 'string' && reviewerReason({ player_name: body.player_name }) === 'number_name'",
    "if (false && typeof body.player_name === 'string' && reviewerReason({ player_name: body.player_name }) === 'number_name'"],
  // Sessions stop adding the reviewer mark.
  ['sessions hide a reviewer by default and mark them when only reviewers are asked for',
    'src/services/telemetry/analytics.service.ts',
    '...(reviewer ? { reviewer: true as const } : {}),', ''],
  // The funnel stops leaving a review install out of first opens.
  ['the funnel leaves a reviewer guest out of started and their install out of first opens',
    'src/services/telemetry/analytics.service.ts',
    'mongoColl.appInstalls().countDocuments({ first_seen: window, ...notReviewerInstall })',
    'mongoColl.appInstalls().countDocuments({ first_seen: window })'],
] as const

async function audit() {
  const proc = Bun.spawn([process.execPath, '--no-env-file', 'scripts/reviewer-accounts-audit.ts'], {
    stdout: 'pipe', stderr: 'pipe', stdin: 'ignore',
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
  ])
  return { output: stdout + stderr, code }
}

assert.equal((await audit()).code, 0, 'Clean audit must pass before mutation')
for (const [label, file, before, after] of mutations) {
  const original = readFileSync(file, 'utf8')
  assert(original.includes(before), `Mutation target missing: ${label}`)
  try {
    // A replacer function, not a string: these sources contain `$`` and `$'`,
    // which `String.replace` would read as replacement patterns.
    writeFileSync(file, original.replace(before, () => after))
    const result = await audit()
    assert.notEqual(result.code, 0, `Mutation survived: ${label}\n${result.output}`)
    assert(result.output.includes(`FAIL ${label}:`), `Expected check did not bite: ${label}\n${result.output}`)
    console.log(`TAMPER -> exit ${result.code}; FAIL ${label}`)
  } finally {
    writeFileSync(file, original)
  }
  assert.equal((await audit()).code, 0, `Audit failed after restoring: ${label}`)
  console.log('RESTORE -> exit 0; clean audit passed')
}
console.log(`Bite demo: ${mutations.length}/${mutations.length} mutations rejected; every original restored and rechecked.`)
