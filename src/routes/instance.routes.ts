import { Elysia } from 'elysia'
import { authPlugin } from '../middleware/auth'
import { instanceService } from '../services/instance.service'
import { CreateInstanceBody, InstanceQueryParams } from '../schemas/instance.schema'

export const instanceRoutes = new Elysia({ prefix: '/instances' })
  .use(authPlugin)

  // List my instances
  .get('/', async ({ user, query }) => {
    if (!user) throw new Error('Unauthorized')
    return instanceService.list(user.id, query.include_archived === true)
  }, { query: InstanceQueryParams })

  // Get instance by ID
  .get('/:id', async ({ user, params }) => {
    if (!user) throw new Error('Unauthorized')
    const instance = await instanceService.getById(params.id, user.id)
    if (!instance) throw new Error('Instance not found')
    return instance
  })

  // Create instance from template
  .post('/', async ({ user, body }) => {
    if (!user) throw new Error('Unauthorized')
    return instanceService.create(user.id, body.template_id, user.tier)
  }, { body: CreateInstanceBody })

  // Archive instance
  .post('/:id/archive', async ({ user, params }) => {
    if (!user) throw new Error('Unauthorized')
    return instanceService.archive(params.id, user.id)
  })
