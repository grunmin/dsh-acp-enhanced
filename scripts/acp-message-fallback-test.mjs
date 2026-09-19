#!/usr/bin/env node
/**
 * End-to-end check of live streaming and the `assistant/message` fallback.
 *
 * The bridge has two tiers for delivering assistant text:
 *   1. the `agent/assistant-stream` frames event — the only live seam,
 *   2. the committed `assistant/message` fallback, which fires only when a step
 *      put no text on the wire.
 *
 * This test drives a real session twice over:
 *   - it asserts the live seam actually fired by reading the `ACP_DEBUG=1`
 *     stderr markers, so a silent regression to the fallback fails instead of
 *     quietly passing, and
 *   - it asserts a two-marker reply arrives exactly once, so the fallback can
 *     never duplicate a reply the live seam already delivered.
 *
 * Spawns `dsh --profile acp-enhanced` (override with argv: `node
 * scripts/acp-message-fallback-test.mjs <command> <arg...>`), so run it wherever
 * that profile is linked — see scripts/init-acp-home.sh.
 *
 * Exits 0 only when a live seam fired and the reply arrived exactly once.
 */
import { spawn } from 'node:child_process'
import readline from 'node:readline'

const [cmd = 'dsh', ...rest] = process.argv.slice(2)
const args = rest.length > 0 ? rest : ['--profile', 'acp-enhanced']

const FIRST = 'FALLBACK-ALPHA'
const SECOND = 'FALLBACK-OMEGA'
const TIMEOUT_MS = 180_000

// ACP_DEBUG makes the bridge narrate every session event / frame on stderr;
// capture it so the live-seam assertion below can see which tier delivered.
const child = spawn(cmd, args, {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, ACP_DEBUG: '1' },
})
const pending = new Map()
const chunks = []
let framesSeam = 0
let seq = 0
let failed = 0

function check(label, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failed += 1
}

const timer = setTimeout(() => {
  console.log('FAIL  test timed out')
  child.kill()
  process.exit(1)
}, TIMEOUT_MS)

function send(method, params) {
  return new Promise((resolve) => {
    const id = ++seq
    pending.set(id, resolve)
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
  })
}

readline.createInterface({ input: child.stdout }).on('line', (line) => {
  if (!line.trim()) return
  let msg
  try {
    msg = JSON.parse(line)
  } catch {
    console.log('RAW:', line.slice(0, 200))
    return
  }
  if (msg.id !== undefined) {
    // A request FROM the agent to this client carries `method`; a response to
    // one of ours does not. Resolve by that, never by id alone — the agent's
    // own ids can collide with this client's sequence.
    if (msg.method === 'session/request_permission') {
      child.stdin.write(`${JSON.stringify({
        jsonrpc: '2.0',
        id: msg.id,
        result: { outcome: { outcome: 'selected', optionId: msg.params?.options?.[0]?.optionId } },
      })}\n`)
      return
    }
    if (msg.method === undefined && pending.has(msg.id)) {
      pending.get(msg.id)(msg)
      pending.delete(msg.id)
    }
    return
  }
  const update = msg.params?.update
  if (update?.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text') {
    chunks.push(update.content.text)
  }
})

// Live-seam marker, emitted by the bridge under ACP_DEBUG:
// `agent/assistant-stream frame=chunk …`.
readline.createInterface({ input: child.stderr }).on('line', (line) => {
  if (line.includes('agent/assistant-stream frame=chunk')) framesSeam += 1
})

const initialized = await send('initialize', { protocolVersion: 1, clientCapabilities: {} })
check('initialize succeeds', initialized.result !== undefined, initialized.error ? JSON.stringify(initialized.error) : '')

const session = await send('session/new', { cwd: process.cwd(), mcpServers: [] })
check('session/new succeeds', session.result?.sessionId !== undefined,
  session.error ? JSON.stringify(session.error) : `sessionId=${session.result?.sessionId ?? ''}`)

const sessionId = session.result?.sessionId
if (sessionId === undefined) {
  clearTimeout(timer)
  child.kill()
  console.log('\nCHECKS FAILED')
  process.exit(1)
}

const settled = await send('session/prompt', {
  sessionId,
  prompt: [{ type: 'text', text: `Reply with exactly these two lines and nothing else:\n${FIRST}\n${SECOND}` }],
})
check('prompt settles with end_turn', settled.result?.stopReason === 'end_turn',
  settled.error ? JSON.stringify(settled.error) : `stopReason=${settled.result?.stopReason}`)

// Trailing notifications can arrive after the prompt response drains.
await new Promise((resolve) => setTimeout(resolve, 3000))
clearTimeout(timer)

const text = chunks.join('')
const count = (needle) => text.split(needle).length - 1
const first = count(FIRST)
const second = count(SECOND)

console.log(`CHUNKS: ${chunks.length}`)
console.log(`TEXT: ${JSON.stringify(text)}`)
check('the live streaming seam fired (agent/assistant-stream frames)', framesSeam > 0,
  `frames=${framesSeam}`)
check('the reply reached the client', first > 0 && second > 0, `text=${JSON.stringify(text.slice(0, 120))}`)
check('the reply reached it exactly once', first === 1 && second === 1,
  `${FIRST}×${first}, ${SECOND}×${second}`)

child.kill()
console.log(failed === 0 ? '\nALL MESSAGE-FALLBACK CHECKS PASSED' : `\n${failed} CHECK(S) FAILED`)
process.exit(failed === 0 ? 0 : 1)
