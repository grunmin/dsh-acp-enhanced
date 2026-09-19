#!/usr/bin/env node
/**
 * Package-integrity check: assert the published tarball before npm sees it.
 *
 * `npm pack --dry-run` on its own only *prints* the file list — it fails for
 * nothing, so it cannot catch a package whose manifest, modes or shipped-file
 * references drifted. This asserts the four things that actually break an
 * install:
 *
 *   1. the entry points ship (`main`, every `exports` target, the bundle patch)
 *   2. nothing dev-only ships (a stripped `files` whitelist used to be the only
 *      thing standing between this repo and a tarball full of tests)
 *   3. every path a shipped file points at is itself shipped — a relative
 *      import, or a `scripts/...` path printed in a user-facing message
 *   4. modes are usable by a second user: a shared or system-wide install must
 *      be able to read what it runs (600/711 in the tarball is silent breakage)
 *
 * Usage: node scripts/pack-check.mjs  (needs npm; writes nothing)
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join, posix, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')

let failed = 0
function check(label, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failed += 1
}

const manifest = JSON.parse(readFileSync(join(repoDir, 'package.json'), 'utf8'))
const packed = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json'], { cwd: repoDir, encoding: 'utf8' }))[0]
const shipped = new Map(packed.files.map((entry) => [entry.path, entry]))
const read = (path) => readFileSync(join(repoDir, path), 'utf8')

// ── 1. the entry points must ship ───────────────────────────────────────────
const entryPoints = new Set([manifest.main, manifest.dsh?.bundle?.patch]
  .map((path) => path?.replace(/^\.\//, '')))
for (const target of Object.values(manifest.exports ?? {})) {
  if (typeof target === 'string') entryPoints.add(target.replace(/^\.\//, ''))
}
const missingEntries = [...entryPoints].filter((path) => path !== undefined && !shipped.has(path))
check('entry points ship (main, exports, bundle patch)',
  missingEntries.length === 0, missingEntries.join(', '))

// ── 2. nothing dev-only ships ───────────────────────────────────────────────
// `files` is authoritative; these are the roots that must never appear even if
// someone widens it, so the whitelist cannot silently become "the whole repo".
const forbidden = /(^|\/)(node_modules|\.git|packages|docs|assets)\/|(^|\/)\.DS_Store$|\.tgz$|\.log$/
const intruders = [...shipped.keys()].filter((path) => forbidden.test(path))
check('no dev-only path ships', intruders.length === 0, intruders.join(', '))

// ── 3. every reference from a shipped file resolves inside the tarball ──────
// Only `scripts/...` paths are required to ship: `docs/...` mentions point at
// the upstream harness catalogs, which are not this package's files.
const unresolved = []
for (const path of shipped.keys()) {
  if (!/\.(js|mjs|sh)$/.test(path)) continue
  const text = read(path)
  const here = posix.dirname(path)
  for (const match of text.matchAll(/(?:from|import\(|require\()\s*['"](\.\/[^'"]+)['"]/g)) {
    const target = posix.normalize(posix.join(here, match[1]))
    if (!shipped.has(target)) unresolved.push(`${path} → ${match[1]}`)
  }
  for (const match of text.matchAll(/scripts\/[A-Za-z0-9._/-]+/g)) {
    const target = match[0].replace(/[.,]+$/, '')
    if (!shipped.has(target)) unresolved.push(`${path} → ${target}`)
  }
}
check('every path a shipped file references is shipped',
  unresolved.length === 0, [...new Set(unresolved)].join(', '))

// ── 4. modes must work for a second user ────────────────────────────────────
const unreadable = [...shipped.values()].filter((entry) => (entry.mode & 0o004) === 0)
check('every shipped file is world-readable', unreadable.length === 0,
  unreadable.map((entry) => `${entry.path} (0${entry.mode.toString(8)})`).join(', '))
const shellScripts = [...shipped.entries()].filter(([path]) => path.endsWith('.sh'))
const notExecutable = shellScripts.filter(([, entry]) => (entry.mode & 0o001) === 0)
check('shipped shell scripts are world-executable', notExecutable.length === 0,
  notExecutable.map(([path, entry]) => `${path} (0${entry.mode.toString(8)})`).join(', '))

check('the tarball listing is self-consistent',
  packed.entryCount === packed.files.length, `${packed.entryCount} vs ${packed.files.length}`)

console.log(`\n${shipped.size} files, ${packed.unpackedSize} bytes unpacked, ${manifest.name}@${manifest.version}`)
console.log(failed === 0 ? 'ALL CHECKS PASSED' : `${failed} CHECK(S) FAILED`)
process.exit(failed === 0 ? 0 : 1)
