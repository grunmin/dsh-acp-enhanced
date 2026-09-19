#!/usr/bin/env node
/**
 * Public-surface guard for the harness API this bridge consumes.
 *
 * The bridge is a third-party dsh bundle, so it may only touch the harness's
 * *declared* surface: services listed in the generated `docs/capability-seams.md`
 * and events listed in the generated `docs/event-producer-consumer.md`, plus
 * published package exports. Everything else — backend-only methods, removed
 * accessors, `internal/*` event strings — is private and rots without notice.
 *
 * This script turns that rule into a CI check: it extracts every harness API
 * usage from `lib/`, compares it with `scripts/compat/public-surface.json`
 * (a reviewed allow-list where each entry cites its upstream declaration), and
 * fails on anything not listed. Comments are stripped first so prose that names
 * a forbidden symbol does not trip the guard.
 *
 * Usage: node scripts/api-surface-check.mjs
 */
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const surface = JSON.parse(readFileSync(join(repoDir, 'scripts/compat/public-surface.json'), 'utf8'))
const FILES = ['lib/index.js', 'lib/codec.js', 'lib/terminal-codec.js']

/**
 * Blank out comments while preserving byte offsets (and therefore line
 * numbers). String and template literals are kept intact — service ids and
 * event names live there.
 */
function stripComments(source) {
  const out = [...source]
  let state = 'code'
  let quote = ''
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i]
    const next = source[i + 1]
    if (state === 'code') {
      if (ch === '/' && next === '/') { state = 'line'; out[i] = out[i + 1] = ' '; i += 1; continue }
      if (ch === '/' && next === '*') { state = 'block'; out[i] = out[i + 1] = ' '; i += 1; continue }
      if (ch === '"' || ch === "'" || ch === '`') { state = 'string'; quote = ch; continue }
    } else if (state === 'line') {
      if (ch === '\n') { state = 'code'; continue }
      out[i] = ' '
    } else if (state === 'block') {
      if (ch === '*' && next === '/') { out[i] = out[i + 1] = ' '; i += 1; state = 'code'; continue }
      if (ch !== '\n') out[i] = ' '
    } else if (state === 'string') {
      if (ch === '\\') { i += 1; continue }
      if (ch === quote) state = 'code'
    }
  }
  return out.join('')
}

const lineOf = (source, index) => source.slice(0, index).split('\n').length
const violations = []
const seen = new Set()

function report(file, source, index, message) {
  const key = `${file}:${lineOf(source, index)}:${message}`
  if (seen.has(key)) return
  seen.add(key)
  violations.push({ file, line: lineOf(source, index), message })
}

const sources = FILES.map((file) => ({ file, raw: readFileSync(join(repoDir, file), 'utf8') }))
  .map((entry) => ({ ...entry, text: stripComments(entry.raw) }))

const serviceNames = new Set(Object.keys(surface.services))
const eventNames = new Set(Object.keys(surface.events))

// ── 1. services: ctx.get('x') and ctx.x ──────────────────────────────────────
for (const { file, text } of sources) {
  for (const match of text.matchAll(/ctx\.get\(\s*'([^']+)'\s*\)/g)) {
    if (!serviceNames.has(match[1])) {
      report(file, text, match.index, `undeclared service: ctx.get('${match[1]}')`)
    }
  }
  for (const match of text.matchAll(/\bctx\.([a-zA-Z][a-zA-Z0-9_]*)\b/g)) {
    const name = match[1]
    // Cordis framework built-ins are not harness surface.
    if (surface.framework.includes(name)) continue
    if (serviceNames.has(name)) continue
    report(file, text, match.index, `undeclared ctx member: ctx.${name}`)
  }
}

// ── 2. events: ctx.on / ctx.waterfall ───────────────────────────────────────
for (const { file, text } of sources) {
  for (const match of text.matchAll(/ctx\.(?:on|waterfall)\(\s*'([^']+)'/g)) {
    const name = match[1]
    if (name.startsWith('internal/')) {
      report(file, text, match.index, `forbidden internal event: ${name}`)
      continue
    }
    if (!eventNames.has(name)) report(file, text, match.index, `undeclared event: ${name}`)
  }
}

