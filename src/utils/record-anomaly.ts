import { ObjectId } from 'mongodb'
import { mongoColl } from '../config/mongo'
import { parseObjectId } from './mongo-id'
import { log } from './logger'
import type {
  ProjectionAnomalySeverity,
  ProjectionAnomalyType,
} from '../models/projection-anomaly.model'

/**
 * Write one projection anomaly.
 *
 * Anomalies are observability, so this NEVER throws — a failure to record a
 * failure must not become a second failure. It is deliberately the only writer
 * outside the batch insert on the generation tail, so every new inconsistency
 * check gets the same shape without repeating the document literal.
 */
export async function recordAnomaly(params: {
  instanceId: string | ObjectId
  playerId: string | ObjectId
  eventId?: ObjectId | null
  sequence: number
  type: ProjectionAnomalyType
  severity: ProjectionAnomalySeverity
  details: string
}): Promise<void> {
  try {
    await mongoColl.projectionAnomalies().insertOne({
      _id: new ObjectId(),
      instance_id:
        typeof params.instanceId === 'string' ? parseObjectId(params.instanceId) : params.instanceId,
      player_id:
        typeof params.playerId === 'string' ? parseObjectId(params.playerId) : params.playerId,
      event_id: params.eventId ?? null,
      sequence: params.sequence,
      type: params.type,
      severity: params.severity,
      details: params.details.slice(0, 500),
      created_at: new Date(),
      resolved_at: null,
    })
  } catch (err) {
    log.warn('anomaly.record_failed', {
      type: params.type,
      reason: (err as Error).message,
    })
  }
}
