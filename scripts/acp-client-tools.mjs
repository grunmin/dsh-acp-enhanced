#!/usr/bin/env node
/**
 * End-to-end ACP test for the client-forwarding tools (Zed fs / terminal).
 *
 * Drives `dsh --profile acp-enhanced` with a mock CLIENT that advertises the
 * same capabilities Zed does (fs.readTextFile / fs.writeTextFile / terminal),
 * then verifies:
 *   - session/new no longer advertises an empty `reasoning_effort` option
 *     when the routed model exposes no reasoning efforts;
 *   - the agent's `zed_write_text_file` / `zed_read_text_file` / `zed_terminal`
 *     calls reach the client as `fs/write_text_file`, `fs/read_text_file`,
 *     `terminal/create` requests carrying the session id and args.
 *
 * Run: node scripts/acp-client-tools.mjs   (needs the acp-enhanced profile)
 */
import { spawn } from 'node:child_process'
import { Readable, Writable } from 'node:stream'
import { ClientSideConnection, ndJsonStream } from '@agentclientprotocol/sdk'

const [cmd = 'dsh', ...rest] = process.argv.slice(2)
const args = rest.length > 0 ? rest : ['--profile', 'acp-enhanced']

const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'inherit'] })
const stream = ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout))

const received = { writes: [], reads: [], terminals: [], elicitations: [] }

// Tap the raw stream: log every non-session/update line so request/response
// traffic (fs/..., terminal/...) is visible.
import readline from 'node:readline'
const rawRl = readline.createInterface({ input: child.stdout })
rawRl.on('line', (line) => {
  if (!line.trim()) return
  let msg
  try { msg = JSON.parse(line) } catch { return }
  if (msg.method !== 'session/update') {
    console.log('WIRE:', JSON.stringify(msg).slice(0, 300))
  }
})

const client = {
  async sessionUpdate(params) {
    const kind = params?.update?.sessionUpdate
    if (kind === 'tool_call' || kind === 'tool_call_update') {
      console.log('CLIENT session/update:', kind, params?.update?.title ?? params?.update?.status)
    }
  },
  async writeTextFile(params) {
    console.log('CLIENT fs/write_text_file ->', JSON.stringify({ path: params.path, len: params.content?.length }))
    received.writes.push(params)
    return {}
  },
  async readTextFile(params) {
    console.log('CLIENT fs/read_text_file ->', params.path)
    received.reads.push(params)
    return { content: `mock content of ${params.path}` }
  },
  async createTerminal(params) {
    console.log('CLIENT terminal/create ->', params.command)
    received.terminals.push(params)
    return { terminalId: 'term-1' }
  },
  async terminalOutput(params) {
    return { output: 'hello from the mock terminal\n', truncated: false, exitStatus: { exitCode: 0, signal: null } }
  },
  async waitForTerminalExit() {
    return { exitCode: 0 }
  },
  async releaseTerminal() {},
  async killTerminal() {},
  async unstable_createElicitation(params) {
    console.log('CLIENT elicitation/create (form) ->', JSON.stringify({ message: params.message?.slice(0, 60), props: Object.keys(params.requestedSchema?.properties ?? {}) }))
    received.elicitations.push(params)
    const content = {}
    for (const id of Object.keys(params.requestedSchema?.properties ?? {})) {
      content[id] = '是'
    }
    return { action: 'accept', content }
  },
  async requestPermission(params) {
    console.log('CLIENT: request_permission ->', JSON.stringify(params).slice(0, 160))
    return { outcome: 'allowed', optionId: 'allow-once' }
  },
}

const conn = new ClientSideConnection(() => client, stream)

let failed = 0
function check(label, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failed += 1
}

