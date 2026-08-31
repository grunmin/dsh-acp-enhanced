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
 * `locations` (the clickable file chips via `toolCallLocationsFor`): the bare
 * dsh tool name is exactly `read`, so it must match by itself — `read_text`
 * and `fs_*read` only cover the long-form names.
 */
export function toolKindFor(name) {
  if (name === 'bash' || name === 'pwsh' || name === 'zed_terminal') return 'execute'
  if (/^fs_.*read|^read$|read_text|cat|show/.test(name)) return 'read'
  if (/search|find|grep/.test(name)) return 'search'
  if (/fetch|http/.test(name)) return 'fetch'
  if (/think/.test(name)) return 'think'
  if (/write|edit|patch|apply/.test(name)) return 'edit'
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