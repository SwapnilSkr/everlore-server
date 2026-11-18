/**
 * Country hints for players seen before country capture existed
 * (`everlore-docs/phases/admin-insights.md`, "Country for players seen before
 * capture").
 *
 * The same pass the maintenance job runs, over every account rather than the
 * day's batch: the region of the stored phone number (which wins), else the
 * region of the latest app session's locale. It never writes `country` and
 * never writes an empty value — no signal means no key.
 *
 *   bun --no-env-file scripts/backfill-country-hint.ts --dry-run
 *   bun scripts/backfill-country-hint.ts --apply
 *
 * `--dry-run` writes nothing at all. The orchestrator runs `--apply` after a
 * deploy, with the owner's OK.
 */
import { internalAccounts, type CountryHintReport } from '../src/services/internal-accounts'

export type BackfillOptions = { apply: boolean }

/** `--dry-run` (the default) reads only; `--apply` writes. Anything else is refused. */
export function parseBackfillArgs(argv: string[]): BackfillOptions {
  let apply = false
  let dryRun = false
  for (const arg of argv) {
    if (arg === '--apply') apply = true
    else if (arg === '--dry-run') dryRun = true
    else throw new Error(`Unknown argument ${arg}. Use --dry-run or --apply.`)
  }
  if (apply && dryRun) throw new Error('Use either --dry-run or --apply, not both.')
  return { apply }
}

export function summarize(report: CountryHintReport, apply: boolean): string {
  const verb = apply ? 'wrote' : 'would write'
  return `country hints: ${report.checked} account(s) read, ${verb} ${report.changed} hint(s)`
}

if (import.meta.main) {
  try {
    const options = parseBackfillArgs(process.argv.slice(2))
    // Loaded here, not at the top: the audit imports this file with a fake
    // database module that has no connect.
    const { connectMongo } = await import('../src/config/mongo')
    await connectMongo()
    const report = await internalAccounts.backfillCountryHints(options)
    console.log(summarize(report, options.apply))
    for (const row of report.rows.slice(0, 50)) console.log(`  ${row.id}  ${row.code ?? '(none)'}  ${row.source ?? '-'}`)
    if (report.rows.length > 50) console.log(`  … ${report.rows.length - 50} more`)
    if (!options.apply) console.log('Dry run: nothing was written. Re-run with --apply to write these hints.')
    process.exit(0)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}
