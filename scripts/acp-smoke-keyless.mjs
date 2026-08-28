#!/usr/bin/env node
/**
 * Keyless boot smoke test for CI: initialize → session/new → slash commands
 * with no model calls (no DEEPSEEK_API_KEY needed). Proves the npm-installed
 * bundle boots, serves the ACP handshake and config-option surface, and
 * handles adapter slash commands (/status, /model) without a model turn.
 *
 * The dsh CLI must be on PATH. The profile is created on demand from this
 * checkout via `dsh plugin --profile <name> add link:<repo>` so the test is
 * self-contained.
 */
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import readline from 'node:readline'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const profile = `acp-ci-${process.pid}`

let failed = 0
function check(label, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failed += 1
}

// Create the profile from this checkout (link: keeps it free of npm state).
const setup = spawnSync('dsh', ['plugin', '--profile', profile, 'add', `link:${repo}`], {
  stdio: ['ignore', 'pipe', 'pipe'],
})
if (setup.status !== 0) {
  console.error(String(setup.stderr))
  console.error('FAIL  could not create profile via dsh plugin add')
  process.exit(1)
}

const child = spawn('dsh', ['--profile', profile], { stdio: ['pipe', 'pipe', 'inherit'] })
const pending = new Map()
const notifications = []
/** Wire arrival order: responses vs notifications, for ordering assertions. */
const orderMarks = []
let lastMethod = ''
let seq = 0

readline.createInterface({ input: child.stdout }).on('line', (line) => {
  if (!line.trim()) return
  let msg
  try {
    msg = JSON.parse(line)
  } catch {
    return
  }
  if (msg.id !== undefined) {
    const resolve = pending.get(msg.id)
    if (resolve) {
      pending.delete(msg.id)
      orderMarks.push({ kind: 'response', method: lastMethod })
      resolve(msg)
    }
    return
  }
  const params = msg.params ?? msg
  notifications.push(params)
  orderMarks.push({ kind: 'notification', sessionUpdate: params.update?.sessionUpdate })
})

const waitFor = async (predicate, timeoutMs = 8000) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const hit = notifications.find(predicate)
    if (hit !== undefined) return hit
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return notifications.find(predicate)
}

function rpc(method, params, timeoutMs = 30000) {
  const id = String(++seq)
  lastMethod = method
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`timeout: ${method}`))
    }, timeoutMs)
    pending.set(id, (msg) => {
      clearTimeout(timer)
      if (msg.error !== undefined) reject(new Error(`${method}: ${JSON.stringify(msg.error)}`))
      else resolve(msg.result)
    })
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
  })
}

