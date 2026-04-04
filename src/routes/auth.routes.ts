import { Elysia } from 'elysia'
import {
  RegisterBody,
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

  .post('/register', (ctx) => authController.register(ctx), { body: RegisterBody })

  .post('/login', (ctx) => authController.login(ctx), { body: LoginBody })

  .post('/google', (ctx) => authController.google(ctx), { body: GoogleAuthBody })

  .post('/otp/send', (ctx) => authController.sendOtp(ctx), { body: SendOtpBody })

  .post('/otp/verify', (ctx) => authController.verifyOtp(ctx), { body: VerifyOtpBody })

  .get('/me', (ctx) => authController.me(ctx))

  .put('/preferences', (ctx) => authController.updatePreferences(ctx), {
    body: UpdatePreferencesBody,
  })
