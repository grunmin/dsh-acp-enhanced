/**
 * Shared CI helper: make a throwaway dsh profile the same shape as a real one.
 *
 * The scripts that self-create a profile (`acp-smoke-keyless.mjs`,
 * `acp-mcp-test.mjs`) call `seedHostServiceRow` after `dsh plugin add`, because
 * from 0.1.2-alpha on the shipped `standard` preset mounts tool-subagent with
 * `modelSelectionSettings: true`, which needs `subagent-model-selection-settings`
 * in the Host scope. dsh-base does not carry the row and the bridge's bundle
 * patch cannot ship it (the module does not exist on ≤ 0.1.1 harnesses, where an
 * unresolvable row breaks boot), so real profiles get it in their user layer —
 * see scripts/init-acp-home.sh.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

/** The home the running CLI boots under (honours an explicit DSH_HOME). */
export const dshHome = () => process.env.DSH_HOME ?? path.join(homedir(), '.dsh')

/**
 * Seed the 0.1.2-alpha+ Host-scope service row into one profile's user layer.
 * A no-op on older CLIs and when the row is already present.
 */
export function seedHostServiceRow(profileName) {
  const version = (spawnSync('dsh', ['--version'], { encoding: 'utf8' }).stdout ?? '').trim()
  // The release line rides the patch digit in the 0.1 series (0.1.5-rc.2); the
  // row became mandatory in 0.1.2-alpha.2 and stays so for every later line.
  const [major = '0', minor = '0', rest = '0'] = version.split('.')
  const line = Number(rest.split('-')[0])
  const needsRow = Number(major) > 0 || Number(minor) > 1 || (Number(minor) === 1 && line >= 2)
  if (!needsRow) return
  const patchPath = path.join(dshHome(), 'profiles', profileName, 'cordis.patch.yml')
  const existing = existsSync(patchPath) ? readFileSync(patchPath, 'utf8') : ''
  if (existing.includes('subagent-model-selection-settings')) return
  // `dsh plugin add` seeds the profile's patch layer as an empty top-level
  // array; drop that `[]` placeholder line before appending the insert row (a
  // flow sequence followed by a block sequence is not valid YAML).
  const body = existing.replace(/^\[\]\s*$/m, '').trimEnd()
  writeFileSync(patchPath, `${body.length > 0 ? `${body}\n` : ''}- insert:\n    - id: subagent-model-selection-settings\n      name: '@deepseek-ai/dsh-tool-subagent/model-selection-settings'\n`)
}
