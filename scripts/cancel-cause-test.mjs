#!/usr/bin/env node
/**
 * Contract test for the cancel causes this bridge hands the harness.
 *
 * `agent.cancel(cause)` takes a closed union — `AgentCancelCause` is exactly
 * `{kind:'user'} | {kind:'parent'} | {kind:'disposed'} | {kind:'hook'}` (see
 * `abortedCancelCause` in @deepseek-ai/dsh-agent-loop: every other value lands
 * on `assertNever`). The bridge once passed `new Error('cancelled by user')` to
 * get a readable interrupted-tool result, which made that `assertNever` throw
 * while `turn()` closed the turn: the durable `turn/end` then carried
 * `reason: null`, a downstream session projection threw on `reason.kind`, and
 * the session failed every later prompt, config switch and `session/load`.
 *
 * The violation is invisible offline (it needs a live aborted turn), so this
 * guard reads the shipped source and holds the two decisions that matter:
 * every cancel call passes a union member, and the scanner really saw the
 * calls it claims to check. No network, no dsh.
 */
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const FILES = ['lib/index.js', 'lib/codec.js', 'lib/terminal-codec.js', 'lib/stored-titles.js']

let failed = 0
function check(label, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failed += 1
}

/** Blank comment bodies while keeping every byte offset (and line) in place. */
function blankComments(source) {
  const chars = source.split('')
  const blank = (from, to) => {
    for (let i = from; i < to && i < chars.length; i += 1) {
      if (chars[i] !== '\n') chars[i] = ' '
    }
  }
  let i = 0
  while (i < source.length) {
    const ch = source[i]
    if (ch === '/' && source[i + 1] === '/') {
      const end = source.indexOf('\n', i)
      blank(i, end === -1 ? source.length : end)
      i = end === -1 ? source.length : end
      continue
    }
    if (ch === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2)
      const stop = end === -1 ? source.length : end + 2
      blank(i, stop)
      i = stop
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      i += 1
      while (i < source.length && source[i] !== ch) i += source[i] === '\\' ? 2 : 1
      i += 1
      continue
    }
    i += 1
  }
  return chars.join('')
}

/** Every `.cancel(` call with its balanced argument text, in source order. */
function cancelCalls(source) {
  const calls = []
  const needle = '.cancel('
  for (let at = source.indexOf(needle); at !== -1; at = source.indexOf(needle, at + needle.length)) {
    let depth = 1
    let i = at + needle.length
    while (i < source.length && depth > 0) {
      const ch = source[i]
      if (ch === "'" || ch === '"' || ch === '`') {
        const quote = ch
        i += 1
        while (i < source.length && source[i] !== quote) i += source[i] === '\\' ? 2 : 1
      } else if (ch === '(') depth += 1
      else if (ch === ')') depth -= 1
      i += 1
    }
    calls.push({ argument: source.slice(at + needle.length, i - 1), line: source.slice(0, at).split('\n').length })
  }
  return calls
}

const LEGAL_CAUSE = /^\{\s*kind:\s*'(user|parent|disposed|hook)'\s*\}$/
const calls = FILES.flatMap((file) => cancelCalls(blankComments(readFileSync(join(repoDir, file), 'utf8')))
  .map((call) => ({ ...call, file })))

// The scanner is the test: a guard that silently finds nothing passes forever,
// so pin the call sites it is responsible for and fail when one appears or goes.
check('the scanner sees every cancel call it guards', calls.length === 2,
  calls.map((c) => `${c.file}:${c.line}`).join(', ') || 'none')

for (const call of calls) {
  const argument = call.argument.trim()
  check(`${call.file}:${call.line} cancels with a legal AgentCancelCause`,
    LEGAL_CAUSE.test(argument),
    // Name the failure mode: an Error cause is what bricked sessions, and a
    // no-argument cancel is the AbortController shape this union has no arm for.
    argument === '' ? 'no argument' : argument.split('\n')[0].slice(0, 80))
}

console.log(failed === 0 ? 'ALL CHECKS PASSED' : `${failed} CHECK(S) FAILED`)
process.exit(failed === 0 ? 0 : 1)
