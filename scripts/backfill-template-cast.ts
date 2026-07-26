/**
 * One-time production migration: extract every template's authored starting
 * cast and copy it into every existing instance as independent Codex cards.
 *
 * Run: bun run backfill:template-cast
 */
import { connectMongo, mongoColl } from '../src/config/mongo'
import { idString } from '../src/utils/mongo-id'
import { extractTemplateCast } from '../worker/lib/template-cast-extractor'
import { materializeTemplateCast } from '../src/services/template-cast.service'

await connectMongo()

const templates = await mongoColl.worldTemplates().find({}).toArray()
let templatesUpdated = 0
let instancesSeeded = 0
let cardsProposed = 0

for (const template of templates) {
  const cast = await extractTemplateCast({
    title: template.title,
    description: template.description,
    seedPrompt: template.seed_prompt,
    globalLore: template.global_lore,
    openingLine: template.opening_line,
    protagonistName: template.protagonist?.name,
  })
  await mongoColl.worldTemplates().updateOne(
    { _id: template._id },
    { $set: { seed_cast: cast, updated_at: new Date() } },
  )
  templatesUpdated++

  const refreshed = { ...template, seed_cast: cast }
  const instances = await mongoColl.worldInstances().find({ template_id: template._id }).toArray()
  for (const instance of instances) {
    // This is a one-time migration: freeze the refreshed authored cast on every
    // existing save before materializing it, so later template edits cannot
    // change a rewind's sequence-zero characters or starting bonds.
    await mongoColl.worldInstances().updateOne(
      { _id: instance._id },
      { $set: { seed_cast_snapshot: cast, updated_at: new Date() } },
    )
    const written = await materializeTemplateCast({
      template: refreshed,
      instanceId: idString(instance._id),
      playerId: idString(instance.player_id),
      sequence: 0,
    })
    cardsProposed += written
    instancesSeeded++
  }
  console.log(`[template-cast] ${template.title}: ${cast.length} authored cast member(s), ${instances.length} instance(s)`)
}

console.log(JSON.stringify({ templatesUpdated, instancesSeeded, cardsProposed }))
process.exit(0)
