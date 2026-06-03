import { authService } from '../services/auth.service'
import { deletionService } from '../services/deletion.service'
import { disconnectUserSockets } from '../services/play-ws.service'
import { rateLimit } from '../middleware/rate-limit'
import type { AuthUser } from '../middleware/auth'
import { HttpError } from '../utils/http-error'

type JwtApi = { sign: (payload: ReturnType<typeof authService.toJwtPayload>) => Promise<string> }

export const authController = {
  register: async ({ body, jwt }: { body: { email: string; username: string; password: string }; jwt: JwtApi }) => {
    const user = await authService.registerWithPassword(body)
    const token = await jwt.sign(authService.toJwtPayload(user))
    return {
      token,
      user: authService.serializeUser(user),
    }
  },

  login: async ({ body, jwt }: { body: { email: string; password: string }; jwt: JwtApi }) => {
    const rl = await rateLimit(body.email, 'auth_attempt')
    if (!rl.allowed) {
      throw new HttpError(429, 'Too many login attempts. Please try again later.')
    }

    const userDoc = await authService.authenticatePassword(body)
    const token = await jwt.sign(authService.toJwtPayload(userDoc))
    return {
      token,
      user: authService.serializeUser(userDoc),
    }
  },

  google: async ({ body, jwt }: { body: { id_token: string }; jwt: JwtApi }) => {
    const userDoc = await authService.signInWithGoogle(body.id_token)
    const token = await jwt.sign(authService.toJwtPayload(userDoc))
    return {
      token,
      user: authService.serializeUser(userDoc),
    }
  },

  sendOtp: async ({ body }: { body: { phone: string } }) => {
    const phone = body.phone.trim()
    const rl = await rateLimit(phone, 'otp_send')
    if (!rl.allowed) {
      throw new HttpError(429, 'Too many OTP requests. Please try again later.')
    }

    await authService.sendPhoneOtp(phone)
    return { success: true, mockCode: '123456' }
  },

  verifyOtp: async ({ body, jwt }: { body: { phone: string; code: string }; jwt: JwtApi }) => {
    const phone = body.phone.trim()
    const code = body.code.trim()

    const rl = await rateLimit(phone, 'otp_verify')
    if (!rl.allowed) {
      throw new HttpError(429, 'Too many OTP verification attempts. Please try again later.')
    }

    const userDoc = await authService.signInWithPhoneOtp(phone, code)
    const token = await jwt.sign(authService.toJwtPayload(userDoc))
    return {
      token,
      user: authService.serializeUser(userDoc),
    }
  },

  me: async ({ user }: { user: AuthUser | null }) => {
    if (!user) throw new HttpError(401, 'Unauthorized')
    const dbUser = await authService.getUserById(user.id)
    return authService.serializeUser(dbUser)
  },

  updatePreferences: async ({
    user,
    body,
  }: {
    user: AuthUser | null
    body: Record<string, unknown>
  }) => {
    if (!user) throw new HttpError(401, 'Unauthorized')
    await authService.updatePreferences(user.id, body)
    return { success: true }
  },

  deleteAccount: async ({ user }: { user: AuthUser | null }) => {
    if (!user) throw new HttpError(401, 'Unauthorized')
    await deletionService.deleteAccount(user.id)
    disconnectUserSockets(user.id)
    return { deleted: true }
  },
}
