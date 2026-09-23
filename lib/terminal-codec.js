/**
 * Terminal-card wire helpers for the ACP bridge — the pure slice of the
 * codex-acp-style bash/pwsh presentation. Kept separate from `index.js` so the
 * parsing and mapping rules are unit-testable without a live profile (mirrors
 * `codec.js` for the image surface).
 *
 * @module dsh-acp-enhanced/terminal-codec
 */

import { isAbsolute, resolve } from 'node:path'

/**
 * Whether a tool name carries one of `keywords`, matched on whole name
 * segments (`_`/`-`/`.`-delimited, camelCase humps included) — never as a
 * bare substring. `locate` must not classify on `cat`, `dispatch` not on
 * `patch`, `showcase` not on `show`; multi-segment keywords (`run_code`)
 * match consecutive segments.
 */
export function nameHasKeyword(name, keywords) {
  const haystack = `_${String(name)
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')}_`
  return keywords.some((keyword) => haystack.includes(`_${keyword.toLowerCase()}_`))
}

/**
 * Map a dsh tool name to the ACP ToolKind used for icons and card UX.
 *
 * Kind and content must agree: Zed treats kind == 'execute' as a terminal tool
 * and kind == 'edit' as a diff tool, and for both it HIDES the rawInput
 * section. Genuine terminals (`zed_terminal`, plus the model-facing shell
 * executors `bash`/`pwsh`) map to 'execute': for bash/pwsh the bridge emits
 * the codex-acp terminal-card wire shape (terminal content + terminal_info /
 * terminal_output / terminal_exit meta), so the command and output render in a
 * terminal panel instead of a raw-JSON card. Write/edit tools map to 'edit'
 * only because the bridge always pairs them with a `diff` content block — the
 * diff replaces the raw dump as the card body. Remaining local executors like
 * run_code stay 'other' and carry the command as a markdown code block,
 * keeping the raw sections available too.
 *
 * Read tools map to 'read' so the bridge can pair the kind with ACP
 * `locations` (the clickable file chips via `toolCallLocationsFor`).
 * Classification is whole-segment (see `nameHasKeyword`), so keyword aliases
 * (`editor` alongside `edit`, `thinking` alongside `think`) are spelled out
 * instead of relying on substring accidents.
 */
export function toolKindFor(name) {
  if (name === 'bash' || name === 'pwsh' || name === 'zed_terminal') return 'execute'
  if (nameHasKeyword(name, ['read', 'cat', 'show', 'view'])) return 'read'
  if (nameHasKeyword(name, ['search', 'find', 'grep', 'glob', 'rg'])) return 'search'
  if (nameHasKeyword(name, ['fetch', 'http'])) return 'fetch'
  if (nameHasKeyword(name, ['think', 'thinking'])) return 'think'
  if (nameHasKeyword(name, ['write', 'edit', 'editor', 'patch', 'apply', 'replace'])) return 'edit'
  return 'other'
}

/** Whether a tool's result is presented through the Zed terminal panel. Only
 *  the model-facing shell executors are terminal-presented; `zed_terminal`
 *  runs client-side and its result comes from the client, not from dsh. */
export function isTerminalToolName(name) {
  return name === 'bash' || name === 'pwsh'
}

/** Strip a `bash -lc`-style shell prefix from a command line, codex-acp style.
 *  Handles both single- and double-quoted payloads so the terminal card title
 *  shows the command itself, not the wrapping evaluator. */
export function stripShellPrefix(command) {
  const withoutShell = String(command ?? '').replace(/^(?:\/bin\/)?(?:bash|zsh|sh)\s+(?:-[lc]+\s+)?/, '')
  const wrapped = withoutShell
  if (wrapped.length >= 2
    && ((wrapped.startsWith("'") && wrapped.endsWith("'"))
      || (wrapped.startsWith('"') && wrapped.endsWith('"')))) {
    return wrapped.slice(1, -1)
  }
  return withoutShell
}

/**
 * The command line an editor-terminal call runs, from its parsed arguments.
 *
 * `zed_terminal` takes a program plus argv — the model writes
 * `{command: 'bash', args: ['-lc', '<line>'], cwd}` — so `command` alone names
 * the *evaluator*, and a card titled from it reads "bash" with nothing else.
 * This returns what the card owes the reader: the payload of a `-c`-style
 * invocation when there is one, otherwise the program and its arguments joined.
 *
 * @param value - a call's parsed arguments (non-objects yield `undefined`).
 * @returns the command line, or `undefined` when the call carries none.
 */
export function terminalCommandLine(value) {
  const obj = value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {}
  const program = typeof obj.command === 'string' && obj.command.trim() !== '' ? obj.command.trim() : undefined
  const argv = Array.isArray(obj.args) ? obj.args.filter((part) => typeof part === 'string') : []
  // `bash -lc '<line>'` (or `-c`) wraps the real command in an evaluator flag;
  // trailing argv after the payload are positional parameters, not the command.
  if (argv.length >= 2 && /^-[lc]+$/.test(argv[0])) return argv[1]
  if (argv.length > 0) return [program, ...argv].filter((part) => part !== undefined).join(' ')
  return program
}

/** Full text of a dsh tool result, or `undefined` when the tool failed. */
export function resultText(event) {
  if (event.data.error !== undefined) return undefined
  const parts = []
  for (const block of event.data.message?.content ?? []) {
    for (const inner of block?.content ?? []) {
      if (inner?.type === 'text' && typeof inner.text === 'string') parts.push(inner.text)
    }
  }
  return parts.join('\n')
}

/**
 * Recover the terminal exit pill from a rendered shell-tool result — the
 * inverse of the `[exit code: N]` / `[killed by signal: X]` markers the shell
 * tools append (guaranteed to be the last line, prefixed with a newline).
 * Returns the marker-free body plus exit code/signal; a body without a marker
 * is a clean exit with code 0.
 */
export function parseShellExitStatus(text) {
  const signal = /\n\[killed by signal: ([^\]\n]+)\]$/.exec(text)
  if (signal?.[1] !== undefined) {
    return { body: text.slice(0, signal.index), exitCode: 0, signal: signal[1] }
  }
  const exit = /\n\[exit code: (\d+)\]$/.exec(text)
  if (exit?.[1] !== undefined) {
    return { body: text.slice(0, exit.index), exitCode: Number(exit[1]), signal: null }
  }
  return { body: text, exitCode: 0, signal: null }
}

/** Resolve the cwd a bash/pwsh call runs in, for the terminal_info card. */
export function shellCallCwd(args, session) {
  const headerCwd = session?.header?.cwd
  if (typeof args === 'object' && args !== null && typeof args.workdir === 'string' && args.workdir.length > 0) {
    return isAbsolute(args.workdir) ? args.workdir : headerCwd === undefined ? args.workdir : resolve(headerCwd, args.workdir)
  }
  return headerCwd ?? process.cwd()
}