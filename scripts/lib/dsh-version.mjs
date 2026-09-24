/**
 * The dsh version comparison the launcher and the doctor share.
 *
 * Not a general semver implementation — it only has to order the version
 * strings this project deals with (`0.1.5-rc.2`, `0.1.6-alpha.2`, `0.1.1-rc.2`),
 * following semver's rules for those shapes: compare the numeric triple, then
 * the prerelease identifiers (numeric < alphanumeric, fewer fields < more), and
 * a release outranks the same triple's prerelease. Anything unparseable makes
 * every comparison `undefined`, so callers can fail open instead of guessing.
 *
 * Also usable as a command, which is how the bash launcher asks:
 *
 *   node dsh-version.mjs --supported '^0.1.7-alpha.1' 0.1.7-alpha.1
 *   → exit 0 supported, 1 outside the range, 2 unparseable
 */
import { pathToFileURL } from 'node:url'

/** `0.1.5-rc.2` → `{ numbers: [0,1,5], prerelease: ['rc','2'] }`, else undefined. */
export function parseVersion(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(String(value ?? '').trim())
  if (match === null) return undefined
  return {
    numbers: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4] === undefined ? [] : match[4].split('.'),
  }
}

function compareIdentifiers(left, right) {
  const leftNumeric = /^\d+$/.test(left)
  const rightNumeric = /^\d+$/.test(right)
  if (leftNumeric && rightNumeric) return Math.sign(Number(left) - Number(right))
  if (leftNumeric) return -1
  if (rightNumeric) return 1
  return left < right ? -1 : left > right ? 1 : 0
}

/** -1 / 0 / 1, or undefined when either side is not a version of this shape. */
export function compareVersions(left, right) {
  const a = parseVersion(left)
  const b = parseVersion(right)
  if (a === undefined || b === undefined) return undefined
  for (let index = 0; index < 3; index += 1) {
    if (a.numbers[index] !== b.numbers[index]) return Math.sign(a.numbers[index] - b.numbers[index])
  }
  if (a.prerelease.length === 0 && b.prerelease.length === 0) return 0
  if (a.prerelease.length === 0) return 1
  if (b.prerelease.length === 0) return -1
  for (let index = 0; index < Math.max(a.prerelease.length, b.prerelease.length); index += 1) {
    if (a.prerelease[index] === undefined) return -1
    if (b.prerelease[index] === undefined) return 1
    const step = compareIdentifiers(a.prerelease[index], b.prerelease[index])
    if (step !== 0) return step
  }
  return 0
}

/** The lowest version a peer range accepts. These ranges are
 *  `^x.y.z-a || ^x.y.z-b`, and the second alternative only ever starts higher
 *  than the first, so the first alternative's version is the floor. */
export function floorOfRange(range) {
  const first = String(range ?? '').split('||')[0]
  const match = /(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/.exec(first ?? '')
  return match?.[1]
}

/** The window one `^x.y.z[-pre]` alternative accepts: a floor and the first
 *  version *past* its ceiling. `undefined` for any other shape, so callers fail
 *  open rather than guess at a range nobody has taught this helper. */
function caretBounds(alternative) {
  const match = /^\s*\^\s*(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?\s*$/.exec(alternative ?? '')
  if (match === null) return undefined
  const major = Number(match[1])
  const minor = Number(match[2])
  const patch = Number(match[3])
  // A caret's ceiling is the next *major*, except at 0.x — where it is the next
  // minor (and at 0.0.x the next patch). dsh is a 0.x CLI, so the distinction is
  // load-bearing: `^0.1.5` stops at 0.2.0, it does not run to 1.0.0.
  const ceiling = major > 0 ? `${major + 1}.0.0` : minor > 0 ? `0.${minor + 1}.0` : `0.0.${patch + 1}`
  const floor = `${major}.${minor}.${patch}${match[4] === undefined ? '' : `-${match[4]}`}`
  return { floor, ceiling }
}

/** Whether a CLI version is inside the supported range. Both ends are checked:
 *  a range's ceiling is the next minor on the 0.x line the bridge targets, so a
 *  CLI from a line this bridge was never verified against is *not* supported.
 *
 *  Deliberately not a semver implementation. Prerelease *gating* is looser than
 *  npm's (a prerelease above an alternative's floor counts as inside), which
 *  only ever makes the pre-boot warning quieter — never the other way, which is
 *  what matters here. Returns `undefined` when the version or the range cannot
 *  be read, so callers fail open. */
export function isSupported(cliVersion, range) {
  if (parseVersion(cliVersion) === undefined) return undefined
  let understood = false
  for (const alternative of String(range ?? '').split('||')) {
    const bounds = caretBounds(alternative)
    if (bounds === undefined) continue
    understood = true
    const aboveFloor = compareVersions(cliVersion, bounds.floor)
    const belowCeiling = compareVersions(cliVersion, bounds.ceiling)
    if (aboveFloor === undefined || belowCeiling === undefined) return undefined
    if (aboveFloor >= 0 && belowCeiling < 0) return true
  }
  return understood ? false : undefined
}

const invokedDirectly = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1]).href

if (invokedDirectly) {
  const [flag, range, version] = process.argv.slice(2)
  if (flag !== '--supported' || range === undefined || version === undefined) {
    console.error('usage: dsh-version.mjs --supported <peer-range> <cli-version>')
    process.exit(2)
  }
  const supported = isSupported(version, range)
  process.exit(supported === undefined ? 2 : supported ? 0 : 1)
}
