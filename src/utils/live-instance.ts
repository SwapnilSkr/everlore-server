import type { ObjectId } from 'mongodb'
import { mongoColl } from '../config/mongo'

/** True while a chat save or a walk save with this id still exists. */
export async function liveInstanceExists(id: ObjectId): Promise<boolean> {
  const [chat, walk] = await Promise.all([
    mongoColl.worldInstances().findOne({ _id: id }, { projection: { _id: 1 } }),
    mongoColl.interactiveWorldInstances().findOne({ _id: id }, { projection: { _id: 1 } }),
  ])
  return Boolean(chat || walk)
}
