/**
 * Pure audit: `idx_memories_pinecone_id` is unique + PARTIAL, and startup
 * notices when a partial filter changes.
 *
 * The index is `{ pinecone_id: 1 }`, unique, partial on
 * `{ pinecone_id: { $type: 'string' } }` — not sparse. Sparse skips a document
 * that LACKS the key but still indexes an explicit null, so one stray
 * `pinecone_id: null` from an old writer made every maintenance archive fail
 * with E11000 (prod, Oct 24 2026). Only real string ids are indexed now, so a
 * null or missing id never participates in the unique constraint.
 *
 * `ensureEverloreIndexes` drops + recreates a same-key index only when
 * `optionsMatch` says the options differ. Before this change that comparison
 * ignored `partialFilterExpression`, so a later edit to a filter would have
 * gone unnoticed until someone found the wrong index in prod.
 *
 * Every check is shown to bite: the source is copied to a temp dir with the
 * filter comparison broken in one specific way, and the checks that must notice
 * are required to fail (and the rest to keep passing).
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Document } from 'mongodb'
import { EVERLORE_INDEXES, optionsMatch, type EverloreIndexDef } from '../src/config/mongo-indexes'

const root = new URL('..', import.meta.url).pathname.replace(/\/$/, '')
const sourcePath = join(root, 'src/config/mongo-indexes.ts')

let failures = 0
function check(name: string, fn: () => void) {
  try {
    fn()
    console.log(`PASS ${name}`)
  } catch (err) {
    failures++
    console.log(`FAIL ${name}: ${(err as Error).message}`)
  }
}

type Match = typeof optionsMatch
type Defs = EverloreIndexDef[]

const NAME = 'idx_memories_pinecone_id'
const memoriesDef = EVERLORE_INDEXES.find((def) => def.options?.name === NAME)
assert(memoriesDef, `${NAME} is missing from EVERLORE_INDEXES`)
const memoriesOptions = memoriesDef.options ?? {}

/** The document `listIndexes` returns for an index created with these options. */
function listed(def: EverloreIndexDef): Document {
  const options = def.options ?? {}
  return {
    v: 2,
    key: structuredClone(def.key),
    name: options.name ?? JSON.stringify(def.key),
    ...(options.unique ? { unique: true } : {}),
    ...(options.sparse ? { sparse: true } : {}),
    ...(options.partialFilterExpression
      ? { partialFilterExpression: structuredClone(options.partialFilterExpression) }
      : {}),
  }
}

type Case = { key: string; name: string; run: (match: Match, defs: Defs) => void }

const cases: Case[] = [
  {
    key: '(a)',
    name: '(a) a sparse index does not match the partial definition, so startup migrates',
    run: (match) => {
      assert.equal(
        match({ v: 2, key: { pinecone_id: 1 }, name: NAME, unique: true, sparse: true }, memoriesOptions),
        false,
      )
      // Already migrated to unique-without-sparse but carrying no filter: only
      // the filter comparison can tell this one apart.
      assert.equal(
        match({ v: 2, key: { pinecone_id: 1 }, name: NAME, unique: true }, memoriesOptions),
        false,
      )
    },
  },
  {
    key: '(b)',
    name: '(b) identical partial filters match regardless of key order',
    run: (match) => {
      const desired = {
        name: 'idx_partial_fixture',
        partialFilterExpression: { slot: { $exists: true }, status: { $in: ['open', 'reviewing'] } },
      }
      assert.equal(match({
        v: 2,
        key: { slot: 1 },
        name: 'idx_partial_fixture',
        partialFilterExpression: { status: { $in: ['open', 'reviewing'] }, slot: { $exists: true } },
      }, desired), true)
    },
  },
  {
    key: '(c)',
    name: '(c) differing partial filters do not match',
    run: (match) => {
      const echo = {
        v: 2,
        key: { status: 1 },
        name: 'idx_partial_fixture',
        partialFilterExpression: { status: { $in: ['open'] } },
      }
      assert.equal(
        match(echo, { name: 'idx_partial_fixture', partialFilterExpression: { status: { $in: ['open', 'reviewing'] } } }),
        false,
      )
      assert.equal(
        match({ ...echo, partialFilterExpression: undefined }, { name: 'idx_partial_fixture', partialFilterExpression: { status: { $in: ['open'] } } }),
        false,
      )
      assert.equal(
        match({ ...echo, partialFilterExpression: { status: { $type: 'object' } } }, { name: 'idx_partial_fixture', partialFilterExpression: { status: { $type: 'string' } } }),
        false,
      )
    },
  },
  {
    key: '(d)',
    name: '(d) every partial index in EVERLORE_INDEXES matches its listIndexes echo',
    run: (match, defs) => {
      const partial = defs.filter((def) => def.options?.partialFilterExpression)
      assert.ok(partial.length >= 3, `expected at least 3 partial indexes, found ${partial.length}`)
      for (const def of partial) {
        assert.equal(match(listed(def), def.options), true, def.options?.name)
        // Not constant-true: an altered filter must be rejected.
        const echo = listed(def)
        echo.partialFilterExpression = {
          ...(def.options?.partialFilterExpression as Document),
          probe: { $exists: true },
        }
        assert.equal(match(echo, def.options), false, `${def.options?.name} accepted an altered filter`)
      }
    },
  },
  {
    key: '(e)',
    name: "(e) the memories definition is unique + partial on $type 'string' with no sparse",
    run: (_match, defs) => {
      const def = defs.find((entry) => entry.options?.name === NAME)
      assert.ok(def, `${NAME} is missing from EVERLORE_INDEXES`)
      assert.deepEqual(def.key, { pinecone_id: 1 })
      assert.equal(def.options?.unique, true)
      assert.equal(def.options?.sparse, undefined)
      assert.deepEqual(def.options?.partialFilterExpression, { pinecone_id: { $type: 'string' } })
    },
  },
]

