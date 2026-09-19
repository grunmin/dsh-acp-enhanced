#!/usr/bin/env node
/**
 * dsh-acp-enhanced doctor — one boot, three failure layers, one fix.
 *
 * The ACP bridge is a dsh *bundle*: it is linked (ESM), mounted (cordis loader)
 * and only then exercised (ACP `initialize`). Each layer fails differently and
 * dsh reports all three as raw node/loader stacks, so this script boots the
 * profile exactly as Zed does — through the shipped launcher, so the CLI
 * resolution is the real one — and classifies the failure:
 *
 *   link-time   the booting CLI's closure cannot satisfy an import
 *               (`does not provide an export named …`)
 *   mount-time  the loader rejected one entry and rethrew, taking the whole
 *               profile down (one bundle is a single failure domain)
 *   run-time    the handshake reached the bridge, which then called a harness
 *               method that does not exist on this CLI generation
 *
 * It always prints the environment (CLI, home, profile, every bundle + version,
 * the supported peer range) and, on failure, the offending bundle plus the exact
 * fix command. Exit code 0 = handshake OK, 1 = classified failure.
 *
 * Usage: node scripts/acp-doctor.mjs [--profile <name>] [--home <dir>] [--timeout <ms>]
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

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
const supportedRange = readJson(join(repoDir, 'package.json'))?.peerDependencies?.['@deepseek-ai/dsh-agent'] ?? '(undeclared)'

/** Resolve the dsh CLI the same way the launcher does. */
function resolveCli() {
  const explicit = process.env.DSH_PATH
  if (explicit !== undefined && explicit.length > 0) {
    if (existsSync(explicit) && !explicit.endsWith('/')) return { path: explicit, source: 'DSH_PATH' }
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

/** Classify one boot failure from the stderr the launcher collected.
 *
 *  Order matters: a mount failure *wraps* its cause, so `failed to apply loader
 *  entry …: Cannot find package …` carries both signatures. The unambiguous
 *  link-time signature (a missing named export) wins; otherwise a loader
 *  rejection is mount-time; a bare unresolved import is the bridge's own graph.
 */
function classify(stderr) {
  const firstOf = (pattern) => stderr.match(pattern)?.[1]
  if (/does not provide an export named|SyntaxError: The requested module/.test(stderr)) {
    const moduleName = firstOf(/module '([^']+)'/)
    return {
      layer: 'link-time',
      subject: moduleName ?? 'a harness bundle',
      fix: `the closure was healed to a different CLI generation. Restart the other dsh processes under ${dshHome}, or pin this launcher to the matching CLI with DSH_PATH (resolved: ${cli.path ?? 'none'}, supported: ${supportedRange}).`,
    }
  }
  if (/failed to apply loader entry|failed to import loader entry|in the Host scope|requires .* to be available|cannot resolve plugin/.test(stderr)) {
    // The outermost rejection wraps the real one, so read the innermost entry.
    const entry = firstOf(/failed to import loader entry "?([^"\s(]+)"?/)
      ?? firstOf(/failed to apply loader entry "?([^"\s(]+)"?/)
      ?? firstOf(/entry "([^"]+)"/)
      ?? firstOf(/requires "([^"]+)"/)
      ?? firstOf(/\[plugin: ([^\]]+)\]/)
    const moduleName = firstOf(/failed to import loader entry [^(]*\(([^)]+)\)/)
      ?? firstOf(/Cannot find package '([^']+)'/)
    return {
      layer: 'mount-time',
      subject: moduleName === undefined ? (entry ?? 'one loader entry') : `${entry ?? 'an entry'} (${moduleName})`,
      fix: `one rejected entry takes the whole profile down. Disable or remove it in ${join(profileDir, 'cordis.patch.yml')}, install the missing module, or move the third-party bundle out of the profile into a preset composition.`,
    }
  }
  if (/ERR_MODULE_NOT_FOUND/.test(stderr)) {
    const moduleName = firstOf(/Cannot find (?:package|module) '([^']+)'/)
    return {
      layer: 'link-time',
      subject: moduleName ?? 'a harness bundle',
      fix: 'the profile is missing a module its bundle graph imports. Install it in the profile (dsh plugin add …) or trim the bundle.',
    }
  }
  if (/is not a function|is not a valid method|Cannot read properties of (undefined|null)/.test(stderr)) {
    return {
      layer: 'run-time',
      subject: 'a harness service method',
      fix: `this CLI generation (${cliVersion ?? 'unknown'}) does not provide it; the bridge supports ${supportedRange}. Upgrade: npm install -g @deepseek-ai/dsh@<version in that range>.`,
    }
  }
  return undefined
}

/** The few stderr lines that actually carry the failure, not the stack tail. */
function evidenceLines(lines) {
  const interesting = lines
    .map((line) => line.trim())
    .filter((line) => /Error|failed to (?:apply|import) loader entry|does not provide an export|Host scope|Cannot find (?:package|module)/.test(line))
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
let handshake
let exited

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
    if (message.id === 'doctor') handshake = message
  }
})
child.on('exit', (code) => { exited = code ?? 0 })

child.stdin.write(`${JSON.stringify({
  jsonrpc: '2.0',
  id: 'doctor',
  method: 'initialize',
  params: { protocolVersion: 1, clientCapabilities: {} },
})}\n`)

const deadline = Date.now() + timeoutMs
while (handshake === undefined && exited === undefined && Date.now() < deadline) {
  await new Promise((resolveWait) => setTimeout(resolveWait, 200))
}

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

// An error response is a failure too: fold its message into the evidence the
// classifier reads.
const stderr = [stderrLines.join('\n'), handshake?.error === undefined ? '' : JSON.stringify(handshake.error)]
  .filter((part) => part.length > 0)
  .join('\n')
const agentInfo = handshake?.result?.agentInfo
const failure = classify(stderr)
child.kill('SIGTERM')

console.log('')
if (handshake?.result !== undefined && exited === undefined && failure === undefined) {
  console.log(`BOOT    OK — ACP initialize answered (agent ${agentInfo?.name ?? '?'} ${agentInfo?.version ?? '?'}) and the profile settled.`)
  if (closureVersion !== undefined && cliVersion !== undefined && closureVersion !== cliVersion) {
    console.log(`WARN    the shared closure holds @deepseek-ai/dsh-agent ${closureVersion} but the CLI is ${cliVersion}; restart the other dsh processes under this home.`)
  }
  console.log('RESULT  READY')
  process.exit(0)
}

if (handshake?.result !== undefined) {
  console.log('BOOT    FAILED after the handshake — initialize was answered, then the profile died')
  console.log(`        (exit ${exited ?? 'still running'}); a client sees this as an opaque hang, not an error.`)
} else {
  console.log(`BOOT    FAILED — ${exited === undefined ? 'no handshake inside the timeout' : `exited before the handshake (${exited})`}`)
}
if (failure === undefined) {
  console.log('LAYER   unclassified — the stderr evidence below:')
  for (const line of evidenceLines(stderrLines)) console.log(`        ${line}`)
  console.log(`FIX     trim the profile's bundles to ${MINIMAL_BUNDLES.join(' + ')}, then bisect.`)
} else {
  console.log(`LAYER   ${failure.layer}`)
  console.log(`SUBJECT ${failure.subject}`)
  console.log(`FIX     ${failure.fix}`)
  console.log('        evidence:')
  for (const line of evidenceLines(stderrLines)) console.log(`        ${line}`)
}
process.exit(1)