try {
  const init = await conn.initialize({
    protocolVersion: 1,
    clientInfo: { name: 'acp-client-tools-test', version: '0.1.0' },
    clientCapabilities: {
      fs: { readTextFile: true, writeTextFile: true },
      terminal: true,
      session: { configOptions: { boolean: {} } },
      elicitation: { form: {}, url: {} },
    },
  })
  check('initialize negotiated', init.protocolVersion !== undefined)

  const created = await conn.newSession({ cwd: process.cwd(), mcpServers: [] })
  const sessionId = created.sessionId
  const optionIds = (created.configOptions ?? []).map((o) => o.id)
  check('config options advertised', optionIds.includes('model') && optionIds.includes('permission_preset'),
    JSON.stringify(optionIds))
  check('empty reasoning_effort option suppressed', !optionIds.includes('reasoning_effort'),
    JSON.stringify(optionIds))

  // ── prompt 1: write through the editor ───────────────────────────────────
  const p1 = await conn.prompt({
    sessionId,
    prompt: [{
      type: 'text',
      text: '使用 zed_write_text_file 工具，把内容 "hello acp" 写入文件 /tmp/acp-client-tools-test.txt。不要用其他工具。',
    }],
  })
  check('write prompt settles', p1.stopReason === 'end_turn', `stopReason=${p1.stopReason}`)
  check('fs/write_text_file reached the client', received.writes.length >= 1,
    JSON.stringify(received.writes.map((w) => w.path)))
  if (received.writes.length > 0) {
    const w = received.writes[0]
    check('write carries session id', w.sessionId === sessionId)
    check('write carries path+content', w.path === '/tmp/acp-client-tools-test.txt' && w.content === 'hello acp',
      JSON.stringify({ path: w.path, content: w.content }))
  }

  // ── prompt 2: read through the editor ────────────────────────────────────
  const p2 = await conn.prompt({
    sessionId,
    prompt: [{
      type: 'text',
      text: '使用 zed_read_text_file 工具读取 /tmp/acp-client-tools-test.txt，然后复述你读到的内容。不要用其他工具。',
    }],
  })
  check('read prompt settles', p2.stopReason === 'end_turn', `stopReason=${p2.stopReason}`)
  check('fs/read_text_file reached the client', received.reads.length >= 1,
    JSON.stringify(received.reads.map((r) => r.path)))

  // ── prompt 3: terminal through the editor ────────────────────────────────
  const p3 = await conn.prompt({
    sessionId,
    prompt: [{
      type: 'text',
      text: '使用 zed_terminal 工具运行命令 echo hi（在 /tmp 目录）。不要用其他工具。',
    }],
  })
  check('terminal prompt settles', p3.stopReason === 'end_turn', `stopReason=${p3.stopReason}`)
  check('terminal/create reached the client', received.terminals.length >= 1,
    JSON.stringify(received.terminals.map((t) => ({ cmd: t.command, cwd: t.cwd }))))

  // ── prompt 4: ask the user through an editor form ────────────────────────
  const p4 = await conn.prompt({
    sessionId,
    prompt: [{
      type: 'text',
      text: '使用 ask_user_question 工具向用户问一个问题：id 为 cont，内容为 "继续吗？"，选项 ["是","否"]。不要用其他工具。',
    }],
  })
  check('elicitation prompt settles', p4.stopReason === 'end_turn', `stopReason=${p4.stopReason}`)
  check('elicitation form reached the client', received.elicitations.length >= 1,
    JSON.stringify(received.elicitations.map((e) => Object.keys(e.requestedSchema?.properties ?? {}))))
  if (received.elicitations.length > 0) {
    const e = received.elicitations[0]
    check('elicitation carries session id', e.sessionId === sessionId)
    check('elicitation form has the question property',
      e.requestedSchema?.properties?.cont !== undefined && e.mode === 'form')
    check('elicitation enum carries the options',
      JSON.stringify(e.requestedSchema?.properties?.cont?.enum ?? []) === JSON.stringify(['是', '否']))
  }

  console.log(failed === 0 ? '\nALL CLIENT-TOOLS CHECKS PASSED' : `\n${failed} CHECK(S) FAILED`)
} catch (error) {
  console.error('\nFATAL:', error.message)
  failed += 1
  console.log(`\n${failed} CHECK(S) FAILED`)
} finally {
  child.kill('SIGTERM')
  await new Promise((r) => setTimeout(r, 300))
  process.exit(failed === 0 ? 0 : 1)
}
