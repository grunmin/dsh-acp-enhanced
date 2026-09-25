#!/usr/bin/env node
/**
 * Unit tests for the `tool/result` shape folds in lib/codec.js:
 * toolResultCallId / toolResultText.
 *
 * Both folds exist because `ToolResultMessage` moved across the supported dsh
 * lines: 0.1.7 carries the call id on the message and its text blocks flat,
 * while 0.1.5 nests both under the first `tool-result` content block. Reading
 * only one shape sent a `tool_call_update` with no `toolCallId` (the editor
 * could not match it, so the card stuck at "running") and an empty body (no
 * output). These folds take the raw event data / content array, which is the
 * shared contract for the live and replayed reads. No network, no dsh.
 */
import { toolResultCallId, toolResultText } from '../lib/codec.js'

let failed = 0
function check(label, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failed += 1
}

// ── toolResultCallId: every generation's location ──────────────────────────

// 0.1.7 live shape: message.toolCallId, flat text content, no root callId.
check('0.1.7 message-level toolCallId is read',
  toolResultCallId({
    message: { role: 'tool', toolCallId: 'call_07', content: [{ type: 'text', text: 'x' }] },
  }) === 'call_07')
// 0.1.5 live shape: no message-level id, id nested on the tool-result block.
check('0.1.5 nested block toolCallId is read',
  toolResultCallId({
    message: { content: [{ type: 'tool-result', toolCallId: 'call_05', content: [] }] },
  }) === 'call_05')
// Legacy fallback.
check('root-level callId is the last resort',
  toolResultCallId({ callId: 'call_root', message: { content: [] } }) === 'call_root')
check('message-level id wins over the nested one',
  toolResultCallId({
    message: {
      toolCallId: 'call_msg',
      content: [{ type: 'tool-result', toolCallId: 'call_blk', content: [] }],
    },
  }) === 'call_msg')
check('no id anywhere → undefined',
  toolResultCallId({ message: { content: [{ type: 'text', text: 'x' }] } }) === undefined)
check('empty data → undefined', toolResultCallId(undefined) === undefined)
check('empty message → undefined', toolResultCallId({ message: {} }) === undefined)

// ── toolResultText: flat and nested content, in order ──────────────────────

check('flat text blocks join with a newline (0.1.7)',
  toolResultText([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }]) === 'a\nb')
check('nested tool-result blocks join with a newline (0.1.5)',
  toolResultText([
    { type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'a' }] },
    { type: 'tool-result', toolCallId: 'c2', content: [{ type: 'text', text: 'b' }] },
  ]) === 'a\nb')
check('a mixed list keeps generation order',
  toolResultText([
    { type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'nested' }] },
    { type: 'text', text: 'flat' },
  ]) === 'nested\nflat')
check('non-text inner blocks are ignored',
  toolResultText([
    { type: 'tool-result', toolCallId: 'c1', content: [{ type: 'image', attachment: { attachmentId: 'x' } }] },
    { type: 'text', text: 'kept' },
  ]) === 'kept')
check('empty content → ""', toolResultText([]) === '' && toolResultText(undefined) === '')
check('a text block carrying no text is skipped, not repeated',
  toolResultText([{ type: 'text', content: [{ type: 'text', text: 'inner' }] }]) === 'inner')

console.log(failed === 0 ? 'ALL CHECKS PASSED' : `${failed} CHECK(S) FAILED`)
process.exit(failed === 0 ? 0 : 1)
