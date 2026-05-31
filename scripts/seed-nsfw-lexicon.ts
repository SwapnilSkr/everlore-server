/**
 * Seed the `nsfw_lexicon` collection used by the narration router (worker/lib/
 * nsfw-classifier.ts) to decide whether a turn should route to the explicit model.
 *
 * Sources:
 *  1. CURATED — hand-authored, high-signal sexual terms/phrases (weight 1-2).
 *     These drive routing. Graphical anatomy/acts/fluids = weight 2; ambiguous
 *     or mild = weight 1 (a single weight-2 hit is below the router threshold,
 *     so lone ambiguous words like "wet"/"ride" can't trip it on their own).
 *  2. LDNOOBW — the public "List of Dirty, Naughty, Obscene, and Otherwise Bad
 *     Words" (Shutterstock, CC). Imported for completeness so the collection
 *     doubles as a moderation dictionary. Sexual roots get weight 1; general
 *     profanity/slurs/brands are stored at weight 0 (NOT used for routing).
 *
 * Idempotent: upserts on `term`. Curated entries always win over LDNOOBW.
 *
 * Run:  bun run scripts/seed-nsfw-lexicon.ts
 *       bun run scripts/seed-nsfw-lexicon.ts --no-fetch   (curated only, offline)
 */
import { connectMongo, mongoColl, getDb } from '../src/config/mongo'
import type { NsfwTermCategory } from '../src/models/nsfw-term.model'

const LDNOOBW_URL =
  'https://raw.githubusercontent.com/LDNOOBW/List-of-Dirty-Naughty-Obscene-and-Otherwise-Bad-Words/master/en'

type CuratedEntry = { terms: string[]; category: NsfwTermCategory; weight: number }

/**
 * Hand-curated, high-signal lexicon. NOTE: romance words (kiss, embrace, caress,
 * whisper, desire...) are deliberately ABSENT — romance must stay on the SFW
 * model; only explicit sexual content belongs here.
 */
const CURATED: CuratedEntry[] = [
  // --- Anatomy: unambiguous (weight 2) ---
  {
    category: 'anatomy',
    weight: 2,
    terms: [
      'cock', 'dick', 'penis', 'cocks', 'pussy', 'pussies', 'vagina', 'vulva',
      'labia', 'clit', 'clitoris', 'cunt', 'nipple', 'nipples', 'areola',
      'testicle', 'testicles', 'scrotum', 'ballsack', 'foreskin', 'glans',
      'butthole', 'anus', 'asshole', 'cum', // also fluid; kept here is fine, dedup keeps one
    ],
  },
  // --- Anatomy / descriptors: ambiguous out of context (weight 1) ---
  {
    category: 'anatomy',
    weight: 1,
    terms: ['breast', 'breasts', 'boob', 'boobs', 'tit', 'tits', 'shaft', 'balls', 'crotch', 'groin'],
  },
  // --- Acts: unambiguous (weight 2) ---
  {
    category: 'act',
    weight: 2,
    terms: [
      'fuck', 'fucking', 'fucked', 'fucks', 'fuckin', 'sex', 'intercourse', 'coitus',
      'blowjob', 'handjob', 'rimjob', 'rimming', 'deepthroat', 'cunnilingus',
      'fellatio', 'masturbate', 'masturbating', 'masturbation', 'fingering',
      'penetrate', 'penetration', 'doggystyle', 'cowgirl', 'missionary', 'scissoring',
      'fisting', 'creampie', 'gangbang', 'threesome', 'orgy', 'titfuck', 'facefuck',
      'cumshot', 'bukkake', 'felching', 'pegging',
    ],
  },
  // --- Acts: ambiguous out of context (weight 1) ---
  {
    category: 'act',
    weight: 1,
    terms: [
      'thrust', 'thrusts', 'thrusting', 'hump', 'humping', 'grind', 'grinding',
      'ride', 'riding', 'straddle', 'straddling', 'suck', 'sucking', 'lick',
      'licking', 'stroke', 'stroking', 'jerk', 'jerking', 'foreplay', 'pound',
      'pounding', 'mount', 'mounting',
    ],
  },
  // --- Fluids (weight 2) ---
  {
    category: 'fluid',
    weight: 2,
    terms: ['cumming', 'precum', 'semen', 'ejaculate', 'ejaculating', 'ejaculation', 'squirt', 'squirting'],
  },
  // --- Descriptors: clearly sexual (weight 2) ---
  {
    category: 'descriptor',
    weight: 2,
    terms: [
      'horny', 'aroused', 'arousal', 'orgasm', 'orgasms', 'orgasmic', 'climax',
      'climaxing', 'erection', 'erect', 'naked', 'nude', 'undress', 'undressed',
      'undressing', 'foreskin', 'aphrodisiac', 'libido',
    ],
  },
  // --- Descriptors: ambiguous out of context (weight 1) ---
  {
    category: 'descriptor',
    weight: 1,
    terms: ['wet', 'dripping', 'throbbing', 'moan', 'moans', 'moaning', 'moaned', 'panting', 'quiver', 'writhe', 'writhing', 'thigh', 'thighs'],
  },
  // --- Apparel (weight 1) ---
  {
    category: 'apparel',
    weight: 1,
    terms: ['lingerie', 'panties', 'thong', 'negligee', 'garter', 'bra', 'corset'],
  },
  // --- Phrases (multi-word, substring-matched; weight 2) ---
  {
    category: 'act',
    weight: 2,
    terms: [
      'make love', 'making love', 'inside me', 'inside you', 'go down on',
      'going down on', 'eat me out', 'ride me', 'bend over', 'take me now',
      'on top of me', 'between my legs', 'between your legs', 'blow job', 'hand job',
    ],
  },
]

