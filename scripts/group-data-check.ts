/**
 * Group data check: the shape, counts and ages of authored group world files.
 *
 *   bun --no-env-file run scripts/group-data-check.ts <dir>
 *
 * Pure: it reads the *.json in <dir> and nothing else. No environment file, no
 * socket, no model. It judges structure only, never what a line says, so it
 * can't be satisfied by a word list. One line per file; exit 1 if any fails.
 *
 * The shape is the one the three launch groups define (`flat-4b.json` is the
 * reference), because no server model types a group's cast yet.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'

/** The authoring rule for the 50 group worlds: everyone is an adult lead. */
const MIN_AGE = 21
const MAX_AGE = 45

/**
 * The three worlds written before the 21-45 rule, exempt by slug rather than by
 * quietly making every bound advisory. Between them they carry what the current
 * rule forbids: casts over 45 (Owen 47, Carol 61, Walt 73) and voices shorter
 * than five lines (Elena 4, Lukas 4, Owen 4). Both bounds still apply to them,
 * widened only as far as those files need.
 */
const LEGACY_SLUGS = new Set(['flat-4b', 'last-light-guild', 'alder-lane-watch'])
const LEGACY_MAX_AGE = 80
const LEGACY_MIN_VOICE_LINES = 4

const TOP_LEVEL_STRINGS = [
  'slug',
  'title',
  'description',
  'genre',
  'narrative_style',
  'seed_prompt',
  'global_lore',
] as const

const CAST_STRINGS = ['name', 'role', 'identity_kind', 'appearance', 'persona'] as const
const GROUP_STRINGS = ['speech', 'wants', 'intimacy', 'start_bond'] as const
const STATUS_KEYS = ['morning', 'afternoon', 'evening', 'night'] as const

const MIN_VOICE_LINES = 5
const MAX_VOICE_LINES = 7
const FIRST_TEXTS = 3
const MIN_TOPICS = 10

type Row = Record<string, unknown>

const isRow = (value: unknown): value is Row =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const filled = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/** One to ninety in words, which is how every `appearance` opens. */
const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15,
  sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
}

/**
 * The age an appearance states, read from its opening words: "Twenty-nine; long
 * dark hair…" reads 29. Digits are accepted too. Null when it states none.
 */
function statedAge(appearance: string): number | null {
  const head = appearance.split(/[;,.]/)[0]!.trim().toLowerCase()
  const digits = head.match(/^\d+/)
  if (digits) return Number(digits[0])
  let total = 0
  let seen = false
  for (const word of head.split(/[\s-]+/)) {
    if (word === 'and') continue
    const value = NUMBER_WORDS[word]
    if (value === undefined) break
    total += value
    seen = true
  }
  return seen ? total : null
}

type Verdict = { problems: string[]; slug: string }

