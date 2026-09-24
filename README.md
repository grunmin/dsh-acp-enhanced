**[中文](README-zh.md) | English**

# dsh-acp-enhanced

An enhanced [Agent Client Protocol](https://agentclientprotocol.com) (ACP) server for
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh), built for ACP
editors like **Zed**. It is a drop-in replacement for the official `@deepseek-ai/dsh-acp`
bridge: the official bridge only streams plain text, this one exposes the Web GUI's
capabilities — streaming, telemetry, model/permission control, session management, MCP —
over the ACP wire.

## Features

### Output & telemetry

- **Block + reasoning streaming**: text blocks and the model's thinking arrive live
  (`agent_message_chunk` / `agent_thought_chunk`); cancelled/retried attempts never leak
  torn output. Set `streamDeltas: true` on the acp-enhanced row for token-level
  streaming instead — the reply renders while the model writes it, coalesced on a 75 ms
  timer; the trade-off is that a mid-block retry can no longer hide its abandoned
  partial text, so a visible `_[stream interrupted — retrying]_` marker separates the
  seam (off by default)
- **Full telemetry**: context usage ring plus cache hit rate / TPS / input-output-reasoning
  tokens / tool timing / turn counts (`usage_update._meta` carries the full breakdown)
- **Image support (multimodal)**: when the dsh composition mounts an attachment store
  (`dsh-attachment-local`, mounted by default in `dsh-base`), `promptCapabilities.image`
  is advertised and pasted/uploaded images are ingested into the harness's durable attachment
  store — a vision-capable model (e.g. `deepseek-v4-flash-vision-exp`) reads them natively,
  in wire order with surrounding text. Older stacks (no attachment store) automatically
  downgrade: image is not advertised and an image prompt is refused with a clear error.

### Model & permissions

- **Model switching**: live `provider/model` catalog dropdown (ACP grouped-select wire shape)
- **Reasoning effort**: `reasoning_effort` dropdown — only when the routed model exposes
  selectable efforts; each model remembers the effort it last used (persisted per profile),
  so switching back restores it, and a first-time model falls back to its own default — or
  its first offered effort — instead of an empty "unknown" selection
