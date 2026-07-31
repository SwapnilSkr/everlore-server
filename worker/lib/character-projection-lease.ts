/**
 * The inline projection normally finishes quickly, but it may make an LLM call.
 * Do not let a recovery job steal its claim while that call is still healthy.
 */
export const CHARACTER_PROJECTION_CLAIM_LEASE_MS = 2 * 60_000
