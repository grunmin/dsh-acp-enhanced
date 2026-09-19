#!/usr/bin/env node
/**
 * Launcher contract test for scripts/dsh-acp-zed.sh.
 *
 * The launcher boots a dsh *profile* inside the dsh home it was started with.
 * It must never rewrite DSH_HOME (the old isolated-home switch moved the profile
 * to ~/.dsh-acp behind the user's back), must fail loudly when the profile is
 * missing, and must warn on stderr — never stdout, which is the ACP wire — when
 * the home's shared dependency closure disagrees with the CLI it boots.
 *
 * The dsh binary is faked, so no harness process is started and no real dsh home
 * is touched. Usage: node scripts/acp-launcher-test.mjs
 */
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const launcher = join(repoDir, 'scripts/dsh-acp-zed.sh')
const scratch = mkdtempSync(join(tmpdir(), 'acp-launcher-test-'))

let failed = 0
function check(label, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failed += 1
}

/** A stand-in dsh that echoes the environment the launcher handed it. */
const fakeDsh = join(scratch, 'fake-dsh')
writeFileSync(fakeDsh, `#!/bin/bash
if [ "\${1:-}" = "--version" ]; then echo "\${FAKE_DSH_VERSION:-0.1.5-rc.2}"; exit 0; fi
echo "home=\${DSH_HOME:-<unset>} profile_dir=\${DSH_ACP_PROFILE_DIR:-<unset>} args=$*"
`)
chmodSync(fakeDsh, 0o755)

function run(home, extraEnv = {}) {
  return spawnSync('bash', [launcher, '--some-client-arg'], {
    encoding: 'utf8',
    env: { ...process.env, DSH_HOME: home, DSH_PATH: fakeDsh, DEEPSEEK_API_KEY: 'test-key', ...extraEnv },
  })
}

function seedProfile(home, name = 'acp-enhanced') {
  mkdirSync(join(home, 'profiles', name), { recursive: true })
}

function seedClosure(home, version) {
  const dir = join(home, 'profiles', 'node_modules', '@deepseek-ai', 'dsh-agent')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-agent', version }, null, 2))
}

try {
  // 1. Missing profile: loud failure, and the home is left untouched.
  const missingHome = join(scratch, 'missing-home')
  const missing = run(missingHome)
  check('missing profile exits 127', missing.status === 127, `status=${missing.status}`)
  check('missing profile explains itself on stderr',
    /not found at/.test(missing.stderr) && /plugin --profile acp-enhanced add/.test(missing.stderr),
    JSON.stringify(missing.stderr.split('\n')[0] ?? ''))
  check('missing profile writes nothing to stdout', missing.stdout === '', JSON.stringify(missing.stdout))
  check('missing profile does not create the home', !existsSync(missingHome))

  // 2. Seeded profile: boots, and DSH_HOME survives verbatim.
  const home = join(scratch, 'home')
  seedProfile(home)
  const ok = run(home)
  check('seeded profile exits 0', ok.status === 0, `status=${ok.status} stderr=${JSON.stringify(ok.stderr.trim())}`)
  check('DSH_HOME is passed through unchanged', ok.stdout.includes(`home=${home}`), JSON.stringify(ok.stdout.trim()))
  check('profile dir is computed from the home',
    ok.stdout.includes(`profile_dir=${join(home, 'profiles', 'acp-enhanced')}`), JSON.stringify(ok.stdout.trim()))
  check('the profile name and client args reach the CLI',
    ok.stdout.includes('args=--profile acp-enhanced --some-client-arg'), JSON.stringify(ok.stdout.trim()))
  check('no warning when no closure is seeded', !/warning/.test(ok.stderr), JSON.stringify(ok.stderr.trim()))

  // 3. Generation mismatch: stderr warning, stdout stays the ACP wire.
  seedClosure(home, '0.1.1-rc.2')
  const drift = run(home)
  check('mismatched closure still boots', drift.status === 0, `status=${drift.status}`)
  check('mismatched closure warns on stderr',
    /warning/.test(drift.stderr) && drift.stderr.includes('dsh-agent 0.1.1-rc.2') && drift.stderr.includes('0.1.5-rc.2'),
    JSON.stringify(drift.stderr.trim()))
  check('the warning never reaches stdout (ACP wire)', !/warning/.test(drift.stdout), JSON.stringify(drift.stdout.trim()))

  // 4. Matching closure: silent.
  seedClosure(home, '0.1.5-rc.2')
  const quiet = run(home)
  check('matching closure is silent', quiet.status === 0 && !/warning/.test(quiet.stderr),
    `status=${quiet.status} stderr=${JSON.stringify(quiet.stderr.trim())}`)

  // 5. Overrides: DSH_ACP_PROFILE / DSH_ACP_PROFILE_DIR win over the defaults.
  const otherHome = join(scratch, 'other-home')
  seedProfile(otherHome, 'custom')
  const overridden = run(otherHome, { DSH_ACP_PROFILE: 'custom' })
  check('DSH_ACP_PROFILE selects the profile', overridden.status === 0
    && overridden.stdout.includes('args=--profile custom'), JSON.stringify(overridden.stdout.trim()))
  const pinned = run(home, { DSH_ACP_PROFILE_DIR: join(home, 'profiles', 'acp-enhanced') })
  check('DSH_ACP_PROFILE_DIR is honored',
    pinned.stdout.includes(`profile_dir=${join(home, 'profiles', 'acp-enhanced')}`), JSON.stringify(pinned.stdout.trim()))
} finally {
  rmSync(scratch, { recursive: true, force: true })
}

console.log(failed === 0 ? '\nALL LAUNCHER CHECKS PASSED' : `\n${failed} CHECK(S) FAILED`)
process.exit(failed === 0 ? 0 : 1)
