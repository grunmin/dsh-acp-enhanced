# Migration plan: public-API-only surface (dsh ≥ 0.1.5-rc.2)

- Date: 2026-09-20
- Branch: **`feat/public-api-only`** (stacked on `feat/dsh-0.1.3-plus-support`)
- Status: **P0–P4 done** — executed 2026-09-20; §11 is the execution record,
  §12 the environment migration that followed
- Supersedes nothing; layers on top of the 0.1.3+ adaptation

> **Handoff note for a fresh session.** Read this file top to bottom first. It is
> written to be self-contained: it records the decisions already taken, the
> machine state, the exact work items with `file:line`, and the commands to
> verify each phase. Nothing else from the originating conversation is needed.
> §11 records what the execution session actually did, including the two
> deviations and the open items it did not close.

---

## 0. Two directives from the maintainer

1. **Remove the launcher's implicit home switch.** The launcher must never
   rewrite `DSH_HOME` / silently move the profile to `~/.dsh-acp`. The ACP
   profile stays a **separate profile inside the current home**
   (`$DSH_HOME/profiles/acp-enhanced`), sharing credentials, settings, sessions
   and presets with `dsh web`.
2. **Do not use private APIs.** Only touch the harness's *declared* surface.

Two rulings on the trade-offs this forces:

3. **Accept the floor raise to dsh ≥ 0.1.5-rc.2** (currently 0.1.0-rc.6).
4. **Drop `session/delete`** (no public persistence delete exists) and file an
   upstream issue asking for one.

## 1. What "public API" means here (operational definition)

Upstream generates the authoritative surface:

| Source | Covers |
| --- | --- |
| `docs/capability-seams.md` | declared services (`ctx.*`) with owner + consumers |
| `docs/event-producer-consumer.md` | declared events with `Declared in file:line` |
| `docs/architecture.md:74,109,139` | "Events are the extension points"; lists `agent/assistant-stream` as a live extension point |
| published package `lib/types/*.d.ts` | service class members, exported helpers |

Test: **can the usage be pointed at in one of those?** If not, it is private.
`internal/*` event strings are always forbidden.

Important correction already made: **`agent/assistant-stream` is NOT private.**
It is declared in `packages/core/agent/src/runtime-types.ts:363`, registered in
the event matrix (dispatchers `agent-loop`; listeners `headless`,
`session-controller`), and named as a live extension point in
`docs/architecture.md`. It is the only sanctioned live-streaming seam, so it
stays — with the durable `assistant/message` fallback as the source of truth.

## 2. Current state

Branches (local, `origin` has only the first two):

```
main
└── feat/dsh-0.1.3-plus-support   (pushed) 7 commits — 0.1.3+ adaptation, floor 0.1.0-rc.6
    └── feat/public-api-only      (local) 1 commit  — P0 public-surface guard
```

`feat/public-api-only` content so far:

- `f86e123 chore(compat): add a public-surface guard for the harness API we consume`
  - `scripts/compat/public-surface.json` — reviewed allow-list, every entry with
    an upstream citation; carries `supportedDshFloor: "0.1.5-rc.2"`.
  - `scripts/api-surface-check.mjs` — extracts harness usage from `lib/`
    (services, service members through local aliases, events, package imports),
    strips comments first, rejects `internal/*`.
  - `node scripts/api-surface-check.mjs`; added to the CI **syntax** check only.

Already-adapted pieces inherited from the parent branch (still valid, do not
redo): `agent/assistant-stream` seam with per-step latch, persistence
dual-generation helpers, `assistant/message` fallback, `cordis.patch.yml` row
updates, CLI pinned at `0.1.5-rc.2`, 4-generation `compat-check`.

## 3. P0 result = the P2 worklist (machine-verified)

`node scripts/api-surface-check.mjs` currently exits 1 with **30 reports**
across **17 unique code sites** (each site is reported twice when it also
matches the denylist — that duplication is expected, not a bug).

`RESULT` after P2 must be `PUBLIC SURFACE OK`. Then, and only then, wire the
check in as a **blocking CI step**.

### A. dead code (1)

| Site | Now | Action | ACP impact |
| --- | --- | --- | --- |
| `lib/index.js:64` `import * as agentPresetsModule from '@deepseek-ai/dsh-agent-presets'` | zero usages | delete | none; also removes a link-time dependency |

### B. legacy-generation branches (10) — deleted together with the floor raise

