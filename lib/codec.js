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
 * Flatten an ACP prompt's text blocks to the line a composer submits: text
 * blocks concatenate verbatim in wire order, while images and resource links
 * are composer attachments, not input-box text. This is the line slash
 * commands are parsed from — an image pasted next to a slash line must neither
 * prefix it nor pollute its arguments (the Web composer's `matchEnter`
 * contract: line text plus a separate images payload).
 * @param prompt - ACP `session/prompt` content, in wire order.
 * @returns the concatenated text-block content.
 */
export function acpPromptLineText(prompt) {
  return (prompt ?? []).flatMap((block) => block?.type === 'text' && typeof block.text === 'string' ? [block.text] : []).join('')
}

/**
 * Build the composer's image payload for a slash-command submission from an
 * ACP prompt: one `{ data, mediaType, name? }` upload object per image block,
 * in wire order — the registry `execute` images slot's exact shape (the
 * composer serializes `{ type: 'image', mediaType, data, name }`, and the
 * command service's `admitEncodedImages` reads `data`/`mediaType`/`name`).
 * The service admits the payload into the attachment store itself; the store
 * is content-addressed, so an image `convertPrompt` already saved resolves to
 * the same reference and nothing is duplicated. An image whose media type is
 * not a raster cannot reach a command (`convertPrompt` rejects it before
 * dispatch), so a non-raster here is simply skipped.
 * @param prompt - ACP `session/prompt` content, in wire order.
 * @returns upload objects ready for `commands.execute`'s images slot.
 */
export function acpPromptCommandImages(prompt) {
  return (prompt ?? []).flatMap((block) => {
    if (block?.type !== 'image' || typeof block.data !== 'string' || block.data.length === 0) return []
    const mediaType = canonicalImageMediaType(block.mimeType)
    if (mediaType === undefined) return []
    const name = imageName(block.uri)
    return [{ data: block.data, mediaType, ...name === undefined ? {} : { name } }]
  })
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
 * than refusing. All validation (block types, decode, limits, `validateImage`)
 * completes before the first `saveImage`, so a rejected prompt leaves no
 * partial writes behind.
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
  // Admission is strictly before persistence, in two phases: first the whole
  // block-type scan, then image decoding/limits. A prompt like [image, audio]
  // is rejected as unsupported content BEFORE the image is prepared (and long
  // before any `saveImage`), so an unsupported block later in the prompt can
  // never fail after an earlier image was durably saved (an orphan in the
  // store), and the error priority does not depend on block order. Store
  // writes only happen in the assembly loop below.
  for (const block of prompt) {
    const type = block?.type
    if (type !== 'text' && type !== 'resource_link' && type !== 'image') {
      throw new UnsupportedPromptContentError(type ?? 'unknown')
    }
    if (type === 'image' && attachments === undefined) {
      throw new UnsupportedPromptContentError('image')
    }
  }
  const preparedImages = []
  for (const block of prompt) {
    if (block?.type !== 'image') continue
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
      // The limit reads decoded bytes — the same unit `validateImage`/
      // `saveImage` receive and the store enforces (base64 wire text would be
      // ~4/3 of this).
      if (image.data.byteLength > maxImageBytes) {
        throw new PromptImageError('image exceeds the configured image-byte limit')
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
 * The preset a session actually runs, folded from its committed event log:
 * the last `agent-preset/selected` event wins over the creation header.
 * Folded here rather than resolved through dsh-agent-presets so the read is
 * generation-agnostic: the legacy `resolveSessionPreset` export and the
 * 0.1.2-alpha `agentPreset` session projection define this exact fold — the
 * last selection event wins, the creation header is the fallback, and a
 * deployment that composes none yields `undefined`.
 * @param events - the session's committed events, in log order.
 * @param header - the session header (creation metadata).
 * @returns the running agent preset id, or `undefined`.
 */
export function runningPresetFrom(events, header) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type === 'agent-preset/selected') return event.data.agentPreset
  }
  return header?.agentPreset
}

/**
 * Whether one session has produced anything yet. A preset swap is only legal
 * while it is blank (dsh-agent-presets product rule): swapping tools
 * mid-conversation would strand logged tool calls the new composition cannot
 * make. Checks both the live turn marker and persisted user messages, so the
 * same rule holds for resumed sessions whose on-disk logs may not carry
 * `turn/start`.
 * @param events - the session's committed events, in log order.
 * @returns `true` while no turn or user message is logged.
 */
export function isBlankFrom(events) {
  return !events.some((event) => (
    event?.type === 'turn/start' || event?.type === 'user/message'
  ))
}

