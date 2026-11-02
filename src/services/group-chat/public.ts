/** Only plain documents are copied; dates and database ids keep their encoding. */
export function publicGroupData<T>(value: T): T {
  if (Array.isArray(value)) return value.map(publicGroupData) as T
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) return value
  return Object.fromEntries(Object.entries(value).filter(([key]) =>
    !['interested', 'intimacy', 'voice', 'wants', 'talkativeness', 'topics', 'group_state', 'group_state_after', 'group_context', 'group_template_id', 'cost', 'cost_usd', 'tame'].includes(key),
  ).map(([key, entry]) => [key, publicGroupData(entry)])) as T
}
