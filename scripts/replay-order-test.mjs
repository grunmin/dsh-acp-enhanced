#!/usr/bin/env node
/**
 * Unit tests for the committed-message delivery contract shared by history
 * replay and the `assistant/message` fallback: `assistantContentChunks` (order)
 * and `fallbackDelivery` (what the fallback still owes the client).
 *
 * Regression guard: a committed message carries its reasoning *before* the text
 * it produced (measured across the local archive: 2040/2040 messages that carry
 * both blocks order them reasoning-first), and the live seam streams them that
 * way. Emitting text first used to leave the thinking block below its reply and,
 * on the session's final message, parked a think block at the very end of the
 * thread. The fallback used to re-render an image placeholder that the message
 * handler had already sent. No network, no dsh — runs anywhere `node` exists.
 */
import { assistantContentChunks, fallbackDelivery } from '../lib/codec.js'

let failed = 0
function check(label, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failed += 1
}

const kinds = (content) => assistantContentChunks(content).map((chunk) => `${chunk.kind}:${chunk.text}`)
const owed = (content, streamed = {}) => fallbackDelivery(content, streamed).map((chunk) => `${chunk.kind}:${chunk.text}`)

// ── the regression: reasoning must precede the reply it belongs to ─────────

check('reasoning boots before the reply it produced',
  JSON.stringify(kinds([
    { type: 'reasoning', text: 'think' },
    { type: 'text', text: 'reply' },
  ])) === JSON.stringify(['thought:think', 'text:reply']),
  JSON.stringify(kinds([
    { type: 'reasoning', text: 'think' },
    { type: 'text', text: 'reply' },
  ])))

check('the reply is the last chunk of a reasoning→text message (nothing lands after it)',
  assistantContentChunks([
    { type: 'reasoning', text: 'think' },
    { type: 'text', text: 'reply' },
  ]).at(-1)?.kind === 'text')

// ── single-kind messages keep their shape ─────────────────────────────────

check('text-only message yields one text chunk',
  JSON.stringify(kinds([{ type: 'text', text: 'hello' }])) === JSON.stringify(['text:hello']))
check('reasoning-only message yields one thought chunk',
  JSON.stringify(kinds([{ type: 'reasoning', text: 'quiet' }])) === JSON.stringify(['thought:quiet']))

// ── order is preserved, not just kind-grouped ─────────────────────────────

check('interleaved text→reasoning→text keeps block order',
  JSON.stringify(kinds([
    { type: 'text', text: 'a' },
    { type: 'reasoning', text: 'b' },
    { type: 'text', text: 'c' },
  ])) === JSON.stringify(['text:a', 'thought:b', 'text:c']))

check('a tool-call block between reasoning and text is skipped without reordering',
  JSON.stringify(kinds([
    { type: 'reasoning', text: 'why' },
    { type: 'tool-call', toolCallId: 't1' },
    { type: 'text', text: 'done' },
  ])) === JSON.stringify(['thought:why', 'text:done']))

// ── coalescing + text-kind images + blanks ────────────────────────────────

check('consecutive same-kind blocks coalesce into one chunk',
  JSON.stringify(kinds([
    { type: 'reasoning', text: 'part 1' },
    { type: 'reasoning', text: 'part 2' },
    { type: 'text', text: 'line 1' },
    { type: 'text', text: 'line 2' },
  ])) === JSON.stringify(['thought:part 1\npart 2', 'text:line 1\nline 2']))

check('image blocks keep their own run, in place',
  JSON.stringify(kinds([
    { type: 'text', text: 'before' },
    { type: 'image', attachment: { attachmentId: 'sha256:abc' } },
    { type: 'text', text: 'after' },
  ])) === JSON.stringify(['text:before', 'image:[image attachment sha256:abc]', 'text:after']))

check('reasoning before an image stays ahead of it (the fallback delivery order)',
  JSON.stringify(kinds([
    { type: 'reasoning', text: 'why' },
    { type: 'image', attachment: { attachmentId: 'sha256:abc' } },
  ])) === JSON.stringify(['thought:why', 'image:[image attachment sha256:abc]']))

