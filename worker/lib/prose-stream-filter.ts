/**
 * Guards the player-facing narration stream against two things the narrator
 * gets wrong often enough to be a pattern, not an accident:
 *
 * 1. a provider that ignores the prose-only instruction and emits the old JSON
 *    envelope instead of prose (below);
 * 2. the house prose format itself — only spoken words in double quotes, every
 *    other word in single-asterisk italics. The adult narrator in particular
 *    writes `*I hiss. "Mine,"* I snarl,` and `*I hiss. "Keep still."*`, which
 *    paints speech as narration and narration as speech. Those markers are
 *    moved by {@link makeProseFormatNormalizer} as the words arrive, so the
 *    player never sees the broken form even for a moment, and the prose the
 *    turn is persisted with is the prose that was shown.
 *
 * Normal prose passes through immediately. A completion whose opening is a
 * JSON object containing `narrative` is held until it is complete, then only
 * that string is released. This is intentionally a narrow guard: a legitimate
 * story that starts with `{` must not be discarded merely because it is not
 * valid JSON with the expected field.
 */
import { makeProseFormatNormalizer, normalizeProseFormat } from '../../src/utils/prose-hygiene'

export interface ProseStreamFilter {
  push(chunk: string): string
  end(): string
  prose(): string
  /** True when a provider began the legacy narrative JSON envelope but did not
   * finish a parseable object. The caller must reset/retry rather than expose
   * protocol text as story prose. */
  malformedNarrativeEnvelope(): boolean
}

function narrativeFromJson(value: string): string | null {
  try {
    const parsed = JSON.parse(value) as { narrative?: unknown }
    return typeof parsed.narrative === 'string' ? parsed.narrative : null
  } catch {
    return null
  }
}

function looksLikeNarrativeEnvelope(value: string): boolean {
  return /^\s*\{\s*["']narrative["']\s*:/i.test(value)
}

/**
 * The choices tail is hidden metadata, not prose: `choice-tail.ts` parses it out
 * of exactly this stream (a `===CHOICES===` heading, or a bare `[act]`/`[say]`
 * row as its backstop). Prose formatting must therefore never touch it — an
 * asterisk inside that heading would stop it matching, and the tail would leak
 * to the player as narration. Both shapes are protocol syntax, not wording: a
 * `=` heading is punctuation no story sentence uses, and a row opens the line
 * with a bracket.
 */
function startsChoicesProtocol(c: string, lineClean: boolean): boolean {
  return c === '=' || (c === '[' && lineClean)
}

function isLineFiller(c: string): boolean {
  return c === ' ' || c === '\t' || c === '\r'
}

export function makeProseStreamFilter(): ProseStreamFilter {
  let raw = ''
  let mode: 'undecided' | 'prose' | 'json' = 'undecided'
  let visible = ''
  let malformedEnvelope = false
  const format = makeProseFormatNormalizer()
  /** Only spaces/tabs seen since this line began. */
  let lineClean = true
  /** Past the prose: the choices tail and anything after it pass through as-is. */
  let protocol = false

  return {
    push(chunk: string): string {
      if (!chunk) return ''
      raw += chunk

      if (mode === 'undecided') {
        // Narrative prose is instructed to begin with an asterisk or quote.
        // Holding the unusual `{` opening until completion ensures a JSON
        // envelope can never flash even when its first key arrives split across
        // several provider chunks (for example, `{"nar` + `rative": ...}`).
        if (!raw.trim()) return ''
        mode = raw.trimLeft().startsWith('{') ? 'json' : 'prose'
      }

      if (mode === 'json') return ''

      let delta = ''
      for (const c of chunk) {
        if (!protocol && startsChoicesProtocol(c, lineClean)) {
          protocol = true
          // Ends the formatter, closing only a run it opened itself; text it
          // was still holding belongs before the protocol line.
          delta += format.end()
        }
        delta += protocol ? c : format.push(c)
        if (c === '\n') lineClean = true
        else if (!isLineFiller(c)) lineClean = false
      }
      visible += delta
      return delta
    },

    end(): string {
      if (mode !== 'json') {
        const rest = format.end()
        visible += rest
        return rest
      }
      const narrative = narrativeFromJson(raw)
      if (narrative != null) {
        visible = normalizeProseFormat(narrative)
        return visible
      }
      // Do not ever render an incomplete legacy envelope as if it were prose.
      // A real story can still legitimately start with `{` and falls through to
      // the old preservation behavior unless it clearly begins with the
      // narrative protocol key.
      if (looksLikeNarrativeEnvelope(raw)) {
        malformedEnvelope = true
        visible = ''
        return ''
      }
      visible = normalizeProseFormat(raw)
      return visible
    },

    prose(): string {
      return visible
    },

    malformedNarrativeEnvelope(): boolean {
      return malformedEnvelope
    },
  }
}