function checkFile(path: string): Verdict {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    return { problems: [`JSON does not parse (${message(error)})`], slug: '' }
  }
  if (!isRow(parsed)) return { problems: ['top level is not an object'], slug: '' }
  const row = parsed

  const problems: string[] = []
  const fail = (problem: string): void => {
    problems.push(problem)
  }

  for (const key of TOP_LEVEL_STRINGS) {
    if (!filled(row[key])) fail(`${key} is missing or not a non-empty string`)
  }
  if (typeof row.is_sentient !== 'boolean') fail('is_sentient is not a boolean')
  if (row.is_nsfw_capable !== true) fail('is_nsfw_capable is not true')
  if (row.kind !== 'group') fail(`kind is ${JSON.stringify(row.kind)}, not "group"`)

  const slug = filled(row.slug) ? row.slug : ''
  if (slug) {
    if (basename(path, '.json') !== slug) fail(`slug "${slug}" is not the file name`)
    if (row.cover !== `cover_${slug}.png`) {
      fail(`cover is ${JSON.stringify(row.cover)}, expected "cover_${slug}.png"`)
    }
  }

  if (!Array.isArray(row.scene_tags) || !row.scene_tags.every(filled) || row.scene_tags.length === 0) {
    fail('scene_tags is not a non-empty array of strings')
  }

  if (!Array.isArray(row.topics) || !row.topics.every(filled)) {
    fail('topics is not an array of strings')
  } else if (row.topics.length < MIN_TOPICS) {
    fail(`topics has ${row.topics.length}, fewer than ${MIN_TOPICS}`)
  }

  const cast = row.seed_cast
  if (!Array.isArray(cast)) {
    return { problems: [...problems, 'seed_cast is not an array'], slug }
  }
  if (cast.length < 2 || cast.length > 6) {
    fail(`seed_cast has ${cast.length}, expected 2 to 6`)
  }

  const names = new Set<string>()
  const legacy = LEGACY_SLUGS.has(slug)
  const maxAge = legacy ? LEGACY_MAX_AGE : MAX_AGE
  const minVoice = legacy ? LEGACY_MIN_VOICE_LINES : MIN_VOICE_LINES

  cast.forEach((entry, index) => {
    const where = `cast ${index + 1}`
    if (!isRow(entry)) {
      fail(`${where} is not an object`)
      return
    }
    for (const key of CAST_STRINGS) {
      if (!filled(entry[key])) fail(`${where}.${key} is missing or not a non-empty string`)
    }
    const name = filled(entry.name) ? entry.name.trim() : ''
    if (name) {
      const key = name.toLowerCase()
      if (names.has(key)) fail(`${where} repeats the name "${name}"`)
      names.add(key)
    }
    const label = name || where

    if (!Array.isArray(entry.aliases) || !entry.aliases.every(filled)) {
      fail(`${label}.aliases is not an array of strings`)
    }

    const group = entry.group
    if (!isRow(group)) {
      fail(`${label}.group is not an object`)
    } else {
      for (const key of GROUP_STRINGS) {
        if (!filled(group[key])) fail(`${label}.group.${key} is missing or not a non-empty string`)
      }
      const age = group.age
      if (typeof age !== 'number' || !Number.isInteger(age)) {
        fail(`${label}.group.age is not an integer`)
      } else if (age < MIN_AGE) {
        fail(`${label}.group.age is ${age}, under ${MIN_AGE}`)
      } else if (age > maxAge) {
        fail(`${label}.group.age is ${age}, over ${maxAge}`)
      }
      if (typeof group.talkativeness !== 'number' || !Number.isFinite(group.talkativeness)) {
        fail(`${label}.group.talkativeness is not a number`)
      } else if (group.talkativeness < 0 || group.talkativeness > 1) {
        fail(`${label}.group.talkativeness is ${group.talkativeness}, outside 0 to 1`)
      }
      const voice = group.voice
      if (!Array.isArray(voice) || !voice.every(filled)) {
        fail(`${label}.group.voice is not an array of strings`)
      } else if (voice.length < minVoice || voice.length > MAX_VOICE_LINES) {
        fail(`${label}.group.voice has ${voice.length} lines, expected ${minVoice} to ${MAX_VOICE_LINES}`)
      }
      if (typeof age === 'number' && filled(entry.appearance)) {
        const stated = statedAge(entry.appearance)
        if (stated === null) {
          fail(`${label}.appearance does not state an age`)
        } else if (stated !== age) {
          fail(`${label}.appearance says ${stated}, group.age says ${age}`)
        }
      }
    }

    if (!Array.isArray(entry.first_texts) || !entry.first_texts.every(filled)) {
      fail(`${label}.first_texts is not an array of strings`)
    } else if (entry.first_texts.length !== FIRST_TEXTS) {
      fail(`${label}.first_texts has ${entry.first_texts.length}, expected ${FIRST_TEXTS}`)
    }

    const statuses = entry.statuses
    if (!isRow(statuses)) {
      fail(`${label}.statuses is not an object`)
    } else {
      for (const key of STATUS_KEYS) {
        if (!filled(statuses[key])) fail(`${label}.statuses.${key} is missing or not a non-empty string`)
      }
    }
  })

  const opening = row.opening_lines
  if (!Array.isArray(opening) || opening.length === 0) {
    fail('opening_lines is not a non-empty array')
  } else {
    opening.forEach((line, index) => {
      if (!isRow(line) || !filled(line.name) || !filled(line.text)) {
        fail(`opening_lines ${index + 1} is not { name, text }`)
      } else if (names.size > 0 && !names.has(line.name.trim().toLowerCase())) {
        fail(`opening_lines ${index + 1} speaks as "${line.name}", who is not in the cast`)
      }
    })
  }

  return { problems, slug }
}

function main(): void {
  const argument = process.argv[2]
  if (!argument) {
    console.error('usage: bun --no-env-file run scripts/group-data-check.ts <dir>')
    process.exit(1)
  }
  const dir = resolve(argument)
  let entries: string[]
  try {
    if (!statSync(dir).isDirectory()) throw new Error('not a directory')
    entries = readdirSync(dir).filter((entry) => entry.endsWith('.json')).sort()
  } catch (error) {
    console.error(`group-data-check: ${dir}: ${message(error)}`)
    process.exit(1)
  }
  if (entries.length === 0) {
    console.error(`group-data-check: no *.json files in ${dir}`)
    process.exit(1)
  }

  let failed = 0
  for (const entry of entries) {
    const path = join(dir, entry)
    if (!statSync(path).isFile()) continue
    const { problems, slug } = checkFile(path)
    if (problems.length === 0) {
      const note = LEGACY_SLUGS.has(slug) ? ` (legacy cast, ages up to ${LEGACY_MAX_AGE})` : ''
      console.log(`${entry}: ok${note}`)
      continue
    }
    failed += 1
    console.log(`${entry}: FAIL — ${problems.join('; ')}`)
  }
  if (failed > 0) {
    console.log(`${failed} of ${entries.length} file(s) failed`)
    process.exit(1)
  }
}

if (import.meta.main) main()
