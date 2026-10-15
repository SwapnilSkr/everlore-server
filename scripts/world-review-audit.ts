import assert from 'node:assert/strict'
import { Elysia } from 'elysia'
import { ObjectId } from 'mongodb'
import { adminRoutes } from '../src/routes/admin.routes'
import { templateRoutes } from '../src/routes/template.routes'
import { env } from '../src/config/env'
import { moderationService } from '../src/services/moderation.service'
import { templateService } from '../src/services/template.service'
import { mongoColl } from '../src/config/mongo'
import { adminService } from '../src/services/admin.service'
import { authService } from '../src/services/auth.service'
import { instanceService } from '../src/services/instance.service'
import { templateController } from '../src/controllers/template.controller'
import type { WorldTemplateDoc } from '../src/models/world-template.model'
import type { UserDoc } from '../src/models/user.model'
import { canForge } from '../src/utils/can-forge'
import { HttpError } from '../src/utils/http-error'
import { hasMeaningfulWorldEdit, publishReviewUpdate } from '../src/utils/world-review'

const ownerId = new ObjectId()
const templateId = new ObjectId()
const world = {
  _id: templateId,
  creator_id: ownerId,
  title: 'A World',
  description: 'A place to travel',
  is_published: true,
  visibility: 'public',
  review_status: 'approved',
  base_stats_template: {},
  flag_definitions: {},
  scene_tags: [],
  model_preferences: {},
  seed_prompt: 'A place to travel',
  global_lore: '',
  is_sentient: false,
  is_nsfw_capable: false,
  version: 1,
  created_at: new Date(),
  updated_at: new Date(),
} as WorldTemplateDoc

function matches(row: Record<string, unknown>, filter: Record<string, unknown>): boolean {
  return Object.entries(filter).every(([key, condition]) => {
    if (key === '$or') return (condition as Record<string, unknown>[]).some((part) => matches(row, part))
    if (key === '$and') return (condition as Record<string, unknown>[]).every((part) => matches(row, part))
    if (condition && typeof condition === 'object' && !Array.isArray(condition)) {
      const expression = condition as Record<string, unknown>
      if ('$exists' in expression) return (row[key] !== undefined) === expression.$exists
      if ('$ne' in expression) return row[key] !== expression.$ne
      if ('$regex' in expression) return new RegExp(String(expression.$regex), String(expression.$options || '')).test(String(row[key] || ''))
    }
    return row[key] === condition
  })
}

let checks = 0
function check(name: string, actual: unknown, expected: unknown) {
  assert.deepEqual(actual, expected, name)
  checks++
  console.log(`  PASS ${name}`)
}

const discovery = { is_published: true, ...await moderationService.discoveryFilter() }
for (const [name, patch, listed] of [
  ['legacy published', { visibility: undefined, review_status: undefined }, true],
  ['approved public', { visibility: 'public', review_status: 'approved' }, true],
  ['private', { visibility: 'private', review_status: undefined }, false],
  ['pending public', { visibility: 'public', review_status: 'pending' }, false],
  ['changes requested', { visibility: 'public', review_status: 'changes_requested' }, false],
  ['hidden approved', { visibility: 'public', review_status: 'approved', moderation_status: 'hidden' }, false],
  ['draft legacy', { is_published: false, visibility: undefined, review_status: undefined }, false],
] as const) {
  check(`Discover ${name}`, matches({ ...world, ...patch }, discovery), listed)
}

const originalSearchCollection = mongoColl.worldTemplates
let searchFilter: Record<string, unknown> = {}
try {
  ;(mongoColl as unknown as { worldTemplates: () => unknown }).worldTemplates = () => ({
    countDocuments: async (filter: Record<string, unknown>) => { searchFilter = filter; return 0 },
    find: () => ({ sort: () => ({ skip: () => ({ limit: () => ({ toArray: async () => [] }) }) }) }),
  })
  await templateService.listPublished(1, 20, 'World')
  check('search keeps pending world out', matches({ ...world, review_status: 'pending' }, searchFilter), false)
  check('search includes matching approved world', matches(world, searchFilter), true)
  check('search excludes nonmatching approved world', matches({ ...world, title: 'Elsewhere', description: 'A different place' }, searchFilter), false)
} finally {
  ;(mongoColl as unknown as { worldTemplates: () => unknown }).worldTemplates = originalSearchCollection
}

