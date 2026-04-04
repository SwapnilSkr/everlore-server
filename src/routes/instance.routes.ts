import { Elysia } from 'elysia'
import { authPlugin } from '../middleware/auth'
import { CreateInstanceBody, InstanceQueryParams } from '../schemas/instance.schema'
import { instanceController } from '../controllers/instance.controller'

export const instanceRoutes = new Elysia({ prefix: '/instances' })
  .use(authPlugin)

  .get('/', (ctx) => instanceController.list(ctx), { query: InstanceQueryParams })

  .get('/:id', (ctx) => instanceController.getById(ctx))

  .post('/', (ctx) => instanceController.create(ctx), { body: CreateInstanceBody })

  .post('/:id/archive', (ctx) => instanceController.archive(ctx))
