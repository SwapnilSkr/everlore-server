import * as argon2 from 'argon2'
import { env } from '../config/env'
import { mongoColl } from '../config/mongo'
import type { UserAccountStatus, UserDoc, UserInsertDoc, UserTier } from '../models/user.model'
import { HttpError } from '../utils/http-error'
import { idString, parseObjectId } from '../utils/mongo-id'
import { phoneVerifyError, sendPhoneOtp, verifyPhoneOtp } from '../providers/auth.provider'
import { verifyFirebaseIdToken } from '../providers/firebase-auth.provider'
import { canForge } from '../utils/can-forge'
import { reviewerReason } from './reviewer-accounts'
import { guestService, usernameFromSeed } from './guest.service'

/** Ceiling on stored guide arcs; the app declares roughly a dozen. */
const MAX_GUIDE_FLOWS = 64

/**
 * Every preference key the app writes and the server reads. `updatePreferences`
 * used to store whatever it was handed, which let a client grow the account
 * document without bound; anything outside this list is now refused with a 400.
 * `age_confirmed` is the one key that is consumed rather than stored.
 */
export const PREFERENCE_UPDATE_KEYS = [
  'age_confirmed',
  'nsfw_enabled',
  'group_notifications',
  'player_name',
  'gender',
  'interests',
  'guide_progress',
  'guide_opt_out',
] as const

export function defaultUserPreferences(): UserDoc['preferences'] {
  return {
    nsfw_enabled: false,
    preferred_model: 'gpt-4o',
    theme: 'dark',
    narration_length: 'detailed',
    auto_memory_curation: true,
  }
}

export type JwtUserPayload = {
  id: string
  email: string
  username: string
  tier: string
}

