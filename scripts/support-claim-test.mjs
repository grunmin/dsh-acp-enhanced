#!/usr/bin/env node
/**
 * Guard for the support claim itself: the declared peer range, the CI boot
 * matrix and the link-check generations must describe the same set of lines,
 * and the shipped version helper must agree with the host's own gate.
 *
 * Why this exists (measured, 2026-09-30): `@deepseek-ai/dsh-app-boot` rejects a
 * profile bundle whose `@deepseek-ai/dsh*` peers do not satisfy the *running*
 * CLI version — `semver.satisfies(runtime, range, { includePrerelease: true })`
 * — and on the boot path it does so by silently dropping that bundle's whole
 * patch layer (`dsh: skipping profile bundle "…"`). Before the 0.2.0 support
 * work, `scripts/lib/dsh-version.mjs` reported `0.2.0-rc.2` as *supported*
 * against `^0.1.5-rc.2 || ^0.1.6-alpha.1 || ^0.1.7-alpha.1` while semver said
 * otherwise, so the launcher stayed quiet on a host that had already discarded
 * the bridge. Two gates, one claim — they are pinned against each other here.
 *
 * What it checks, all offline and dependency-light (the only import is `semver`
 * itself, a devDependency on purpose: the host gate's own resolver):
 *
 *   1. every declared `@deepseek-ai/dsh*` peer accepts every CI matrix version
 *      (a single un-widened range skips the whole bundle, not just that peer);
 *   2. every matrix version is inside the canonical declared range;
 *   3. every alternative of that range ("line") has a matrix version in it;
 *   4. every `compat-check.mjs` generation is inside the declared range, so the
 *      link check covers the lines the manifest claims;
 *   5. `isSupported` agrees with `semver.satisfies(…, { includePrerelease: true })`
 *      across every line edge — including the range that stopped at 0.1.7, which
 *      is what catches the caret-ceiling regression on its own;
 *   6. the shipped helper stays dependency-free and `semver` stays a
 *      devDependency (it boots inside the launcher, from the published package).
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import semver from 'semver'

import { isSupported } from './lib/dsh-version.mjs'

const repoDir = join(dirname(fileURLToPath(import.meta.url)), '..')
const HOST_OPTIONS = { includePrerelease: true }

let failed = 0
function check(label, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failed += 1
}

const manifest = JSON.parse(readFileSync(join(repoDir, 'package.json'), 'utf8'))
const peers = manifest.peerDependencies ?? {}
const dshPeers = Object.entries(peers).filter(([name]) => name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-'))
// The doctor reads this one as the canonical range, so the guard does too.
const range = peers['@deepseek-ai/dsh-agent']

const ciSource = readFileSync(join(repoDir, '.github/workflows/ci.yml'), 'utf8')
const matrix = /dsh-version:\s*\[([^\]]*)\]/.exec(ciSource)
const ciVersions = matrix === null
  ? []
  : [...matrix[1].matchAll(/'([^']+)'|"([^"]+)"/g)].map((m) => m[1] ?? m[2])

const compatSource = readFileSync(join(repoDir, 'scripts/compat-check.mjs'), 'utf8')
const compatVersions = [...compatSource.matchAll(/'@deepseek-ai\/dsh':\s*'([^']+)'/g)].map((m) => m[1])

// ── 1–2. the matrix and the manifest describe the same lines ────────────────
check('the canonical range is declared', typeof range === 'string' && range.length > 0, String(range))
check('the CI matrix names at least one version', ciVersions.length > 0, ciVersions.join(', '))

// Every peer must be part of the pinned devDependency closure — the set of
// packages this bundle actually links against. A peer that no `lib/` file
// imports is not a dependency of the bundle but of a *profile row*, and rows are
// resolved from the running CLI's own closure at boot. Declaring such a package
// as a peer is how `@deepseek-ai/dsh-agent-presets` (no release past 0.1.6) got
// force-installed into every 0.2.0 profile: from 0.1.7 the install path
// evaluates each patch row's resolved package with the same gate and rejects the
// entire installation (`incompatible-version`) when one of them disagrees.
const strays = Object.keys(peers).filter((name) => (manifest.devDependencies ?? {})[name] === undefined)
check('every declared peer is a devDependency of the pinned line', strays.length === 0, strays.join(', '))

const rejected = dshPeers.flatMap(([name, peerRange]) =>
  ciVersions.filter((version) => !semver.satisfies(version, peerRange, HOST_OPTIONS)).map((version) => `${name}@${peerRange} rejects ${version}`))
check('every dsh peer accepts every CI matrix version', rejected.length === 0, rejected.join('; '))

const outside = ciVersions.filter((version) => !semver.satisfies(version, range, HOST_OPTIONS))
check('every CI matrix version is inside the declared range', outside.length === 0, outside.join(', '))

// ── 3. every line the range claims is booted by the matrix ─────────────────
const lines = String(range).split('||').map((alternative) => alternative.trim()).filter(Boolean)
const uncovered = lines.filter((alternative) => {
  const floor = semver.minVersion(alternative)
  if (floor === null) return true
  const line = `${floor.major}.${floor.minor}`
  return !ciVersions.some((version) => version.startsWith(`${line}.`) && semver.satisfies(version, alternative, HOST_OPTIONS))
})
check('every declared line has a CI matrix version', uncovered.length === 0, uncovered.join('; '))

// ── 4. the link check covers the declared lines ─────────────────────────────
const unlinked = compatVersions.filter((version) => !semver.satisfies(version, range, HOST_OPTIONS))
check('every compat-check generation is inside the declared range', unlinked.length === 0, unlinked.join(', '))
const uncoveredGenerations = lines.filter((alternative) => {
  const floor = semver.minVersion(alternative)
  if (floor === null) return true
  return !compatVersions.some((version) => semver.satisfies(version, alternative, HOST_OPTIONS))
})
check('every declared line has a compat-check generation', uncoveredGenerations.length === 0, uncoveredGenerations.join('; '))

// ── 5. the shipped helper agrees with the host gate, edge by edge ───────────
// The 0.1.x range is kept as a fixture on purpose: it is the shape that was
// wrong, and it must stay wrong-free no matter what the manifest claims today.
const FIXTURE_RANGE = '^0.1.5-rc.2 || ^0.1.6-alpha.1 || ^0.1.7-alpha.1'
const VERSIONS = [
  '0.1.4-rc.9', '0.1.5-alpha.1', '0.1.5-rc.1', '0.1.5-rc.2', '0.1.5-rc.3', '0.1.5',
  '0.1.6-alpha.1', '0.1.6-alpha.2', '0.1.6', '0.1.7-alpha.1', '0.1.7-rc.1', '0.1.7-rc.2', '0.1.7',
  '0.1.8-rc.1', '0.1.9', '0.2.0-rc.1', '0.2.0-rc.2', '0.2.0', '0.2.1', '0.2.5',
  '0.3.0-rc.1', '0.3.0', '1.0.0',
]
const divergences = []
for (const candidate of [range, FIXTURE_RANGE]) {
  for (const version of VERSIONS) {
    const expected = semver.satisfies(version, candidate, HOST_OPTIONS)
    const actual = isSupported(version, candidate)
    if (actual !== expected) divergences.push(`${version} against ${candidate}: helper=${actual} semver=${expected}`)
  }
}
check(`the helper matches semver on all ${VERSIONS.length} line edges`, divergences.length === 0, divergences.slice(0, 4).join('; '))

// The ceiling rule is the whole point; assert it directly so a future helper
// rewrite cannot satisfy the parity table by coincidence.
check('a prerelease of the ceiling version is outside the range',
  isSupported('0.2.0-rc.2', FIXTURE_RANGE) === false && isSupported('0.2.0-rc.2', range) === true,
  `fixture=${isSupported('0.2.0-rc.2', FIXTURE_RANGE)} widened=${isSupported('0.2.0-rc.2', range)}`)
check('an unparseable version stays unknown, not unsupported',
  isSupported('not-a-version', range) === undefined && isSupported('0.1.7-rc.2', 'not-a-range') === undefined)

// ── 6. the shipped helper stays standalone ─────────────────────────────────
const helperSource = readFileSync(join(repoDir, 'scripts/lib/dsh-version.mjs'), 'utf8')
const helperImports = [...helperSource.matchAll(/^\s*import\s[^;]*from\s+'([^']+)'/gm)].map((m) => m[1])
check('the shipped helper imports only node builtins',
  helperImports.every((specifier) => specifier.startsWith('node:')),
  helperImports.join(', '))
check('semver is a devDependency, never a runtime dependency',
  manifest.devDependencies?.semver !== undefined && (manifest.dependencies?.semver ?? undefined) === undefined)

console.log(failed === 0
  ? `SUPPORT CLAIM OK (${lines.length} declared lines, ${ciVersions.length} matrix versions, ${compatVersions.length} link generations)`
  : `${failed} CHECK(S) FAILED`)
process.exit(failed === 0 ? 0 : 1)
