/** Each mutation is loaded in memory in an isolated child; working-tree files are never edited. */
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'

type Mutation = { name: string; file: URL; changes: Array<[string, string]> }
const controller = new URL('../src/controllers/template.controller.ts', import.meta.url)
const projection = new URL('../src/utils/template-public-projection.ts', import.meta.url)
const instanceController = new URL('../src/controllers/instance.controller.ts', import.meta.url)
const playWs = new URL('../src/services/play-ws.service.ts', import.meta.url)
const fullDecision = "return template.kind !== 'group' && canReadTemplateAuthoring(template, user) ? template : publicGroupTemplate(template)"
const createDecision = `return canReadTemplateAuthoring(result.template, user)
      ? result
      : { ...result, template: publicTemplate(result.template) }`
const loadDecision = `const responseState = state.template && !canReadTemplateAuthoring(state.template, user)
            ? { ...state, template: publicTemplate(state.template) }
            : state`
const mutations: Mutation[] = [
  { name: 'a', file: controller, changes: [['return { ...result, templates: result.templates.map(publicGroupTemplate) }', 'return result']] },
  { name: 'b', file: controller, changes: [[fullDecision, "return !user ? template : (template.kind !== 'group' && canReadTemplateAuthoring(template, user) ? template : publicGroupTemplate(template))"]] },
  { name: 'c', file: controller, changes: [[fullDecision, 'return user ? template : publicGroupTemplate(template)']] },
  { name: 'd', file: controller, changes: [[fullDecision, 'return publicGroupTemplate(template)']] },
  { name: 'e', file: projection, changes: [['return isAdmin || Boolean(user && idString(template.creator_id) === user.id)', 'return Boolean(user && idString(template.creator_id) === user.id)']] },
  { name: 'f', file: projection, changes: [['.filter((key) => Object.prototype.hasOwnProperty.call(template, key))', ".concat(['future_private_field'] as unknown as typeof PUBLIC_TEMPLATE_KEYS[number][])\n      .filter((key) => Object.prototype.hasOwnProperty.call(template, key))"]] },
  { name: 'g', file: controller, changes: [[`    return templateService.listByCreator(
      user.id,
      Number(query.page) || 1,
      Number(query.limit) || 20,
      query.search,
      query.kind,
    )`, `    const result = await templateService.listByCreator(
      user.id,
      Number(query.page) || 1,
      Number(query.limit) || 20,
      query.search,
      query.kind,
    )
    return { ...result, templates: result.templates.map(publicGroupTemplate) }`]] },
  { name: 'h', file: instanceController, changes: [[createDecision, 'return result']] },
  { name: 'h', file: instanceController, changes: [[createDecision, 'result.template = publicTemplate(result.template) as typeof result.template\n    return result']] },
  { name: 'i', file: playWs, changes: [[loadDecision, 'const responseState = state']] },
  { name: 'i', file: playWs, changes: [[loadDecision, 'if (state.template) state.template = publicTemplate(state.template) as typeof state.template\n          const responseState = state']] },
  { name: 'j', file: instanceController, changes: [[createDecision, 'return { ...result, template: publicTemplate(result.template) }']] },
  { name: 'j', file: playWs, changes: [[loadDecision, 'const responseState = state.template ? { ...state, template: publicTemplate(state.template) } : state']] },
]

const reportDir = resolve(tmpdir(), 'everlore-template-privacy-bite')
await mkdir(reportDir, { recursive: true })
const preload = resolve(reportDir, 'mutation-loader.ts')
await writeFile(preload, `import { plugin } from 'bun'
const mutation = JSON.parse(process.env.TEMPLATE_PRIVACY_MUTATION!)
plugin({ name: 'template-privacy-mutation', setup(build) {
  build.onLoad({ filter: new RegExp('^' + mutation.path.replaceAll('.', '[.]') + '$') }, () => ({ contents: mutation.contents, loader: 'ts' }))
} })
`)
const cwd = fileURLToPath(new URL('..', import.meta.url))
for (const mutation of mutations) {
  const file = fileURLToPath(mutation.file)
  const original = await readFile(file, 'utf8')
  let tampered = original
  for (const [from, to] of mutation.changes) {
    assert.ok(tampered.includes(from), `Missing mutation anchor: ${mutation.name}`)
    assert.equal(tampered.split(from).length, 2, `mutation ${mutation.name} must match once`)
    tampered = tampered.replace(from, to)
  }
  const child = Bun.spawn(['bun', '--no-env-file', '--preload', preload, './scripts/template-privacy-audit.ts'], {
    cwd, stdout: 'pipe', stderr: 'pipe',
    env: { ...process.env, TEMPLATE_PRIVACY_MUTATION: JSON.stringify({ path: file, contents: tampered }) },
  })
  const timer = setTimeout(() => child.kill(), 30000)
  const [out, err, status] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  clearTimeout(timer)
  assert.equal(status, 1, `DID NOT BITE: ${mutation.name}\n${out}\n${err}`)
  assert.ok(err.includes(`FAIL (${mutation.name})`), `Must fail the named assertion, not syntax/typechecking: ${mutation.name}\n${err}`)
  console.log(`BITE (${mutation.name}): exit ${status}; ${err.split('\n').find((line) => line.includes(`FAIL (${mutation.name})`))?.trim()}`)
}
console.log(`All ${mutations.length} mutations failed their named check; working-tree sources unchanged.`)
