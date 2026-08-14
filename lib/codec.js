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
