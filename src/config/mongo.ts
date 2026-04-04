import { MongoClient, Db, type Collection, type Document } from 'mongodb'
import { env } from './env'
import { ensureEverloreIndexes } from './mongo-indexes'

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

  await ensureEverloreIndexes(database)

  console.log('MongoDB connected')
  return database
}

export function getDb(): Db {
  if (!database) throw new Error('MongoDB not connected. Call connectMongo() first.')
  return database
}

