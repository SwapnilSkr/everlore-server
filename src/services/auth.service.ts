import * as argon2 from 'argon2'
import { mongoColl } from '../config/mongo'
import type { UserAccountStatus, UserDoc, UserInsertDoc, UserTier } from '../models/user.model'
import { HttpError } from '../utils/http-error'
import { idString, parseObjectId } from '../utils/mongo-id'
import { sendPhoneOtp, verifyPhoneOtp } from '../providers/auth.provider'
import { verifyFirebaseIdToken } from '../providers/firebase-auth.provider'

/** Ceiling on stored guide arcs; the app declares roughly a dozen. */
const MAX_GUIDE_FLOWS = 64

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
    if (userDoc.account_status === 'banned') throw new HttpError(403, 'This account is banned')

    return userDoc
  },

  async signInWithGoogle(idToken: string): Promise<UserDoc> {
    // A Firebase ID token now, not a raw Google one. `googleSubject` is the
    // original Google `sub` lifted out of the Firebase token, so the lookup
    // below is unchanged and every account that existed before the migration
    // still matches on its first sign-in afterwards.
    const profile = await verifyFirebaseIdToken(idToken)

    let userDoc: UserDoc | null = await users().findOne({
      $or: [{ google_sub: profile.googleSubject }, { email: profile.email }],
    })

    if (!userDoc) {
      const doc: UserInsertDoc = {
        email: profile.email,
        google_sub: profile.googleSubject,
        firebase_uid: profile.firebaseUid,
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
      if (userDoc.account_status === 'banned') throw new HttpError(403, 'This account is banned')
      const prov = Array.isArray(userDoc.providers)
        ? new Set<string>(userDoc.providers)
        : new Set<string>()
      prov.add('google')

      await users().updateOne(
        { _id: userDoc._id },
        {
          $set: {
            email: profile.email,
            google_sub: profile.googleSubject,
            firebase_uid: profile.firebaseUid,
            providers: [...prov],
            updated_at: new Date(),
          },
        },
      )

      userDoc = {
        ...userDoc,
        email: profile.email,
        google_sub: profile.googleSubject,
        firebase_uid: profile.firebaseUid,
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
      if (userDoc.account_status === 'banned') throw new HttpError(403, 'This account is banned')
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

  /** JWT tier can lag after admin upgrades — read the live value from Mongo. */
  async getLiveTier(userId: string): Promise<UserTier> {
    const row = await this.getLiveAccess(userId)
    return row?.tier ?? 'free'
  },

  async getLiveAccess(userId: string): Promise<{ tier: UserTier; account_status: UserAccountStatus; admin_tier_override?: UserTier | null } | null> {
    const row = await users().findOne(
      { _id: parseObjectId(userId) },
      { projection: { tier: 1, account_status: 1, admin_tier_override: 1 } },
    )
    if (!row) return null
    return {
      tier: row.admin_tier_override || (row.tier as UserTier | undefined) || 'free',
      account_status: row.account_status === 'banned' ? 'banned' : 'active',
      admin_tier_override: row.admin_tier_override ?? null,
    }
  },

  async updatePreferences(userId: string, body: Record<string, unknown>) {
    const updateFields: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(body)) {
      // guide_progress is a client-authored map with free-form keys, so it is
      // the one field here that could grow without bound. Keep it to a sane
      // ceiling — the app declares roughly a dozen arcs.
      if (key === 'guide_progress' && value && typeof value === 'object') {
        const entries = Object.entries(value as Record<string, unknown>)
          .filter(([flowId]) => flowId.length <= 64)
          .slice(0, MAX_GUIDE_FLOWS)
        updateFields[`preferences.${key}`] = Object.fromEntries(entries)
        continue
      }
      updateFields[`preferences.${key}`] = value
    }
    updateFields.updated_at = new Date()

    await users().updateOne({ _id: parseObjectId(userId) }, { $set: updateFields })
  },
}
