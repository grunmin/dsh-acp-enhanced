# Changelog

Release history for `dsh-acp-enhanced`, newest first. Versions match the git tags (`vX.Y.Z`)
and the npm releases. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

The [README](README.md) describes what the bridge *is* and which harness lines it supports
today; per-release notes live here instead. The long-form engineering records — what was
measured, what was rejected, what is left to verify — are in [`docs/plans/`](docs/plans/),
linked from each entry. A Chinese mirror is kept at [CHANGELOG-zh.md](CHANGELOG-zh.md).

## [0.11.0] - 2026-10-22

dsh **0.2.1** support. Nothing was widened — `^0.2.0-rc.2` already contained `0.2.1-rc.2` — and
no `lib/` line changed: the release names the line, boots it in CI, and drops
`@deepseek-ai/dsh-invariants`. Migration record:
[`docs/plans/2026-10-18-dsh-0.2.1-support.md`](docs/plans/2026-10-18-dsh-0.2.1-support.md).

`dsh` 0.2.1 (still an RC line — `latest` is 0.2.0-rc.2 and `next` is 0.2.1-rc.2) adds two
things a user can see, and needs nothing from this bridge to get either. The first is
host-side **DeepSeek search and fetch**: the harness's `dsh-base` bundle — the layer this
bridge's own bundle extends — now registers a `web-deepseek-api` row, which serves
`web_search`/`web_fetch` through DeepSeek's dedicated Search and Fetch endpoints instead of a
full auxiliary model request. It takes its credential from `DEEPSEEK_API_KEY` and is selected
in the harness's own web-search settings; no row, peer or import of this bridge's is involved,
and it changes nothing about an existing profile's web-search configuration until that switch
is used. The second is UI-only: a new client plugin labels the 1017 checkpoint in the model
picker, and it is wired into the **web/desktop** bundle layer, so an ACP profile does not load
it at all.

Everything this bridge links against is unchanged: across the packages it imports, 0.2.1
differs from 0.2.0 by `package.json` versions alone, the agent-preset roster keeps the
registry-and-declaration shape 0.1.7 introduced, and the generation gate in `cordis.patch.yml`
(`minor > 1`) already classifies 0.2.1 as a registry-roster line. So this release is a
declaration change plus its evidence:

- every `@deepseek-ai/dsh*` peer gained `|| ^0.2.1-rc.2`. That alternative **narrows nothing**:
  the caret ceiling for `^0.2.0-rc.2` is `<0.3.0-0`, which already contains `0.2.1-rc.2`. It is
  declared anyway, because the range doubles as the list of lines the guard checks and
  `scripts/support-claim-test.mjs` requires **every** alternative to have a CI matrix version
  and a link-check generation — naming the line is what puts a boot behind it;
- `@deepseek-ai/dsh-invariants` left `peerDependencies` **and** `devDependencies`. It was always
  a version-tracking peer (never imported by `lib/`, never a patch row), and upstream stopped
  publishing it at 0.2.0-rc.2, so the 0.2.1 closure does not carry it. Keeping the declaration
  would have made pnpm install a package the line does not have — the failure mode 0.10.0
  documented for the ≤ 0.1.6 roster package;
- a fourth `compat-check` generation (`framesRegistry021`) pins the 0.2.1 set with
  `dsh-invariants` **absent**, so the link check describes the closure the line actually
  resolves instead of the previous line's;
- the boot matrix and the link check cover four lines, and the canary's comment records which
  dist-tag carries which line;
