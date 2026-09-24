#!/usr/bin/env node
/**
 * Cross-generation link-time compatibility check for the acp bridge.
 *
 * The bridge statically imports pure helpers from the harness packages; a
 * removed named export is a hard ESM link-time failure that no runtime
 * fallback can absorb (that is exactly how 0.1.2-alpha.1 broke
 * `resolveSessionPreset`/`UnknownPresetError`/`PresetMountError` consumers).
 * This script installs each supported harness generation into a scratch
 * directory and imports the bridge from it, so this repo's own node_modules
 * (pinned to the newest generation) can never mask a link-time break against
 * an older one.
 *
 * The supported lines share the `agent/assistant-stream` frames API and the
 * declared service surface; the one runtime difference is the agent-preset
 * roster, whose packaging changed in 0.1.7 (`dsh-agent-presets` → a registry
 * plus one declaration row per preset). That difference is confined to
 * `cordis.patch.yml` (a generation-gated row) and one duck-typed member probe,
 * `presets.resolveMountable` → `presets.resolve`; both are exercised by the
 * boot matrix in `.github/workflows/ci.yml`, not here. Behaviour on a live host
 * is covered by the e2e runs in scripts/.
 *
 * Usage: node scripts/compat-check.mjs [--registry <npm-registry>]
 *   --registry defaults to the public npm registry: prerelease harness
 *   versions are typically absent from internal mirrors.
 */