| Site | Now | Action | ACP impact |
| --- | --- | --- | --- |
| `lib/index.js:480` `session.events` | ≤0.1.1 raw event array | keep only `session.snapshotEvents()` | none on ≥0.1.2-rc.1 |
| `lib/index.js:822`, `:826` `assistant/chunk` | ≤0.1.2-rc.1 live seam (case + `ACP_DEBUG` branch) | delete; live streaming is `agent/assistant-stream` only | none on ≥0.1.3-alpha.2 (event absent there anyway) |
| `lib/index.js:495` `permissionState` probe | picks `current(session)` vs `current(events)` | call `permission.current(session)` directly | none on ≥0.1.2-alpha |
| `lib/index.js:1875`, `:1877` `userQuestions.registerProvider` | ≤0.1.1 registration | delete; keep the `user-questions/request` waterfall (already at `:1884`) | none on ≥0.1.2 (that IS the active path) |
| `lib/index.js:2277`, `:2278` `persistence.load` | ≤0.1.2 `load() → {meta, events}` | keep only `open(id, 'read')` handle path | none on ≥0.1.5 |
| `lib/index.js:2307`, `:2308` `readRaw` + `supportsRawArtifacts` | raw-artifact title fast path | keep only `stat()` size guard + handle read | none on ≥0.1.5; title parsing now reads events (8 MB ceiling already in place) |

### C. equivalent replacements (6)

| Site | Now | Action | ACP impact |
| --- | --- | --- | --- |
| `lib/index.js:1433`, `:2528`, `:2567`, `:2618` `permission.presets[name]` | hand-builds `{name, description}` for ACP modes / config option | use declared **`permission.optionOf(name)`** (the service itself builds its options this way) | none expected |
| `lib/index.js:1563` `permission.apply(session, name, cb)` | `apply` + manual `approval.setPolicy(agent, policy)` | use declared **`permission.set(session, name)`** | none; strictly more correct — `set()` is `this.apply(session, name, p => setApprovalPolicy(session, p))`, and the `.d.ts` marks `apply` as `private apply;` |
| `lib/index.js:2953` `persistence.locate` | `session/delete` resolves the backend dir and `rm -rf`s it | **drop `session/delete`** and remove `delete` from the advertised session capabilities | ⚠️ the only real feature loss: clients can no longer delete a persisted session. `session/close`, `session/list`, `session/load`/resume unaffected; files remain under `$DSH_HOME/sessions` |

### P2 verification points (do these explicitly)

1. `optionOf(name)` output is byte-equivalent to what `presets[name]` produced
   (ACP modes + `permission_preset` dropdown name/description).
2. `permission.set()` really applies both knobs (sandbox **and** approval) —
   re-test a mode switch end to end.
3. After dropping `session/delete`: clients don't offer it and `session/list`
   output is unchanged.

## 4. P1 — remove the implicit home switch

File: `scripts/dsh-acp-zed.sh`.

**Target behaviour**

- Delete `ISOLATED_HOME`, the `DSH_ACP_HOME` export, and the "isolated home"
  guard block. **The launcher never writes `DSH_HOME`.**
- Keep the CLI resolution order (`$DSH_PATH` → package-local
  `<pkg>/node_modules/.bin/dsh` → global). It now decides *which dsh*, never
  *which home*.
- Profile dir: compute instead of climbing paths —
  ```sh
  PROFILE_NAME="${DSH_ACP_PROFILE:-acp-enhanced}"
  EFFECTIVE_HOME="${DSH_HOME:-$HOME/.dsh}"
  : "${DSH_ACP_PROFILE_DIR:=$EFFECTIVE_HOME/profiles/$PROFILE_NAME}"
  ```
  (the old `../../..` climb breaks for a `link:` checkout; `DSH_ACP_PROFILE_DIR`
  remains an override).
- Missing-profile guard: if `$EFFECTIVE_HOME/profiles/$PROFILE_NAME` is absent,
  print install instructions and exit 127 (replaces the isolated-home guard).
- **Generation-mismatch warning** (new): read
  `$EFFECTIVE_HOME/profiles/node_modules/@deepseek-ai/dsh-agent/package.json`
  and compare its `version` with `"$DASH_BIN" --version`. If they differ, warn
  on stderr: the shared closure will be healed to the booting CLI, so every
  other dsh process under this home (`dsh web`, …) must be restarted. Must go to
  **stderr** — stdout is the ACP wire.
- Keep: node discovery, the `DEEPSEEK_API_KEY` fallback from a running
  `dsh web`, `exec "$DASH_BIN" --profile "$PROFILE_NAME" "$@"`.
