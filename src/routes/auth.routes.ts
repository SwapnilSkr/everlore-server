import { Elysia } from 'elysia'
import { jwt } from '@elysiajs/jwt'
import * as argon2 from 'argon2'
import { getDb } from '../config/mongo'
import { env } from '../config/env'
import { generateId } from '../utils/id'
import { RegisterBody, LoginBody, GoogleAuthBody, UpdatePreferencesBody } from '../schemas/user.schema'
import { authPlugin, requireAuth } from '../middleware/auth'
import { rateLimit } from '../middleware/rate-limit'

export const authRoutes = new Elysia({ prefix: '/auth' })
  .use(jwt({ name: 'jwt', secret: env.JWT_SECRET }))

  .post('/register', async ({ body, jwt }) => {
    const db = getDb()
    const { email, username, password } = body

    // Check existing
    const existing = await db.collection('users').findOne({
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
      preferences: {
        nsfw_enabled: false,
        preferred_model: 'gpt-4o',
        theme: 'dark',
        narration_length: 'detailed',
        auto_memory_curation: true,
      },
      token_balance: 15000,
      created_at: new Date(),
      updated_at: new Date(),
    }

    await db.collection('users').insertOne(user)

    const token = await jwt.sign({
      id: user._id,
      email: user.email,
      username: user.username,
      tier: user.tier,
    })

    return {
      token,
      user: { id: user._id, email, username, tier: user.tier, preferences: user.preferences },
    }
  }, { body: RegisterBody })

  .post('/login', async ({ body, jwt }) => {
    const db = getDb()
    const { email, password } = body

    await rateLimit(email, 'auth_attempt', 10, 300)

    const user = await db.collection('users').findOne({ email })
    if (!user) throw new Error('Invalid credentials')

    const valid = await argon2.verify(user.password_hash, password)
    if (!valid) throw new Error('Invalid credentials')

    const token = await jwt.sign({
      id: user._id,
      email: user.email,
      username: user.username,
      tier: user.tier,
    })

    return {
      token,
      user: {
        id: user._id,
        email: user.email,
        username: user.username,
        tier: user.tier,
        preferences: user.preferences,
      },
    }
  }, { body: LoginBody })

  .post('/google', async ({ body, jwt }) => {
    const db = getDb()
    const { id_token } = body

    // Verify Google ID token (simplified — in production, use google-auth-library)
    // For now, decode the JWT payload (the real implementation should verify signature)
    const parts = id_token.split('.')
    if (parts.length !== 3) throw new Error('Invalid token')
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString())

    if (!payload.email) throw new Error('No email in token')

    let user = await db.collection('users').findOne({ email: payload.email })

    if (!user) {
      const id = generateId('usr')
      user = {
        _id: id,
        email: payload.email,
        username: payload.email.split('@')[0] + '_' + Date.now().toString(36),
        password_hash: '',
        tier: 'free',
        preferences: {
          nsfw_enabled: false,
          preferred_model: 'gpt-4o',
          theme: 'dark',
          narration_length: 'detailed',
          auto_memory_curation: true,
        },
        token_balance: 15000,
        created_at: new Date(),
        updated_at: new Date(),
      }
      await db.collection('users').insertOne(user)
    }

    const token = await jwt.sign({
      id: user._id,
      email: user.email,
      username: user.username,
      tier: user.tier,
    })

    return {
      token,
      user: {
        id: user._id,
        email: user.email,
        username: user.username,
        tier: user.tier,
        preferences: user.preferences,
      },
    }
  }, { body: GoogleAuthBody })

  .use(authPlugin)

  .get('/me', async ({ user }) => {
    if (!user) throw new Error('Unauthorized')
    const db = getDb()
    const dbUser = await db.collection('users').findOne({ _id: user.id })
    if (!dbUser) throw new Error('User not found')

    return {
      id: dbUser._id,
      email: dbUser.email,
      username: dbUser.username,
      tier: dbUser.tier,
      preferences: dbUser.preferences,
      token_balance: dbUser.token_balance,
    }
  })

  .put('/preferences', async ({ user, body }) => {
    if (!user) throw new Error('Unauthorized')
    const db = getDb()

    const updateFields: any = {}
    for (const [key, value] of Object.entries(body)) {
      updateFields[`preferences.${key}`] = value
    }
    updateFields.updated_at = new Date()

    await db.collection('users').updateOne({ _id: user.id }, { $set: updateFields })
    return { success: true }
  }, { body: UpdatePreferencesBody })
