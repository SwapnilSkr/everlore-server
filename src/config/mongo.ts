import { MongoClient, Db, type Collection, type Document } from 'mongodb'
import { env } from './env'

/** Custom string IDs (usr_, tpl_, …); not MongoDB ObjectId. */
export type EverloreDoc = Document & { _id: string }

let client: MongoClient | null = null
let database: Db | null = null

export function coll(name: string): Collection<EverloreDoc> {
  return getDb().collection<EverloreDoc>(name)
}

export async function connectMongo(): Promise<Db> {
  client = new MongoClient(env.MONGODB_URI)
  await client.connect()
  database = client.db()

  // Create indexes
  await createIndexes(database)

  console.log('MongoDB connected')
  return database
}

export function getDb(): Db {
  if (!database) throw new Error('MongoDB not connected. Call connectMongo() first.')
  return database
}

async function createIndexes(db: Db) {
  const c = <N extends string>(n: N) => db.collection<EverloreDoc>(n)

  // world_instances
  await c('world_instances').createIndex({ player_id: 1, 'meta.is_archived': 1 })
  await c('world_instances').createIndex({ template_id: 1 })
  await c('world_instances').createIndex({ 'meta.last_active_at': 1 })

  // events
  await c('events').createIndex({ instance_id: 1, sequence: 1 }, { unique: true })
  await c('events').createIndex({ instance_id: 1, type: 1 })
  await c('events').createIndex({ instance_id: 1, scene_tag: 1 })

  // memories
  await c('memories').createIndex({ instance_id: 1, is_archived: 1, importance: -1 })
  await c('memories').createIndex({ instance_id: 1, type: 1 })
  await c('memories').createIndex({ last_accessed_at: 1, importance: 1 })
  await c('memories').createIndex({ pinecone_id: 1 }, { unique: true, sparse: true })

  // scene_summaries
  await c('scene_summaries').createIndex({ instance_id: 1, 'event_range.start_sequence': 1 })

  // world_templates
  await c('world_templates').createIndex({ is_published: 1, created_at: -1 })
  await c('world_templates').createIndex({ creator_id: 1 })
  await c('world_templates').createIndex({ slug: 1 }, { unique: true })

  // users
  await c('users').createIndex({ email: 1 }, { unique: true, sparse: true })
  await c('users').createIndex({ username: 1 }, { unique: true })
  await c('users').createIndex({ phone: 1 }, { unique: true, sparse: true })
  await c('users').createIndex({ google_sub: 1 }, { unique: true, sparse: true })
}