// ── 3. imports from harness packages ────────────────────────────────────────
for (const { file, text } of sources) {
  for (const match of text.matchAll(/import\s+(?:([A-Za-z_$][\w$]*)\s*,?\s*)?(?:\{([^}]*)\}|\*\s+as\s+([A-Za-z_$][\w$]*))?\s*from\s*'(@deepseek-ai\/[^']+)'/g)) {
    const pkg = match[4]
    const allowed = surface.imports[pkg]
    if (allowed === undefined) {
      report(file, text, match.index, `undeclared harness package import: ${pkg}`)
      continue
    }
    const names = []
    if (match[1] !== undefined) names.push('default')
    if (match[3] !== undefined) names.push('*')
    if (match[2] !== undefined) {
      for (const part of match[2].split(',')) {
        const name = part.trim().split(/\s+as\s+/)[0].trim()
        if (name.length > 0) names.push(name)
      }
    }
    for (const name of names) {
      if (!allowed.includes(name)) report(file, text, match.index, `undeclared export: ${name} from ${pkg}`)
    }
  }
}

// ── 4. service members, through the local aliases ───────────────────────────
const aliasToService = new Map()
for (const { text } of sources) {
  // const helper = () => ctx.get('svc')  → helper name resolves to svc
  const helpers = new Map()
  for (const match of text.matchAll(/const\s+([A-Za-z_$][\w$]*)\s*=\s*\(\s*\)\s*=>\s*ctx\.get\(\s*'([^']+)'\s*\)/g)) {
    helpers.set(match[1], match[2])
  }
  for (const match of text.matchAll(/const\s+([A-Za-z_$][\w$]*)\s*=\s*ctx\.get\(\s*'([^']+)'\s*\)/g)) {
    aliasToService.set(match[1], match[2])
  }
  for (const match of text.matchAll(/const\s+([A-Za-z_$][\w$]*)\s*=\s*ctx\.([a-zA-Z][\w$]*)\b/g)) {
    if (serviceNames.has(match[2])) aliasToService.set(match[1], match[2])
  }
  for (const match of text.matchAll(/const\s+([A-Za-z_$][\w$]*)\s*=\s*([A-Za-z_$][\w$]*)\(\s*\)/g)) {
    if (helpers.has(match[2])) aliasToService.set(match[1], helpers.get(match[2]))
  }
}
for (const { file, text } of sources) {
  for (const [alias, service] of aliasToService) {
    const allowed = surface.services[service]?.members ?? []
    for (const match of text.matchAll(new RegExp(`\\b${alias}\\.([a-zA-Z][\\w$]*)`, 'g'))) {
      const member = match[1]
      if (!allowed.includes(member)) {
        report(file, text, match.index, `undeclared member: ${service}.${member}`)
      }
    }
  }
}

// ── 5. session methods + explicit denylist ──────────────────────────────────
for (const { file, text } of sources) {
  for (const name of surface.sessionMethods) {
    if (text.includes(`.${name}(`)) continue
    // allowed but currently unused — no violation, just informational later.
  }
  for (const banned of surface.denylist) {
    let index = text.indexOf(banned)
    while (index !== -1) {
      report(file, text, index, `denylisted private usage: ${banned}`)
      index = text.indexOf(banned, index + 1)
    }
  }
}

// ── report ──────────────────────────────────────────────────────────────────
if (violations.length === 0) {
  console.log(`PUBLIC SURFACE OK (floor dsh ${surface.supportedDshFloor}; ${serviceNames.size} services, ${eventNames.size} events)`)
  process.exit(0)
}
console.log(`PUBLIC SURFACE VIOLATIONS: ${violations.length}\n`)
for (const v of violations.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)) {
  console.log(`  ${v.file}:${v.line}  ${v.message}`)
}
console.log('\nFix by replacing the usage with a declared surface, or add it to')
console.log('scripts/compat/public-surface.json WITH an upstream citation.')
process.exit(1)
