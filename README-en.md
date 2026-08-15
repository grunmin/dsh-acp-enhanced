**[中文](README.md) | English**

# dsh-acp-enhanced

An enhanced [Agent Client Protocol](https://agentclientprotocol.com) (ACP) server for
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh), built for
editors like **Zed** that speak ACP over JSON-RPC stdio.

The official `@deepseek-ai/dsh-acp` bridge is deliberately automation-only: it commits
text only after a whole message, carries no telemetry, and exposes no model/permission
controls. This project is a drop-in replacement that surfaces what the Web GUI has:

| Surface | ACP mechanism | What you see in Zed |
|---|---|---|
| **Block-level streaming** | `agent_message_chunk` per committed text block (`block-end`), grouped by `messageId` per model step | Text appears while the agent works; cancelled/retried blocks never leak torn output |
| **Token & context telemetry** | standard `usage_update` (`used` = context pressure, `size` = model context window) | Context meter in the agent status bar |
| **Cache hit rate / TPS / input-output-reasoning tokens / tool timing / turn count** | `usage_update._meta` + `tool_call` / `tool_call_update` `_meta` | Raw numbers every step (the `_meta` extension field carries the full breakdown) |
| **Tool-call visibility** | `tool_call` carries `rawInput` (parsed arguments) and `kind` (read/edit/execute/…); `tool_call_update` carries `rawOutput` (result preview, capped at 12k chars) | Tool cards expand to show the **exact arguments** (e.g. the bash command) and the **result**, with kind-based icons |
| **Model switching** | `session/set_config_option` with the `model` select (`provider/model` values from the live catalog; ACP grouped-select wire shape `{ group, name, options }`) | Config-option UI — switch to any model on the route |
| **Reasoning effort** | `session/set_config_option` with the `reasoning_effort` select (only when the routed model **exposes** selectable efforts) | Config-option UI (appears only when the route exposes efforts; see Design notes) |
| **Permission presets** | `session/set_config_option` (`permission_preset`) **and** ACP session modes via `session/set_mode` | Mode switcher / config-option UI |
| **Approval** | `session/request_permission` (allow-once / reject-once per tool call) | Native permission prompt |
| **Zed client file tools** | agent-side `zed_read_text_file` / `zed_write_text_file` / `zed_terminal` forwarded as `fs/read_text_file` / `fs/write_text_file` / `terminal/create` | Edits land in the agent panel's **"Edited files" section (diff + accept/reject)**; commands run in a **real Zed terminal** |
| **Zed form elicitation** | `ask_user_question` tool + `userQuestions` provider forwarded as `elicitation/create` (form mode) | Questions pop up as **native Zed forms**; options answerable in one click |
| **Plan panel** | `plan_mode` boolean config option + `plan/mode` events mapped to ACP `plan` updates | A **Plan status bar** at the bottom of the panel while plan mode is on; cleared when it leaves |
| **Session resume** | `loadSession` capability + `session/load` resumes the persisted agent via `agents.resume` and replays history as `user_message_chunk` / `agent_message_chunk` / `tool_call` | **Continue a previous thread** in Zed (long investigations keep their context) |
| **Session archive list** | `sessionCapabilities.list/delete`; `session/list` enumerates persisted sessions via `ctx.sessionPersistence.list()` (titles read from `session/title` events in the stored log), `session/delete` disposes the live agent and removes its persisted directory; `session/title` / `turn/end` push live `session_info_update`s | The **thread archive** shows all sessions (titled, sorted by last activity) — click to resume, delete to remove |
| **Empty-option suppression** | no `reasoning_effort` option is advertised when the routed model exposes no efforts | No empty, unclickable "Reasoning effort" chip |

> **Repository layout** — this repo contains two independent packages:
> - `dsh-acp-enhanced` (repo root): the enhanced ACP bridge (`lib/index.js`).
> - `packages/dsh-web-search-openrouter/`: a standalone `ctx.web` search provider that
>   routes `web_search` through any OpenAI-Responses gateway instead of DeepSeek's
>   Anthropic `/messages` endpoint. It deliberately does **not** couple to the ACP
>   bridge, so any profile (the Web GUI included) can mount it.

## Quick start

This package follows the official dsh plugin conventions (it declares `dsh.bundle`),
so installation is identical to any official bundle: **one command** —
`dsh plugin --profile <name> add <pkg>` auto-initializes the profile (the first layer
`dsh-base` already carries the whole agent stack), installs the package, and
**auto-appends it to the profile's bundle layers**. The shipped patch inserts the
`acp-enhanced` row and overrides the default model route — **no profile YAML to write**.

### Install (2 steps)

**Step 1 — install** (run in a directory containing `dsh-acp-enhanced`; `link:` keeps
your edits live):

