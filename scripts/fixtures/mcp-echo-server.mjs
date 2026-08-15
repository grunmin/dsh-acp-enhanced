#!/usr/bin/env node
/**
 * Minimal stdio MCP server used by acp-mcp-test.mjs: answers initialize,
 * tools/list and tools/call over JSON-RPC/stdio, and echoes a marker line on
 * stderr when initialized so the harness test can observe the mount.
 */
import readline from 'node:readline'

const respond = (id, result) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`)

const rl = readline.createInterface({ input: process.stdin })
rl.on('line', (line) => {
  if (!line.trim()) return
  let msg
  try {
    msg = JSON.parse(line)
  } catch {
    return
  }
  switch (msg.method) {
    case 'initialize':
      process.stderr.write('[echo-mcp] initialized\n')
      respond(msg.id, {
        protocolVersion: '2025-03-26',
        capabilities: { tools: {} },
        serverInfo: { name: 'echo-mcp', version: '1.0.0' },
      })
      break
    case 'notifications/initialized':
      break
    case 'tools/list':
      process.stderr.write('[echo-mcp] tools/list\n')
      respond(msg.id, {
        tools: [{
          name: 'echo',
          description: 'Echo the provided text back.',
          inputSchema: {
            type: 'object',
            properties: { text: { type: 'string' } },
            required: ['text'],
          },
        }],
      })
      break
    case 'tools/call':
      respond(msg.id, {
        content: [{ type: 'text', text: String(msg.params?.arguments?.text ?? '') }],
      })
      break
    default:
      respond(msg.id, {})
  }
})
