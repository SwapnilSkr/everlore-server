import { Elysia } from 'elysia'
import * as argon2 from 'argon2'
import { coll } from '../config/mongo'
import { generateId } from '../utils/id'
import {
  RegisterBody,
  LoginBody,
  GoogleAuthBody,
  SendOtpBody,
  VerifyOtpBody,
  UpdatePreferencesBody,
} from '../schemas/user.schema'
import { authPlugin } from '../middleware/auth'
import { rateLimit } from '../middleware/rate-limit'
import {
  sendPhoneOtp,
  verifyGoogleIdToken,
  verifyPhoneOtp,
} from '../services/auth-provider.service'

function defaultPreferences() {
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

function signAppToken(
  jwt: { sign: (payload: any) => Promise<string> },
  user: { _id: string; email?: string; username: string; tier: string },
) {
  return jwt.sign({
    id: user._id,
    email: user.email || '',
    username: user.username,
    tier: user.tier,
  })
}

function serializeUser(user: any) {
  return {
    id: user._id,
    email: user.email || '',
    phone: user.phone || null,
    username: user.username,
    tier: user.tier,
    preferences: user.preferences,
    token_balance: user.token_balance,
  }
}

export const authRoutes = new Elysia({ prefix: '/auth' })
  .use(authPlugin)

  .post('/register', async ({ body, jwt }) => {
    const { email, username, password } = body

    const existing = await coll('users').findOne({
      $or: [{ email }, { username }],
    })
    if (existing) {
      throw new Error(existing.email === email ? 'Email already registered' : 'Username taken')
    }

    const passwordHash = await argon2.hash(password)
    const id = generateId('usr')

    const user = {
      _id: id,
      email,
      username,
      password_hash: passwordHash,
      tier: 'free',
      providers: ['password'],
      preferences: defaultPreferences(),
      token_balance: 15000,
      created_at: new Date(),
      updated_at: new Date(),
    }

    await coll('users').insertOne(user)

    const token = await signAppToken(jwt, user)

    return {
      token,
      user: serializeUser(user),
    }
  }, { body: RegisterBody })

  .post('/login', async ({ body, jwt }) => {
    const { email, password } = body

    const rl = await rateLimit(email, 'auth_attempt')
    if (!rl.allowed) {
      throw new Error('Too many login attempts. Please try again later.')
    }

    const userDoc = await coll('users').findOne({ email })
    if (!userDoc) throw new Error('Invalid credentials')

    const valid = await argon2.verify(userDoc.password_hash, password)
    if (!valid) throw new Error('Invalid credentials')

    const token = await signAppToken(jwt, userDoc as any)

    return {
      token,
      user: serializeUser(userDoc),
    }
  }, { body: LoginBody })

  .post('/google', async ({ body, jwt }) => {
    const { id_token } = body
    const profile = await verifyGoogleIdToken(id_token)

    let userDoc = await coll('users').findOne({
      $or: [{ google_sub: profile.subject }, { email: profile.email }],
    })

    if (!userDoc) {
      const id = generateId('usr')
      const newUser = {
        _id: id,
        email: profile.email,
        google_sub: profile.subject,
        username: usernameFromSeed(profile.email.split('@')[0] || profile.name || 'player'),
        password_hash: '',
        tier: 'free',
        providers: ['google'],
        preferences: defaultPreferences(),
        token_balance: 15000,
        created_at: new Date(),
        updated_at: new Date(),
      }
      await coll('users').insertOne(newUser)
      userDoc = newUser
    } else {
      const providers = Array.isArray((userDoc as any).providers)
        ? new Set<string>((userDoc as any).providers)
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

    const token = await signAppToken(jwt, userDoc as any)

    return {
      token,
      user: serializeUser(userDoc),
    }
  }, { body: GoogleAuthBody })

  .post('/otp/send', async ({ body }) => {
    const phone = body.phone.trim()
    const rl = await rateLimit(phone, 'otp_send')
    if (!rl.allowed) {
      throw new Error('Too many OTP requests. Please try again later.')
    }

    await sendPhoneOtp(phone)
    return { success: true, mockCode: '123456' }
  }, { body: SendOtpBody })

  .post('/otp/verify', async ({ body, jwt }) => {
    const phone = body.phone.trim()
    const code = body.code.trim()

    const rl = await rateLimit(phone, 'otp_verify')
    if (!rl.allowed) {
      throw new Error('Too many OTP verification attempts. Please try again later.')
    }

    const approved = await verifyPhoneOtp(phone, code)
    if (!approved) throw new Error('Invalid verification code')

    let userDoc = await coll('users').findOne({ phone })

    if (!userDoc) {
      const id = generateId('usr')
      const newUser = {
        _id: id,
        phone,
        username: usernameFromSeed(phone),
        password_hash: '',
        tier: 'free',
        providers: ['phone'],
        preferences: defaultPreferences(),
        token_balance: 15000,
        created_at: new Date(),
        updated_at: new Date(),
      }
      await coll('users').insertOne(newUser)
      userDoc = newUser
    } else {
      const providers = Array.isArray((userDoc as any).providers)
        ? new Set<string>((userDoc as any).providers)
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

    const token = await signAppToken(jwt, userDoc as any)

    return {
      token,
      user: serializeUser(userDoc),
    }
  }, { body: VerifyOtpBody })

  .get('/me', async ({ user }) => {
    if (!user) throw new Error('Unauthorized')
    const dbUser = await coll('users').findOne({ _id: user.id })
    if (!dbUser) throw new Error('User not found')

    return serializeUser(dbUser)
  })

  .put('/preferences', async ({ user, body }) => {
    if (!user) throw new Error('Unauthorized')

    const updateFields: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(body)) {
      updateFields[`preferences.${key}`] = value
    }
    updateFields.updated_at = new Date()

    await coll('users').updateOne({ _id: user.id }, { $set: updateFields })
    return { success: true }
  }, { body: UpdatePreferencesBody })
