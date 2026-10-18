#!/usr/bin/env node
/**
 * Guard for the documentation claims around the support claim: the surface the
 * READMEs quote, the release history, and the two languages' parity.
 *
 * Why this exists: `support-claim-test.mjs` pins the declared range against the
 * CI matrix and the link check, but nothing read the prose around it — and that
 * prose is where every stale claim in this repo's history lived (a peer range
 * one release behind the manifest, a version table still describing the previous
 * line, "0.11.0" quoted from a checkout that was not 0.11.0 any more). Wording
 * cannot be guarded; *structure* can, and structure is what rots first:
 *
 *   1. both READMEs quote the peer range the manifest declares. The range sits
 *      inside markdown table cells, where `|` is written `\|`, so the comparison
 *      normalizes that escape before looking;
 *   2. each changelog's newest entry is the version in `package.json`;
 *   3. both changelogs list the same versions, in the same order;
 *   4. every released bridge version in the README's support-policy table has a
 *      changelog entry — a release without release notes is the failure mode
 *      this repo shipped twice;
 *   5. release history stays in the changelog: a `What X changed` /
 *      `X 的变更` heading in either README fails the guard. That content was
 *      moved out on purpose — the changelog is the single place a reader has to
 *      look for it, and the README is the page a new user reads first;
 *   6. the two READMEs, and the two changelogs, have the same heading count, so
 *      a section added in one language cannot be forgotten in the other.
 *
 * Offline, dependency-free, and deliberately indifferent to wording: it checks
 * that the structure which has gone stale before cannot go stale unnoticed.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoDir = join(dirname(fileURLToPath(import.meta.url)), '..')

let failed = 0
function check(label, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failed += 1
}

const read = (file) => readFileSync(join(repoDir, file), 'utf8')

/** Headings outside fenced code blocks: the patch snippets are full of `#` lines. */
function headings(text) {
  const found = []
  let fenced = false
  for (const line of text.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) { fenced = !fenced; continue }
    if (fenced) continue
    const match = /^(#{1,6})\s+(\S.*)$/.exec(line)
    if (match !== null) found.push(match[2].trim())
  }
  return found
}

/** Version headings of a Keep-a-Changelog file; `## [Unreleased]` carries no date. */
const changelogVersions = (text) => [...text.matchAll(/^## \[([^\]]+)\] - \S+/gm)].map((match) => match[1])

const manifest = JSON.parse(read('package.json'))
const range = manifest.peerDependencies['@deepseek-ai/dsh-agent']

const readmes = { 'README.md': read('README.md'), 'README-zh.md': read('README-zh.md') }
const changelogs = { 'CHANGELOG.md': read('CHANGELOG.md'), 'CHANGELOG-zh.md': read('CHANGELOG-zh.md') }

// ── 1. the READMEs quote the manifest's range ───────────────────────────────
const rangeStrays = Object.entries(readmes)
  .filter(([, text]) => !text.replaceAll('\\|', '|').includes(range))
  .map(([name]) => name)
check('both READMEs quote the declared peer range', rangeStrays.length === 0 && typeof range === 'string',
  rangeStrays.length === 0 ? String(range) : `missing from ${rangeStrays.join(', ')}`)

// ── 2–3. the two changelogs describe the same releases ──────────────────────
const newest = Object.fromEntries(Object.entries(changelogs).map(([name, text]) => [name, changelogVersions(text)[0]]))
const staleNewest = Object.entries(newest).filter(([, version]) => version !== manifest.version).map(([name, v]) => `${name} says ${v}`)
check('each changelog\'s newest entry is the version in package.json',
  staleNewest.length === 0 && Object.keys(newest).length === 2,
  staleNewest.length === 0 ? `all say ${manifest.version}` : `${staleNewest.join(', ')} (package.json: ${manifest.version})`)

const enVersions = changelogVersions(changelogs['CHANGELOG.md'])
const zhVersions = changelogVersions(changelogs['CHANGELOG-zh.md'])
const divergent = enVersions.length !== zhVersions.length
  ? `${enVersions.length} vs ${zhVersions.length} entries`
  : enVersions.map((v, i) => (v === zhVersions[i] ? null : `#${i + 1}: ${v} vs ${zhVersions[i]}`)).filter(Boolean).join('; ')
check('both changelogs list the same versions in the same order', divergent === '',
  divergent || `${enVersions.length} versions, newest ${enVersions[0]}`)

// ── 4. no released version without a changelog entry ────────────────────────
// The support-policy table is the released-versions list; rows for unreleased
// generations (0.8.x, 0.7.x and older) are not bold, and are not required here.
const releasedRows = [...readmes['README.md'].matchAll(/^\| \*\*(\d+\.\d+\.\d+)\*\* \|/gm)].map((match) => match[1])
const unreleased = releasedRows.filter((version) => !enVersions.includes(version))
check('every released version in the support table has a changelog entry',
  releasedRows.length > 0 && unreleased.length === 0,
  unreleased.length === 0 ? `${releasedRows.length} released versions` : unreleased.join(', '))

// ── 5. release history lives in the changelog, not in the READMEs ───────────
const HISTORY_HEADING = /^(?:What .* changed|\d+\.\d+\.\d+\s*的(?:破坏性)?变更)/
const historyStrays = Object.entries(readmes)
  .flatMap(([name, text]) => headings(text).filter((heading) => HISTORY_HEADING.test(heading)).map((heading) => `${name}: ${heading}`))
check('release history stays in the changelogs', historyStrays.length === 0, historyStrays.join('; '))

// ── 6. language parity, by heading count ───────────────────────────────────
for (const pair of [['README.md', 'README-zh.md'], ['CHANGELOG.md', 'CHANGELOG-zh.md']]) {
  const [en, zh] = pair.map((name) => headings(readmes[name] ?? changelogs[name]).length)
  check(`${pair[0]} and ${pair[1]} have the same heading count`, en === zh, `${en} vs ${zh}`)
}

console.log(failed === 0
  ? `DOCS CLAIM OK (${enVersions.length} changelog versions, newest ${enVersions[0]}, ${headings(readmes['README.md']).length} README headings)`
  : `${failed} CHECK(S) FAILED`)
process.exit(failed === 0 ? 0 : 1)