```sh
dsh plugin --profile acp-enhanced add "link:/absolute/path/to/dsh-acp-enhanced"
```

**Step 2 — register in Zed** (the model route and credentials all come from `env`; no
patch to write)

Register the agent under `agent_servers` in `~/.config/zed/settings.json`. Zed (a GUI
app) spawns agent processes with a minimal PATH, so use the shipped launcher
`scripts/dsh-acp-zed.sh` (it locates `node`/`dsh` itself):

```jsonc
{
  // ...your existing settings...
  "agent_servers": {
    "dsh-acp-enhanced": {
      "type": "custom",
      "command": "/bin/bash",
      "args": ["/absolute/path/to/dsh-acp-enhanced/scripts/dsh-acp-zed.sh"],
      "env": {
        "DSH_ACP_PROVIDER": "<your-provider-id>",   // required: provider for the model route
        "DSH_ACP_MODEL": "<your-model-id>",          // required: model id
        "<KEY_ENV_NAME>": "<key>"                    // required: the provider's API key
      }
    }
  }
}
```

> **What the three env vars mean**: `DSH_ACP_PROVIDER` / `DSH_ACP_MODEL` choose the
> model route (the shipped patch reads both, falling back to
> `deepseek-official` / `deepseek-v4-flash`). `<KEY_ENV_NAME>` is the env var the
> provider reads for its key (DeepSeek official is `DEEPSEEK_API_KEY`; gateway
> adapters usually declare their own `apiKeyEnv`) — alternatively store it in
> `~/.dsh/.credentials.yaml` and let the dsh credentials service manage it. Every
> route uses the same install path; only the env values differ: DeepSeek official
> uses `deepseek-official`/`deepseek-v4-flash` + `DEEPSEEK_API_KEY`; an
> OpenAI-Responses gateway uses the provider/model it exposes + the key it requires.

Zed hot-reloads settings. Open the **AI Agent panel** (`Cmd+Shift+A`) → pick
**dsh-acp-enhanced** in the top **agent selector** → send your first message. Replies
stream in real time, the status bar shows context usage, and the panel exposes Model /
Permission preset / Plan mode config options plus read-only / workspace-write /
full-access modes; the thread archive lists and resumes past sessions.

Verify locally (no Zed needed):

```sh
DSH_ACP_PROVIDER=... DSH_ACP_MODEL=... node scripts/acp-client.mjs   # expect ALL CHECKS PASSED
env -i HOME=$HOME PATH=/usr/bin:/bin node scripts/acp-client.mjs \
  /bin/bash /absolute/path/to/dsh-acp-enhanced/scripts/dsh-acp-zed.sh  # Zed-like spawn
```

### Optional: route web_search through the same gateway

The bridge does not depend on it. If the gateway implements the OpenAI Responses
`web_search` server tool, you can route search through it too (reusing the same
credential). Install it as a plain dependency and append two blocks to the profile's
`cordis.patch.yml`:

```sh
dsh plugin --profile acp-enhanced add "link:/absolute/path/to/dsh-acp-enhanced/packages/dsh-web-search-openrouter"
```

`~/.dsh/profiles/acp-enhanced/cordis.patch.yml` (`<provider>` is your gateway provider id):

```yaml
- id: web
  config:
    searchProvider: <provider>

- insert:
    - id: web-search-openrouter
      name: 'dsh-web-search-openrouter'
      config:
        enabled: true
        baseURL: http://<gateway-host>:<port>/v1
        model: <your-model-id>
        apiKeyEnv: <KEY_ENV_NAME>
```

### Troubleshooting

| Symptom | Cause & fix |
|---|---|
| `Server exited with status 127` / `exec: dsh: not found` | Zed's PATH lacks `node`/`dsh`. Use the shipped `dsh-acp-zed.sh` launcher (it resolves both); verify with `bash scripts/dsh-acp-zed.sh` in a clean shell. |
| `no API key for provider route "deepseek-official"` | The key cannot be resolved. Write `~/.dsh/.credentials.yaml` (see step 2), or set `env.DEEPSEEK_API_KEY` in the agent_servers entry. |
| Agent does not appear after editing settings | Run `zed: reload settings` (command palette) or restart Zed. |
| "Cannot switch models" or "context usage not shown" in Zed | Usually a ghost provider is selected (an adapter that is mounted but has no usable API key). The bridge filters ghost groups by default (only `config.provider` models are advertised); if it persists, check that the profile's `config.provider` points at a real routable route and reset the polluted `agent-default-model` default to it. See Design notes. |
| `session/new` reports `additionalDirectories is not supported` | The bridge only supports baseline sessions; Zed does not send extra directories by default — remove them if a custom config sends them. |
| Need detailed diagnostics | Start with `ACP_DEBUG=1 dsh --profile acp-enhanced` (lifecycle trace on stderr). |

