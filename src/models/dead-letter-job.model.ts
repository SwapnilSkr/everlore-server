import type { ObjectId } from 'mongodb'

/**
 * dead_letter_jobs — failed BullMQ jobs persisted for inspection.
 */
export interface DeadLetterJobDoc {
  _id: ObjectId
  queue: string
  jobId: string | number | undefined
  data: unknown
  error: string
  stack?: string
  failedAt: Date
}
