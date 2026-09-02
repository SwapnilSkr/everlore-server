import type { CorpusTurn } from './corpus-freeze'

/**
 * The corpus sample, deterministic for a given corpus + size, so a tier measured
 * today and one measured next week are scored over exactly the same turns.
 * Stratified by world so a single long run cannot dominate.
 */
export function stratifiedSample(turns: CorpusTurn[], n: number): CorpusTurn[] {
  const byInstance = new Map<string, CorpusTurn[]>()
  for (const turn of turns) {
    if (!turn.prose.trim() || !turn.playerInput.trim()) continue
    const list = byInstance.get(turn.instance) || []
    list.push(turn)
    byInstance.set(turn.instance, list)
  }
  // Allocate slots in PROPORTION TO DEPTH, then stride within each world.
  //
  // Round-robin across worlds looked like stratification and was not: the corpus
  // has 24 worlds and most are 1-8 turns long, so two rounds of round-robin
  // produced a sample whose median sequence was 4. Every extractor was being
  // scored almost entirely on cold openings, which is the one situation where
  // there is no prior location to carry and everything must be guessed.
  // Durability is a property of long runs, so the sample has to reach into them.
  const pools = [...byInstance.values()]
    .map((pool) => pool.sort((a, b) => a.sequence - b.sequence))
    .sort((a, b) => b.length - a.length)
  const total = pools.reduce((sum, pool) => sum + pool.length, 0)
  const out: CorpusTurn[] = []
  for (const pool of pools) {
    if (out.length >= n) break
    const share = Math.max(1, Math.round((pool.length / total) * n))
    const stride = Math.max(1, Math.floor(pool.length / share))
    for (let k = 0; k < share && out.length < n; k++) {
      const index = Math.min(pool.length - 1, k * stride)
      const turn = pool[index]
      if (turn && !out.includes(turn)) out.push(turn)
    }
  }
  return out
}
