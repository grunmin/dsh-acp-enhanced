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
import { defineTool } from '@deepseek-ai/dsh-tools'
import { SessionId } from '@deepseek-ai/dsh-session'
import {
  attachmentIngestOf,
  convertPrompt,
  PromptImageError,
  sanitizeWireTitle,
  turnEndToStopReason,
  UnsupportedPromptContentError,
  usageTelemetry,
} from './codec.js'

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

export const name = 'acp-enhanced'
/** The bridge creates and owns agents; every other concern is carried by the composition. */
export const inject = ['agents', 'llm', 'approval', 'tools', 'commands', 'systemPrompt']

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
})

/** Preserve invalid-parameter detail in the SDK wire error message. */
function invalidParams(detail) {
  return RequestError.invalidParams(undefined, detail)
}

/** Preserve failed-turn detail; plain handler errors become a generic wire internal error. */
function internalError(detail) {
  return RequestError.internalError(undefined, detail)
}

/**
 * Map a dsh tool name to the ACP ToolKind used for icons and card UX.
 *
 * Kind and content must agree: Zed treats kind == 'execute' as a terminal tool
 * and kind == 'edit' as a diff tool, and for both it HIDES the rawInput
 * section. `zed_terminal` is genuinely terminal; write/edit tools map to
 * 'edit' only because the bridge always pairs them with a `diff` content
 * block (see toolCallContentFor) — the diff replaces the raw dump as the card
 * body. Local executors like bash/run_code stay 'other' and carry the command
 * as a markdown code block, keeping the raw sections available too.
 */
