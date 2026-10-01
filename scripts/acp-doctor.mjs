#!/usr/bin/env node
/**
 * dsh-acp-enhanced doctor — one boot, four failure layers, one fix.
 *
 * The ACP bridge is a dsh *bundle*: it is linked (ESM), mounted (cordis loader)
 * and only then exercised (ACP `initialize`). Each layer fails differently and
 * dsh reports most of them as raw node/loader stacks, so this script boots the
 * profile exactly as Zed does — through the shipped launcher, so the CLI
 * resolution is the real one — and classifies the failure:
 *
 *   manifest-gate  the CLI's own peer gate rejected a bundle's declared
 *                  `@deepseek-ai/dsh*` peers and dropped its whole patch layer
 *                  (`skipping profile bundle …`). This one is not a stack: the
 *                  boot continues, so it is a failure layer only when the boot
 *                  has no crash signature to explain it; on a boot that still
 *                  opened a thread it is reported as DEGRADED instead.
 *   link-time      the booting CLI's closure cannot satisfy an import
 *                  (`does not provide an export named …`)
 *   mount-time     the loader rejected one entry and rethrew, taking the whole
 *                  profile down (one bundle is a single failure domain)
 *   run-time       the handshake reached the bridge, which then called a harness
 *                  method that does not exist on this CLI generation
 *
 * It always prints the environment (CLI, home, profile, every bundle + version,
 * the supported peer range) and, on failure, the offending bundle plus the exact
 * fix command. Exit code 0 = handshake OK; 1 = a classified failure, or a
 * **degraded** boot — an entry that never activated leaves ACP working with a
 * feature silently missing, which is exactly the state a handshake-only check
 * (and so the old result) called READY.
 *
 * Usage: node scripts/acp-doctor.mjs [--profile <name>] [--home <dir>] [--timeout <ms>]
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { diagnose, inactiveEntries } from './lib/boot-classify.mjs'
import { compareVersions, floorOfRange, isSupported } from './lib/dsh-version.mjs'

const repoDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const launcher = join(repoDir, 'scripts', 'dsh-acp-zed.sh')

function argOf(name) {
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}

const profileName = argOf('--profile') ?? process.env.DSH_ACP_PROFILE ?? 'acp-enhanced'
const dshHome = resolve(argOf('--home') ?? process.env.DSH_HOME ?? join(homedir(), '.dsh'))
const profileDir = process.env.DSH_ACP_PROFILE_DIR ?? join(dshHome, 'profiles', profileName)
const timeoutMs = Number(argOf('--timeout') ?? 45_000)
/** How long to keep watching after a successful handshake, for a profile that
 *  answers initialize and then dies on a later loader entry. */
const settleMs = Number(argOf('--settle') ?? 4_000)

/** Bundles this profile is allowed to carry: dsh-base ships with the CLI, so a
 *  profile of exactly these two cannot mismatch its own boot. */
const MINIMAL_BUNDLES = ['@deepseek-ai/dsh-base', 'dsh-acp-enhanced']

const readJson = (file) => {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return undefined
  }
}

/** The bridge's declared harness range, from its own package.json. */
const bridgeManifest = readJson(join(repoDir, 'package.json'))
const bridgeVersion = bridgeManifest?.version
const supportedRange = bridgeManifest?.peerDependencies?.['@deepseek-ai/dsh-agent'] ?? '(undeclared)'
/** The name the host prints for this bridge in a skipped-bundle line. */
const bridgeName = bridgeManifest?.name ?? 'dsh-acp-enhanced'
/** The range's floor: below it the CLI is too old, at or above it (yet outside
 *  the range) the CLI is from a line this bridge has not been verified against. */
const supportedFloor = floorOfRange(supportedRange)