/** LDNOOBW entries whose token matches a sexual root get weight 1; everything else weight 0. */
const SEXUAL_ROOT =
  /sex|fuck|cum|orgasm|masturbat|porn|cock|dick|pussy|vagina|penis|clit|nipple|breast|boob|tit|nude|naked|erotic|horny|arous|genital|anal|oral|blowjob|handjob|fellat|cunnilingus|intercours|coit|ejacul|climax|fondl|seduc|thrust|moan|panties|lingerie|hentai|fetish|bdsm|dildo|vibrator|hump|grind|squirt|semen|labia|vulva|scrotum|testicl|whore|slut|bukkake|creampie|gangbang|threesome|rimjob|rimming|felch|peg/i

function norm(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, ' ')
}

async function main() {
  const noFetch = process.argv.includes('--no-fetch')
  await connectMongo()

  // Build the merged term map (term -> doc fields). Curated first so it wins.
  const now = new Date()
  const map = new Map<string, { is_phrase: boolean; category: NsfwTermCategory; weight: number; source: string }>()

  for (const group of CURATED) {
    for (const raw of group.terms) {
      const term = norm(raw)
      if (!term) continue
      // Keep the highest weight if a term appears in multiple curated groups.
      const existing = map.get(term)
      if (existing && existing.weight >= group.weight) continue
      map.set(term, {
        is_phrase: term.includes(' '),
        category: group.category,
        weight: group.weight,
        source: 'curated',
      })
    }
  }
  const curatedCount = map.size

  // Import LDNOOBW (broad public list) unless skipped.
  let importedCount = 0
  if (!noFetch) {
    try {
      const res = await fetch(LDNOOBW_URL)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const body = await res.text()
      const lines = body.split('\n').map(norm).filter(Boolean)
      for (const term of lines) {
        if (map.has(term)) continue // curated wins
        const weight = SEXUAL_ROOT.test(term) ? 1 : 0
        map.set(term, {
          is_phrase: term.includes(' '),
          category: weight > 0 ? 'other' : 'profanity',
          weight,
          source: 'ldnoobw',
        })
        importedCount++
      }
      console.log(`Fetched LDNOOBW: ${lines.length} terms (${importedCount} new after curated merge)`)
    } catch (e) {
      console.warn(`⚠️  LDNOOBW fetch failed (${(e as Error).message}); seeding curated only.`)
    }
  } else {
    console.log('Skipping LDNOOBW fetch (--no-fetch); seeding curated only.')
  }

  // Ensure the unique index exists (connectMongo already reconciles canonical
  // indexes, but be defensive for a brand-new collection).
  await getDb()
    .collection('nsfw_lexicon')
    .createIndex({ term: 1 }, { unique: true, name: 'uniq_nsfw_lexicon_term' })
    .catch(() => {})

  // Idempotent upsert on `term`.
  const ops = [...map.entries()].map(([term, fields]) => ({
    updateOne: {
      filter: { term },
      update: {
        $set: {
          term,
          is_phrase: fields.is_phrase,
          category: fields.category,
          weight: fields.weight,
          source: fields.source,
          updated_at: now,
        },
        $setOnInsert: { created_at: now },
      },
      upsert: true,
    },
  }))

  const result = await mongoColl.nsfwLexicon().bulkWrite(ops as any, { ordered: false })

  // Summary by weight + a routing-relevant count.
  const total = await mongoColl.nsfwLexicon().countDocuments({})
  const routable = await mongoColl.nsfwLexicon().countDocuments({ weight: { $gte: 1 } })
  const byWeight = await mongoColl
    .nsfwLexicon()
    .aggregate([{ $group: { _id: '$weight', n: { $sum: 1 } } }, { $sort: { _id: 1 } }])
    .toArray()

  console.log('\n=== nsfw_lexicon seed complete ===')
  console.log(`curated: ${curatedCount}  |  ldnoobw new: ${importedCount}`)
  console.log(`upserted: ${result.upsertedCount}  modified: ${result.modifiedCount}`)
  console.log(`collection total: ${total}  |  routable (weight>=1): ${routable}`)
  console.log('by weight:', byWeight.map((w) => `${w._id}:${w.n}`).join('  '))

  process.exit(0)
}

main().catch((err) => {
  console.error('seed-nsfw-lexicon failed:', err)
  process.exit(1)
})
