#!/usr/bin/env node
/**
 * Unit tests for the session-log folds in lib/codec.js: runningPresetFrom /
 * isBlankFrom. These folds are consumed from BOTH the live session log and the
 * stored (resume-time) log, so they take a plain events array — this test
 * pins that contract (the pre-0.9.0 shape mismatch between the two callers
 * silently broke preset restoration on resume). No network, no dsh.
 */
import {
  isBlankFrom,
  runningPresetFrom,
} from '../lib/codec.js'

let failed = 0
function check(label, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failed += 1
}

// ── runningPresetFrom: last selection wins, header is the fallback ─────────

check('no events, no header preset → undefined',
  runningPresetFrom([], {}) === undefined)
check('header preset survives an empty log',
  runningPresetFrom([], { agentPreset: 'code' }) === 'code')
check('a selection event overrides the header',
  runningPresetFrom(
    [{ type: 'agent-preset/selected', data: { agentPreset: 'minimal' } }],
    { agentPreset: 'code' },
  ) === 'minimal')
check('the LAST selection wins',
  runningPresetFrom([
    { type: 'agent-preset/selected', data: { agentPreset: 'minimal' } },
    { type: 'turn/start', data: {} },
    { type: 'agent-preset/selected', data: { agentPreset: 'cordis' } },
  ], { agentPreset: 'code' }) === 'cordis')
check('unrelated events do not disturb the fold',
  runningPresetFrom([
    { type: 'user/message', data: {} },
    { type: 'agent-preset/selected', data: { agentPreset: 'standard' } },
    { type: 'tool/call', data: {} },
  ], {}) === 'standard')

// ── isBlankFrom: blank ⇔ no turn and no user message ───────────────────────

check('empty log is blank', isBlankFrom([]) === true)
check('a turn/start makes it non-blank', isBlankFrom([{ type: 'turn/start', data: {} }]) === false)
check('a user/message makes it non-blank', isBlankFrom([{ type: 'user/message', data: {} }]) === false)
check('title-only log stays blank',
  isBlankFrom([{ type: 'session/title', data: { title: 'x' } }]) === true)
check('a stored log without turn/start still counts (user message only)',
  isBlankFrom([
    { type: 'session/title', data: { title: 'x' } },
    { type: 'user/message', data: {} },
  ]) === false)

console.log(failed === 0 ? 'ALL CHECKS PASSED' : `${failed} CHECK(S) FAILED`)
process.exit(failed === 0 ? 0 : 1)
