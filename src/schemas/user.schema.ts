import { t } from 'elysia'

export const RegisterBody = t.Object({
  email: t.String({ format: 'email' }),
  username: t.String({ minLength: 3, maxLength: 30, pattern: '^[a-zA-Z0-9_]+$' }),
  password: t.String({ minLength: 8, maxLength: 128 }),
})

export const LoginBody = t.Object({
  email: t.String({ format: 'email' }),
  password: t.String({ minLength: 1 }),
})

export const GoogleAuthBody = t.Object({
  id_token: t.String(),
})

export const SendOtpBody = t.Object({
  phone: t.String({ pattern: '^\\+[1-9]\\d{7,14}$' }),
})

export const VerifyOtpBody = t.Object({
  phone: t.String({ pattern: '^\\+[1-9]\\d{7,14}$' }),
  code: t.String({ minLength: 4, maxLength: 10 }),
})

/** One arc's progress record — see `GuideFlowProgress` in user.model.ts. */
const GuideFlowProgressBody = t.Object({
  version: t.Integer({ minimum: 1, maximum: 10_000 }),
  step: t.Integer({ minimum: 0, maximum: 1_000 }),
  status: t.Union([t.Literal('seen'), t.Literal('skipped'), t.Literal('done')]),
  at: t.String({ maxLength: 40 }),
})

export const UpdatePreferencesBody = t.Object({
  nsfw_enabled: t.Optional(t.Boolean()),
  preferred_model: t.Optional(t.String()),
  theme: t.Optional(t.String()),
  narration_length: t.Optional(t.Union([
    t.Literal('concise'),
    t.Literal('detailed'),
    t.Literal('verbose'),
  ])),
  auto_memory_curation: t.Optional(t.Boolean()),
  player_name: t.Optional(t.String({ minLength: 2, maxLength: 40 })),
  gender: t.Optional(t.Union([
    t.Literal('male'),
    t.Literal('female'),
    t.Literal('non_binary'),
  ])),
  interests: t.Optional(t.Array(t.String())),
  guide_progress: t.Optional(t.Record(t.String(), GuideFlowProgressBody)),
  guide_opt_out: t.Optional(t.Boolean()),
})

/** Body for admin tier updates. Guarded by env-backed admin auth. */
export const AdminSetTierBody = t.Object({
  tier: t.Union([
    t.Literal('free'),
    t.Literal('premium'),
    t.Literal('creator'),
    t.Literal('inherit'),
  ]),
})

export const AdminSetUserStatusBody = t.Object({
  status: t.Union([t.Literal('active'), t.Literal('banned')]),
  reason: t.Optional(t.String({ maxLength: 240 })),
})

export const AdminUserListQuery = t.Object({
  limit: t.Optional(t.Numeric({ minimum: 1, maximum: 200 })),
})
