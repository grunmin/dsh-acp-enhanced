#!/usr/bin/env node
/**
 * Unit tests for the session-log `request/context` fold in lib/codec.js:
 * contextWindowFrom.
 *
 * This fold is the fix for the pinned context ring: the harness appends
 * `request/context` only when the route or capacity changes, so a resumed
 * session's capacity must be recovered from its committed log — the live
 * `session/event` listener alone never sees it again. The fold takes a plain
 * events array, which is the shared contract between the live and stored reads.
 * No network, no dsh.
 */
import { contextWindowFrom } from '../lib/codec.js'

let failed = 0
function check(label, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failed += 1
}

// ── the plain case ─────────────────────────────────────────────────────────

check('no events → undefined', contextWindowFrom([]) === undefined)
check('no request/context → undefined',
  contextWindowFrom([
    { type: 'turn/start', data: {} },
    { type: 'assistant/message', data: {} },
  ]) === undefined)
check('a lone request/context is read',
  contextWindowFrom([{ type: 'request/context', data: { provider: 'p', model: 'm', contextWindow: 1048576 } }]) === 1048576)

// ── the resumed-log shape (this is the regression) ──────────────────────────
// A stored log ends with turns consumed long after the request/context row;
// the fold must still find it, exactly like the harness's own requestContext().
check('capacity survives later unrelated events (resumed-log shape)',
  contextWindowFrom([
    { type: 'turn/start', data: {} },
    { type: 'request/header', data: {} },
    { type: 'request/context', data: { provider: 'p', model: 'm', contextWindow: 1000000 } },
    { type: 'assistant/message', data: {} },
    { type: 'turn/end', data: {} },
    { type: 'turn/start', data: {} },
    { type: 'assistant/message', data: {} },
  ]) === 1000000)

// ── the latest event is authoritative ──────────────────────────────────────
check('the LAST request/context wins (route switch)',
  contextWindowFrom([
    { type: 'request/context', data: { provider: 'p', model: 'm', contextWindow: 1000000 } },
    { type: 'request/context', data: { provider: 'p', model: 'n', contextWindow: 480000 } },
  ]) === 480000)
check('a later route that declares no capacity does NOT inherit the old window',
  contextWindowFrom([
    { type: 'request/context', data: { provider: 'p', model: 'm', contextWindow: 1000000 } },
    { type: 'request/context', data: { provider: 'q', model: 'n' } },
  ]) === undefined)

// ── invalid capacities are never reported as a window ──────────────────────
for (const bad of [0, -1, 1.5, '1048576', null, undefined, Number.NaN]) {
  check(`non-positive/non-integer contextWindow (${JSON.stringify(bad)}) → undefined`,
    contextWindowFrom([{ type: 'request/context', data: { contextWindow: bad } }]) === undefined)
}
check('missing data object → undefined',
  contextWindowFrom([{ type: 'request/context' }]) === undefined)

console.log(failed === 0 ? 'ALL CHECKS PASSED' : `${failed} CHECK(S) FAILED`)
process.exit(failed === 0 ? 0 : 1)