- `scripts/init-acp-home.sh`: demote to an **optional** isolation tool. Update
  its header and its closing message (it currently promises the launcher will
  export `DSH_HOME` automatically — no longer true). It may keep setting
  `DSH_HOME` for its own operations.

**Constraint that must not regress:** the maintainer's Zed config points at
`~/.dsh/profiles/acp-enhanced/node_modules/dsh-acp-enhanced/scripts/dsh-acp-zed.sh`.
Keep that path and its arguments working unchanged.

**P1 verification**

- `DSH_HOME=/tmp/x bash scripts/dsh-acp-zed.sh` with no profile → clear error,
  and `/tmp/x` untouched; assert `DSH_HOME` is not rewritten (add a tiny test).
- With a seeded profile: boots, and `DSH_HOME` stays as passed in.
- Seed `<home>/profiles/node_modules/@deepseek-ai/dsh-agent` with a different
  version → warning appears on stderr, stdout stays clean.

## 5. P3 — compatibility guardrails

1. **`dsh-acp-enhanced doctor`** (new script): boot the profile once under the
   resolved CLI and classify failures into the three layers —
   *link-time* (`does not provide an export named`), *mount-time*
   (`failed to apply loader entry`, `requires … in the Host scope`),
   *run-time* (method missing on initialize). Name the offending bundle and
   print the fix command. Also print: CLI version, home, profile, every bundle
   + version, and the supported range.
2. **stderr signature translation** in the launcher for the same three classes.
3. **Minimise the ACP profile**: bundles = `dsh-base` + `dsh-acp-enhanced` only;
   move third-party bundles (e.g. `dsh-free-search`) to **preset-scoped**
   mounting. Failure domain then cannot mismatch, because `dsh-base` ships with
   the CLI. This is the structural answer to "a bad plugin in the profile kills
   ACP": `cordis-plugin-loader` `update()` rethrows any rejected entry
   (`Promise.allSettled` → `throw failures[0]` / `AggregateError`), so the
   profile is a single failure domain.
4. README recovery matrix: symptom → locate command → fix command.

## 6. P4 — docs and migration

- Bilingual README: replace the isolated-home sections with the shared-home
  model; compatibility matrix floor → 0.1.5-rc.2; document one-CLI-generation-
  per-home; document the `session/delete` removal.
- Note the breaking change in the version bump.

## 7. Version and CI changes (land with P2)

- `package.json`: version **0.9.0**; peer ranges → `^0.1.5-rc.2 || ^0.1.6-alpha.1`
  (keep whatever the pinned CLI declares); keep the CLI devDependency at
  `0.1.5-rc.2`.
- `scripts/compat-check.mjs`: drop the `legacy` (0.1.0-rc.6) and `projection`
  (0.1.2-rc.1) generations; keep `frames` (0.1.5-rc.2) and `framesNext`
  (0.1.6-alpha.2).
- `.github/workflows/ci.yml`: matrix `dsh-version` → `['0.1.5-rc.2']` (plus
  optionally `0.1.6-alpha.2`); **add the blocking `node scripts/api-surface-check.mjs`
  step in the commit that reaches zero**.
- `scripts/lib/host-service-row.mjs`: the generation gate can stay; from 0.1.2 on
  the row is always required.

## 8. Machine state / environment gotchas

> **Superseded 2026-09-19 (session 3): the environment was migrated, see §12.**
> The original state is kept below because the failure modes it describes are
> what the launcher/doctor now translate.

- The maintainer's live setup: Zed →
  `~/.dsh/profiles/acp-enhanced/node_modules/dsh-acp-enhanced/scripts/dsh-acp-zed.sh`;
  that installed bridge copy is **0.7.0** (from `file:dsh-acp-enhanced-0.7.0.tgz`,
  not a symlink to the repo); global `dsh` is **0.1.1-rc.2**; `~/.dsh-acp` does
  **not** exist. Two `dsh --profile acp-enhanced` processes may be running.
- Consequence: after P2 the **global dsh must be upgraded to ≥ 0.1.5-rc.2** or
  ACP stops (the launcher should say so instead of degrading silently).
- Verification uses isolated scratch homes, never `~/.dsh`:
  ```sh
  DSH_HOME=/tmp/acp-verify-home PATH="$PWD/node_modules/.bin:$PATH" node scripts/acp-smoke-keyless.mjs
  DSH_HOME=/tmp/acp-verify-home PATH="$PWD/node_modules/.bin:$PATH" node scripts/acp-message-fallback-test.mjs
  DSH_HOME=/tmp/acp-verify-home PATH="$PWD/node_modules/.bin:$PATH" node scripts/acp-resume-test.mjs
  ```
  (the smoke scripts seed the `subagent-model-selection-settings` row themselves;
  delete scratch homes afterwards — they hold copied credentials).
