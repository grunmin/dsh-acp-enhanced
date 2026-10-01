/**
 * Boot-failure classification the doctor and its regression test share.
 *
 * Two different things end up in one boot's stderr:
 *
 *   - **crash signatures** (`classifyCrash`): the loader rejected an entry, an
 *     import did not resolve, a harness method was missing. These are why the
 *     profile is down.
 *   - **the host's peer-gate skip line** (`manifestGate`): the CLI dropped one
 *     bundle's whole patch layer and kept booting. It is not a crash at all —
 *     it is a missing capability, and whether it *matters* depends on what else
 *     the profile needs.
 *
 * `diagnose` combines them with the caller's boot outcome:
 *
 *   - a crash signature always wins. When a loader entry is rejected, that is
 *     the reason the profile is down; the skip line is context, not the cause
 *     (ranking the skip above it hides the row the user actually has to fix);
 *   - when a thread opened (`bootOk`), a skipped bundle is *not* a failure. The
 *     caller reports it as DEGRADED through `inactiveEntries`, which lists the
 *     skip lines independently of the loader's activation count;
 *   - when the boot failed with no crash signature, the skip is the failure: a
 *     self-skip takes the ACP server away (no handshake at all). For a third
 *     party's bundle that is not what happens — measured on a profile another
 *     row depended on, the boot still answered `initialize`, opened a thread and
 *     carried a prompt to the model call, so a third-party skip is a capability
 *     loss and nothing more.
 *
 * Kept out of `acp-doctor.mjs` so `boot-classify-test.mjs` can pin the table
 * without booting anything (the doctor runs its boot at import time).
 */
import { join } from 'node:path'

/** The bundle name in the CLI's `skipping profile bundle "…"` line, or undefined. */
export function skippedBundleOf(stderr) {
  return /skipping profile bundle "([^"]+)"/.exec(stderr)?.[1]
}

/** The CLI's peer-gate diagnosis for a boot this skip can explain.
 *
 *  The FIX splits *this bridge* from *a third party*, because the two have
 *  different outs: this bridge can be upgraded (or the CLI pinned to a line it
 *  declares), but no upgrade of this bridge can widen someone else's range. */
export function manifestGate(stderr, { profileName, supportedRange, bridgeVersion, bridgeName = 'dsh-acp-enhanced' }) {
  const skipped = skippedBundleOf(stderr)
  if (skipped === undefined) return undefined
  const runtime = /is incompatible with dsh ([^\s:]+)/.exec(stderr)?.[1]
  const subject = `profile bundle ${skipped} rejected by the CLI's peer gate${runtime === undefined ? '' : ` (dsh ${runtime})`}`
  if (skipped === bridgeName) {
    return {
      layer: 'manifest-gate',
      subject,
      fix: `this CLI checked the bundle's declared @deepseek-ai/dsh* peers, did not accept the running version, and dropped this bridge's whole patch layer — so the capability is silently gone. Upgrade the bridge (\`dsh plugin --profile ${profileName} add dsh-acp-enhanced@${bridgeVersion ?? '?'}\`) or pin the CLI to a line the bridge declares: ${supportedRange}, e.g. npm install -g @deepseek-ai/dsh@<version in that range>.`,
    }
  }
  return {
    layer: 'manifest-gate',
    subject,
    fix: `this CLI checked that bundle's declared @deepseek-ai/dsh* peers, did not accept the running version, and dropped its whole patch layer, so the rows it provided never mount and whatever it gave the profile is gone. This bridge is not the one being skipped, so upgrading it will not help: upgrade \`${skipped}\` if a release declares this CLI line, take it out of the profile, or pin the CLI to a line that bundle declares. The boot itself usually survives (measured on \`dsh-free-search@0.4.39\` on 0.2.0-rc.2, with and without a user row configuring its entry) — the loss is that bundle's capability, not the profile. If there is no release of it for this CLI line, upstream can take the risk explicitly: \`dsh plugin allow-version ${skipped}@<version> --dsh-version ${runtime ?? '<running version>'} --accept-risk --profile ${profileName}\` (measured to lift the skip; what it costs is the risk the warning names).`,
  }
}

/** Classify one boot *crash* from the stderr the launcher collected.
 *
 *  Order matters: a mount failure *wraps* its cause, so `failed to apply loader
 *  entry …: Cannot find package …` carries both signatures. The unambiguous
 *  link-time signature (a missing named export) wins; otherwise a loader
 *  rejection is mount-time; a bare unresolved import is the bridge's own graph.
 *  A duplicate loader entry id outranks the loader signatures: it is a
 *  composition conflict (the same row shipped by two layers), not a generation
 *  problem, and its fix is a specific line to delete.
 */