function toolKindFor(name) {
  if (name === 'zed_terminal') return 'execute'
  if (/^fs_.*read|read_text|cat|show/.test(name)) return 'read'
  if (/search|find|grep/.test(name)) return 'search'
  if (/fetch|http/.test(name)) return 'fetch'
  if (/think/.test(name)) return 'think'
  if (/write|edit|patch|apply/.test(name)) return 'edit'
  return 'other'
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
  const logger = ctx.logger
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
    const preview = resultPreview(event)
    const call = record.callArgs.get(callId)
    record.callArgs.delete(callId)
    const isError = event.data.error !== undefined
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
   */
  function handleChunk(record, event) {
    const chunk = event.data.chunk
    switch (chunk.type) {
      case 'block-start':
        if (chunk.blockType === 'text') record.buffer[chunk.index] = ''
        else if (chunk.blockType === 'reasoning') record.thoughtBuffer[chunk.index] = ''
        break
      case 'text-delta':
        if (record.buffer[chunk.index] !== undefined) record.buffer[chunk.index] += chunk.text
        else if (record.thoughtBuffer[chunk.index] !== undefined) record.thoughtBuffer[chunk.index] += chunk.text
        break
      case 'reasoning-delta':
        if (record.thoughtBuffer[chunk.index] !== undefined) record.thoughtBuffer[chunk.index] += chunk.text
        break
      case 'block-end': {
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
        currentValue: permission.current(record.agent.session.events),
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
    const planMode = ctx.get('planMode')
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
      // The UI provider that renders those questions as an editor form.
      clientToolDisposers.push(userQuestions.registerProvider({
        ask: async (request) => {
          const record = ownedRecord(request.agent)
          if (record === undefined) {
            throw new Error('ask_user_question is only usable inside a bridge-owned session')
          }
          const properties = {}
          const required = []
          for (const question of request.questions) {
            required.push(question.id)
            const labels = (question.options ?? []).map((option) => option.label)
            if (question.multiSelect === true) {
              properties[question.id] = {
                type: 'array',
                ...labels.length > 0 ? { items: { type: 'string', enum: labels } } : { items: { type: 'string' } },
                description: question.question,
              }
            } else if (labels.length > 0) {
              properties[question.id] = { type: 'string', enum: labels, description: question.question }
            } else {
              properties[question.id] = { type: 'string', description: question.question }
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
              const selected = Array.isArray(value)
                ? value.filter((entry) => typeof entry === 'string')
                : typeof value === 'string' ? [value] : []
              return { id: question.id, selected }
            }),
          }
        },
      }))
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

  /** Refresh every client-visible surface a command may have mutated. */
  function refreshAfterCommand(record) {
    const permission = permissionPresets()
    if (permission !== undefined) {
      notify({
        sessionId: record.agent.session.id,
        update: {
          sessionUpdate: 'current_mode_update',
          currentModeId: permission.current(record.agent.session.events),
        },
      })
    }
    broadcastConfig(record).catch((error) => {
      logger.warn(`acp-enhanced: config rebroadcast after command failed: ${String(error)}`)
    })
    publishCommands(record)
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
      contextWindow: undefined,
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
    const events = record.agent.session.events
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
            sessionCapabilities: { list: {}, delete: {}, additionalDirectories: {} },
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
        assertOpen()
        const additionalDirectories = normalizeSessionParams(params)
        const sessionId = SessionId(randomUUID())
        const handle = await agents.create({
          sessionId,
          meta: { cwd: params.cwd },
          agentOptions: {
            ...config.provider === undefined ? {} : { provider: config.provider },
            ...config.model === undefined ? {} : { model: config.model },
          },
        })
        if (closed) {
          await handle.dispose()
          throw internalError('connection closed during session/new')
        }
        const record = makeRecord(handle)
        record.additionalDirectories = additionalDirectories
        sessions.set(sessionId, record)
        await syncMcpServers(params.mcpServers, params.cwd)
        publishCommandsAfterResponse(record)
        const permission = permissionPresets()
        return {
          sessionId,
          ...permission === undefined ? {} : {
            modes: {
              currentModeId: permission.current(handle.agent.session.events),
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
          configOptions: await buildConfigOptions(record),
        }
      },

      async loadSession(params) {
        assertOpen()
        const additionalDirectories = normalizeSessionParams(params)
        await syncMcpServers(params.mcpServers, params.cwd)
        const sessionId = SessionId(params.sessionId)
        const live = sessions.get(sessionId)
        if (live !== undefined) {
          // Already live on this connection: return its state without replay.
          // The client's root list is authoritative for the loaded workspace.
          live.additionalDirectories = additionalDirectories
          const permission = permissionPresets()
          return {
            ...permission === undefined ? {} : {
              modes: {
                currentModeId: permission.current(live.agent.session.events),
                availableModes: permission.names.map((presetName) => {
                  const spec = permission.presets[presetName]
                  return { id: presetName, name: spec?.name ?? presetName }
                }),
              },
            },
            configOptions: await buildConfigOptions(live),
          }
        }
        const handle = await agents.resume({
          resumeSessionId: sessionId,
          agentOptions: {
            ...config.provider === undefined ? {} : { provider: config.provider },
            ...config.model === undefined ? {} : { model: config.model },
          },
        })
        if (closed) {
          await handle.dispose()
          throw internalError('connection closed during session/load')
        }
        const record = makeRecord(handle)
        record.additionalDirectories = additionalDirectories
        sessions.set(sessionId, record)
        // Zed inserts the thread before the load RPC completes; replay the
        // conversation history as notifications so the thread renders.
        await replayHistory(record)
        publishCommandsAfterResponse(record)
        const permission = permissionPresets()
        return {
          ...permission === undefined ? {} : {
            modes: {
              currentModeId: permission.current(record.agent.session.events),
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
          configOptions: await buildConfigOptions(record),
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
        publishCommands(record)

        // Adapter-level slash commands never reach the model: /status and
        // /model are built in, any other registered slash (compact/goal/
        // permission/plan/…) runs through the harness command registry
        // without a model turn. An unresolved slash falls through — the
        // /skill-name gesture is claimed inside the agent's next step.
        const trimmed = text.trim()
        const commandMatch = trimmed.match(/^\/(\w[\w-]*)\b/)
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
          return respond(await modelCommandText(record, trimmed.slice(commandMatch[0].length).trim()))
        }
        if (commandMatch !== null && commandMatch[1] !== undefined) {
          let execution
          try {
            execution = await commands.execute(record.agent, trimmed, new AbortController().signal)
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

        if (ctx.agents.get(record.agent.id) !== record.agent) {
          throw internalError('prompt was not queued: the agent was disposed outside the bridge')
        }
        const message = createUserMessage({ content: blocks, source: { kind: 'user' } })
        if (process.env.ACP_DEBUG) process.stderr.write(`[acp-debug] followup queued, agent phase=${record.agent.phase?.kind} inboxPending=${record.agent.inbox?.hasPending}\n`)
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
        return { stopReason }
      },

      cancel(params) {
        const record = sessions.get(SessionId(params.sessionId))
        if (record === undefined) return Promise.resolve()
        record.agent.cancel({ kind: 'user' })
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
          case 'plan_mode': {
            if (typeof value !== 'boolean') throw invalidParams('plan_mode value must be a boolean')
            const planMode = ctx.get('planMode')
            if (planMode === undefined) throw internalError('plan mode is not mounted')
            planMode.set(record.agent, value)
            break
          }
          default:
            throw invalidParams(`unknown config option "${params.configId}" (available: model, reasoning_effort, permission_preset, plan_mode)`)
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
      record.agent.cancel({ kind: 'user' })
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