- Known false alarms: `acp-smoke-keyless.mjs` asserts `deepseek-v4-flash` in the
  `/model` catalog, which fails on a home whose `settings.yaml` pins another
  model. Use a fresh scratch home.

## 9. Verification matrix (per phase)

| Phase | Commands | Expected |
| --- | --- | --- |
| P0 (done) | `node scripts/api-surface-check.mjs` | 30 violations listed (worklist) |
| P1 | launcher tests described in §4 | `DSH_HOME` never rewritten; mismatch warning on stderr |
| P2 | `node scripts/api-surface-check.mjs` | `PUBLIC SURFACE OK` |
| P2 | `node scripts/compat-check.mjs` | 2/2 generations link clean |
| P2 | keyless smoke + fallback test + resume test on 0.1.5-rc.2 | ALL PASSED (`frames=…`, reply exactly once) |
| P2 | `node scripts/acp-mcp-test.mjs` on 0.1.5-rc.2 | ALL PASSED |
| P3 | inject a broken bundle into a scratch profile, run `doctor` | names the bundle + prints the fix |

## 10. Open items / follow-ups

- **Upstream issue**: request a public delete on `SessionPersistence` (or a
  documented session-delete service) so `session/delete` can return.
- `attachments` (`validateImage`, `saveImage`, `imageLimits`) and
  `agentDefaultModel` (`saveSelection`, `currentSelection`) members are in the
  allow-list with a **"pending citation check"** note — confirm them against the
  upstream d.ts and drop the notes.
- `command-goal` stays intentionally enabled at base level (see the long comment
  in `cordis.patch.yml`): the shipped `standard` preset only started owning that
  row in 0.1.2-rc.1, so disabling it would delete `/goal` on ≤0.1.1 hosts.
- The parent branch `feat/dsh-0.1.3-plus-support` remains the escape hatch for
  users who cannot move off ≤0.1.2-rc.1.
- **Fixed in session 3: the bundle patch now ships the `standard` preset's host
  row.** The shipped `standard` preset mounts `tool-subagent` with
  `modelSelectionSettings: true`, which needs `subagent-model-selection-settings`
  in the Host scope; `dsh-base` carries no such row, so a bare
  `dsh plugin --profile X add dsh-acp-enhanced` profile failed every
  `session/new` (`agent-presets: preset "standard" failed to mount: … tool-subagent:
  modelSelectionSettings requires …`). The official `@deepseek-ai/dsh-web-app`
  bundle inserts this exact row (its `cordis.patch.yml:47`), so the bridge does
  the same — that is the app-bundle pattern, and the module exists on every
  supported CLI now that the floor is 0.1.5-rc.2.
  The row keeps the **canonical id**, so the user layer must not seed a second
  copy: `cordis-plugin-loader` aborts the whole tree with `duplicate loader entry
  id: …`. The old seeding is therefore gone from the repo —
  `scripts/lib/host-service-row.mjs` is deleted, the smoke/MCP scripts no longer
  call it (so CI now proves a *bare* profile boots and composes a `standard`
  session), `init-acp-home.sh` no longer writes the row and instead retires a
  legacy copy (timestamped backup, comments and other rows preserved, `[]`
  restored when the layer empties), and the doctor classifies
  `duplicate loader entry id` as mount-time with the exact line to delete.
  Migration for an existing profile: re-run `scripts/init-acp-home.sh`, or delete
  the row from `$DSH_HOME/profiles/<name>/cordis.patch.yml` by hand.

## 11. Execution record (2026-09-20, session 2)

Commits on `feat/public-api-only` (oldest last):

| Commit | Phase |
| --- | --- |
| `03493e3 docs: document the 0.9.0 breaking changes and the shared-home model` | P4 |
| `fa65a54 feat(doctor): name the boot failure layer and keep the profile minimal` | P3 |
| `783c7bc feat(api)!: consume only the declared harness surface (floor 0.1.5-rc.2)` | P2 |
| `faae6fe fix(launcher): stop moving the profile to an implicit isolated home` | P1 |
| `539bc43 docs(plan): handoff plan for the public-API-only migration` | P0 |

Every row of §9 was run and passed, plus the three explicit P2 verification
points:

