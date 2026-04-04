import * as argon2 from 'argon2'
import type { Document } from 'mongodb'
import { coll } from '../config/mongo'
import { HttpError } from '../utils/http-error'
import { idString, parseObjectId } from '../utils/mongo-id'
import {
  sendPhoneOtp,
  verifyGoogleIdToken,
  verifyPhoneOtp,
} from './auth-provider.service'

export function defaultUserPreferences() {
  return {
    nsfw_enabled: false,
    preferred_model: 'gpt-4o',
    theme: 'dark',
    narration_length: 'detailed' as const,
    auto_memory_curation: true,
  }
}

function usernameFromSeed(seed: string): string {
  const base = seed
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 20) || 'player'
  return `${base}_${Date.now().toString(36)}`
}

export type JwtUserPayload = {
  id: string
  email: string
  username: string
  tier: string
}

type UserRow = Document & {
  email?: string
  phone?: string
  username?: string
  tier?: string
  preferences?: unknown
  token_balance?: number
  providers?: string[]
  google_sub?: string
  password_hash?: string
}

export const authService = {
  toJwtPayload(user: Document): JwtUserPayload {
    const u = user as UserRow
    return {
      id: idString(u._id),
      email: u.email || '',
      username: typeof u.username === 'string' ? u.username : '',
      tier: typeof u.tier === 'string' ? u.tier : 'free',
    }
  },

  serializeUser(user: Document) {
    const u = user as UserRow
    return {
      id: idString(u._id),
      email: u.email || '',
      phone: u.phone || null,
      username: typeof u.username === 'string' ? u.username : '',
      tier: typeof u.tier === 'string' ? u.tier : 'free',
      preferences: u.preferences,
      token_balance: u.token_balance,
    }
  },

  async registerWithPassword(input: { email: string; username: string; password: string }) {
    const { email, username, password } = input
    const existing = await coll('users').findOne({
      $or: [{ email }, { username }],
    })
    if (existing) {
      throw new HttpError(
        409,
        existing.email === email ? 'Email already registered' : 'Username taken',
      )
    }

    const passwordHash = await argon2.hash(password)

    const doc = {
      email,
      username,
      password_hash: passwordHash,
      tier: 'free',
      providers: ['password'],
      preferences: defaultUserPreferences(),
      token_balance: 15000,
      created_at: new Date(),
      updated_at: new Date(),
    }

    const { insertedId } = await coll('users').insertOne(doc)
    return { ...doc, _id: insertedId }
  },

  async authenticatePassword(input: { email: string; password: string }): Promise<Document> {
    const userDoc = await coll('users').findOne({ email: input.email })
    if (!userDoc) throw new HttpError(401, 'Invalid credentials')

    const valid = await argon2.verify(userDoc.password_hash as string, input.password)
    if (!valid) throw new HttpError(401, 'Invalid credentials')

    return userDoc
  },

  async signInWithGoogle(idToken: string): Promise<Document> {
    const profile = await verifyGoogleIdToken(idToken)

    let userDoc: Document | null = await coll('users').findOne({
      $or: [{ google_sub: profile.subject }, { email: profile.email }],
    })

    if (!userDoc) {
      const doc = {
        email: profile.email,
        google_sub: profile.subject,
        username: usernameFromSeed(profile.email.split('@')[0] || profile.name || 'player'),
        password_hash: '',
        tier: 'free',
        providers: ['google'],
        preferences: defaultUserPreferences(),
        token_balance: 15000,
        created_at: new Date(),
        updated_at: new Date(),
      }
      const { insertedId } = await coll('users').insertOne(doc)
      userDoc = { ...doc, _id: insertedId }
    } else {
      const prev = userDoc as UserRow
      const providers = Array.isArray(prev.providers)
        ? new Set<string>(prev.providers)
        : new Set<string>()
      providers.add('google')

      await coll('users').updateOne(
        { _id: userDoc._id },
        {
          $set: {
            email: profile.email,
            google_sub: profile.subject,
            providers: [...providers],
            updated_at: new Date(),
          },
        },
      )

      userDoc = {
        ...userDoc,
        email: profile.email,
        google_sub: profile.subject,
        providers: [...providers],
      }
    }

    return userDoc
  },

  async sendPhoneOtp(phone: string) {
    await sendPhoneOtp(phone)
  },

  async signInWithPhoneOtp(phone: string, code: string): Promise<Document> {
    const approved = await verifyPhoneOtp(phone, code)
    if (!approved) throw new HttpError(400, 'Invalid verification code')

    let userDoc: Document | null = await coll('users').findOne({ phone })

    if (!userDoc) {
      const doc = {
        phone,
        username: usernameFromSeed(phone),
        password_hash: '',
        tier: 'free',
        providers: ['phone'],
        preferences: defaultUserPreferences(),
        token_balance: 15000,
        created_at: new Date(),
        updated_at: new Date(),
      }
      const { insertedId } = await coll('users').insertOne(doc)
      userDoc = { ...doc, _id: insertedId }
    } else {
      const prev = userDoc as UserRow
      const providers = Array.isArray(prev.providers)
        ? new Set<string>(prev.providers)
        : new Set<string>()
      providers.add('phone')

      await coll('users').updateOne(
        { _id: userDoc._id },
        {
          $set: {
            phone,
            providers: [...providers],
            updated_at: new Date(),
          },
        },
      )

      userDoc = {
        ...userDoc,
        phone,
        providers: [...providers],
      }
    }

    return userDoc
  },

  async getUserById(userId: string) {
    const dbUser = await coll('users').findOne({ _id: parseObjectId(userId) })
    if (!dbUser) throw new HttpError(404, 'User not found')
    return dbUser
  },

  async updatePreferences(userId: string, body: Record<string, unknown>) {
    const updateFields: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(body)) {
      updateFields[`preferences.${key}`] = value
    }
    updateFields.updated_at = new Date()

    await coll('users').updateOne({ _id: parseObjectId(userId) }, { $set: updateFields })
  },
}
