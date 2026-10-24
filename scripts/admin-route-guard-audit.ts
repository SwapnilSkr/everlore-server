/**
 * Every admin route must reject a caller who is not signed in.
 *
 * Pure: run with `bun --no-env-file run`. It touches no Mongo and no Redis, and
 * every collection is stubbed to throw, so a request that ever reaches a handler
 * fails loudly instead of passing quietly.
 *
 * Two states are checked for every route in the table:
 *   (a) credentials unset  -> 503 `Admin credentials are not configured`;
 *   (b) credentials set, a session cookie sent WITHOUT the `x-everlore-admin`
 *       header -> 403. This is the state that catches an ungated route, because
 *       (a) is answered before the router is ever consulted about the caller.
 *
 * The 401 path is deliberately not exercised: it charges the failure budget in
 * Redis, and this audit must not need Redis at all.
 */
import { Elysia } from 'elysia'
import { env } from '../src/config/env'
import { mongoColl } from '../src/config/mongo'
import { SESSION_COOKIE } from '../src/services/admin-session.service'
import { adminRoutes } from '../src/routes/admin.routes'
import { adminPersonaRoutes } from '../src/routes/admin-persona.routes'

/** Any 24-hex id satisfies every `:param` in the admin table. */
const PLACEHOLDER_ID = '6a1b2c3d4e5f60718293a4b5'
const UNCONFIGURED_ERROR = 'Admin credentials are not configured'
const MISSING_HEADER_ERROR = 'Missing admin request header'
const DUMMY_USERNAME = 'admin-route-guard-audit'
const DUMMY_PASSWORD = 'admin-route-guard-audit'

/**
 * A body that passes the route's schema.
 *
 * Validation runs BEFORE the auth hook, so a route with required body fields
 * answers 422 to `{}` and the gate is never reached — which would prove nothing.
 * Such a route is resent with the body below; a route with a required body and no
 * entry here fails the audit instead of being waved through.
 */
const ROUTE_BODIES: Record<string, Record<string, unknown>> = {
  'PATCH /admin/users/:userId/tier': { tier: 'free' },
  'PATCH /admin/users/:userId/status': { status: 'active' },
  'POST /admin/users/:userId/ink-grants': { amount: 1, idempotency_key: 'admin-route-guard-audit' },
  'PATCH /admin/reports/:reportId': { action: 'none' },
  'PATCH /admin/worlds/:worldId/moderation': { moderation_status: 'active' },
  'POST /admin/worlds/:worldId/request-changes': { note: 'admin route guard audit' },
}

type TableRoute = { method: string; path: string; url: string }

const originalEnv = { ...env }
const originalCollections = { ...mongoColl }
let checks = 0
const failures: string[] = []

function pass(label: string) {
  checks++
  console.log(`PASS ${label}`)
}

function fail(label: string, detail: string) {
  checks++
  failures.push(label)
  console.error(`FAIL ${label}: ${detail}`)
}

/** `/admin/personas/` and `/admin/personas` are the same route. */
function tableKey(route: TableRoute): string {
  return `${route.method} ${route.path.replace(/\/+$/, '') || '/'}`
}

