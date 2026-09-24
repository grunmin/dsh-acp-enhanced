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
import { dshHome } from './lib/dsh-home.mjs'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const profile = `acp-ci-${process.pid}`

// Deterministic ordering coverage: slow the config-option assembly so the
// command broadcast must cross real event-loop turns (the cold-runner
// condition that raced it past the session/new response on CI). Unset to
// run against an un-delayed server.
process.env.DSH_TEST_SLOW_CATALOG_MS = process.env.DSH_TEST_SLOW_CATALOG_MS ?? '150'

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

    // The ACP mode list and the `permission_preset` config option are two views
    // of one table — both are built from `permissionPresets.optionOf()` — so
    // they must agree option-for-option on id/value, label and description.
    // Drift here is how the mode UI and the dropdown start disagreeing.
    const presetOption = (created.configOptions ?? []).find((o) => o.id === 'permission_preset')
    const advertisedModes = created.modes?.availableModes ?? []
    const presetShape = (entries) => entries
      .map((entry) => [String(entry.id ?? entry.value ?? ''), entry.name, entry.description ?? null])
      .sort((a, b) => a[0].localeCompare(b[0]))
    check('permission_preset options match the advertised modes',
      presetOption !== undefined && advertisedModes.length === presetOption.options.length
        && JSON.stringify(presetShape(advertisedModes)) === JSON.stringify(presetShape(presetOption.options)),
      `modes=${JSON.stringify(presetShape(advertisedModes))} options=${JSON.stringify(presetShape(presetOption?.options ?? []))}`)

    // ── multi-root workspaces: capability + lifecycle params ─────────────────
    // Zed renders "This agent doesn't currently support multi-root workspaces"
    // unless initialize advertises sessionCapabilities.additionalDirectories;
    // once advertised it sends every workspace root on session/new|load.
    const extraRoot = path.resolve(repo, 'lib')
    check('initialize advertises additionalDirectories',
      init.agentCapabilities?.sessionCapabilities?.additionalDirectories !== undefined)
    const multi = await rpc('session/new', {
      cwd: process.cwd(),
      additionalDirectories: [extraRoot, extraRoot, process.cwd()],
      mcpServers: [],
    })
    check('session/new accepts additionalDirectories', typeof multi.sessionId === 'string')
    // The JSONL persistence header becomes listable asynchronously; poll briefly.
    let listedMulti
    for (let attempt = 0; attempt < 20 && listedMulti === undefined; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 250))
      const listed = await rpc('session/list', { cwd: process.cwd() })
      listedMulti = (listed.sessions ?? []).find((s) => s.sessionId === multi.sessionId)
    }
    check('session/list reports the deduped additional roots',
      JSON.stringify(listedMulti?.additionalDirectories ?? []) === JSON.stringify([extraRoot]),
      JSON.stringify(listedMulti?.additionalDirectories ?? null))
    const reloaded = await rpc('session/load', {
      sessionId: multi.sessionId,
      cwd: process.cwd(),
      additionalDirectories: [extraRoot],
      mcpServers: [],
    })
    check('session/load accepts updated additionalDirectories', typeof reloaded?.sessionId === 'string' || reloaded !== undefined)
    const bad = await rpc('session/new', {
      cwd: process.cwd(),
      additionalDirectories: ['relative/path'],
      mcpServers: [],
    }).then(() => null, (error) => error)
    check('relative additionalDirectories rejected as invalid params',
      bad !== null && /absolute path/.test(bad.message), String(bad?.message))

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
      // Non-empty and vocabulary-legal: the per-model fallback chain replaced
      // the dropped effort with the model's own default (or its first offered
      // effort) instead of an empty selection that renders as "unknown".
      check('unsupported effort resets to a legal non-empty effort instead of unknown',
        after !== undefined && String(after.currentValue) !== '' && legalEfforts.includes(String(after.currentValue)),
        `sent=${illegal} current=${JSON.stringify(after?.currentValue)}`)
    } else {
      console.log(`SKIP  unsupported-effort reset (effort option: ${effortOption !== undefined ? 'all candidates legal' : 'absent'})`)
    }

    // Regression 2: the dropdown path itself — switching models must succeed.
    // Use a target the advertised catalog actually offers (provider-agnostic).
    const modelOption = (created.configOptions ?? []).find((o) => o.id === 'model')
    const modelValues = (modelOption?.options ?? []).flatMap((group) => (group.options ?? []).map((o) => String(o.value)))
    const origModelValue = modelOption?.currentValue
    const origEffortOption = (created.configOptions ?? []).find((o) => o.id === 'reasoning_effort')
    const origEfforts = (origEffortOption?.options ?? []).map((o) => String(o.value))
    const origEffortBefore = origEffortOption?.currentValue
    const alt = modelValues.find((value) => value !== origModelValue)
    if (alt !== undefined) {
      const switched = await rpc('session/set_config_option', { sessionId, configId: 'model', value: alt })
      const after = (switched.configOptions ?? []).find((o) => o.id === 'model')
      check('model switch via set_config_option succeeds', after?.currentValue === alt,
        `target=${alt} current=${JSON.stringify(after?.currentValue)}`)

      // Regression 3: per-model effort memory. The switch carries the old
      // model's effort onto the new one; the target must end up with a
      // non-empty, legal effort (never "unknown"). Then switch back and
      // assert the original route's effort is restored.
      const altEffort = (switched.configOptions ?? []).find((o) => o.id === 'reasoning_effort')
      const altEfforts = (altEffort?.options ?? []).map((o) => String(o.value))
      check('effort after model switch is non-empty and legal',
        altEffort === undefined || (String(altEffort.currentValue) !== '' && altEfforts.includes(String(altEffort.currentValue))),
        `current=${JSON.stringify(altEffort?.currentValue)}`)
      // Nudge the new model to a different legal effort, then switch back.
      const different = altEfforts.find((value) => value !== String(altEffort?.currentValue))
      if (altEffort !== undefined && different !== undefined) {
        await rpc('session/set_config_option', { sessionId, configId: 'reasoning_effort', value: different })
        const switchedBack = await rpc('session/set_config_option', { sessionId, configId: 'model', value: origModelValue })
        const backEffort = (switchedBack.configOptions ?? []).find((o) => o.id === 'reasoning_effort')
        const backEfforts = (backEffort?.options ?? []).map((o) => String(o.value))
        const sameVocabulary = JSON.stringify(backEfforts) === JSON.stringify(origEfforts)
        check('switch-back keeps a legal non-empty effort',
          backEffort === undefined || (String(backEffort.currentValue) !== '' && backEfforts.includes(String(backEffort.currentValue))),
          `current=${JSON.stringify(backEffort?.currentValue)}`)
        if (sameVocabulary) {
          // Same vocabulary: the carried effort is legal on the way back, so
          // the session simply keeps it (this is what the memory restores).
          check('switch-back keeps the carried effort (same vocabulary)',
            backEffort === undefined || String(backEffort.currentValue) === different,
            `restored=${JSON.stringify(backEffort?.currentValue)} expected=${different}`)
        } else {
          // Different vocabulary: the carried effort is unsupported on the way
          // back, so the per-model memory must restore the original effort.
          check('switch-back restores the remembered effort (different vocabulary)',
            backEffort === undefined || String(backEffort.currentValue) === String(origEffortBefore),
            `restored=${JSON.stringify(backEffort?.currentValue)} expected=${JSON.stringify(origEffortBefore)}`)
        }
      } else {
        console.log(`SKIP  effort memory restore (no alternate effort${altEffort === undefined ? '; model has no effort option' : ''})`)
      }
    } else {
      console.log('SKIP  model switch (only one advertised model)')
    }

    // Regression 4: a configured preset this roster does not have must not make
    // every session unopenable. dsh 0.1.7 stopped discovering
    // `$DSH_HOME/.agent-presets` (the roster became a registry fed by
    // declaration rows), so a stale `DSH_ACP_PRESET` / profile default is a
    // normal upgrade state rather than a crash: a *blank* session composes
    // under a preset the roster does offer and says so on stderr.
    {
      const bogus = 'acp-smoke-no-such-preset'
      const fallbackChild = spawn('dsh', ['--profile', profile], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, DSH_ACP_PRESET: bogus },
      })
      let fallbackStderr = ''
      let fallbackBuffer = ''
      const fallbackPending = new Map()
      fallbackChild.stderr.on('data', (data) => { fallbackStderr += String(data) })
      fallbackChild.stdout.on('data', (data) => {
        fallbackBuffer += String(data)
        const lines = fallbackBuffer.split('\n')
        fallbackBuffer = lines.pop()
        for (const line of lines) {
          if (!line.trim()) continue
          let message
          try {
            message = JSON.parse(line)
          } catch {
            continue
          }
          if (message.id !== undefined && fallbackPending.has(message.id)) {
            fallbackPending.get(message.id)(message)
            fallbackPending.delete(message.id)
          }
        }
      })
      let fallbackId = 0
      const ask = (method, params) => new Promise((settle) => {
        fallbackId += 1
        fallbackPending.set(fallbackId, settle)
        fallbackChild.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: fallbackId, method, params })}\n`)
      })
      try {
        await new Promise((settle) => setTimeout(settle, 1500))
        const handshake = await ask('initialize', { protocolVersion: 1, clientCapabilities: {} })
        const opened = handshake?.result === undefined
          ? undefined
          : await ask('session/new', { cwd: process.cwd(), mcpServers: [] })
        const presetOption = (opened?.result?.configOptions ?? []).find((option) => option.id === 'agent_preset')
        const offered = (presetOption?.options ?? []).map((option) => String(option.value))
        check('an unknown configured preset still opens a session',
          opened?.result?.sessionId !== undefined,
          opened?.error === undefined ? '' : JSON.stringify(opened.error).slice(0, 160))
        check('that session composes under an offered preset instead',
          offered.includes(String(presetOption?.currentValue)),
          `current=${JSON.stringify(presetOption?.currentValue)} offered=${offered.join(',')}`)
        check('the substitution is reported on stderr',
          fallbackStderr.includes(bogus) && fallbackStderr.includes('composing this session under'),
          JSON.stringify(fallbackStderr.trim().split('\n')[0] ?? ''))
      } finally {
        fallbackChild.kill()
      }
    }

    console.log(failed === 0 ? 'ALL CHECKS PASSED' : `${failed} CHECK(S) FAILED`)
  } finally {
    child.kill()
    spawnSync('rm', ['-rf', path.join(dshHome(), 'profiles', profile)])
  }
  process.exit(failed === 0 ? 0 : 1)
}

main()