/** Resolve the dsh CLI the same way the launcher does (directory-first DSH_PATH). */
function resolveCli() {
  const explicit = process.env.DSH_PATH
  if (explicit !== undefined && explicit.length > 0) {
    // Same contract as dsh-acp-zed.sh / init-acp-home.sh: a directory means
    // "checkout root" (node_modules/.bin/dsh inside), a file means the binary.
    // (The old trailing-slash convention is subsumed: stat says directory.)
    const isDir = existsSync(explicit) && statSync(explicit).isDirectory()
    if (!isDir && existsSync(explicit)) return { path: explicit, source: 'DSH_PATH' }
    const nested = join(explicit, 'node_modules', '.bin', 'dsh')
    if (existsSync(nested)) return { path: nested, source: 'DSH_PATH' }
    return { path: undefined, source: 'DSH_PATH (holds no dsh)' }
  }
  const local = join(repoDir, 'node_modules', '.bin', 'dsh')
  if (existsSync(local)) return { path: local, source: 'package-local' }
  const which = spawnSync('dsh', ['--version'], { encoding: 'utf8' })
  if (which.status === 0) return { path: 'dsh', source: 'PATH (global)' }
  return { path: undefined, source: 'not found' }
}

const cli = resolveCli()
const cliVersion = cli.path === undefined ? undefined : (spawnSync(cli.path, ['--version'], { encoding: 'utf8' }).stdout ?? '').trim()

/** One bundle's installed version: profile-local first, then the shared closure. */
function bundleVersion(name) {
  for (const base of [join(profileDir, 'node_modules', name), join(dshHome, 'profiles', 'node_modules', name)]) {
    const version = readJson(join(base, 'package.json'))?.version
    if (version !== undefined) return version
  }
  return undefined
}

const profileManifest = readJson(join(profileDir, 'package.json'))
const bundles = profileManifest?.dsh?.profile?.bundles ?? []
const closureVersion = readJson(join(dshHome, 'profiles', 'node_modules', '@deepseek-ai', 'dsh-agent', 'package.json'))?.version

console.log('dsh-acp-enhanced doctor')
console.log(`  bridge         ${readJson(join(repoDir, 'package.json'))?.version ?? '?'} (${repoDir})`)
console.log(`  supported dsh  ${supportedRange}`)
console.log(`  cli            ${cli.path ?? '<not found>'} ${cliVersion ?? ''} [${cli.source}]`)
console.log(`  home           ${dshHome}`)
console.log(`  profile        ${profileName} → ${profileDir}${existsSync(profileDir) ? '' : '  (MISSING)'}`)
console.log(`  closure        ${dshHome}/profiles/node_modules → @deepseek-ai/dsh-agent ${closureVersion ?? '<absent>'}`)
console.log('  bundles')
for (const name of bundles) {
  const version = bundleVersion(name)
  const marker = MINIMAL_BUNDLES.includes(name) ? '' : '  ← not minimal'
  console.log(`    - ${name} ${version ?? '<version unknown>'}${marker}`)
}
if (bundles.length === 0) console.log('    (none declared)')

if (bundles.some((name) => !MINIMAL_BUNDLES.includes(name))) {
  console.log('  note           a third-party bundle in the profile is a boot-wide failure domain:')
  console.log('                 cordis-plugin-loader rethrows the first rejected entry, so one bad')
  console.log(`                 bundle kills ACP. Move it into a preset composition instead.`)
}

/** The few stderr lines that actually carry the failure, not the stack tail. */
function evidenceLines(lines) {
  const interesting = lines
    .map((line) => line.trim())
    .filter((line) => /Error|failed to (?:apply|import) loader entry|does not provide an export|Host scope|Cannot find (?:package|module)|skipping profile bundle/.test(line))
    .filter((line) => !/^throw /.test(line))
    .map((line) => (line.length > 240 ? `${line.slice(0, 240)}…` : line))
  const picked = []
  for (const line of interesting) {
    if (picked.some((seen) => seen.includes(line) || line.includes(seen))) continue
    picked.push(line)
    if (picked.length === 3) break
  }
  return picked.length > 0 ? picked : lines.slice(-6)
}

if (!existsSync(profileDir)) {
  console.log('\nRESULT  FAIL — the profile does not exist, so nothing can boot.')
  console.log(`FIX     ${cli.path ?? 'dsh'} plugin --profile ${profileName} add link:${repoDir}`)
  process.exit(1)
}