try {
  Object.assign(
    mongoColl,
    Object.fromEntries(
      Object.keys(mongoColl).map((name) => [
        name,
        () => {
          throw new Error(`collection ${name} was reached by a caller who is not signed in`)
        },
      ]),
    ),
  )

  const app = new Elysia().use(adminRoutes).use(adminPersonaRoutes)
  const routes: TableRoute[] = [
    ...new Map(
      (app.routes as Array<{ method: string; path: string }>).map((route) => {
        const entry: TableRoute = {
          method: String(route.method).toUpperCase(),
          path: route.path,
          url: route.path.replace(/:[^/]+/g, PLACEHOLDER_ID),
        }
        return [`${entry.method} ${entry.path}`, entry] as const
      }),
    ).values(),
  ]

  async function send(
    route: TableRoute,
    body: Record<string, unknown>,
    headers: Record<string, string>,
  ): Promise<{ status: number; body: Record<string, unknown> | null }> {
    const init: RequestInit = { method: route.method, headers: { ...headers } }
    if (route.method !== 'GET' && route.method !== 'HEAD') {
      init.body = JSON.stringify(body)
      init.headers = { ...headers, 'content-type': 'application/json' }
    }
    const response = await app.handle(new Request(`http://localhost${route.url}`, init))
    return { status: response.status, body: await response.json().catch(() => null) }
  }

  /** `{}` first; a validation rejection is retried with the route's real body. */
  async function probe(
    route: TableRoute,
    headers: Record<string, string>,
  ): Promise<{ status: number; body: Record<string, unknown> | null; notes: string }> {
    const first = await send(route, {}, headers)
    if (first.status !== 422) return { ...first, notes: '' }
    const fixture = ROUTE_BODIES[tableKey(route)]
    if (!fixture) {
      return {
        ...first,
        notes: ' — the schema rejected the audit body before the gate ran; add this route to ROUTE_BODIES',
      }
    }
    return { ...(await send(route, fixture, headers)), notes: '' }
  }

  function describe(response: { status: number; body: Record<string, unknown> | null }, notes: string): string {
    return `got ${response.status} ${JSON.stringify(response.body)}${notes}`
  }

  for (const route of routes) {
    env.ADMIN_USERNAME = ''
    env.ADMIN_PASSWORD = ''
    const unconfigured = await probe(route, {})
    const unconfiguredLabel = `${route.method} ${route.path} rejects an unconfigured server with 503`
    if (unconfigured.status === 503 && unconfigured.body?.error === UNCONFIGURED_ERROR) pass(unconfiguredLabel)
    else fail(unconfiguredLabel, describe(unconfigured, unconfigured.notes))

    env.ADMIN_USERNAME = DUMMY_USERNAME
    env.ADMIN_PASSWORD = DUMMY_PASSWORD
    // The cookie state a browser would send; the header is what a cross-origin
    // script cannot add, so its absence must be refused on every route.
    const cookieOnly = await probe(route, { cookie: `${SESSION_COOKIE}=audit-session` })
    const cookieLabel = `${route.method} ${route.path} rejects a session cookie without the admin header with 403`
    if (cookieOnly.status === 403 && cookieOnly.body?.error === MISSING_HEADER_ERROR) pass(cookieLabel)
    else fail(cookieLabel, describe(cookieOnly, cookieOnly.notes))
  }

  const keys = new Set(routes.map(tableKey))
  for (const expected of ['GET /admin/personas', 'GET /admin/personas/:personaId']) {
    const label = `the route table contains ${expected}`
    if (keys.has(expected)) pass(label)
    else fail(label, `not in: ${[...keys].join(', ')}`)
  }

  const personaRoutes = routes.filter((route) => route.url.startsWith('/admin/personas'))
  const label = 'persona routes are read-only'
  if (personaRoutes.length > 0 && personaRoutes.every((route) => route.method === 'GET')) pass(label)
  else fail(label, personaRoutes.map((route) => `${route.method} ${route.path}`).join(', ') || 'no persona routes found')

  const staleLabel = 'every ROUTE_BODIES entry names a route in the table'
  const stale = Object.keys(ROUTE_BODIES).filter((name) => !keys.has(name))
  if (stale.length === 0) pass(staleLabel)
  else fail(staleLabel, `no such route: ${stale.join(', ')}`)

  console.log('')
  for (const route of routes) console.log(`  checked ${route.method} ${route.path}`)
  console.log(
    `\nadmin-route-guard audit: ${checks} checks over ${routes.length} routes, ${failures.length} failed`,
  )
  if (failures.length) process.exitCode = 1
} finally {
  Object.assign(env, originalEnv)
  Object.assign(mongoColl, originalCollections)
}