/**
 * The tool call id a dsh `tool/result` event answers.
 *
 * `ToolResultMessage` moved the id across the supported dsh lines: 0.1.7
 * carries `message.toolCallId`, 0.1.5 nests it on the first `tool-result`
 * content block, and a root-level `callId` is the legacy fallback. Reading only
 * one of them left the emitted `tool_call_update` without an id on the other
 * line, so the editor could not match the update to the card — its status
 * stayed "running" and no output ever appeared. Accept all three shapes.
 * @param data - the `tool/result` event's `data`.
 * @returns the call id, or `undefined` when the event carries none.
 */
export function toolResultCallId(data) {
  return data?.message?.toolCallId
    ?? data?.message?.content?.[0]?.toolCallId
    ?? data?.callId
}

/**
 * Flatten a dsh `tool/result` message's content array into plain text.
 *
 * The ToolResultMessage content shape moved across the supported dsh lines:
 * 0.1.5 nests each entry's text under a `tool-result` content block, while
 * 0.1.7 emits the text blocks directly. Accept both — a top-level text block
 * contributes its own text, anything else contributes the text of its nested
 * `content` array — so the result body survives either generation. Non-text
 * inner blocks (images, attachments) are ignored; this is the plain-text
 * projection the tool cards and the shell exit-marker parser consume.
 * @param content - a dsh `tool/result` message content block array.
 * @returns the joined text ('' when the result carries none).
 */
export function toolResultText(content) {
  const parts = []
  for (const block of content ?? []) {
    if (block?.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text)
      continue
    }
    for (const inner of block?.content ?? []) {
      if (inner?.type === 'text' && typeof inner.text === 'string') parts.push(inner.text)
    }
  }
  return parts.join('\n')
}

/**
 * Split a committed assistant message's content blocks into the wire chunks
 * that carry it, **in generation order**.
 *
 * A model message is an ordered block list — reasoning blocks precede the text
 * they produced — and the live seam preserves that order because it forwards
 * one chunk per block. Replay and the `assistant/message` fallback read the
 * committed message as a whole, so they must recover the order here: emitting
 * every text block and then every reasoning block renders the thinking block
 * *below* the reply it belongs to, which on a session's final message parks a
 * think block at the very end of the thread.
 *
 * Consecutive blocks of the same kind coalesce into one chunk (joined by `\n`),
 * so the ordinary `reasoning → text` message stays two chunks. Image blocks are
 * their own `image` run: ACP carries no attachment bytes, so the run's text is
 * the same textual placeholder `textFromBlocks` uses, but keeping the kind lets
 * a caller deliver an image even when the host already streamed the text around
 * it (images never travel the streaming text path) without ever sending the
 * same placeholder twice.
 *
 * @param content - a dsh `assistant/message` content block array.
 * @returns ordered `{ kind: 'text' | 'thought' | 'image', text }` chunks; blank ones dropped.
 */
export function assistantContentChunks(content) {
  const runs = []
  for (const block of content ?? []) {
    let kind
    let text
    if (block?.type === 'text' && typeof block.text === 'string') {
      kind = 'text'
      text = block.text
    } else if (block?.type === 'reasoning' && typeof block.text === 'string') {
      kind = 'thought'
      text = block.text
    } else if (block?.type === 'image' && block.attachment?.attachmentId !== undefined) {
      kind = 'image'
      text = `[image attachment ${block.attachment.attachmentId}]`
    } else {
      continue
    }
    const last = runs[runs.length - 1]
    if (last !== undefined && last.kind === kind) last.parts.push(text)
    else runs.push({ kind, parts: [text] })
  }
  return runs
    .map(({ kind, parts }) => ({ kind, text: parts.join('\n') }))
    .filter((chunk) => chunk.text.trim().length > 0)
}

/**
 * Which wire chunks of a committed assistant message the client is still owed.
 *
 * The `assistant/message` fallback covers a host that streamed nothing — or
 * whose frames were dropped — but it must never duplicate what did stream.
 * Delivery is all-or-nothing per kind: if this step already put any text on the
 * wire, the whole step's text was rendered, and the same for reasoning. Images
 * are the exception — they never travel the streaming text path, so a committed
 * image is always owed, exactly once, in its committed position.
 *
 * Keeping the decision here rather than in the adapter makes it an offline unit
 * test, and keeps it beside the ordering contract it depends on.
 *
 * @param content - a dsh `assistant/message` content block array.
 * @param streamed - what this step already put on the wire, as
 *   `{ streamedText, streamedThought }` (the adapter's per-step counters).
 * @returns the ordered `assistantContentChunks` runs the fallback should send.
 */
export function fallbackDelivery(content, streamed) {
  const owed = {
    thought: (streamed?.streamedThought ?? '').length === 0,
    text: (streamed?.streamedText ?? '').length === 0,
    image: true,
  }
  return assistantContentChunks(content).filter((chunk) => owed[chunk.kind] === true)
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