// A CLI outside the supported range is the most common upgrade mistake, in both
// directions: the bridge updated and the CLI left behind, or the CLI moved to a
// line this bridge has not been verified against. Either way it is definitive
// and independent of the profile, so diagnose it before booting — on the newer
// side the host's peer gate would otherwise drop this bundle's whole patch layer
// with one stderr line and keep going.
if (isSupported(cliVersion, supportedRange) === false) {
  const belowFloor = supportedFloor !== undefined && compareVersions(cliVersion, supportedFloor) < 0
  console.log('')
  if (belowFloor) {
    console.log(`RESULT  FAIL — CLI too old: ${cliVersion} is below the supported range ${supportedRange}`)
    console.log('        The bridge targets one declared harness API line; older CLIs lack the')
    console.log('        services and package subpaths it uses, so the profile dies while loading.')
  } else {
    console.log(`RESULT  FAIL — CLI line not supported by this bridge: ${cliVersion} is outside ${supportedRange}`)
    console.log('        From 0.1.7 the host checks a bundle\'s declared @deepseek-ai/dsh* peers against')
    console.log('        the running CLI and drops the whole bundle, silently, when they do not match.')
    console.log('        A CLI from an unverified line therefore boots without this bridge — or refuses')
    console.log('        the install outright (`incompatible-version`).')
  }
  console.log('FIX     npm install -g @deepseek-ai/dsh@<version in that range>')
  console.log(`        or pin this launcher to a supported CLI: DSH_PATH=<path-to-dsh> (now ${cli.path ?? 'unresolved'})`)
  process.exit(1)
}

// ── one real boot: the launcher, the ACP handshake, and the stderr ───────────
const child = spawn('bash', [launcher], {
  env: {
    ...process.env,
    DSH_HOME: dshHome,
    DSH_ACP_PROFILE: profileName,
    ...process.env.DSH_ACP_PROFILE_DIR === undefined ? { DSH_ACP_PROFILE_DIR: profileDir } : {},
  },
  stdio: ['pipe', 'pipe', 'pipe'],
})

const stderrLines = []
let stdout = ''
let exited
const pending = new Map()

child.stderr.on('data', (buffer) => {
  for (const line of String(buffer).split('\n')) if (line.trim().length > 0) stderrLines.push(line)
})
child.stdout.on('data', (buffer) => {
  stdout += String(buffer)
  for (const line of stdout.split('\n')) {
    if (line.trim().length === 0) continue
    let message
    try {
      message = JSON.parse(line)
    } catch {
      continue
    }
    if (message.id !== undefined && pending.has(message.id)) {
      pending.get(message.id)(message)
      pending.delete(message.id)
    }
  }
})
child.on('exit', (code) => { exited = code ?? 0 })

/** Write one request and resolve with its response, or undefined on timeout. */
function request(id, method, params, waitMs) {
  return new Promise((resolveWait) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      resolveWait(undefined)
    }, waitMs)
    pending.set(id, (message) => {
      clearTimeout(timer)
      resolveWait(message)
    })
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
  })
}

const handshake = await request('doctor/initialize', 'initialize', { protocolVersion: 1, clientCapabilities: {} }, timeoutMs)

// A broken bundle can fail AFTER the ACP server has answered: the transport
// mounts before the rest of the profile tree, so `initialize` succeeds and the
// process dies right after — exactly the opaque hang a client reports. Confirm
// the boot actually settled before calling the profile healthy.
if (handshake?.result !== undefined && exited === undefined) {
  const settleUntil = Date.now() + settleMs
  while (exited === undefined && Date.now() < settleUntil) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 100))
  }
}

// Opening a thread is the step a user actually cares about, and it exercises
// more than the handshake: composing an agent preset (which mounts plugins in a
// fresh scope). A bridge older than its CLI answers `initialize` and then fails
// every `session/new` — invisible to a handshake-only check.
let opened
if (handshake?.result !== undefined && exited === undefined) {
  opened = await request('doctor/session-new', 'session/new', { cwd: process.cwd(), mcpServers: [] }, 30_000)
}
const createdSessionId = opened?.result?.sessionId

// A diagnostic must not litter the archive, and `session/delete` does not exist
// (no public persistence delete upstream), so remove the throwaway session's
// artifact directly — it has no events beyond its header.
if (createdSessionId !== undefined) {
  const sessionsRoot = join(dshHome, 'sessions')
  if (existsSync(sessionsRoot)) {
    for (const slug of readdirSync(sessionsRoot)) {
      rmSync(join(sessionsRoot, slug, createdSessionId), { recursive: true, force: true })
    }
  }
}

