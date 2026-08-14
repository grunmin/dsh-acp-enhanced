#!/usr/bin/env node
/**
 * Verifies the acp-enhanced web_search provider routes through an
 * OpenAI-Responses gateway. Spawns `dsh --profile acp-enhanced`, drives a
 * prompt that must call the model-facing `web` tool, and asserts a `tool_call`
 * named `web` completed (i.e. the registered `openai-responses` search
 * provider answered the gateway).
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
const notes = { webCalls: 0, anyErrors: 0, chunks: [] }
rl.on('line', (line) => {
  if (!line.trim() || !line.startsWith('{')) return
  let msg
  try { msg = JSON.parse(line) } catch { return }
  if (msg.id !== undefined) {
    const resolve = pending.get(msg.id)
    if (resolve) { pending.delete(msg.id); resolve(msg) }
    return
  }
  const u = msg.params?.update ?? {}
  if (u.sessionUpdate === 'tool_call' && (u.title === 'web_search' || u.title === 'web')) {
    notes.webCalls += 1
  }
  if (u.sessionUpdate === 'tool_call_update' && u.status === 'error') {
    notes.anyErrors += 1
  }
  if (u.sessionUpdate === 'agent_message_chunk') notes.chunks.push(u.content?.text ?? '')
})

function rpc(method, params, timeoutMs = 180000) {
  return new Promise((resolve, reject) => {
    const rid = String(++seq)
    const timer = setTimeout(() => { pending.delete(rid); reject(new Error(`timeout: ${method}`)) }, timeoutMs)
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
  await rpc('initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'web-search-test', version: '0.0.1' } })
  const created = await rpc('session/new', { cwd: process.cwd(), mcpServers: [] })
  check('session/new ok', typeof created.sessionId === 'string')

  const t0 = Date.now()
  const result = await rpc('session/prompt', {
    sessionId: created.sessionId,
    prompt: [{ type: 'text', text: '请用 web_search 工具搜索今天（2026年8月14日）AI 行业新闻，然后以 markdown 链接的形式列出你找到的来源 URL，并给出一句话总结。' }],
  })
  const ms = Date.now() - t0
  check('prompt settles', result.stopReason === 'end_turn', `stopReason=${result.stopReason} (${ms}ms)`)

  await sleep(500)
  check('model called the web tool', notes.webCalls >= 1, `webCalls=${notes.webCalls}`)
  check('no tool errored during the turn', notes.anyErrors === 0, `toolErrors=${notes.anyErrors}`)
  const all = notes.chunks.join(' ')
  console.log('\n--- assistant reply ---')
  console.log((all || '(none)').slice(0, 900))
  check('reply contains source URLs', /https?:\/\//.test(all), 'has http link(s)')
  check('reply cites multiple distinct sources', (all.match(/https?:\/\//g) ?? []).length >= 2, '>=2 links')

  console.log(failed === 0 ? '\nALL CHECKS PASSED (web_search via OpenAI-Responses gateway)' : `\n${failed} CHECK(S) FAILED`)
} catch (error) {
  console.error('\nFATAL:', error.message)
  failed += 1
  console.log(`\n${failed} CHECK(S) FAILED`)
} finally {
  child.kill('SIGTERM')
  await sleep(300)
  process.exit(failed === 0 ? 0 : 1)
}