## Development

```sh
node scripts/acp-client.mjs           # end-to-end smoke test (needs a routable provider)
node scripts/acp-client-tools.mjs     # client-tool tests (mocks Zed fs/terminal/elicitation/plan)
node scripts/acp-resume-test.mjs      # resume tests (two processes: create+persist → load+replay → continue)
ACP_DEBUG=1 dsh --profile acp-enhanced   # lifecycle trace on stderr
```

The smoke client drives initialize → session/new → prompt (verifying block streaming,
`usage_update`, `tool_call`), config-option and mode switching, a second prompt after
switching, and `session/cancel`. `acp-client-tools.mjs` uses the SDK's
`ClientSideConnection` to mock Zed: it declares
`fs.readTextFile/writeTextFile/terminal/elicitation` capabilities and verifies that
`zed_*` tool calls arrive as `fs/write_text_file`, `fs/read_text_file`,
`terminal/create` requests, that `ask_user_question` arrives as an `elicitation/create`
form (with enum options), that the `plan_mode` boolean toggle emits ACP `plan` updates
(on → entry, off → cleared), and that routes without reasoning efforts no longer
advertise an empty `reasoning_effort`.

## Design notes

- **Block-level streaming**: text deltas accumulate per block index; a committed
  `block-end` goes on the wire immediately. A retry restarts the same index, so the
  torn tail of a cancelled attempt never reaches the client — ACP has no undo, and
  this is the cleanest boundary.
- **Telemetry**: every provider `usage` sample is broadcast as `usage_update`
  (used = input + cache read + cache write; size = the routed model's context
  window), with the full breakdown in `_meta`: input/output/cache/reasoning tokens,
  `cacheHitRate`, `tps` (generated tokens / step wall-clock), step elapsed, turn
  count, and cumulative tool-call stats.
- **Tool-call visibility**: `tool_call` notifications carry `kind` and `rawInput`
  (`JSON.parse` of the arguments, falling back to the raw string), so Zed's tool
  cards expand to show the exact arguments (bash command, written file, ...);
  `tool_call_update` carries `rawOutput` (a bounded text preview extracted from the
  `ToolResultMessage`, truncated at 12k). **A key constraint on `kind` mapping**: Zed
  treats `kind == 'execute'` as a terminal tool and `kind == 'edit'` as a diff tool,
  and **hides rawInput for both**. So only `zed_terminal` (a real editor terminal)
  maps to `execute`; bash/run_code/write tools stay `other` so rawInput renders —
  otherwise the card shows only the tool name with no command. Also note the dsh
  `tool/result` event carries `toolCallId` on `message.content[0].toolCallId`
  (the `ToolResultBlock`), not on the event root — missing it makes the SDK reject
  the whole `tool_call_update`. History replay (resume) carries the same fields.
- **Session config**: the `model` select enumerates the live model catalog
  (`ctx.llm.listProviders` → `listModels` → `resolveModelInfo`), `reasoning_effort`
  enumerates the routed model's efforts, `permission_preset` enumerates the mounted
  presets. Writes go through `llm.resolveCallConfig` + `installModelSelection` (the
  same mechanism the Web api-proxy uses) or `permissionPresets.apply`.
- **Model grouped-select wire shape**: the `model` option's groups must use the ACP
  shape `{ group: <id>, name: <label>, options: [...] }`. An early version emitted
  `{ groupName, options }`; Zed (`agent-client-protocol-schema` 1.4.0) silently
  skipped the whole group on deserialization (`DefaultOnError` + `VecSkipError`),
  leaving the dropdown empty — and the SDK mock client does not validate agent
  responses, so tests missed it. Now `acp-client-tools.mjs` runs
  `zSessionConfigOption.safeParse` on every config option, so this class of wire bug
  cannot slip through again.
- **Reasoning-effort route limitation**: the `reasoning_effort` option is advertised
  only when the routed model **exposes** efforts (`resolveModelInfo().reasoning.efforts`
  non-empty). On routes without efforts, explicitly setting one is rejected by the
  adapter (`does not support reasoning effort "high"`) — so the absence of an effort
  dropdown there is **correct behavior**, not a bug; switching to a route that exposes
  efforts makes the dropdown reappear automatically.
- **Model-catalog filtering (`includeAllProviders`, default off)**: by default only
  `config.provider` models are advertised, keeping "ghost providers" (adapters that
  are mounted but not routable — e.g. a `deepseek-official` with no usable API key)
  out of the dropdown. Those models look switchable but every later prompt fails with
  `MISSING_CREDENTIAL` (`no API key for provider route "xxx"`) — in Zed that shows up
  as "cannot switch models, and no `usage_update` arrives because the turn failed"
  (the Web GUI shows an unavailable banner for the current item; Zed does not, so the
  same data looks broken there). Set `includeAllProviders: true` when multiple
  providers are genuinely usable.
