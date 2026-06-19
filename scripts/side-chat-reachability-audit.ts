/**
 * Deterministic audit for side-chat reachability (§10). Pure — no LLM, no DB.
 * Focuses on ACCURACY: the dead/gone block must be high-precision (no false
 * blocks on living characters), and the mode must match the world state.
 *
 *   bun run scripts/side-chat-reachability-audit.ts
 */
import { resolveSideChatReachability, worldHasRemoteComm } from '../worker/lib/side-chat-reachability'

let pass = 0
let fail = 0
function ok(label: string, cond: boolean, detail = '') {
  console.log(`  ${cond ? '✅' : '❌'} ${label}${detail ? ` — ${detail}` : ''}`)
  cond ? pass++ : fail++
}

const NAMES = ['Mara', 'the captain']
const base = { characterNames: NAMES, currentSequence: 100, lastSeenSequence: 0 }

console.log('side-chat reachability audit:\n')

// BLOCKED — unambiguous death / permanent departure.
ok('dead → blocked', resolveSideChatReachability({ ...base, cardState: ['Mara is dead'] }).mode === 'blocked')
ok('was killed → blocked', resolveSideChatReachability({ ...base, cardState: ['Mara was killed in the duel'] }).mode === 'blocked')
ok('passed away → blocked', resolveSideChatReachability({ ...base, cardState: ['she passed away last winter'] }).mode === 'blocked')
ok('gone for good → blocked', resolveSideChatReachability({ ...base, cardState: ['Mara left for good'] }).mode === 'blocked')
ok('blocked is not allowed', resolveSideChatReachability({ ...base, cardState: ['Mara is dead'] }).allowed === false)

// PRECISION — these must NOT block (living characters).
ok('"not dead" → not blocked', resolveSideChatReachability({ ...base, cardState: ['Mara is not dead after all'] }).mode !== 'blocked')
ok('"presumed dead" → not blocked', resolveSideChatReachability({ ...base, cardState: ['Mara is presumed dead'] }).mode !== 'blocked')
ok('"fears death" → not blocked', resolveSideChatReachability({ ...base, cardState: ['Mara fears death'] }).mode !== 'blocked')
ok('"nearly killed" → not blocked', resolveSideChatReachability({ ...base, cardState: ['Mara was nearly killed'] }).mode !== 'blocked')
ok('"gone to the market" → not blocked', resolveSideChatReachability({ ...base, cardState: ['Mara has gone to the market'] }).mode !== 'blocked')

// PRESENT / NEARBY.
ok('present in latest scene', resolveSideChatReachability({ ...base, latestPresent: ['Mara'] }).mode === 'present')
ok('present matches alias', resolveSideChatReachability({ ...base, latestPresent: ['The Captain'] }).mode === 'present')
ok('in recent window → nearby', resolveSideChatReachability({ ...base, latestPresent: ['Bram'], recentPresent: ['Bram', 'Mara'] }).mode === 'nearby')
ok('seen 3 turns ago → nearby', resolveSideChatReachability({ ...base, lastSeenSequence: 97 }).mode === 'nearby')

// REMOTE vs SEEK — depends on world capability.
ok('modern world, absent → reachable_remote', resolveSideChatReachability({ ...base, worldText: 'A modern city of smartphones and traffic.' }).mode === 'reachable_remote')
ok('magic link world → reachable_remote', resolveSideChatReachability({ ...base, worldText: 'Mages speak mind-to-mind across the realm via telepathy.' }).mode === 'reachable_remote')
ok('grounded world, absent → seek_required', resolveSideChatReachability({ ...base, worldText: 'A medieval village of farmers and mud.' }).mode === 'seek_required')
ok('seek_required is disabled until sought out', resolveSideChatReachability({ ...base, worldText: 'A medieval village.' }).allowed === false)

// worldHasRemoteComm unit checks.
ok('phone → remote', worldHasRemoteComm('she sent a text message') === true)
ok('radio → remote', worldHasRemoteComm('crackling radio chatter') === true)
ok('plain medieval → not remote', worldHasRemoteComm('swords and horses') === false)

console.log(`\nside-chat reachability audit: ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
