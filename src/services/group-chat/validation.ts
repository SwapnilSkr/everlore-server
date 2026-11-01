import type { WorldTemplateDoc } from '../../models/world-template.model'

export function validateGroup(data: Partial<WorldTemplateDoc>): void {
  if (data.kind !== 'group') return
  const fail = (message: string): never => { throw new Error(`Group: ${message}`) }
  if (data.is_sentient !== false) fail('is_sentient must be false')
  if (Object.keys(data.base_stats_template || {}).length) fail('stats must be empty')
  if (data.protagonist || data.opening_line) fail('use seed_cast and opening_lines')
  const cast = data.seed_cast || []
  if (cast.length < 4 || cast.length > 5) fail('4–5 cast members required')
  const names = new Set<string>()
  for (const member of cast) {
    const name = member.name?.trim().toLowerCase()
    if (!name || names.has(name)) fail('cast names must be unique')
    if (member.name !== member.name.trim() || /[:\r\n*@]/u.test(member.name)) fail('cast names must be valid message prefixes')
    names.add(name)
    const traits = member.group
    if (!traits || !Number.isFinite(traits.age) || traits.age < 18) fail('every member must be 18 or older')
    if (!Number.isFinite(traits!.talkativeness) || traits!.talkativeness < 0 || traits!.talkativeness > 1) fail('talkativeness must be 0–1')
    if (!traits!.speech?.trim() || !traits!.wants?.trim()) fail('speech and wants must contain text')
  }
  if (!data.topics?.length || data.topics.some(topic => !topic.trim())) fail('topics must contain text')
  if (!data.opening_lines?.length) fail('opening_lines required')
  for (const line of data.opening_lines || []) {
    if (!names.has(line.name.trim().toLowerCase()) || !line.text.trim()) fail('opening_lines must name cast members and contain text')
  }
}