check('consecutive images coalesce into one image run',
  JSON.stringify(kinds([
    { type: 'image', attachment: { attachmentId: 'sha256:a' } },
    { type: 'image', attachment: { attachmentId: 'sha256:b' } },
  ])) === JSON.stringify(['image:[image attachment sha256:a]\n[image attachment sha256:b]']))

// The fallback decides delivery per kind, once, from these runs: `image` is
// always deliverable (it never streams), so a host that streamed the text
// around an image still gets the image — and only once.
check('an image between streamed text runs is still its own deliverable run',
  assistantContentChunks([
    { type: 'text', text: 'before' },
    { type: 'image', attachment: { attachmentId: 'sha256:abc' } },
    { type: 'text', text: 'after' },
  ]).filter((chunk) => chunk.kind === 'image').length === 1)

check('an image with no attachment id is not a wire chunk',
  JSON.stringify(kinds([{ type: 'image' }, { type: 'text', text: 'x' }])) === JSON.stringify(['text:x']))

check('blank runs are dropped',
  JSON.stringify(kinds([
    { type: 'reasoning', text: '   \n ' },
    { type: 'text', text: 'real' },
  ])) === JSON.stringify(['text:real']))

check('a tool-call-only message yields no chunks',
  assistantContentChunks([{ type: 'tool-call', toolCallId: 't1' }]).length === 0)
check('empty and undefined content yield no chunks',
  assistantContentChunks([]).length === 0 && assistantContentChunks(undefined).length === 0)

// ── fallback delivery: what a host that streamed nothing is still owed ────
// The regression this guards: the `assistant/message` handler used to send the
// image placeholder itself and then `emitMessageFallback` sent the same string
// again, so an image-only reply reached the editor twice.

const reasoningThenReply = [
  { type: 'reasoning', text: 'why' },
  { type: 'text', text: 'answer' },
]

check('a host that streamed nothing is owed the whole message, in order',
  JSON.stringify(owed(reasoningThenReply)) === JSON.stringify(['thought:why', 'text:answer']))

check('a host that streamed the text is owed only the reasoning',
  JSON.stringify(owed(reasoningThenReply, { streamedText: 'answer' })) === JSON.stringify(['thought:why']))

check('a host that streamed both is owed nothing',
  owed(reasoningThenReply, { streamedText: 'answer', streamedThought: 'why' }).length === 0)

check('every text run of an unstreamed interleaved message is owed (not just the first)',
  JSON.stringify(owed([
    { type: 'text', text: 'a' },
    { type: 'reasoning', text: 'b' },
    { type: 'text', text: 'c' },
  ])) === JSON.stringify(['text:a', 'thought:b', 'text:c']))

check('an image-only message is owed exactly one placeholder',
  JSON.stringify(owed([{ type: 'image', attachment: { attachmentId: 'sha256:abc' } }]))
    === JSON.stringify(['image:[image attachment sha256:abc]']))

check('an image is still owed when the host streamed the text around it',
  JSON.stringify(owed([
    { type: 'text', text: 'before' },
    { type: 'image', attachment: { attachmentId: 'sha256:abc' } },
    { type: 'text', text: 'after' },
  ], { streamedText: 'beforeafter' })) === JSON.stringify(['image:[image attachment sha256:abc]']))

check('image placeholders are never owed twice for one message',
  JSON.stringify(owed([
    { type: 'image', attachment: { attachmentId: 'sha256:abc' } },
    { type: 'image', attachment: { attachmentId: 'sha256:def' } },
  ])) === JSON.stringify(['image:[image attachment sha256:abc]\n[image attachment sha256:def]']))

check('a host that streamed the text is not owed a second copy of it',
  owed([{ type: 'text', text: 'reply' }], { streamedText: 'reply' }).length === 0)

console.log(failed === 0 ? 'ALL CHECKS PASSED' : `${failed} CHECK(S) FAILED`)
process.exit(failed === 0 ? 0 : 1)
