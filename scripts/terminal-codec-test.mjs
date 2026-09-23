#!/usr/bin/env node
/**
 * Unit tests for the terminal-card codec: toolKindFor / isTerminalToolName /
 * stripShellPrefix / resultText / parseShellExitStatus / shellCallCwd. No
 * network, no dsh — runs anywhere `node` exists.
 */
import {
  isTerminalToolName,
  nameHasKeyword,
  parseShellExitStatus,
  resultText,
  shellCallCwd,
  stripShellPrefix,
  terminalCommandLine,
  toolKindFor,
} from '../lib/terminal-codec.js'

let failed = 0
function check(label, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failed += 1
}

function textEvent(text, error = undefined) {
  return {
    data: {
      error,
      message: { content: [{ type: 'text', content: [{ type: 'text', text }] }] },
    },
  }
}

// ── toolKindFor: bash/pwsh are terminals, the rest keeps its old mapping ───

check('toolKindFor(bash) → execute', toolKindFor('bash') === 'execute')
check('toolKindFor(pwsh) → execute', toolKindFor('pwsh') === 'execute')
check('toolKindFor(zed_terminal) → execute', toolKindFor('zed_terminal') === 'execute')
check('toolKindFor(read_text_file) → read', toolKindFor('read_text_file') === 'read')
check('toolKindFor(read) → read (bare dsh read tool)', toolKindFor('read') === 'read')
check('toolKindFor(already) → other (substring alone does not match)', toolKindFor('already') === 'other')
check('toolKindFor(grep) → search', toolKindFor('grep') === 'search')
check('toolKindFor(fetch_url) → fetch', toolKindFor('fetch_url') === 'fetch')
check('toolKindFor(think) → think', toolKindFor('think') === 'think')
check('toolKindFor(str_replace_editor) → edit', toolKindFor('str_replace_editor') === 'edit')
check('toolKindFor(run_code) → other', toolKindFor('run_code') === 'other')
// Whole-segment classification: a keyword buried inside another word is not a
// class signal (these were the substring false positives).
check('toolKindFor(locate) → other (cat is not a segment)', toolKindFor('locate') === 'other')
check('toolKindFor(concat) → other (cat is not a segment)', toolKindFor('concat') === 'other')
check('toolKindFor(showcase) → other (show is not a segment)', toolKindFor('showcase') === 'other')
check('toolKindFor(dispatch) → other (patch is not a segment)', toolKindFor('dispatch') === 'other')
check('toolKindFor(fs_write_readonly_x) → edit, not read',
  toolKindFor('fs_write_readonly_x') === 'edit')
check('toolKindFor(content_search) → search (multi-segment keyword)',
  toolKindFor('content_search') === 'search')
check('toolKindFor(mcp__fs__read_file) → read (provider-mangled name)',
  toolKindFor('mcp__fs__read_file') === 'read')

// ── nameHasKeyword: segment boundaries and multi-segment keywords ──────────

check('nameHasKeyword(read) on read → true', nameHasKeyword('read', ['read']) === true)
check('nameHasKeyword(read) on already → false', nameHasKeyword('already', ['read']) === false)
check('nameHasKeyword(read) on read_text_file → true', nameHasKeyword('read_text_file', ['read']) === true)
check('nameHasKeyword(run_code) on run_code → true', nameHasKeyword('run_code', ['run_code']) === true)
check('nameHasKeyword(run_code) on runner_codebase → false',
  nameHasKeyword('runner_codebase', ['run_code']) === false)
check('nameHasKeyword is camelCase-aware (readTextFile)', nameHasKeyword('readTextFile', ['read']) === true)

// ── isTerminalToolName: only the dsh-side shell executors ──────────────────

check('isTerminalToolName(bash) → true', isTerminalToolName('bash') === true)
check('isTerminalToolName(pwsh) → true', isTerminalToolName('pwsh') === true)
check('isTerminalToolName(zed_terminal) → false (client-side tool)',
  isTerminalToolName('zed_terminal') === false)
check('isTerminalToolName(run_code) → false', isTerminalToolName('run_code') === false)

// ── stripShellPrefix: unwrap the evaluator, keep the real command ──────────

