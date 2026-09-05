/**
 * Enhanced Agent Client Protocol server for DeepSeek Harness.
 *
 * A drop-in improvement over the official `@deepseek-ai/dsh-acp` automation
 * bridge. It keeps the same session model (fresh agents per `session/new`,
 * prompt/cancel lifecycle, one-shot permission requests) and adds the surfaces
 * the Web GUI has but the official wire lacks:
 *
 * - **Block-level streaming**: `text` blocks are emitted as soon as each block
 *   commits (`block-end`), instead of waiting for the whole `assistant/message`.
 *   A retried/cancelled block is dropped before it commits, so the wire never
 *   carries torn text.
 * - **Usage telemetry**: every provider `usage` sample is broadcast as a
 *   standard `usage_update` (used = context pressure, size = model context
 *   window), with the full breakdown in `_meta`: input/output/cache/reasoning
 *   tokens, cache hit rate, tokens-per-second, step elapsed, turn count, and
 *   tool-call stats.
 * - **Tool visibility**: `tool_call` / `tool_call_update` notifications carry
 *   the tool name and per-call elapsed time.
 * - **Session configuration**: `session/set_config_option` switches model,
 *   reasoning effort, and permission preset; the option set is advertised on
 *   `session/new` and re-broadcast as `config_option_update` after changes.
 * - **Session modes**: permission presets are exposed as ACP modes
 *   (`session/set_mode`), so the client's mode UI drives the sandbox/approval
 *   preset of the session.
 * - **Multi-root workspaces**: `sessionCapabilities.additionalDirectories` is
 *   advertised, so Zed passes every workspace root on the session lifecycle
 *   requests instead of warning "this agent doesn't currently support
 *   multi-root workspaces". All roots are described to the model in the
 *   system prompt; the sandbox still enforces one writable root (the primary
 *   `cwd`) — writes under an additional root go through escalation.
 *
 * Stdout is reserved for ACP JSON-RPC; diagnostics go to stderr only.
 *
 * @module dsh-acp-enhanced
 */

import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { isAbsolute, dirname, join, resolve } from 'node:path'
import { Readable, Writable } from 'node:stream'
import Schema from '@deepseek-ai/schemastery'
import { AgentSideConnection, ndJsonStream, PROTOCOL_VERSION, RequestError } from '@agentclientprotocol/sdk'
import { createUserMessage, errorChain, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
// Version tolerance: every harness value this bridge imports is a pure helper
// (no service identity), so a copy resolved from this package's own
// node_modules is functionally equivalent to the host tree's even when the
// booting CLI pins a different generation. dsh-agent-presets is the one
// exception in kind, not in rule: 0.1.2-alpha.1 removed its named exports
// (resolveSessionPreset, UnknownPresetError, PresetMountError), so a named
// import would fail at ESM link time on that generation. It is imported as a
// namespace instead; nothing is taken from it at link time (see
// isPresetClientError, which uses the legacy classes only through guarded
// property access).
import * as agentPresetsModule from '@deepseek-ai/dsh-agent-presets'
import { renderSkillContent } from '@deepseek-ai/dsh-skill'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { SessionId } from '@deepseek-ai/dsh-session'
import { attachmentIngestOf, acpPromptCommandImages, acpPromptLineText, convertPrompt, PromptImageError, sanitizeWireTitle, turnEndToStopReason, UnsupportedPromptContentError, usageTelemetry } from './codec.js'
import { isTerminalToolName, parseShellExitStatus, resultText, shellCallCwd, stripShellPrefix, toolKindFor } from './terminal-codec.js'

/** Agent version advertised on the ACP wire — read from package.json so the
 *  handshake can never drift from the released package version. */
const AGENT_VERSION = createRequire(import.meta.url)('../package.json').version

/** State-kept per-model reasoning-effort memory (`provider/model` → effort
 *  id). A model switch carries the session's current effort onto the new
 *  model; when the target does not offer it, the effort this bridge last
 *  successfully applied to that route is restored instead — and switching
 *  back restores the effort that model had before, so the editor's dropdown
 *  never falls back to an empty ("unknown") selection. Persisted as a small
 *  JSON file next to the profile (the shipped Zed launcher exports
 *  DSH_ACP_PROFILE_DIR); without that variable the memory simply lives for
 *  the process. */
const effortMemoryFile = process.env.DSH_ACP_PROFILE_DIR !== undefined && process.env.DSH_ACP_PROFILE_DIR.length > 0
  ? join(process.env.DSH_ACP_PROFILE_DIR, 'dsh-acp-enhanced-effort-memory.json')
  : undefined

function loadEffortMemory() {
  if (effortMemoryFile === undefined) return {}
  try {
    const parsed = JSON.parse(readFileSync(effortMemoryFile, 'utf8'))
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      console.warn(`acp-enhanced: effort memory unreadable (${effortMemoryFile}): ${String(error)}`)
    }
  }
  return {}
}

const effortMemory = loadEffortMemory()

function writeEffortMemory() {
  if (effortMemoryFile === undefined) return
  writeFile(effortMemoryFile, JSON.stringify(effortMemory, null, 2)).catch((error) => {
    console.warn(`acp-enhanced: effort memory write failed (${effortMemoryFile}): ${String(error)}`)
  })
}

/** The effort last successfully applied to a route, when one was recorded. */
function rememberedEffort(provider, model) {
  const effort = effortMemory[`${provider}/${model}`]
  return typeof effort === 'string' && effort.length > 0 ? effort : undefined
}

/** Record the effort applied to a route, persisting when possible. */
function rememberEffort(provider, model, effort) {
  const key = `${provider}/${model}`
  if (effortMemory[key] === effort) return
  effortMemory[key] = effort
  writeEffortMemory()
}

/** Coalescing window for `streamDeltas` flushes. 75ms ≈ 13 wire updates/s —
 *  smooth enough to read as live typing in the editor, few enough not to flood
 *  the ACP wire on fast models. */
const DELTA_FLUSH_MS = 75

/** Wire text inserted between an abandoned (retried mid-block) attempt and the
 *  retried one when `streamDeltas` already forwarded the partial text. ACP has
 *  no message-truncation update, so the seam must be visible rather than
 *  repaired. */
const RETRY_MARKER = '\n\n_[stream interrupted — retrying]_\n\n'

export const name = 'acp-enhanced'
/** The bridge creates and owns agents; every other concern is carried by the composition. */
export const inject = ['agents', 'llm', 'approval', 'tools', 'commands', 'skills', 'systemPrompt']

export const Config = Schema.object({
  /** Initial provider route for every created agent. */
  provider: Schema.string(),
  /** Initial model for every created agent. */
  model: Schema.string(),
  /** When false (default), the model dropdown advertises only the configured
   *  provider's models. On a single-provider machine (chat routed through a
   *  company gateway, or through a single official key) this hides "phantom"
   *  providers — mountable-but-unroutable adapters whose models look switchable
   *  but fail to dispatch with a MISSING_CREDENTIAL error. Set true to list
   *  every served provider's models regardless. */
  includeAllProviders: Schema.boolean().default(false),
  /** Initial agent preset every created agent is composed from, when an
   *  `agent-presets` roster is mounted. Absent adopts the roster's own
   *  default. The `DSH_ACP_PRESET` environment variable overrides this value
   *  when set. */
  preset: Schema.string().default(undefined),
  /** Optional JSONL trace of session events with wall-clock timestamps and
   *  tool call durations. After a stalled turn, the log discriminates a hung
   *  model request (long gap between `step/start` and the first
   *  `assistant/chunk`) from a hung tool call (long `tool/call` →
   *  `tool/result` gap). The `ACP_LOG` environment variable overrides this
   *  value; unset disables tracing. */
  logFile: Schema.string().default(undefined),
  /** Forward `text-delta` / `reasoning-delta` stream chunks to the client as
   *  they arrive (coalesced on a short timer), instead of holding every block
   *  until its `block-end`. This is token-level streaming — the reply renders
   *  in the editor while the model is still writing it — at the cost of the
   *  safety property block buffering exists for: text already sent cannot be
   *  unsent, so when a request fails mid-block and the harness retries, the
   *  abandoned partial stays on the wire and a visible marker separates it
   *  from the retried attempt. Off by default; block-level streaming remains
   *  the safe default. */
  streamDeltas: Schema.boolean().default(false),
})

/** Preserve invalid-parameter detail in the SDK wire error message. */
function invalidParams(detail) {
  return RequestError.invalidParams(undefined, detail)
}

/** Preserve failed-turn detail; plain handler errors become a generic wire internal error. */
function internalError(detail) {
  return RequestError.internalError(undefined, detail)
}

/** Parse a tool's raw arguments JSON into a JSON value for ACP rawInput. */
function parseToolArguments(raw) {
  try {
    const parsed = JSON.parse(raw)
    return parsed !== null && typeof parsed === 'object' ? parsed : String(raw ?? '')
  } catch {
    return String(raw ?? '')
  }
}

/** Collapse whitespace and bound a string to one display line (Zed shows the
 *  tool-call header from the title, truncating overflow with an ellipsis). */
function clipOneLine(text, max) {
  const oneLine = String(text).replace(/\s+/g, ' ').trim()
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine
}

/** Escape markdown-significant characters so a dynamic title fragment (path,
 *  pattern, URL, query) renders literally inside Zed's markdown label. Zed
 *  applies no escaping to `other`/`read`/`search`/`fetch`/`think` kinds — it
 *  only escapes `edit` itself — so the bridge must keep emphasis/code/link
 *  syntax from being interpreted. Execute-kind titles render as plain text
 *  and are never escaped. */
