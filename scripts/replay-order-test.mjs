#!/usr/bin/env node
/**
 * Unit tests for `assistantContentChunks` — the ordering contract shared by
 * history replay and the `assistant/message` fallback.
 *
 * Regression guard: a committed message carries its reasoning *before* the text
 * it produced (measured across the local archive: 2040/2040 messages that carry
 * both blocks order them reasoning-first), and the live seam streams them that
 * way. Emitting text first used to leave the thinking block below its reply and,
 * on the session's final message, parked a think block at the very end of the
 * thread. No network, no dsh — runs anywhere `node` exists.
 */
import { assistantContentChunks } from '../lib/codec.js'

let failed = 0
function check(label, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failed += 1
}

const kinds = (content) => assistantContentChunks(content).map((chunk) => `${chunk.kind}:${chunk.text}`)

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

check('image blocks become text-kind placeholders in place',
  JSON.stringify(kinds([
    { type: 'text', text: 'before' },
    { type: 'image', attachment: { attachmentId: 'sha256:abc' } },
    { type: 'text', text: 'after' },
  ])) === JSON.stringify(['text:before\n[image attachment sha256:abc]\nafter']))

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

console.log(failed === 0 ? 'ALL CHECKS PASSED' : `${failed} CHECK(S) FAILED`)
process.exit(failed === 0 ? 0 : 1)
