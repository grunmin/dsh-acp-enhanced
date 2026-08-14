# dsh-acp-enhanced

Enhanced [Agent Client Protocol](https://agentclientprotocol.com) server for
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh),
built for editors like **Zed** that speak ACP over JSON-RPC stdio.

The official `@deepseek-ai/dsh-acp` bridge is deliberately automation-only:
committed text after a whole message, no telemetry, no model/permission
controls. This project is a drop-in replacement that exposes the surfaces the
Web GUI has:

| Surface | ACP mechanism | What you see in Zed |
|---|---|---|
| **Block-level streaming** | `agent_message_chunk` per committed text block (`block-end`), grouped by `messageId` per model step | Text appears while the agent works; cancelled/retried blocks never leak torn output |
| **Token & context telemetry** | standard `usage_update` (`used` = context pressure, `size` = model context window) | Context meter in the agent status bar |
| **Cache hit rate / TPS / input-output-reasoning tokens / tool timing / turn count** | `usage_update._meta` + `tool_call` / `tool_call_update` `_meta` | Raw numbers every step (the `_meta` extension field carries the full breakdown) |
| **Model switching** | `session/set_config_option` with the `model` select (`provider/model` values from the live model catalog) | Config-option UI |
| **Reasoning effort** | `session/set_config_option` with the `reasoning_effort` select (efforts of the current model route) | Config-option UI |
| **Permission preset** | `session/set_config_option` (`permission_preset`) **and** ACP session modes via `session/set_mode` | Mode switcher / config-option UI |
| **Approval** | `session/request_permission` (allow-once / reject-once per tool call) | Native approval prompt |

## Quick start

### 1. Create the profile

```sh
# one-time profile setup (already done if ~/.dsh/profiles/acp-enhanced exists)
dsh plugin --profile acp-enhanced init
dsh plugin --profile acp-enhanced add "link:/absolute/path/to/dsh-acp-enhanced" \
  "@deepseek-ai/dsh-agent-spine-demo@next" "@deepseek-ai/dsh-llm-deepseek@next" \
  "@deepseek-ai/dsh-sandbox-local@next" "@deepseek-ai/dsh-sandbox-policy@next" \
  "@deepseek-ai/dsh-subprocess-local@next" "@deepseek-ai/dsh-bash-sandbox@next" \
  "@deepseek-ai/dsh-user-approval@next" "@deepseek-ai/dsh-permission-presets@next" \
  "@deepseek-ai/dsh-session-persistence-jsonl@next" \
  "@deepseek-ai/dsh-session-checkpoint-policy@next" \
  "@deepseek-ai/dsh-session-query-sqlite@next" "@deepseek-ai/dsh-session-projection@next" \
  "@deepseek-ai/dsh-token-meter@next" "@deepseek-ai/dsh-compaction-basic@next" \
  "@deepseek-ai/dsh-fs-sandbox@next" "@deepseek-ai/dsh-fs-observation-policy@next" \
  "@deepseek-ai/dsh-tool-fs@next" "@deepseek-ai/dsh-tool-todo@next" \
  "@deepseek-ai/dsh-repeat-tool-reminder@next" \
  "@deepseek-ai/dsh-agent-loop@next" "@deepseek-ai/dsh-goal@next" \
  "@deepseek-ai/dsh-goal-round-driver@next" "@deepseek-ai/dsh-home-paths@next" \
  "@deepseek-ai/dsh-llm-retry@next" "@deepseek-ai/dsh-scope@next" \
  "@deepseek-ai/dsh-session-title@next" "@deepseek-ai/dsh-skill@next" \
  "@deepseek-ai/dsh-system-prompt@next" "@deepseek-ai/dsh-jobs-local@next" \
  "@deepseek-ai/dsh-shell-env@next" "@deepseek-ai/dsh-tool-bash@next" \
  "@deepseek-ai/dsh-tool-goal@next" "@deepseek-ai/dsh-tool-skill@next" \
  "@deepseek-ai/dsh-skill-filesystem@next" "@deepseek-ai/dsh-tool-jobs@next" \
  "@deepseek-ai/cordis-plugin-timer@next" "@deepseek-ai/cordis@next" \
  "@deepseek-ai/dsh-agent@next" "@deepseek-ai/dsh-session@next" \
  "@deepseek-ai/dsh-llm@next" "@deepseek-ai/dsh-tools@next" \
  "@deepseek-ai/dsh-agent-instructions@next" "@deepseek-ai/dsh-invariants@next" \
  "@deepseek-ai/dsh-session-query@next" "@deepseek-ai/cordis-plugin-loader@next" \
  "@deepseek-ai/cordis-plugin-include@next" "@deepseek-ai/dsh-app-boot@next" zod
# install profile/cordis.yml into the profile:
cp profile/cordis.yml ~/.dsh/profiles/acp-enhanced/cordis.yml
```

> `link:` keeps your edits live (pnpm symlinks the package); use `file:` for a
> frozen copy. `@next` pins the 0.1.0-rc.6 line matching the running dsh.

