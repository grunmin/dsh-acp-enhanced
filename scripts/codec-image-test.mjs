#!/usr/bin/env node
/**
 * Unit tests for the image capability codec: convertPrompt / attachmentIngestOf /
 * canonicalImageMediaType with a fake attachment store. No network, no dsh —
 * runs anywhere `node` exists.
 */
import assert from 'node:assert/strict'
import {
  attachmentIngestOf,
  canonicalImageMediaType,
  convertPrompt,
  PromptImageError,
  UnsupportedPromptContentError,
} from '../lib/codec.js'

let failed = 0
function check(label, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failed += 1
}

/** A real 1x1 red PNG (sharp-decodable). */
const ONE_PX_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

function fakeStore(overrides = {}) {
  const calls = { validate: [], save: [] }
  const store = {
    imageLimits: {
      maxImageBytes: 1024 * 1024,
      maxImagesPerMessage: 4,
      maxMessageImageBytes: 4 * 1024 * 1024,
      mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
    },
    async validateImage(input) {
      calls.validate.push(input)
    },
    async saveImage(input) {
      calls.save.push(input)
      return {
        attachmentId: `sha256:test-${calls.save.length}`,
        mediaType: input.mediaType,
        bytes: input.data.byteLength,
        width: 1,
        height: 1,
        ...input.name === undefined ? {} : { name: input.name },
      }
    },
    ...overrides,
  }
  return { store, calls }
}

// ── attachmentIngestOf ──────────────────────────────────────────────────────

check('attachmentIngestOf(undefined) → undefined', attachmentIngestOf(undefined) === undefined)
check('attachmentIngestOf(null) → undefined', attachmentIngestOf(null) === undefined)
check('attachmentIngestOf(empty object) → undefined', attachmentIngestOf({}) === undefined)
{
  const { store } = fakeStore()
  check('attachmentIngestOf(complete store) → store', attachmentIngestOf(store) === store)
  check('attachmentIngestOf(missing imageLimits) → undefined',
    attachmentIngestOf({ validateImage() {}, saveImage() {} }) === undefined)
  check('attachmentIngestOf(missing methods) → undefined',
    attachmentIngestOf({ imageLimits: { maxImageBytes: 1, maxImagesPerMessage: 1, maxMessageImageBytes: 1 } }) === undefined)
}

// ── canonicalImageMediaType ─────────────────────────────────────────────────

check('mediaType image/jpg → image/jpeg', canonicalImageMediaType('image/jpg') === 'image/jpeg')
check('mediaType image/png kept', canonicalImageMediaType('image/png') === 'image/png')
check('mediaType uppercase normalized', canonicalImageMediaType('IMAGE/PNG') === 'image/png')
check('mediaType image/svg+xml → undefined', canonicalImageMediaType('image/svg+xml') === undefined)
check('mediaType image/avif → undefined', canonicalImageMediaType('image/avif') === undefined)
check('mediaType garbage → undefined', canonicalImageMediaType('not-a-type') === undefined)
check('mediaType empty → undefined', canonicalImageMediaType(undefined) === undefined)

// ── convertPrompt: text / resource_link pass-through ────────────────────────

{
  const { store, calls } = fakeStore()
  const out = await convertPrompt([
    { type: 'text', text: 'hello' },
    { type: 'resource_link', name: 'a.txt', uri: 'file:///tmp/a.txt' },
    { type: 'text', text: ' world' },
  ], store)
  check('text+resource_link keeps blocks', out.blocks.length === 1 && out.blocks[0].type === 'text',
    JSON.stringify(out.blocks))
  check('displayText strips resource markup', out.displayText === 'hello @a.txt  world', out.displayText)
  check('no images stored', calls.save.length === 0)
}

// ── convertPrompt: image without an ingest is refused ──────────────────────

{
  let threw = null
  try {
    await convertPrompt([{ type: 'image', mimeType: 'image/png', data: ONE_PX_PNG }], undefined)
  } catch (error) {
    threw = error
  }
  check('image without ingest throws UnsupportedPromptContentError',
    threw instanceof UnsupportedPromptContentError, String(threw?.message))
}

{
  let threw = null
  try {
    await convertPrompt([
      { type: 'text', text: 'say hi' },
      { type: 'image', mimeType: 'image/png', data: ONE_PX_PNG },
    ], attachmentIngestOf({ validateImage() {}, saveImage() {} }) /* no limits → undefined */)
  } catch (error) {
    threw = error
  }
  check('image without a *working* ingest also refused',
    threw instanceof UnsupportedPromptContentError, String(threw?.message))
}

// ── convertPrompt: image accepted and stored, wire order preserved ─────────

{
  const { store, calls } = fakeStore()
  const out = await convertPrompt([
    { type: 'text', text: 'what is this? ' },
    { type: 'image', mimeType: 'image/png', data: ONE_PX_PNG, uri: 'https://example.com/pic.png' },
    { type: 'text', text: ' and that?' },
  ], store)
  check('blocks: text,image,text in wire order',
    JSON.stringify(out.blocks.map((b) => b.type)) === '["text","image","text"]',
    JSON.stringify(out.blocks.map((b) => b.type)))
  check('image block carries attachment ref', out.blocks[1].type === 'image'
    && typeof out.blocks[1].attachment?.attachmentId === 'string', JSON.stringify(out.blocks[1]))
  check('validateImage called once', calls.validate.length === 1)
  check('saveImage called once with decoded bytes', calls.save.length === 1
    && calls.save[0].data instanceof Uint8Array && calls.save[0].data.byteLength > 0)
  check('displayText keeps images inline', out.displayText.includes('[image: pic.png]'), out.displayText)
}

// ── convertPrompt: admission limits ────────────────────────────────────────

{
  const { store } = fakeStore({ imageLimits: { maxImageBytes: 10, maxImagesPerMessage: 1, maxMessageImageBytes: 1000 } })
  let threw = null
  try {
    await convertPrompt([{ type: 'image', mimeType: 'image/png', data: ONE_PX_PNG }], store)
  } catch (error) {
    threw = error
  }
  check('oversized image throws PromptImageError', threw instanceof PromptImageError
    && /encoded-byte limit/.test(threw.message), String(threw?.message))
}

{
  const { store } = fakeStore()
  let threw = null
  try {
    await convertPrompt([
      { type: 'text', text: 'describe ' },
      { type: 'image', mimeType: 'image/avif', data: ONE_PX_PNG },
    ], store)
  } catch (error) {
    threw = error
  }
  check('unsupported media type rejected (avif)', threw instanceof PromptImageError
    && /unsupported image media type/.test(threw.message), String(threw?.message))
}

{
  const { store } = fakeStore()
  let threw = null
  try {
    await convertPrompt([{ type: 'image', mimeType: 'image/png', data: '' }], store)
  } catch (error) {
    threw = error
  }
  check('empty image data rejected', threw instanceof PromptImageError && /empty/.test(threw.message),
    String(threw?.message))
}

// ── convertPrompt: store failure is wrapped, not leaked ────────────────────

{
  const { store } = fakeStore()
  store.saveImage = async () => { throw new Error('disk full') }
  let threw = null
  try {
    await convertPrompt([{ type: 'image', mimeType: 'image/png', data: ONE_PX_PNG }], store)
  } catch (error) {
    threw = error
  }
  check('store saveImage failure wrapped as PromptImageError', threw instanceof PromptImageError
    && /disk full/.test(threw.message), String(threw?.message))
}

console.log(failed === 0 ? 'ALL CHECKS PASSED' : `${failed} CHECK(S) FAILED`)
process.exit(failed === 0 ? 0 : 1)