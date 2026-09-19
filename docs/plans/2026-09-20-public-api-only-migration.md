# Migration plan: public-API-only surface (dsh ≥ 0.1.5-rc.2)

- Date: 2026-09-20
- Branch: **`feat/public-api-only`** (stacked on `feat/dsh-0.1.3-plus-support`)
- Status: **P0 done**, P1–P4 pending
- Supersedes nothing; layers on top of the 0.1.3+ adaptation

> **Handoff note for a fresh session.** Read this file top to bottom first. It is
> written to be self-contained: it records the decisions already taken, the
> machine state, the exact work items with `file:line`, and the commands to
> verify each phase. Nothing else from the originating conversation is needed.

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
  - `npm run check:surface`; added to the CI **syntax** check only.

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

- `package.json`: version **0.9.0**; peer ranges → `^0.1.5-rc.1 || ^0.1.6-alpha.1`
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
| P0 (done) | `npm run check:surface` | 30 violations listed (worklist) |
| P1 | launcher tests described in §4 | `DSH_HOME` never rewritten; mismatch warning on stderr |
| P2 | `npm run check:surface` | `PUBLIC SURFACE OK` |
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
