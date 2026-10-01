#!/usr/bin/env node
/**
 * Regression guard for `scripts/lib/boot-classify.mjs`.
 *
 * The doctor runs its boot at import time, so its classifier lives in a lib and
 * is pinned here instead. The cases below are the shapes that were wrong before
 * 0.10.0 shipped:
 *
 *   - a skipped bundle on a boot that still opened a thread must NOT classify
 *     as a failure, or the doctor reports `BOOT FAILED … the profile died (exit
 *     still running)` for a working profile and the skip never reaches the
 *     DEGRADED path (`inactiveEntries`);
 *   - a crash signature must outrank the skip line, or a duplicate loader entry
 *     (the row the user has to delete) is hidden behind an upgrade suggestion;
 *   - on a boot that *is* down for the skip, `manifest-gate` is still the layer.
 *
 * Usage: node scripts/boot-classify-test.mjs
 */
import { diagnose, inactiveEntries, skippedBundleOf } from './lib/boot-classify.mjs'

let failed = 0
function check(label, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failed += 1
}

const OPTIONS = {
  profileDir: '/home/u/.dsh/profiles/acp-enhanced',
  dshHome: '/home/u/.dsh',
  repoDir: '/pkg/dsh-acp-enhanced',
  supportedRange: '^0.1.5-rc.2 || ^0.1.6-alpha.1 || ^0.1.7-alpha.1 || ^0.2.0-rc.2',
  profileName: 'acp-enhanced',
  cliPath: '/pkg/dsh-acp-enhanced/node_modules/.bin/dsh',
  cliVersion: '0.2.0-rc.2',
  bridgeVersion: '0.10.0',
  bridgeName: 'dsh-acp-enhanced',
}

/** The exact stderr shape `dsh-app-boot` writes (JSON.stringify around the name). */
const skipLine = (name) =>
  `dsh: skipping profile bundle "${name}": Error: Plugin ${name}@1.0.0 is incompatible with dsh 0.2.0-rc.2: peerDependencies {"@deepseek-ai/dsh-agent":"^0.1.0"}. Running it may cause crashes or data loss.`

// ── 1. the skip is parsed from the host's own line shape ────────────────────
check('the skipped bundle name is read out of the JSON-quoted skip line',
  skippedBundleOf(skipLine('dsh-free-search')) === 'dsh-free-search',
  String(skippedBundleOf(skipLine('dsh-free-search'))))
check('a stderr with no skip line yields no name', skippedBundleOf('Error: boom') === undefined)

// ── 2. a healthy boot with a skipped bundle is not a failure ────────────────
const healthy = diagnose(skipLine('dsh-free-search'), { ...OPTIONS, bootOk: true })
check('a skipped bundle on a boot that opened a thread is not a failure layer',
  healthy === undefined, JSON.stringify(healthy))

// ── 3. a dead boot with only the skip is manifest-gate ──────────────────────
const dead = diagnose(skipLine('dsh-free-search'), { ...OPTIONS, bootOk: false })
check('a skipped bundle on a dead boot is the manifest-gate layer',
  dead?.layer === 'manifest-gate', JSON.stringify(dead?.layer))
check('the third-party subject names the bundle and the running dsh',
  dead?.subject === 'profile bundle dsh-free-search rejected by the CLI\'s peer gate (dsh 0.2.0-rc.2)',
  String(dead?.subject))
check('the third-party fix does not tell the user to upgrade this bridge',
  /This bridge is not the one being skipped/.test(dead?.fix ?? '')
  && /when another row depends on the skipped bundle/.test(dead?.fix ?? ''),
  JSON.stringify(dead?.fix?.slice(0, 80)))

const self = diagnose(skipLine('dsh-acp-enhanced'), { ...OPTIONS, bootOk: false })
check('a self-skip is manifest-gate with the bridge-specific fix',
  self?.layer === 'manifest-gate'
  && /this bridge's whole patch layer/.test(self?.fix ?? '')
  && (self?.fix ?? '').includes('dsh-acp-enhanced@0.10.0')
  && (self?.fix ?? '').includes('^0.2.0-rc.2'),
  JSON.stringify(self?.fix?.slice(0, 80)))

// ── 4. a crash signature outranks the skip ──────────────────────────────────
const dup = diagnose(`${skipLine('dsh-free-search')}\nError: duplicate loader entry id: tool-web`, { ...OPTIONS, bootOk: false })
check('a duplicate loader id outranks the skip line',
  dup?.layer === 'mount-time' && /duplicate loader entry id: tool-web/.test(dup?.subject ?? ''),
  JSON.stringify(dup?.subject))
const link = diagnose(`${skipLine('dsh-free-search')}\nError [ERR_MODULE_NOT_FOUND]: The requested module 'x' does not provide an export named 'y'`, { ...OPTIONS, bootOk: false })
check('a link-time signature outranks the skip line',
  link?.layer === 'link-time', JSON.stringify(link?.layer))
check('the link-time fix still names the resolved CLI path',
  (link?.fix ?? '').includes(OPTIONS.cliPath), JSON.stringify(link?.fix?.slice(0, 90)))
check('a crash-only stderr classifies without any skip line',
  diagnose('Error: failed to apply loader entry "tool-web"', { ...OPTIONS, bootOk: false })?.layer === 'mount-time')

// ── 5. inactiveEntries: the DEGRADED report of a still-working boot ─────────
const onlySkip = inactiveEntries([skipLine('dsh-free-search'), 'profile settled'])
check('a skip line alone is an inactive item even without an activation count',
  onlySkip.length === 1 && onlySkip[0].includes('skipping profile bundle "dsh-free-search"'),
  JSON.stringify(onlySkip))
const counted = inactiveEntries([
  'warning: 2 entries did not activate',
  'tool-web (tool-web): cannot find package',
  'tool-fs (tool-fs): boom',
])
check('the loader activation count still reports its entries',
  counted.length === 2 && counted[0] === 'tool-web (tool-web): cannot find package',
  JSON.stringify(counted))
const both = inactiveEntries([
  skipLine('dsh-free-search'),
  'warning: 1 entry did not activate',
  'tool-web (tool-web): cannot find package',
])
check('a skipped bundle and an inactive entry are reported together',
  both.length === 2 && /skipping profile bundle/.test(both[0]) && /tool-web/.test(both[1]),
  JSON.stringify(both))
check('a clean stderr yields no inactive items',
  inactiveEntries(['profile settled']).length === 0)
const long = inactiveEntries([`prefix skipping profile bundle "${'x'.repeat(300)}"`])
check('an over-long skip line is truncated', long[0].endsWith('…') && long[0].length === 241, String(long[0].length))

console.log(failed === 0 ? '\nALL BOOT-CLASSIFY CHECKS PASSED' : `\n${failed} CHECK(S) FAILED`)
process.exit(failed === 0 ? 0 : 1)
