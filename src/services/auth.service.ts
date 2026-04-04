import * as argon2 from 'argon2'
import { mongoColl } from '../config/mongo'
import type { UserDoc, UserInsertDoc, UserTier } from '../models/user.model'
import { HttpError } from '../utils/http-error'
import { idString, parseObjectId } from '../utils/mongo-id'
import {
  sendPhoneOtp,
  verifyGoogleIdToken,
  verifyPhoneOtp,
} from './auth-provider.service'

export function defaultUserPreferences(): UserDoc['preferences'] {
  return {
    nsfw_enabled: false,
    preferred_model: 'gpt-4o',
    theme: 'dark',
    narration_length: 'detailed',
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

const users = () => mongoColl.users()

export const authService = {
  toJwtPayload(user: UserDoc): JwtUserPayload {
    return {
      id: idString(user._id),
      email: user.email || '',
      username: user.username,
      tier: user.tier,
    }
  },

  serializeUser(user: UserDoc) {
    return {
      id: idString(user._id),
      email: user.email || '',
      phone: user.phone || null,
      username: user.username,
      tier: user.tier,
      preferences: user.preferences,
      token_balance: user.token_balance,
    }
  },

  async registerWithPassword(input: { email: string; username: string; password: string }) {
    const { email, username, password } = input
    const existing = await users().findOne({
      $or: [{ email }, { username }],
    })
    if (existing) {
      throw new HttpError(
        409,
        existing.email === email ? 'Email already registered' : 'Username taken',
      )
    }

    const passwordHash = await argon2.hash(password)

    const doc: UserInsertDoc = {
      email,
      username,
      password_hash: passwordHash,
      tier: 'free' as UserTier,
      providers: ['password'],
      preferences: defaultUserPreferences(),
      token_balance: 15000,
      created_at: new Date(),
      updated_at: new Date(),
    }

    const { insertedId } = await users().insertOne(doc)
    return { ...doc, _id: insertedId } as UserDoc
  },

  async authenticatePassword(input: { email: string; password: string }): Promise<UserDoc> {
    const userDoc = await users().findOne({ email: input.email })
    if (!userDoc) throw new HttpError(401, 'Invalid credentials')

    const valid = await argon2.verify(userDoc.password_hash, input.password)
    if (!valid) throw new HttpError(401, 'Invalid credentials')

    return userDoc
  },

  async signInWithGoogle(idToken: string): Promise<UserDoc> {
    const profile = await verifyGoogleIdToken(idToken)

    let userDoc: UserDoc | null = await users().findOne({
      $or: [{ google_sub: profile.subject }, { email: profile.email }],
    })

    if (!userDoc) {
      const doc: UserInsertDoc = {
        email: profile.email,
        google_sub: profile.subject,
        username: usernameFromSeed(profile.email.split('@')[0] || profile.name || 'player'),
        password_hash: '',
        tier: 'free' as UserTier,
        providers: ['google'],
        preferences: defaultUserPreferences(),
        token_balance: 15000,
        created_at: new Date(),
        updated_at: new Date(),
      }
      const { insertedId } = await users().insertOne(doc)
      userDoc = { ...doc, _id: insertedId } as UserDoc
    } else {
      const prov = Array.isArray(userDoc.providers)
        ? new Set<string>(userDoc.providers)
        : new Set<string>()
      prov.add('google')

      await users().updateOne(
        { _id: userDoc._id },
        {
          $set: {
            email: profile.email,
            google_sub: profile.subject,
            providers: [...prov],
            updated_at: new Date(),
          },
        },
      )

      userDoc = {
        ...userDoc,
        email: profile.email,
        google_sub: profile.subject,
        providers: [...prov],
      }
    }

    return userDoc
  },

  async sendPhoneOtp(phone: string) {
    await sendPhoneOtp(phone)
  },

  async signInWithPhoneOtp(phone: string, code: string): Promise<UserDoc> {
    const approved = await verifyPhoneOtp(phone, code)
    if (!approved) throw new HttpError(400, 'Invalid verification code')

    let userDoc: UserDoc | null = await users().findOne({ phone })

    if (!userDoc) {
      const doc: UserInsertDoc = {
        phone,
        username: usernameFromSeed(phone),
        password_hash: '',
        tier: 'free' as UserTier,
        providers: ['phone'],
        preferences: defaultUserPreferences(),
        token_balance: 15000,
        created_at: new Date(),
        updated_at: new Date(),
      }
      const { insertedId } = await users().insertOne(doc)
      userDoc = { ...doc, _id: insertedId } as UserDoc
    } else {
      const prov = Array.isArray(userDoc.providers)
        ? new Set<string>(userDoc.providers)
        : new Set<string>()
      prov.add('phone')

      await users().updateOne(
        { _id: userDoc._id },
        {
          $set: {
            phone,
            providers: [...prov],
            updated_at: new Date(),
          },
        },
      )

      userDoc = {
        ...userDoc,
        phone,
        providers: [...prov],
      }
    }

    return userDoc
  },

  async getUserById(userId: string): Promise<UserDoc> {
    const dbUser = await users().findOne({ _id: parseObjectId(userId) })
    if (!dbUser) throw new HttpError(404, 'User not found')
    return dbUser
  },

  async updatePreferences(userId: string, body: Record<string, unknown>) {
    const updateFields: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(body)) {
      updateFields[`preferences.${key}`] = value
    }
    updateFields.updated_at = new Date()

    await users().updateOne({ _id: parseObjectId(userId) }, { $set: updateFields })
  },
}
