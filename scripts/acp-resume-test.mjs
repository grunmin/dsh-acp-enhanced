#!/usr/bin/env node
/**
 * End-to-end ACP test for session resume (`session/load`).
 *
 * Two bridge processes:
 *   Part 1 — creates a session, prompts it (history persists), prints the
 *            session id to a temp file, exits.
 *   Part 2 — loads that session via `session/load` and verifies the history
 *            is replayed to the client as user/assistant message chunks, then
 *            sends a follow-up prompt on the resumed agent.
 *
 * Run: node scripts/acp-resume-test.mjs   (needs the acp-enhanced profile)
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { ClientSideConnection, ndJsonStream } from '@agentclientprotocol/sdk'

const [cmd = 'dsh', ...rest] = process.argv.slice(2)
const args = rest.length > 0 ? rest : ['--profile', 'acp-enhanced']
const workdir = mkdtempSync(join(tmpdir(), 'acp-resume-'))
const sidFile = join(workdir, 'sid.txt')

let failed = 0
function check(label, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failed += 1
}

function spawnBridge() {
  const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'inherit'] })
  const stream = ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout))
  const connection = new ClientSideConnection(() => client(), stream)
  return { child, conn: connection }
}

const client = () => ({
  async sessionUpdate(params) {
    const kind = params?.update?.sessionUpdate
    if (kind === 'user_message_chunk' || kind === 'agent_message_chunk') {
      history.push({
        kind,
        text: params.update.content?.text ?? '',
      })
    }
    if (kind === 'tool_call') history.push({ kind, name: params.update.title })
    if (kind === 'tool_call_update') history.push({ kind, status: params.update.status })
  },
})

const history = []
let conn
try {
  // ── Part 1: create + prompt (persist) ────────────────────────────────────
  {
    const { child, conn: c } = spawnBridge()
    conn = c
    await c.initialize({
      protocolVersion: 1,
      clientInfo: { name: 'acp-resume-test', version: '0.1.0' },
      clientCapabilities: { session: { configOptions: { boolean: {} } } },
    })
    const created = await c.newSession({ cwd: process.cwd(), mcpServers: [] })
    const sessionId = created.sessionId
    check('part1 session/new ok', typeof sessionId === 'string' && sessionId.length > 0)
    const p1 = await c.prompt({
      sessionId,
      prompt: [{ type: 'text', text: '只回复三个字：你好呀' }],
    })
    check('part1 prompt settles', p1.stopReason === 'end_turn', p1.stopReason)
    writeFileSync(sidFile, sessionId, 'utf8')
    child.kill('SIGTERM')
    await new Promise((r) => setTimeout(r, 800)) // let persistence flush
  }

  // ── Part 2: load the persisted session ───────────────────────────────────
  const sid = readFileSync(sidFile, 'utf8')
  history.length = 0
  const { child, conn: c2 } = spawnBridge()
  conn = c2
  const init = await c2.initialize({
    protocolVersion: 1,
    clientInfo: { name: 'acp-resume-test', version: '0.1.0' },
    clientCapabilities: { session: { configOptions: { boolean: {} } } },
  })
  check('agent advertises loadSession', init.agentCapabilities?.loadSession === true,
    JSON.stringify(init.agentCapabilities?.loadSession))
  const loaded = await c2.loadSession({ sessionId: sid, cwd: process.cwd(), mcpServers: [] })
  check('session/load returns config', Array.isArray(loaded.configOptions) && loaded.configOptions.length >= 2,
    JSON.stringify((loaded.configOptions ?? []).map((o) => o.id)))
  await new Promise((r) => setTimeout(r, 500)) // let replay notifications drain
  const userChunks = history.filter((h) => h.kind === 'user_message_chunk')
  const agentChunks = history.filter((h) => h.kind === 'agent_message_chunk')
  check('history replays a user message', userChunks.length >= 1,
    JSON.stringify(userChunks.map((h) => h.text)))
  check('history replays the assistant reply', agentChunks.some((h) => h.text.includes('你好')),
    JSON.stringify(agentChunks.map((h) => h.text)))

  // follow-up prompt on the resumed agent
  const p2 = await c2.prompt({
    sessionId: sid,
    prompt: [{ type: 'text', text: '接着说一句话' }],
  })
  check('resumed agent accepts a follow-up', p2.stopReason === 'end_turn', p2.stopReason)
  child.kill('SIGTERM')
  await new Promise((r) => setTimeout(r, 500))

  console.log(failed === 0 ? '\nALL RESUME CHECKS PASSED' : `\n${failed} CHECK(S) FAILED`)
} catch (error) {
  console.error('\nFATAL:', error.message)
  failed += 1
  console.log(`\n${failed} CHECK(S) FAILED`)
} finally {
  try { rmSync(workdir, { recursive: true, force: true }) } catch { /* ignore */ }
  process.exit(failed === 0 ? 0 : 1)
}
