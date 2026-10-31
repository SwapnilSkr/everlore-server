/** Offline auth configuration and provider checks. Always run with --no-env-file. */
import assert from 'node:assert/strict'

const live = {
  TWILIO_ACCOUNT_SID: 'AC_PROD_AUTH_AUDIT_FAKE',
  TWILIO_AUTH_TOKEN: 'prod-auth-audit-token-fake',
  TWILIO_VERIFY_SERVICE_SID: 'VA_PROD_AUTH_AUDIT_FAKE',
  JWT_SECRET: 'prod-auth-audit-jwt-fake',
}
type AuthConfig = Partial<typeof live>
type InvalidCase = { name: string; key: keyof typeof live; value: string | undefined }
const invalid: InvalidCase[] = []
for (const key of Object.keys(live) as (keyof typeof live)[]) {
  for (const value of [undefined, '', ' \t ']) {
    invalid.push({ name: `${key} ${value === undefined ? 'missing' : value === '' ? 'empty' : 'whitespace'}`, key, value })
  }
}
invalid.push(
  { name: 'mock SID', key: 'TWILIO_ACCOUNT_SID', value: 'AC_MOCK_SID' },
  { name: 'development JWT secret', key: 'JWT_SECRET', value: 'dev-secret-change-in-production' },
)

// Synthetic values precede dynamic imports so this audit never needs local config.
process.env.NODE_ENV = 'test'
Object.assign(process.env, live)
process.env.REVIEW_DEMO_PHONE = ''
process.env.REVIEW_DEMO_OTP = ''
for (const key of ['MONGODB_URI', 'REDIS_URL', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'PINECONE_API_KEY']) {
  process.env[key] = 'prod-auth-audit-fake'
}
const { assertProductionAuthConfig, env } = await import('../src/config/env')

function checkMessage(message: string, config: AuthConfig, key: keyof typeof live): void {
  assert.ok(message.includes(key), `${key}: error names the variable`)
  for (const value of Object.values(config)) {
    if (value?.trim()) assert.ok(!message.includes(value), `${key}: error excludes configuration values`)
  }
}

for (const test of invalid) {
  const config = { ...live, [test.key]: test.value }
  assert.throws(() => assertProductionAuthConfig(config, 'production'), (error: unknown) => {
    assert.ok(error instanceof Error, test.name)
    checkMessage(error.message, config, test.key)
    return true
  }, `${test.name}: production must reject`)
}
assert.doesNotThrow(() => assertProductionAuthConfig(live, 'production'))
for (const nodeEnv of ['development', 'test', 'staging', undefined]) {
  assert.doesNotThrow(() => assertProductionAuthConfig({}, nodeEnv))
}
console.log(`production guard: ${invalid.length} invalid configurations rejected; live config and non-production defaults pass`)

// A fresh env import catches a guard that exists but is no longer called at boot.
function loadConfig(config: AuthConfig, nodeEnv?: string) {
  const childEnv: Record<string, string> = {}
  if (nodeEnv !== undefined) childEnv.NODE_ENV = nodeEnv
  for (const [key, value] of Object.entries(config)) {
    if (value !== undefined) childEnv[key] = value
  }
  return Bun.spawnSync([process.execPath, '--no-env-file', '--eval', `
    try {
      await import(${JSON.stringify(new URL('../src/config/env.ts', import.meta.url).href)})
      console.log('config loaded')
    } catch (error) {
      console.error(error instanceof Error ? error.message : 'Unexpected config error')
      process.exit(1)
    }
  `], { env: childEnv, stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' })
}
for (const test of invalid) {
  const config = { ...live, [test.key]: test.value }
  const child = loadConfig(config, 'production')
  assert.equal(child.exitCode, 1, `${test.name}: env load must reject`)
  checkMessage(child.stderr.toString(), config, test.key)
  assert.ok(!child.stdout.toString().includes('config loaded'), `${test.name}: env was not exported`)
}
for (const [config, nodeEnv] of [[live, 'production'], [{}, 'development'], [{}, undefined]] as const) {
  const child = loadConfig(config, nodeEnv)
  assert.equal(child.exitCode, 0, 'valid production or non-production env load succeeds')
  assert.ok(child.stdout.toString().includes('config loaded'))
}
console.log(`env-load integration: ${invalid.length} unsafe boots rejected; configured production and empty non-production boot pass`)

const provider = await import('../src/providers/auth.provider')
const phone = '+12025550142'
const originalFetch = globalThis.fetch
let fetchCalls = 0
globalThis.fetch = Object.assign(async (_input: string | URL | Request, _init?: RequestInit) => {
  fetchCalls++
  return Response.json({ status: 'pending' })
}, { preconnect: () => {} })
try {
  // Change the already-loaded env to bypass the startup check deliberately.
  for (const test of invalid.filter(test => test.key !== 'JWT_SECRET')) {
    Object.assign(env, live, { [test.key]: test.value || '' })
    process.env.NODE_ENV = 'production'
    assert.equal(provider.mockOtpCode(phone), null, `${test.name}: no production mock code`)
    const before = fetchCalls
    assert.equal(await provider.verifyPhoneOtp(phone, '123456'), false, `${test.name}: no production mock acceptance`)
    assert.equal(fetchCalls, before + 1, `${test.name}: production uses the provider`)

    for (const nodeEnv of ['development', 'test', undefined]) {
      if (nodeEnv === undefined) delete process.env.NODE_ENV
      else process.env.NODE_ENV = nodeEnv
      // Whitespace was not a mock trigger before this guard; keep that behavior.
      const mocked = test.value !== ' \t '
      assert.equal(provider.mockOtpCode(phone), mocked ? '123456' : null, `${test.name}: development mock unchanged`)
      const before = fetchCalls
      assert.equal(await provider.verifyPhoneOtp(phone, '123456'), mocked, `${test.name}: development verification unchanged`)
      assert.equal(await provider.verifyPhoneOtp(phone, '000000'), false)
      assert.equal(fetchCalls, before + (mocked ? 0 : 2), `${test.name}: development fetch behavior unchanged`)
    }
  }
} finally {
  globalThis.fetch = originalFetch
  Object.assign(env, live)
  process.env.NODE_ENV = 'test'
}
console.log('provider defence: production never exposes or accepts mock OTP after bypassing boot; development mock behavior unchanged; all fetches stubbed')
console.log('prod-auth-guard audit: PASS (no DB, no network, no .env)')