function mdEscape(text) {
  return String(text).replace(/([\\*_`[\]<>])/g, '\\$1')
}

/** Executor-class tool names (command runners) shared by title/content/kind. */
const EXECUTOR_NAME = /bash|pwsh|powershell|shell|exec|run_code|execute|terminal/

/** Fenced-code language hint per executor tool (best effort — highlight only). */
function executorLang(name) {
  if (/pwsh|powershell/.test(name)) return 'powershell'
  if (/run_code/.test(name)) return 'typescript'
  return 'bash'
}

/** Shared file-path argument lookup (key order = display preference). */
function pathArg(obj) {
  for (const key of ['path', 'file_path', 'filePath', 'file', 'target']) {
    if (typeof obj[key] === 'string' && obj[key].trim() !== '') return obj[key].trim()
  }
  return undefined
}

/** Cap a long text body for a card, marking the cut so nothing looks lost. */
function boundBody(text, max) {
  const body = String(text ?? '')
  return body.length > max ? `${body.slice(0, max)}\n… (truncated)` : body
}

/** A markdown fenced code block, widening the fence when the text itself
 *  contains ``` runs so the body always renders literally. */
function codeFence(text, lang) {
  const body = String(text ?? '')
  const ticks = body.includes('```') ? '````' : '```'
  return `${ticks}${lang}\n${boundBody(body, 12000)}\n${ticks}`
}

/**
 * ACP content blocks giving the card a friendly body — the protocol's
 * best-practice surface (clients render these INSTEAD of the raw JSON dump,
 * which stays available as rawInput/rawOutput for transparency):
 * - write/edit tools → a `diff` block rendered as a real diff card;
 * - executors → the command as a syntax-highlighted code block.
 */
function toolCallContentFor(name, argumentsValue, kind) {
  const obj = argumentsValue !== null && typeof argumentsValue === 'object' && !Array.isArray(argumentsValue)
    ? argumentsValue
    : {}
  if (kind === 'edit') {
    const path = pathArg(obj)
    if (path === undefined) return undefined
    const newText = ['content', 'new_string', 'new_str', 'newText'].find((key) => typeof obj[key] === 'string')
    if (newText === undefined) return undefined
    const oldKey = ['old_string', 'old_str', 'oldText'].find((key) => typeof obj[key] === 'string')
    return [{
      type: 'diff',
      path,
      newText: boundBody(obj[newText], 8000),
      ...oldKey === undefined ? {} : { oldText: boundBody(obj[oldKey], 8000) },
    }]
  }
  if (name !== 'zed_terminal' && EXECUTOR_NAME.test(name)) {
    const command = typeof obj.command === 'string' ? obj.command
      : typeof obj.cmd === 'string' ? obj.cmd
      : typeof obj.script === 'string' ? obj.script
      : Array.isArray(obj.args) && obj.args.every((part) => typeof part === 'string')
        ? obj.args.join(' ')
      : undefined
    if (typeof command === 'string' && command.trim() !== '') {
      return [{ type: 'content', content: { type: 'text', text: codeFence(command.trim(), executorLang(name)) } }]
    }
  }
  return undefined
}

/**
 * Files the call touches, as ACP `locations` — the "follow the agent"
 * surface. Editors render them as clickable chips that open the file (and
 * scroll to `line`), so a read or an edit is one click from its target.
 */
function toolCallLocationsFor(kind, argumentsValue) {
  if (kind !== 'read' && kind !== 'edit' && kind !== 'delete' && kind !== 'move') return undefined
  const obj = argumentsValue !== null && typeof argumentsValue === 'object' && !Array.isArray(argumentsValue)
    ? argumentsValue
    : {}
  const path = pathArg(obj)
  if (path === undefined) return undefined
  const line = [obj.line, obj.offset].find((value) => (
    typeof value === 'number' && Number.isFinite(value) && value >= 1
  ))
  return [{ path, ...line === undefined ? {} : { line } }]
}

/**
 * One-line human-readable summary of a tool call for the ACP `title` field.
 * Zed renders this as the collapsed tool-call header, so a bare tool name
 * ("read", "bash") hides what actually happened until the card is expanded.
 * Mirror Zed's own native-agent titles (`Read <path>`, `Fetch <url>`,
 * `Search: <pattern>`, and the raw command for terminal tools) with the
 * detail escaped and bounded to one line.
 */
function toolCallTitle(name, argumentsValue) {
  const obj = argumentsValue !== null && typeof argumentsValue === 'object' && !Array.isArray(argumentsValue)
    ? argumentsValue
    : {}
  const str = (key) => (typeof obj[key] === 'string' ? obj[key].trim() : undefined)
  const num = (key) => {
    const value = obj[key]
    if (typeof value === 'number' && Number.isFinite(value)) return value
    if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
      return Number(value)
    }
    return undefined
  }
  const stringField = (value, key) => (
    typeof value === 'object' && value !== null && typeof value[key] === 'string' ? value[key].trim() : undefined
  )

  // Execute-kind tools (plain-text label): show the command itself.
  if (name === 'zed_terminal' || EXECUTOR_NAME.test(name)) {
    // Only zed_terminal maps to kind 'execute' (Zed renders its label as plain
    // text); local executors like bash/run_code are kind 'other' and render as
    // markdown, so their command must be escaped to stay literal.
    const literal = (text) => (name === 'zed_terminal' ? text : mdEscape(text))
    // Codex-style card: the collapsed title is the model's own intent line
    // (bash/pwsh mark `description` required — "Show working tree status"),
    // and the exact command stays visible in rawInput when the card expands.
    const description = str('description')
    if (description) return clipOneLine(literal(description), 100)
    const command = str('command') ?? str('cmd') ?? str('script')
    if (command) return clipOneLine(literal(command), 100)
    const argv = obj.args
    if (Array.isArray(argv) && argv.length > 0) return clipOneLine(literal(argv.map(String).join(' ')), 100)
    const cwd = str('cwd')
    if (cwd) return clipOneLine(literal(`Run in ${cwd}`), 100)
  }

  // File-content tools: `Read <path>` (incl. line range when present).
  if (/read|cat|show|view/.test(name)) {
    const path = pathArg(obj)
    if (path) {
      const range = [num('line') ?? num('offset'), num('limit')].filter((value) => value !== undefined)
      const suffix = range.length === 2 && Number.isFinite(range[0]) && Number.isFinite(range[1]) && range[1] > 0
        ? ` (lines ${range[0]}-${range[0] + range[1] - 1})`
        : range.length === 1 && Number.isFinite(range[0]) && range[0] > 1
          ? ` (from line ${range[0]})`
          : ''
      return clipOneLine(`Read ${mdEscape(path)}${suffix}`, 120)
    }
  }

  // File-modifying tools: `Write <path>` / `Edit <path>`.
  if (/write|edit|patch|apply/.test(name)) {
    const path = pathArg(obj)
    if (path) return clipOneLine(`Write ${mdEscape(path)}`, 120)
  }

  // Content search: `Search: <pattern>`.
  if (/grep|rg|content_search|search_text/.test(name)) {
    const pattern = str('pattern') ?? str('regex') ?? str('query')
    if (pattern) return clipOneLine(`Search: ${mdEscape(pattern)}`, 120)
  }

  // Path search: `Find: <pattern>`.
  if (/glob|find/.test(name)) {
    const pattern = str('pattern') ?? str('query') ?? str('path')
    if (pattern) return clipOneLine(`Find: ${mdEscape(pattern)}`, 120)
  }

  // Network fetch: `Fetch: <url>`.
  if (/fetch|http/.test(name)) {
    const url = str('url') ?? str('uri') ?? str('endpoint')
    if (url) return clipOneLine(`Fetch: ${mdEscape(url)}`, 120)
  }

  // Generic web/data search: `Search: <query>`.
  if (/search/.test(name)) {
    const query = str('query') ?? str('q') ?? str('keyword') ?? str('keywords')
    if (query) return clipOneLine(`Search: ${mdEscape(query)}`, 120)
  }

  // User questions: `Ask: <first question>`.
  if (/ask|question|elicit/.test(name) && Array.isArray(obj.questions)) {
    const first = obj.questions[0]
    const text = typeof first === 'object' && first !== null
      ? stringField(first, 'question') ?? stringField(first, 'header') ?? ''
      : String(first ?? '')
    if (text.trim().length > 0) return clipOneLine(`Ask: ${mdEscape(text)}`, 120)
  }

  // Subagents / delegated work: show the objective.
  if (/spawn_agent|subagent|spawn|delegate|task /.test(name)) {
    const description = str('description') ?? str('objective') ?? str('prompt')
    if (description) return clipOneLine(mdEscape(description), 100)
  }

  // MCP tools: inline a single string-valued field (mirrors Zed's own MCP
  // primary-argument heuristic); otherwise fall back to the tool name.
  if (name.startsWith('mcp__')) {
    const strings = Object.entries(obj)
      .filter(([key, value]) => typeof value === 'string' && value.trim().length > 0)
    if (strings.length === 1) {
      return clipOneLine(mdEscape(strings[0][1].trim()), 120)
    }
    if (strings.length > 1) {
      const [key, value] = strings[0]
      return clipOneLine(`${key}=${mdEscape(value)}`, 120)
    }
  }

  return name
}

/** Extract a bounded text preview of a dsh tool result for ACP rawOutput. */
function resultPreview(event) {
  if (event.data.error !== undefined) {
    return `[tool error: ${event.data.error.code ?? event.data.error.name ?? 'unknown'}]`
  }
  const parts = []
  for (const block of event.data.message?.content ?? []) {
    for (const inner of block?.content ?? []) {
      if (inner?.type === 'text' && typeof inner.text === 'string') parts.push(inner.text)
    }
  }
  const text = parts.join('\n')
  return text.length > 0 ? text.slice(0, 12000) : undefined
}

/** Mount the enhanced ACP server. */
export function apply(ctx, config) {
  // ACP handlers execute outside this plugin's injection scope, so capture the
  // injected services during apply rather than reading them lazily in a callback.
  const agents = ctx.agents
  const llm = ctx.llm
  const approval = ctx.approval
  const tools = ctx.tools
  const commands = ctx.commands
  const skills = ctx.skills
  const logger = ctx.logger
  /** Optional JSONL trace target: config option, overridable by `ACP_LOG`
   *  (mirrors `ACP_DEBUG`, which remains stderr-only). Every event carries a
   *  wall-clock `time` so a stalled turn can be attributed to the model
   *  request vs the tool execution afterwards. */
  const tracePath = process.env.ACP_LOG || config.logFile
  const trace = (entry) => {
    if (tracePath === undefined) return
    writeFile(tracePath, `${JSON.stringify({ time: Date.now(), ...entry })}\n`, { flag: 'a' }).catch((error) => {
      logger.warn(`acp-enhanced: trace write failed: ${String(error)}`)
    })
  }
  /** The user-questions service (mounted by dsh-base); absent in minimal deployments. */
  const userQuestions = ctx.get('userQuestions')

  /** sessionId → protocol state for one bridge-owned agent. */
  const sessions = new Map()
  let closed = false
  let conn
  /** Capabilities the connected client advertised on `initialize`. */
  let clientCaps = {}
  /** Disposers for the client-forwarding tools currently registered. */
  let clientToolDisposers = []

  /** Resolve the permission-presets service, tolerating a lazy mount. */
  const permissionPresets = () => ctx.get('permissionPresets')

  /**
   * Read one session's committed events as an array, tolerant of both harness
   * API generations: 0.1.2-rc.1 replaced the synchronous `session.events`
   * getter with `snapshotEvents()` (a cached frozen snapshot, invalidated on
   * every append — plus `ownEvents()`/`eventAt()`), while earlier generations
   * expose the live log array directly.
   */
  const sessionEventsOf = (session) => (
    typeof session.snapshotEvents === 'function' ? session.snapshotEvents() : session.events
  )

  /** The effective permission preset of one session, across harness
   *  generations: 0.1.2-alpha resolves through the permissions session
   *  projection (`current(session)`), while earlier generations fold the
   *  event log (`current(events)`). Probed per service instance —
   *  the booting CLI decides the service's generation, so this package's
   *  dependency range is not evidence. The probe is `permissionState`, a
   *  0.1.2-alpha method; passing the wrong argument shape to either
   *  generation does not throw reliably (the projection path can silently
   *  answer the default state), so the probe is load-bearing. The legacy
   *  event-log argument goes through sessionEventsOf (0.1.2-rc.1 sessions
   *  no longer expose a synchronous `events` array). */
  const currentPermissionMode = (permission, session) => (
    typeof permission.permissionState === 'function'
      ? permission.current(session)
      : permission.current(sessionEventsOf(session))
  )

  /**
   * The terminal-output meta dialect the connected client renders, exactly as
   * codex-acp resolves it: Zed declares `_meta.terminal_output` support on
   * initialize; older clients stream via `terminal_output_delta`.
   */
  const terminalOutputMode = () => clientCaps._meta?.['terminal_output'] === true
    ? 'terminal_output'
    : 'terminal_output_delta'

  /** Resolve the agent-presets roster, tolerating its absence (a profile that
   *  mounts no roster composes every session from the host layer). */
  const agentPresets = () => ctx.get('agentPresets')

  /**
   * Resolve one service the way a joined agent sees it: through its preset
   * scope chain when a roster is mounted (preset `isolate` realms hide e.g.
   * `planMode`/`compaction` from the root context), falling back to the host
   * context otherwise. Mirrors dsh-tui's `serviceForAgent`.
   */
  const serviceForAgent = (agent, key) => {
    const scoped = agentPresets()?.serviceFor?.(agent, key)
    if (scoped !== undefined) return scoped
    return ctx.get(key)
  }

  /** The preset a session actually runs, read from its log: the last
   *  `agent-preset/selected` event wins over the creation header. Folded here
   *  rather than resolved through dsh-agent-presets so the read is
   *  generation-agnostic: the legacy `resolveSessionPreset` export and the
   *  0.1.2-alpha `agentPreset` session projection define this exact fold —
   *  the last selection event wins, the creation header is the fallback, and
   *  a deployment that composes none yields `undefined`. */
  const runningPresetOf = (session) => {
    const events = sessionEventsOf(session)
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index]
      if (event?.type === 'agent-preset/selected') return event.data.agentPreset
    }
    return session.header.agentPreset
  }

  /** Whether a preset-resolution failure is the caller's setup mistake (an
   *  unknown or unmountable preset id) rather than a server fault; callers
   *  map it to invalid params. Generation-tolerant across the dsh 0.1.x
   *  line: 0.1.2-alpha throws RemoteError with a stable `agent-preset/*`
   *  code — identified structurally (`isDSHRemoteError`), never instanceof,
   *  because that class lives in the host tree; earlier generations throw
   *  UnknownPresetError / PresetMountError, which both carry `presetId`.
   *  instanceof against the namespace-imported classes stays as a last
   *  resort for deployments where the roster service and this module
   *  happened to resolve the same package copy. */
  const isPresetClientError = (error) => {
    if (!(error instanceof Error)) return false
    if (error.isDSHRemoteError === true) {
      return typeof error.code === 'string' && error.code.startsWith('agent-preset/')
    }
    if (error.presetId !== undefined) return true
    const { UnknownPresetError, PresetMountError } = agentPresetsModule
    return (UnknownPresetError !== undefined && error instanceof UnknownPresetError)
      || (PresetMountError !== undefined && error instanceof PresetMountError)
  }

  /** Whether one live session has produced anything yet. A preset swap is only
   *  legal while it is blank (dsh-agent-presets product rule): swapping tools
   *  mid-conversation would strand logged tool calls the new composition cannot
   *  make. Checks both the live turn marker and persisted user messages, so the
   *  same rule holds for resumed sessions whose on-disk logs may not carry
   *  `turn/start`. */
  const isBlankSession = (session) => !sessionEventsOf(session).some((event) => (
    event.type === 'turn/start' || event.type === 'user/message'
  ))

  /**
   * Resolve the preset a new/resumed session will run under, and the setup hook
   * that installs it inside the agent factory's `setup(agentCtx)`.
   *
   * Mirrors dsh-tui / dsh-host-apiproxy `composeAgent`: the id is resolved
   * BEFORE `agents.create` because the session boundary snapshots `meta` before
   * asynchronous setup begins, while the mount itself must run in `setup` so a
   * composition failure rolls the whole creation back. A deployment without a
   * roster returns an empty composition — every session then shares the host
   * composition (the pre-preset behavior).
   *
   * @param requested - preset id, or undefined for the roster default.
   * @returns `{ agentPreset, setup }`, or `{}` without a roster.
   * @throws a roster resolution failure (isPresetClientError — mapped by callers).
   */
  async function composePreset(requested) {
    const presets = agentPresets()
    if (presets === undefined) return {}
    const resolvedId = (await presets.resolveMountable(requested)).id
    return {
      agentPreset: resolvedId,
      setup: async (agentCtx) => {
        await presets.mount(agentCtx, resolvedId)
      },
    }
  }

  /** Persisted facts for one stored session: the preset it runs under and
   *  whether its log shows any real content. Both read from the on-disk log
   *  because a just-resumed session's in-memory event log fills asynchronously
   *  — the loadSession response would otherwise judge blank-ness before the
   *  events arrive. Returns undefined when the artifact is missing/corrupt
   *  (resume itself reports the failure; this lookup must not mask it). */
  async function persistedFactsOf(sessionId) {
    const persistence = ctx.get('sessionPersistence')
    if (persistence === undefined) return undefined
    try {
      const { meta, events } = await persistence.load(sessionId)
      return {
        preset: runningPresetOf({ header: meta, events }),
        blank: isBlankSession({ header: meta, events }),
      }
    } catch {
      // A missing/corrupt artifact leaves resume itself to report the failure;
      // the preset lookup must not mask it with a second, misleading error.
      return undefined
    }
  }

  // Multi-root workspaces: describe the session's roots to the model. Zed
  // passes the primary cwd plus every additional workspace root on the
  // session lifecycle requests; the sandbox policy still resolves a single
  // writable root (the primary cwd), so the text tells the model how writes
  // behave under each policy. Reads are unrestricted by the file sandbox.
  ctx.systemPrompt?.context({
    name: 'acp:workspace-roots',
    order: 115,
    text: (context) => {
      const session = context.agent?.session
      if (session === undefined) return ''
      return renderWorkspaceRoots(
        session.header.cwd,
        sessions.get(session.id)?.additionalDirectories ?? [],
      )
    },
  })

  /** Return the bridge-owned record for an agent, rejecting same-id impostors. */
  const ownedRecord = (agent) => {
    const record = sessions.get(agent.session.id)
    return record?.agent === agent ? record : undefined
  }

  const assertOpen = () => {
    if (closed) throw internalError('the ACP bridge has been disposed')
  }

  const requireSession = (sessionId) => {
    const record = sessions.get(sessionId)
    if (record === undefined) throw invalidParams(`unknown session: ${sessionId}`)
    return record
  }

  /** Send a protocol update without letting a disconnected client fail an agent turn. */
  const notify = (notification) => {
    void conn.sessionUpdate(notification).catch((error) => {
      logger.warn(`acp-enhanced: session/update failed: ${String(error)}`)
    })
  }

  const settlePrompt = (record, reason) => {
    const inflight = record.inflight
    if (inflight === undefined) return
    record.inflight = undefined
    inflight.resolve(reason)
  }

  const rejectFromError = (inflight, reason) => {
    inflight.reject(internalError(`turn failed: ${reason.error.message}`))
  }

  /**
   * Wire update for a harness `tool/call`: the one-line title header plus the
   * protocol's friendly-body surfaces — `content` (diff for file edits, the
   * command as a code block for executors), `locations` (clickable file chips),
   * and `rawInput`/`rawOutput`-class transparency fields.
   */
  function toolCallUpdateFor(record, event) {
    const parsedArgs = parseToolArguments(event.data.arguments)
    if (isTerminalToolName(event.data.name)) {
      // codex-acp terminal-card shape: kind 'execute' plus a terminal content
      // block and terminal_info meta, so Zed renders the command and output in
      // a terminal panel instead of a raw-JSON card. rawInput keeps the exact
      // command + resolved cwd for transparency.
      const command = typeof parsedArgs === 'object' && parsedArgs !== null && typeof parsedArgs.command === 'string'
        ? parsedArgs.command
        : typeof event.data.arguments === 'string' ? event.data.arguments : event.data.name
      const cwd = shellCallCwd(parsedArgs, record.agent.session)
      if (record.callArgs.size >= 64) record.callArgs.delete(record.callArgs.keys().next().value)
      record.callArgs.set(event.data.callId, { name: event.data.name, parsedArgs })
      return {
        sessionUpdate: 'tool_call',
        toolCallId: event.data.callId,
        name: event.data.name,
        title: stripShellPrefix(command) || event.data.name,
        kind: 'execute',
        status: 'in_progress',
        content: [{ type: 'terminal', terminalId: event.data.callId }],
        rawInput: { command, cwd },
        _meta: {
          turn: event.data.turn,
          step: event.data.step,
          name: event.data.name,
          argumentsPreview: event.data.arguments.slice(0, 200),
          terminal_info: { cwd, terminal_id: event.data.callId },
        },
      }
    }
    const kind = toolKindFor(event.data.name)
    const content = toolCallContentFor(event.data.name, parsedArgs, kind)
    const locations = toolCallLocationsFor(kind, parsedArgs)
    // Result-side card bodies need the call's own args (the executor output
    // fence); remember them per callId with a small ceiling against
    // aborted-call leaks.
    if (record.callArgs.size >= 64) record.callArgs.delete(record.callArgs.keys().next().value)
    record.callArgs.set(event.data.callId, { name: event.data.name, parsedArgs })
    return {
      sessionUpdate: 'tool_call',
      toolCallId: event.data.callId,
      name: event.data.name,
      title: toolCallTitle(event.data.name, parsedArgs),
      kind,
      status: 'in_progress',
      ...content === undefined ? {} : { content },
      ...locations === undefined ? {} : { locations },
      rawInput: parsedArgs,
      _meta: {
        turn: event.data.turn,
        step: event.data.step,
        name: event.data.name,
        argumentsPreview: event.data.arguments.slice(0, 200),
      },
    }
  }

  /** Wire update for a harness `tool/result`: terminal status plus, for
   *  executors, the output as a friendly code block under the command. */
  function toolResultUpdateFor(record, event, callId, elapsed) {
    const call = record.callArgs.get(callId)
    record.callArgs.delete(callId)
    const isError = event.data.error !== undefined
    if (call !== undefined && isTerminalToolName(call.name)) {
      // Close the terminal panel from the codex-acp terminal-card shape opened
      // by toolCallUpdateFor: stream the rendered output (minus the exit
      // marker the shell tool appends) via terminal_output(_delta) and finish
      // with terminal_exit, while rawOutput keeps the structured
      // { formatted_output, exit_code } shape. A failed call carries no
      // formatted body (the real exit code lives inside the text marker the
      // error path does not produce), so the panel closes status-failed bare.
      const parsed = isError ? undefined : parseShellExitStatus(resultText(event) ?? '')
      const body = parsed?.body ?? ''
      const meta = {
        terminal_exit: {
          exit_code: parsed?.exitCode ?? 0,
          signal: parsed?.signal ?? null,
          terminal_id: callId,
        },
      }
      if (body.length > 0) {
        Object.assign(meta, terminalOutputMode() === 'terminal_output'
          ? { terminal_output: { data: body, terminal_id: callId } }
          : { terminal_output_delta: { data: body, terminal_id: callId } })
      }
      return {
        sessionUpdate: 'tool_call_update',
        toolCallId: callId,
        name: call.name,
        status: isError ? 'failed' : 'completed',
        ...(!isError && body.length > 0) ? { rawOutput: { formatted_output: body, exit_code: parsed.exitCode } } : {},
        _meta: {
          turn: event.data.turn,
          step: event.data.step,
          elapsedMs: elapsed,
          count: record.toolStats.count,
          totalMs: record.toolStats.totalMs,
          ...meta,
        },
      }
    }
    const preview = resultPreview(event)
    let content
    if (!isError && preview !== undefined && call !== undefined
      && call.name !== 'zed_terminal' && EXECUTOR_NAME.test(call.name)) {
      content = [{ type: 'content', content: { type: 'text', text: codeFence(preview, executorLang(call.name)) } }]
    }
    return {
      sessionUpdate: 'tool_call_update',
      toolCallId: callId,
      ...call === undefined ? {} : { name: call.name },
      status: isError ? 'failed' : 'completed',
      ...content === undefined ? {} : { content },
      ...preview === undefined ? {} : { rawOutput: preview },
      _meta: {
        turn: event.data.turn,
        step: event.data.step,
        elapsedMs: elapsed,
        count: record.toolStats.count,
        totalMs: record.toolStats.totalMs,
      },
    }
  }

  // ── session/event → ACP notifications ─────────────────────────────────────

  ctx.on('session/event', (session, event) => {
    const record = sessions.get(session.header.id)
    if (record === undefined || record.agent.session !== session) return
    try {
      if (tracePath !== undefined) {
        const extra = event.type === 'tool/call'
          ? { name: event.data.name }
          : event.type === 'tool/result'
            ? { name: event.data.name ?? event.data.message?.content?.[0]?.name,
              elapsedMs: record.toolStats.lastCallAt === undefined ? undefined : Date.now() - record.toolStats.lastCallAt }
            : event.type === 'turn/end'
              ? { elapsedMs: record.turnStartedAt === undefined ? undefined : Date.now() - record.turnStartedAt }
              : {}
        trace({ event: event.type, turn: event.data?.turn, step: event.data?.step, ...extra })
      }
      if (process.env.ACP_DEBUG) {
        const extra = event.type === 'turn/end' ? ` reason=${JSON.stringify(event.data.reason)}` : event.type === 'assistant/chunk' ? ` chunkType=${event.data.chunk.type}` : event.type === 'agent/inbox/spliced' ? ` hasPending=${record.agent.inbox?.hasPending}` : event.type === 'tool/call' ? ` name=${event.data.name}` : ''
        process.stderr.write(`[acp-debug] ${event.type} turn=${event.data?.turn} step=${event.data?.step}${extra}\n`)
      }
      switch (event.type) {
        case 'assistant/chunk':
          handleChunk(record, event)
          break
        case 'assistant/message':
          // Final accounting when the adapter reported usage on the message
          // rather than as a stream chunk.
          if (event.data.usage !== undefined) emitUsage(record, event.data.usage, event)
          // Model-produced image blocks never stream through the text chunk
          // path; surface them as a wire placeholder so the reply is not
          // silently missing a block (ACP clients render the text).
          for (const block of event.data.message?.content ?? []) {
            if (block?.type === 'image' && block.attachment?.attachmentId !== undefined) {
              notify({
                sessionId: session.header.id,
                update: {
                  sessionUpdate: 'agent_message_chunk',
                  messageId: record.messageId,
                  content: { type: 'text', text: `[image attachment ${block.attachment.attachmentId}]` },
                },
              })
            }
          }
          break
        case 'turn/start': {
          record.turnCount += 1
          record.turnStartedAt = Date.now()
          // The preset-selection window closes the moment the session produces
          // its first turn: re-advertise the config so the editor's
          // agent_preset dropdown collapses to the running preset (ACP has no
          // disabled state; without this the client keeps showing the full
          // session/new list and offers switches the server must reject).
          if (record.turnCount === 1) {
            broadcastConfig(record).catch((error) => {
              logger.warn(`acp-enhanced: config rebroadcast after first turn failed: ${String(error)}`)
            })
          }
          break
        }
        case 'turn/end': {
          const elapsed = record.turnStartedAt === undefined ? 0 : Date.now() - record.turnStartedAt
          record.turnStartedAt = undefined
          record.lastActivityAt = Date.now()
          publishSessionInfo(record, { updatedAt: new Date(record.lastActivityAt).toISOString() })
          // Surface turn-level stats even when no usage sample landed this turn.
          if (record.lastUsage !== undefined) {
            notify({
              sessionId: session.header.id,
              update: {
                sessionUpdate: 'usage_update',
                used: record.lastUsage.used,
                size: record.lastUsage.size,
                _meta: {
                  ...record.lastUsage.meta,
                  turnCount: record.turnCount,
                  turnMs: elapsed,
                  tools: record.toolStats.count > 0 ? {
                    count: record.toolStats.count,
                    totalMs: record.toolStats.totalMs,
                  } : undefined,
                },
              },
            })
          }
          break
        }
        case 'step/start':
          record.stepStartedAt = Date.now()
          // One ACP message per model step: all block chunks of this step share
          // the same messageId so the client can group them.
          record.messageId = randomUUID()
          // Block indexes restart at 0 every step, so the previous step's
          // streamed-delta bookkeeping must not read as a retry seam.
          resetDeltaStreaming(record)
          break
        case 'tool/call': {
          record.toolStats.lastCallAt = Date.now()
          record.toolStats.lastName = event.data.name
          notify({
            sessionId: session.header.id,
            update: toolCallUpdateFor(record, event),
          })
          break
        }
        case 'tool/result': {
          const elapsed = record.toolStats.lastCallAt === undefined
            ? 0
            : Date.now() - record.toolStats.lastCallAt
          record.toolStats.count += 1
          record.toolStats.totalMs += elapsed
          record.toolStats.lastCallAt = undefined
          // The tool call id lives on the ToolResultBlock, not on the event root.
          const callId = event.data.message?.content?.[0]?.toolCallId ?? event.data.callId
          notify({
            sessionId: session.header.id,
            update: toolResultUpdateFor(record, event, callId, elapsed),
          })
          break
        }
        case 'request/context':
          if (event.data.contextWindow !== undefined) record.contextWindow = event.data.contextWindow
          break
        case 'session/title': {
          // Titles derive from raw first-prompt text; sanitize before the wire
          // so pasted markup (e.g. SiYuan `[resource_link ...]`) can't leak
          // into Zed's thread title.
          const title = sanitizeWireTitle(event.data.title)
          if (typeof title === 'string' && title.length > 0) {
            record.title = title
            publishSessionInfo(record, {
              title,
              updatedAt: new Date().toISOString(),
            })
          }
          break
        }
        case 'plan/mode': {
          // Map DSH plan mode flips onto the ACP Plan panel. DSH plan mode has
          // no structured task list, so a single state entry marks "planning in
          // progress" while active; leaving plan mode clears the panel. The
          // wire shape is flat: `{ sessionUpdate: 'plan', entries: [...] }`.
          const active = event.data.active === true
          notify({
            sessionId: session.header.id,
            update: {
              sessionUpdate: 'plan',
              entries: active
                ? [{
                  content: 'Plan mode: the agent will propose a plan and await your review before making changes.',
                  priority: 'high',
                  status: 'in_progress',
                }]
                : [],
            },
          })
          break
        }
      }
    } finally {
      const inflight = record.inflight
      if (inflight !== undefined && event.type === 'turn/end'
        && (inflight.turn === undefined || inflight.turn === event.data.turn)) {
        // agent/inbox/claimed can arrive on a scope this plugin does not see;
        // with at most one in-flight prompt per session, the newest turn/end
        // is authoritative for the pending prompt.
        if (event.data.reason.kind === 'error') {
          record.inflight = undefined
          rejectFromError(inflight, event.data.reason)
        } else {
          inflight.endReason = event.data.reason
        }
      }
    }
  })

  /**
   * Block-level streaming: accumulate text deltas per block index and forward
   * committed blocks immediately. A retry restarts the same index, so torn
   * partial text never reaches the wire; the uncommitted tail of a cancelled
   * attempt is simply dropped.
   *
   * With `streamDeltas` enabled, deltas additionally reach the wire while the
   * block is still open (coalesced on DELTA_FLUSH_MS), so the reply renders as
   * the model writes it. The block-end flush then forwards only the tail that
   * never made it out. Text already streamed cannot be unsent: when the
   * harness retries a failed request, block-start re-opens the same index, and
   * a deltaSent entry marks the seam with RETRY_MARKER.
   */
  function handleChunk(record, event) {
    const chunk = event.data.chunk
    switch (chunk.type) {
      case 'block-start':
        if (chunk.blockType === 'text') {
          emitRetrySeamIfStreamed(record, chunk.index, 'text')
          record.buffer[chunk.index] = ''
        } else if (chunk.blockType === 'reasoning') {
          emitRetrySeamIfStreamed(record, chunk.index, 'thought')
          record.thoughtBuffer[chunk.index] = ''
        }
        break
      case 'text-delta':
        if (record.buffer[chunk.index] !== undefined) {
          record.buffer[chunk.index] += chunk.text
          scheduleDeltaFlush(record, 'text', chunk.index)
        } else if (record.thoughtBuffer[chunk.index] !== undefined) {
          record.thoughtBuffer[chunk.index] += chunk.text
          scheduleDeltaFlush(record, 'thought', chunk.index)
        }
        break
      case 'reasoning-delta':
        if (record.thoughtBuffer[chunk.index] !== undefined) {
          record.thoughtBuffer[chunk.index] += chunk.text
          scheduleDeltaFlush(record, 'thought', chunk.index)
        }
        break
      case 'block-end': {
        // Drop queued entries first: the tail flush below covers them, so a
        // later timer pass must find nothing for these blocks.
        record.pendingDeltas.delete(`text:${chunk.index}`)
        record.pendingDeltas.delete(`thought:${chunk.index}`)
        const text = record.buffer[chunk.index]
        delete record.buffer[chunk.index]
        if (chunk.block.type === 'text' && text !== undefined && text.length > 0) {
          notify({
            sessionId: record.agent.session.id,
            update: {
              sessionUpdate: 'agent_message_chunk',
              messageId: record.messageId,
              content: { type: 'text', text },
            },
          })
        }
        const thought = record.thoughtBuffer[chunk.index]
        delete record.thoughtBuffer[chunk.index]
        if (chunk.block.type === 'reasoning' && thought !== undefined && thought.length > 0) {
          notify({
            sessionId: record.agent.session.id,
            update: {
              sessionUpdate: 'agent_thought_chunk',
              messageId: record.messageId,
              content: { type: 'text', text: thought },
            },
          })
        }
        break
      }
      case 'usage':
        emitUsage(record, chunk.usage, event)
        break
    }
  }

  /** On block-start, mark the seam when the previous attempt at this block
   *  index already streamed partial text to the client. */
  function emitRetrySeamIfStreamed(record, index, kind) {
    const key = `${kind}:${index}`
    if (!record.deltaSent.has(key)) return
    record.deltaSent.delete(key)
    notify({
      sessionId: record.agent.session.id,
      update: {
        sessionUpdate: kind === 'text' ? 'agent_message_chunk' : 'agent_thought_chunk',
        messageId: record.messageId,
        content: { type: 'text', text: RETRY_MARKER },
      },
    })
  }

  /** Queue a block's accumulated-but-unsent text for the coalesced flush.
   *  No-op when streamDeltas is off (block buffering only). */
  function scheduleDeltaFlush(record, kind, index) {
    if (config.streamDeltas !== true) return
    record.pendingDeltas.set(`${kind}:${index}`, { kind, index })
    if (record.deltaFlushTimer === undefined) {
      record.deltaFlushTimer = setTimeout(() => {
        record.deltaFlushTimer = undefined
        flushPendingDeltas(record)
      }, DELTA_FLUSH_MS)
    }
  }

  /** Forward every queued block's unsent text and clear the queue. Called on
   *  the coalescing timer; each entry's buffer resets to '' so block-end
   *  forwards only the never-streamed tail. */
  function flushPendingDeltas(record) {
    for (const { kind, index } of record.pendingDeltas.values()) {
      const buffer = kind === 'text' ? record.buffer : record.thoughtBuffer
      const text = buffer[index]
      if (text === undefined || text.length === 0) continue
      buffer[index] = ''
      record.deltaSent.add(`${kind}:${index}`)
      notify({
        sessionId: record.agent.session.id,
        update: {
          sessionUpdate: kind === 'text' ? 'agent_message_chunk' : 'agent_thought_chunk',
          messageId: record.messageId,
          content: { type: 'text', text },
        },
      })
    }
    record.pendingDeltas.clear()
  }

  /** Cancel pending streamed-delta state for one record (step boundary or
   *  dispose): indexes restart per step, so nothing survives a step/end. */
  function resetDeltaStreaming(record) {
    if (record.deltaFlushTimer !== undefined) {
      clearTimeout(record.deltaFlushTimer)
      record.deltaFlushTimer = undefined
    }
    record.pendingDeltas.clear()
    record.deltaSent.clear()
  }

  /** Broadcast one usage sample as a standard usage_update with rich _meta. */
  function emitUsage(record, usage, event) {
    const now = Date.now()
    const elapsedMs = record.stepStartedAt === undefined ? 0 : now - record.stepStartedAt
    const telemetry = usageTelemetry(usage, elapsedMs)
    const used = telemetry.contextTokens
    const size = record.contextWindow ?? used
    const update = {
      sessionUpdate: 'usage_update',
      used,
      size,
      _meta: {
        ...telemetry,
        turn: event?.data?.turn,
        step: event?.data?.step,
        turnCount: record.turnCount,
        tools: record.toolStats.count > 0 ? {
          count: record.toolStats.count,
          totalMs: record.toolStats.totalMs,
        } : undefined,
      },
    }
    record.lastUsage = { used, size, meta: update._meta }
    notify({ sessionId: record.agent.session.id, update })
  }

  // ── approval → session/request_permission ─────────────────────────────────

  ctx.on('approval/request', (request, next) => {
    const record = ownedRecord(request.agent)
    if (record === undefined || request.callId === undefined) return next()
    return conn.requestPermission({
      sessionId: record.agent.session.id,
      toolCall: { toolCallId: request.callId },
      options: [
        { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
      ],
    }).then(({ outcome }) => {
      if (outcome.outcome === 'cancelled') return 'cancelled'
      return outcome.optionId === 'allow-once' ? 'allowed-once' : 'rejected'
    })
  })

  // ── configuration options (model / reasoning effort / permission preset) ──

  /**
   * A provider route can register asynchronously right after boot, so a
   * freshly spawned bridge may enumerate before the profile's provider (e.g.
   * one that registers after a gateway/adapter section is applied) appears in
   * `llm.listProviders()`. Without a settle, the very first `session/new`
   * builds a model select that omits the session's own provider, so its models
   * cannot be chosen. Wait until the expected provider is registered (or a
   * short ceiling elapses) before building the catalog; also rebroadcast
   * config options whenever the adapter set changes, so an editor that opened
   * a session mid-boot catches up.
   */
  function waitForProvider(provider) {
    if (provider === undefined) return Promise.resolve()
    if (llm.listProviders().some((entry) => entry.id === provider)) return Promise.resolve()
    return new Promise((resolve) => {
      let settled = false
      const finish = () => {
        if (settled) return
        settled = true
        dispose()
        clearTimeout(timer)
        resolve()
      }
      const check = () => {
        if (llm.listProviders().some((entry) => entry.id === provider)) finish()
      }
      const timer = setTimeout(finish, 4000)
      const dispose = ctx.on('llm/adapters-updated', check)
    })
  }

  /** Rebuild every open session's config options when the provider set changes. */
  ctx.on('llm/adapters-updated', () => {
    for (const record of sessions.values()) {
      broadcastConfig(record).catch((error) => {
        logger.warn(`acp-enhanced: config rebroadcast after adapter update failed: ${String(error)}`)
      })
    }
  })

  /** Model directory for the select option: provider/model entries with reasoning info. */
  async function modelCatalog() {
    const groups = []
    await waitForProvider(config.provider)
    let providers = llm.listProviders()
    if (!config.includeAllProviders) {
      const configured = providers.filter((entry) => entry.id === config.provider)
      // Only advertise the configured provider's models. This machine's default
      // route is the one that can actually dispatch; dropping the rest keeps the
      // "phantom" cross-provider group (e.g. an official adapter mounted but
      // without a key when chat routes through a company gateway) from appearing
      // selectable — picking one silently broke every later prompt. Fall back to
      // the full set only if the configured provider isn't served yet, so the
      // dropdown is never empty during adapter boot.
      if (configured.length > 0) providers = configured
    }
    for (const provider of providers) {
      try {
        const models = await llm.listModels(provider.id)
        const entries = await Promise.all(models.map(async (model) => {
          let resolved
          try {
            resolved = await llm.resolveModelInfo(provider.id, model.id)
          } catch {
            resolved = undefined
          }
          return {
            id: model.id,
            name: model.name,
            ...model.description === undefined ? {} : { description: model.description },
            ...resolved?.reasoning === undefined ? {} : {
              reasoning: {
                efforts: resolved.reasoning.efforts.map((effort) => ({
                  id: effort.id,
                  name: effort.name,
                  ...effort.description === undefined ? {} : { description: effort.description },
                })),
                ...resolved.reasoning.defaultEffort === undefined ? {} : { defaultEffort: resolved.reasoning.defaultEffort },
              },
            },
          }
        }))
        if (entries.length > 0) groups.push({ id: provider.id, name: provider.name, models: entries })
      } catch {
        // A provider that fails to enumerate contributes no models.
      }
    }
    return groups
  }

  /** Build the full config-option set for one session. */
  async function buildConfigOptions(record) {
    // Test hook (unset in production): artificial latency proving the
    // response-vs-broadcast ordering holds even when config-option assembly
    // spans real event-loop turns (the cold-runner condition that raced the
    // command broadcast past the session/new response on CI).
    if (process.env.DSH_TEST_SLOW_CATALOG_MS !== undefined) {
      await new Promise((resolve) => setTimeout(resolve, Number(process.env.DSH_TEST_SLOW_CATALOG_MS) || 0))
    }
    const selected = record.selection.current
    const options = []
    const groups = await modelCatalog()
    // ACP grouped-select shape: each group is `{ group, name, options }`
    // (`group` = unique id, `name` = display label). Emitting `groupName`
    // instead made Zed skip the whole group on deserialization, so the model
    // dropdown came back empty and models could not be selected.
    const selectGrouped = groups.map((group) => ({
      group: group.id,
      name: group.name,
      options: group.models.map((model) => ({
        value: `${group.id}/${model.id}`,
        name: model.name,
        ...model.description === undefined ? {} : { description: model.description },
      })),
    }))
    options.push({
      id: 'model',
      type: 'select',
      name: 'Model',
      description: 'Provider/model route for this session (provider/model values).',
      category: 'model',
      currentValue: `${selected.provider}/${selected.model}`,
      options: selectGrouped,
    })
    const modelInfo = await llm.resolveModelInfo(selected.provider, selected.model).catch(() => undefined)
    const efforts = modelInfo?.reasoning?.efforts ?? []
    // Only advertise the reasoning-effort option when the routed model exposes
    // selectable efforts. A model route without reasoning metadata (e.g. a
    // gateway that reports none) would otherwise render an empty, dead dropdown
    // chip next to the send button.
    if (efforts.length > 0) {
      options.push({
        id: 'reasoning_effort',
        type: 'select',
        name: 'Reasoning effort',
        description: 'Reasoning level applied to model requests for this session.',
        category: 'thought_level',
        // The chain mirrors applySelection: selected effort, the model's own
        // default, then the first offered effort — a non-empty selection
        // unless the model declares no reasoning at all. This backstop keeps
        // the editor's dropdown from ever showing an "unknown" effort.
        currentValue: selected.reasoningEffort ?? modelInfo?.reasoning?.defaultEffort ?? efforts[0]?.id ?? '',
        options: efforts.map((effort) => ({
          value: effort.id,
          name: effort.name,
          ...effort.description === undefined ? {} : { description: effort.description },
        })),
      })
    }
    const permission = permissionPresets()
    if (permission !== undefined) {
      options.push({
        id: 'permission_preset',
        type: 'select',
        name: 'Permission preset',
        description: 'Sandbox mode and approval policy bundle for this session.',
        category: 'mode',
        currentValue: currentPermissionMode(permission, record.agent.session),
        options: permission.names.map((presetName) => {
          const spec = permission.presets[presetName]
          return {
            value: presetName,
            name: spec?.name ?? presetName,
            ...spec?.description === undefined ? {} : { description: spec.description },
          }
        }),
      })
    }
    const presets = agentPresets()
    if (presets !== undefined) {
      // Broken presets must not be offered: mounting one always fails.
      const mountable = (await presets.list()).filter((preset) => preset.broken === undefined)
      if (mountable.length > 0) {
        const current = runningPresetOf(record.agent.session) ?? ''
        // A just-resumed session's in-memory events fill asynchronously; trust
        // the on-disk log snapshot taken at load time when one exists.
        const blank = record.blankFromLog ?? isBlankSession(record.agent.session)
        options.push({
          id: 'agent_preset',
          type: 'select',
          name: 'Agent preset',
          description: blank
            ? 'Model-facing tool/prompt composition for this session (switch only while blank).'
            : 'Model-facing tool/prompt composition for this session (locked: switching requires a blank session).',
          category: 'model_config',
          currentValue: current,
          // ACP has no per-option disabled state, so a non-blank session
          // advertises only the running preset — the editor shows the current
          // mode without offering a switch the server would reject (the
          // setSessionConfigOption guard stays as the authoritative check).
          options: blank
            ? mountable.map((preset) => ({
              value: preset.id,
              name: preset.name ?? preset.id,
              ...preset.description === undefined ? {} : { description: preset.description },
            }))
            : [{ value: current, name: mountable.find((preset) => preset.id === current)?.name ?? (current || 'host') }],
        })
      }
    }
    const planMode = serviceForAgent(record.agent, 'planMode')
    if (planMode !== undefined) {
      options.push({
        id: 'plan_mode',
        type: 'boolean',
        name: 'Plan mode',
        description: 'Ask the agent to plan before acting and present the plan for review.',
        category: 'plan',
        currentValue: planMode.get(record.agent).active,
      })
    }
    return options
  }

  /** Resolve and apply a new model/effort selection to the session. */
  async function applySelection(record, next) {
    // Per-model effort restoration. An explicit effort (Zed re-applies its
    // saved default_config_options on every session, and a model switch
    // carries the session's current effort onto the newly picked model) wins
    // when the target offers it. Unsupported efforts are not just dropped:
    // the effort last successfully applied to this route is restored, and a
    // first-time route falls back to its own default — or, when it declares
    // none, to the FIRST effort it offers — so the selection never carries an
    // empty effort that renders as "unknown" in the editor's dropdown. A
    // model without reasoning metadata resolves without an effort.
    let info
    try {
      info = await llm.resolveModelInfo(next.provider, next.model)
    } catch {
      info = undefined
    }
    const efforts = info?.reasoning?.efforts ?? []
    let candidate = next.reasoningEffort
    if (candidate !== undefined && !efforts.some((effort) => effort.id === candidate)) {
      logger.warn(`acp-enhanced: dropped reasoning effort "${candidate}" for ${next.provider}/${next.model} (unsupported)`)
      candidate = undefined
    }
    if (candidate === undefined && efforts.length > 0) {
      const remembered = rememberedEffort(next.provider, next.model)
      candidate = remembered !== undefined && efforts.some((effort) => effort.id === remembered)
        ? remembered
        : info?.reasoning?.defaultEffort ?? efforts[0].id
    }
    const resolved = await llm.resolveCallConfig(
      candidate === undefined
        ? { provider: next.provider, model: next.model }
        : { ...next, reasoningEffort: candidate },
    )
    const selected = {
      provider: resolved.provider,
      model: resolved.model,
      ...resolved.reasoningEffort === undefined ? {} : { reasoningEffort: resolved.reasoningEffort },
    }
    record.selection.current = selected
    // Remember the effective effort for this route so a later switch back
    // restores it (a model without reasoning metadata records nothing).
    if (selected.reasoningEffort !== undefined) {
      rememberEffort(selected.provider, selected.model, selected.reasoningEffort)
    }
    // Persist as the default only when the chosen route is one this bridge is
    // wired to serve. On a single-provider machine the default route is the
    // routable one, so switching within it always persists; a stray cross-provider
    // pick (a manually addressed adapter that isn't configured here) is applied
    // to this session but never recorded as the default, so it can't poison the
    // default for every later session with a non-routable route.
    const persistDefault = config.includeAllProviders || selected.provider === config.provider
    if (persistDefault) {
      try {
        await ctx.get('agentDefaultModel')?.saveSelection?.(selected)
      } catch (error) {
        logger.warn(`acp-enhanced: the model switch applies to this session but was not saved as the default: ${String(error)}`)
      }
    }
  }

  async function broadcastConfig(record) {
    const configOptions = await buildConfigOptions(record)
    notify({
      sessionId: record.agent.session.id,
      update: { sessionUpdate: 'config_option_update', configOptions },
    })
    return configOptions
  }

  /** Apply one permission preset, mirroring the /permission command. */
  function applyPermissionPreset(record, presetName, permission) {
    if (!permission.names.includes(presetName)) {
      throw invalidParams(`unknown permission preset "${presetName}" (available: ${permission.names.join(', ')})`)
    }
    permission.apply(record.agent.session, presetName, (policy) => {
      approval.setPolicy(record.agent, policy)
    })
  }

  // ── client-forwarding tools (Zed fs / terminal) ──────────────────────────

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

  /** The bridge-owned session record behind a tool call, or throw. */
  function sessionIdOf(exec) {
    const record = ownedRecord(exec.agent)
    if (record === undefined) {
      throw new Error('this tool is only usable inside a bridge-owned session')
    }
    return record.agent.session.id
  }

  /**
   * Register (or refresh) the tools that forward to the connected client's own
   * capabilities — Zed's filesystem API and terminal. They only exist while the
   * client advertised the matching capability, so a raw test client or a plain
   * automation client never sees them. When the model edits project files
   * through `zed_write_text_file`, Zed applies the change to its own buffer and
   * surfaces it in the agent panel's "edited files" section with diff +
   * accept/reject; `zed_terminal` runs the command in a real Zed terminal.
   */
  function syncClientTools() {
    for (const dispose of clientToolDisposers) dispose()
    clientToolDisposers = []
    const fsCaps = clientCaps.fs ?? {}
    if (fsCaps.readTextFile === true) {
      clientToolDisposers.push(tools.register(defineTool({
        name: 'zed_read_text_file',
        description: 'Read a file through the connected editor (Zed) instead of the local fs tool. Use for files inside the editor workspace; the editor resolves the path against its project and records the read in its agent activity log.',
        parameters: {
          path: { type: 'string', required: true, description: 'Absolute path to the file to read.' },
          line: { type: 'integer', description: '1-based line to start reading from.' },
          limit: { type: 'integer', description: 'Maximum number of lines to read.' },
        },
        output: {
          schema: {
            type: 'object', additionalProperties: false,
            properties: { content: { type: 'string', required: true } },
          },
          render: (_args, value) => [{ type: 'text', text: value.content }],
        },
        async execute(args, exec) {
          const sessionId = sessionIdOf(exec)
          const response = await conn.readTextFile({
            sessionId,
            path: args.path,
            ...args.line === undefined ? {} : { line: args.line },
            ...args.limit === undefined ? {} : { limit: args.limit },
          })
          return { content: response.content }
        },
      })))
    }
    if (fsCaps.writeTextFile === true) {
      clientToolDisposers.push(tools.register(defineTool({
        name: 'zed_write_text_file',
        description: 'Write a file through the connected editor (Zed) instead of the local fs write tool. Use for project files in the editor workspace: the editor applies the change to its own buffer and shows it in the agent panel\'s edited-files section with a diff you can accept or reject. The content replaces the whole file.',
        parameters: {
          path: { type: 'string', required: true, description: 'Absolute path to the file to write.' },
          content: { type: 'string', required: true, description: 'The full text content to write to the file.' },
        },
        output: {
          schema: {
            type: 'object', additionalProperties: false,
            properties: { path: { type: 'string', required: true }, bytes: { type: 'integer' } },
          },
          render: (_args, value) => [{ type: 'text', text: `wrote ${value.bytes ?? 0} bytes to ${value.path} (in the editor)` }],
        },
        async execute(args, exec) {
          const sessionId = sessionIdOf(exec)
          await conn.writeTextFile({ sessionId, path: args.path, content: args.content })
          return { path: args.path, bytes: Buffer.byteLength(args.content, 'utf8') }
        },
      })))
    }
    if (clientCaps.terminal === true) {
      clientToolDisposers.push(tools.register(defineTool({
        name: 'zed_terminal',
        description: 'Run a command in a terminal inside the connected editor (Zed) instead of the local bash tool. The command runs in a real editor terminal visible in the panel; output is captured until the process exits (up to 120s). Use when running commands in the editor workspace where you want the terminal visible.',
        parameters: {
          command: { type: 'string', required: true, description: 'The command to execute.' },
          args: { type: 'array', items: { type: 'string' }, description: 'Optional command arguments.' },
          cwd: { type: 'string', description: 'Working directory for the command (absolute path).' },
        },
        output: {
          schema: {
            type: 'object', additionalProperties: false,
            properties: {
              output: { type: 'string', required: true },
              exitCode: { required: true, oneOf: [{ type: 'integer' }, { type: 'null' }] },
              signal: { required: true, oneOf: [{ type: 'string' }, { type: 'null' }] },
              timedOut: { type: 'boolean', required: true },
            },
          },
          render: (_args, value) => [{
            type: 'text',
            text: value.timedOut
              ? `timed out after 120s; last output:\n${value.output}`
              : `exit code: ${value.exitCode ?? 'signal' + (value.signal ?? '')}\n${value.output}`,
          }],
        },
        async execute(args, exec) {
          const sessionId = sessionIdOf(exec)
          const handle = await conn.createTerminal({
            sessionId,
            command: args.command,
            ...args.args === undefined || args.args.length === 0 ? {} : { args: args.args },
            ...args.cwd === undefined ? {} : { cwd: args.cwd },
          })
          try {
            let output = ''
            let exitStatus
            const deadline = Date.now() + 120_000
            while (Date.now() < deadline) {
              await sleep(300)
              const chunk = await handle.currentOutput()
              if (chunk.output) output = chunk.output // cumulative
              if (chunk.exitStatus !== undefined && chunk.exitStatus !== null) {
                exitStatus = chunk.exitStatus
                break
              }
            }
            if (exitStatus === undefined) {
              await handle.kill().catch(() => {})
              const final = await handle.currentOutput().catch(() => undefined)
              if (final?.output) output = final.output
              return { output, exitCode: null, signal: null, timedOut: true }
            }
            return {
              output,
              exitCode: exitStatus.exitCode ?? null,
              signal: exitStatus.signal ?? null,
              timedOut: false,
            }
          } finally {
            await handle.release().catch(() => {})
          }
        },
      })))
    }
    if (clientCaps.elicitation?.form !== undefined && clientCaps.elicitation?.form !== null && userQuestions !== undefined) {
      // Model-facing question tool (mirrors @deepseek-ai/dsh-tool-ask-user),
      // rendered in the editor as a form elicitation instead of a web dialog.
      clientToolDisposers.push(tools.register(defineTool({
        name: 'ask_user_question',
        description: 'Ask the user a concise question when you need confirmation, a choice, or missing information before proceeding. Send one or more questions, each with a stable id that will be echoed in the answer. The questions render as a form inside the editor.',
        parameters: { questions: {
          type: 'array',
          required: true,
          description: 'Questions to ask the user before continuing.',
          items: {
            type: 'object',
            additionalProperties: true,
            properties: {
              id: { type: 'string', required: true, description: 'Stable id for this question; echoed in the answer.' },
              question: { type: 'string', required: true, description: 'The specific question to ask the user.' },
              header: { type: 'string', description: 'Optional short heading for the question, such as "Confirm" or "Choose Mode".' },
              options: {
                type: 'array',
                description: 'Optional choices to show the user. If you recommend one, put it first and append "(Recommended)" to that label.',
                items: {
                  type: 'object', additionalProperties: true,
                  properties: {
                    label: { type: 'string', required: true, description: 'Short user-facing option label.' },
                    description: { type: 'string', description: 'One sentence explaining the tradeoff or impact.' },
                  },
                },
              },
              multi_select: { type: 'boolean', description: 'Whether the user may select more than one option. Defaults to false.' },
            },
          },
        } },
        output: {
          schema: {
            type: 'object', additionalProperties: false,
            properties: { answers: {
              type: 'array', required: true,
              items: {
                type: 'object', additionalProperties: false,
                properties: {
                  id: { type: 'string', required: true },
                  selected: { type: 'array', required: true, items: { type: 'string' } },
                  custom: { type: 'string' },
                },
              },
            } },
          },
          render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
        },
        async execute(args, exec) {
          const answers = await userQuestions.ask({
            questions: args.questions.map((question) => ({
              id: question.id,
              question: question.question,
              ...question.header === undefined ? {} : { header: question.header },
              ...question.options === undefined ? {} : { options: question.options },
              ...question.multi_select === undefined ? {} : { multiSelect: question.multi_select },
            })),
            ...exec.agent === undefined ? {} : { agent: exec.agent },
            signal: exec.signal,
          })
          return {
            answers: answers.answers.map((answer) => ({
              id: answer.id,
              selected: [...answer.selected],
              ...answer.custom === undefined ? {} : { custom: answer.custom },
            })),
          }
        },
      })))
      // The UI provider that renders those questions as an editor form. The
      // registration seam differs per harness generation, so it is probed on
      // the service instance (whose generation is the booting CLI's) rather
      // than assumed from this package's imports — migration plan rule 2.1.3:
      // ≤0.1.1-rc.2 exposes `userQuestions.registerProvider({ ask })` (one
      // active provider); ≥0.1.2-alpha.2 removed that method and asks
      // answerers to listen on the `user-questions/request` Cordis waterfall
      // instead, claiming a request by returning an answer or delegating it
      // via `next()`.
      const answerQuestion = async (request) => {
        const record = ownedRecord(request.agent)
        if (record === undefined) {
          throw new Error('ask_user_question is only usable inside a bridge-owned session')
        }
        // Editor forms cannot mix a fixed option list with free text in one
        // field, so every option-backed question gains a companion
        // `<id>__custom` text field: the form equivalent of dsh's native
        // "type your own answer" row, for when none of the offered options
        // fit. Option-free questions are already free-text fields.
        const usedKeys = new Set(request.questions.map((question) => question.id))
        const customKeys = new Map()
        const properties = {}
        const required = []
        for (const question of request.questions) {
          required.push(question.id)
          const options = question.options ?? []
          // Titled options (const/title/description) instead of a bare enum
          // so Zed renders each option's description under its label, like
          // the native question card. A question without options becomes a
          // plain text field: an optionless multi-select would otherwise
          // render as an empty, unanswerable checkbox list.
          const titled = options.map((option) => ({
            const: option.label,
            title: option.label,
            ...option.description === undefined ? {} : { description: option.description },
          }))
          const heading = question.header === undefined ? {} : { title: question.header }
          if (options.length === 0) {
            properties[question.id] = { type: 'string', description: question.question, ...heading }
          } else if (question.multiSelect === true) {
            properties[question.id] = { type: 'array', items: { anyOf: titled }, description: question.question, ...heading }
          } else {
            properties[question.id] = { type: 'string', oneOf: titled, description: question.question, ...heading }
          }
          if (options.length > 0) {
            let customKey = `${question.id}__custom`
            while (usedKeys.has(customKey)) customKey = `${customKey}_`
            usedKeys.add(customKey)
            customKeys.set(question.id, customKey)
            properties[customKey] = {
              type: 'string',
              title: 'Custom answer',
              description: question.multiSelect === true
                ? 'None of the options fit? Type your own answer; it is returned alongside your selections.'
                : 'None of the options fit? Type your own answer; it replaces the selection.',
            }
          }
        }
        const response = await conn.unstable_createElicitation({
          sessionId: record.agent.session.id,
          mode: 'form',
          message: request.questions.map((question) => question.question).join('\n'),
          requestedSchema: { type: 'object', properties, required },
        })
        if (response.action !== 'accept') {
          throw new Error(`the user ${response.action === 'decline' ? 'declined' : 'cancelled'} the question`)
        }
        const content = response.content ?? {}
        return {
          answers: request.questions.map((question) => {
            const value = content[question.id]
            const customKey = customKeys.get(question.id)
            if (customKey === undefined) {
              // Option-free question: the typed text IS the answer, reported
              // as the custom ("other") answer the way the native UI does.
              const text = typeof value === 'string' ? value.trim() : ''
              return { id: question.id, selected: [], ...text === '' ? {} : { custom: text } }
            }
            const selected = Array.isArray(value)
              ? value.filter((entry) => typeof entry === 'string')
              : typeof value === 'string' ? [value] : []
            const customRaw = content[customKey]
            const custom = typeof customRaw === 'string' && customRaw.trim() !== '' ? customRaw.trim() : undefined
            if (custom === undefined) {
              return { id: question.id, selected }
            }
            // A custom answer replaces a single selection and accompanies a
            // multi-select, matching the native question card.
            return {
              id: question.id,
              selected: question.multiSelect === true ? selected : [],
              custom,
            }
          }),
        }
      }
      if (typeof userQuestions.registerProvider === 'function') {
        // Legacy generation (≤0.1.1-rc.2): one active provider on the service.
        clientToolDisposers.push(userQuestions.registerProvider({ ask: answerQuestion }))
      } else {
        // Projection generation (≥0.1.2-alpha.2): answer the
        // `user-questions/request` waterfall. A listener on the root context
        // is untagged, so the scoped dispatch admits it for every agent; a
        // request this bridge does not own is delegated to the next answerer
        // (falling through to NO_PROVIDER when no one else claims it).
        clientToolDisposers.push(ctx.on('user-questions/request', async (request, next) => {
          if (ownedRecord(request.agent) === undefined) return next()
          return answerQuestion(request)
        }))
      }
    }
  }

  // ── per-session MCP servers (dsh-mcp-client mounts) ──────────────────────

  const mcpMounts = new Map() // serverName → { configJson, fiber }
  let mcpClientModule
  let warnedNoMcpClient = false

  function sanitizeMcpServerName(raw) {
    const cleaned = String(raw ?? 'server').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 32)
    return cleaned.length > 0 ? cleaned : 'server'
  }

  /** Project one ACP McpServer onto an mcp-client config, if supported. */
  function mcpConfigFor(server, cwd, serverName) {
    const envList = (list) => Object.fromEntries(
      (Array.isArray(list) ? list : []).map((entry) => [entry.name, entry.value]),
    )
    if (typeof server.command === 'string') {
      return {
        transport: 'stdio',
        serverName,
        command: server.command,
        args: Array.isArray(server.args) ? server.args : [],
        env: envList(server.env),
        cwd: typeof server.cwd === 'string' ? server.cwd : cwd,
        // A dead or misconfigured server must not take the session down;
        // its tools simply stay out of the model's tool list.
        failOnStartupError: false,
      }
    }
    if (server.type === 'http' && typeof server.url === 'string') {
      return {
        transport: 'streamable-http',
        serverName,
        url: server.url,
        headers: envList(server.headers),
        failOnStartupError: false,
      }
    }
    return undefined
  }

  /**
   * Mount/reuse/replace mcp-client instances for a session's server list.
   * Mounts are connection-scoped: the latest session's list wins, so tools
   * registered under `mcp__<serverName>__<tool>` are available to every
   * session on this connection. `ctx.loader.import` resolves the module from
   * the host dsh installation (single module instance, never a profile copy).
   */
  async function syncMcpServers(servers, cwd) {
    if (servers === undefined || servers.length === 0) return
    let module = mcpClientModule
    if (module === undefined) {
      try {
        module = await ctx.loader.import('@deepseek-ai/dsh-mcp-client')
        mcpClientModule = module
      } catch (error) {
        if (!warnedNoMcpClient) {
          warnedNoMcpClient = true
          logger.warn(`acp-enhanced: ignoring ${servers.length} MCP server(s): @deepseek-ai/dsh-mcp-client is not available: ${String(error.message ?? error)}`)
        }
        return
      }
    }
    const taken = new Set()
    for (const entry of servers) {
      const base = sanitizeMcpServerName(entry.name)
      let serverName = base
      for (let n = 2; taken.has(serverName); n += 1) serverName = `${base.slice(0, 28)}_${n}`
      const cfg = mcpConfigFor(entry, cwd, serverName)
      if (cfg === undefined) {
        logger.warn(`acp-enhanced: skipping MCP server "${serverName}": unsupported transport`)
        continue
      }
      const configJson = JSON.stringify(cfg)
      const existing = mcpMounts.get(serverName)
      if (existing !== undefined) {
        if (existing.configJson === configJson) {
          taken.add(serverName)
          continue
        }
        try {
          void existing.fiber.dispose()
        } catch (error) {
          logger.warn(`acp-enhanced: disposing MCP server "${serverName}": ${String(error)}`)
        }
        mcpMounts.delete(serverName)
      }
      try {
        const fiber = ctx.plugin(module, cfg)
        mcpMounts.set(serverName, { configJson, fiber })
        taken.add(serverName)
        logger.info(`acp-enhanced: mounted MCP server "${serverName}" (${cfg.transport})`)
      } catch (error) {
        logger.warn(`acp-enhanced: failed to mount MCP server "${serverName}": ${String(error)}`)
      }
    }
  }

  // ── slash commands (adapter built-ins + harness command registry) ────────

  /** Adapter-level commands, always first in the advertised list. */
  const BUILTIN_COMMANDS = [
    { name: 'status', description: 'Show session status: model route, context usage, telemetry.' },
    { name: 'model', description: 'List the model catalog, or switch with /model <provider/model | substring>.' },
    { name: 'preset', description: 'List agent presets, or switch with /preset <id> (blank session only).' },
  ]

  /**
   * Advertise the full command surface for a session as ACP
   * `available_commands_update`: adapter built-ins plus whatever the harness
   * command registry (compact/goal/permission/plan/…) serves for the agent.
   */
  async function publishCommands(record) {
    const list = [...BUILTIN_COMMANDS]
    const seen = new Set(list.map((command) => command.name))
    try {
      for (const descriptor of commands.list(record.agent)) {
        if (seen.has(descriptor.name)) continue
        seen.add(descriptor.name)
        list.push({
          name: descriptor.name,
          description: descriptor.description,
          ...descriptor.input === undefined ? {} : { input: descriptor.input },
        })
      }
    } catch (error) {
      logger.warn(`acp-enhanced: command listing failed: ${String(error)}`)
    }
    // User-invocable skills (e.g. /ask-matt) must be advertised as commands or
    // the Zed client rejects the slash before it reaches the bridge (its
    // available_skills only covers native agents, and it validates ACP
    // connections against available_commands locally).
    try {
      const summaries = await skills.list({ scope: record.agent, cwd: record.agent.session.header.cwd })
      for (const skill of summaries) {
        if (!skill.invocation?.userInvocable) continue
        if (seen.has(skill.name)) continue
        seen.add(skill.name)
        list.push({ name: skill.name, description: `Run the ${skill.name} skill` })
      }
    } catch (error) {
      logger.warn(`acp-enhanced: skill command listing failed: ${String(error)}`)
    }
    notify({
      sessionId: record.agent.session.id,
      update: { sessionUpdate: 'available_commands_update', availableCommands: list },
    })
  }

  /**
   * Advertise the command surface *after* the current request response is
   * written. A fresh `session/new` id is generated server-side, so the client
   * cannot route session notifications for it until the response arrives; an
   * `available_commands_update` queued before that response is dropped and
   * the slash menu stays empty ("Available commands: none").
   *
   * Ordering contract: arm this only as the handler's LAST statement, after
   * every await. The SDK serializes all outgoing messages through one FIFO
   * write queue and enqueues the handler's response synchronously in the
   * microtask continuation of the handler's promise, which strictly
   * precedes this setImmediate (check phase). Arming before a remaining
   * macrotask await (e.g. the config-option catalog build) lets the
   * immediate fire first, the broadcast overtakes the response, and
   * clients drop it — observed on CI as the broadcast landing before the
   * session/new response.
   */
  function publishCommandsAfterResponse(record) {
    setImmediate(() => {
      publishCommands(record).catch((error) => {
        logger.warn(`acp-enhanced: command broadcast failed: ${String(error)}`)
      })
    })
  }

  /** Text summary of one session: route, turns, last usage telemetry. */
  async function statusText(record) {
    const selection = record.selection.current
    const last = record.lastUsage
    const lines = [
      `route      ${selection.provider ?? '?'}/${selection.model ?? '?'}`,
      `preset     ${runningPresetOf(record.agent.session) ?? 'host'}`,
      `turns      ${record.turnCount}`,
      ...last === undefined ? [] : [
        `context    ${last.used}/${last.size}`,
        `last usage ${last.meta.inputTokens ?? '?'}/${last.meta.outputTokens ?? '?'} in/out, ${last.meta.reasoningTokens ?? '?'} reasoning, cache hit ${last.meta.cacheHitRate ?? '?'}%, ${last.meta.tps ?? '?'} tps`,
      ],
    ]
    // Monospace code block: aligned columns at a glance, no interaction needed.
    return ['```', ...lines, '```'].join('\n')
  }

  /** The /model command: list the live catalog or switch by exact id/substring. */
  async function modelCommandText(record, query) {
    const catalog = await modelCatalog()
    const current = record.selection.current
    if (query.trim().length === 0) {
      const lines = catalog.flatMap((group) => group.models.map((model) => {
        const mark = `${group.id}/${model.id}` === `${current.provider}/${current.model}` ? '* ' : '  '
        return `${mark}${group.id}/${model.id}`
      }))
      // Monospace code block: aligned catalog, no interaction needed.
      return lines.length > 0 ? ['```', ...lines, '```'].join('\n') : 'no models available'
    }
    const needle = query.trim().toLowerCase()
    const matches = catalog.flatMap((group) => group.models.map((model) => ({ provider: group.id, model: model.id })))
      .filter((candidate) => `${candidate.provider}/${candidate.model}`.toLowerCase().includes(needle) || candidate.model.toLowerCase().includes(needle))
    if (matches.length === 0) return `no model matches "${query}"`
    if (matches.length > 1) return `ambiguous: ${matches.map((m) => `${m.provider}/${m.model}`).join(', ')}`
    await applySelection(record, { provider: matches[0].provider, model: matches[0].model })
    return `switched to ${matches[0].provider}/${matches[0].model}`
  }

  /** The /preset command: list the roster or switch by exact id/substring. */
  async function presetCommandText(record, query) {
    const presets = agentPresets()
    if (presets === undefined) return 'no agent-presets roster is mounted in this profile'
    const roster = (await presets.list()).filter((preset) => preset.broken === undefined)
    const current = runningPresetOf(record.agent.session)
    if (query.trim().length === 0) {
      const lines = roster.map((preset) => {
        const mark = preset.id === current ? '* ' : '  '
        return `${mark}${preset.id}${preset.name !== undefined ? ` — ${preset.name}` : ''}`
      })
      return lines.length > 0 ? ['```', ...lines, '```'].join('\n') : 'no agent presets available'
    }
    const needle = query.trim().toLowerCase()
    const matches = roster.filter((preset) => (
      preset.id.toLowerCase().includes(needle) || preset.name?.toLowerCase().includes(needle)
    ))
    if (matches.length === 0) return `no agent preset matches "${query}"`
    if (matches.length > 1) return `ambiguous: ${matches.map((preset) => preset.id).join(', ')}`
    const target = matches[0]
    if (target.id === current) return `already on agent preset ${target.id}`
    if (!isBlankSession(record.agent.session)) {
      return `cannot switch agent preset on a non-blank session (current: ${current ?? 'host'})`
    }
    let preset
    try {
      preset = await presets.recompose(record.agent.ctx, target.id)
    } catch (error) {
      // A listed preset can still fail to mount (a missing service in this
      // deployment); report it as a command failure, not a wire crash.
      const detail = error instanceof Error ? error.message : String(error)
      return `⚠ /preset failed: ${detail}`
    }
    // The switch is a logged session fact (model-visible ⟺ logged), so a
    // resume re-resolves the NEW composition.
    record.agent.session.append('agent-preset/selected', { agentPreset: preset.id })
    return `switched to agent preset ${preset.id}`
  }

  /**
   * Execute one registry slash command, tolerant of both harness API
   * generations. dsh-commands 0.1.1-rc.1+ admits composer images between the
   * line and the cancellation signal (`execute(agent, line, images, signal)`,
   * images as `{ data, mediaType, name }` upload objects), while 0.1.0-rc.x
   * took `(agent, line, signal)` and could not carry images. Calling the
   * newer shape against the older service lands the signal in the images slot
   * and leaves `signal` undefined (`signal.aborted` throws), and the reverse
   * lands an array where the signal belongs — so the shapes must be probed,
   * not guessed. The declared arity is a faithful probe: the `Remote`
   * decorator only records a marker initializer and never wraps the method,
   * so `execute.length` equals the declared parameter count (3 on 0.1.0-rc.x,
   * 4 on 0.1.1-rc.1+). Images accompanying a slash line only reach the older
   * generation when an attachment store is also mounted, which the 0.1.0-rc.x
   * seam never provides (convertPrompt rejects them before dispatch) — so the
   * legacy call needs no images handling.
   */
  function executeRegistryCommand(agent, line, prompt) {
    const signal = new AbortController().signal
    const execute = commands.execute
    if (typeof execute.length === 'number' && execute.length >= 4) {
      return execute.call(commands, agent, line, acpPromptCommandImages(prompt), signal)
    }
    return execute.call(commands, agent, line, signal)
  }

  /** Refresh every client-visible surface a command may have mutated. */
  function refreshAfterCommand(record) {
    const permission = permissionPresets()
    if (permission !== undefined) {
      notify({
        sessionId: record.agent.session.id,
        update: {
          sessionUpdate: 'current_mode_update',
          currentModeId: currentPermissionMode(permission, record.agent.session),
        },
      })
    }
    broadcastConfig(record).catch((error) => {
      logger.warn(`acp-enhanced: config rebroadcast after command failed: ${String(error)}`)
    })
    publishCommands(record).catch((error) => {
      logger.warn(`acp-enhanced: command broadcast after command failed: ${String(error)}`)
    })
  }

  // ── session records + history replay ─────────────────────────────────────

  /** Build the bridge-owned protocol record for a fresh or resumed agent. */
  function makeRecord(handle) {
    // Session-local model selection, exactly as the Web api-proxy installs it:
    // reads fall back to the logged request header, then the default.
    let picked
    const selection = {
      get current() {
        if (picked !== undefined) return picked
        const logged = handle.agent.session.requestHeader()?.config
        if (logged === undefined) return ctx.get('agentDefaultModel')?.currentSelection?.() ?? {}
        return {
          provider: logged.provider,
          model: logged.model,
          ...logged.reasoningEffort === undefined ? {} : { reasoningEffort: logged.reasoningEffort },
        }
      },
      set current(next) {
        picked = next
      },
      assembled: undefined,
    }
    installModelSelection(handle.agent.ctx, selection)
    return {
      agent: handle.agent,
      dispose: () => handle.dispose(),
      /** Additional workspace roots beyond the primary cwd (multi-root). */
      additionalDirectories: [],
      inflight: undefined,
      messageId: undefined,
      stepStartedAt: undefined,
      turnStartedAt: undefined,
      turnCount: 0,
      title: undefined,
      lastActivityAt: undefined,
      toolStats: { count: 0, totalMs: 0, lastCallAt: undefined, lastName: undefined },
      /** callId → { name, parsedArgs } for result-time card bodies (bounded). */
      callArgs: new Map(),
      buffer: {},
      thoughtBuffer: {},
      /** streamDeltas bookkeeping: keys `text:<index>` / `thought:<index>`
       *  whose deltas already reached the wire this step (retry-seam
       *  detection), the blocks with unsent text queued for the coalesced
       *  flush, and that flush's timer. All reset per step — block indexes
       *  restart at 0 with every model step. */
      deltaSent: new Set(),
      pendingDeltas: new Map(),
      deltaFlushTimer: undefined,
      contextWindow: undefined,
      /** Blank-ness captured from the on-disk log at load time (resumed
       *  sessions' in-memory events fill asynchronously). Undefined for
       *  fresh/live sessions, which judge blank-ness live. */
      blankFromLog: undefined,
      lastUsage: undefined,
      selection,
    }
  }

  /**
   * Best-effort last known title of a persisted (non-live) session, read from
   * its stored log's `session/title` events. Bounded: oversized logs are
   * skipped rather than fully loaded.
   */
  async function readStoredTitle(persistence, id) {
    try {
      if (persistence?.supportsRawArtifacts !== true) return undefined
      const raw = await persistence.readRaw(id)
      if (raw === undefined || raw.content.length > 8 * 1024 * 1024) return undefined
      let last
      for (const line of raw.content.split('\n')) {
        if (line.trim().length === 0) continue
        try {
          const record = JSON.parse(line)
          if (record?.type === 'session/title' && typeof record?.data?.title === 'string') {
            last = record.data.title
          }
        } catch {
          // Malformed line — skip; titles live on well-formed rows.
        }
      }
      // Stored titles are the raw upstream text (the sanitizer runs on the
      // live path only); clean them here so replay shows the same wire shape.
      return last === undefined ? undefined : sanitizeWireTitle(last)
    } catch {
      return undefined
    }
  }

  /** Publish a session-metadata change (title / last activity) to the client. */
  function publishSessionInfo(record, info) {
    notify({
      sessionId: record.agent.session.id,
      update: { sessionUpdate: 'session_info_update', ...info },
    })
  }

  /** Extract plain text from a dsh message's content blocks (baseline ACP is text-only). */
  function textFromBlocks(content) {
    const parts = []
    for (const block of content ?? []) {
      if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text)
      else if (block?.type === 'image' && block.attachment?.attachmentId !== undefined) {
        // Model-produced images replay as a textual reference — the wire
        // surface does not carry attachment bytes.
        parts.push(`[image attachment ${block.attachment.attachmentId}]`)
      }
    }
    return parts.join('\n')
  }

  /** Extract reasoning text from assistant content blocks (replay only). */
  function thoughtFromBlocks(content) {
    const parts = []
    for (const block of content ?? []) {
      if (block?.type === 'reasoning' && typeof block.text === 'string') parts.push(block.text)
    }
    return parts.join('\n')
  }

  /**
   * Replay a resumed session's conversation to the client as ACP session
   * notifications. Zed inserts the thread before the load RPC completes, so
   * these find it. Only the baseline-visible surface is replayed: user and
   * assistant text chunks plus tool calls/results; everything else (turns,
   * steps, usage, plan flips, …) is omitted.
   */
  async function replayHistory(record) {
    const events = sessionEventsOf(record.agent.session)
    for (const event of events) {
      try {
        switch (event.type) {
          case 'user/message': {
            // Only direct human prompts (source.kind === 'user') belong in the
            // editor thread; synthetic injections (system reminders, skill
            // content, cron notices, …) would clutter it.
            if (event.data.source?.kind !== 'user') break
            const text = textFromBlocks(event.data.content)
            if (text.trim().length === 0) break
            await notifyNow(record, {
              sessionUpdate: 'user_message_chunk',
              messageId: randomUUID(),
              content: { type: 'text', text },
            })
            break
          }
          case 'assistant/message': {
            const text = textFromBlocks(event.data.message.content)
            const thought = thoughtFromBlocks(event.data.message.content)
            if (text.trim().length === 0 && thought.trim().length === 0) break
            if (text.trim().length > 0) {
              await notifyNow(record, {
                sessionUpdate: 'agent_message_chunk',
                messageId: randomUUID(),
                content: { type: 'text', text },
              })
            }
            if (thought.trim().length > 0) {
              await notifyNow(record, {
                sessionUpdate: 'agent_thought_chunk',
                messageId: randomUUID(),
                content: { type: 'text', text: thought },
              })
            }
            break
          }
          case 'tool/call': {
            // Same card shape as the live path — replayed threads render the
            // friendly body (diff / command block) and clickable locations too.
            await notifyNow(record, toolCallUpdateFor(record, event))
            break
          }
          case 'tool/result': {
            const callId = event.data.message?.content?.[0]?.toolCallId ?? event.data.callId
            await notifyNow(record, toolResultUpdateFor(record, event, callId, 0))
            break
          }
        }
      } catch (error) {
        logger.warn(`acp-enhanced: history replay skipped an event: ${String(error)}`)
      }
    }
  }

  /** Awaiting variant of notify() used by history replay (ordered delivery). */
  async function notifyNow(record, update) {
    await conn.sessionUpdate({
      sessionId: record.agent.session.id,
      update,
    }).catch((error) => {
      logger.warn(`acp-enhanced: session/update failed during history replay: ${String(error)}`)
    })
  }

  // ── the Agent face ────────────────────────────────────────────────────────

  const makeAgent = (connection) => {
    conn = connection
    return {
      initialize(params) {
        clientCaps = params?.clientCapabilities ?? {}
        syncClientTools()
        return Promise.resolve({
          protocolVersion: PROTOCOL_VERSION,
          agentInfo: { name: 'deepseek-harness-acp-enhanced', version: AGENT_VERSION },
          agentCapabilities: {
            loadSession: true,
            // additionalDirectories: multi-root workspaces (Zed passes every
            // workspace root on session/new / session/load instead of showing
            // the "doesn't currently support multi-root workspaces" callout).
            sessionCapabilities: { list: {}, delete: {}, additionalDirectories: {}, close: {} },
            // Image support is a live capability: the harness advertises
            // `image: true` only when the composition mounted a working
            // attachment store (duck-typed, so dsh 0.1.1-rc.2+ with
            // dsh-attachment-local enables it and older stacks report false).
            promptCapabilities: {
              image: attachmentIngestOf(ctx.get('attachments')) !== undefined,
              audio: false,
              embeddedContext: false,
            },
            // Stdio MCP servers always work; streamable HTTP maps onto
            // dsh-mcp-client's second transport. Legacy SSE does not.
            mcpCapabilities: { http: true, sse: false },
          },
          authMethods: [],
        })
      },

      authenticate() {
        return Promise.resolve()
      },

      async newSession(params) {
        try {
          assertOpen()
          const additionalDirectories = normalizeSessionParams(params)
          const sessionId = SessionId(randomUUID())
          const requestedPreset = process.env.DSH_ACP_PRESET ?? config.preset
          let composition
          try {
            composition = await composePreset(requestedPreset)
          } catch (error) {
            // A bad DSH_ACP_PRESET / preset config is a client-side setup mistake,
            // not a server fault: surface the roster's detail as invalid params.
            const detail = error instanceof Error ? error.message : String(error)
            if (isPresetClientError(error)) {
              throw invalidParams(detail)
            }
            throw error
          }
          const handle = await agents.create({
            sessionId,
            meta: {
              cwd: params.cwd,
              ...composition.agentPreset === undefined ? {} : { agentPreset: composition.agentPreset },
            },
            agentOptions: {
              ...config.provider === undefined ? {} : { provider: config.provider },
              ...config.model === undefined ? {} : { model: config.model },
            },
            ...composition.setup === undefined ? {} : { setup: composition.setup },
          })
          if (closed) {
            await handle.dispose()
            throw internalError('connection closed during session/new')
          }
          const record = makeRecord(handle)
          record.additionalDirectories = additionalDirectories
          sessions.set(sessionId, record)
          await syncMcpServers(params.mcpServers, params.cwd)
          const permission = permissionPresets()
          const configOptions = await buildConfigOptions(record)
          // Arm strictly after the handler's last await (see
          // publishCommandsAfterResponse): the SDK enqueues the response into
          // its FIFO write queue in the microtask continuation of this
          // handler's promise, which always precedes the immediate — so the
          // broadcast can never overtake the response.
          publishCommandsAfterResponse(record)
          return {
            sessionId,
            ...permission === undefined ? {} : {
              modes: {
                currentModeId: currentPermissionMode(permission, handle.agent.session),
                availableModes: permission.names.map((presetName) => {
                  const spec = permission.presets[presetName]
                  return {
                    id: presetName,
                    name: spec?.name ?? presetName,
                    ...spec?.description === undefined ? {} : { description: spec.description },
                  }
                }),
              },
            },
            configOptions,
          }
        } catch (error) {
          if (process.env.ACP_DEBUG) process.stderr.write(`[acp-debug] newSession failed: ${error?.stack ?? String(error)}\n`)
          throw error
        }
      },

      async loadSession(params) {
        assertOpen()
        const additionalDirectories = normalizeSessionParams(params)
        await syncMcpServers(params.mcpServers, params.cwd)
        const sessionId = SessionId(params.sessionId)
        const live = sessions.get(sessionId)
        if (live !== undefined) {
          // Already live on this connection. The client is re-loading the
          // session because it dropped its local thread (that is the only
          // reason a load arrives for a session the client already knows), so
          // replay the history — without it the client renders a blank thread
          // and Zed misreads the empty thread as a draft, permanently losing
          // the session linkage in its sidebar. The client's root list is
          // authoritative for the loaded workspace.
          live.additionalDirectories = additionalDirectories
          await replayHistory(live)
          const permission = permissionPresets()
          return {
            ...permission === undefined ? {} : {
              modes: {
                currentModeId: currentPermissionMode(permission, live.agent.session),
                availableModes: permission.names.map((presetName) => {
                  const spec = permission.presets[presetName]
                  return { id: presetName, name: spec?.name ?? presetName }
                }),
              },
            },
            configOptions: await buildConfigOptions(live),
          }
        }
        const runningPreset = await persistedFactsOf(sessionId)
        let composition
        try {
          composition = await composePreset(runningPreset?.preset)
        } catch (error) {
          // Same mapping as session/new: a roster that cannot supply the
          // session's logged preset is reported as a client mistake.
          const detail = error instanceof Error ? error.message : String(error)
          if (isPresetClientError(error)) {
            throw invalidParams(detail)
          }
          throw error
        }
        const handle = await agents.resume({
          resumeSessionId: sessionId,
          agentOptions: {
            ...config.provider === undefined ? {} : { provider: config.provider },
            ...config.model === undefined ? {} : { model: config.model },
          },
          ...composition.setup === undefined ? {} : { setup: composition.setup },
        })
        if (closed) {
          await handle.dispose()
          throw internalError('connection closed during session/load')
        }
        const record = makeRecord(handle)
        record.additionalDirectories = additionalDirectories
        record.blankFromLog = runningPreset?.blank
        sessions.set(sessionId, record)
        // Zed inserts the thread before the load RPC completes; replay the
        // conversation history as notifications so the thread renders.
        await replayHistory(record)
        const permission = permissionPresets()
        const configOptions = await buildConfigOptions(record)
        // Arm strictly after the handler's last await (see
        // publishCommandsAfterResponse): the broadcast must land after the
        // load response, never before it.
        publishCommandsAfterResponse(record)
        return {
          ...permission === undefined ? {} : {
            modes: {
              currentModeId: currentPermissionMode(permission, record.agent.session),
              availableModes: permission.names.map((presetName) => {
                const spec = permission.presets[presetName]
                return {
                  id: presetName,
                  name: spec?.name ?? presetName,
                  ...spec?.description === undefined ? {} : { description: spec.description },
                }
              }),
            },
          },
          configOptions,
        }
      },

      async prompt(params) {
        assertOpen()
        const record = requireSession(SessionId(params.sessionId))
        if (record.inflight !== undefined) {
          throw invalidParams('a prompt is already in flight for this session')
        }
        // Capability-gated content conversion: text/resource_link always work;
        // image blocks are ingested through the composition's attachment
        // store when one is mounted (advertised on initialize). A client that
        // sends unsupported content gets the exact failing kind — never a
        // silent drop — and an image that fails admission (bad type, over
        // limits, store rejection) surfaces its precise reason.
        let blocks
        let text
        try {
          const ingest = attachmentIngestOf(ctx.get('attachments'))
          const converted = await convertPrompt(params.prompt, ingest)
          blocks = converted.blocks
          text = converted.displayText
        } catch (error) {
          if (error instanceof UnsupportedPromptContentError) {
            throw invalidParams(error.message)
          }
          if (error instanceof PromptImageError) {
            throw invalidParams(`image rejected: ${error.message}`)
          }
          throw error
        }
        if (text.trim().length === 0) throw invalidParams('empty prompt')

        // Insurance: by the first prompt the client is guaranteed to know the
        // session, so re-advertise the command surface (idempotent) — covers
        // any client that missed the post-session/new broadcast.
        publishCommands(record).catch((error) => {
          logger.warn(`acp-enhanced: command broadcast failed: ${String(error)}`)
        })

        // Adapter-level slash commands never reach the model: /status and
        // /model are built in, any other registered slash (compact/goal/
        // permission/plan/…) runs through the harness command registry
        // without a model turn. An unresolved slash falls through — the
        // /skill-name gesture is claimed inside the agent's next step.
        // The command line is the prompt's text blocks, not the display
        // text: pasted images are composer attachments riding alongside the
        // line (forwarded to the registry as a separate images payload), and
        // their `[image: …]` display placeholders must neither prefix the
        // line (which would hide the slash) nor pollute its arguments.
        const commandLine = acpPromptLineText(params.prompt).trim()
        const commandMatch = commandLine.match(/^\/(\w[\w-]*)\b/)
        const respond = (reply) => {
          notify({
            sessionId: record.agent.session.id,
            update: {
              sessionUpdate: 'agent_message_chunk',
              messageId: randomUUID(),
              content: { type: 'text', text: reply },
            },
          })
          return { stopReason: 'end_turn' }
        }
        if (commandMatch?.[1] === 'status') return respond(await statusText(record))
        if (commandMatch?.[1] === 'model') {
          return respond(await modelCommandText(record, commandLine.slice(commandMatch[0].length).trim()))
        }
        if (commandMatch?.[1] === 'preset') {
          const reply = await presetCommandText(record, commandLine.slice(commandMatch[0].length).trim())
          refreshAfterCommand(record)
          return respond(reply)
        }
        if (commandMatch !== null && commandMatch[1] !== undefined) {
          let execution
          try {
            execution = await executeRegistryCommand(record.agent, commandLine, params.prompt)
          } catch (error) {
            return respond(`⚠ /${commandMatch[1]} failed: ${error.message ?? String(error)}`)
          }
          if (execution !== undefined) {
            const { result } = execution
            const reply = result.text ?? (result.kind === 'success' ? `/${commandMatch[1]} ✓` : `/${commandMatch[1]} failed`)
            refreshAfterCommand(record)
            return respond(result.kind === 'error' ? `⚠ ${reply}` : reply)
          }
        }

        // The slash is not a harness command: it may be a skill gesture
        // (`/skill-name`, e.g. `/ask-matt`). Zed would normally reject unknown
        // slashes, but we advertise user-invocable skills in publishCommands,
        // so this path is reachable. Load the skill body and append it to the
        // message so the model reads the skill's instructions, exactly like
        // dsh-tool-skill's user-invocation injection would.
        if (commandMatch !== null && commandMatch[1] !== undefined) {
          const skillName = commandMatch[1]
          try {
            const skill = await skills.get(skillName, {
              scope: record.agent,
              cwd: record.agent.session.header.cwd,
            })
            if (skill !== undefined && skill.invocation?.userInvocable !== false) {
              blocks = [...blocks, { type: 'text', text: renderSkillContent(skill) }]
            }
          } catch (error) {
            logger.warn(`acp-enhanced: skill gesture "${skillName}" failed: ${String(error)}`)
          }
        }

        if (ctx.agents.get(record.agent.id) !== record.agent) {
          throw internalError('prompt was not queued: the agent was disposed outside the bridge')
        }
        const message = createUserMessage({ content: blocks, source: { kind: 'user' } })
        if (process.env.ACP_DEBUG) process.stderr.write(`[acp-debug] followup queued, agent phase=${record.agent.phase?.kind} inboxPending=${record.agent.inbox?.hasPending}\n`)
        const promptAt = Date.now()
        const stopReason = await new Promise((resolve, reject) => {
          const inflight = {
            resolve,
            reject,
            messageId: message.id,
            turn: undefined,
            endReason: undefined,
          }
          record.inflight = inflight
          try {
            record.agent.followup(message)
          } catch (error) {
            record.inflight = undefined
            const detail = error instanceof Error ? error.message : String(error)
            throw internalError(`prompt was not queued: ${detail}`)
          }
          void record.agent.whenIdle().then(() => {
            if (record.inflight !== inflight) return
            record.inflight = undefined
            const end = inflight.endReason
            if (end === undefined) {
              inflight.resolve('cancelled')
            } else {
              inflight.resolve(end.kind === 'max-tokens' ? 'end_turn' : turnEndToStopReason(end))
            }
          })
        })
        trace({ event: 'prompt/settled', stopReason, elapsedMs: Date.now() - promptAt })
        return { stopReason }
      },

      cancel(params) {
        const record = sessions.get(SessionId(params.sessionId))
        if (record === undefined) return Promise.resolve()
        // An Error reason, not a bare object: the harness surfaces an aborted
        // tool's signal reason verbatim into the tool result the model reads,
        // so a plain object would render as the useless "Error: [object
        // Object]" and push the model off the tool that was merely
        // interrupted by the user's stop.
        record.agent.cancel(new Error('cancelled by user'))
        settlePrompt(record, 'cancelled')
        return Promise.resolve()
      },

      async setSessionConfigOption(params) {
        assertOpen()
        const record = requireSession(SessionId(params.sessionId))
        // ACP serializes SessionConfigOptionValue FLATTENED into the request
        // (schema 1.4.0 / JS SDK 0.25.1, what Zed sends): selects arrive as
        // `value: '<id>'`, booleans as `type: 'boolean', value: true` at the
        // top level. The SDK already validates this shape, so `params.value`
        // is a plain string/boolean here. The unwrap below is only a safety
        // net for hand-rolled streams that send the older nested form.
        let value = params.value
        if (typeof value === 'object' && value !== null && !Array.isArray(value) && 'value' in value) {
          value = value.value
        }
        switch (params.configId) {
          case 'model': {
            if (typeof value !== 'string') throw invalidParams('model value must be a "provider/model" string')
            const slash = value.indexOf('/')
            if (slash <= 0 || slash === value.length - 1) {
              throw invalidParams('model value must be a "provider/model" string')
            }
            const current = record.selection.current
            await applySelection(record, {
              provider: value.slice(0, slash),
              model: value.slice(slash + 1),
              ...current.reasoningEffort === undefined ? {} : { reasoningEffort: current.reasoningEffort },
            })
            break
          }
          case 'reasoning_effort': {
            if (typeof value !== 'string' || value.length === 0) {
              throw invalidParams('reasoning_effort value must be a non-empty effort id')
            }
            const current = record.selection.current
            await applySelection(record, {
              provider: current.provider,
              model: current.model,
              reasoningEffort: ReasoningEffortId(value),
            })
            break
          }
          case 'permission_preset': {
            if (typeof value !== 'string') throw invalidParams('permission_preset value must be a preset name')
            const permission = permissionPresets()
            if (permission === undefined) throw internalError('permission presets are not mounted')
            applyPermissionPreset(record, value, permission)
            break
          }
          case 'agent_preset': {
            if (typeof value !== 'string' || value.length === 0) {
              throw invalidParams('agent_preset value must be a non-empty preset id')
            }
            const presets = agentPresets()
            if (presets === undefined) throw internalError('agent presets are not mounted')
            if (!isBlankSession(record.agent.session)) {
              throw invalidParams('agent preset can only be switched while the session is blank (no turn has run)')
            }
            let preset
            try {
              preset = await presets.recompose(record.agent.ctx, value)
            } catch (error) {
              // Map the roster's typed failures onto the wire error shape: an
              // unknown/broken preset id is a client mistake (invalid params),
              // while a composition that fails to mount is a server fault.
              const detail = error instanceof Error ? error.message : String(error)
              if (isPresetClientError(error)) {
                throw invalidParams(detail)
              }
              throw internalError(detail)
            }
            // The switch is a logged session fact (model-visible ⟺ logged), so a
            // resume re-resolves the NEW composition.
            record.agent.session.append('agent-preset/selected', { agentPreset: preset.id })
            break
          }
          case 'plan_mode': {
            if (typeof value !== 'boolean') throw invalidParams('plan_mode value must be a boolean')
            const planMode = serviceForAgent(record.agent, 'planMode')
            if (planMode === undefined) throw internalError('plan mode is not mounted')
            planMode.set(record.agent, value)
            break
          }
          default:
            throw invalidParams(`unknown config option "${params.configId}" (available: model, reasoning_effort, permission_preset, agent_preset, plan_mode)`)
        }
        const configOptions = await broadcastConfig(record)
        return { configOptions }
      },

      async setSessionMode(params) {
        assertOpen()
        const record = requireSession(SessionId(params.sessionId))
        const permission = permissionPresets()
        if (permission === undefined) throw internalError('session modes are unavailable: permission presets are not mounted')
        applyPermissionPreset(record, params.modeId, permission)
        notify({
          sessionId: record.agent.session.id,
          update: { sessionUpdate: 'current_mode_update', currentModeId: params.modeId },
        })
        await broadcastConfig(record)
        return {}
      },

      async listSessions(params) {
        assertOpen()
        if (params.cwd !== undefined && params.cwd !== null && !isAbsolute(params.cwd)) {
          throw invalidParams(`cwd must be an absolute path: ${params.cwd}`)
        }
        const cwd = params.cwd ?? undefined
        const persistence = ctx.get('sessionPersistence')
        const headers = persistence === undefined ? [] : await persistence.list()
        const out = []
        for (const header of headers) {
          if (cwd !== undefined && header.cwd !== undefined && header.cwd !== cwd) continue
          const live = sessions.get(header.id)
          const title = live?.title ?? await readStoredTitle(persistence, header.id)
          const updatedAtMs = live?.lastActivityAt ?? header.createdAt
          const liveDirs = live?.additionalDirectories ?? []
          out.push({
            sessionId: header.id,
            cwd: header.cwd ?? cwd ?? process.cwd(),
            ...liveDirs.length === 0 ? {} : { additionalDirectories: liveDirs },
            ...title === undefined ? {} : { title },
            updatedAt: new Date(updatedAtMs).toISOString(),
          })
        }
        out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        return { sessions: out }
      },

      async closeSession(params) {
        assertOpen()
        const sessionId = SessionId(params.sessionId)
        const live = sessions.get(sessionId)
        if (live === undefined) return {}
        sessions.delete(sessionId)
        // The client released its last handle on this session (its thread was
        // dropped). Dispose the in-memory record so a later session/load fully
        // resumes from the persisted session; keeping it "live" would serve an
        // empty thread with no history replay on the next load.
        try {
          await live.dispose()
        } catch (error) {
          logger.warn(`acp-enhanced: failed to dispose closed session ${sessionId}: ${String(error)}`)
        }
        return {}
      },

      async deleteSession(params) {
        assertOpen()
        const sessionId = SessionId(params.sessionId)
        const live = sessions.get(sessionId)
        if (live !== undefined) {
          sessions.delete(sessionId)
          try {
            await live.dispose()
          } catch (error) {
            logger.warn(`acp-enhanced: failed to dispose live session ${sessionId}: ${String(error)}`)
          }
        }
        const persistence = ctx.get('sessionPersistence')
        if (persistence !== undefined) {
          try {
            const headers = await persistence.list()
            const header = headers.find((entry) => entry.id === sessionId)
            if (header !== undefined) {
              const location = persistence.locate(header)
              // The JSONL backend owns one directory per session; remove the
              // whole directory (log + any session-local artifacts). No official
              // delete API exists on the persistence surface, so this removes the
              // backend artifact directly.
              if (location?.path !== undefined) {
                await rm(dirname(location.path), { recursive: true, force: true })
              }
            }
          } catch (error) {
            logger.warn(`acp-enhanced: failed to remove persisted session ${sessionId}: ${String(error)}`)
          }
        }
        return {}
      },
    }
  }

  const stream = config.stream ?? ndJsonStream(
    Writable.toWeb(process.stdout),
    Readable.toWeb(process.stdin),
  )
  conn = new AgentSideConnection(makeAgent, stream)

  let quiescing
  const quiesce = () => {
    if (quiescing !== undefined) return quiescing
    closed = true
    const records = [...sessions.values()]
    sessions.clear()
    for (const record of records) {
      record.agent.cancel(new Error('cancelled because the session closed'))
      settlePrompt(record, 'cancelled')
    }
    for (const { fiber } of mcpMounts.values()) {
      try {
        void fiber.dispose()
      } catch (error) {
        logger.warn(`acp-enhanced: disposing MCP server mount failed: ${String(error)}`)
      }
    }
    mcpMounts.clear()
    quiescing = (async () => {
      const subagents = ctx.get('subagents')
      if (subagents?.drainContinuableDescendants !== undefined) {
        try {
          await subagents.drainContinuableDescendants(records.map((record) => record.agent))
        } catch (error) {
          logger.warn(`acp-enhanced: continuable subagent teardown failed: ${String(error)}`)
        }
      }
      const disposals = await Promise.allSettled(records.map((record) => record.dispose()))
      const failures = []
      for (const result of disposals) {
        if (result.status === 'rejected') failures.push(result.reason)
      }
      if (failures.length > 0) {
        const detail = failures.map((failure) => errorChain(failure)).join('; ')
        throw new AggregateError(failures, `ACP agent teardown failed for ${failures.length} session(s): ${detail}`)
      }
    })()
    return quiescing
  }

  void conn.closed
    .catch((error) => {
      logger.warn(`acp-enhanced: connection closed with an error: ${String(error)}`)
    })
    .then(quiesce)
    .catch((error) => {
      logger.warn(`acp-enhanced: connection-close teardown failed: ${String(error)}`)
    })

  ctx.effect(() => quiesce, 'acp-enhanced.connection')
}

