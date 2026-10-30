import { idString } from '../utils/mongo-id'
import { guestService } from '../services/guest.service'
import { authService } from '../services/auth.service'
import { deletionService } from '../services/deletion.service'
import { disconnectUserSockets } from '../services/play-ws.service'
import { rateLimit } from '../middleware/rate-limit'
import type { AuthUser } from '../middleware/auth'
import { HttpError } from '../utils/http-error'
import { mockOtpCode, phoneVerifyError } from '../providers/auth.provider'

type JwtApi = { sign: (payload: ReturnType<typeof authService.toJwtPayload>) => Promise<string>; verify?: (token: string) => Promise<unknown> }

async function guestId(token: string | undefined, jwt: JwtApi): Promise<string | undefined> {
  if (!token || !jwt.verify) return undefined
  try {
    const payload = await jwt.verify(token)
    return payload && typeof payload === 'object' && 'id' in payload && typeof payload.id === 'string' ? payload.id : undefined
  } catch { return undefined }
}

export const authController = {
  guest: async ({ body, jwt, address, sessionUserId, sessionToken }: { body: { install_id: string }; jwt: JwtApi; address: string; sessionUserId?: string; sessionToken?: string }) => {
    const byIp = await rateLimit(address, 'guest_ip')
    const byInstall = await rateLimit(body.install_id, 'guest_install')
    if (!byIp.allowed || !byInstall.allowed) throw new HttpError(429, 'Please wait before beginning another story.')
    const userDoc = await guestService.create(body.install_id, sessionUserId)
    const token = sessionToken && sessionUserId === idString(userDoc._id) ? sessionToken : await jwt.sign(authService.toJwtPayload(userDoc))
    return { token, user: authService.serializeUser(userDoc) }
  },
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

  google: async ({ body, jwt }: { body: { id_token: string; guest_token?: string }; jwt: JwtApi }) => {
    const { userDoc, newAccount } = await authService.signInWithGoogle(body.id_token, await guestId(body.guest_token, jwt))
    const token = await jwt.sign(authService.toJwtPayload(userDoc))
    return {
      token,
      user: authService.serializeUser(userDoc),
      ...(newAccount ? { new_account: true } : {}),
    }
  },

  sendOtp: async ({ body }: { body: { phone: string } }) => {
    const phone = body.phone.trim()
    const rl = await rateLimit(phone, 'otp_send')
    if (!rl.allowed) {
      throw phoneVerifyError('send_limited', rl.retryAfter)
    }

    await authService.sendPhoneOtp(phone)
    const mockCode = mockOtpCode(phone)
    return mockCode ? { success: true, mockCode } : { success: true }
  },

  verifyOtp: async ({ body, jwt }: { body: { phone: string; code: string; guest_token?: string }; jwt: JwtApi }) => {
    const phone = body.phone.trim()
    const code = body.code.trim()

    const rl = await rateLimit(phone, 'otp_verify')
    if (!rl.allowed) {
      throw phoneVerifyError('verify_limited', rl.retryAfter)
    }

    const { userDoc, newAccount } = await authService.signInWithPhoneOtp(phone, code, await guestId(body.guest_token, jwt))
    const token = await jwt.sign(authService.toJwtPayload(userDoc))
    return {
      token,
      user: authService.serializeUser(userDoc),
      ...(newAccount ? { new_account: true } : {}),
    }
  },

  me: async ({ user }: { user: AuthUser | null }) => {
    if (!user) throw new HttpError(401, 'Sign in to continue.')
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
    if (!user) throw new HttpError(401, 'Sign in to continue.')
    await authService.updatePreferences(user.id, body)
    return { success: true }
  },

  deleteAccount: async ({ user }: { user: AuthUser | null }) => {
    if (!user) throw new HttpError(401, 'Sign in to continue.')
    await deletionService.deleteAccount(user.id)
    disconnectUserSockets(user.id)
    return { deleted: true }
  },
}
