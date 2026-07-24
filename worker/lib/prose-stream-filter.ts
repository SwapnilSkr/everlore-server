/**
 * Guards the player-facing narration stream against the occasional provider
 * that ignores the prose-only instruction and emits the old JSON envelope.
 *
 * Normal prose passes through immediately. A completion whose opening is a
 * JSON object containing `narrative` is held until it is complete, then only
 * that string is released. This is intentionally a narrow guard: a legitimate
 * story that starts with `{` must not be discarded merely because it is not
 * valid JSON with the expected field.
 */
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

export function makeProseStreamFilter(): ProseStreamFilter {
  let raw = ''
  let mode: 'undecided' | 'prose' | 'json' = 'undecided'
  let visible = ''
  let malformedEnvelope = false

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
      visible += chunk
      return chunk
    },

    end(): string {
      if (mode !== 'json') return ''
      const narrative = narrativeFromJson(raw)
      if (narrative != null) {
        visible = narrative
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
      visible = raw
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