import { spawnSync } from 'node:child_process'
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repoDir = join(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const registryFlag = argv.indexOf('--registry')
const registry = registryFlag !== -1 ? argv[registryFlag + 1] : 'https://registry.npmjs.org'

// Runtime dependencies of the bridge itself (package.json "dependencies").
const bridgeDeps = {
  '@agentclientprotocol/sdk': '1.3.0',
  '@deepseek-ai/schemastery': '^3.18.1',
  zod: '^4.4.3',
}

// The supported API generations, all on the `agent/assistant-stream` frames
// line (0.1.3-alpha.2+) and all consuming the same declared service surface:
// "frames" is the pinned rc line, "framesNext" the 0.1.6 alpha line, and
// "framesRegistry" the 0.1.7 line that replaced the preset roster. Each mirrors
// the repo devDependency ranges (the same ranges the pinned @deepseek-ai/dsh
// CLI declares), so a fresh resolution matches what a real profile boot heals.
// `roster` names the agent-preset package that line ships, which the row the
// bridge's bundle patch inserts must also match.
const GENERATIONS = {
  frames: {
    label: '0.1.3-alpha.2+ (assistant-stream frames API, rc line)',
    roster: '@deepseek-ai/dsh-agent-presets',
    deps: {
      '@deepseek-ai/cordis': '^4.0.2',
      '@deepseek-ai/cordis-plugin-include': '^1.0.7',
      '@deepseek-ai/cordis-plugin-loader': '^1.0.3',
      '@deepseek-ai/dsh': '0.1.5-rc.2',
      '@deepseek-ai/dsh-agent': '^0.1.5-rc.2',
      '@deepseek-ai/dsh-agent-instructions': '^0.1.5-rc.2',
      '@deepseek-ai/dsh-agent-presets': '^0.1.5-rc.2',
      '@deepseek-ai/dsh-invariants': '^0.1.5-rc.2',
      '@deepseek-ai/dsh-llm': '^0.1.5-rc.2',
      '@deepseek-ai/dsh-mcp-client': '^0.1.5-rc.2',
      '@deepseek-ai/dsh-permission-presets': '^0.1.5-rc.2',
      '@deepseek-ai/dsh-session': '^0.1.5-rc.2',
      '@deepseek-ai/dsh-session-query': '^0.1.5-rc.2',
      '@deepseek-ai/dsh-skill': '^0.1.5-rc.2',
      '@deepseek-ai/dsh-tools': '^0.1.5-rc.2',
      '@deepseek-ai/dsh-user-approval': '^0.1.5-rc.2',
    },
  },
  framesNext: {
    label: '0.1.3-alpha.2+ (assistant-stream frames API, alpha line)',
    roster: '@deepseek-ai/dsh-agent-presets',
    deps: {
      '@deepseek-ai/cordis': '^4.0.2',
      '@deepseek-ai/cordis-plugin-include': '^1.0.7',
      '@deepseek-ai/cordis-plugin-loader': '^1.0.3',
      '@deepseek-ai/dsh': '0.1.6-alpha.2',
      '@deepseek-ai/dsh-agent': '^0.1.6-alpha.2',
      '@deepseek-ai/dsh-agent-instructions': '^0.1.6-alpha.2',
      '@deepseek-ai/dsh-agent-presets': '^0.1.6-alpha.2',
      '@deepseek-ai/dsh-invariants': '^0.1.6-alpha.2',
      '@deepseek-ai/dsh-llm': '^0.1.6-alpha.2',
      '@deepseek-ai/dsh-mcp-client': '^0.1.6-alpha.2',
      '@deepseek-ai/dsh-permission-presets': '^0.1.6-alpha.2',
      '@deepseek-ai/dsh-session': '^0.1.6-alpha.2',
      '@deepseek-ai/dsh-session-query': '^0.1.6-alpha.2',
      '@deepseek-ai/dsh-skill': '^0.1.6-alpha.2',
      '@deepseek-ai/dsh-tools': '^0.1.6-alpha.2',
      '@deepseek-ai/dsh-user-approval': '^0.1.6-alpha.2',
    },
  },
  // 0.1.7 retires `@deepseek-ai/dsh-agent-presets` (last release 0.1.6-alpha.2)
  // in favour of `@deepseek-ai/dsh-agent-preset-registry` plus one
  // `@deepseek-ai/dsh-agent-preset` declaration per preset. Both are installed
  // here because the bridge's bundle patch names them; the exact pins mirror
  // what @deepseek-ai/dsh@0.1.7-rc.2 itself declares.
  framesRegistry: {
    label: '0.1.7+ (agent-preset registry API, rc line)',
    roster: '@deepseek-ai/dsh-agent-preset-registry',
    deps: {
      '@deepseek-ai/cordis': '~4.0.4',
      '@deepseek-ai/cordis-plugin-include': '~1.0.9',
      '@deepseek-ai/cordis-plugin-loader': '~1.0.5',
      '@deepseek-ai/dsh': '0.1.7-rc.2',
      '@deepseek-ai/dsh-agent': '0.1.7-rc.2',
      '@deepseek-ai/dsh-agent-instructions': '0.1.7-rc.2',
      '@deepseek-ai/dsh-agent-preset': '0.1.7-rc.2',
      '@deepseek-ai/dsh-agent-preset-registry': '0.1.7-rc.2',
      '@deepseek-ai/dsh-invariants': '0.1.7-rc.2',
      '@deepseek-ai/dsh-llm': '0.1.7-rc.2',
      '@deepseek-ai/dsh-mcp-client': '0.1.7-rc.2',
      '@deepseek-ai/dsh-permission-presets': '0.1.7-rc.2',
      '@deepseek-ai/dsh-session': '0.1.7-rc.2',
      '@deepseek-ai/dsh-session-query': '0.1.7-rc.2',
      '@deepseek-ai/dsh-skill': '0.1.7-rc.2',
      '@deepseek-ai/dsh-tools': '0.1.7-rc.2',
      '@deepseek-ai/dsh-user-approval': '0.1.7-rc.2',
    },
  },
}

let failed = 0
for (const [name, generation] of Object.entries(GENERATIONS)) {
  const scratch = mkdtempSync(join(tmpdir(), `dsh-acp-compat-${name}-`))
  try {
    writeFileSync(join(scratch, 'package.json'), JSON.stringify({
      name: 'dsh-acp-compat-probe',
      private: true,
      type: 'module',
      dependencies: { ...generation.deps, ...bridgeDeps },
    }, null, 2))
    // Scratch installs run under pnpm (the repo's own manager): its lenient
    // auto-install-peers resolves the prerelease peer chains the same way a
    // real profile boot does, where npm's strict resolver walks them into
    // unresolvable conflicts against exact pins.
    const installed = spawnSync('pnpm', ['install', '--silent', `--registry=${registry}`], { cwd: scratch, encoding: 'utf8' })
    if (installed.status !== 0) {
      console.log(`FAIL  [${name}] npm install of the generation failed: ${(installed.stderr || '').split('\n').slice(-3).join(' ')}`)
      failed += 1
      continue
    }
    // Import the bridge with the scratch tree as its resolution root.
    cpSync(join(repoDir, 'lib'), join(scratch, 'lib'), { recursive: true })
    cpSync(join(repoDir, 'package.json'), join(scratch, 'package.json'))
    const host = await import(pathToFileURL(join(scratch, 'lib', 'index.js')).href)
    const llmVersion = (await import(pathToFileURL(join(scratch, 'node_modules', '@deepseek-ai', 'dsh-llm', 'package.json')).href, { with: { type: 'json' } })).default.version
    const presetsKeys = Object.keys(await import(pathToFileURL(join(scratch, 'node_modules', ...generation.roster.split('/'), 'lib', 'index.js')).href))
    console.log(`PASS  [${name}] bridge imports clean under ${generation.label} (dsh-llm ${llmVersion}; ${generation.roster} exports ${presetsKeys.length} symbols; bridge exports ${Object.keys(host).length})`)
  } catch (error) {
    console.log(`FAIL  [${name}] bridge failed to import under ${generation.label}: ${error.message}`)
    failed += 1
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}
console.log(failed === 0 ? `\nCOMPAT CHECK PASSED (${Object.keys(GENERATIONS).length} generations link clean)` : `\nCOMPAT CHECK FAILED (${failed} generation(s))`)
process.exit(failed === 0 ? 0 : 1)
