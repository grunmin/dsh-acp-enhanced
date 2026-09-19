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
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const launcher = join(repoDir, 'scripts/dsh-acp-zed.sh')
const scratch = mkdtempSync(join(tmpdir(), 'acp-launcher-test-'))
/** The range the launcher must quote back comes from the manifest, so this
 *  assertion cannot drift when the declared floor moves. */
const declaredRange = JSON.parse(readFileSync(join(repoDir, 'package.json'), 'utf8'))
  .peerDependencies['@deepseek-ai/dsh-agent']

let failed = 0
function check(label, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failed += 1
}

/** A stand-in dsh that echoes the environment the launcher handed it. */
const fakeDsh = join(scratch, 'fake-dsh')
writeFileSync(fakeDsh, `#!/bin/bash
if [ "\${1:-}" = "--version" ]; then echo "\${FAKE_DSH_VERSION:-0.1.5-rc.2}"; exit 0; fi
if [ -n "\${FAKE_DSH_FAIL:-}" ]; then echo "\${FAKE_DSH_FAIL}" >&2; exit 1; fi
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

  // 6. Boot-failure translation: the raw signature is kept, one classified hint
  //    is added, and stdout stays the ACP wire.
  const cases = [
    {
      label: 'link-time',
      signature: "Error [ERR_MODULE_NOT_FOUND]: The requested module '@deepseek-ai/dsh-agent' does not provide an export named 'installModelSelection'",
      expect: /LINK-TIME failure/,
      detail: /@deepseek-ai\/dsh-agent/,
    },
    {
      label: 'mount-time',
      signature: 'Error: failed to apply loader entry "tool-web"',
      expect: /MOUNT-TIME failure/,
      detail: /acp-doctor\.mjs/,
    },
    {
      label: 'run-time',
      signature: 'TypeError: permission.optionOf is not a function',
      expect: /RUN-TIME failure/,
      detail: new RegExp(declaredRange.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    },
  ]
  for (const testCase of cases) {
    const failedBoot = run(home, { FAKE_DSH_FAIL: testCase.signature })
    check(`${testCase.label} failure is classified on stderr`,
      failedBoot.stderr.includes(testCase.signature) && testCase.expect.test(failedBoot.stderr) && testCase.detail.test(failedBoot.stderr),
      JSON.stringify(failedBoot.stderr.trim()))
    check(`${testCase.label} translation never reaches stdout`, failedBoot.stdout === '', JSON.stringify(failedBoot.stdout))
  }

  // 7. Supported-floor check: a user who upgrades the bridge but not the CLI
  //    must be told, instead of meeting a loader error that names an internal
  //    row. It warns, never blocks, and an unreadable version is ignored.
  const oldCli = run(home, { FAKE_DSH_VERSION: '0.1.1-rc.2' })
  check('a CLI below the supported range warns on stderr',
    /below the range this bridge supports/.test(oldCli.stderr) && oldCli.stderr.includes(declaredRange),
    JSON.stringify(oldCli.stderr.trim().split('\n')[0] ?? ''))
  check('the too-old warning does not block the boot',
    oldCli.status === 0 && /home=/.test(oldCli.stdout),
    `status=${oldCli.status} stdout=${JSON.stringify(oldCli.stdout.trim().slice(0, 60))}`)
  check('the too-old warning never reaches stdout',
    !/below the range/.test(oldCli.stdout), JSON.stringify(oldCli.stdout.trim().slice(0, 60)))
  const newCli = run(home, { FAKE_DSH_VERSION: '0.1.5-rc.2' })
  check('a supported CLI is not warned about', !/below the range/.test(newCli.stderr), JSON.stringify(newCli.stderr.trim()))
  const oddCli = run(home, { FAKE_DSH_VERSION: 'weird' })
  check('an unreadable CLI version is ignored, not warned about',
    oddCli.status === 0 && !/below the range/.test(oddCli.stderr),
    `status=${oddCli.status} stderr=${JSON.stringify(oddCli.stderr.trim())}`)

  // 8. Migration footgun: a user layer that still seeds a row the bundle patch
  //    now provides aborts the boot with a duplicate id, so say it up front.
  const seededHome = join(scratch, 'seeded-home')
  seedProfile(seededHome)
  writeFileSync(join(seededHome, 'profiles', 'acp-enhanced', 'cordis.patch.yml'),
    "- insert:\n    - id: subagent-model-selection-settings\n      name: '@deepseek-ai/dsh-tool-subagent/model-selection-settings'\n")
  mkdirSync(join(seededHome, 'profiles', 'acp-enhanced', 'node_modules', 'dsh-acp-enhanced'), { recursive: true })
  writeFileSync(join(seededHome, 'profiles', 'acp-enhanced', 'node_modules', 'dsh-acp-enhanced', 'cordis.patch.yml'),
    "- insert:\n    - id: subagent-model-selection-settings\n      name: '@deepseek-ai/dsh-tool-subagent/model-selection-settings'\n")
  const seeded = run(seededHome)
  check('a legacy user-layer host row is warned about before the boot',
    /still seeds 'subagent-model-selection-settings'/.test(seeded.stderr) && /init-acp-home\.sh/.test(seeded.stderr),
    JSON.stringify(seeded.stderr.trim().split('\n')[0] ?? ''))
  check('the duplicate-row warning never reaches stdout', !/still seeds/.test(seeded.stdout), JSON.stringify(seeded.stdout.trim().slice(0, 60)))
  // A comment naming the row must NOT trigger it (users keep explanatory notes).
  writeFileSync(join(seededHome, 'profiles', 'acp-enhanced', 'cordis.patch.yml'),
    '# the subagent-model-selection-settings row is provided by the bundle patch\n- id: acp-enhanced\n  config: {}\n')
  check('a comment mentioning the row is not a false positive', !/still seeds/.test(run(seededHome).stderr))

  // 9. The pre-0.9.0 launcher moved the profile to ~/.dsh-acp on its own; that
  //    home may still hold a working profile, so name it when it exists.
  const fakeHome = join(scratch, 'fakehome')
  mkdirSync(join(fakeHome, '.dsh-acp', 'profiles', 'acp-enhanced'), { recursive: true })
  const migrated = run(join(scratch, 'empty-home'), { HOME: fakeHome })
  check('a profile left under ~/.dsh-acp is pointed out',
    migrated.status === 127 && /Found an existing profile at/.test(migrated.stderr) && /DSH_HOME=/.test(migrated.stderr),
    `status=${migrated.status} stderr=${JSON.stringify(migrated.stderr.trim().split('\n').slice(-2).join(' | '))}`)
} finally {
  rmSync(scratch, { recursive: true, force: true })
}

console.log(failed === 0 ? '\nALL LAUNCHER CHECKS PASSED' : `\n${failed} CHECK(S) FAILED`)
process.exit(failed === 0 ? 0 : 1)
