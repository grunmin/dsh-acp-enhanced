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
| **工具调用可见性** | `tool_call` 携带 `rawInput`（解析后的参数对象）与 `kind`（read/edit/execute/…）；`tool_call_update` 携带 `rawOutput`（结果预览，最多 12k 字符） | 工具卡片能展开看到**具体参数**（如 bash 执行的命令）与**执行结果**，并按工具类型渲染图标 |
| **模型切换** | `session/set_config_option`，`model` 下拉框（取值来自实时的 `provider/model` 模型目录；分组线格式为 ACP 规范的 `{ group, name, options }`） | 配置项 UI——可切换路由内任意模型 |
| **推理强度** | `session/set_config_option`，`reasoning_effort` 下拉框（仅当当前模型路由**暴露**可选的 reasoning efforts 时） | 配置项 UI（当前网关路由的所有模型都不暴露 efforts——见"设计说明"，这是路由/适配器限制而非桥接器 bug） |
| **权限预设** | `session/set_config_option`（`permission_preset`）**以及**通过 `session/set_mode` 的 ACP 会话模式 | 模式切换器 / 配置项 UI |
| **审批** | `session/request_permission`（每个工具调用 allow-once / reject-once） | 原生审批弹窗 |
| **Zed 客户端文件工具** | agent 侧注册 `zed_read_text_file` / `zed_write_text_file` / `zed_terminal`，转发为 `fs/read_text_file` / `fs/write_text_file` / `terminal/create` | 文件编辑出现在 agent 面板的 **"编辑文件"区（带 diff + 接受/拒绝）**；命令跑在 **Zed 真实终端** 里 |
| **Zed 表单提问** | 注册 `ask_user_question` 工具 + `userQuestions` provider，转发为 `elicitation/create`（form 模式） | DSH 需要用户确认/选择时，问题以 **Zed 原生表单** 弹出，选项即点即答 |
| **Plan 面板** | `plan_mode` 布尔配置项（Zed 侧开关）+ `plan/mode` 事件映射为 ACP `plan` update | Zed 底部出现 **Plan 状态条**：plan mode 开时显示"规划中"，关时清空 |
| **会话恢复（resume）** | 声明 `loadSession` 能力 + `session/load` 走 `agents.resume` 加载持久化会话，并把历史回放为 `user_message_chunk` / `agent_message_chunk` / `tool_call` | 在 Zed 里可以**继续之前的对话线程**（长排查不丢上下文） |
| **空选项抑制** | 当前模型路由无 reasoning efforts 时不广播 `reasoning_effort` 配置项 | 不再出现一个空的、点不动的"Reasoning effort"chip |

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
        # 可选：默认只在下拉框里广播 config.provider 的模型（见"设计说明"）。
        # 多 provider 且都可用时才设为 true。
        includeAllProviders: false

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
| 在 Zed 里"无法切换模型"或"上下文用量不显示" | 通常是选到了不可路由的幽灵 provider（如某些环境 上仍挂载的 `deepseek-official`）。本桥接器默认已过滤幽灵分组（只广播 `config.provider` 模型），若仍出现请确认 profile 的 `config.provider` 指向真实可用的路由，并把被污染的 `agent-default-model` 默认重置回该路由。见"设计说明"。 |
| `session/new` 报 `additionalDirectories is not supported` | ACP 桥接器仅支持 baseline；Zed 默认不会发送额外目录——若自定义配置发送了就移除它。 |
| 需要详细诊断 | 用 `ACP_DEBUG=1 dsh --profile acp-enhanced` 启动（stderr 上的生命周期 trace）。 |

## 开发

```sh
node scripts/acp-client.mjs           # 端到端冒烟测试（需要 DEEPSEEK_API_KEY）
DEEPSEEK_API_KEY=... node scripts/acp-client.mjs
node scripts/acp-client-tools.mjs     # 客户端工具测试（模拟 Zed 的 fs/terminal/elicitation/plan 能力）
node scripts/acp-resume-test.mjs      # 会话恢复测试（两个进程：创建持久化 → 加载回放 → 续聊）
ACP_DEBUG=1 dsh --profile acp-enhanced   # stderr 上的详细生命周期 trace
```

