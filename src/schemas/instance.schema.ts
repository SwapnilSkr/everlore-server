import { t } from 'elysia'

export const CreateInstanceBody = t.Object({
  template_id: t.String(),
  persona_id: t.Optional(t.String()),
})

export const InstanceQueryParams = t.Object({
  page: t.Optional(t.Numeric()),
  limit: t.Optional(t.Numeric()),
  include_archived: t.Optional(t.Boolean()),
  search: t.Optional(t.String({ maxLength: 100 })),
})
