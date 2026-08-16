/**
 * Pure translation between the harness lifecycle and the enhanced ACP wire.
 * @module dsh-acp-enhanced/codec
 */

/**
 * Map a harness turn ending to ACP's terminal reason vocabulary.
 * @param reason - harness turn outcome.
 * @returns the closest legal ACP stop reason.
 */
export function turnEndToStopReason(reason) {
  switch (reason.kind) {
    case 'completed':
      return 'end_turn'
    case 'max-tokens':
      return 'max_tokens'
    // `cancelled` is reserved for explicit client cancellation (`session/cancel`)
    // and disposal, both settled out of band; a turn aborted by a hook or
    // another owner is ordinary quiescence and reports `end_turn`.
    case 'aborted':
      return 'end_turn'
    case 'interrupted':
      return 'cancelled'
    case 'blocked':
    case 'error':
      return 'end_turn'
    default:
      return 'end_turn'
  }
}

/**
 * Flatten an ACP prompt's baseline blocks to text. Text blocks concatenate
 * verbatim; resource links become explicit textual references.
 * @param prompt - supported ACP prompt blocks.
 * @returns text in wire order, with resource links rendered as bracketed references.
 */
export function acpPromptToText(prompt) {
  return prompt.flatMap((block) => {
    switch (block.type) {
      case 'text':
        return [block.text]
      case 'resource_link':
        return [`\n[resource_link name=${JSON.stringify(block.name)} uri=${JSON.stringify(block.uri)}]\n`]
      default:
        return []
    }
  }).join('')
}

/**
 * Whether a prompt carries content beyond the ACP baseline.
 * @param prompt - ACP prompt blocks to inspect.
 * @returns `true` when any block is neither `text` nor `resource_link`.
 */
export function promptHasUnsupportedContent(prompt) {
  return prompt.some((block) => block.type !== 'text' && block.type !== 'resource_link')
}

/** Kramdown attribute-style inline markup (SiYuan exports), including
 *  truncation-damaged tails — titles are byte-budgeted upstream, so a cut
 *  can land mid-attribute (unterminated `"` or no closing `]`):
 *  `[resource_link name="..." url="..."]`, `[file_link ...]`, `[ref ...]`. */
const KRAMDOWN_ATTR_MARKUP = /\[[^\]]*="[^\]]*\]|\[[^\]]*="[^\]]*$/g

/** Tight markdown link `[label](url)` — kept as the label only. */
const MARKDOWN_LINK = /\[([^\]]+)\]\(([^)\s]+)\)/g

/** Human-facing attribute kept when stripping kramdown markup; the closing
 *  quote is optional so a value truncated at the byte budget still survives. */
const ATTR_NAME_OR_TEXT = /(?:name|text)="([^"]*)"?/i

/**
 * Sanitize a session title for display on the ACP wire. Titles derive from
 * raw first-prompt text, which often carries pasted markup — SiYuan's
 * kramdown `[resource_link ...]` / `[file_link ...]` / `[ref ...]` inline
 * syntax (possibly truncated mid-markup), or plain markdown links. Keeps the
 * human-facing name/text (or the markdown label) and collapses whitespace
 * to a single line.
 * @param input - untrusted title text (raw or upstream-normalized).
 * @returns the cleaned title; `''` when nothing visible remains.
 */
export function sanitizeWireTitle(input) {
  return String(input ?? '')
    .replace(MARKDOWN_LINK, '$1')
    .replace(KRAMDOWN_ATTR_MARKUP, (match) => {
      const keep = ATTR_NAME_OR_TEXT.exec(match)
      return keep === null ? '' : keep[1]
    })
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Compute the usage telemetry snapshot for one provider-reported usage sample.
 * @param usage - TokenUsage { inputTokens, outputTokens, cacheReadTokens?, cacheWriteTokens?, reasoningTokens? }.
 * @param elapsedMs - generation wall time since the step started (0 when unknown).
 * @returns the flat telemetry record emitted inside usage_update._meta.
 */
export function usageTelemetry(usage, elapsedMs) {
  const inputTokens = usage.inputTokens
  const cacheReadTokens = usage.cacheReadTokens ?? 0
  const cacheWriteTokens = usage.cacheWriteTokens ?? 0
  const outputTokens = usage.outputTokens
  const reasoningTokens = usage.reasoningTokens ?? 0
  const pressure = inputTokens + cacheReadTokens + cacheWriteTokens
  const cacheHitRate = pressure > 0 ? Math.round((cacheReadTokens / pressure) * 10000) / 100 : 0
  const generated = outputTokens + reasoningTokens
  const tps = elapsedMs > 0 ? Math.round((generated / (elapsedMs / 1000)) * 10) / 10 : 0
  return {
    inputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    outputTokens,
    reasoningTokens,
    contextTokens: pressure,
    cacheHitRate,
    tps,
    elapsedMs,
  }
}
