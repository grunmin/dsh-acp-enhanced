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
      resolve(msg)
    }
    return
  }
  notifications.push(msg.params ?? msg)
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

    const status = await rpc('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: '/status' }],
    })
    check('/status settles without a model turn', status.stopReason === 'end_turn', JSON.stringify(status))
    const statusChunk = notifications.find(
      (n) => n.sessionId === sessionId && n.update?.sessionUpdate === 'agent_message_chunk',
    )
    check('/status replied with text', typeof statusChunk?.update?.content?.text === 'string'
      && statusChunk.update.content.text.includes('route:'), statusChunk?.update?.content?.text)

    const model = await rpc('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: '/model' }],
    })
    check('/model settles without a model turn', model.stopReason === 'end_turn')
    check('/model lists the catalog', notifications.some(
      (n) => n.sessionId === sessionId && n.update?.sessionUpdate === 'agent_message_chunk'
        && n.update.content?.text?.includes('deepseek-v4-flash'),
    ))

    console.log(failed === 0 ? 'ALL CHECKS PASSED' : `${failed} CHECK(S) FAILED`)
  } finally {
    child.kill()
    spawnSync('rm', ['-rf', `${process.env.HOME}/.dsh/profiles/${profile}`])
  }
  process.exit(failed === 0 ? 0 : 1)
}

main()