/**
 * Validate `session/new`-style params and normalize the optional
 * `additionalDirectories` list. Entries must be absolute paths; they are
 * lexically resolved, deduplicated, and the primary cwd itself is dropped
 * (the schema treats the cwd as the first root — Zed never repeats it, but a
 * hand-rolled client may).
 */
function normalizeSessionParams(params) {
  if (!isAbsolute(params.cwd)) throw invalidParams(`cwd must be an absolute path: ${params.cwd}`)
  const raw = params.additionalDirectories
  if (raw === undefined || raw === null) return []
  if (!Array.isArray(raw)) throw invalidParams('additionalDirectories must be an array of absolute paths')
  const primary = resolve(params.cwd)
  const seen = new Set()
  const dirs = []
  for (const entry of raw) {
    if (typeof entry !== 'string' || !isAbsolute(entry)) {
      throw invalidParams(`additionalDirectories entries must be absolute paths: ${String(entry)}`)
    }
    const dir = resolve(entry)
    if (dir === primary || seen.has(dir)) continue
    seen.add(dir)
    dirs.push(dir)
  }
  return dirs
}

/**
 * System-prompt context for a multi-root session (empty for single-root).
 * Reads are unrestricted by the file sandbox; writes follow the session
 * policy, whose single writable root is the primary cwd (dsh-sandbox-policy
 * resolves one `workspaceRoot` per session), so additional roots need
 * escalation under workspace-write and are unrestricted under
 * danger-full-access.
 */
function renderWorkspaceRoots(cwd, dirs) {
  if (dirs.length === 0 || cwd === undefined) return ''
  return [
    `Multi-root workspace: relative paths resolve against the primary root ${JSON.stringify(cwd)}. The session also spans these additional workspace roots:`,
    ...dirs.map((dir) => `- ${dir}`),
    'File reads work in every root. File writes follow the sandbox policy: in workspace-write mode only the primary root (plus temp areas) is writable without approval, so a write under an additional root must obtain wider access first; in danger-full-access mode every root is writable.',
  ].join('\n')
}