- one behavioural caveat is **documented, not fixed**: the four preset declarations this bridge
  inlines are its own copy of the host's compositions, and 0.2.1-rc.2 rewrote all four of them
  upstream — it dropped `persona.config.suffix` and the subagents' `backgroundMode`, added
  `time-context`, `tool-schedule` and `tool-plugin-market` to `standard`, a `compaction` group and
  `tool-fs` to `minimal`, and reworded the plan-mode section. The copy **mounts** on 0.2.1 (the
  keyless smoke opens a session, which composes the default preset), but mounting is all that
  proves: the suffix it still carried was not merely stale, it killed every turn on that line (see
  Fixed below), while `backgroundMode` and the added rows stay unadopted — so a 0.2.1 ACP session
  composes the **0.2.0** set: no `time-context`, no `tool-schedule`, and the older plan-mode text.
  Adopting the rest needs per-line declarations, because two of the added rows name packages that
  exist on 0.2.1 only while the install path resolves every row name on every declared line — see
  `docs/plans/2026-10-18-dsh-0.2.1-support.md` §2.3 and §7.

Verification has the same shape as 0.10.0's and leaves the same two gaps to the maintainer:
the model-backed legs and a real Zed session. Measured locally for this release: the five
offline guards (this release adds `scripts/docs-claim-test.mjs` to the four), the link check
across all four generations, the install path, the doctor and the keyless boot smoke on
0.2.1-rc.2 — see `docs/plans/2026-10-18-dsh-0.2.1-support.md`, §5.

### Fixed

- **The inlined presets sent `{{cwd}}`, which 0.2.1 no longer accepts — every turn died.** The
  rosters carry `dsh-persona` rows, and on the 0.2.1 line `dsh-agent-loop` registers only
  `provider` and `model` as prompt variables (`cwd` was registered through 0.1.7). Interpolation
  is strict, so any session composed from the bridge's inlined `standard` / `ptc` / `cordis`
  rosters failed prompt assembly with `unknown prompt variable "{{cwd}}"` before the first model
  request: the boot was fine and the mount was fine, every turn failed. The three persona rows now
  carry the model prefix only, as upstream 0.2.1's own preset files do, and the working-directory
  service supplies the directory context. `profile/cordis.yml` — the hand-rolled reference
  composition — drops the same clause from its spine persona. This is the one row of the §2.3
  preset table that was never a fidelity gap, and the only upstream preset change this release
  adopts.

## [0.10.0] - 2026-10-01

