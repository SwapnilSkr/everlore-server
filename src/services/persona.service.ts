import { ObjectId } from 'mongodb'
import { mongoColl } from '../config/mongo'
import { getRedisClient } from '../config/redis'
import type { PersonaDoc, PersonaGender, PersonaSnapshotDoc } from '../models/persona.model'
import { HttpError } from '../utils/http-error'
import { idString, parseObjectId } from '../utils/mongo-id'

const personas = () => mongoColl.personas()
const worldInstances = () => mongoColl.worldInstances()

export const PERSONA_LIMITS = {
  name: 60,
  description: 500,
  otherInfo: 500,
  minAge: 13,
  maxAge: 120,
} as const

export type PersonaInput = {
  name?: string
  gender?: PersonaGender
  age?: number | null
  description?: string
  other_info?: string
}

function cleanText(value: unknown, max: number): string {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
}

function cleanGender(value: unknown): PersonaGender {
  if (value === 'male' || value === 'female' || value === 'non_binary') return value
  throw new HttpError(400, 'Invalid persona gender')
}

function cleanAge(value: unknown): number | null {
  if (value === undefined || value === null || value === '') return null
  const n = Number(value)
  if (!Number.isInteger(n) || n < PERSONA_LIMITS.minAge || n > PERSONA_LIMITS.maxAge) {
    throw new HttpError(400, 'Invalid persona age')
  }
  return n
}

function snapshotFromPersona(persona: Pick<PersonaDoc, 'name' | 'gender' | 'age' | 'description' | 'other_info'>): PersonaSnapshotDoc {
  return {
    name: persona.name,
    gender: persona.gender,
    age: persona.age ?? null,
    description: persona.description || '',
    other_info: persona.other_info || '',
  }
}

function toApi(persona: PersonaDoc) {
  return {
    id: idString(persona._id),
    name: persona.name,
    gender: persona.gender,
    age: persona.age ?? null,
    description: persona.description || '',
    other_info: persona.other_info || '',
    created_at: persona.created_at,
    updated_at: persona.updated_at,
  }
}

export const personaService = {
  snapshotFromPersona,

  async list(playerId: string) {
    const rows = await personas()
      .find({ player_id: parseObjectId(playerId) })
      .sort({ updated_at: -1 })
      .toArray()
    return { personas: rows.map((p: any) => toApi(p)) }
  },

  async create(playerId: string, input: Required<Pick<PersonaInput, 'name' | 'gender'>> & PersonaInput) {
    const name = cleanText(input.name, PERSONA_LIMITS.name)
    if (name.length < 1) throw new HttpError(400, 'Persona name is required')

    const now = new Date()
    const doc = {
      _id: new ObjectId(),
      player_id: parseObjectId(playerId),
      name,
      gender: cleanGender(input.gender),
      age: cleanAge(input.age),
      description: cleanText(input.description, PERSONA_LIMITS.description),
      other_info: cleanText(input.other_info, PERSONA_LIMITS.otherInfo),
      created_at: now,
      updated_at: now,
    }
    await personas().insertOne(doc as any)
    return { persona: toApi(doc as PersonaDoc) }
  },

  async update(playerId: string, personaId: string, input: PersonaInput) {
    const pid = parseObjectId(playerId)
    const personaOid = parseObjectId(personaId)

    const existing = await personas().findOne({ _id: personaOid, player_id: pid })
    if (!existing) throw new HttpError(404, 'Persona not found')

    // Build the set of fields that actually change vs. the stored persona, so a
    // no-op save (same values, or an empty patch) does no DB write and no cache
    // busting. Each cleaned candidate is compared to the current stored value.
    const changes: Record<string, unknown> = {}
    if (input.name !== undefined) {
      const name = cleanText(input.name, PERSONA_LIMITS.name)
      if (!name) throw new HttpError(400, 'Persona name is required')
      if (name !== existing.name) changes.name = name
    }
    if (input.gender !== undefined) {
      const gender = cleanGender(input.gender)
      if (gender !== existing.gender) changes.gender = gender
    }
    if (input.age !== undefined) {
      const age = cleanAge(input.age)
      if (age !== (existing.age ?? null)) changes.age = age
    }
    if (input.description !== undefined) {
      const description = cleanText(input.description, PERSONA_LIMITS.description)
      if (description !== (existing.description || '')) changes.description = description
    }
    if (input.other_info !== undefined) {
      const otherInfo = cleanText(input.other_info, PERSONA_LIMITS.otherInfo)
      if (otherInfo !== (existing.other_info || '')) changes.other_info = otherInfo
    }

    // Nothing actually changed — skip the write and the fan-out entirely.
    if (Object.keys(changes).length === 0) {
      return { persona: toApi(existing as PersonaDoc) }
    }

    const result = await personas().findOneAndUpdate(
      { _id: personaOid, player_id: pid },
      { $set: { ...changes, updated_at: new Date() } },
      { returnDocument: 'after' },
    )
    if (!result) throw new HttpError(404, 'Persona not found')

    // Refresh-on-edit: re-write the snapshot into every instance still pointing
    // at this persona so active chats pick up the change, and bust their session
    // caches. Already-seeded GM protagonists are canon and are left untouched.
    const snapshot = snapshotFromPersona(result as PersonaDoc)
    const affected = await worldInstances()
      .find({ player_id: pid, persona_id: personaOid }, { projection: { _id: 1 } })
      .toArray()
    if (affected.length > 0) {
      await worldInstances().updateMany(
        { player_id: pid, persona_id: personaOid },
        { $set: { persona_snapshot: snapshot, updated_at: new Date() } },
      )
      const redis = getRedisClient()
      await Promise.all(affected.map((i: any) => redis.del(`session:${idString(i._id)}`)))
    }
    return { persona: toApi(result as any) }
  },

  async delete(playerId: string, personaId: string) {
    const pid = parseObjectId(playerId)
    const personaOid = parseObjectId(personaId)
    const result = await personas().deleteOne({ _id: personaOid, player_id: pid })
    if (result.deletedCount === 0) throw new HttpError(404, 'Persona not found')
    const affected = await worldInstances()
      .find({ player_id: pid, persona_id: personaOid }, { projection: { _id: 1 } })
      .toArray()
    await worldInstances().updateMany(
      { player_id: pid, persona_id: personaOid },
      { $set: { persona_id: null, persona_snapshot: null, updated_at: new Date() } },
    )
    if (affected.length > 0) {
      const redis = getRedisClient()
      await Promise.all(affected.map((i: any) => redis.del(`session:${idString(i._id)}`)))
    }
    return { success: true }
  },
}