| Check | Result |
| --- | --- |
| `node scripts/api-surface-check.mjs` | `PUBLIC SURFACE OK (floor dsh 0.1.5-rc.2; 14 services, 5 events)` |
| `node scripts/compat-check.mjs` | `COMPAT CHECK PASSED (2 generations link clean)` |
| keyless smoke / mcp / fallback / resume on 0.1.5-rc.2 | ALL PASSED; fallback `frames=18`, reply exactly once |
| P2.1 `optionOf` ≡ `presets[name]` | live: `availableModes` and the `permission_preset` options are identical option-for-option (3 presets, labels = table keys); now a permanent smoke assertion |
| P2.2 `permission.set()` writes both knobs | live: `session/set_mode danger-full-access` logged `permission/preset` + `sandbox/mode` + `approval/policy`; the preset survives `session/load` in a new process (now asserted in the resume test) |
| P2.3 `session/delete` gone | `sessionCapabilities` = `{list, additionalDirectories, close}`; `session/list` output unchanged (asserted) |
| P1 launcher | `node scripts/acp-launcher-test.mjs` — 21 checks: home never rewritten, missing profile → 127, drift warning stderr-only, three boot-failure translations |
| P3 doctor | healthy scratch profile → `READY`; profile with an injected unresolvable bundle → `LAYER mount-time`, `SUBJECT broken-third-party (dsh-definitely-not-installed)`, exit 1 |
| P4 docs | compat matrix replaced by the single-line statement + a breaking-changes table |

### Deviations from the plan (both deliberate)

1. **the per-step `streamSeam` latch was removed, not kept.** §2 said the
   `agent/assistant-stream` seam "with per-step latch" was inherited and valid —
   true while `assistant/chunk` existed. Deleting that seam (§3B) left the latch
   write-only, so it went with it. Behaviour is unchanged: a single seam cannot
   double-stream.
2. **`dsh-agent-presets` was imported for real** (`isPresetClientError`'s
   instanceof fallback), so §3A's "zero usages" was wrong. The import was deleted
   *with* that fallback, which is dead on the new floor: 0.1.5 throws
   `RemoteError` with an `agent-preset/*` code, and `UnknownPresetError` /
   `PresetMountError` / the `presetId` branch no longer exist upstream.
   `scripts/compat/public-surface.json` also gained `agentPresets.serviceFor`
   (used through a call, so the extractor never saw it) and lost the two
   "pending citation check" notes — both members were confirmed against the
   installed 0.1.5-rc.2 `lib/types/*.d.ts`.

### Not closed

- §10's `command-goal` item was left as the plan states ("stays intentionally
  enabled"). Its stated reason — `/goal` would disappear on ≤0.1.1 hosts — no
  longer applies on this branch, since the floor is 0.1.5-rc.2 and the shipped
  `standard` preset owns that row from 0.1.2-rc.1. Adding `- id: command-goal` +
  `disabled: true` to `cordis.patch.yml` would align it with the official
  web-app/tui patch. Left for the maintainer to decide.
- `subagent-model-selection-settings` still lives in the profile's user layer
  (`init-acp-home.sh` / `host-service-row.mjs`) although the bridge could now
  ship the row itself in `cordis.patch.yml` (the module exists on every
  supported CLI). §7 blessed leaving the generation gate; moving it would change
  every fresh profile boot, so it is a separate change.
- The launcher's global-CLI fallback is still reachable, but the machine's
  global `dsh` is **0.1.1-rc.2** — below the new floor. Reinstalling the bridge
  into `~/.dsh/profiles/acp-enhanced` without upgrading the global CLI (or
  pinning `DSH_PATH`) leaves ACP dead; the doctor and the launcher's run-time
  translation both say so.
- §8's environment note is otherwise unchanged: the installed bridge copy in the
  maintainer's profile is still 0.7.0 from a tarball, so the live setup is
  unaffected until it is reinstalled.

## 12. Environment migration (2026-09-19, session 3 — at the maintainer's request)

§8's state is superseded. What was done, in order:

1. **Global CLI upgraded**: `npm install -g @deepseek-ai/dsh@0.1.5-rc.2`
   (`/opt/homebrew/lib/node_modules`, the install prefix `npm prefix -g` reports).
   npm 11 blocked the closure's install scripts; checked that the artifacts those
   scripts produce are already shipped — `node-pty/prebuilds/darwin-arm64/pty.node`
   and an executable `spawn-helper` (all `ensure-spawn-helper.mjs` does is
   `chmod 0755`), plus koffi's `@koromix/koffi-darwin-arm64/koffi.node`.