dsh **0.2.0** support, and the **floor raised to `0.1.6-alpha.1`** (0.1.5-rc.2 is dropped — its
boot smoke never passed on GitHub's runners). Adds the guard that keeps the declared range, the
CI matrix and the link-check generations in agreement. Migration record:
[`docs/plans/2026-09-30-dsh-0.2.0-support.md`](docs/plans/2026-09-30-dsh-0.2.0-support.md).

`dsh` 0.2.0 (RC line; no stable release yet) is a **client/UI release**. Everything this bridge
imports is unchanged apart from versions: the harness packages it links against differ from
0.1.7-rc.2 by `package.json` alone (the audit covers ten packages), `@deepseek-ai/dsh-session`
adds one export (`ToolCallRecovery`, the upstream fix for "a tool-scheduling failure left the
conversation unable to continue"), and the two generated catalogs gained `ctx.otel` and
`ctx.productAnalytics` with **no removals** — 0 services and 0 events disappeared.

What did change is the host's **peer gate**, and that is what this release is about:

| | ≤ 0.1.7 | ≥ 0.2.0 for a bridge that stops at 0.1.7 |
|---|---|---|
| `dsh plugin add` of the bundle | installs | hard **`incompatible-version`** failure, offering an exact-version exemption |
| boot of a profile carrying it | the bundle loads | the CLI **drops the bundle's entire patch layer** and prints one stderr line: `dsh: skipping profile bundle "dsh-acp-enhanced": … peerDependencies {…}` |
| the launcher's own warning | — | *nothing*: the old helper's ceiling was never given semver's `-0`, so it reported `0.2.0-rc.2` as supported while the host had already discarded the bridge |

Five things were fixed, none of them in `lib/`:

- every remaining `@deepseek-ai/dsh*` peer gained `|| ^0.2.0-rc.2`; the gate checks the *running
  version* against every declared range, so one unwidened entry is enough to lose the bundle;
- `@deepseek-ai/dsh-agent-presets` was **removed** from `peerDependencies`. It is the roster of the
  ≤ 0.1.6 lines and has no release past 0.1.6, so declaring it made pnpm pull it into every 0.2.0
  profile — and the *install* path checks more than the manifest: `bundleComponentManifests`
  resolves every row `name` in the bundle's patches and runs the same gate on each resolved
  package, so that unused 0.1.6 package made the installation fail with `incompatible-version` even
  after the range was widened. That rejection is about what is being *installed* (the added package
  and whatever its own rows and peers resolve to); a profile that merely still carries an
  incompatible third-party member draws a warning and stays installed, denied at startup until it
  is upgraded, removed, or granted an exemption (measured; see the migration record
  `docs/plans/2026-09-30-dsh-0.2.0-support.md`, §5 row 23). The row itself stays (it is generation-gated off on every later
  line) and still resolves from the running CLI's own closure — which is exactly how the sibling
  `@deepseek-ai/dsh-agent-preset-registry` row has worked since 0.9.1. Measured across the lines:
  the legacy package resolves from the 0.1.6 install and not from 0.1.7 or 0.2.0, which
  is why 0.1.6 still logs the *legacy* roster's `preset "…" not found` while 0.1.7/0.2.0 log
  the registry's `Unknown agent preset`;
- `scripts/lib/dsh-version.mjs` now expands a caret ceiling to `<x.y.0-0`, matching
  `semver.satisfies(…, { includePrerelease: true })`, so a prerelease of the ceiling version
  (`0.2.0-rc.2` against `^0.1.7-alpha.1`) is correctly *outside*; the doctor's failure message
  distinguishes "too old" from "unverified line";
- `scripts/support-claim-test.mjs` (new, blocking CI) asserts that the declared range, the CI
  boot matrix, the `compat-check` generations and the helper all agree, that the helper matches
  npm's semver on every line edge, and that **every declared peer is also a devDependency** — the
  pinned closure `lib/` links against. That last check is what keeps a line-gated row package from
  creeping back into `peerDependencies`;
- the **doctor and the launcher** report it. `acp-doctor.mjs` classifies a skipped bundle as
  `LAYER manifest-gate` when that is why the boot is down (a crash signature outranks it, and a
  boot that still opened a thread reports `DEGRADED <n> inactive items` — a skipped third-party
  bundle is a missing capability, never a boot failure: measured on a profile whose user layer
  configured the skipped bundle's entry, the boot answered `initialize`, opened a thread and
  carried a prompt to the model call), and its `FIX` splits *this bridge* from
  *a third party*; the launcher translates the same stderr line to `dsh-acp-zed: MANIFEST-GATE …`
  without spending its one fatal hint on it, which matters because that line is the only failure
  class that is not a stack trace — the boot continues without the bundle, so nothing else in the
  log says anything is wrong.

Both gate paths are covered by the smoke and the CI matrix: the install path is what `dsh plugin
add` exercises on every declared line, and `scripts/acp-smoke-keyless.mjs` asserts that a boot's stderr
carries no `skipping profile bundle` line.

The generation gate in `cordis.patch.yml` needed no new boundary: `minor > 1` already classifies
0.2.0 as a registry-roster line, and each of the four inlined preset declarations carries the same
`config` subtree as `@deepseek-ai/dsh-web-app@0.2.0-rc.2`'s (the declaration row itself adds this
bridge's `disabled` generation gate and its display metadata).

**Third-party bundles gate themselves.** A third-party bundle whose declared peers stop at
0.1.x is skipped on a 0.2.0 profile until its publisher widens its own range — this
package cannot fix that. What a skip costs is that bundle's capability, not the profile. On a profile built by
the 0.1.6 CLI (bridge + such a bundle; `RESULT READY` on 0.1.7-rc.2) and booted by
0.2.0-rc.2, an independent ACP probe answered `initialize` in ~0.5 s, stayed alive, opened a
`session/new` thread and carried a `session/prompt` as far as the model call — with an empty user
layer **and** with a user row that configures the skipped bundle's entry,
i.e. the shape the "another row depends on it" story needed. `scripts/acp-doctor.mjs` reports
exactly that: `BOOT OK` + `DEGRADED <n> inactive items`. It prints `LAYER manifest-gate` only when
the boot really is down for a skip, which for this bridge means the *self*-skip (no handshake at
all), and its `FIX` splits the cases instead of telling you to upgrade this bridge when the skipped
bundle is someone else's. Upstream also takes an exact-version exemption when a bundle has no
release for this line: `dsh plugin allow-version <pkg@ver> --dsh-version <exact> --accept-risk
--profile <p>` — measured to lift the skip, with the boot still settling; granting it is accepting
the crash/data-loss risk the warning names, and whether that bundle's code works on this line is
exactly what stays unverified.

## [0.9.1] - 2026-09-25

dsh **0.1.7** support: the agent-preset roster was repackaged upstream, so the bridge ships
both shapes (generation-gated rows) and inlines the four preset declarations. Migration record:
[`docs/plans/2026-09-24-dsh-0.1.7-support.md`](docs/plans/2026-09-24-dsh-0.1.7-support.md).

`dsh` 0.1.7 **repackaged the agent-preset roster**. `@deepseek-ai/dsh-agent-presets` (which
bundled the standard/ptc/minimal/cordis compositions and prepended them as a read-only
`system` root) has no 0.1.7 release at all; that line ships
`@deepseek-ai/dsh-agent-preset-registry` plus one `@deepseek-ai/dsh-agent-preset` declaration
row per preset. Three surfaces moved, and the bridge absorbs all three without dropping a
supported line:

| Surface | ≤ 0.1.6 | ≥ 0.1.7 | What the bridge does |
|---|---|---|---|
| roster row | `@deepseek-ai/dsh-agent-presets`, `config.default` | `@deepseek-ai/dsh-agent-preset-registry`, `config.default` | both rows ship; each is `disabled` by a generation gate, so exactly one activates (they provide the same service name, and a second `provide` would throw). Both resolve from the running CLI's own installation — neither is a `peerDependency` of this package, and 0.10.0 removed the legacy one for exactly that reason (see below) |
| shipped presets | bundled inside the roster package (`system` root) | one `@deepseek-ai/dsh-agent-preset` declaration each — whoever wants them ships them (`@deepseek-ai/dsh-web-app` ships `presets/*.patch.yml` layers) | the four declarations are inlined into `cordis.patch.yml` verbatim from the web-app bundle (MIT, 0.1.7-rc.2), with the display metadata the old roster's per-preset `preset.yml` carried added back — 0.1.7 publishes no `name` for a shipped id |
| mountable resolution | private `presets.resolveMountable(id)` | `presets.resolve(id)` returns a broken row on purpose; every mounting path refuses it *after* resolution | member probe: `resolveMountable` when present, otherwise `resolve()` plus the row's own `broken` reason |

The gate reads the **identity of the installation that is booting**: it opens
`profileContext.installAnchor` — the running CLI's own `package.json` — and its `version`
decides the shape (the registry roster starts at 0.1.7 on the 0.1.x line). `profileContext`
does not exist on the older lines at all (`≤ 0.1.6`), which is itself the answer, and
anything unreadable or unclassifiable keeps the older row. `!!js` expressions are evaluated `with (ctx)` over the
loader context plus globals, so the version has to be read rather than queried — nothing in
scope exposes it.

A resolver probe (`ctx.pluginPackages.packageOf(…, <profile URL>)`) was the first attempt and
is **wrong for a `link:`-installed bridge**: that resolution runs from the profile and reaches
the *linked checkout's* own tree, so a dev checkout carrying 0.1.7 packages made a 0.1.6 host
believe the registry was present — it disabled the working roster row and then failed to
import five 0.1.7 rows (`agent-preset-registry: failed to import`). The installation anchor
has no such reach: it is a fixed path inside the running CLI, independent of the profile, the
link targets, and the layout (npm flat or pnpm strict). Nothing here can fail a boot — the
worst case is the graceful degradation 0.1.7 had before this release (`agent_preset` simply is
not offered).

`DSH_ACP_PRESET`, the `agent_preset` config option and `/preset` behave the same on every
line.

### What 0.1.7 changes about a large session store

Reading a stored session log got much more expensive on 0.1.7 (~217ms per log against
~9ms on 0.1.5), and `session/list` needs one title per stored session. Before this fix the
list asked for a `stat()` **and** a full decode per session, so a store of a few hundred
sessions made the call take ~60 seconds — past the client's 30-second wire timeout, which
left the session sidebar empty. It was invisible to a scratch profile: a fresh home has too
few sessions to notice.

The list now takes the size and revision of every session from a single store pass and
decodes only as many logs as a short budget allows, **most recently updated session first**
(that is the order the sidebar shows). Whatever the budget does not reach keeps resolving in
the background and arrives as `session_info_update`, and titles are cached by revision, so a
re-list is a map lookup. Measured on a real 302-session store: 60s → 2.7s per call, with the
rest of the titles arriving as they resolve. `DSH_ACP_LIST_BUDGET_MS` tunes the budget
(default 2500).


### Upgrading to 0.1.7

Two things outside this package to check, both silent when wrong:

- **every third-party bundle** must have a release built for the line. An older release may
  import `SettingsProvider`, which 0.1.7's `dsh-settings` replaced with `SettingsForms`; the
  entry fails to import, the loader continues, and that capability is simply gone.
  `scripts/acp-doctor.mjs` now reports a
  degraded boot (`RESULT DEGRADED` with the entry names, exit 1) instead of `RESULT READY`.
- **user-authored presets** in `$DSH_HOME/.agent-presets/` are no longer discovered — see
  [Your own presets](README.md#your-own-presets).

## [0.9.0] - 2026-09-19

**Breaking.** Declared-surface-only rewrite: floor `0.1.5-rc.2`, `session/delete` removed, the
launcher no longer rewrites `DSH_HOME`. Migration record:
[`docs/plans/2026-09-20-public-api-only-migration.md`](docs/plans/2026-09-20-public-api-only-migration.md).

| Change | Effect | If it bites |
|---|---|---|
| floor raised to dsh **≥ 0.1.5-rc.2** | older hosts fail at mount time with a named error instead of degrading silently | upgrade the CLI (`npm install -g @deepseek-ai/dsh@0.1.5-rc.2`), or stay on the `feat/dsh-0.1.3-plus-support` branch for ≤ 0.1.2-rc.1 |
| **`session/delete` removed** | the ACP capability is no longer advertised and persisted sessions are never deleted — the harness declares no public persistence delete | the files stay under `$DSH_HOME/sessions/<slug>/<id>/`; remove them by hand if you must. An upstream issue tracks a public delete API |
| the launcher **no longer rewrites `DSH_HOME`** | the ACP profile boots inside the home the launcher was started with (`${DSH_HOME:-$HOME/.dsh}`), sharing credentials, settings, sessions and presets with `dsh web` | used the old implicit `~/.dsh-acp`? Point the launcher at it explicitly (`"DSH_HOME": "<home>/.dsh-acp"` in Zed's `agent_servers.env`) or migrate back to the shared home |
| the `assistant/chunk` seam is gone | live streaming is `agent/assistant-stream` only (the floor carries it) | upgrade the CLI; a host that streams nothing is still covered by the committed `assistant/message` fallback |

## [0.8.x] - unreleased

The 0.1.3+ live-stream seam and the 0.1.5 persistence-handle API. Never published; superseded
by 0.9.0.

## [0.7.0] - 2026-09-04

Runtime probing of both harness generations (≤ 0.1.2-rc.1). Earlier versions predate this
changelog.
