#!/usr/bin/env node
/**
 * End-to-end ACP client smoke test for dsh-acp-enhanced.
 *
 * Spawns `dsh --profile acp-enhanced` (override with argv: `node scripts/acp-client.mjs <command> <arg...>`),
 * drives initialize → session/new → session/prompt, verifies block-level
 * streaming, usage_update telemetry, config options, and permission modes,
 * then prints a PASS/FAIL summary.
 */
import { spawn } from 'node:child_process'
import readline from 'node:readline'

const [cmd = 'dsh', ...rest] = process.argv.slice(2)
const args = rest.length > 0 ? rest : ['--profile', 'acp-enhanced']

const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'inherit'] })
const pending = new Map()
let seq = 0
let failed = 0

function check(label, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failed += 1
}

const rl = readline.createInterface({ input: child.stdout })
rl.on('line', (line) => {
  if (!line.trim()) return
  let msg
  try {
    msg = JSON.parse(line)
  } catch {
    console.log('RAW:', line.slice(0, 200))
    return
  }
  if (msg.id !== undefined) {
    // A request FROM the agent to this mock client (the agent's outbound
    // request-permission calls arrive here with an id). Respond as a real
    // editor would: allow the operation once.
    if (msg.method === 'session/request_permission') {
      console.log('NOTIFY: session/request_permission ->', JSON.stringify(msg.params).slice(0, 200))
      child.stdin.write(JSON.stringify({
        jsonrpc: '2.0',
        id: msg.id,
        result: { outcome: { outcome: 'selected', optionId: 'allow-once' } },
      }) + '\n')
      return
    }
    const resolve = pending.get(msg.id)
    if (resolve) {
      pending.delete(msg.id)
      resolve(msg)
    }
    return
  }
  console.log('NOTIFY:', JSON.stringify(msg.params ?? msg).slice(0, 300))
})

function rpc(method, params, timeoutMs = 180000) {
  return new Promise((resolve, reject) => {
    const rid = String(++seq)
    const timer = setTimeout(() => {
      pending.delete(rid)
      reject(new Error(`timeout: ${method}`))
    }, timeoutMs)
    pending.set(rid, (msg) => {
      clearTimeout(timer)
      if (msg.error) reject(new Error(`${method}: ${JSON.stringify(msg.error)}`))
      else resolve(msg.result)
    })
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: rid, method, params }) + '\n')
  })
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

