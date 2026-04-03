import { Elysia } from 'elysia'
import * as argon2 from 'argon2'
import { coll } from '../config/mongo'
import { generateId } from '../utils/id'
import { RegisterBody, LoginBody, GoogleAuthBody, UpdatePreferencesBody } from '../schemas/user.schema'
import { authPlugin } from '../middleware/auth'
import { rateLimit } from '../middleware/rate-limit'

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

    await coll('users').insertOne(user)

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
    const { email, password } = body

    const rl = await rateLimit(email, 'auth_attempt')
    if (!rl.allowed) {
      throw new Error('Too many login attempts. Please try again later.')
    }

    const userDoc = await coll('users').findOne({ email })
    if (!userDoc) throw new Error('Invalid credentials')

    const valid = await argon2.verify(userDoc.password_hash, password)
    if (!valid) throw new Error('Invalid credentials')

    const token = await jwt.sign({
      id: userDoc._id,
      email: userDoc.email,
      username: userDoc.username,
      tier: userDoc.tier,
    })

    return {
      token,
      user: {
        id: userDoc._id,
        email: userDoc.email,
        username: userDoc.username,
        tier: userDoc.tier,
        preferences: userDoc.preferences,
      },
    }
  }, { body: LoginBody })

  .post('/google', async ({ body, jwt }) => {
    const { id_token } = body

    const parts = id_token.split('.')
    if (parts.length !== 3) throw new Error('Invalid token')
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString()) as {
      email?: string
    }

    if (!payload.email) throw new Error('No email in token')

    let userDoc = await coll('users').findOne({ email: payload.email })

    if (!userDoc) {
      const id = generateId('usr')
      const newUser = {
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
      await coll('users').insertOne(newUser)
      userDoc = newUser
    }

    const token = await jwt.sign({
      id: userDoc._id,
      email: userDoc.email,
      username: userDoc.username,
      tier: userDoc.tier,
    })

    return {
      token,
      user: {
        id: userDoc._id,
        email: userDoc.email,
        username: userDoc.username,
        tier: userDoc.tier,
        preferences: userDoc.preferences,
      },
    }
  }, { body: GoogleAuthBody })

  .get('/me', async ({ user }) => {
    if (!user) throw new Error('Unauthorized')
    const dbUser = await coll('users').findOne({ _id: user.id })
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

    const updateFields: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(body)) {
      updateFields[`preferences.${key}`] = value
    }
    updateFields.updated_at = new Date()

    await coll('users').updateOne({ _id: user.id }, { $set: updateFields })
    return { success: true }
  }, { body: UpdatePreferencesBody })