该冒烟客户端驱动 initialize → session/new → prompt（验证块级流式、`usage_update`、
`tool_call`）、配置项与模式切换、切换后的第二次 prompt，以及 `session/cancel`。
`acp-client-tools.mjs` 用 SDK 的 `ClientSideConnection` 模拟 Zed：声明
`fs.readTextFile/writeTextFile/terminal/elicitation` 能力，验证模型调用 `zed_*` 工具时请求以
`fs/write_text_file`、`fs/read_text_file`、`terminal/create` 正确到达客户端，`ask_user_question`
以 `elicitation/create` 表单（含 enum 选项）到达客户端，`plan_mode` 布尔开关触发 ACP `plan`
update（开→条目、关→清空），并验证无 reasoning efforts 的路由不再广播空 `reasoning_effort`。

## 设计说明

- **块级流式输出**：文本增量按块索引累积；`block-end` 一旦确认就立即上送线上。重试会重启
  同一个索引，因此被取消尝试的残留尾部永远到不了客户端——ACP 没有撤销机制，这是最干净的边界。
- **遥测**：每个 provider 的 `usage` 样本都会以 `usage_update` 广播（used = 输入 + 缓存命中
  + 缓存写入；size = 所路由模型的上下文窗口），完整明细在 `_meta` 中：输入/输出/缓存/推理
  token、`cacheHitRate`、`tps`（生成 token / step 墙钟耗时）、step 耗时、轮次计数，以及累计的
  工具调用统计。
- **工具调用可见性**：`tool_call` 通知带 `kind` 与 `rawInput`（`JSON.parse` 参数，失败则回退为
  字符串），Zed 的工具卡片因此能展开看到具体参数（bash 的命令、写入的文件等）；
  `tool_call_update` 带 `rawOutput`（从 `ToolResultMessage` 的文本块提取结果预览，截断 12k）。
  **`kind` 映射有个关键约束**：Zed 把 `kind == 'execute'` 当**终端工具**、`kind == 'edit'`
  当 **diff 工具**，两者都会**隐藏 rawInput**。所以只有真正在 Zed 里开终端的 `zed_terminal`
  用 `execute`；bash/run_code/写文件等一律 `other`（rawInput 正常显示），否则就会出现"卡片只
  显示 bash 字样、看不到命令"的现象。另注意 dsh 的 `tool/result` 事件里 `toolCallId` 在
  `message.content[0].toolCallId`（`ToolResultBlock`）上，不在事件根——漏取会导致 SDK 校验
  拒绝整条 `tool_call_update`。历史回放（resume）同样携带这些字段。
- **会话配置**：`model` 下拉框枚举实时模型目录（`ctx.llm.listProviders` → `listModels` →
  `resolveModelInfo`），`reasoning_effort` 下拉框枚举当前路由的可用强度，`permission_preset`
  枚举已挂载的预设。修改走 `llm.resolveCallConfig` 与 `installModelSelection`（与 Web
  api-proxy 使用的同一机制）或 `permissionPresets.apply` 写路径。
- **模型分组线格式**：`model` 选项的分组必须是 ACP 规范的
  `{ group: <id>, name: <label>, options: [...] }`。早期版本发成了 `{ groupName, options }`，
  Zed（`agent-client-protocol-schema` 1.4.0）反序列化时把整个组跳过（`DefaultOnError` +
  `VecSkipError`），于是 `model` 下拉框变空、模型无法选择——而 SDK 的 mock 客户端不校验
  响应所以测试没拦住；现在 `acp-client-tools.mjs` 会对每个 config option 跑
  `zSessionConfigOption.safeParse`，这类线格式错误不会再漏网。
- **推理强度的路由限制**：`reasoning_effort` 选项只在模型路由**暴露** efforts 时广播
  （`resolveModelInfo().reasoning.efforts` 非空）。当前网关路由的 9 个模型都不
  暴露 efforts（逐个探测确认），且显式设置会被适配器拒绝（`does not support reasoning
  effort "high"`）——所以该路由下 Zed 里没有推理强度下拉是**正确行为**，不是桥接器 bug；
  换到暴露 efforts 的路由（如其他环境 上的官方 deepseek 模型）后下拉框会自动出现。
- **模型目录过滤（`includeAllProviders`，默认关）**：默认只广播 `config.provider` 的模型，
  避免把"幽灵 provider"（已挂载但不可路由的适配器，例如聊天走网关时仍挂着的官方
  `deepseek-official`）列进下拉框。这些模型在列表里看起来可切换，但一旦选中，后续每次
  prompt 都会以 `MISSING_CREDENTIAL`（`no API key for provider route "xxx"`）失败——在
  Zed 里表现为"无法切换模型、且因 turn 失败而不再收到 `usage_update`，上下文用量不显示"
  （Web GUI 会对不可路由的当前项显示 unavailable 横幅，Zed 没有，所以同样的数据在 Zed
  里看起来就是坏的）。需要多 provider 都可用时设 `includeAllProviders: true`。
