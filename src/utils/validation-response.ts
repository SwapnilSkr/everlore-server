import { ValueErrorType } from '@sinclair/typebox/errors'

export const VALIDATION_MESSAGE = "Some of the details sent weren't valid. Please check them and try again."

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : {}
}

/** Keep every failed constraint, but never copy values or value-bearing summaries. */
export function validationResponse(error: unknown) {
  const source = record(error)
  let report = source
  let issues: unknown = source.all
  if (!Array.isArray(issues)) {
    // The VALIDATION code path can receive a serialized framework error.
    if (typeof source.message === 'string') {
      try { report = record(JSON.parse(source.message)) } catch { /* No structured details. */ }
    }
    issues = report.errors
  }
  const errors = (Array.isArray(issues) ? issues : [report]).map((issue: unknown) => {
    const detail = record(issue)
    const path = typeof detail.path === 'string' ? detail.path
      : typeof detail.property === 'string' ? detail.property : ''
    const type = typeof detail.type === 'number' ? detail.type : undefined
    return { path, summary: type === undefined ? 'Validation constraint failed' : ValueErrorType[type] ?? 'Validation constraint failed', type }
  })
  return {
    response: { error: VALIDATION_MESSAGE },
    details: {
      on: typeof source.type === 'string' && source.type !== 'validation' ? source.type
        : typeof report.on === 'string' ? report.on : 'unknown',
      properties: [...new Set(errors.map(({ path }) => path))],
      errors,
    },
  }
}