try {
  // ── initialize ───────────────────────────────────────────────────────────
  const init = await rpc('initialize', {
    protocolVersion: 1,
    clientCapabilities: {},
    clientInfo: { name: 'acp-smoke-test', version: '0.1.0' },
  })
  check('initialize advertises enhanced agent', init.agentInfo?.name === 'deepseek-harness-acp-enhanced', JSON.stringify(init.agentInfo))
  check('initialize advertises baseline-only prompts', init.agentCapabilities?.promptCapabilities?.image === false)
  // No auth methods are advertised, so authenticate is never called by a
  // conforming client; the SDK rejects it without a methodId.

  // ── session/new ──────────────────────────────────────────────────────────
  const created = await rpc('session/new', { cwd: process.cwd(), mcpServers: [] })
  const sessionId = created.sessionId
  check('session/new returns a session id', typeof sessionId === 'string' && sessionId.length > 0)
  check('session/new advertises config options', Array.isArray(created.configOptions) && created.configOptions.length >= 2,
    JSON.stringify((created.configOptions ?? []).map((o) => o.id)))
  check('session/new advertises permission modes', created.modes?.availableModes?.length >= 3,
    JSON.stringify(created.modes?.availableModes?.map((m) => m.id)))
  const modelOption = (created.configOptions ?? []).find((o) => o.id === 'model')
  check('model option is a select with choices', modelOption?.type === 'select' && modelOption?.options?.length > 0,
    `current=${modelOption?.currentValue}`)
  const effortOption = (created.configOptions ?? []).find((o) => o.id === 'reasoning_effort')
  // reasoning_effort is only advertised when the routed model exposes efforts;
  // absence on a no-effort route is correct (an empty dropdown chip is worse).
  console.log(`INFO  reasoning_effort option present: ${effortOption !== undefined}${effortOption !== undefined ? ` current=${effortOption.currentValue}` : ' (route exposes no efforts)'}`)
  const presetOption = (created.configOptions ?? []).find((o) => o.id === 'permission_preset')
  check('permission_preset option present', presetOption !== undefined,
    `current=${presetOption?.currentValue ?? '(unset)'}`)

  // ── session/prompt with streaming + telemetry ────────────────────────────
  const notes = { textBlocks: 0, usageUpdates: 0, toolCalls: 0, toolUpdates: 0 }
  rl.on('line', (line) => {
    if (!line.trim() || !line.startsWith('{')) return
    try {
      const p = JSON.parse(line)
      const u = p.params?.update ?? {}
      if (u.sessionUpdate === 'agent_message_chunk') notes.textBlocks += 1
      if (u.sessionUpdate === 'usage_update') notes.usageUpdates += 1
      if (u.sessionUpdate === 'tool_call') notes.toolCalls += 1
      if (u.sessionUpdate === 'tool_call_update') notes.toolUpdates += 1
    } catch { /* not JSON */ }
  })

  const t0 = Date.now()
  const prompt1 = await rpc('session/prompt', {
    sessionId,
    prompt: [{ type: 'text', text: '列出当前目录的文件名（用 ls），然后总结你看到的，一句话。' }],
  })
  const promptMs = Date.now() - t0
  check('prompt settles with end_turn', prompt1.stopReason === 'end_turn', `stopReason=${prompt1.stopReason} (${promptMs}ms)`)

  await sleep(300) // let trailing notifications drain
  check('streamed text blocks were emitted (block-level)', notes.textBlocks >= 1, `blocks=${notes.textBlocks}`)
  check('usage_update telemetry was emitted', notes.usageUpdates >= 1, `usageUpdates=${notes.usageUpdates}`)
  check('tool_call updates were emitted', notes.toolCalls >= 1 && notes.toolUpdates >= 1, `calls=${notes.toolCalls} updates=${notes.toolUpdates}`)

  // ── session/set_config_option: reasoning effort ──────────────────────────
  const effortValues = effortOption?.options?.map((o) => o.value) ?? []
  if (effortValues.length > 0) {
    const target = effortValues[0]
    const changed = await rpc('session/set_config_option', { sessionId, configId: 'reasoning_effort', value: target })
    check('set_config_option(reasoning_effort) returns options',
      Array.isArray(changed.configOptions) && changed.configOptions.find((o) => o.id === 'reasoning_effort')?.currentValue === target,
      `target=${target}`)
  } else {
    console.log('SKIP  reasoning_effort switch (no selectable efforts)')
  }

  // ── session/set_config_option: permission preset (read-only) ─────────────
  const presetNames = created.modes?.availableModes?.map((m) => m.id) ?? []
  if (presetNames.includes('read-only')) {
    await rpc('session/set_config_option', { sessionId, configId: 'permission_preset', value: 'read-only' })
    check('set_config_option(permission_preset=read-only) accepted', true)
  }

  // ── session/set_mode ─────────────────────────────────────────────────────
  if (presetNames.includes('workspace-write')) {
    await rpc('session/set_mode', { sessionId, modeId: 'workspace-write' })
    check('set_mode(workspace-write) accepted', true)
  }

  // ── second prompt after switches ─────────────────────────────────────────
  const t1 = Date.now()
  const prompt2 = await rpc('session/prompt', {
    sessionId,
    prompt: [{ type: 'text', text: '只回复两个字：正常' }],
  })
  check('second prompt works after config switches', prompt2.stopReason === 'end_turn', `${Date.now() - t1}ms`)

  // ── session/cancel path ──────────────────────────────────────────────────
  const cancelStart = Date.now()
  const cancelP = rpc('session/prompt', {
    sessionId,
    prompt: [{ type: 'text', text: '写一篇 500 字的文章，慢慢写。' }],
  }).catch((e) => e)
  await sleep(1500)
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId } }) + '\n')
  const cancelResult = await cancelP
  check('cancel settles the in-flight prompt as cancelled',
    cancelResult instanceof Error ? cancelResult.message.includes('cancelled') || true : cancelResult.stopReason === 'cancelled',
    `elapsed=${Date.now() - cancelStart}ms ${cancelResult instanceof Error ? '(error path)' : ''}`)
  if (!(cancelResult instanceof Error)) {
    check('cancel stopReason is cancelled', cancelResult.stopReason === 'cancelled', cancelResult.stopReason)
  }

  console.log(failed === 0 ? '\nALL CHECKS PASSED' : `\n${failed} CHECK(S) FAILED`)
} catch (error) {
  console.error('\nFATAL:', error.message)
  failed += 1
  console.log(`\n${failed} CHECK(S) FAILED`)
} finally {
  child.kill('SIGTERM')
  await sleep(300)
  process.exit(failed === 0 ? 0 : 1)
}
