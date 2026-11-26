/**
 * TEMPLATE THUMB: every story payload that names a cover also names the 540 px
 * WebP stored beside it, so a list card on the phone never downloads the full
 * image. Publishing a cover already stores the small variant
 * (`image_thumb_url`, `COVER_THUMB_WIDTH` in `utils/image-encoding.ts`); this
 * audit pins that the small variant reaches the player:
 *
 *   (a) the summary shaper carries it, unchanged, for a world that has one;
 *   (b) a world without one gets no key at all — never `null`, never `""`;
 *   (c) an empty thumbnail counts as none;
 *   (d) the summary projection selects every field the shaper emits, and the
 *       shaper emits every field the projection selects — the two can never
 *       drift apart;
 *   (e) `publicTemplate()` passes it through, and leaves it out when absent;
 *   (f) the wiring: instance.service.ts selects its three template summaries
 *       through TEMPLATE_SUMMARY_PROJECTION and shapes its destructured one
 *       through templateSummary, so no summary can silently lose the thumb.
 *
 * Every check is shown to bite: (d) and (f) reject tampered copies of the
 * projection and of the service source, and the rest are shown by removing the
 * key from the allow-list, the shaper and a summary site in turn.
 *
 *   bun --no-env-file run scripts/template-thumb-audit.ts
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { ObjectId } from 'mongodb'
import {
  TEMPLATE_SUMMARY_PROJECTION,
  publicTemplate,
  templateSummary,
} from '../src/utils/template-public-projection'

let failures = 0
function check(name: string, fn: () => void) {
  try {
    fn()
    console.log(`PASS ${name}`)
  } catch (error) {
    failures++
    console.log(`FAIL ${name}: ${(error as Error).message}`)
  }
}

const cover = 'https://cdn.example.invalid/iron-coast.webp'
const coverThumb = 'https://cdn.example.invalid/iron-coast.w540.webp'
const world = {
  _id: new ObjectId('0000000000000000000000a1'),
  title: 'Iron Coast',
  description: 'A cold shore.',
  kind: 'world' as const,
  is_sentient: false,
  image_url: cover,
}

check('(a) the summary carries the cover thumbnail a world has', () => {
  assert.deepEqual(templateSummary({ ...world, image_thumb_url: coverThumb }), {
    ...world,
    image_thumb_url: coverThumb,
  })
})

check('(b) a world without a thumbnail arrives without the key', () => {
  const summary = templateSummary(world)
  assert.equal(Object.hasOwn(summary, 'image_thumb_url'), false)
  assert.deepEqual(summary, world)
})

check('(c) an empty or null thumbnail counts as none', () => {
  for (const empty of ['', null as unknown as string]) {
    const summary = templateSummary({ ...world, image_thumb_url: empty })
    assert.equal(Object.hasOwn(summary, 'image_thumb_url'), false, `sent ${JSON.stringify(empty)}`)
    assert.deepEqual(summary, world)
  }
})

/** What is wrong with a summary projection, as text, so a mutant can be tested. */
function projectionProblems(projection: Record<string, unknown>): string[] {
  const problems: string[] = []
  const shaped = templateSummary({ ...world, image_thumb_url: coverThumb })
  if (!projection.image_thumb_url) {
    problems.push('the summary projection does not select image_thumb_url')
  }
  for (const [key, value] of Object.entries(projection)) {
    if (value !== 1) problems.push(`${key} is not an inclusion`)
  }
  const never = Object.keys(shaped).filter((key) => !(key in projection))
  if (never.length) problems.push(`the shaper emits fields the projection never selects: ${never.join(', ')}`)
  const unused = Object.keys(projection).filter((key) => !Object.hasOwn(shaped, key))
  if (unused.length) problems.push(`the projection selects fields the summary never carries: ${unused.join(', ')}`)
  return problems
}

check('(d) the projection and the shaper select the same fields', () => {
  const problems = projectionProblems(TEMPLATE_SUMMARY_PROJECTION)
  assert.deepEqual(problems, [], problems.join('; '))
})

check('(e) publicTemplate passes the thumbnail through, and omits it when absent', () => {
  assert.equal(
    publicTemplate({ ...world, image_thumb_url: coverThumb }).image_thumb_url,
    coverThumb,
  )
  const unthumbed: Record<string, unknown> = { ...world }
  assert.equal(Object.hasOwn(publicTemplate(unthumbed), 'image_thumb_url'), false)
})

const summarySource = readFileSync(
  new URL('../src/services/instance.service.ts', import.meta.url),
  'utf8',
)
// The import, listByTemplate's find, list's find and listRealms' $lookup.
const PROJECTION_USES = 4
// The no-stories branch, the realm's own template row and list's map.
const SHAPED_SITES = 3

/** What is wrong with the summary wiring, as text, so a mutant can be tested. */
function wiringProblems(source: string): string[] {
  const problems: string[] = []
  if (/image_url:\s*1/.test(source)) {
    problems.push('a template summary is hand-written instead of TEMPLATE_SUMMARY_PROJECTION')
  }
  const projections = source.split('TEMPLATE_SUMMARY_PROJECTION').length - 1
  if (projections !== PROJECTION_USES) {
    problems.push(`expected ${PROJECTION_USES} uses of TEMPLATE_SUMMARY_PROJECTION, found ${projections}`)
  }
  const shaped = source.split('templateSummary(').length - 1
  if (shaped !== SHAPED_SITES) {
    problems.push(`expected ${SHAPED_SITES} uses of templateSummary, found ${shaped}`)
  }
  return problems
}

check('(f) every instance summary goes through the shared projection and shaper', () => {
  const problems = wiringProblems(summarySource)
  assert.deepEqual(problems, [], problems.join('; '))
})

check('bite: (d) rejects a projection that lost the thumbnail', () => {
  const lost: Record<string, unknown> = { ...TEMPLATE_SUMMARY_PROJECTION }
  delete lost.image_thumb_url
  assert.ok(projectionProblems(lost).length > 0)
})

check('bite: (f) rejects a summary site that hand-writes its projection', () => {
  const handWritten = summarySource.replace(
    '.project(TEMPLATE_SUMMARY_PROJECTION)',
    '.project({ _id: 1, title: 1, is_sentient: 1, description: 1, kind: 1, image_url: 1 })',
  )
  assert.notEqual(handWritten, summarySource, 'the projection anchor moved; update this audit')
  assert.ok(wiringProblems(handWritten).length > 0)
})

check('bite: (f) rejects a destructure site that stopped shaping', () => {
  const unshaped = summarySource.replace(
    'template: templateSummary(template), stories: []',
    'template, stories: []',
  )
  assert.notEqual(unshaped, summarySource, 'the shaper anchor moved; update this audit')
  assert.ok(wiringProblems(unshaped).length > 0)
})

console.log(failures === 0 ? '\ntemplate-thumb: ALL GREEN' : `\ntemplate-thumb: ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
