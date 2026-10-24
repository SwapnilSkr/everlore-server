/**
 * §4.3 — reduce an exception message to its shape before it is stored.
 *
 * A Dart exception message is the one place a player's own words can reach the
 * server: a JSON decode error quotes the reply that failed to parse, a server
 * error echoes the input that caused it. The screenshot from the report is
 * exactly that shape — `Bad state: No element` is harmless, `Could not parse
 * "the moon was full and she said..."` is somebody's story.
 *
 * So the message keeps its structure and loses its particulars. Order matters
 * and is not free to change:
 *   1. quoted runs first — that is where the words are, and replacing them early
 *      means the patterns below never have to reason about quoted content;
 *   2. addresses, then URL queries;
 *   3. 24-hex ids before digit runs, or an all-digit ObjectId would degrade to
 *      `<n>` runs instead of one `<id>`;
 *   4. digit runs of six or more (otp codes, phone fragments, timestamps);
 *   5. cut to 300.
 *
 * The fingerprint never uses this output, so scrubbing cannot split a group.
 */
export const MAX_MESSAGE_CHARS = 300

/**
 * A quote only opens a run when it does not follow a word character, so the
 * apostrophe in "don't" is not read as the start of a quoted span. Anything
 * inside single, double or back quotes collapses to the same marker, because the
 * console only needs to know a value was there, not which punctuation held it.
 */
function collapseQuoted(text: string): string {
  return text
    .replace(/(?<![\w])'[^'\n]*'/g, "'…'")
    .replace(/"[^"\n]*"/g, "'…'")
    .replace(/`[^`\n]*`/g, "'…'")
}

export function scrubMessage(raw: string): string {
  let text = collapseQuoted(raw)
  text = text.replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, '<email>')
  // Only the query part of a URL: the host and path say where, the query says
  // what was asked for, and that is where search terms and tokens live.
  text = text.replace(/\b(https?:\/\/[^\s?#]+)\?[^\s#]*/g, '$1?…')
  text = text.replace(/\b[0-9a-f]{24}\b/gi, '<id>')
  text = text.replace(/\d{6,}/g, '<n>')
  return text.slice(0, MAX_MESSAGE_CHARS)
}