async function main() {
  try {
    const init = await rpc('initialize', { protocolVersion: 1, clientCapabilities: {} })
    check('initialize succeeds', init.agentInfo?.name === 'deepseek-harness-acp-enhanced')
    check('agent version present', typeof init.agentInfo?.version === 'string')

    const created = await rpc('session/new', { cwd: process.cwd(), mcpServers: [] })
    const sessionId = created.sessionId
    check('session/new returns a session id', typeof sessionId === 'string')
    const ids = (created.configOptions ?? []).map((option) => option.id)
    check('config options advertised', ['model', 'permission_preset'].every((id) => ids.includes(id)), ids.join(','))
    check('permission modes advertised', Array.isArray(created.modes?.availableModes) && created.modes.availableModes.length >= 3)

    // Slash commands: the adapter advertises them and handles them without a
    // model turn (this whole test runs without any API key).
    const commandsUpdate = await waitFor(
      (n) => n.update?.sessionUpdate === 'available_commands_update'
        && n.sessionId === sessionId,
    )
    const names = (commandsUpdate?.update?.availableCommands ?? []).map((c) => c.name)
    check('available_commands_update advertised', names.includes('status') && names.includes('model'), names.join(','))

    // Regression: the broadcast must be written AFTER the session/new response.
    // The session id is generated server-side, so a client cannot route session
    // notifications until that response arrives; a pre-response broadcast is
    // dropped and the slash menu stays empty.
    const newIdx = orderMarks.findIndex((m) => m.kind === 'response' && m.method === 'session/new')
    const cmdIdx = orderMarks.findIndex((m) => m.kind === 'notification' && m.sessionUpdate === 'available_commands_update')
    check('commands broadcast after session/new response', newIdx !== -1 && cmdIdx > newIdx, `response@${newIdx} commands@${cmdIdx}`)

    const status = await rpc('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: '/status' }],
    })
    check('/status settles without a model turn', status.stopReason === 'end_turn', JSON.stringify(status))
    const statusChunk = notifications.find(
      (n) => n.sessionId === sessionId && n.update?.sessionUpdate === 'agent_message_chunk',
    )
    check('/status replied with text', typeof statusChunk?.update?.content?.text === 'string'
      && statusChunk.update.content.text.includes('route'), statusChunk?.update?.content?.text)

    const model = await rpc('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: '/model' }],
    })
    check('/model settles without a model turn', model.stopReason === 'end_turn')
    check('/model lists the catalog', notifications.some(
      (n) => n.sessionId === sessionId && n.update?.sessionUpdate === 'agent_message_chunk'
        && n.update.content?.text?.includes('deepseek-v4-flash'),
    ))

    // ── config options: model switch + effort resilience (all keyless) ──────
    // Regression 1 (the "cannot switch models" report): Zed re-applies its
    // saved default_config_options on every session, and a model switch
    // carries the session's current effort onto the new model. An effort the
    // target model does not offer used to reject the whole switch, snapping
    // the dropdown back. It must reset to the model default instead.
    const effortOption = (created.configOptions ?? []).find((o) => o.id === 'reasoning_effort')
    const legalEfforts = (effortOption?.options ?? []).map((o) => String(o.value))
    // Pick a vocabulary-legal effort the routed model does not declare.
    const illegal = ['medium', 'low', 'xhigh', 'minimal'].find((id) => !legalEfforts.includes(id))
    if (effortOption !== undefined && illegal !== undefined) {
      const dropped = await rpc('session/set_config_option', { sessionId, configId: 'reasoning_effort', value: illegal })
      const after = (dropped.configOptions ?? []).find((o) => o.id === 'reasoning_effort')
      check('unsupported effort resets to model default instead of erroring',
        after !== undefined && after.currentValue !== illegal,
        `sent=${illegal} current=${JSON.stringify(after?.currentValue)}`)
    } else {
      console.log(`SKIP  unsupported-effort reset (effort option: ${effortOption !== undefined ? 'all candidates legal' : 'absent'})`)
    }

    // Regression 2: the dropdown path itself — switching models must succeed.
    // Use a target the advertised catalog actually offers (provider-agnostic).
    const modelOption = (created.configOptions ?? []).find((o) => o.id === 'model')
    const modelValues = (modelOption?.options ?? []).flatMap((group) => (group.options ?? []).map((o) => String(o.value)))
    const alt = modelValues.find((value) => value !== modelOption?.currentValue)
    if (alt !== undefined) {
      const switched = await rpc('session/set_config_option', { sessionId, configId: 'model', value: alt })
      const after = (switched.configOptions ?? []).find((o) => o.id === 'model')
      check('model switch via set_config_option succeeds', after?.currentValue === alt,
        `target=${alt} current=${JSON.stringify(after?.currentValue)}`)
    } else {
      console.log('SKIP  model switch (only one advertised model)')
    }

    console.log(failed === 0 ? 'ALL CHECKS PASSED' : `${failed} CHECK(S) FAILED`)
  } finally {
    child.kill()
    spawnSync('rm', ['-rf', `${process.env.HOME}/.dsh/profiles/${profile}`])
  }
  process.exit(failed === 0 ? 0 : 1)
}

main()
