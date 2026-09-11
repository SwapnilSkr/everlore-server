/**
 * Move walk catalog and saves off WorldTemplateDoc / WorldInstanceDoc.
 *
 * InteractiveWorldDoc is the catalog. InteractiveWorldInstanceDoc is the save.
 * Instance `_id`s are reused so events, memories and InteractiveWorldStateDoc
 * rows stay attached. Chat templates and chat instances are left alone.
 *
 *   bun run migrate:walks-separate-docs
 */
import { connectMongo, mongoColl } from '../src/config/mongo'
import type { InteractiveWorldInstanceDoc } from '../src/models/interactive-world.model'
import type { WorldInstanceDoc } from '../src/models/world-instance.model'
import type { WorldTemplateDoc } from '../src/models/world-template.model'
import { interactiveWorldService } from '../src/services/interactive-world.service'
import { idString } from '../src/utils/mongo-id'
import { loadWorld } from '../src/worlds/world-fixture'

function walkKeyOf(template: WorldTemplateDoc): string | null {
  const key = typeof template.interactive_world_key === 'string'
    ? template.interactive_world_key.trim()
    : ''
  return key.length > 0 ? key : null
}

function pickCatalogTemplate(templates: WorldTemplateDoc[]): WorldTemplateDoc {
  return (
    templates.find((t) => t.is_published && t.moderation_status !== 'hidden') ??
    templates[0]
  )
}

await connectMongo()

const templates = (await mongoColl
  .worldTemplates()
  .find({
    interactive_world_key: { $type: 'string', $ne: '' },
  })
  .toArray()) as WorldTemplateDoc[]

const byKey = new Map<string, WorldTemplateDoc[]>()
for (const template of templates) {
  const key = walkKeyOf(template)
  if (!key) continue
  const list = byKey.get(key) ?? []
  list.push(template)
  byKey.set(key, list)
}

let worldsStamped = 0
let instancesMoved = 0
let templatesRemoved = 0
let chatRowsRemoved = 0

for (const [key, keyed] of byKey) {
  const fixture = loadWorld(key)
  const world = fixture
    ? await interactiveWorldService.upsertWorldFromAuthored(fixture)
    : await interactiveWorldService.getWorld(key)
  const catalog = pickCatalogTemplate(keyed)
  const image = typeof catalog.image_url === 'string' ? catalog.image_url.trim() : ''
  await mongoColl.interactiveWorlds().updateOne(
    { _id: world._id },
    {
      $set: {
        creator_id: catalog.creator_id,
        is_published: catalog.is_published === true,
        description: catalog.description || world.chapter_title,
        ...(image.length > 0 ? { image_url: image } : {}),
        ...(catalog.moderation_status ? { moderation_status: catalog.moderation_status } : {}),
        updated_at: new Date(),
      },
    },
  )
  worldsStamped++

  const templateIds = keyed.map((t) => t._id)
  const chatSaves = (await mongoColl
    .worldInstances()
    .find({ template_id: { $in: templateIds } })
    .toArray()) as WorldInstanceDoc[]

  for (const save of chatSaves) {
    const existing = await mongoColl.interactiveWorldInstances().findOne({ _id: save._id })
    if (!existing) {
      const doc: InteractiveWorldInstanceDoc = {
        _id: save._id,
        world_id: world._id,
        world_key: key,
        player_id: save.player_id,
        meta: {
          total_events: save.meta.total_events ?? 0,
          total_memories: save.meta.total_memories ?? 0,
          last_active_at: save.meta.last_active_at ?? save.updated_at ?? save.created_at,
          is_archived: save.meta.is_archived === true,
        },
        created_at: save.created_at,
        updated_at: save.updated_at ?? save.created_at,
      }
      await mongoColl.interactiveWorldInstances().insertOne(doc)
      instancesMoved++
    }
  }

  const removedSaves = await mongoColl.worldInstances().deleteMany({
    template_id: { $in: templateIds },
  })
  chatRowsRemoved += removedSaves.deletedCount
  const removedTemplates = await mongoColl.worldTemplates().deleteMany({
    _id: { $in: templateIds },
  })
  templatesRemoved += removedTemplates.deletedCount
}

console.log(JSON.stringify({
  keys: byKey.size,
  worldsStamped,
  instancesMoved,
  chatRowsRemoved,
  templatesRemoved,
}))
process.exit(0)