2. **The live profile relinked to this checkout**:
   `dsh plugin --profile acp-enhanced add link:/Users/runmin/dev/dsh-acp-enhanced`
   → `node_modules/dsh-acp-enhanced` is now a symlink to the repo (bridge 0.9.0
   instead of the 0.7.0 tarball), so the running bridge is the working tree.
3. **The required host row added to the profile's user layer** — first as a
   hand-written insert, then (later the same session) moved to where it belongs:
   the bridge's bundle patch, with the user-layer copy removed again. See §10's
   last item; the temporary hand-edit is not part of the final state.
   `~/.dsh/profiles/acp-enhanced/cordis.patch.yml` now carries only the local
   `acp-enhanced` override plus a note explaining why the host row is absent.
4. **`dsh-free-search` kept at 0.4.24** — the maintainer's rule was "delete it if
   it is incompatible", and it is not: a scratch profile with
   `@deepseek-ai/dsh-base` + `dsh-acp-enhanced` + `dsh-free-search` boots clean
   under 0.1.5-rc.2 with both 0.4.24 and the latest 0.4.32, mounts
   `web-search-free`, and patches the host `web` row to `searchProvider: ddg`
   (`dsh --profile … --dump-config`). It stays a boot-path bundle, so the profile
   is deliberately not minimal (the doctor flags it).
5. **Zed pointed at the repo launcher**:
   `~/.config/zed/settings.json` → `agent_servers."dsh-acp-enhanced".args` is now
   `/Users/runmin/dev/dsh-acp-enhanced/scripts/dsh-acp-zed.sh` (backup:
   `settings.json.bak-20260919-154923`). The `env` block (provider/model/proxy)
   is untouched.

Verification on the real home (not a scratch one):

| Check | Result |
| --- | --- |
| `node scripts/acp-doctor.mjs` | `READY` — bridge 0.9.0, base 0.1.5-rc.2, free-search 0.4.24, closure healed to `@deepseek-ai/dsh-agent 0.1.5-rc.2` |
| live `initialize` through the launcher | `deepseek-harness-acp-enhanced 0.9.0` |
| live `session/new` (standard preset) | OK — modes + `permission_preset` (danger-full-access) + `agent_preset` = `standard` (options: standard, ptc, minimal, cordis, router-standard) |
| live `session/list` | 481 real sessions read through the 0.1.5 handle API, 198 with titles — the persistence rewrite holds over the existing archive |
| `dsh --profile web --dump-config` | composes cleanly on 0.1.5-rc.2 (613 rows, no errors), so `dsh web` survives the closure heal |

