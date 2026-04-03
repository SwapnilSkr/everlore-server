import { t } from 'elysia'

export const CreateInstanceBody = t.Object({
  template_id: t.String(),
})

export const InstanceQueryParams = t.Object({
  page: t.Optional(t.Numeric()),
  limit: t.Optional(t.Numeric()),
  include_archived: t.Optional(t.Boolean()),
})
