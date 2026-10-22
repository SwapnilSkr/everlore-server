import { ObjectId, type UpdateFilter } from 'mongodb'
import { mongoColl } from '../config/mongo'
import type {
  FlagDefinitionDoc,
  StatDefinitionDoc,
  WorldTemplateDoc,
} from '../models/world-template.model'
import { vectorStore } from './vector-store'
import { embed } from '../ai'
import { deriveProtagonist } from '../utils/protagonist'
import { HttpError } from '../utils/http-error'
import { idString, parseObjectId } from '../utils/mongo-id'
import { isDefaultCoverUrl, resolveTemplateImageUrl } from '../constants/default-cover'
import { storageService } from './storage.service'
import { familyExpandedKeys } from '../utils/narrative-styles'
import { extractTemplateCast } from '../../worker/lib/template-cast-extractor'
import { FIELD_LIMITS } from '../schemas/template.schema'
import { moderationService } from './moderation.service'
import { hasMeaningfulWorldEdit, publishReviewUpdate } from '../utils/world-review'
import {
  deriveGenre,
  forYouOrder,
  GENRES,
  genreFilter,
  resolveGenre,
  type Genre,
} from '../utils/genre'

const worldTemplates = () => mongoColl.worldTemplates()
const users = () => mongoColl.users()

/** Explore options beyond paging and search; mirrors the query schema. */
export interface TemplateListFilters {
  kind?: 'world' | 'character'
  genre?: Genre
  styles?: string[]
  sort?: 'foryou' | 'new'
}

/** One narration voice's counts inside a shelf, split by kind. */
export interface VoiceCount {
  worlds: number
  characters: number
}

export interface GenreCount {
  key: Genre
  label: string
  worlds: number
  characters: number
  styles: Record<string, VoiceCount>
}

/** Counts are per player only because moderation blocks are; everyone else shares. */
const GENRE_CACHE_TTL_MS = 60_000
const ANONYMOUS_GENRE_CACHE_KEY = 'anonymous'
const genreCountCache = new Map<string, { at: number; genres: GenreCount[] }>()

