/**
 * Warm the world_derivations cache before players arrive.
 *
 * A new save's two slowest steps are the calendar derivation and the opening
 * place, and both answer only from the world's own text. Computing them once
 * per listed world here means the first player to open it pays neither.
 *
 * Dry run by default: prints how many worlds, how many keys are already cached,
 * how many model calls a run would make and an estimated cost. `--apply` runs
 * it, at most `--max-calls N` calls (default 400), four worlds at a time.
 * Counts only — never world text.
 *
 *   bun --no-env-file run scripts/warm-world-derivations.ts            # dry run
 *   bun --no-env-file run scripts/warm-world-derivations.ts --apply --max-calls 400
 *
 * Cost assumption: both derivations call `AI_MODELS.metadata`, which defaults to
 * `gpt-4o-mini`. The code keeps no per-model token price table — billing prices
 * Ink, and the admin console reads the provider-reported `cost_usd` — so the
 * figure below uses the published gpt-4o-mini rate ($0.15 / 1M input tokens,
 * $0.60 / 1M output tokens) against conservative per-call token estimates.
 */
import { MongoClient } from 'mongodb'
import { derivationKey } from '../src/services/world-derivations.service'
import { deriveCalendarFromPremise } from '../src/services/time.service'
import { deriveOpeningPlace } from '../src/services/opening-place.service'
import { planForWorld, type WorldWarmPlan } from '../src/services/world-warm.service'
import { isWorldListed } from '../src/utils/world-review'
import type { WorldTemplateDoc } from '../src/models/world-template.model'

// Conservative per-call estimates, only for the dry-run figure.
const CALENDAR_CALL_USD = 600 * (0.15 / 1_000_000) + 220 * (0.60 / 1_000_000)
const PLACE_CALL_USD = 120 * (0.15 / 1_000_000) + 12 * (0.60 / 1_000_000)

const CONCURRENCY = 4
const DEFAULT_MAX_CALLS = 400

interface Options { apply: boolean; maxCalls: number }

function parseOptions(argv: string[]): Options {
  const options: Options = { apply: false, maxCalls: DEFAULT_MAX_CALLS }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--apply') options.apply = true
    else if (arg === '--max-calls') {
      const value = Number(argv[++i])
      if (!Number.isInteger(value) || value < 0) throw new Error('--max-calls needs a non-negative integer')
      options.maxCalls = value
    } else throw new Error(`Unknown option: ${arg}`)
  }
  return options
}

async function main() {
  const options = parseOptions(Bun.argv.slice(2))
  const uri = process.env.MONGODB_URI
  if (!uri) throw new Error('MONGODB_URI is not set.')

  const client = new MongoClient(uri)
  try {
    await client.connect()
    const db = client.db()
    const worlds = await db
      .collection<WorldTemplateDoc>('world_templates')
      .find({ is_published: true, kind: { $ne: 'group' }, moderation_status: { $ne: 'hidden' } })
      .toArray()
    // The catalog's own gate, applied in code so the warm set is exactly what
    // discovery would show.
    const listed = worlds.filter((world) => isWorldListed(world))
    const derivations = db.collection('world_derivations')

    const plans: WorldWarmPlan[] = []
    let cachedKeys = 0
    let calendarMissing = 0
    let openingMissing = 0
    for (const world of listed) {
      const plan = planForWorld(world)
      if (!plan.calendarInput && !plan.openingInput) continue
      plans.push(plan)
      if (plan.calendarInput) {
        if (await derivations.findOne({ _id: derivationKey('calendar', plan.calendarInput) }, { projection: { _id: 1 } })) cachedKeys++
        else calendarMissing++
      }
      if (plan.openingInput) {
        if (await derivations.findOne({ _id: derivationKey('opening_place', plan.openingInput) }, { projection: { _id: 1 } })) cachedKeys++
        else openingMissing++
      }
    }

    const missing = calendarMissing + openingMissing
    const cost = calendarMissing * CALENDAR_CALL_USD + openingMissing * PLACE_CALL_USD
    console.log(`Worlds listed: ${listed.length} (with derivable text: ${plans.length})`)
    console.log(`Derivation keys: ${cachedKeys} cached, ${missing} missing (${calendarMissing} calendar, ${openingMissing} opening place)`)
    console.log(`Model calls a run would make: ${missing}`)
    console.log(`Estimated cost: $${cost.toFixed(4)} at gpt-4o-mini rates (gpt-4o-mini-token assumption)`)
    if (missing > options.maxCalls) console.log(`Hard cap ${options.maxCalls} calls per run; the rest wait for a later run.`)

    if (!options.apply) {
      console.log('Dry run. Re-run with --apply to fill the cache.')
      return
    }

    // Stored through this script's own connection: the server's `mongoColl`
    // is never connected here, so `cachedDerivation` would pay for each call
    // and then fail to keep it. Same document shape and rule (only an answer
    // the model actually gave is kept) as world-derivations.service.
    async function store(kind: 'calendar' | 'opening_place', input: string, value: unknown, cacheable: boolean): Promise<boolean> {
      if (!cacheable) return false
      const key = derivationKey(kind, input)
      await derivations.updateOne(
        { _id: key as never },
        { $setOnInsert: { _id: key, kind, value, created_at: new Date() } },
        { upsert: true },
      )
      return true
    }

    // Each world makes at most two calls; the cap is a hard ceiling on calls.
    let spent = 0
    let warmed = 0
    const queue = [...plans]
    async function worker() {
      for (;;) {
        const plan = queue.shift()
        if (!plan || spent >= options.maxCalls) return

        if (plan.calendarInput && spent < options.maxCalls) {
          const input = plan.calendarInput
          // Whichever path runs, it is one call when the key is missing; a hit
          // is free and costs no budget, which a re-run relies on.
          if (!(await derivations.findOne({ _id: derivationKey('calendar', input) }, { projection: { _id: 1 } }))) {
            spent++
            const { spec, cacheable } = await deriveCalendarFromPremise(input)
            if (await store('calendar', input, spec, cacheable)) warmed++
          }
        }
        if (plan.openingInput && spent < options.maxCalls) {
          const input = plan.openingInput
          if (!(await derivations.findOne({ _id: derivationKey('opening_place', input) }, { projection: { _id: 1 } }))) {
            spent++
            const { value, cacheable } = await deriveOpeningPlace(input)
            if (await store('opening_place', input, value, cacheable)) warmed++
          }
        }
      }
    }
    await Promise.all(Array.from({ length: CONCURRENCY }, worker))
    console.log(`Warmed ${warmed} derivation${warmed === 1 ? '' : 's'} in ${spent} model call${spent === 1 ? '' : 's'} (the rest were failed or unusable answers, retried next run).`)
  } finally {
    await client.close()
  }
}

if (import.meta.main) {
  try { await main(); process.exit(0) }
  catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exit(1) }
}
