import { Elysia, t } from 'elysia'
import { authPlugin } from '../middleware/auth'
import { personaController } from '../controllers/persona.controller'
import { PERSONA_LIMITS } from '../services/persona.service'

const PersonaBody = t.Object({
  name: t.String({ minLength: 1, maxLength: PERSONA_LIMITS.name }),
  gender: t.Union([t.Literal('male'), t.Literal('female'), t.Literal('non_binary')]),
  age: t.Optional(t.Nullable(t.Integer({ minimum: PERSONA_LIMITS.minAge, maximum: PERSONA_LIMITS.maxAge }))),
  description: t.Optional(t.String({ maxLength: PERSONA_LIMITS.description })),
  other_info: t.Optional(t.String({ maxLength: PERSONA_LIMITS.otherInfo })),
})

const PersonaPatchBody = t.Object({
  name: t.Optional(t.String({ minLength: 1, maxLength: PERSONA_LIMITS.name })),
  gender: t.Optional(t.Union([t.Literal('male'), t.Literal('female'), t.Literal('non_binary')])),
  age: t.Optional(t.Nullable(t.Integer({ minimum: PERSONA_LIMITS.minAge, maximum: PERSONA_LIMITS.maxAge }))),
  description: t.Optional(t.String({ maxLength: PERSONA_LIMITS.description })),
  other_info: t.Optional(t.String({ maxLength: PERSONA_LIMITS.otherInfo })),
})

const PersonaQuery = t.Object({
  page: t.Optional(t.Numeric({ minimum: 1 })),
  limit: t.Optional(t.Numeric({ minimum: 1, maximum: 50 })),
  search: t.Optional(t.String({ maxLength: 100 })),
})

export const personaRoutes = new Elysia({ prefix: '/personas' })
  .use(authPlugin)
  .get('/', (ctx) => personaController.list(ctx), { query: PersonaQuery })
  .post('/', (ctx) => personaController.create(ctx), { body: PersonaBody })
  .patch('/:id', (ctx) => personaController.update(ctx), { body: PersonaPatchBody })
  .delete('/:id', (ctx) => personaController.delete(ctx))