// An error response is a failure too: fold its message into the evidence the
// classifier reads AND into the evidence we print (a session/new refusal is an
// RPC error, not a stderr line).
const responseEvidence = [
  handshake?.error === undefined ? undefined : `initialize -> ${JSON.stringify(handshake.error)}`,
  opened?.error === undefined ? undefined : `session/new -> ${JSON.stringify(opened.error)}`,
].filter((part) => part !== undefined)
const stderr = [stderrLines.join('\n'), ...responseEvidence].filter((part) => part.length > 0).join('\n')
const evidence = [...stderrLines, ...responseEvidence]
const agentInfo = handshake?.result?.agentInfo
// A boot is healthy when the handshake was answered, the process is still up,
// and a real thread opened. On that boot a skipped bundle is a missing
// capability (the DEGRADED report below), never the failure layer — and when
// the boot *is* down, a crash signature outranks the skip (diagnose does both).
const bootOk = handshake?.result !== undefined && exited === undefined && createdSessionId !== undefined
const failure = diagnose(stderr, {
  bootOk, profileDir, dshHome, repoDir, supportedRange, profileName, cliPath: cli.path, cliVersion, bridgeVersion, bridgeName,
})
child.kill('SIGTERM')

console.log('')
if (bootOk && failure === undefined) {
  console.log(`BOOT    OK — ACP initialize answered (agent ${agentInfo?.name ?? '?'} ${agentInfo?.version ?? '?'}), the profile settled, and session/new opened a thread.`)
  if (closureVersion !== undefined && cliVersion !== undefined && closureVersion !== cliVersion) {
    console.log(`WARN    the shared closure holds @deepseek-ai/dsh-agent ${closureVersion} but the CLI is ${cliVersion}; restart the other dsh processes under this home.`)
  }
  const inactive = inactiveEntries(stderrLines)
  if (inactive.length > 0) {
    console.log(`DEGRADED ${inactive.length} inactive ${inactive.length === 1 ? 'item' : 'items'} — the boot`)
    console.log('        continued, so this is a missing feature rather than a failure:')
    for (const line of inactive) console.log(`        ${line}`)
    console.log('FIX     upgrade that bundle (a harness export it imports may have been renamed or')
    console.log('        removed in this dsh line, or its declared dsh peers may not match this CLI),')
    console.log('        or take it out of the profile.')
    console.log(`RESULT  DEGRADED — ACP works; ${inactive.length} ${inactive.length === 1 ? 'item is' : 'items are'} not running.`)
    process.exit(1)
  }
  console.log('RESULT  READY')
  process.exit(0)
}

if (handshake?.result !== undefined && exited === undefined && createdSessionId === undefined) {
  console.log('BOOT    FAILED at session/new — the handshake and the profile load are fine, but no')
  console.log('        thread can open, so every new Zed agent thread fails')
  console.log(`        (${opened === undefined ? 'no response inside the timeout' : 'the request was refused'}).`)
} else if (handshake?.result !== undefined) {
  if (exited !== undefined) {
    console.log('BOOT    FAILED after the handshake — initialize was answered, then the profile died')
    console.log(`        (exit ${exited}); a client sees this as an opaque hang, not an error.`)
  } else {
    console.log('BOOT    FAILED after the handshake — initialize was answered and a thread opened,')
    console.log('        but the boot reported a failure; the layer below names it.')
  }
} else {
  console.log(`BOOT    FAILED — ${exited === undefined ? 'no handshake inside the timeout' : `exited before the handshake (${exited})`}`)
}
if (failure === undefined) {
  console.log('LAYER   unclassified — the stderr evidence below:')
  for (const line of evidenceLines(evidence)) console.log(`        ${line}`)
  console.log(`FIX     trim the profile's bundles to ${MINIMAL_BUNDLES.join(' + ')}, then bisect.`)
} else {
  console.log(`LAYER   ${failure.layer}`)
  console.log(`SUBJECT ${failure.subject}`)
  console.log(`FIX     ${failure.fix}`)
  console.log('        evidence:')
  for (const line of evidenceLines(evidence)) console.log(`        ${line}`)
}
process.exit(1)
