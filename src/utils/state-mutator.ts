export interface Mutation {
  op: 'add' | 'subtract' | 'set'
  value: number
}

export interface FlagMutation {
  op: 'set' | 'increment' | 'decrement'
  value?: unknown
}

/** Loose key for matching a model-emitted stat name to a tracked gauge:
 *  case-folded with separators and spaces removed, so "Heat", "heat ", and
 *  "player_heat" style casing/punctuation drift still lands on `heat`. */
function statKey(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '')
}

/**
 * Resolve a model-emitted stat name to the tracked gauge it means. Exact match
 * first; otherwise a single unambiguous case/punctuation-insensitive match.
 * Returns null when the name matches no tracked gauge (or more than one) — an
 * unknown gauge is dropped rather than guessed at.
 */
export function resolveStatKey(
  name: string,
  trackedKeys: readonly string[],
): string | null {
  if (trackedKeys.includes(name)) return name
  const wanted = statKey(name)
  if (!wanted) return null
  const matches = trackedKeys.filter((key) => statKey(key) === wanted)
  return matches.length === 1 ? matches[0] : null
}

export function applyStateMutations(
  currentState: Record<string, number>,
  mutations: Record<string, Mutation>,
  statLimits?: Record<string, { min: number; max: number }>,
): Record<string, number> {
  const newState = { ...currentState }
  const trackedKeys = Object.keys(newState)

  for (const [rawKey, mutation] of Object.entries(mutations)) {
    // A mutation naming an untracked gauge is dropped — but casing/punctuation
    // drift ("Heat" for `heat`) is a near miss, not an untracked gauge, and
    // silently dropping it froze every stat it touched.
    const key = resolveStatKey(rawKey, trackedKeys)
    if (!key) continue

    switch (mutation.op) {
      case 'add':
        newState[key] += mutation.value
        break
      case 'subtract':
        newState[key] -= mutation.value
        break
      case 'set':
        newState[key] = mutation.value
        break
    }

    // Clamp to limits
    const limits = statLimits?.[key]
    if (limits) {
      newState[key] = Math.max(limits.min, Math.min(limits.max, newState[key]))
    } else {
      newState[key] = Math.max(0, Math.min(100, newState[key]))
    }
  }

  return newState
}

export function applyFlagMutations(
  currentFlags: Record<string, any>,
  mutations: Record<string, FlagMutation>,
): Record<string, any> {
  const newFlags = { ...currentFlags }

  for (const [key, mutation] of Object.entries(mutations)) {
    switch (mutation.op) {
      case 'set':
        newFlags[key] = mutation.value
        break
      case 'increment':
        newFlags[key] = (typeof newFlags[key] === 'number' ? newFlags[key] : 0) + 1
        break
      case 'decrement':
        newFlags[key] = (typeof newFlags[key] === 'number' ? newFlags[key] : 0) - 1
        break
    }
  }

  return newFlags
}
