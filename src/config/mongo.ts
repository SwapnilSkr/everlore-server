import { MongoClient, Db, type Collection, type Document, type WithoutId } from 'mongodb'
import { env } from './env'
import { ensureEverloreIndexes } from './mongo-indexes'
import { COLLECTIONS } from '../models/collections'
import type { UserDoc } from '../models/user.model'
import type { WorldTemplateDoc } from '../models/world-template.model'
import type { WorldInstanceDoc } from '../models/world-instance.model'
import type { WorldEventDoc } from '../models/world-event.model'
import type { MemoryDoc } from '../models/memory.model'
import type { SceneSummaryDoc } from '../models/scene-summary.model'
import type { ChapterSummaryDoc } from '../models/chapter-summary.model'
import type { ArcSummaryDoc } from '../models/arc-summary.model'
import type { CharacterProfileDoc } from '../models/character-profile.model'
import type { EntityDoc } from '../models/entity.model'
import type { EntityEdgeDoc } from '../models/entity-edge.model'
import type { StoryCalendarDoc, TimelineBranchDoc } from '../models/time.model'
import type { PersonaDoc } from '../models/persona.model'
import type { DeadLetterJobDoc } from '../models/dead-letter-job.model'
import type { GenerationLogDoc } from '../models/generation-log.model'
import type { NsfwTermDoc } from '../models/nsfw-term.model'
import type { ProjectionAnomalyDoc } from '../models/projection-anomaly.model'

let client: MongoClient | null = null
let database: Db | null = null

/** Low-level access; prefer {@link mongoColl} for typed collections. */
export function coll<T extends Document = Document>(name: string): Collection<T> {
  return getDb().collection<T>(name)
}

/**
 * Typed MongoDB collections (single source of truth with {@link COLLECTIONS}).
 * Use {@link WithoutId} for the collection schema so `insertOne` accepts valid writes;
 * reads are still full document types with `_id` (e.g. {@link UserDoc}).
 */
export const mongoColl = {
  users: () => coll<WithoutId<UserDoc>>(COLLECTIONS.users),
  worldTemplates: () => coll<WithoutId<WorldTemplateDoc>>(COLLECTIONS.world_templates),
  worldInstances: () => coll<WithoutId<WorldInstanceDoc>>(COLLECTIONS.world_instances),
  events: () => coll<WithoutId<WorldEventDoc>>(COLLECTIONS.events),
  memories: () => coll<WithoutId<MemoryDoc>>(COLLECTIONS.memories),
  sceneSummaries: () => coll<WithoutId<SceneSummaryDoc>>(COLLECTIONS.scene_summaries),
  chapterSummaries: () => coll<WithoutId<ChapterSummaryDoc>>(COLLECTIONS.chapter_summaries),
  arcSummaries: () => coll<WithoutId<ArcSummaryDoc>>(COLLECTIONS.arc_summaries),
  characters: () => coll<WithoutId<CharacterProfileDoc>>(COLLECTIONS.characters),
  entities: () => coll<WithoutId<EntityDoc>>(COLLECTIONS.entities),
  entityEdges: () => coll<WithoutId<EntityEdgeDoc>>(COLLECTIONS.entity_edges),
  storyCalendars: () => coll<WithoutId<StoryCalendarDoc>>(COLLECTIONS.story_calendars),
  timelineBranches: () => coll<WithoutId<TimelineBranchDoc>>(COLLECTIONS.timeline_branches),
  personas: () => coll<WithoutId<PersonaDoc>>(COLLECTIONS.personas),
  deadLetterJobs: () => coll<WithoutId<DeadLetterJobDoc>>(COLLECTIONS.dead_letter_jobs),
  generationLogs: () => coll<WithoutId<GenerationLogDoc>>(COLLECTIONS.generation_logs),
  nsfwLexicon: () => coll<WithoutId<NsfwTermDoc>>(COLLECTIONS.nsfw_lexicon),
  projectionAnomalies: () => coll<WithoutId<ProjectionAnomalyDoc>>(COLLECTIONS.projection_anomalies),
} as const

export async function connectMongo(): Promise<Db> {
  client = new MongoClient(env.MONGODB_URI)
  await client.connect()
  database = client.db()

  await ensureEverloreIndexes(database)

  console.log('MongoDB connected')
  return database
}

export function getDb(): Db {
  if (!database) throw new Error('MongoDB not connected. Call connectMongo() first.')
  return database
}