- **Default model cannot be poisoned**: `applySelection` persists the new selection as
  the `agent-default-model` default only when `selected.provider === config.provider`
  (or explicit `includeAllProviders`). An accidental switch to a non-routable provider
  therefore affects only the current session and never corrupts the default route of
  every later session.
- **Client-forwarding tools (Zed fs / terminal)**: on `initialize` the bridge reads
  `clientCapabilities` and registers `zed_read_text_file` / `zed_write_text_file` /
  `zed_terminal` (`ctx.tools.register` + `defineTool`) only when the client declares
  the matching capabilities. Tool bodies forward to the editor via
  `conn.readTextFile` / `conn.writeTextFile` / `conn.createTerminal`:
  `zed_write_text_file` lands edits on Zed's own buffer (the "Edited files" section
  with diff + accept/reject); `zed_terminal` runs the command in a real Zed terminal
  and polls output (`terminal/output` is cumulative — take the last one), killing after
  120s. Clients without those capabilities (e.g. pure automation) never see these tools.
- **Zed form elicitation**: when the client declares `elicitation.form`, the bridge
  registers the `ask_user_question` tool (mirroring `dsh-tool-ask-user`'s definition
  through the `ctx.userQuestions` seam) plus the matching UI provider: questions map
  to an ACP `elicitation/create` (form mode) JSON Schema (single choice → `string` +
  `enum`, multi → `array`, none → bare `string`); the user's native-form answer maps
  back to `AskUserQuestionAnswer` for the model. decline/cancel end the tool call with
  an error the model can route around. Note Zed's elicitation capability is an object
  (`form: {}`), not a boolean — check for presence, not `=== true`.
- **Plan panel**: the `plan_mode` boolean config option toggles DSH plan mode via
  `ctx.planMode.set(agent, active)`; `plan/mode` flips in `session/event` map to ACP
  `plan` updates — one "planning" entry while active, cleared on exit. DSH plan mode
  has no structured task list, so this is a state indicator, not a task list. The ACP
  `plan` update is **flat** (`{ sessionUpdate: 'plan', entries: [...] }`), not
  `{ plan: {...} }`.
- **Session resume (session/load)**: `initialize` declares `loadSession: true`;
  `session/load` resumes the persisted agent via `ctx.agents.resume({ resumeSessionId })`
  (`dsh-session-persistence-jsonl`, mounted by dsh-base), then replays history from the
  event log: `user/message` (only `source.kind === 'user'` — synthetic injections like
  system reminders and skill content are filtered) → `user_message_chunk`,
  `assistant/message` text → `agent_message_chunk`, `tool/call`/`tool/result` →
  `tool_call`/`tool_call_update`. Zed inserts the thread before the load RPC
  completes, so the replay notifications reach it. After replay the session behaves
  like a fresh one for further prompts.
- **Session archive list (session/list + session/delete)**: `initialize` declares
  `sessionCapabilities: { list: {}, delete: {} }`; `session/list` enumerates
  materialized sessions via `ctx.sessionPersistence.list()` (`SessionHeader`:
  id/cwd/createdAt), titles come from live `session/title` events or are read
  best-effort from the stored log (the last `session/title` event; oversized logs are
  skipped), sorted by `updatedAt` descending. `session/delete` disposes the live agent
  (`sessions.delete` + `dispose`), then removes the session's directory via
  `persistence.locate(header)` — note dsh's persistence surface has **no official
  delete API**, so this removes the backend directory directly. Live title/activity
  changes are pushed as `session_info_update` notifications (`session/title` and
  `turn/end` events).
- **Empty-effort suppression**: when the routed model exposes no reasoning efforts,
  the `reasoning_effort` option is not advertised — Zed renders no empty, inoperable
  "Reasoning effort" chip. Switching to a model with efforts makes the option reappear
  (every switch replays `config_option_update`).
- **Modes**: permission presets are presented as ACP session modes, so Zed's mode
  switcher drives the sandbox/approval presets.
- **Known limitations** (inherited from the official bridge): baseline prompts only
  (no image/audio/MCP attachments), no `additionalDirectories`/MCP server attachment,
  committed text streams at block granularity, and one in-flight prompt per session.
  Session resume and the archive list are supported (see above), but
  `session/close` / `session/fork` / `session/resume` are not implemented (the
  capabilities are not declared, so conforming clients do not call them);
  `session/delete` removes the backend directory directly because dsh's persistence
  surface has no official delete API.
