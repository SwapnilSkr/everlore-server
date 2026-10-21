/** Deliberate source mutations, each restored before the next case. Run alone. */
import assert from 'node:assert/strict'

const controller = new URL('../src/controllers/template.controller.ts', import.meta.url)
const projection = new URL('../src/utils/template-public-projection.ts', import.meta.url)
const instanceController = new URL('../src/controllers/instance.controller.ts', import.meta.url)
const playWs = new URL('../src/services/play-ws.service.ts', import.meta.url)
const fullDecision = 'return canReadTemplateAuthoring(template, user) ? template : publicTemplate(template)'
const createDecision = `return canReadTemplateAuthoring(result.template, user)
      ? result
      : { ...result, template: publicTemplate(result.template) }`
const loadDecision = `const responseState = state.template && !canReadTemplateAuthoring(state.template, user)
            ? { ...state, template: publicTemplate(state.template) }
            : state`
const cases = [
  ['a', controller, 'return { ...result, templates: result.templates.map(publicTemplate) }', 'return result'],
  ['b', controller, fullDecision, 'return !user ? template : (canReadTemplateAuthoring(template, user) ? template : publicTemplate(template))'],
  ['c', controller, fullDecision, 'return user ? template : publicTemplate(template)'],
  ['d', controller, fullDecision, 'return publicTemplate(template)'],
  ['e', projection, 'return isAdmin || Boolean(user && idString(template.creator_id) === user.id)', 'return Boolean(user && idString(template.creator_id) === user.id)'],
  ['f', projection, '.filter((key) => Object.prototype.hasOwnProperty.call(template, key))', ".concat(['future_private_field'] as unknown as typeof PUBLIC_TEMPLATE_KEYS[number][])\n      .filter((key) => Object.prototype.hasOwnProperty.call(template, key))"],
  ['g', controller,
    'return templateService.listByCreator(user.id, Number(query.page) || 1, Number(query.limit) || 20, query.search)',
    'const result = await templateService.listByCreator(user.id, Number(query.page) || 1, Number(query.limit) || 20, query.search)\n    return { ...result, templates: result.templates.map(publicTemplate) }'],
  ['h', instanceController, createDecision, 'return result'],
  ['h', instanceController, createDecision,
    'result.template = publicTemplate(result.template) as typeof result.template\n    return result'],
  ['i', playWs, loadDecision, 'const responseState = state'],
  ['i', playWs, loadDecision,
    'if (state.template) state.template = publicTemplate(state.template) as typeof state.template\n          const responseState = state'],
  ['j', instanceController, createDecision, 'return { ...result, template: publicTemplate(result.template) }'],
  ['j', playWs, loadDecision,
    'const responseState = state.template ? { ...state, template: publicTemplate(state.template) } : state'],
] as const

for (const [label, file, before, after] of cases) {
  const original = await Bun.file(file).text()
  assert.equal(original.split(before).length, 2, `mutation ${label} must match once`)
  try {
    await Bun.write(file, original.replace(before, after))
    const proc = Bun.spawn([process.execPath, '--no-env-file', 'run', 'scripts/template-privacy-audit.ts'], {
      cwd: new URL('..', import.meta.url).pathname,
      stdout: 'pipe', stderr: 'pipe',
    })
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
    ])
    const output = stdout + stderr
    assert.equal(code, 1, `mutation ${label} must fail the audit: ${output}`)
    assert(output.includes(`FAIL (${label})`), `mutation ${label} must fail its own check: ${output}`)
    console.log(`BITE (${label}): exit ${code}; ${output.split('\n').find((line) => line.includes(`FAIL (${label})`))?.trim()}`)
  } finally {
    await Bun.write(file, original)
    assert.equal(await Bun.file(file).text(), original)
  }
}
console.log(`All ${cases.length} mutations caught; source files restored byte-for-byte.`)
