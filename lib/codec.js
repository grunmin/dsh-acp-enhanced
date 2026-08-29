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

/** Raster media types the harness attachment seam admits (dsh-attachment). */
const IMAGE_MEDIA_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

/**
 * Canonicalize an ACP image MIME type for the harness attachment store.
 * @param mimeType - the client-declared type (may be `image/jpg`, which
 *   the raster vocabulary spells `image/jpeg`).
 * @returns the harness media type, or `undefined` when the value is not a
 *   raster we ingest.
 */
export function canonicalImageMediaType(mimeType) {
  const lower = String(mimeType ?? '').trim().toLowerCase()
  const mapped = lower === 'image/jpg' ? 'image/jpeg' : lower
  return IMAGE_MEDIA_TYPES.has(mapped) ? mapped : undefined
}

/** Error for prompt content this adapter does not advertise. */
export class UnsupportedPromptContentError extends Error {
  constructor(contentType) {
    super(`unsupported prompt content type: ${contentType}`)
    this.name = 'UnsupportedPromptContentError'
  }
}

/** Error when an advertised image cannot be ingested (limits, decode, store). */
export class PromptImageError extends Error {
  constructor(message, options) {
    super(message, options)
    this.name = 'PromptImageError'
  }
}

/**
 * Narrow an unknown `ctx.attachments` value to the ingest surface used by
 * {@link convertPrompt}. Capability detection instead of version detection:
 * the service exists (with methods) on dsh 0.1.1-rc.2+, while the 0.1.0-rc.x
 * seam is an empty shell without `validateImage`/`saveImage` — and a
 * deployment without the attachment-local row has no service at all. All
 * three fall back to `undefined` here, so the caller simply does not
 * advertise image support.
 * @param value - `ctx.get('attachments')` (or anything shaped like it).
 * @returns the ingest surface, or `undefined` when absent/empty.
 */
export function attachmentIngestOf(value) {
  if (value === null || typeof value !== 'object') return undefined
  const candidate = value
  if (typeof candidate.validateImage !== 'function' || typeof candidate.saveImage !== 'function') {
    return undefined
  }
  const limits = candidate.imageLimits
  if (limits === undefined
    || typeof limits.maxImagesPerMessage !== 'number'
    || typeof limits.maxMessageImageBytes !== 'number'
    || typeof limits.maxImageBytes !== 'number') {
    return undefined
  }
  return candidate
}

function decodeImageData(data) {
  if (typeof data !== 'string' || data.length === 0) throw new PromptImageError('image data is empty')
  const decoded = Buffer.from(data, 'base64')
  if (decoded.byteLength === 0) throw new PromptImageError('image data is empty')
  return new Uint8Array(decoded)
}

/** Display name from an image URI's leaf, with local path info stripped. */
function imageName(uri) {
  if (typeof uri !== 'string' || uri.length === 0) return undefined
  let leaf
  try {
    leaf = new URL(uri).pathname.split('/').filter(Boolean).at(-1)
  } catch {
    leaf = uri.split(/[/\\]/).filter(Boolean).at(-1)
  }
  if (leaf === undefined || leaf.length === 0) return undefined
  try {
    return decodeURIComponent(leaf)
  } catch {
    return leaf
  }
}

/** Flush accumulated text into the block list (keeps 图文交替 wire order). */
function flushText(parts, blocks) {
  const text = parts.join('')
  parts.length = 0
  if (text.length > 0) blocks.push({ type: 'text', text })
}

/**
 * Convert an ACP prompt's content blocks into harness user-message content
 * blocks. Text and resource links concatenate in wire order; when the
 * composition provides an attachment ingest, ACP `image` blocks are decoded,
 * admission-checked against the store limits, and durably committed with
 * `saveImage`, keeping block order with surrounding text. Binary `resource`
 * payloads and audio stay rejected — silently dropping them would be worse
 * than refusing.
 * @param prompt - ACP `session/prompt` content, in wire order.
 * @param attachments - `ctx.attachments` ingest when the composition mounted
 *   one; omit (or pass `undefined`) to refuse images.
 * @returns `{ blocks, displayText }` ready for `createUserMessage` plus a
 *   human-readable text rendering (used for titles, transcripts, commands).
 * @throws UnsupportedPromptContentError for audio/binary blocks, or images
 *   with no ingest; PromptImageError when advertised image bytes fail
 *   admission.
 */
export async function convertPrompt(prompt, attachments) {
  const preparedImages = []
  for (const block of prompt) {
    if (block?.type !== 'image') continue
    if (attachments === undefined) throw new UnsupportedPromptContentError('image')
    const mediaType = canonicalImageMediaType(block.mimeType)
    if (mediaType === undefined) throw new PromptImageError(`unsupported image media type: ${block.mimeType}`)
    const data = decodeImageData(block.data)
    preparedImages.push({
      data,
      mediaType,
      ...imageName(block.uri) === undefined ? {} : { name: imageName(block.uri) },
    })
  }

  if (preparedImages.length > 0) {
    const { maxImagesPerMessage, maxMessageImageBytes, maxImageBytes } = attachments.imageLimits
    if (preparedImages.length > maxImagesPerMessage) {
      throw new PromptImageError('prompt exceeds the configured image-count limit')
    }
    const totalBytes = preparedImages.reduce((sum, image) => sum + image.data.byteLength, 0)
    if (totalBytes > maxMessageImageBytes) {
      throw new PromptImageError('prompt exceeds the configured aggregate image-byte limit')
    }
    for (const image of preparedImages) {
      if (image.data.byteLength > maxImageBytes) {
        throw new PromptImageError('image exceeds the configured encoded-byte limit')
      }
      try {
        await attachments.validateImage({ data: image.data, mediaType: image.mediaType, ...image.name === undefined ? {} : { name: image.name } })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        throw new PromptImageError(`image validation failed: ${message}`, { cause: error })
      }
    }
  }

  const parts = []
  const display = []
  const blocks = []
  let imageIndex = 0
  for (const block of prompt) {
    switch (block?.type) {
      case 'text':
        parts.push(block.text)
        display.push(block.text)
        break
      case 'resource_link':
        // Mirror the baseline bridge's textual reference so plain clients
        // keep file mentions without the bridge dropping them.
        parts.push(`\n[resource_link name=${JSON.stringify(block.name)} uri=${JSON.stringify(block.uri)}]\n`)
        display.push(`@${block.name}`)
        break
      case 'image': {
        if (attachments === undefined) throw new UnsupportedPromptContentError('image')
        const prepared = preparedImages[imageIndex]
        imageIndex += 1
        if (prepared === undefined) throw new PromptImageError('image block was not prepared')
        flushText(parts, blocks)
        let attachment
        try {
          attachment = await attachments.saveImage(prepared)
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          throw new PromptImageError(message, { cause: error })
        }
        blocks.push({ type: 'image', attachment })
        display.push(`[image${prepared.name === undefined ? '' : `: ${prepared.name}`}]`)
        break
      }
      default:
        throw new UnsupportedPromptContentError(block?.type ?? 'unknown')
    }
  }
  flushText(parts, blocks)
  return { blocks, displayText: display.join(' ').trim() }
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
