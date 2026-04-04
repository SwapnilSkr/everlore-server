import { ObjectId } from 'mongodb'
import { HttpError } from './http-error'

/** Invalid MongoDB ObjectId (maps to 400 in global error handler). */
export class BadIdError extends HttpError {
  constructor(message = 'Invalid id') {
    super(400, message)
    this.name = 'BadIdError'
  }
}

export function parseObjectId(id: string): ObjectId {
  if (!id || typeof id !== 'string') throw new BadIdError('Invalid id')
  const trimmed = id.trim()
  if (!ObjectId.isValid(trimmed)) throw new BadIdError('Invalid id')
  try {
    return new ObjectId(trimmed)
  } catch {
    throw new BadIdError('Invalid id')
  }
}

/** Hex string for APIs, Redis keys, Pinecone namespaces, Bull job payloads. */
export function idString(id: unknown): string {
  if (id instanceof ObjectId) return id.toHexString()
  if (typeof id === 'string') return id
  return String(id)
}
