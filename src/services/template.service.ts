import { ObjectId } from 'mongodb'
import { coll } from '../config/mongo'
import { getPineconeIndex } from '../config/pinecone'
import { embed } from '../utils/embedding'
import { HttpError } from '../utils/http-error'
import { idString, parseObjectId } from '../utils/mongo-id'

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}

function assertNonEmptyStats(baseStats: Record<string, unknown> | undefined, field: string) {
  if (!baseStats || Object.keys(baseStats).length === 0) {
    throw new HttpError(400, `At least one stat is required (${field})`)
  }
}

export const templateService = {
  async create(creatorId: string, data: any) {
    assertNonEmptyStats(data.base_stats_template, 'base_stats_template')

    const _id = new ObjectId()
    let slug = slugify(data.title)

    const existing = await coll('world_templates').findOne({ slug })
    if (existing) {
      slug = `${slug}-${Date.now().toString(36)}`
    }

    const creatorOid = parseObjectId(creatorId)

    const template = {
      _id,
      creator_id: creatorOid,
      title: data.title,
      slug,
      description: data.description,
      is_published: false,
      is_sentient: data.is_sentient,
      is_nsfw_capable: data.is_nsfw_capable,
      version: 1,
      seed_prompt: data.seed_prompt,
      global_lore: data.global_lore,
      base_stats_template: data.base_stats_template,
      flag_definitions: data.flag_definitions || {},
      scene_tags: data.scene_tags || [],
      model_preferences: {
        logic: data.model_preferences?.logic || 'gpt-4o',
        narration_nsfw: data.model_preferences?.narration_nsfw || 'pygmalionai/mythalion-13b',
        narration_sfw: data.model_preferences?.narration_sfw || 'gpt-4o',
        summary: data.model_preferences?.summary || 'gpt-4o-mini',
      },
      max_context_memories: data.max_context_memories || 25,
      max_lore_results: data.max_lore_results || 10,
      created_at: new Date(),
      updated_at: new Date(),
    }

    await coll('world_templates').insertOne(template)
    return template
  },

  async update(templateId: string, creatorId: string, data: any) {
    const tid = parseObjectId(templateId)
    const creatorOid = parseObjectId(creatorId)

    const existing = await coll('world_templates').findOne({
      _id: tid,
      creator_id: creatorOid,
    })
    if (!existing) throw new Error('Template not found')

    if (data.base_stats_template !== undefined) {
      assertNonEmptyStats(data.base_stats_template, 'base_stats_template')
    }

    const updateFields: any = { ...data, updated_at: new Date() }
    delete updateFields.creator_id
    delete updateFields._id

    await coll('world_templates').updateOne({ _id: tid }, { $set: updateFields })

    return { ...existing, ...updateFields }
  },

  async publish(templateId: string, creatorId: string) {
    const tid = parseObjectId(templateId)
    const creatorOid = parseObjectId(creatorId)

    const template = await coll('world_templates').findOne({
      _id: tid,
      creator_id: creatorOid,
    })
    if (!template) throw new Error('Template not found')

    const loreKey = idString(template._id)
    if (template.global_lore) {
      await embedLore(loreKey, template.global_lore)
    }

    await coll('world_templates').updateOne(
      { _id: tid },
      {
        $set: { is_published: true, updated_at: new Date() },
        $inc: { version: 1 },
      },
    )

    return { success: true }
  },

  async getById(templateId: string) {
    return coll('world_templates').findOne({ _id: parseObjectId(templateId) })
  },

  async listPublished(page: number = 1, limit: number = 20, search?: string) {
    const filter: any = { is_published: true }
    if (search) {
      filter.$or = [
        { title: { $regex: search, $options: 'i' } },
        { description: { $regex: search, $options: 'i' } },
      ]
    }

    const total = await coll('world_templates').countDocuments(filter)
    const templates = await coll('world_templates')
      .find(filter)
      .sort({ created_at: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .toArray()

    return { templates, total, page }
  },

  async listByCreator(creatorId: string) {
    return coll('world_templates')
      .find({ creator_id: parseObjectId(creatorId) })
      .sort({ updated_at: -1 })
      .toArray()
  },
}

async function embedLore(namespaceKey: string, loreText: string) {
  const chunks = chunkText(loreText, 500)
  const index = getPineconeIndex()
  const namespace = index.namespace(`lore_${namespaceKey}`)

  const vectors = await Promise.all(
    chunks.map(async (chunk, i) => {
      const embedding = await embed(chunk)
      return {
        id: `lore_${namespaceKey}_${i}`,
        values: embedding,
        metadata: {
          text: chunk,
          type: 'lore',
          importance: 5,
          is_nsfw: false,
          created_at: new Date().toISOString(),
        },
      }
    }),
  )

  for (let i = 0; i < vectors.length; i += 100) {
    await namespace.upsert({ records: vectors.slice(i, i + 100) })
  }
}

function chunkText(text: string, maxChars: number): string[] {
  const sentences = text.split(/(?<=[.!?])\s+/)
  const chunks: string[] = []
  let current = ''

  for (const sentence of sentences) {
    if (current.length + sentence.length > maxChars && current.length > 0) {
      chunks.push(current.trim())
      current = ''
    }
    current += sentence + ' '
  }
  if (current.trim()) chunks.push(current.trim())

  return chunks
}