check('meaningful changed title', hasMeaningfulWorldEdit(world, { title: 'A Different World' }), true)
check('meaningful same title', hasMeaningfulWorldEdit(world, { title: world.title }), false)
check('non-meaningful stats', hasMeaningfulWorldEdit(world, { max_lore_results: 20 }), false)
check('meaningful protagonist structure', hasMeaningfulWorldEdit(world, { protagonist: { name: 'A Hero' } }), true)
check('same-value object', hasMeaningfulWorldEdit({ ...world, protagonist: { name: 'A Hero' } }, { protagonist: { name: 'A Hero' } }), false)
check('approved edit moves to pending',
  world.review_status === 'approved' && hasMeaningfulWorldEdit(world, { title: 'A Different World' }) ? 'pending' : world.review_status,
  'pending')
check('same-value edit stays approved',
  world.review_status === 'approved' && hasMeaningfulWorldEdit(world, { title: world.title }) ? 'pending' : world.review_status,
  'approved')

const privatePublish = publishReviewUpdate(world)
check('publish with no body defaults private', privatePublish.$set.visibility, 'private')
check('private publish clears review state', Object.keys(privatePublish.$unset).sort(),
  ['review_status', 'review_note', 'submitted_at', 'reviewed_at', 'reviewed_by'].sort())
check('approved public republish stays approved', publishReviewUpdate(world, 'public').$set.review_status, 'approved')
check('draft public publish waits for review', publishReviewUpdate({ ...world, is_published: false }, 'public').$set.review_status, 'pending')

// Exercise the service writes with an in-memory collection; no database or
// authoring call is needed for the fields selected here.
const originalWorldTemplates = mongoColl.worldTemplates
let stored = { ...world }
let lastSet: Record<string, unknown> = {}
try {
  ;(mongoColl as unknown as { worldTemplates: () => unknown }).worldTemplates = () => ({
    findOne: async () => stored,
    updateOne: async (_filter: unknown, update: { $set: Record<string, unknown>; $unset?: Record<string, unknown> }) => {
      lastSet = update.$set
      stored = { ...stored, ...update.$set }
      if (update.$unset) for (const key of Object.keys(update.$unset)) delete (stored as Record<string, unknown>)[key]
      return { matchedCount: 1 }
    },
  })
  await templateService.update(templateId.toHexString(), ownerId.toHexString(), { is_nsfw_capable: true })
  check('service meaningful edit sets pending', lastSet.review_status, 'pending')
  stored = { ...world }
  await templateService.update(templateId.toHexString(), ownerId.toHexString(), { title: world.title })
  check('service same-value edit keeps approval', lastSet.review_status, undefined)
  stored = { ...world }
  await templateService.update(templateId.toHexString(), ownerId.toHexString(), { max_lore_results: 20 })
  check('service non-meaningful edit keeps approval', lastSet.review_status, undefined)
  stored = { ...world, is_published: false }
  const published = await templateService.publish(templateId.toHexString(), ownerId.toHexString())
  check('service publish with absent body is private', published.visibility, 'private')
  check('service private publish clears review status', stored.review_status, undefined)
} finally {
  ;(mongoColl as unknown as { worldTemplates: () => unknown }).worldTemplates = originalWorldTemplates
}

const originalGetById = templateService.getById
try {
  for (const status of ['private', 'pending'] as const) {
    const target = { ...world, visibility: status === 'private' ? 'private' as const : 'public' as const,
      review_status: status === 'pending' ? 'pending' as const : undefined }
    templateService.getById = async () => target
    await assert.rejects(
      templateController.getById({ params: { id: templateId.toHexString() }, user: { id: new ObjectId().toHexString(), email: '', username: '', tier: 'free' } }),
      (error: unknown) => (error as { statusCode?: number }).statusCode === 404,
    )
    checks++
    console.log(`  PASS non-owner ${status} read returns 404`)
    const own = await templateController.getById({ params: { id: templateId.toHexString() }, user: { id: ownerId.toHexString(), email: '', username: '', tier: 'free' } })
    check(`owner ${status} read succeeds`, own._id.toHexString(), templateId.toHexString())
  }
} finally {
  templateService.getById = originalGetById
}