type SignInResult = { userDoc: UserDoc; newAccount: boolean }

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
      guest: user.guest === true,
      ...(user.guest ? { guest_turns: user.guest_turns || 0 } : {}),
      can_forge: !user.guest && canForge(user),
      ...(user.age_confirmed_at ? { age_confirmed_at: user.age_confirmed_at.toISOString() } : {}),
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

    const createdAt = new Date()
    const doc: UserInsertDoc = {
      email,
      username,
      password_hash: passwordHash,
      tier: 'free' as UserTier,
      providers: ['password'],
      preferences: defaultUserPreferences(),
      token_balance: 15000,
      created_at: createdAt,
      signed_up_at: createdAt,
      updated_at: new Date(),
    }

    try {
      const { insertedId } = await users().insertOne(doc)
      return { ...doc, _id: insertedId } as UserDoc
    } catch (error) {
      if (typeof error !== 'object' || error === null || !('code' in error) || error.code !== 11000) throw error
      const existing = await users().findOne({ $or: [{ email }, { username }] })
      if (!existing) throw error
      throw new HttpError(
        409,
        existing.email === email ? 'Email already registered' : 'Username taken',
      )
    }
  },

  async authenticatePassword(input: { email: string; password: string }): Promise<UserDoc> {
    const userDoc = await users().findOne({ email: input.email })
    if (!userDoc) throw new HttpError(401, 'Invalid credentials')

    const valid = await argon2.verify(userDoc.password_hash, input.password)
    if (!valid) throw new HttpError(401, 'Invalid credentials')
    if (userDoc.account_status === 'banned') throw new HttpError(403, 'This account is banned')

    return userDoc
  },

  async signInWithGoogle(idToken: string, guestId?: string): Promise<SignInResult> {
    const profile = await verifyFirebaseIdToken(idToken)
    return this.signInVerifiedIdentity({ email: profile.email, google_sub: profile.googleSubject,
      firebase_uid: profile.firebaseUid }, 'google', profile.email.split('@')[0] || profile.name || 'player', guestId)
  },

  async sendPhoneOtp(phone: string) {
    await sendPhoneOtp(phone)
  },

  async signInWithPhoneOtp(phone: string, code: string, guestId?: string): Promise<SignInResult> {
    const approved = await verifyPhoneOtp(phone, code)
    if (!approved) throw phoneVerifyError('code_invalid')
    return this.signInVerifiedIdentity({ phone }, 'phone', phone, guestId)
  },

  /** Called only after the existing provider has verified the credential. */
  async signInVerifiedIdentity(identity: { email?: string; google_sub?: string; firebase_uid?: string; phone?: string },
    provider: string, seed: string, guestId?: string): Promise<SignInResult> {
    const filter = identity.phone ? { phone: identity.phone } : {
      $or: [{ google_sub: identity.google_sub }, { email: identity.email }],
    }
    let userDoc = await users().findOne(filter)
    let newAccount = false
    if (!userDoc) {
      try {
        const claimed = await guestService.claim(guestId, identity, provider, seed)
        if (claimed) return { userDoc: await this.flagReviewPhone(claimed, identity.phone), newAccount: true }
        // A fenced transfer must finish at its original destination.
        const guest = await guestService.eligible(guestId)
        if (guest?.guest_merge_target) throw new HttpError(409, 'Your story is being saved. Please try again.', { code: 'guest_transfer_pending' })
        const createdAt = new Date()
        const doc: UserInsertDoc = {
          ...identity, username: usernameFromSeed(seed), password_hash: '', tier: 'free', providers: [provider],
          preferences: defaultUserPreferences(), token_balance: 15000, created_at: createdAt, signed_up_at: createdAt, updated_at: createdAt,
        }
        const { insertedId } = await users().insertOne(doc)
        userDoc = { ...doc, _id: insertedId }
        newAccount = true
      } catch (error) {
        if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 11000) throw error
        userDoc = await users().findOne(filter)
        if (!userDoc) throw error
      }
    }
    if (userDoc.account_status === 'banned') throw new HttpError(403, 'This account is banned')
    if (!newAccount) {
      const providers = [...new Set([...(userDoc.providers || []), provider])]
      await users().updateOne({ _id: userDoc._id }, { $set: { ...identity, providers, updated_at: new Date() } })
      userDoc = { ...userDoc, ...identity, providers }
    }
    const guest = await guestService.eligible(guestId)
    userDoc = await guestService.merge(guestId, userDoc)
    // The reviewer's own phone number is a review account, new or existing. It
    // keeps every feature; the console just stops counting it as a player.
    userDoc = await this.flagReviewPhone(userDoc, identity.phone)
    return { userDoc, newAccount: newAccount || !!guest }
  },

  /** Sticky: the flag is only ever added, and the first `reviewer_at` is kept. */
  async flagReviewPhone(user: UserDoc, phone?: string): Promise<UserDoc> {
    if (!phone || reviewerReason({ phone }, env.REVIEW_DEMO_PHONE) !== 'review_phone') return user
    if (user.reviewer === true) return user
    const reviewer_at = new Date()
    await users().updateOne(
      { _id: user._id, reviewer: { $ne: true } },
      { $set: { reviewer: true, reviewer_reason: 'review_phone', reviewer_at } },
    )
    return { ...user, reviewer: true, reviewer_reason: 'review_phone', reviewer_at }
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

  async getLiveAccess(userId: string): Promise<{ guest?: boolean; tier: UserTier; account_status: UserAccountStatus; admin_tier_override?: UserTier | null } | null> {
    const row = await users().findOne(
      { _id: parseObjectId(userId) },
      { projection: { tier: 1, account_status: 1, admin_tier_override: 1, guest_merge_target: 1, guest_purging: 1, guest: 1 } },
    )
    if (!row || row.guest_merge_target || row.guest_purging) return null
    return {
      guest: row.guest === true,
      tier: row.admin_tier_override || (row.tier as UserTier | undefined) || 'free',
      account_status: row.account_status === 'banned' ? 'banned' : 'active',
      admin_tier_override: row.admin_tier_override ?? null,
    }
  },

  async updatePreferences(userId: string, body: Record<string, unknown>) {
    const unknown = Object.keys(body).filter(key => !(PREFERENCE_UPDATE_KEYS as readonly string[]).includes(key))
    if (unknown.length) throw new HttpError(400, 'That setting could not be changed.')
    const user = await this.getUserById(userId)
    if (body.nsfw_enabled === true && !user.age_confirmed_at && body.age_confirmed !== true) {
      throw new HttpError(400, "Please confirm you're 18 or older to allow mature themes.", { code: 'age_confirmation_required' })
    }
    if (body.age_confirmed === true) {
      // The conditional write keeps the first confirmation, even across requests.
      await users().updateOne({ _id: user._id, age_confirmed_at: { $exists: false } },
        { $set: { age_confirmed_at: new Date() } })
    }
    const updateFields: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(body)) {
      if (key === 'age_confirmed') continue
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

    // A reviewer types the number from the review instructions into the name
    // field. The same write stamps the account, so no window exists where the
    // name is stored and the account is still counted as a player. Never
    // overwritten once set: the first reason and date are kept.
    if (typeof body.player_name === 'string' && reviewerReason({ player_name: body.player_name }) === 'number_name'
      && user.reviewer !== true) {
      updateFields.reviewer = true
      updateFields.reviewer_reason = 'number_name'
      updateFields.reviewer_at = new Date()
    }

    await users().updateOne({ _id: parseObjectId(userId) }, { $set: updateFields })
  },
}
