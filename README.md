**[English](README-en.md) | 中文**

# dsh-acp-enhanced

面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）的增强版
[Agent Client Protocol](https://agentclientprotocol.com)（ACP）服务器，专为
**Zed** 这类通过 JSON-RPC stdio 使用 ACP 的编辑器而设计。

官方 `@deepseek-ai/dsh-acp` 桥接器刻意保持"纯自动化"：在整个消息结束后才提交文本，
不带遥测，也没有模型/权限控制。本项目是一个**即插即用替代品**，把 Web GUI 有的能力
全部暴露出来：

| 能力 | ACP 机制 | 你在 Zed 中看到的 |
|---|---|---|
| **块级流式输出** | 每个已提交文本块（`block-end`）发送一条 `agent_message_chunk`，按每个模型 step 的 `messageId` 分组 | agent 工作时文本实时出现；被取消/重试的块不会残留撕裂的半截输出 |
| **Token 与上下文遥测** | 标准 `usage_update`（`used` = 上下文压力，`size` = 模型上下文窗口） | agent 状态栏中的上下文仪表 |
| **缓存命中率 / TPS / 输入-输出-推理 token / 工具耗时 / 轮次计数** | `usage_update._meta` + `tool_call` / `tool_call_update` 的 `_meta` | 每一步都有原始数字（`_meta` 扩展字段携带完整明细） |
| **模型切换** | `session/set_config_option`，`model` 下拉框（取值来自实时的 `provider/model` 模型目录） | 配置项 UI |
| **推理强度** | `session/set_config_option`，`reasoning_effort` 下拉框（当前模型路由可用的强度） | 配置项 UI |
| **权限预设** | `session/set_config_option`（`permission_preset`）**以及**通过 `session/set_mode` 的 ACP 会话模式 | 模式切换器 / 配置项 UI |
| **审批** | `session/request_permission`（每个工具调用 allow-once / reject-once） | 原生审批弹窗 |

> **仓库结构** —— 本仓库包含两个相互独立的包：
> - `dsh-acp-enhanced`（仓库根目录）：增强版 ACP 桥接器（`lib/index.js`）。
> - `packages/dsh-web-search-openrouter/`：独立的 `ctx.web` 搜索 provider，让 `web_search`
>   走任意 OpenAI-Responses 网关，而非 DeepSeek 的 Anthropic `/messages` 端点。它刻意
>   **不**与 ACP 桥接器耦合，因此任何 profile（包括 Web GUI）都可挂载。

## 快速开始

### 0. OpenAI-Responses 网关变体

上面的步骤针对 DeepSeek 官方 API（`deepseek-official` + `DEEPSEEK_API_KEY`）。
如果你是通过 OpenAI-Responses 网关（一个实现了 OpenAI Responses API 的企业级 LLM 网关）
来访问模型，则可用一个更小的 profile：随附的 `dsh-base` bundle 已经挂载了整套 agent
栈（spine、sandbox、approval、permission presets、token meter、compaction、fs 工具……），
因此该 profile 只需添加 `acp-enhanced` 一行、一个默认模型覆写，以及可选的
`web-search-openrouter` provider。

```sh
# 1) profile 骨架（bundle = dsh-base；"init" 的 pnpm 报错无害）
dsh plugin --profile acp-enhanced init

# 2) 安装仓库依赖，并把两个包都链接进 profile
cd /path/to/dsh-acp-enhanced && pnpm install
mkdir -p ~/.dsh/profiles/acp-enhanced/node_modules
ln -s /path/to/dsh-acp-enhanced ~/.dsh/profiles/acp-enhanced/node_modules/dsh-acp-enhanced
ln -s /path/to/dsh-acp-enhanced/packages/dsh-web-search-openrouter \
  ~/.dsh/profiles/acp-enhanced/node_modules/dsh-web-search-openrouter

# 3) 编写 patch 层（见下）
```

`~/.dsh/profiles/acp-enhanced/cordis.patch.yml`（*用户 patch 层* —— 根 `cordis.yml` 在
每次启动时都会被重写为 `[]`，所以组合在这里，而不是在 `cordis.yml`）：

```yaml
- id: agent-default-model
  config:
    provider: <your-provider-id>
    model: <your-model-id>

# 通过同一个网关路由 web_search：其 OpenAI Responses API 实现了原生
# `web_search` 工具（返回 `openrouter:web_search` 项），因此无需单独的
# DeepSeek 搜索 key/endpoint。
- id: web
  config:
    searchProvider: openai-responses

- insert:
    - id: acp-enhanced
      name: 'dsh-acp-enhanced'
      config:
        provider: <your-provider-id>
        model: <your-model-id>

    - id: web-search-openrouter
      name: 'dsh-web-search-openrouter'
      config:
        enabled: true
        baseURL: http://<gateway-host>:<port>/v1
        model: <your-model-id>
        apiKeyEnv: RESPONSES_API_KEY
        searchContextSize: medium
        maxOutputTokens: 1024
```

为什么要覆写 `agent-default-model`：在任何请求头存在之前，桥接器的按会话选择会先回退到
`agent-default-model`，而基础行默认是 `deepseek-official`——不覆写的话，提示词会被路由到
llm-deepseek 并以 *no API key for provider route "deepseek-official"* 失败。

Web 搜索是一个**独立包**（`packages/dsh-web-search-openrouter`），不属于 ACP 桥接器：
该 provider 是一个正交的 `ctx.web` 能力，任何 profile（含 Web GUI）都能挂载。它注册了一个
id 为 `openai-responses` 的搜索 provider，使用 OpenAI 的 `web_search` 服务端工具调用网关的
`/responses` 端点；用 `web.searchProvider` 即可选中它。桥接器的 Config 保持干净
（仅 `provider`/`model`），且 `deepseek-official` provider 在无网关的环境下依然可用。

Zed 的注册与下面的第 3 步相同；可用下列命令验证：

```sh
node scripts/acp-client.mjs                          # 期望 ALL CHECKS PASSED
node scripts/web-search-test.mjs                     # 期望 ALL CHECKS PASSED（web_search 走网关）
env -i HOME=$HOME PATH=/usr/bin:/bin node scripts/acp-client.mjs \
  /bin/bash /path/to/dsh-acp-enhanced/scripts/dsh-acp-zed.sh   # 模拟 Zed 的 spawn 方式
```

### 1. 创建 profile

```sh
# 一次性 profile 初始化（若 ~/.dsh/profiles/acp-enhanced 已存在则跳过）
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
# 把 profile/cordis.yml 安装进 profile：
cp profile/cordis.yml ~/.dsh/profiles/acp-enhanced/cordis.yml
```

> `link:` 会让你的改动实时生效（pnpm 用符号链接到包）；需要冻结副本则用 `file:`。
> `@next` 固定为与运行中的 dsh 匹配的 0.1.0-rc.6 版本线。

### 2. 提供 API key

该 profile 通过 dsh 凭据服务解析 `DEEPSEEK_API_KEY`。只需存储一次（等价于 Web Models
页面所写入的内容）：

```sh
# ~/.dsh/.credentials.yaml — dsh 以 0600 权限创建并自动读取
# DEEPSEEK_API_KEY: sk-...
echo "DEEPSEEK_API_KEY: sk-..." >> ~/.dsh/.credentials.yaml && chmod 600 ~/.dsh/.credentials.yaml
```

或者在启动环境中导出：

```sh
export DEEPSEEK_API_KEY=sk-...
dsh --profile acp-enhanced       # stdout 是 ACP 协议线 — 不要往里打日志
```

### 3. 在 Zed 中注册

Zed（GUI 应用）会用极简 PATH 来拉起 agent 进程，因此请使用随附的启动器
`scripts/dsh-acp-zed.sh`——它自己会定位 `node` 和 `dsh`（PATH → npx 缓存 → 全局 npm →
Homebrew），把 node 目录前置到 PATH，并可选地从正在运行的 `dsh web` 进程继承
`DEEPSEEK_API_KEY`。

`~/.config/zed/settings.json`：

```jsonc
{
  // ...你已有的设置...
  "agent_servers": {
    // 可选：已有的 agent（pi-acp、codex-acp……）不受影响
    "dsh-acp-enhanced": {
      "type": "custom",
      "command": "/bin/bash",
      "args": ["/absolute/path/to/dsh-acp-enhanced/scripts/dsh-acp-zed.sh"],
      "env": {}          // 可选：{"DEEPSEEK_API_KEY": "sk-..."} 可覆写
    }
  }
}
```

Zed 会热重载设置。然后在 Zed 界面中：

1. 打开 **AI Agent 面板**（右侧边栏，`Cmd+Shift+A`）。
2. 点击面板顶部的 **agent 选择器**（或从命令面板执行 `agent: select agent`），选择
   **dsh-acp-enhanced**。
3. 首次选择时 agent 进程会被拉起。输入一条消息——回复会实时流式返回，上下文仪表
   （`usage_update`）跟踪 used/size，面板会暴露 **Model**、**Reasoning effort** 和
   **Permission preset** 配置项，以及 read-only / workspace-write / full-access 模式。

### 故障排查

| 症状 | 原因与解决办法 |
|---|---|
| `Server exited with status 127` / `exec: dsh: not found` | Zed 的 PATH 缺少 `node`/`dsh`。请用随附的 `dsh-acp-zed.sh` 启动器（它会解析两者）；可用 `bash scripts/dsh-acp-zed.sh` 在干净 shell 中验证。 |
| `no API key for provider route "deepseek-official"` | 无法解析 key。写入 `~/.dsh/.credentials.yaml`（见第 2 步），或在 agent_servers 条目里设置 `env.DEEPSEEK_API_KEY`。 |
| 编辑设置后 agent 未出现 | 执行 `zed: reload settings`（命令面板）或重启 Zed。 |
| `session/new` 报 `additionalDirectories is not supported` | ACP 桥接器仅支持 baseline；Zed 默认不会发送额外目录——若自定义配置发送了就移除它。 |
| 需要详细诊断 | 用 `ACP_DEBUG=1 dsh --profile acp-enhanced` 启动（stderr 上的生命周期 trace）。 |

## 开发

```sh
node scripts/acp-client.mjs           # 端到端冒烟测试（需要 DEEPSEEK_API_KEY）
DEEPSEEK_API_KEY=... node scripts/acp-client.mjs
ACP_DEBUG=1 dsh --profile acp-enhanced   # stderr 上的详细生命周期 trace
```

该冒烟客户端驱动 initialize → session/new → prompt（验证块级流式、`usage_update`、
`tool_call`）、配置项与模式切换、切换后的第二次 prompt，以及 `session/cancel`。

## 设计说明

- **块级流式输出**：文本增量按块索引累积；`block-end` 一旦确认就立即上送线上。重试会重启
  同一个索引，因此被取消尝试的残留尾部永远到不了客户端——ACP 没有撤销机制，这是最干净的边界。
- **遥测**：每个 provider 的 `usage` 样本都会以 `usage_update` 广播（used = 输入 + 缓存命中
  + 缓存写入；size = 所路由模型的上下文窗口），完整明细在 `_meta` 中：输入/输出/缓存/推理
  token、`cacheHitRate`、`tps`（生成 token / step 墙钟耗时）、step 耗时、轮次计数，以及累计的
  工具调用统计。
- **会话配置**：`model` 下拉框枚举实时模型目录（`ctx.llm.listProviders` → `listModels` →
  `resolveModelInfo`），`reasoning_effort` 下拉框枚举当前路由的可用强度，`permission_preset`
  枚举已挂载的预设。修改走 `llm.resolveCallConfig` 与 `installModelSelection`（与 Web
  api-proxy 使用的同一机制）或 `permissionPresets.apply` 写路径。
- **模式**：权限预设被呈现为 ACP 会话模式，因此 Zed 的模式切换器驱动 sandbox/approval 预设。
- **已知限制**（继承自官方桥接器）：仅全新会话（无 load/resume）、仅 baseline prompt（无
  图片/音频/MCP）、已确认文本按块粒度流式，且每个会话同时只能有一个 in-flight prompt。
