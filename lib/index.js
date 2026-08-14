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
 *
 * Stdout is reserved for ACP JSON-RPC; diagnostics go to stderr only.
 *
 * @module dsh-acp-enhanced
 */

import { randomUUID } from 'node:crypto'
import { isAbsolute } from 'node:path'
import { Readable, Writable } from 'node:stream'
import Schema from '@deepseek-ai/schemastery'
import { AgentSideConnection, ndJsonStream, PROTOCOL_VERSION, RequestError } from '@agentclientprotocol/sdk'
import { createUserMessage, errorChain, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { acpPromptToText, promptHasUnsupportedContent, turnEndToStopReason, usageTelemetry } from './codec.js'

export const name = 'acp-enhanced'
/** The bridge creates and owns agents; every other concern is carried by the composition. */
export const inject = ['agents', 'llm', 'approval']

export const Config = Schema.object({
  /** Initial provider route for every created agent. */
  provider: Schema.string(),
  /** Initial model for every created agent. */
  model: Schema.string(),
})

/** Preserve invalid-parameter detail in the SDK wire error message. */
function invalidParams(detail) {
  return RequestError.invalidParams(undefined, detail)
}

/** Preserve failed-turn detail; plain handler errors become a generic wire internal error. */
function internalError(detail) {
  return RequestError.internalError(undefined, detail)
}

/** Mount the enhanced ACP server. */
export function apply(ctx, config) {
  // ACP handlers execute outside this plugin's injection scope, so capture the
  // injected services during apply rather than reading them lazily in a callback.
  const agents = ctx.agents
  const llm = ctx.llm
  const approval = ctx.approval
  const logger = ctx.logger
  /** sessionId → protocol state for one bridge-owned agent. */
  const sessions = new Map()
  let closed = false
  let conn

  /** Resolve the permission-presets service, tolerating a lazy mount. */
  const permissionPresets = () => ctx.get('permissionPresets')

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
          break
        case 'turn/start': {
          record.turnCount += 1
          record.turnStartedAt = Date.now()
          break
        }
        case 'turn/end': {
          const elapsed = record.turnStartedAt === undefined ? 0 : Date.now() - record.turnStartedAt
          record.turnStartedAt = undefined
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
            update: {
              sessionUpdate: 'tool_call',
              toolCallId: event.data.callId,
              title: event.data.name,
              _meta: {
                turn: event.data.turn,
                step: event.data.step,
                name: event.data.name,
                argumentsPreview: event.data.arguments.slice(0, 200),
              },
            },
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
          notify({
            sessionId: session.header.id,
            update: {
              sessionUpdate: 'tool_call_update',
              toolCallId: event.data.callId,
              status: event.data.error === undefined ? 'completed' : 'error',
              _meta: {
                turn: event.data.turn,
                step: event.data.step,
                elapsedMs: elapsed,
                count: record.toolStats.count,
                totalMs: record.toolStats.totalMs,
              },
            },
          })
          break
        }
        case 'request/context':
          if (event.data.contextWindow !== undefined) record.contextWindow = event.data.contextWindow
          break
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
        break
      case 'text-delta':
        if (record.buffer[chunk.index] !== undefined) record.buffer[chunk.index] += chunk.text
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


  /** Model directory for the select option: provider/model entries with reasoning info. */
  async function modelCatalog() {
    const groups = []
    for (const provider of llm.listProviders()) {
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
    const selectGrouped = groups.map((group) => ({
      groupName: group.name,
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
    options.push({
      id: 'reasoning_effort',
      type: 'select',
      name: 'Reasoning effort',
      description: 'Reasoning level applied to model requests for this session.',
      category: 'thought_level',
      currentValue: selected.reasoningEffort ?? modelInfo?.reasoning?.defaultEffort ?? '',
      options: efforts.map((effort) => ({
        value: effort.id,
        name: effort.name,
        ...effort.description === undefined ? {} : { description: effort.description },
      })),
    })
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
    return options
  }

  /** Resolve and apply a new model/effort selection to the session. */
  async function applySelection(record, next) {
    const resolved = await llm.resolveCallConfig(next)
    const selected = {
      provider: resolved.provider,
      model: resolved.model,
      ...resolved.reasoningEffort === undefined ? {} : { reasoningEffort: resolved.reasoningEffort },
    }
    record.selection.current = selected
    try {
      await ctx.get('agentDefaultModel')?.saveSelection?.(selected)
    } catch (error) {
      logger.warn(`acp-enhanced: the model switch applies to this session but was not saved as the default: ${String(error)}`)
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

  // ── the Agent face ────────────────────────────────────────────────────────

  const makeAgent = (connection) => {
    conn = connection
    return {
      initialize() {
        return Promise.resolve({
          protocolVersion: PROTOCOL_VERSION,
          agentInfo: { name: 'deepseek-harness-acp-enhanced', version: '0.1.0' },
          agentCapabilities: {
            promptCapabilities: { image: false, audio: false, embeddedContext: false },
          },
          authMethods: [],
        })
      },

      authenticate() {
        return Promise.resolve()
      },

      async newSession(params) {
        assertOpen()
        validateSessionParams(params)
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
        // Session-local model selection, exactly as the Web api-proxy installs
        // it: reads fall back to the logged request header, then the default.
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
        const record = {
          agent: handle.agent,
          dispose: () => handle.dispose(),
          inflight: undefined,
          messageId: undefined,
          stepStartedAt: undefined,
          turnStartedAt: undefined,
          turnCount: 0,
          toolStats: { count: 0, totalMs: 0, lastCallAt: undefined, lastName: undefined },
          buffer: {},
          contextWindow: undefined,
          lastUsage: undefined,
          selection,
        }
        sessions.set(sessionId, record)
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

      async prompt(params) {
        assertOpen()
        const record = requireSession(SessionId(params.sessionId))
        if (record.inflight !== undefined) {
          throw invalidParams('a prompt is already in flight for this session')
        }
        if (promptHasUnsupportedContent(params.prompt)) {
          throw invalidParams('only text and resource_link prompt content is supported')
        }
        const text = acpPromptToText(params.prompt)
        if (text.trim().length === 0) throw invalidParams('empty prompt')
        if (ctx.agents.get(record.agent.id) !== record.agent) {
          throw internalError('prompt was not queued: the agent was disposed outside the bridge')
        }
        const message = createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
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
        const value = params.value
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
          default:
            throw invalidParams(`unknown config option "${params.configId}" (available: model, reasoning_effort, permission_preset)`)
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

/** Reject session features outside the automation contract. */
function validateSessionParams(params) {
  if (!isAbsolute(params.cwd)) throw invalidParams(`cwd must be an absolute path: ${params.cwd}`)
  if (params.additionalDirectories !== undefined && params.additionalDirectories.length > 0) {
    throw invalidParams('additionalDirectories is not supported')
  }
  if (params.mcpServers.length > 0) throw invalidParams('mcpServers is not supported')
}