- **默认模型不被污染**：`applySelection` 只有在 `selected.provider === config.provider`（或
  显式 `includeAllProviders`）时才把新选择持久化为 `agent-default-model` 默认值。否则一次
  误切到不可路由的 provider 只会作用于当前会话，不会写坏后续所有新会话的默认路由。
- **客户端转发工具（Zed fs / terminal）**：`initialize` 时读取 `clientCapabilities`，仅在客户端
  声明对应能力时，向 agent 注册 `zed_read_text_file` / `zed_write_text_file` / `zed_terminal`
  三个工具（`ctx.tools.register` + `defineTool`）。工具体通过 `conn.readTextFile` /
  `conn.writeTextFile` / `conn.createTerminal` 把请求转发给编辑器：`zed_write_text_file` 让
  文件编辑落在 Zed 自己的 buffer 上，出现在 agent 面板的"编辑文件"区（diff + 接受/拒绝）；
  `zed_terminal` 让命令跑在 Zed 真实终端里并轮询输出（`terminal/output` 是累计内容，取最后
  一次即可），120s 超时后 kill。无这些能力的客户端（如纯自动化测试）不会看到这些工具。
- **Zed 表单提问（elicitation）**：客户端声明 `elicitation.form` 时，桥接器注册
  `ask_user_question` 工具（复刻 `dsh-tool-ask-user` 的定义，走 `ctx.userQuestions` seam）
  以及对应的 UI provider：把问题映射成 ACP `elicitation/create`（form 模式）的 JSON Schema
  （单选 → `string`+`enum`，多选 → `array`，无选项 → 裸 `string`），用户在 Zed 里以原生
  表单作答后，答案映射回 `AskUserQuestionAnswer` 喂回模型。decline/cancel 会以错误结束该次
  工具调用，模型可据此改道。注意 Zed 的 elicitation 能力是对象（`form: {}`）而非布尔，
  判断用"存在"而非 `=== true`。
- **Plan 面板**：`plan_mode` 布尔配置项走 `ctx.planMode.set(agent, active)` 切换 DSH plan
  mode（Zed 的布尔开关即点即用）；`session/event` 里的 `plan/mode` 翻转被映射为 ACP `plan`
  update——开时一条"规划中"条目，关时清空。DSH 的 plan mode 没有结构化任务列表，所以这是
  状态指示而非任务清单。注意 ACP 的 `plan` update 是**扁平**形状
  （`{ sessionUpdate: 'plan', entries: [...] }`），不是 `{ plan: {...} }`。
- **会话恢复（session/load）**：`initialize` 声明 `loadSession: true`；`session/load` 通过
  `ctx.agents.resume({ resumeSessionId })` 从持久化存储（`dsh-session-persistence-jsonl`，
  dsh-base 已挂载）恢复 agent，然后按事件日志回放历史：`user/message`（仅
  `source.kind === 'user'` 的真实人类消息，过滤 system-reminder 等合成注入）→
  `user_message_chunk`，`assistant/message` 的文本 → `agent_message_chunk`，
  `tool/call`/`tool/result` → `tool_call`/`tool_call_update`。Zed 在线程插入后才完成 load
  RPC，所以回放通知能被线程接收。回放完成后该会话与新建会话一样支持继续 prompt。
- **空 effort 抑制**：当前路由模型不暴露 reasoning efforts 时，不广播 `reasoning_effort`
  配置项——Zed 就不会渲染一个空的、无法操作的"Reasoning effort"chip。切到带 efforts 的
  模型后该选项自动重新出现（每次切换都会重播 `config_option_update`）。
- **模式**：权限预设被呈现为 ACP 会话模式，因此 Zed 的模式切换器驱动 sandbox/approval 预设。
- **已知限制**（继承自官方桥接器）：仅 baseline prompt（无图片/音频/MCP 附件）、不支持
  `additionalDirectories`/MCP server 附加、已确认文本按块粒度流式，且每个会话同时只能有一个
  in-flight prompt。会话恢复已支持（见上），但"恢复后同一连接内不能有两个同名会话记录"等
  边界由 `session/load` 的 live-session 短路处理。
