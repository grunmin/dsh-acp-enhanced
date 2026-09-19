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
 *   node dsh-version.mjs --supported '^0.1.5-rc.1 || ^0.1.6-alpha.1' 0.1.5-rc.2
 *   → exit 0 supported, 1 below the range's floor, 2 unparseable
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

/** Whether a CLI version is inside the supported range (floor comparison only:
 *  the caret's ceiling is a major, which no dsh 0.x CLI reaches). Returns
 *  undefined when the version or the range cannot be read. */
export function isSupported(cliVersion, range) {
  const floor = floorOfRange(range)
  if (floor === undefined) return undefined
  const order = compareVersions(cliVersion, floor)
  return order === undefined ? undefined : order >= 0
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
