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
})
