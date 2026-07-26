import { ObjectId } from 'mongodb'
import { mongoColl } from '../config/mongo'
import type {
  FlagDefinitionDoc,
  StatDefinitionDoc,
  WorldTemplateDoc,
} from '../models/world-template.model'
import { getPineconeIndex } from '../config/pinecone'
import { embed } from '../ai'
import { deriveProtagonist } from '../utils/protagonist'
import { HttpError } from '../utils/http-error'
import { idString, parseObjectId } from '../utils/mongo-id'
import { isDefaultCoverUrl, resolveTemplateImageUrl } from '../constants/default-cover'
import { storageService } from './storage.service'
import { familyExpandedKeys } from '../utils/narrative-styles'
import { extractTemplateCast } from '../../worker/lib/template-cast-extractor'

const worldTemplates = () => mongoColl.worldTemplates()
const users = () => mongoColl.users()

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}

function assertValidStats(baseStats: Record<string, unknown> | undefined, field: string) {
  if (!baseStats || Object.keys(baseStats).length === 0) {
    throw new HttpError(400, `At least one stat is required (${field})`)
  }
  const seen = new Set<string>()
  for (const [rawKey, rawDef] of Object.entries(baseStats)) {
    const key = rawKey.trim().toLowerCase().replace(/\s+/g, '_')
    const def = rawDef as Partial<StatDefinitionDoc>
    if (!key || seen.has(key)) throw new HttpError(400, `Stat names must be unique (${field})`)
    seen.add(key)
    if (
      !Number.isFinite(def.min) || !Number.isFinite(def.max) || !Number.isFinite(def.default) ||
      (def.min as number) >= (def.max as number) ||
      (def.default as number) < (def.min as number) ||
      (def.default as number) > (def.max as number)
    ) {
      throw new HttpError(400, `Each stat needs min < max and a default inside that range (${rawKey})`)
    }
    if (typeof def.description !== 'string' || !def.description.trim()) {
      throw new HttpError(400, `Each stat needs a description (${rawKey})`)
    }
  }
}