check('stripShellPrefix("bash -lc \\"ls -la\\"") → "ls -la"',
  stripShellPrefix('bash -lc "ls -la"') === 'ls -la')
check("stripShellPrefix(\"bash -lc 'echo hi'\") → 'echo hi'",
  stripShellPrefix("bash -lc 'echo hi'") === 'echo hi')
check('stripShellPrefix("/bin/bash -c echo x") → "echo x"',
  stripShellPrefix('/bin/bash -c echo x') === 'echo x')
check('stripShellPrefix("zsh -l pwd") → "pwd"', stripShellPrefix('zsh -l pwd') === 'pwd')
check('stripShellPrefix("sh -c make") → "make"', stripShellPrefix('sh -c make') === 'make')
check('stripShellPrefix("git status") → "git status" (no shell prefix)',
  stripShellPrefix('git status') === 'git status')
check('stripShellPrefix(undefined) → ""', stripShellPrefix(undefined) === '')

// ── resultText: full text, undefined on error ──────────────────────────────

{
  const event = textEvent('line1\nline2')
  check('resultText joins text blocks', resultText(event) === 'line1\nline2')
}
check('resultText(error event) → undefined', resultText(textEvent('x', { code: 'E' })) === undefined)
{
  const event = { data: { message: { content: [] } } }
  check('resultText(empty message) → ""', resultText(event) === '')
}

// ── parseShellExitStatus: inverse of the dsh shell markers ─────────────────

{
  const parsed = parseShellExitStatus('hello\n[exit code: 3]')
  check('exit-code marker stripped', parsed.body === 'hello' && parsed.exitCode === 3 && parsed.signal === null,
    JSON.stringify(parsed))
}
{
  const parsed = parseShellExitStatus('out\n[killed by signal: SIGTERM]')
  check('signal marker yields exit 0 + signal', parsed.body === 'out' && parsed.exitCode === 0 && parsed.signal === 'SIGTERM',
    JSON.stringify(parsed))
}
{
  const parsed = parseShellExitStatus('clean output')
  check('no marker → exit 0', parsed.body === 'clean output' && parsed.exitCode === 0 && parsed.signal === null,
    JSON.stringify(parsed))
}
{
  // A marker in the middle is OUTPUT, not an exit pill.
  const parsed = parseShellExitStatus('line\n[exit code: 9]\ntail')
  check('marker mid-body is kept', parsed.body === 'line\n[exit code: 9]\ntail' && parsed.exitCode === 0,
    JSON.stringify(parsed))
}

// ── terminalCommandLine: the card title for an editor-run command ──────────
// `zed_terminal` takes a program plus argv, so `command` alone titles the card
// "bash"; the payload of a `-c`-style invocation is the real command.

check('a shell payload wins over its evaluator',
  terminalCommandLine({ command: 'bash', args: ['-lc', 'pwd && ls'] }) === 'pwd && ls')
check('-c is recognised too',
  terminalCommandLine({ command: '/bin/sh', args: ['-c', 'echo hi'] }) === 'echo hi')
check('a program with argv joins into one line',
  terminalCommandLine({ command: 'node', args: ['-e', 'console.log(1)'] }) === 'node -e console.log(1)')
check('a whole command line stays itself',
  terminalCommandLine({ command: 'pwd && ls', description: 'Inspect' }) === 'pwd && ls')
check('no command yields undefined',
  terminalCommandLine({ cwd: '/tmp' }) === undefined && terminalCommandLine(undefined) === undefined)

// ── shellCallCwd: absolute wins, relative resolves, fallback to header ─────

const session = { header: { cwd: '/work/proj' } }
check('absolute workdir stays absolute', shellCallCwd({ workdir: '/tmp/x' }, session) === '/tmp/x')
check('relative workdir resolves against header cwd',
  shellCallCwd({ workdir: 'sub' }, session) === '/work/proj/sub')
check('absent workdir falls back to header cwd', shellCallCwd({}, session) === '/work/proj')
check('absent session falls back to process.cwd()', shellCallCwd({}, undefined) === process.cwd())

console.log(failed === 0 ? 'ALL CHECKS PASSED' : `${failed} CHECK(S) FAILED`)
process.exit(failed === 0 ? 0 : 1)