const originalSummaryTemplates = mongoColl.worldTemplates
const originalSummaryInstances = mongoColl.worldInstances
let summaryWorld = { ...world }
try {
  ;(mongoColl as unknown as { worldTemplates: () => unknown }).worldTemplates = () => ({ findOne: async () => summaryWorld })
  ;(mongoColl as unknown as { worldInstances: () => unknown }).worldInstances = () => ({
    find: () => ({ sort: () => ({ toArray: async () => [] }) }),
  })
  for (const status of ['private', 'pending'] as const) {
    summaryWorld = { ...world, visibility: status === 'private' ? 'private' : 'public',
      review_status: status === 'pending' ? 'pending' : undefined }
    const other = await instanceService.listByTemplate(new ObjectId().toHexString(), templateId.toHexString())
    check(`empty story list hides ${status} summary`, other.template, null)
    const own = await instanceService.listByTemplate(ownerId.toHexString(), templateId.toHexString())
    check(`empty owner story list keeps ${status} summary`, own.template?.title, world.title)
  }
} finally {
  ;(mongoColl as unknown as { worldTemplates: () => unknown }).worldTemplates = originalSummaryTemplates
  ;(mongoColl as unknown as { worldInstances: () => unknown }).worldInstances = originalSummaryInstances
}

check('forge free switch off', canForge({ tier: 'free' }, false), false)
check('forge free switch on', canForge({ tier: 'free' }, true), true)
check('forge premium switch off', canForge({ tier: 'premium' }, false), true)
const freeUser = { _id: ownerId, username: 'maker', tier: 'free' } as UserDoc
const originalForgeSwitch = env.FORGE_OPEN_TO_ALL_TIERS
try {
  env.FORGE_OPEN_TO_ALL_TIERS = false
  check('serialized free user cannot forge when off', authService.serializeUser(freeUser).can_forge, false)
  env.FORGE_OPEN_TO_ALL_TIERS = true
  check('serialized free user can forge when on', authService.serializeUser(freeUser).can_forge, true)
} finally {
  env.FORGE_OPEN_TO_ALL_TIERS = originalForgeSwitch
}

const originalReviewCollection = mongoColl.worldTemplates
let reviewFilter: Record<string, unknown> = {}
let reviewSet: Record<string, unknown> = {}
try {
  ;(mongoColl as unknown as { worldTemplates: () => unknown }).worldTemplates = () => ({
    findOneAndUpdate: async (filter: Record<string, unknown>, update: { $set: Record<string, unknown> }) => {
      reviewFilter = filter
      reviewSet = update.$set
      return null
    },
  })
  await assert.rejects(adminService.reviewWorld(templateId.toHexString(), 'approved', 'reviewer'),
    (error: unknown) => (error as { statusCode?: number }).statusCode === 409)
  checks++
  console.log('  PASS review action rejects a world outside public pending')
  check('review action requires public pending',
    { visibility: reviewFilter.visibility, review_status: reviewFilter.review_status },
    { visibility: 'public', review_status: 'pending' })
  check('approval records reviewer', reviewSet.reviewed_by, 'reviewer')
} finally {
  ;(mongoColl as unknown as { worldTemplates: () => unknown }).worldTemplates = originalReviewCollection
}

// An empty admin credential disables authentication before any Redis lookup.
// The request reaches the real route table and must be refused by the guard.
const originalUsername = env.ADMIN_USERNAME
const originalPassword = env.ADMIN_PASSWORD
env.ADMIN_USERNAME = ''
env.ADMIN_PASSWORD = ''
try {
  const app = new Elysia().use(adminRoutes)
  for (const [method, path, body] of [
    ['GET', '/admin/worlds/review', undefined],
    ['POST', `/admin/worlds/${templateId}/approve`, undefined],
    ['POST', `/admin/worlds/${templateId}/request-changes`, JSON.stringify({ note: 'Revise the opening' })],
  ] as const) {
    const response = await app.handle(new Request(`http://localhost${path}`, {
      method, body, headers: body ? { 'content-type': 'application/json' } : {},
    }))
    check(`${method} ${path} refuses unauthenticated request`, response.status, 503)
  }
} finally {
  env.ADMIN_USERNAME = originalUsername
  env.ADMIN_PASSWORD = originalPassword
}

// Missing request body must pass validation so old app builds get the private default.
const publishResponse = await new Elysia()
  .onError(({ error, set }) => {
    if (error instanceof HttpError) {
      set.status = error.statusCode
      return { error: error.message }
    }
  })
  .use(templateRoutes).handle(new Request(
  `http://localhost/templates/${templateId}/publish`, { method: 'POST' },
))
check('publish route accepts an absent body before auth', publishResponse.status, 401)

console.log(`world-review audit: ${checks} checks passed`)
