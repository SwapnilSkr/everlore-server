import type { ObjectId } from 'mongodb'
import { mongoColl } from '../config/mongo'

/** A deleted save must not let an already-running chat job write new payload. */
export async function liveInstanceExists(id: ObjectId): Promise<boolean> {
  return Boolean(await mongoColl.worldInstances().findOne({ _id: id }, { projection: { _id: 1 } }))
}