export const templateService = {
  async create(creatorId: string, data: any): Promise<WorldTemplateDoc> {
    const kind: 'world' | 'character' = data.kind === 'character' ? 'character' : 'world'
    // Characters may be stat-less; Worlds still require at least one stat.
    if (kind === 'world') {
      assertValidStats(data.base_stats_template, 'base_stats_template')
    }

    const _id = new ObjectId()
    let slug = slugify(data.title)

    const existing = await worldTemplates().findOne({ slug })
    if (existing) {
      slug = `${slug}-${Date.now().toString(36)}`
    }

    const creatorOid = parseObjectId(creatorId)

    // Lock the protagonist for sentient templates. Prefer an explicit one
    // (Character creation supplies it); otherwise derive from the seed prompt so
    // existing fantasy sentient worlds also get an accurate, fixed protagonist.
    let protagonist = data.protagonist as WorldTemplateDoc['protagonist']
    if (!protagonist?.name && data.is_sentient) {
      protagonist = (await deriveProtagonist(data.seed_prompt)) || undefined
    }

    // This runs during authoring, never on a play turn. A failure simply leaves
    // the cast empty; it must not block a creator from saving their template.
    const seedCast = await extractTemplateCast({
      title: data.title,
      description: data.description,
      seedPrompt: data.seed_prompt,
      globalLore: data.global_lore,
      openingLine: data.opening_line,
      protagonistName: protagonist?.name,
    })

    // Promote a chosen preview, or assign the universal default when skipped.
    const imageUrl = await resolveTemplateImageUrl(data.image_url)

    const template: WorldTemplateDoc = {
      _id,
      creator_id: creatorOid,
      title: data.title,
      slug,
      description: data.description,
      kind,
      is_published: false,
      is_sentient: data.is_sentient,
      is_nsfw_capable: data.is_nsfw_capable,
      version: 1,
      seed_prompt: data.seed_prompt,
      global_lore: data.global_lore,
      narrative_style: typeof data.narrative_style === 'string' ? data.narrative_style : '',
      style_notes: typeof data.style_notes === 'string' ? data.style_notes.slice(0, 500) : '',
      image_url: imageUrl,
      image_prompt: typeof data.image_prompt === 'string' ? data.image_prompt.slice(0, 1200) : '',
      opening_line: typeof data.opening_line === 'string' ? data.opening_line.trim() : undefined,
      protagonist,
      seed_cast: seedCast,
      base_stats_template: (data.base_stats_template || {}) as Record<string, StatDefinitionDoc>,
      flag_definitions: (data.flag_definitions || {}) as Record<string, FlagDefinitionDoc>,
      scene_tags: data.scene_tags || [],
      // Narration models default to env (NARRATION_SFW_MODEL / _NSFW_MODEL) so
      // they can be A/B'd globally without per-template migrations. Leave empty
      // unless a world needs a specific override.
      model_preferences: {},
      max_context_memories: data.max_context_memories || 25,
      max_lore_results: data.max_lore_results || 10,
      created_at: new Date(),
      updated_at: new Date(),
    }

    await worldTemplates().insertOne(template)
    return template
  },

  async update(templateId: string, creatorId: string, data: any): Promise<WorldTemplateDoc> {
    const tid = parseObjectId(templateId)
    const creatorOid = parseObjectId(creatorId)

    const existing = await worldTemplates().findOne({
      _id: tid,
      creator_id: creatorOid,
    })
    if (!existing) throw new Error('Template not found')

    const effectiveKind = data.kind || existing.kind || 'world'
    if (effectiveKind === 'world' && data.base_stats_template !== undefined) {
      assertValidStats(data.base_stats_template, 'base_stats_template')
    }

    const updateFields: Record<string, unknown> = { ...data, updated_at: new Date() }
    delete updateFields.creator_id
    delete updateFields._id
    delete updateFields.seed_cast

    const castSourceChanged = [
      'title', 'description', 'seed_prompt', 'global_lore', 'opening_line', 'protagonist',
    ].some((key) => Object.prototype.hasOwnProperty.call(data, key))
    if (castSourceChanged) {
      const merged = { ...existing, ...data }
      const protagonist = merged.protagonist as WorldTemplateDoc['protagonist'] | undefined
      updateFields.seed_cast = await extractTemplateCast({
        title: String(merged.title || ''),
        description: String(merged.description || ''),
        seedPrompt: String(merged.seed_prompt || ''),
        globalLore: String(merged.global_lore || ''),
        openingLine: typeof merged.opening_line === 'string' ? merged.opening_line : undefined,
        protagonistName: protagonist?.name,
      })
    }

    // If a new image was chosen (or cleared), promote or fall back to default.
    if (typeof data.image_url === 'string' && data.image_url !== existing.image_url) {
      updateFields.image_url = await resolveTemplateImageUrl(data.image_url)
      if (existing.image_url && !isDefaultCoverUrl(existing.image_url)) {
        const oldKey = storageService.keyFromUrl(existing.image_url)
        if (oldKey) void storageService.delete(oldKey)
      }
    }

    await worldTemplates().updateOne({ _id: tid }, { $set: updateFields })

    return { ...existing, ...updateFields } as WorldTemplateDoc
  },

  async publish(templateId: string, creatorId: string) {
    const tid = parseObjectId(templateId)
    const creatorOid = parseObjectId(creatorId)

    const template = await worldTemplates().findOne({
      _id: tid,
      creator_id: creatorOid,
    })
    if (!template) throw new Error('Template not found')

    const loreKey = idString(template._id)
    if (template.global_lore) {
      await embedLore(loreKey, template.global_lore)
    }

    await worldTemplates().updateOne(
      { _id: tid },
      {
        $set: { is_published: true, updated_at: new Date() },
        $inc: { version: 1 },
      },
    )

    return { success: true }
  },

  async getById(templateId: string) {
    return worldTemplates().findOne({ _id: parseObjectId(templateId) })
  },

  async listPublished(
    page: number = 1,
    limit: number = 20,
    search?: string,
    userId?: string,
  ) {
    const filter: Record<string, unknown> = { is_published: true }
    if (search) {
      filter.$or = [
        { title: { $regex: search, $options: 'i' } },
        { description: { $regex: search, $options: 'i' } },
      ]
    }

    const total = await worldTemplates().countDocuments(filter)

    // Personalize ordering by the player's interests when signed in. Pure boost,
    // never a filter: an exact genre match outranks a same-family match, then
    // recency. Falls back to plain recency when there are no interests.
    const interests = userId ? await this.interestsFor(userId) : []
    if (interests.length > 0) {
      const family = familyExpandedKeys(interests)
      const templates = await worldTemplates()
        .aggregate<WorldTemplateDoc>([
          { $match: filter },
          {
            $addFields: {
              _interest_score: {
                $switch: {
                  branches: [
                    { case: { $in: ['$narrative_style', interests] }, then: 2 },
                    { case: { $in: ['$narrative_style', family] }, then: 1 },
                  ],
                  default: 0,
                },
              },
            },
          },
          { $sort: { _interest_score: -1, created_at: -1 } },
          { $skip: (page - 1) * limit },
          { $limit: limit },
          { $project: { _interest_score: 0 } },
        ])
        .toArray()
      return { templates, total, page }
    }

    const templates = await worldTemplates()
      .find(filter)
      .sort({ created_at: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .toArray()

    return { templates, total, page }
  },

  /** The signed-in player's saved interest keys (empty if none / not found). */
  async interestsFor(userId: string): Promise<string[]> {
    const user = await users().findOne(
      { _id: parseObjectId(userId) },
      { projection: { 'preferences.interests': 1 } },
    )
    const interests = user?.preferences?.interests
    return Array.isArray(interests) ? interests : []
  },

  async listByCreator(creatorId: string): Promise<WorldTemplateDoc[]> {
    return worldTemplates()
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