for (const c of cases) check(c.name, () => c.run(optionsMatch, EVERLORE_INDEXES))

// Without a source-level bite these checks could rot into no-ops, so break the
// comparison two ways and require exactly the checks that depend on it to fail.
const PARTIAL_COMPARISON = `  if (!documentsEqual(
    existing.partialFilterExpression ?? null,
    d.partialFilterExpression ?? null,
  )) return false`

const BITES: Array<{ label: string; replacement: string; kills: string[] }> = [
  {
    label: 'partial comparison removed',
    replacement: '  // partialFilterExpression deliberately ignored by the bite',
    kills: ['(a)', '(c)', '(d)'],
  },
  {
    label: 'partial filter read from the wrong field',
    replacement: '  if (!documentsEqual(existing.partialFilter ?? null, d.partialFilterExpression ?? null)) return false',
    kills: ['(b)', '(d)'],
  },
]

const source = readFileSync(sourcePath, 'utf8')
assert.equal(source.split(PARTIAL_COMPARISON).length, 2, 'partial comparison anchor not found exactly once; update this audit with optionsMatch')

// (e) never calls optionsMatch, so it bites on its own stale fixture below.
const killed = new Set([...BITES.flatMap((bite) => bite.kills), '(e)'])
for (const c of cases) assert(killed.has(c.key), `no bite kills ${c.name}`)

const dir = mkdtempSync(join(tmpdir(), 'mongo-index-partial-'))
try {
  symlinkSync(join(root, 'node_modules'), join(dir, 'node_modules'), 'dir')
  for (const [i, bite] of BITES.entries()) {
    const file = join(dir, `mutant-${i}.ts`)
    writeFileSync(file, source
      .replaceAll('"../models/collections"', `"${root}/src/models/collections.ts"`)
      .replace(PARTIAL_COMPARISON, bite.replacement))
    const mutant = await import(file) as { optionsMatch: Match }
    for (const c of cases) {
      let verdict = 'survived'
      try {
        c.run(mutant.optionsMatch, EVERLORE_INDEXES)
      } catch {
        verdict = 'killed'
      }
      if (bite.kills.includes(c.key)) {
        assert.equal(verdict, 'killed', `${c.name} survived the "${bite.label}" bite`)
      } else {
        assert.equal(verdict, 'survived', `"${bite.label}" unexpectedly broke ${c.name}`)
      }
    }
    console.log(`PASS bite: "${bite.label}" kills ${bite.kills.join(', ')} and nothing else`)
  }
} finally {
  rmSync(dir, { recursive: true, force: true })
}

// (e) does not depend on optionsMatch, so it bites on its own fixture.
check('bites: (e) rejects the old sparse definition', () => {
  const stale = EVERLORE_INDEXES.map((def) => def.options?.name === NAME
    ? { ...def, options: { unique: true, sparse: true, name: NAME } }
    : def)
  assert.throws(() => cases.find((c) => c.key === '(e)')!.run(optionsMatch, stale))
})

console.log(failures === 0 ? '\nmongo-index-partial: ALL GREEN' : `\nmongo-index-partial: ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
