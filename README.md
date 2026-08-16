**[中文](README.md) | English**

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
  torn output
- **Full telemetry**: context usage ring plus cache hit rate / TPS / input-output-reasoning
  tokens / tool timing / turn counts (`usage_update._meta` carries the full breakdown)

### Model & permissions

- **Model switching**: live `provider/model` catalog dropdown (ACP grouped-select wire shape)
- **Reasoning effort**: `reasoning_effort` dropdown — only when the routed model exposes
  selectable efforts
- **Permission presets**: read-only / workspace-write / full-access session modes
- **Approval**: native allow-once / reject-once prompts per tool call

### Zed deep integration

- **Tool cards**: expand to see each call's full arguments and result preview
  (`rawInput` / `rawOutput`), with per-kind icons
- **Zed files & terminal**: `zed_read_text_file` / `zed_write_text_file` / `zed_terminal`
  put file edits into Zed's "edited files" area (diff + accept/reject) and commands into a
  real Zed terminal
- **Native form questions**: `ask_user_question` → `elicitation/create` form, click an
  option, no typing
- **Plan panel**: plan mode toggle → "planning" status bar in Zed

### Sessions

- **Resume & archive**: `session/load` restores past threads (full replay);
  `session/list` / `session/delete` manage the thread archive (titled, sorted by last
  activity); live title updates

### Commands

- **Slash commands**: typing `/` reveals the command list (`available_commands_update`):
  `/status` shows the route and telemetry, `/model` lists or switches the model, everything
  else (`/compact` `/goal` `/permission` `/plan`…) runs straight through the harness
  command registry — all executed **without a model turn**; unresolved slashes fall
  through to the model (the `/skill-name` skill gesture)

### MCP

- **MCP servers**: `session/new` `mcpServers` mount any MCP server (stdio + streamable
  HTTP); tools join as `mcp__<server>__<tool>`; a failing server never takes the session
  down

## Preview

After picking **dsh-acp-enhanced** in Zed's AI Agent panel:

<img src="assets/screenshots/approval-config-context.png" alt="Approval popup, model/reasoning-effort switches, context ring" width="560">

- Tool calls that need permission pop a **native approval prompt**; below the input box sit
  the model, reasoning effort, permission preset, plan mode options and the context usage
  ring.

<img src="assets/screenshots/tool-cards-elicitation.png" alt="Tool call inputs and outputs, native Zed question form" width="320">

- **Tool cards** expand to show full arguments and result previews; when dsh needs your
  confirmation or a choice, the question arrives as a **native Zed form** — click an
  option, no typing.

## Quick start

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
        "DSH_ACP_MODEL": "deepseek-v4-flash"      // the official model id
      }
    }
  }
}
```

> Both env vars match the shipped patch's defaults, so **they can be omitted entirely** —
> writing them out just makes the route explicit. The API key does not have to live in Zed:
> store it in `~/.dsh/.credentials.yaml` (`DEEPSEEK_API_KEY`) and the dsh credentials
> service resolves it; the launcher also falls back to a running `dsh web` process's key.

Optional: pin the panel's default config options (all still changeable in the panel):

```jsonc
"dsh-acp-enhanced": {
  // ...the type/command/args/env above...
  "default_config_options": {
    "model": "deepseek-official/deepseek-v4-flash",
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
node scripts/acp-client.mjs                    # official default route, no env; expect ALL CHECKS PASSED
DSH_ACP_PROVIDER=... DSH_ACP_MODEL=... node scripts/acp-client.mjs   # only for a custom route
```

### Optional: route web_search through the same gateway

If the gateway implements the OpenAI Responses `web_search` server tool, you can route
search through it too (reusing the same credential). Install the sub-package and append
two blocks to the profile's `cordis.patch.yml`:

```sh
dsh plugin --profile acp-enhanced add dsh-web-search-openrouter
```

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

## Troubleshooting

| Symptom | Fix |
|---|---|
| `exec: dsh: not found` (status 127) | Use the shipped `dsh-acp-zed.sh` launcher (locates node/dsh itself) |
| `no API key for provider route "xxx"` | Write `~/.dsh/.credentials.yaml`, or set `env.DEEPSEEK_API_KEY` on the agent_servers entry |
| Cannot switch models / context usage missing | A "phantom provider" route was picked; this bridge filters them by default (only `config.provider`'s models are advertised) — point the profile's provider at a real route |
| Need detailed diagnostics | `ACP_DEBUG=1 dsh --profile acp-enhanced` (stderr lifecycle trace) |

## Development

```sh
node scripts/acp-client.mjs           # end-to-end smoke (needs an API key)
node scripts/acp-client-tools.mjs     # client-tool tests (mocks Zed fs/terminal/elicitation/plan)
node scripts/acp-mcp-test.mjs         # MCP mount test (no model calls)
node scripts/acp-smoke-keyless.mjs    # keyless boot smoke (CI)
node scripts/acp-resume-test.mjs      # session resume test
```

## Known limitations

Baseline prompts only (no image/audio attachments), no `additionalDirectories`, text
streams at block granularity, one in-flight prompt per session. MCP supports stdio and
streamable HTTP (legacy SSE / `acp` transports are not advertised).
`session/close` / `session/fork` / `session/resume` are not implemented (capabilities
undeclared, compliant clients will not call them); `session/delete` removes the persisted
directory directly because dsh persistence has no official delete API.