Follow-up fix shipped in the same session (see §10's last item): the
`subagent-model-selection-settings` row moved from the profile's user layer into
`cordis.patch.yml` (the bundle patch, mirroring `@deepseek-ai/dsh-web-app`), the
legacy seeding helper was deleted, and the migration path was verified three
ways — bare profile → `READY` + `session/new` OK; profile with a legacy copy →
`LAYER mount-time`, `SUBJECT duplicate loader entry id: subagent-model-selection-settings`;
`init-acp-home.sh` → row retired, comments kept, `[]` restored, boot `READY`.

Consequence to remember: the closure flipped from 0.1.1-rc.2 to 0.1.5-rc.2 under
the ACP threads that were already running (spawned by the old global CLI), which
is precisely the drift the launcher warns about. **Existing Zed threads must be
restarted** (close/reopen the thread, or restart Zed) to run on the new stack;
the freshly created session used for the check above was deleted by hand, since
`session/delete` no longer exists.

## 13. Impact on existing users (analysis, 2026-09-19 session 3)

Who "existing users" are: the npm `latest` is **0.7.0** (0.8.0 was never
published — this branch is 0.9.0), so every installed copy is on the pre-0.1.3
API line. `dsh-acp-enhanced` is a caret-on-0.x dependency in the profile, so
`dsh plugin update` cannot pull a user onto 0.9.0 by accident; the upgrade is
always explicit.

Each scenario below was executed, not inferred (scratch homes + the shipped
launcher; the published 0.7.0 tarball fetched with `npm pack`):

| Scenario | Observed | Now mitigated by |
| --- | --- | --- |
| **CLI upgraded, bridge left at 0.7.0** | `initialize` OK, then **every `session/new` fails**: `Internal error` → `agent-presets: preset "standard" failed to mount: … tool-subagent: modelSelectionSettings requires … in the Host scope`. 0.7.0 also has **no `agent/assistant-stream`** (0 hits) and no `assistant/message` fallback, and only `persistence.load` (no `open()` handle) — so streaming, replies and the archive would break even if sessions opened | doctor now performs a real `session/new` (the old check stopped at the handshake and would have said READY); `classify` gained a host-scope branch that names the missing service and tells you to move bridge and CLI together. Nothing can warn *before* the fact, because that bridge is already installed |
| **Bridge upgraded, CLI left behind** (0.1.1-rc.2) | profile dies while loading: `failed to import loader entry subagent-model-selection-settings (…): Package subpath './model-selection-settings' is not defined by "exports"` — names an internal row, not "your dsh is too old" | launcher warns on stderr **before** the boot (`below the range this bridge supports: ^0.1.5-rc.2 || ^0.1.6-alpha.1`); doctor prints `RESULT FAIL — CLI too old` and never boots. Both driven by the new `scripts/lib/dsh-version.mjs` |
| **Both together, profile seeded per the old README** (`subagent-model-selection-settings` in the user layer) | boot aborts: `TypeError: duplicate loader entry id: subagent-model-selection-settings` | launcher pre-warns (anchored on the real row line, so a comment does not false-positive); doctor classifies the duplicate and prints the fix; `init-acp-home.sh` retires the row (backup, comments kept, `[]` restored) |
| **Both together, profile booted from a checkout / `DSH_PATH`** | the old launcher had moved the profile to `~/.dsh-acp`; the new one resolves `~/.dsh`, so it exits 127 (`profile not found`) | the missing-profile branch now detects `~/.dsh-acp/profiles/<name>` and prints the exact `DSH_HOME=<home>` fix |
| **Both together, stock npm install** | works; verified doctor READY, `session/new` OK, 481 archived sessions listed through the 0.1.5 handle API | — |
| **`session/delete`** | clients lose the capability (Zed stops offering it); persisted files stay under `$DSH_HOME/sessions` | documented; upstream issue still open |
| **Third-party bundles** | any bundle that cannot load on 0.1.5 kills the whole profile (single failure domain). `dsh-free-search` 0.4.24 and 0.4.32 verified good | doctor names the entry; README's "Keep the profile minimal" |

Two extra checks were added in the same breath:

- **`acp-doctor.mjs` now opens a thread** (`session/new`) after the handshake and
  before declaring `READY`, and deletes the throwaway session's artifact directly
  (there is no public delete). Without it the 0.7.0-under-a-new-CLI state looked
  healthy.
- **`scripts/lib/dsh-version.mjs`** is the single semver comparison shared by the
  launcher (via `--supported`) and the doctor (`isSupported`); it fails open on an
  unreadable version rather than warning wrongly. Unit-checked against the real
  version strings (0.1.1-rc.2 … 0.1.6-alpha.2, 0.1.10, 0.2.0).

`scripts/acp-launcher-test.mjs` grew to 30 checks, covering the too-old warning
(warn, never block; stdout untouched), the duplicate-row warning and its
comment false-positive, and the `~/.dsh-acp` migration hint.

## 14. Upgrade-adaptation practice: upstream, ecosystem, and us (research, session 3)

The maintainer asked whether our upgrade-adaptation practice matches the
recommended one, given that dsh has broken and will keep breaking. Researched
against the public upstream repository (`deepseek-ai/deepseek-harness`:
`docs/architecture.md`, `docs/capability-seams.md`, `docs/cookbook/*`), the
shipped official packages, and published third-party plugins.

### What upstream does

| Mechanism | Evidence | Meaning for an out-of-tree bundle |
| --- | --- | --- |
| **Lockstep versions: one release per CLI line** | `dsh-base`, `dsh-web-app`, `dsh-headless`, `dsh-acp`, `dsh-acp-app` are all `0.1.5-rc.2` — equal to the CLI — with their `@deepseek-ai/dsh-*` deps at `^0.1.5-rc.2` | upstream never supports two generations at once; it ships a build per line |
| **Workspace invariant: package `version` matches the root** | `docs/cookbook/adding-a-package.md:25` | in-tree packages cannot drift; only out-of-tree plugins need ranges |
| **Everything is a plugin; extend by mounting beside it** | `docs/architecture.md:11-13` | a third-party bundle replacing an official row (our case) is the intended shape |
| **Profiles hold out-of-tree plugins; patches target rows by id** | `docs/architecture.md:19,23,27` | `dsh.profile.bundles` + `dsh.bundle.patch` are the sanctioned packaging |
| **Host rows belong to app bundles** | `dsh-web-app/cordis.patch.yml:47` inserts `subagent-model-selection-settings`; this repo now does the same | a bundle ships the rows its composition needs |
| **A custom ACP profile may replace the ACP row** | `dsh-acp-app/README.md:61` | our existence is a supported configuration, not a hack |
| **ACP profiles use startup-only patches** | `dsh-acp-app/README.md:63` | profile edits take effect on the next process — matches our docs |
| **No shim for a removed private surface** | `docs/architecture.md:49`: "The removed private direct-config carrier has no compatibility bin or fallback parser" | upstream does not carry dead private surfaces — the stance P2 adopted |
| **Per-package documented surface** | `dsh-acp/README.md:64` (per-method `Stable …` table) + `Known Limitations` sections | documenting the supported surface is the convention |

### What the ecosystem does

Both published plugins checked declare long OR-chains that are already stale:

- `dsh-free-search@0.4.32`: `^0.1.0-rc.7 || ^0.1.1-rc.2 || ^0.1.2-alpha.2 || ^0.1.3-alpha.2 || ^0.1.5-alpha.1`
  — it lists neither `0.1.5-rc.2` nor `0.1.6-alpha.2`, yet boots, mounts and configures
  `web.searchProvider` on both (§12).
- `dsh-mnemon@0.5.11`: skips the 0.1.3/0.1.4 lines entirely, stops at `0.1.5-rc.1`.

So the community norm is a best-effort OR-chain plus runtime tolerance, with declared
ranges that are neither enforced nor reliable — the pattern P2 deliberately deleted here.

### Conformance

| Practice | Us | Verdict |
| --- | --- | --- |
| declared-surface-only, machine-enforced | `api-surface-check.mjs` + `public-surface.json`, blocking CI | **stronger than upstream requires** |
| peer ranges mirroring the CLI's ranges; devDeps pinned in the same range | `package.json`, 14 peers | matches the upstream invariant |
| one release per API line, no cross-generation tolerance | 0.9.x ↔ `^0.1.5-rc.2 \|\| ^0.1.6-alpha.1`; 0.7.x was the probing generation | matches upstream's lockstep discipline |
| per-line verification | `compat-check.mjs` (link) + CI boot matrix, now **both** lines | matches upstream's Node-version matrix idea |
| loud, classified failure | launcher translation + `acp-doctor.mjs` (three layers) | **beyond upstream** (no third-party equivalent) |
| migration tooling | `init-acp-home.sh` retires legacy rows; doctor names duplicates; README checklist | **beyond the community norm** |
| early warning for the next line | `.github/workflows/canary.yml`, scheduled on the `alpha` dist-tag | added here |
| stated support policy | README (en+zh) "Support policy" table + four rules | was missing; added here |

### Gaps found, and closed in the same session

1. the compatibility section claimed 0.1.6-alpha.2 was covered while the CI matrix booted only
   0.1.5-rc.2. The alpha line was boot-verified by hand first, then added to the matrix, so the
   claim is now continuously true rather than aspirational.
2. no early warning for a coming line → `canary.yml` (scheduled + manual; `alpha` dist-tag;
   green means "still works, widen the range when promoted", red means "adapt before release").
3. no stated support policy → README table mapping bridge versions to dsh lines, plus the rules
   (a new line gets a release, not a wider probe; the floor moves only with a bridge minor and
   never silently; a line is dropped by publishing a bridge that says so).
4. "One CLI generation per home" described 0.1.5 behaviour as general. On 0.1.6-alpha.2
   `$DSH_HOME/profiles/node_modules` does not exist at all: the home holds
   `profiles/<name>/node_modules` with only the linked out-of-tree bundle, and nothing resolves
   `dsh-agent` under the home. Annotated in both READMEs; the launcher's drift check silently
   no-ops where that path is gone, so it cannot false-alarm.

### Evidence for this section (all run locally)

| Check | Result |
| --- | --- |
| bridge 0.9.0 on dsh **0.1.6-alpha.2** (scratch home, real CLI) | doctor `READY` — handshake, settle and a real `session/new` that opened a thread |
| keyless smoke on 0.1.6-alpha.2 | ALL CHECKS PASSED (same job the widened matrix runs) |
| MCP mount smoke on 0.1.6-alpha.2 | ALL CHECKS PASSED |
| `dsh-free-search@0.4.32` peers vs. reality | declared range excludes both lines we support; it mounts and configures `web.searchProvider` on them anyway |