function cloneGenreCounts(genres: GenreCount[]): GenreCount[] {
  return genres.map((genre) => ({
    ...genre,
    styles: Object.fromEntries(
      Object.entries(genre.styles).map(([voice, counts]) => [voice, { ...counts }]),
    ),
  }))
}

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
      genre: resolveGenre(data.genre, data.narrative_style),
      is_published: false,
      is_sentient: data.is_sentient,
      is_nsfw_capable: data.is_nsfw_capable,
      version: 1,
      seed_prompt: data.seed_prompt,
      global_lore: data.global_lore,
      narrative_style: typeof data.narrative_style === 'string' ? data.narrative_style : '',
      style_notes: typeof data.style_notes === 'string' ? data.style_notes.slice(0, 500) : '',
      image_url: imageUrl,
      image_prompt: typeof data.image_prompt === 'string' ? data.image_prompt.slice(0, FIELD_LIMITS.imagePrompt) : '',
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

    // An authored genre always wins. A world from before the backfill has no
    // stored genre yet, so a new voice re-derives its shelf instead of leaving
    // it homeless.
    if (data.genre === undefined && existing.genre === undefined &&
      data.narrative_style !== undefined && data.narrative_style !== existing.narrative_style) {
      updateFields.genre = deriveGenre(data.narrative_style)
    }

    const castSourceChanged = [
      'title', 'description', 'seed_prompt', 'global_lore', 'opening_line', 'protagonist',
    ].some((key) => Object.prototype.hasOwnProperty.call(data, key) &&
      hasMeaningfulWorldEdit(existing, { [key]: data[key] }))
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

    if (existing.visibility === 'public' && existing.review_status === 'approved' &&
      hasMeaningfulWorldEdit(existing, updateFields)) {
      updateFields.review_status = 'pending'
      updateFields.submitted_at = new Date()
      updateFields.ever_approved = true
    }
    // A legacy published world is approved too, even before it has review fields.
    if (existing.is_published && existing.visibility === undefined &&
      hasMeaningfulWorldEdit(existing, updateFields)) {
      updateFields.visibility = 'public'
      updateFields.review_status = 'pending'
      updateFields.submitted_at = new Date()
      updateFields.ever_approved = true
    }

    const result = await worldTemplates().updateOne(
      {
        _id: tid,
        creator_id: creatorOid,
        visibility: existing.visibility ?? { $exists: false },
        review_status: existing.review_status ?? { $exists: false },
      },
      { $set: updateFields },
    )
    if (result.matchedCount === 0) {
      throw new HttpError(409, 'This world changed while you were editing. Please reopen it.')
    }

    return { ...existing, ...updateFields } as WorldTemplateDoc
  },

  async publish(templateId: string, creatorId: string, visibility: 'private' | 'public' = 'private') {
    const tid = parseObjectId(templateId)
    const creatorOid = parseObjectId(creatorId)

    const template = await worldTemplates().findOne({
      _id: tid,
      creator_id: creatorOid,
    })
    if (!template) throw new Error('Template not found')

    const loreKey = idString(template._id)
    await embedLore(loreKey, template.global_lore || '')

    const update = publishReviewUpdate(template, visibility)
    const result = await worldTemplates().updateOne(
      {
        _id: tid,
        creator_id: creatorOid,
        visibility: template.visibility ?? { $exists: false },
        review_status: template.review_status ?? { $exists: false },
      },
      update as UpdateFilter<WorldTemplateDoc>,
    )
    if (result.matchedCount === 0) {
      throw new HttpError(409, 'This world changed while you were sharing it. Please reopen it.')
    }
    return {
      success: true,
      visibility,
      ...('review_status' in update.$set ? { review_status: update.$set.review_status } : {}),
    }
  },

  async getById(templateId: string) {
    return worldTemplates().findOne({ _id: parseObjectId(templateId) })
  },

  async listPublished(
    page: number = 1,
    limit: number = 20,
    search?: string,
    userId?: string,
    filters: TemplateListFilters = {},
  ) {
    // Discovery must never surface admin-hidden worlds, nor anything this
    // player has blocked. Merged in before the search terms so both a plain
    // listing and a search go through the same gate.
    const filter: Record<string, unknown> = {
      is_published: true,
      ...(await moderationService.discoveryFilter(userId)),
    }
    // Everything that narrows the set goes into $and so it composes with the
    // discovery filter's own $or.
    const clauses: Record<string, unknown>[] = []
    if (search) {
      clauses.push({ $or: [
        { title: { $regex: search, $options: 'i' } },
        { description: { $regex: search, $options: 'i' } },
      ] })
    }
    if (filters.kind) {
      // kind is absent on worlds written before characters existed; the model
      // treats those as 'world', so the Worlds filter must too.
      clauses.push(filters.kind === 'world'
        ? { $or: [{ kind: 'world' }, { kind: null }] }
        : { kind: 'character' })
    }
    if (filters.genre) clauses.push(genreFilter(filters.genre))
    if (filters.styles?.length) filter.narrative_style = { $in: filters.styles }
    if (clauses.length > 0) filter.$and = clauses

    // Filters apply before the count, so a tab's badge and its list agree.
    const total = await worldTemplates().countDocuments(filter)
    const skip = (page - 1) * limit

    if ((filters.sort ?? 'foryou') === 'new') {
      const templates = await worldTemplates()
        .find(filter)
        .sort({ created_at: -1 })
        .skip(skip)
        .limit(limit)
        .toArray()
      return { templates, total, page }
    }

    // For You is one mixed feed. Narrowing by kind, shelf or voice switches to
    // the ranked order below instead.
    if (!filters.kind && !filters.genre && !filters.styles?.length) {
      return { ...(await this.forYouPage(filter, total, skip, limit, userId)), page }
    }

    // Personalize ordering by the player's interests when signed in. Pure boost,
    // never a filter: an exact voice match outranks a same-family match, then
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
          { $skip: skip },
          { $limit: limit },
          { $project: { _interest_score: 0 } },
        ])
        .toArray()
      return { templates, total, page }
    }

    const templates = await worldTemplates()
      .find(filter)
      .sort({ created_at: -1 })
      .skip(skip)
      .limit(limit)
      .toArray()

    return { templates, total, page }
  },

  /**
   * The mixed For You page. Ordering is computed over the whole listed set and
   * then paged (see forYouOrder), so interests weight the feed without ever
   * splitting it into one genre.
   */
  async forYouPage(
    filter: Record<string, unknown>,
    total: number,
    skip: number,
    limit: number,
    userId?: string,
  ) {
    const interests = userId ? await this.interestsFor(userId) : []
    const rows = await worldTemplates()
      .find(filter, { projection: { genre: 1, narrative_style: 1, created_at: 1 } })
      .sort({ created_at: -1 })
      .skip(0)
      .limit(Math.max(total, 1))
      .toArray()
    const ordered = forYouOrder(
      rows.map((row) => ({
        id: idString(row._id),
        genre: row.genre,
        narrative_style: row.narrative_style,
        created_at: row.created_at,
      })),
      interests,
    )
    const pageIds = ordered.slice(skip, skip + limit).map((candidate) => parseObjectId(candidate.id))
    if (pageIds.length === 0) return { templates: [] as WorldTemplateDoc[], total }

    // The page's documents are fetched in one read and restored to the feed's
    // order; a database sort cannot reproduce a round-robin.
    const docs = await worldTemplates().find({ _id: { $in: pageIds } }).toArray()
    const byId = new Map(docs.map((doc) => [idString(doc._id), doc]))
    const templates = pageIds
      .map((id) => byId.get(idString(id)))
      .filter((doc): doc is WorldTemplateDoc => Boolean(doc))
    return { templates, total }
  },

  /**
   * The shelves and their counts, for the app's tab bar and filter sheet. Counts
   * use the same discovery gate as the list; a world written before the backfill
   * counts where its voice derives.
   */
  async listGenres(userId?: string | null, now: number = Date.now()) {
    const cacheKey = userId || ANONYMOUS_GENRE_CACHE_KEY
    const cached = genreCountCache.get(cacheKey)
    if (cached && now - cached.at < GENRE_CACHE_TTL_MS) {
      return { genres: cloneGenreCounts(cached.genres) }
    }

    const filter: Record<string, unknown> = {
      is_published: true,
      ...(await moderationService.discoveryFilter(userId)),
    }
    const rows = await worldTemplates()
      .find(filter, { projection: { genre: 1, narrative_style: 1, kind: 1 } })
      .toArray()

    const counts = new Map<Genre, GenreCount>()
    for (const { key, label } of GENRES) {
      counts.set(key, { key, label, worlds: 0, characters: 0, styles: {} })
    }
    for (const row of rows) {
      const bucket = counts.get(resolveGenre(row.genre, row.narrative_style))!
      const isCharacter = row.kind === 'character'
      if (isCharacter) bucket.characters++
      else bucket.worlds++
      // A voice carries its own per-kind counts, so the sheet can offer only the
      // interests that match the Worlds or Characters option on screen.
      const voice = typeof row.narrative_style === 'string' ? row.narrative_style.trim() : ''
      if (voice) {
        const voiceCounts = bucket.styles[voice] ?? { worlds: 0, characters: 0 }
        bucket.styles[voice] = voiceCounts
        if (isCharacter) voiceCounts.characters++
        else voiceCounts.worlds++
      }
    }

    const genres = GENRES.map(({ key }) => counts.get(key)!)
    if (genreCountCache.size > 1000) {
      for (const [key, entry] of genreCountCache) {
        if (now - entry.at >= GENRE_CACHE_TTL_MS) genreCountCache.delete(key)
      }
    }
    genreCountCache.set(cacheKey, { at: now, genres })
    return { genres: cloneGenreCounts(genres) }
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

  async listByCreator(creatorId: string, page: number = 1, limit: number = 20, search?: string) {
    const filter: Record<string, unknown> = { creator_id: parseObjectId(creatorId) }
    const term = search?.trim()
    if (term) {
      filter.$or = [
        { title: { $regex: term, $options: 'i' } },
        { description: { $regex: term, $options: 'i' } },
      ]
    }
    const safePage = Math.max(1, page)
    const safeLimit = Math.min(50, Math.max(1, limit))
    const [templates, total] = await Promise.all([
      worldTemplates()
      .find(filter)
      .sort({ updated_at: -1 })
      .skip((safePage - 1) * safeLimit)
      .limit(safeLimit)
      .toArray()
      ,
      worldTemplates().countDocuments(filter),
    ])
    return { templates, total, page: safePage }
  },
}

async function embedLore(namespaceKey: string, loreText: string) {
  const chunks = chunkText(loreText, 500)

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

  await vectorStore.replaceLore({ kind: 'lore', templateId: namespaceKey }, vectors)
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