export function classifyCrash(stderr, { profileDir, dshHome, repoDir, supportedRange, profileName, cliPath, cliVersion }) {
  const firstOf = (pattern) => stderr.match(pattern)?.[1]
  const duplicate = firstOf(/duplicate loader entry id: *([^\s,)]+)/)
  if (duplicate !== undefined) {
    return {
      layer: 'mount-time',
      subject: `duplicate loader entry id: ${duplicate}`,
      fix: `two layers ship the row "${duplicate}". If it is a host row the bridge's bundle patch provides (e.g. subagent-model-selection-settings), delete it from the user layer — ${join(profileDir, 'cordis.patch.yml')} — or re-run ${repoDir}/scripts/init-acp-home.sh, which retires the legacy copy.`,
    }
  }
  if (/does not provide an export named|SyntaxError: The requested module/.test(stderr)) {
    const moduleName = firstOf(/module '([^']+)'/)
    return {
      layer: 'link-time',
      subject: moduleName ?? 'a harness bundle',
      fix: `the closure was healed to a different CLI generation. Restart the other dsh processes under ${dshHome}, or pin this launcher to the matching CLI with DSH_PATH (resolved: ${cliPath ?? 'none'}, supported: ${supportedRange}).`,
    }
  }
  if (/in the Host scope/.test(stderr)) {
    const missing = firstOf(/`?(\w+)`? requires [^\s]+ in the Host scope/)
    return {
      layer: 'mount-time',
      subject: `host-scope service missing (${missing ?? 'unnamed'})`,
      fix: `a preset needs a host row this composition does not mount. If the profile's bridge is older than this checkout, upgrade it (\`dsh plugin --profile ${profileName} add dsh-acp-enhanced\`); otherwise the CLI is older than the bridge (supported: ${supportedRange}) — the two must move together.`,
    }
  }
  if (/failed to apply loader entry|failed to import loader entry|requires .* to be available|cannot resolve plugin/.test(stderr)) {
    // The outermost rejection wraps the real one, so read the innermost entry.
    const entry = firstOf(/failed to import loader entry "?([^"\s(]+)"?/)
      ?? firstOf(/failed to apply loader entry "?([^"\s(]+)"?/)
      ?? firstOf(/entry "([^"]+)"/)
      ?? firstOf(/requires "([^"]+)"/)
      ?? firstOf(/\[plugin: ([^\]]+)\]/)
    const moduleName = firstOf(/failed to import loader entry [^(]*\(([^)]+)\)/)
      ?? firstOf(/Cannot find package '([^']+)'/)
    return {
      layer: 'mount-time',
      subject: moduleName === undefined ? (entry ?? 'one loader entry') : `${entry ?? 'an entry'} (${moduleName})`,
      fix: `one rejected entry takes the whole profile down. Disable or remove it in ${join(profileDir, 'cordis.patch.yml')}, install the missing module, or move the third-party bundle out of the profile into a preset composition.`,
    }
  }
  if (/ERR_MODULE_NOT_FOUND/.test(stderr)) {
    const moduleName = firstOf(/Cannot find (?:package|module) '([^']+)'/)
    return {
      layer: 'link-time',
      subject: moduleName ?? 'a harness bundle',
      fix: 'the profile is missing a module its bundle graph imports. Install it in the profile (dsh plugin add …) or trim the bundle.',
    }
  }
  if (/is not a function|is not a valid method|Cannot read properties of (undefined|null)/.test(stderr)) {
    return {
      layer: 'run-time',
      subject: 'a harness service method',
      fix: `this CLI generation (${cliVersion ?? 'unknown'}) does not provide it; the bridge supports ${supportedRange}. Upgrade: npm install -g @deepseek-ai/dsh@<version in that range>.`,
    }
  }
  return undefined
}

/** The one layer a boot is down for, or undefined when it is not down at all.
 *  `bootOk` is the caller's verdict (handshake answered, process alive, a real
 *  `session/new` opened): a skipped bundle on such a boot is a missing
 *  capability, reported as DEGRADED, never as this failure. */
export function diagnose(stderr, options) {
  return classifyCrash(stderr, options) ?? (options.bootOk ? undefined : manifestGate(stderr, options))
}

/** One line per bundle the host's peer gate dropped, or per loader entry that
 *  never activated; or none.
 *
 *  A skipped bundle never reaches the loader, so it has no "did not activate"
 *  entry of its own — and a boot that skipped one can print no activation count
 *  at all. Collect these independently of it, or the one line that names the
 *  missing capability is dropped on the floor. Disabled rows are not counted
 *  (they are skipped before any import), and the patch applier's benign "entry
 *  not found" notes are a different warning entirely.
 *
 *  @param lines - the boot's stderr lines.
 *  @returns one line per inactive entry (or per skipped bundle), or none.
 */
export function inactiveEntries(lines) {
  const text = lines.join('\n')
  const count = /warning: (\d+) entr(?:y|ies) did not activate/.exec(text)?.[1]
  const inactive = []
  for (const line of lines) {
    if (!/skipping profile bundle/.test(line)) continue
    const trimmed = line.trim()
    inactive.push(trimmed.length > 240 ? `${trimmed.slice(0, 240)}…` : trimmed)
  }
  if (count !== undefined) {
    // The loader reports "N entries did not activate" and then one
    // `<entry> (<module>): <reason>` line per entry. Cap the scan at that N: the
    // shape is not unique to the loader, and an unbounded scan can pull any
    // `foo (bar): baz` stderr line into the DEGRADED report.
    const budget = Number(count)
    let taken = 0
    for (const line of lines) {
      if (taken >= budget) break
      const match = /^(\S+) \(([^)]+)\): (\S.*)$/.exec(line.trim())
      if (match === null) continue
      const reason = match[3]
      inactive.push(`${match[1]} (${match[2]}): ${reason.length > 160 ? `${reason.slice(0, 160)}…` : reason}`)
      taken += 1
    }
  }
  if (inactive.length > 0) return inactive
  return count === undefined ? [] : [`${count} entry/entries did not activate (see the log above)`]
}
