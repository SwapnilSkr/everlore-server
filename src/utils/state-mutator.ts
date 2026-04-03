export interface Mutation {
  op: 'add' | 'subtract' | 'set'
  value: number
}

export interface FlagMutation {
  op: 'set' | 'increment' | 'decrement'
  value?: unknown
}

export function applyStateMutations(
  currentState: Record<string, number>,
  mutations: Record<string, Mutation>,
  statLimits?: Record<string, { min: number; max: number }>,
): Record<string, number> {
  const newState = { ...currentState }

  for (const [key, mutation] of Object.entries(mutations)) {
    if (!(key in newState)) continue

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