- **Permission presets**: read-only / workspace-write / full-access session modes
- **Approval**: native allow-once / reject-once prompts per tool call
- **Agent presets**: per-session model-facing composition (tools + prompt sections)
  from the dsh agent-preset roster. `standard` is the full coding agent (default),
  `minimal` (极简模式) is a bare shell + files editor with **no** subagent/web/todo/plan
  tools — nothing from the host layer leaks into a minimal agent; `ptc` and `cordis`
  ship alongside. Your own presets are declared in the profile (see
  [Your own presets](#your-own-presets)) — dsh 0.1.7 no longer discovers
  `~/.dsh/.agent-presets`.
  Choose via the `agent_preset` config option, the `/preset` command, or the
  `DSH_ACP_PRESET` env var (per-session default); switching is only allowed while the
  session is still blank (no turn has run), so history never straddles two tool sets.
  A configured preset this roster no longer has does not close the panel: a blank
  session composes under the roster default and says so on stderr.

### Zed deep integration

- **Tool cards**: one-line summary in the collapsed header — `Read <path>`, the
  model's own intent line for shell commands (`description`, Codex-style — the
  exact command stays one click away), `Search: <pattern>`, `Fetch: <url>`, etc.
  The card body follows the ACP best practice: file edits render as a real
  **diff**, **bash/pwsh commands as a real terminal card** (codex-acp wire
  shape: command line + output + exit pill inside a terminal panel — no more
  raw-JSON cards), other executors as a syntax-highlighted code block, and
  touched files as **clickable locations** that open the file — with `rawInput`
  / `rawOutput` kept one click away for transparency, plus per-kind icons and a
  proper in-progress → completed/failed status lifecycle
- **Zed files & terminal**: `zed_read_text_file` / `zed_write_text_file` / `zed_terminal`
  put file edits into Zed's "edited files" area (diff + accept/reject) and commands into a
  real Zed terminal
- **Native form questions**: `ask_user_question` → `elicitation/create` form, click an
  option — or type a custom answer when none of them fit: options render with their
  descriptions, each option-backed question gets a free-text "Custom answer" field, and a
  custom answer replaces the single selection / accompanies a multi-select (same semantics
  as dsh's native question card)
- **Plan panel**: plan mode toggle → "planning" status bar in Zed

### Sessions

- **Resume & archive**: `session/load` restores past threads (full replay); `session/list`
  lists the thread archive (titled, sorted by last activity); `session/close` drops the
  in-memory record so a later `session/load` resumes from the persisted log; live title
  updates. `session/delete` is deliberately **not** advertised — the harness declares no
  public persistence delete (see [Compatibility](#compatibility))
- **Multi-root workspaces**: `sessionCapabilities.additionalDirectories` is advertised,
  so Zed no longer shows "this agent doesn't currently support multi-root workspaces"
  and instead passes every workspace root on `session/new` / `session/load`. All roots
  are described to the model in the system prompt and reported on `session/list`; the
  sandbox keeps the primary `cwd` as its single writable root (see Known limitations)

### Commands

- **Slash commands**: typing `/` reveals the command list (`available_commands_update`):
  `/status` shows the route and telemetry, `/model` lists or switches the model, `/preset`
  lists or switches the agent preset (listings render as monospace code blocks — readable
  at a glance), everything else (`/compact` `/goal` `/permission` `/plan`…) runs straight
  through the harness command registry — all executed **without a model turn**. Every
  user-invocable skill is advertised as a command too, so `/ask-matt`, `/code-review`,
  `/tdd`, … reach the bridge instead of being rejected by the editor, and the skill's
  instructions are injected into the message (dsh-tool-skill-style user invocation).
  Images pasted next to a slash line ride along as command attachments (e.g. reference
  screenshots for a `/goal` objective), the same way the Web composer submits them

### MCP

- **MCP servers**: `session/new` `mcpServers` mount any MCP server (stdio + streamable
  HTTP); tools join as `mcp__<server>__<tool>`; a failing server never takes the session
  down

## Preview

After picking **dsh-acp-enhanced** in Zed's AI Agent panel:

<img src="assets/screenshots/approval-config-context.png" width="560">

<img src="assets/screenshots/tool-cards-elicitation.png" width="560">

## Quick start

**Requires `dsh ≥ 0.1.5-rc.2`** (`npm install -g @deepseek-ai/dsh@0.1.5-rc.2`, or any version
in the peer range below); the bridge consumes one declared harness surface on every supported
line — 0.1.5-rc.2 through 0.1.7 — and never probes older generations at runtime.

This package follows the official dsh plugin conventions (it declares `dsh.bundle`), so
installation matches any official bundle: **one command** — auto-initializes the profile,
installs the package, appends the bundle layer; no profile YAML to write.

### Install (2 steps)

**Step 1 — install** (from the npm registry; no source checkout needed):

```sh
dsh plugin --profile acp-enhanced add dsh-acp-enhanced
```

> When hacking on the code, use `link:` to a local checkout instead (live edits):
> `dsh plugin --profile acp-enhanced add "link:/absolute/path/to/dsh-acp-enhanced"`

**Step 2 — register in Zed** (under `agent_servers` in `~/.config/zed/settings.json`;
Zed spawns agents with a minimal PATH, so use the shipped launcher
`scripts/dsh-acp-zed.sh`, which locates `node`/`dsh` itself)

> **The launcher ships with the package.** Its absolute path depends on how you
> installed in Step 1:
> - **npm install (default)**: `$HOME/.dsh/profiles/acp-enhanced/node_modules/dsh-acp-enhanced/scripts/dsh-acp-zed.sh` — replace `$HOME` with your home directory (e.g. `/Users/you`); Zed does not expand `~` or env vars, so write the full literal path.
> - **`link:` dev install**: `<your checkout>/scripts/dsh-acp-zed.sh`.

#### Most common: DeepSeek official API (the default route)

```jsonc
{
  // ...your existing settings...
  "agent_servers": {
    "dsh-acp-enhanced": {
      "type": "custom",
      "command": "/bin/bash",
      "args": ["/absolute/path/to/dsh-acp-enhanced/scripts/dsh-acp-zed.sh"],
      "env": {
        "DSH_ACP_PROVIDER": "deepseek-official",  // the official provider id
        "DSH_ACP_MODEL": "deepseek-v4-flash",     // the official model id
        "DSH_ACP_PRESET": "standard"              // optional: agent preset id (minimal / standard / code / cordis / yours)
      }
    }
  }
}
```

> Both env vars match the shipped patch's defaults, so **they can be omitted entirely** —
> writing them out just makes the route explicit. `DSH_ACP_PRESET` defaults to `standard`
> on the roster side; set it when you want every new session to start in a specific mode.
> The API key does not have to live in Zed:
> store it in `~/.dsh/.credentials.yaml` (`DEEPSEEK_API_KEY`) and the dsh credentials
> service resolves it; the launcher also falls back to a running `dsh web` process's key.

Debugging a stalled turn (is it the model request or the tool?):

```jsonc
"env": {
  // ...existing vars...
  "ACP_LOG": "/Users/you/.dsh/dsh-acp-enhanced.trace.jsonl"  // append-only JSONL event trace
}
```

Each line is one session event with wall-clock `time` (ms epoch); a turn that appears to
hang is attributable afterwards: a **model request stall** shows a long gap between
`step/start` and the first `assistant/chunk`, while a **tool-execution stall** shows a
long gap between `tool/call` and `tool/result` (the result line carries `elapsedMs`).
`prompt/settled` lines cover the full user-message round trip (stopReason + elapsed).

Optional: pin the panel's default config options (all still changeable in the panel):

```jsonc
"dsh-acp-enhanced": {
  // ...the type/command/args/env above...
  "default_config_options": {
    "model": "deepseek-official/deepseek-v4-flash",
    "agent_preset": "standard",
    "plan_mode": false,
    "reasoning_effort": "high"
  },
  "favorite_config_option_values": {
    "model": ["deepseek-official/deepseek-v4-flash", "deepseek-official/deepseek-v4-pro"]
  }
}
```

#### Extended: route through an OpenAI-Responses gateway (e.g. a company model gateway)

Same install path; only the env values change to the provider/model the gateway exposes
plus the key env var it requires:

```jsonc
"dsh-acp-enhanced": {
  "type": "custom",
  "command": "/bin/bash",
  "args": ["/absolute/path/to/dsh-acp-enhanced/scripts/dsh-acp-zed.sh"],
  "env": {
    "DSH_ACP_PROVIDER": "<gateway-provider-id>",  // provider id exposed by the gateway
    "DSH_ACP_MODEL": "<gateway-model-id>",         // model id exposed by the gateway
    "<KEY_ENV_NAME>": "<key>"                      // the key env var the gateway reads
  }
}
```

> `<KEY_ENV_NAME>` can also be omitted and the key stored in
> `~/.dsh/.credentials.yaml` instead.

Zed hot-reloads settings. Open the **AI Agent panel** (`Cmd+Shift+A`) → pick
**dsh-acp-enhanced** in the agent selector → send your first message: replies stream in
real time, the status bar shows context usage, the panel exposes Model / Permission preset
/ Plan mode options plus three modes, and the thread archive lists and resumes past
sessions.

Verify locally (no Zed needed):

```sh
node <pkg>/scripts/acp-doctor.mjs              # bundles + versions, the peer range, and one real boot
node scripts/acp-client.mjs                    # dev checkout only: full ACP e2e, expect ALL CHECKS PASSED
DSH_ACP_PROVIDER=... DSH_ACP_MODEL=... node scripts/acp-client.mjs   # only for a custom route
```

### Web search

The bridge ships no search provider and takes no position on which one you use: the
model-facing `web_search` tool rides on the `web` seam's `searchProvider`, so mount any
`ctx.web` provider into the profile — a package with `dsh.bundle` via
`dsh plugin --profile acp-enhanced add <package>`, or a plain package via your user-layer
`insert` rows (see below). Which provider exists in your dsh deployment is a profile
concern, not a bridge one.

Note what that costs: a provider bundle sits on the **boot path** of every ACP thread, so
if it fails to load, the whole profile dies and Zed shows an opaque hang. Prefer a preset
composition when the plugin only adds model-facing tools (see
[Keep the profile minimal](#keep-the-profile-minimal)); a provider that must configure the
host `web` row belongs in the host composition (the profile) — mount it deliberately, and
re-run the doctor after changing it.

### Managing the profile's plugins

dsh-acp-enhanced runs in its **own profile** — `acp-enhanced`, created at
`~/.dsh/profiles/acp-enhanced/` — inside the same dsh home as `dsh web`. The profile is
what isolates the *composition*, so plugin changes here never affect your web setup,
while credentials, settings, sessions and presets stay shared.

The profile composes its plugin tree from three sources, each layer patching the ones
before it:

1. **Bundle layers** — `dsh.profile.bundles` in the profile's `package.json`: the
   template's `@deepseek-ai/dsh-base` first, then every installed package that declares
   `dsh.bundle` (like `dsh-acp-enhanced`), in array order.
2. **Your user layer** — `~/.dsh/profiles/acp-enhanced/cordis.patch.yml`: id-targeted
   row config overrides, `disabled: true` row disables, and `insert` lists (how a
   package without `dsh.bundle` — e.g. a hand-mounted custom provider — gets
   mounted).
3. **Per-run overlays** — `dsh --profile acp-enhanced --patch extra.yml`.

Adjust the set with:

```sh
dsh plugin --profile acp-enhanced add <package>     # install; a dsh.bundle package auto-joins the layer stack
dsh plugin --profile acp-enhanced remove <package>  # uninstall; auto-leaves the stack
dsh plugin --profile acp-enhanced update [package]  # update one/all, then reconcile
dsh --profile acp-enhanced --dump-config             # inspect the composed tree (per-layer provenance)
```

`dsh plugin` is a thin pnpm forwarder (run inside the profile directory) that
reconciles `dsh.profile.bundles` against the installed state after every run. Two
consequences worth knowing:

- **Disabling a bundle by deleting it from `bundles` does not stick** — the package is
  still an installed dependency, and the next `dsh plugin` run appends it right back.
  To disable a single row without uninstalling, target it in the user layer by its
  **row id** (not the package name — find ids in the `--dump-config` output):

  ```yaml
  - id: mnemon
    disabled: true
  ```

- **A package without `dsh.bundle` loads nothing by itself** — it installs as a plain
  dependency (with a one-time warning) and needs your own `insert` entry in the user
  layer. To change an existing row's config, override it with `- id: <row>` + `config:`
  — patch entries replace the whole row config, they do not merge.

Changes take effect in the **next** process: Zed spawns a fresh
`dsh --profile acp-enhanced` for every agent thread, so open a new agent thread (or
restart Zed) after editing the profile.

#### Keep the profile minimal

The profile is a **single failure domain**. `cordis-plugin-loader` awaits every entry and
rethrows the first rejection, so one unloadable row aborts the whole plugin tree: the
process may even answer the ACP `initialize` handshake first and die right after, which a
client reports as an opaque hang, not an error.

Keep `dsh.profile.bundles` at exactly the two rows that cannot mismatch their own boot:

```json
"bundles": ["@deepseek-ai/dsh-base", "dsh-acp-enhanced"]
```

`@deepseek-ai/dsh-base` ships with the CLI, so its version always matches the CLI that
boots it; every other bundle is a third party whose dependency closure can drift. Mount
extra plugins where a failure costs one preset instead of the whole editor session:

- **Plugin adds only model-facing tools/commands** → declare its row inside a preset
  composition. On the **0.1.7 line** that is a `@deepseek-ai/dsh-agent-preset` row in the
  profile's user layer (see [Your own presets](#your-own-presets)); on 0.1.5/0.1.6 it is a
  directory under `$DSH_HOME/.agent-presets/<id>/` (`agent.cordis.yml` for the composition,
  `preset.yml` for the picker label). Either way the ACP `agent_preset` dropdown lists it,
  and a preset whose composition fails to load is reported as broken and simply not
  offered, instead of killing the process.
- **Plugin must configure a host service** (e.g. a search provider overriding the host
  `web` row's `searchProvider`) → it belongs in the host composition, i.e. the profile.
  That is a deliberate trade: accept the boot-path risk, and re-run the doctor after any
  change.

Check the result before trusting it:

```sh
node <pkg>/scripts/acp-doctor.mjs          # bundles + versions, the peer range, and one real boot
dsh --profile acp-enhanced --dump-config   # where each row comes from
```

## Compatibility

One bridge binary, one declared harness surface: **dsh ≥ 0.1.5-rc.2** (peer range
`^0.1.5-rc.2 || ^0.1.6-alpha.1 || ^0.1.7-alpha.1`). All three lines in that range are
**boot-verified** — handshake, profile settle and a real `session/new` — on every CI run, plus
a cross-generation link check. The bridge consumes only the harness's **declared** surface:
services in `docs/capability-seams.md`, events in `docs/event-producer-consumer.md`, published
package exports. `scripts/api-surface-check.mjs` fails on anything else (a blocking CI step).
There is no feature sniffing and no generation matrix: 0.1.7 needed exactly two adaptations —
a **member probe** (`presets.resolveMountable`, private through 0.1.6 and gone in 0.1.7,
replaced there by `resolve()` plus the row's own `broken` verdict) and a **generation-gated
row** in `cordis.patch.yml` for the repackaged agent-preset roster, which reads the booting
installation's own manifest version (below). A host without either falls back to the older
shape; neither path can fail a boot.

### Support policy

| Bridge | Supported dsh lines | What changed |
|---|---|---|
| **0.9.1** | `^0.1.5-rc.2 \|\| ^0.1.6-alpha.1 \|\| ^0.1.7-alpha.1` | 0.1.7 support: the agent-preset roster was repackaged upstream, so the bridge ships both shapes (generation-gated row) and inlines the four preset declarations |
| **0.9.0** | `^0.1.5-rc.2 \|\| ^0.1.6-alpha.1` | declared-surface-only rewrite; floor 0.1.5-rc.2; `session/delete` dropped |
| 0.8.x | `^0.1.0-rc.6 … ^0.1.6-alpha.1` (unreleased) | 0.1.3+ live-stream seam; 0.1.5 persistence handle API |
| 0.7.x and older | ≤ 0.1.2-rc.1 | runtime probing of both generations |

The rules behind that table:

- **A new dsh API line gets a new bridge release, not a wider runtime probe.** Probing is how
  0.7.x absorbed 0.1.1 → 0.1.5, and it is why that support rotted silently. 0.1.7 is a
  repackaging rather than a new API line, so 0.9.1 absorbs it in one patch release — and the
  probe it needs is a single member check, not a generation matrix.
- **The floor moves only with a bridge minor, and never silently**: the launcher warns before
  booting a CLI below the range, and the doctor stops with `RESULT FAIL — CLI too old`.
- **A line is dropped by publishing a bridge that says so**; the previous line stays on the
  `feat/dsh-0.1.3-plus-support` branch for users who cannot move.
- **Watch the next line before it is released**: the scheduled `canary` workflow installs the
  `alpha` dist-tag and runs the guard, the link check and a boot smoke, so a breaking change
  shows up as a red canary rather than as user breakage.

### What 0.9.0 changed (breaking)

| Change | Effect | If it bites |
|---|---|---|
| floor raised to dsh **≥ 0.1.5-rc.2** | older hosts fail at mount time with a named error instead of degrading silently | upgrade the CLI (`npm install -g @deepseek-ai/dsh@0.1.5-rc.2`), or stay on the `feat/dsh-0.1.3-plus-support` branch for ≤ 0.1.2-rc.1 |
| **`session/delete` removed** | the ACP capability is no longer advertised and persisted sessions are never deleted — the harness declares no public persistence delete | the files stay under `$DSH_HOME/sessions/<slug>/<id>/`; remove them by hand if you must. An upstream issue tracks a public delete API |
| the launcher **no longer rewrites `DSH_HOME`** | the ACP profile boots inside the home the launcher was started with (`${DSH_HOME:-$HOME/.dsh}`), sharing credentials, settings, sessions and presets with `dsh web` | used the old implicit `~/.dsh-acp`? Point the launcher at it explicitly (`"DSH_HOME": "<home>/.dsh-acp"` in Zed's `agent_servers.env`) or migrate back to the shared home |
| the `assistant/chunk` seam is gone | live streaming is `agent/assistant-stream` only (the floor carries it) | upgrade the CLI; a host that streams nothing is still covered by the committed `assistant/message` fallback |

### What 0.9.1 changed (additive: dsh 0.1.7 support)

`dsh` 0.1.7 **repackaged the agent-preset roster**. `@deepseek-ai/dsh-agent-presets` (which
bundled the standard/ptc/minimal/cordis compositions and prepended them as a read-only
`system` root) has no 0.1.7 release at all; that line ships
`@deepseek-ai/dsh-agent-preset-registry` plus one `@deepseek-ai/dsh-agent-preset` declaration
row per preset. Three surfaces moved, and the bridge absorbs all three without dropping a
supported line:

| Surface | ≤ 0.1.6 | ≥ 0.1.7 | What the bridge does |
|---|---|---|---|
| roster row | `@deepseek-ai/dsh-agent-presets`, `config.default` | `@deepseek-ai/dsh-agent-preset-registry`, `config.default` | both rows ship; each is `disabled` by a generation gate, so exactly one activates (they provide the same service name, and a second `provide` would throw) |
| shipped presets | bundled inside the roster package (`system` root) | one `@deepseek-ai/dsh-agent-preset` declaration each — whoever wants them ships them (`@deepseek-ai/dsh-web-app` ships `presets/*.patch.yml` layers) | the four declarations are inlined into `cordis.patch.yml` verbatim from the web-app bundle (MIT, 0.1.7-rc.2), with the display metadata the old roster's per-preset `preset.yml` carried added back — 0.1.7 publishes no `name` for a shipped id |
| mountable resolution | private `presets.resolveMountable(id)` | `presets.resolve(id)` returns a broken row on purpose; every mounting path refuses it *after* resolution | member probe: `resolveMountable` when present, otherwise `resolve()` plus the row's own `broken` reason |

The gate reads the **identity of the installation that is booting**: it opens
`profileContext.installAnchor` — the running CLI's own `package.json` — and its `version`
decides the shape (the registry roster starts at 0.1.7 on the 0.1.x line). `profileContext`
does not exist on 0.1.5 at all, which is itself the `≤ 0.1.6` answer, and anything unreadable
or unclassifiable keeps the older row. `!!js` expressions are evaluated `with (ctx)` over the
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

#### Your own presets

From 0.1.7 the roster is a registry fed by declaration rows: it scans **no** user
directory, so `$DSH_HOME/.agent-presets/<id>/` stops being discovered and a profile whose
default names one of those presets fails every `session/new` with
`Unknown agent preset: <id>`. Author your preset where the registry reads:

```yaml
# ~/.dsh/profiles/acp-enhanced/cordis.patch.yml
- insert:
    - id: preset-my-agent
      name: '@deepseek-ai/dsh-agent-preset'
      config:
        id: my-agent              # the id DSH_ACP_PRESET / the dropdown uses
        name: My agent            # optional; 0.1.7 only localizes shipped ids
        description: …            # optional
        order: 5                  # optional
        plugins:                  # the composition, in the shipped preset's shape
          - id: persona
            name: '@deepseek-ai/dsh-persona'
```

Two rules the shipped `presets/*.patch.yml` layers (and this bridge's inlined copy) follow,
because a preset is data the loader mounts:

- **restate the whole composition.** A preset row carries the complete `config.plugins`
  list — there is no "patch a child of an existing preset" — so a fork of `standard` has
  to be re-baselined onto the new line's row set (0.1.7 renamed `workflow-worker-thread`
  to `workflow-ptc`). Prefer the host plane when your only difference is configuration
  (model routes, approval, sandbox): fork a preset only for a different **tool set**.
- **set the default where the line reads it.** `agent-preset-registry.config.default` on
  0.1.7, `agent-presets.config.default` on ≤ 0.1.6 (or the Settings surface, which writes
  `selectedDefault`). A profile that names a preset it no longer declares still works for a
  *blank* session — it composes under the roster default and logs the substitution on
  stderr — and fails to *resume* a session that already ran it, since composing a different
  tool set onto an existing transcript is exactly what the blank-only rule forbids.

### Upgrading from a published ≤ 0.7.0

The published `latest` is **0.7.0**, from the pre-0.1.3 API line, so the bridge and the CLI
have to move **together** — in either order the half-upgraded pair is broken:

| Order | What you get |
|---|---|
| CLI first, bridge left at 0.7.0 | The profile boots and `initialize` succeeds, but **every `session/new` fails** with an Internal error (`tool-subagent: modelSelectionSettings requires … in the Host scope`). Nothing can warn you: that bridge copy is already installed, and it also has no `agent/assistant-stream` seam and no `assistant/message` fallback, so replies would not render either |
| Bridge first, CLI left behind | The profile dies while loading (`… subpath './model-selection-settings' is not defined by "exports"`). The launcher warns on stderr *before* that, and `scripts/acp-doctor.mjs` stops with `RESULT FAIL — CLI too old` |
| Both together | The supported state |

Checklist:

1. `npm install -g @deepseek-ai/dsh@0.1.5-rc.2` (or any version in the peer range above).
2. `dsh plugin --profile acp-enhanced add dsh-acp-enhanced@0.9.1`. Upgrading the bridge is
   explicit: the profile's dependency is a caret on 0.x, so `dsh plugin update` will **not**
   move you to a new minor by itself.
3. Booted the profile from a checkout, or set `DSH_PATH` before? The old launcher moved you
   to `~/.dsh-acp` on its own; it does not any more. Set `DSH_HOME=<that home>` in Zed's
   `agent_servers.env`, or recreate the profile in your default home. The launcher says so if
   it finds a profile there.
4. Followed the old README and seeded `subagent-model-selection-settings` in your profile's
   user layer? Delete the row: the bridge's patch ships it now, and a duplicate id aborts the
   boot. `scripts/init-acp-home.sh` retires it for you. The launcher warns, and the doctor
   names the id.
5. Check that any third-party bundle in the profile supports 0.1.5 (`dsh-free-search` ≥ 0.4.24
   is verified) — the profile is one failure domain.
6. Restart Zed (or open a fresh agent thread); `node <pkg>/scripts/acp-doctor.mjs` verifies the
   whole path first, including opening a thread.

### One CLI generation per home

`$DSH_HOME/profiles/node_modules` is a single dependency closure shared by every profile
under that home, and dsh heals it to whichever CLI booted last. So:

> This is **0.1.5-line behaviour**. On 0.1.6-alpha.2 and later that shared closure no longer
> exists at all (the harness resolves from the CLI's own install; the profile's `node_modules`
> holds only out-of-tree plugins), which is why the launcher's drift check is line-specific
> and silently no-ops where the path is gone.



- **Never run two CLI generations under one home at once.** The second boot flips the
  closure under the first process, which then lazily resolves mismatched modules
  mid-flight. The launcher compares the closure's `dsh-agent` version with the CLI it is
  about to boot and warns on **stderr** when they differ — after such a boot, restart the
  other dsh processes under that home (`dsh web`, …).
- **The escape hatch is the CLI, not the home.** Pin the launcher with `DSH_PATH=<dsh>`
  (or use the repo pin below): the launcher resolves *which dsh*, never *which home*.

Current resolutions are always visible:

```sh
node scripts/compat-check.mjs   # dev checkout: installs the 0.1.5-rc.2, 0.1.6-alpha.2 and 0.1.7-rc.2 sets and imports the bridge from each
node <pkg>/scripts/acp-doctor.mjs   # CLI + closure versions, bundles, and one real boot (shipped)
```

### Dev checkout: repo-pinned CLI, shared home

When the launcher runs **from a checkout** (`link:` install), it resolves the dsh CLI in
this order:

1. `$DSH_PATH` — an explicit dsh binary, or a directory whose `node_modules/.bin/dsh` holds one
2. the repo-pinned CLI — `<repo>/node_modules/.bin/dsh` (this package's `@deepseek-ai/dsh`
   devDependency, currently 0.1.7-rc.2)
3. global fallback — `dsh` on PATH / npx cache / npm prefix (a fresh clone without
   `pnpm install` degrades to it)

Whichever wins boots profile `acp-enhanced` **in the home the launcher was started with**
(`${DSH_HOME:-$HOME/.dsh}`). The home is never rewritten. If you want the bridge on its
own dependency closure, build a separate home and point the launcher at it explicitly:

```sh
DSH_ACP_HOME=~/.dsh-acp scripts/init-acp-home.sh   # optional, idempotent: creates + seeds an isolated home
# then in Zed's agent_servers env:  "DSH_HOME": "/Users/you/.dsh-acp"
```

The isolated home is a deliberate opt-in, not a default: your profile must exist in
whichever home the launcher boots, or it exits 127 with the exact `dsh plugin … add link:`
command that creates it. `init-acp-home.sh` ports your old profile's user rows verbatim,
copies credentials/settings, disables the DeepSeek plugin-package inventory reporter, and
retires a legacy `subagent-model-selection-settings` row from the user layer — that host
row now belongs to the bridge's bundle patch, and a second copy aborts the boot with
`duplicate loader entry id`.

Sessions persist under `$DSH_HOME/sessions/<slug>/<id>/session.jsonl.zstd` in both homes;
nothing is copied between them by default, because the default home's tree also holds
every web-profile session. Pass `--copy-sessions` (or run the `rsync` the script prints)
when migrating an existing setup.

## Troubleshooting

Start with the doctor: it boots the profile exactly as Zed does and names the failure
layer, the offending bundle and the fix.

```sh
node <pkg>/scripts/acp-doctor.mjs              # installed copy
node scripts/acp-doctor.mjs                    # from a checkout (npm run doctor)
node <pkg>/scripts/acp-doctor.mjs --profile <name> --home <dsh-home> --timeout 60000
```

It prints the CLI + version, the home, the profile, every bundle + version, the supported
peer range and the closure version, then classifies the boot into one of three layers:

| Layer | Signature in `dsh`'s stderr | What it means | Fix |
|---|---|---|---|
| **link-time** | `does not provide an export named …`, `SyntaxError: The requested module …` | the booting CLI's closure cannot satisfy an import this bridge performs | `node <pkg>/scripts/acp-doctor.mjs` — if it prints `LAYER link-time`, align the generation: restart every other dsh process under this home (the shared closure heals to whichever CLI booted last), or pin this launcher with `DSH_PATH=<matching dsh>` |
| **mount-time** | `failed to apply loader entry …`, `… requires … in the Host scope`, `duplicate loader entry id: …` | the loader rejected one entry and rethrew, so the whole plugin tree is down | `node <pkg>/scripts/acp-doctor.mjs` prints `SUBJECT <entry> (<module>)` — install the missing module, disable that row (`- id: <entry>` + `disabled: true` in the user layer), or trim `dsh.profile.bundles` to `@deepseek-ai/dsh-base` + `dsh-acp-enhanced`. For a duplicate id, delete the row from your user layer (the bundle patch owns it) |
| **run-time** | `… is not a function` after a successful handshake | the bridge reached a harness service this CLI generation does not provide | `npm install -g @deepseek-ai/dsh@<version in the supported range>` (see [Compatibility](#compatibility)) |

The launcher translates the same three signatures on **stderr** while Zed boots (stdout is
the ACP wire), so the agent log already carries the layer and the fix.

| Symptom | Locate | Fix |
|---|---|---|
| Zed hangs with no output; the thread never answers | `node <pkg>/scripts/acp-doctor.mjs` | Prints `BOOT FAILED` + `LAYER`/`SUBJECT`/`FIX`; follow the `FIX` line. A profile that answers `initialize` and dies right after is reported as such |
| `exec: dsh: not found` (status 127) | `which dsh` | Use the shipped `dsh-acp-zed.sh` launcher (it locates node/dsh itself), or install the CLI |
| `no API key for provider route "xxx"` | `ls -l $DSH_HOME/.credentials.yaml` | Write `~/.dsh/.credentials.yaml`, or set `env.DEEPSEEK_API_KEY` on the agent_servers entry |
| `SyntaxError: … 'PresetMountError'` | the bridge version in the agent log | You are running a pre-0.9.0 bridge copy against a 0.1.5 host — update this package |
| `modelSelectionSettings requires … in the Host scope` | `dsh --profile acp-enhanced --dump-config \| grep subagent-model-selection` | The host row the `standard` preset needs is missing — the bridge's bundle patch inserts it, so reinstall/upgrade the bridge (`dsh plugin --profile acp-enhanced add dsh-acp-enhanced`), and check that nothing in your user layer sets it `disabled: true` |
| `duplicate loader entry id: <row>` | the doctor prints `LAYER mount-time` and the id | Two layers ship the same row. Delete it from the profile's user layer (`$DSH_HOME/profiles/acp-enhanced/cordis.patch.yml`) — these host rows belong to the bundle patch. `scripts/init-acp-home.sh` retires the legacy `subagent-model-selection-settings` copy for you |
| Old threads start empty after a host upgrade | `ls $DSH_HOME/sessions` | The sessions live under `$DSH_HOME/sessions/<slug>/`; copy the old home's history in (`scripts/init-acp-home.sh --copy-sessions`) and the new host resumes them |
| Cannot switch models | `ACP_DEBUG=1 dsh --profile acp-enhanced`, then try the switch | The carried `reasoning_effort` is unsupported on the target: the bridge remembers the last effort per model (per-profile JSON) and falls back to the model's default rather than failing the switch. Also check the route is real — phantom providers are filtered, only `config.provider`'s models are advertised |
| Context usage missing | `/status` in the thread | A "phantom provider" route was picked; point the profile's provider at a real route |
| Turn settles with usage but **no reply text** (empty panel) | `ACP_DEBUG=1` and look for `agent/assistant-stream frame=chunk` | From 0.9.0 the only live seam is the `agent/assistant-stream` frames event, with the committed `assistant/message` as the fallback whenever a step streamed nothing. Frames present but no text = a client-side render problem; no frames at all = the fallback path (upgrade the bridge if it is older) |
| `Unknown agent preset: <id>` after a dsh upgrade | `ls $DSH_HOME/.agent-presets` and the profile's `cordis.patch.yml` | That preset left the roster — from 0.1.7 `$DSH_HOME/.agent-presets` is no longer scanned. Declare it as a `@deepseek-ai/dsh-agent-preset` row ([Your own presets](#your-own-presets)); 0.9.1 opens *blank* sessions under the roster default meanwhile (with a stderr note), but resuming a thread that already ran it keeps failing until the row exists |
| A capability the profile used to have is silently gone (e.g. `web_search`) | `node <pkg>/scripts/acp-doctor.mjs` — a degraded boot prints `DEGRADED <n> loader entries never activated` with the entry names | An entry that fails to import does not take the profile down, it just is not there. Upgrade that bundle for this dsh line — `dsh-free-search` needs ≥ 0.4.39 on 0.1.7, because 0.4.24 imports the `SettingsProvider` export `dsh-settings` dropped — or remove it |
| Plugin edits seem ignored | the profile's `cordis.patch.yml` mtime | Changes apply to the **next** process: open a new agent thread (or restart Zed) |
| Need detailed diagnostics | — | `ACP_DEBUG=1` (stderr lifecycle trace) and `ACP_LOG=/tmp/acp.jsonl` (per-event JSONL with timings) |

## Development

```sh
pnpm install                          # install dev dependencies (repo-pinned CLI and test scripts)
node scripts/compat-check.mjs         # link check across the supported lines (0.1.5-rc.2 / 0.1.6-alpha.2 / 0.1.7-rc.2 scratch installs)
node scripts/api-surface-check.mjs    # public-surface guard: no undeclared harness API (blocking CI step)
node scripts/pack-check.mjs           # package integrity: entry points, modes, shipped-file references (blocking CI step)
node scripts/acp-client.mjs           # end-to-end smoke (needs an API key)
node scripts/acp-client-tools.mjs     # client-tool tests (mocks Zed fs/terminal/elicitation/plan)
node scripts/acp-mcp-test.mjs         # MCP mount test (no model calls)
node scripts/acp-smoke-keyless.mjs    # keyless boot smoke (CI)
node scripts/acp-resume-test.mjs      # session resume test
node scripts/codec-image-test.mjs     # image-codec unit tests (no network, fake store)
node scripts/terminal-codec-test.mjs   # terminal-card codec unit tests (no network)
node scripts/replay-order-test.mjs     # replay/fallback chunk order: reasoning precedes its reply (no network)
node scripts/acp-image-e2e.mjs        # image capability e2e (vision-model leg needs an API key)
node scripts/acp-message-fallback-test.mjs  # live seam + assistant/message fallback: a seam fired and the reply arrived exactly once
node scripts/acp-launcher-test.mjs     # launcher contract: home never rewritten, drift warning, boot-failure translation
node scripts/acp-doctor.mjs            # boot the profile once and name the failing layer/bundle
scripts/init-acp-home.sh              # optional: bootstrap an *isolated* home (the launcher never switches to it by itself)
```

DevDependency pins for the harness packages use the same ranges the pinned
`@deepseek-ai/dsh` CLI declares (e.g. `^0.1.7-alpha.1`), so the repo's tree and a fresh
CLI install resolve one coherent family — exact patch pins here mixed with the CLI's
range-resolved closure produce a split closure (two versions of one name) that breaks
profile boots with export-not-found errors. After changing those pins, regenerate the
whole lockfile (`rm -rf node_modules pnpm-lock.yaml && pnpm install`): an incremental
install both leaves stale store entries poisoning the profile heal AND retains stale
lockfile peer resolutions — bumping 0.1.2-alpha.2 → 0.1.2-rc.1 in place left
`dsh-session-persistence@0.1.2-alpha.3` (old-generation peers) wired into the rc.1
packages' snapshots, which passes boot and session/new and only breaks the first turn
with `TypeError: Cannot read properties of undefined (reading 'length')` from
PersistenceCoordinator.
`pnpm-workspace.yaml` approves the CLI closure's build scripts (node-pty prebuilds, koffi)
— they are runtime requirements when the repo CLI boots the profile.

## Known limitations

Audio attachments are not supported (audio capability is not advertised), text streams at
block granularity by default (`streamDeltas: true` opts into token-level streaming, see
Features), one in-flight prompt per session. MCP supports stdio and streamable HTTP
(legacy SSE / `acp` transports are not advertised).
`session/fork` / `session/resume` are not implemented (capabilities
undeclared, compliant clients will not call them). `session/delete` is not advertised
either: the harness declares no public persistence delete, so persisted sessions are
never removed by the bridge (see [Compatibility](#compatibility)).

Multi-root workspaces are advertised and all roots are visible to the model, but dsh's
sandbox policy resolves **one writable root per session** (the primary `cwd`, i.e.
`session.header.cwd`) and the local sandboxes bind exactly that root for writes. Reads
work in every root; under `workspace-write` a write under an additional root is denied
first and needs escalation/approval, while `danger-full-access` writes everywhere.
True multi-root write enforcement belongs in dsh core (`dsh-sandbox-policy` /
`dsh-sandbox-local` would need a root list instead of a single root).

Agent presets take over the model-facing rows: the shipped `cordis.patch.yml` disables
the dsh-base rows a preset owns (tool-bash/fs/subagent/todo/web/… — exactly the official
dsh-web-app/tui list minus `hmr`, kept version-agnostic across generations: a row a given
generation does not ship is warned and skipped by the patch applier) and mounts the
`agent-presets` roster (`standard`
default; `ptc`/`minimal`/`cordis` ship with the dsh CLI; your own presets are declared as
`@deepseek-ai/dsh-agent-preset` rows from 0.1.7 on — see
[Your own presets](#your-own-presets)). The bundle's own patch applies
automatically (package.json `dsh.bundle.patch`) — do **not** copy it into the profile's
user-layer `cordis.patch.yml`, or the loader rejects the duplicate entry ids at boot.
When **upgrading** a profile that already carries a customized user-layer patch, keep
only your custom row configs there (e.g. `includeAllProviders: true` on the
acp-enhanced row, restating provider/model/preset since patch entries replace whole
rows, they do not merge). A session created before the upgrade resumes under the
roster's default preset.
