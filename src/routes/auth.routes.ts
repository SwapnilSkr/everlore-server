import { guestClientAddress } from '../utils/guest-client-address'
import { Elysia } from 'elysia'
import {
  RegisterBody,
  GuestAuthBody,
  LoginBody,
  GoogleAuthBody,
  SendOtpBody,
  VerifyOtpBody,
  UpdatePreferencesBody,
} from '../schemas/user.schema'
import { authPlugin } from '../middleware/auth'
import { authController } from '../controllers/auth.controller'

export const authRoutes = new Elysia({ prefix: '/auth' })
  .use(authPlugin)

  .post('/guest', (ctx) => authController.guest({ ...ctx,
    address: guestClientAddress(ctx.server?.requestIP(ctx.request)?.address, ctx.headers['x-forwarded-for']),
    sessionUserId: ctx.user?.id,
    sessionToken: ctx.headers.authorization?.startsWith('Bearer ') ? ctx.headers.authorization.slice(7) : undefined,
  }), { body: GuestAuthBody })

  .post('/register', (ctx) => authController.register(ctx), { body: RegisterBody })

  .post('/login', (ctx) => authController.login(ctx), { body: LoginBody })

  .post('/google', (ctx) => authController.google(ctx), { body: GoogleAuthBody })

  .post('/otp/send', (ctx) => authController.sendOtp(ctx), { body: SendOtpBody })

  .post('/otp/verify', (ctx) => authController.verifyOtp(ctx), { body: VerifyOtpBody })

  .get('/me', (ctx) => authController.me(ctx))

  .put('/preferences', (ctx) => authController.updatePreferences(ctx), {
    body: UpdatePreferencesBody,
  })

  .delete('/account', (ctx) => authController.deleteAccount(ctx))
