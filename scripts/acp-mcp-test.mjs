#!/usr/bin/env node
/**
 * End-to-end MCP mount test for dsh-acp-enhanced.
 *
 * Drives initialize → session/new with an `mcpServers` entry pointing at
 * scripts/fixtures/mcp-echo-server.mjs, and asserts the bridge mounted the
 * server: the bridge's dsh-mcp-client mount spawns the fixture itself, whose
 * stderr markers ([echo-mcp] initialized / tools/list) surface on the agent's
 * stderr (inherited) and are collected here.
 *
 * Usage: node scripts/acp-mcp-test.mjs [command] [arg...]
 * Default command: dsh --profile acp-enhanced
 */
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import readline from 'node:readline'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'mcp-echo-server.mjs')

// Explicit command/args win; otherwise self-create a throwaway profile from
// this checkout (like acp-smoke-keyless.mjs) so the test runs anywhere,
// including CI where no named profile exists.
const explicit = process.argv.slice(2)
let cmd
let args
let tempProfile
if (explicit.length > 0) {
  cmd = explicit[0]
  args = explicit.slice(1)
} else {
  tempProfile = `acp-mcp-test-${process.pid}`
  const setup = spawnSync('dsh', ['plugin', '--profile', tempProfile, 'add', `link:${repo}`], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (setup.status !== 0) {
    console.error(String(setup.stderr))
    console.error('FAIL  could not create profile via dsh plugin add')
    process.exit(1)
  }
  cmd = 'dsh'
  args = ['--profile', tempProfile]
}

let failed = 0
function check(label, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failed += 1
}

// ── the ACP agent under test ───────────────────────────────────────────────
const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] })
const pending = new Map()
const serverLog = []
let seq = 0

child.stderr.on('data', (chunk) => {
  for (const line of String(chunk).split('\n')) {
    if (!line.trim()) continue
    if (line.includes('[echo-mcp]')) serverLog.push(line.trim())
  }
})

const rl = readline.createInterface({ input: child.stdout })
rl.on('line', (line) => {
  if (!line.trim()) return
  let msg
  try {
    msg = JSON.parse(line)
  } catch {
    return
  }
  if (msg.id === undefined) return
  const resolve = pending.get(msg.id)
  if (resolve) {
    pending.delete(msg.id)
    resolve(msg)
  }
})

const waitFor = async (marker, timeoutMs = 10000) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (serverLog.includes(marker)) return true
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return serverLog.includes(marker)
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
    check('initialize advertises mcpCapabilities.http', init.agentCapabilities?.mcpCapabilities?.http === true)
    check('initialize advertises mcpCapabilities.sse=false', init.agentCapabilities?.mcpCapabilities?.sse === false)

    const created = await rpc('session/new', {
      cwd: process.cwd(),
      mcpServers: [{
        name: 'echo',
        type: 'stdio',
        command: process.execPath,
        args: [fixture],
        env: [],
      }],
    })
    check('session/new accepts mcpServers', typeof created.sessionId === 'string', `sessionId=${created.sessionId}`)

    const initialized = await waitFor('[echo-mcp] initialized')
    check('MCP server received initialize (mount happened)', initialized)

    const toolsListed = await waitFor('[echo-mcp] tools/list')
    check('MCP server received tools/list (tool discovery ran)', toolsListed)

    // A second session reusing the same server list must not re-mount.
    const before = serverLog.filter((line) => line === '[echo-mcp] initialized').length
    await rpc('session/new', {
      cwd: process.cwd(),
      mcpServers: [{
        name: 'echo',
        type: 'stdio',
        command: process.execPath,
        args: [fixture],
        env: [],
      }],
    })
    await new Promise((resolve) => setTimeout(resolve, 800))
    const after = serverLog.filter((line) => line === '[echo-mcp] initialized').length
    check('same server list is reused, not re-mounted', after === before, `initialized markers: ${before} → ${after}`)

    console.log(failed === 0 ? 'ALL CHECKS PASSED' : `${failed} CHECK(S) FAILED`)
  } finally {
    child.kill()
    if (tempProfile !== undefined) {
      spawnSync('rm', ['-rf', `${process.env.HOME}/.dsh/profiles/${tempProfile}`])
    }
  }
  process.exit(failed === 0 ? 0 : 1)
}

main()