### 2. Provide the API key

The profile resolves `DEEPSEEK_API_KEY` through the dsh credentials service.
Store it once (equivalent to what the Web Models page writes):

```sh
# ~/.dsh/.credentials.yaml — created 0600 by dsh, read automatically
# DEEPSEEK_API_KEY: sk-...
echo "DEEPSEEK_API_KEY: sk-..." >> ~/.dsh/.credentials.yaml && chmod 600 ~/.dsh/.credentials.yaml
```

Or keep exporting it in the launching environment:

```sh
export DEEPSEEK_API_KEY=sk-...
dsh --profile acp-enhanced       # stdout is the ACP wire — do not log to it
```

### 3. Register in Zed

Zed (a GUI app) spawns agent processes with a minimal PATH, so use the bundled
launcher `scripts/dsh-acp-zed.sh` — it locates `node` and `dsh` itself
(PATH → npx cache → global npm → Homebrew), prepends the node dir to PATH, and
optionally inherits `DEEPSEEK_API_KEY` from a running `dsh web` process.

`~/.config/zed/settings.json`:

```jsonc
{
  // ...your existing settings...
  "agent_servers": {
    // optional: existing agents (pi-acp, codex-acp, ...) stay untouched
    "dsh-acp-enhanced": {
      "type": "custom",
      "command": "/bin/bash",
      "args": ["/absolute/path/to/dsh-acp-enhanced/scripts/dsh-acp-zed.sh"],
      "env": {}          // optional: {"DEEPSEEK_API_KEY": "sk-..."} overrides
    }
  }
}
```

Zed hot-reloads settings. Then, in the Zed UI:

1. Open the **AI Agent panel** (right sidebar, `Cmd+Shift+A`).
2. Click the **agent selector** at the top of the panel (or run
   `agent: select agent` from the command palette) and choose
   **dsh-acp-enhanced**.
3. The agent process spawns on first selection. Type a message — replies
   stream in, the context meter (`usage_update`) tracks used/size, and the
   panel exposes **Model**, **Reasoning effort** and **Permission preset**
   config options plus the read-only / workspace-write / full-access modes.

### Troubleshooting

| Symptom | Cause & fix |
|---|---|
| `Server exited with status 127` / `exec: dsh: not found` | Zed's PATH lacks `node`/`dsh`. Use the bundled `dsh-acp-zed.sh` launcher (it resolves both); verify with `bash scripts/dsh-acp-zed.sh` in a clean shell. |
| `no API key for provider route "deepseek-official"` | Key not resolvable. Write `~/.dsh/.credentials.yaml` (see step 2) or set `env.DEEPSEEK_API_KEY` in the agent_servers entry. |
| Agent not listed after editing settings | Run `zed: reload settings` (command palette) or restart Zed. |
| `session/new` fails with `additionalDirectories is not supported` | The ACP bridge is baseline-only; Zed sends no extra dirs by default — if a custom setup does, remove it. |
| Need verbose diagnostics | Launch with `ACP_DEBUG=1 dsh --profile acp-enhanced` (lifecycle trace on stderr). |

## Development

```sh
node scripts/acp-client.mjs           # end-to-end smoke test (needs DEEPSEEK_API_KEY)
DEEPSEEK_API_KEY=... node scripts/acp-client.mjs
ACP_DEBUG=1 dsh --profile acp-enhanced   # verbose lifecycle trace on stderr
```

The smoke client drives initialize → session/new → prompt (verifies block-level
streaming, `usage_update`, `tool_call`), config-option and mode switches, a
second prompt after the switches, and `session/cancel`.

## Design notes

- **Block-level streaming**: text deltas are accumulated per block index;
  `block-end` commits the block to the wire immediately. A retry restarts the
  same index, so a cancelled attempt's tail never reaches the client — ACP has
  no revocation, so this is the clean boundary.
- **Telemetry**: every provider `usage` sample is broadcast as `usage_update`
  (used = input + cache-read + cache-write; size = the routed model's context
  window), with the full breakdown in `_meta`: input/output/cache/reasoning
  tokens, `cacheHitRate`, `tps` (generated tokens / step wall time), step
  elapsed, turn count, and cumulative tool-call stats.
- **Session config**: the `model` select enumerates the live model catalog
  (`ctx.llm.listProviders` → `listModels` → `resolveModelInfo`), the
  `reasoning_effort` select enumerates the current route's efforts, and
  `permission_preset` enumerates the mounted presets. Changes go through
  `llm.resolveCallConfig` and `installModelSelection` (the same mechanism the
  Web api-proxy uses) or the `permissionPresets.apply` write path.
- **Modes**: permission presets are surfaced as ACP session modes, so Zed's
  mode switcher drives the sandbox/approval preset.
- **Known limits** (inherited from the official bridge): fresh sessions only
  (no load/resume), baseline prompts only (no images/audio/MCP), committed
  text streams at block granularity, and one in-flight prompt per session.
