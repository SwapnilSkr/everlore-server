import { MongoClient, Db } from 'mongodb'
import { env } from './env'

let client: MongoClient | null = null
let database: Db | null = null

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
  // world_instances
  await db.collection('world_instances').createIndex({ player_id: 1, 'meta.is_archived': 1 })
  await db.collection('world_instances').createIndex({ template_id: 1 })
  await db.collection('world_instances').createIndex({ 'meta.last_active_at': 1 })

  // events
  await db.collection('events').createIndex({ instance_id: 1, sequence: 1 }, { unique: true })
  await db.collection('events').createIndex({ instance_id: 1, type: 1 })
  await db.collection('events').createIndex({ instance_id: 1, scene_tag: 1 })

  // memories
  await db.collection('memories').createIndex({ instance_id: 1, is_archived: 1, importance: -1 })
  await db.collection('memories').createIndex({ instance_id: 1, type: 1 })
  await db.collection('memories').createIndex({ last_accessed_at: 1, importance: 1 })
  await db.collection('memories').createIndex({ pinecone_id: 1 }, { unique: true, sparse: true })

  // scene_summaries
  await db.collection('scene_summaries').createIndex({ instance_id: 1, 'event_range.start_sequence': 1 })

  // world_templates
  await db.collection('world_templates').createIndex({ is_published: 1, created_at: -1 })
  await db.collection('world_templates').createIndex({ creator_id: 1 })
  await db.collection('world_templates').createIndex({ slug: 1 }, { unique: true })

  // users
  await db.collection('users').createIndex({ email: 1 }, { unique: true })
  await db.collection('users').createIndex({ username: 1 }, { unique: true })
}
