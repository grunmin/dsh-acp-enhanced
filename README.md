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
| **推理强度** | `session/set_config_option`，`reasoning_effort` 下拉框（仅当当前模型路由**暴露**可选的 reasoning efforts 时） | 配置项 UI（仅当路由暴露可用 efforts 时出现，见"设计说明"） |
| **权限预设** | `session/set_config_option`（`permission_preset`）**以及**通过 `session/set_mode` 的 ACP 会话模式 | 模式切换器 / 配置项 UI |
| **审批** | `session/request_permission`（每个工具调用 allow-once / reject-once） | 原生审批弹窗 |
| **Zed 客户端文件工具** | agent 侧注册 `zed_read_text_file` / `zed_write_text_file` / `zed_terminal`，转发为 `fs/read_text_file` / `fs/write_text_file` / `terminal/create` | 文件编辑出现在 agent 面板的 **"编辑文件"区（带 diff + 接受/拒绝）**；命令跑在 **Zed 真实终端** 里 |
| **Zed 表单提问** | 注册 `ask_user_question` 工具 + `userQuestions` provider，转发为 `elicitation/create`（form 模式） | DSH 需要用户确认/选择时，问题以 **Zed 原生表单** 弹出，选项即点即答 |
| **Plan 面板** | `plan_mode` 布尔配置项（Zed 侧开关）+ `plan/mode` 事件映射为 ACP `plan` update | Zed 底部出现 **Plan 状态条**：plan mode 开时显示"规划中"，关时清空 |
| **会话恢复（resume）** | 声明 `loadSession` 能力 + `session/load` 走 `agents.resume` 加载持久化会话，并把历史回放为 `user_message_chunk` / `agent_message_chunk` / `tool_call` | 在 Zed 里可以**继续之前的对话线程**（长排查不丢上下文） |
| **会话归档列表** | 声明 `sessionCapabilities.list/delete`；`session/list` 从持久化存储（`ctx.sessionPersistence.list()`）枚举会话（标题从存储日志的 `session/title` 事件读取），`session/delete` 释放在线 agent 并删除其持久化目录；`session/title` / `turn/end` 实时推送 `session_info_update` | Zed 的**历史线程归档**能看到本项目的全部会话（带标题、按更新时间排序），可点击恢复，也可删除 |
| **空选项抑制** | 当前模型路由无 reasoning efforts 时不广播 `reasoning_effort` 配置项 | 不再出现一个空的、点不动的"Reasoning effort"chip |

## 效果预览

在 Zed 的 AI Agent 面板中选择 **dsh-acp-enhanced** 后，你会看到：

<img src="assets/screenshots/approval-config-context.png" alt="审批弹窗与模型/推理强度切换、上下文环" width="560">

- 工具调用需要许可时弹出**原生审批弹窗**（allow-once / reject-once）；输入框下方是
  **模型**、**推理强度**、**权限预设**、**Plan mode** 配置项与**上下文用量环**
  （`usage_update` 遥测，含缓存命中率、TPS 等明细）。

<img src="assets/screenshots/tool-cards-elicitation.png" alt="工具调用入参与输出、Zed 原生提问表单" width="320">

- **工具卡片**可展开查看每次调用的完整入参（如 bash 执行的命令）与结果预览
  （`rawInput` / `rawOutput`）；DSH 需要你确认或选择时，以 **Zed 原生表单**弹出
  （`ask_user_question` → `elicitation/create`），选项即点即答，无需手动输入。

> **仓库结构** —— 本仓库包含两个相互独立的包：
> - `dsh-acp-enhanced`（仓库根目录）：增强版 ACP 桥接器（`lib/index.js`）。
> - `packages/dsh-web-search-openrouter/`：独立的 `ctx.web` 搜索 provider，让 `web_search`
>   走任意 OpenAI-Responses 网关，而非 DeepSeek 的 Anthropic `/messages` 端点。它刻意
>   **不**与 ACP 桥接器耦合，因此任何 profile（包括 Web GUI）都可挂载。

## 快速开始

本包遵循 dsh 官方插件规范（声明了 `dsh.bundle`），所以安装与官方组合包完全一致：
**一条命令完成** —— `dsh plugin --profile <名> add <包>` 会自动初始化 profile（首层
`dsh-base` 已含整套 agent 栈）、安装包，并把本包**自动追加进 bundle 层**。包自带的
patch 会插入 `acp-enhanced` 行并覆写默认模型路由，**全程无需手写 profile YAML**。

### 安装（2 步）

**第 1 步：安装**（从 npm registry 安装，无需下载源码）

```sh
dsh plugin --profile acp-enhanced add dsh-acp-enhanced
```

> 开发/改源码时改用 `link:` 指向本地 checkout（改动实时生效，跳过 registry）：
> `dsh plugin --profile acp-enhanced add "link:/absolute/path/to/dsh-acp-enhanced"`

**第 2 步：注册进 Zed**（模型路由与凭据全部通过 `env` 传入，无需写 patch）

在 `~/.config/zed/settings.json` 的 `agent_servers` 里注册。Zed（GUI 应用）会用极简 PATH
拉起 agent 进程，因此用随附启动器 `scripts/dsh-acp-zed.sh`（它自己会定位 `node`/`dsh`）。

#### 最常见：DeepSeek 官方 API（默认路由）

```jsonc
{
  // ...你已有的设置...
  "agent_servers": {
    "dsh-acp-enhanced": {
      "type": "custom",
      "command": "/bin/bash",
      "args": ["/absolute/path/to/dsh-acp-enhanced/scripts/dsh-acp-zed.sh"],
      "env": {
        "DSH_ACP_PROVIDER": "deepseek-official",  // 官方 provider id
        "DSH_ACP_MODEL": "deepseek-v4-flash"      // 官方模型 id
      }
    }
  }
}
```

> 这是本项目作者日常使用的配置（macOS）。`DSH_ACP_PROVIDER` / `DSH_ACP_MODEL` 与包自带
> patch 的缺省值（`deepseek-official` / `deepseek-v4-flash`）一致，**所以也可以直接省略**
> ——显式写上只是让路由意图在 Zed 配置里一目了然。API key 不必写进 Zed：写入
> `~/.dsh/.credentials.yaml`（`DEEPSEEK_API_KEY`，600 权限）由 dsh 凭据服务解析即可；
> 启动脚本还会兜底继承正在运行的 `dsh web` 进程的 key。

可选：固定面板默认项（模型 / plan mode / 推理强度；都可以随时在面板里改，这只是初始值）：

```jsonc
"dsh-acp-enhanced": {
  // ...上面的 type/command/args/env...
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

#### 扩展：走 OpenAI-Responses 网关（如公司内部模型网关）

同一安装路径，只是 env 换成网关暴露的 provider/model 与它要求的 key 环境变量名：

```jsonc
"dsh-acp-enhanced": {
  "type": "custom",
  "command": "/bin/bash",
  "args": ["/absolute/path/to/dsh-acp-enhanced/scripts/dsh-acp-zed.sh"],
  "env": {
    "DSH_ACP_PROVIDER": "<gateway-provider-id>",  // 网关暴露的 provider id
    "DSH_ACP_MODEL": "<gateway-model-id>",         // 网关暴露的 model id
    "<KEY_ENV_NAME>": "<key>"                      // 网关声明读取的 key 环境变量名
  }
}
```

> `<KEY_ENV_NAME>` 是 provider 声明读取的 key 环境变量名（网关适配器通常有自己的
> `apiKeyEnv`）；同样可以不写在 Zed 里，而是存进 `~/.dsh/.credentials.yaml` 由凭据服务
> 统一管理。路由换哪种模型都走同一条安装路径，只是 env 值不同。

Zed 会热重载设置。打开 **AI Agent 面板**（`Cmd+Shift+A`）→ 顶部 **agent 选择器** 选
**dsh-acp-enhanced** → 输入第一条消息即可。回复实时流式返回，状态栏显示上下文用量，面板
顶部有 Model / Permission preset / Plan mode 配置项与 read-only / workspace-write /
full-access 模式，线程归档里能看到并恢复历史会话。

本地验证（无需 Zed）：

```sh
node scripts/acp-client.mjs                    # 官方默认路由，无需 env；期望 ALL CHECKS PASSED
DSH_ACP_PROVIDER=... DSH_ACP_MODEL=... node scripts/acp-client.mjs   # 自定义路由时再传
env -i HOME=$HOME PATH=/usr/bin:/bin node scripts/acp-client.mjs \
  /bin/bash /absolute/path/to/dsh-acp-enhanced/scripts/dsh-acp-zed.sh  # 模拟 Zed 的 spawn 方式
```

### 可选：web_search 走同一个网关

桥接器本身不依赖它。若网关实现 OpenAI Responses 的 `web_search` 服务端工具，可把搜索也
路由到网关（复用同一凭据）。装一个普通依赖 + 在 profile 的 `cordis.patch.yml` 追加两段：

```sh
dsh plugin --profile acp-enhanced add "link:/absolute/path/to/dsh-acp-enhanced/packages/dsh-web-search-openrouter"
```

`~/.dsh/profiles/acp-enhanced/cordis.patch.yml`（`<provider>` 填你的网关 provider id）：

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

### 故障排查

| 症状 | 原因与解决办法 |
|---|---|
| `Server exited with status 127` / `exec: dsh: not found` | Zed 的 PATH 缺少 `node`/`dsh`。请用随附的 `dsh-acp-zed.sh` 启动器（它会解析两者）；可用 `bash scripts/dsh-acp-zed.sh` 在干净 shell 中验证。 |
| `no API key for provider route "deepseek-official"` | 无法解析 key。写入 `~/.dsh/.credentials.yaml`（见第 2 步），或在 agent_servers 条目里设置 `env.DEEPSEEK_API_KEY`。 |
| 编辑设置后 agent 未出现 | 执行 `zed: reload settings`（命令面板）或重启 Zed。 |
| 在 Zed 里"无法切换模型"或"上下文用量不显示" | 通常是选到了不可路由的幽灵 provider（例如某个适配器已挂载但没有任何可用的 API key）。本桥接器默认已过滤幽灵分组（只广播 `config.provider` 模型），若仍出现请确认 profile 的 `config.provider` 指向真实可用的路由，并把被污染的 `agent-default-model` 默认重置回该路由。见"设计说明"。 |
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
  （`resolveModelInfo().reasoning.efforts` 非空）。对不暴露 efforts 的路由，显式设置强度会被
  适配器拒绝（`does not support reasoning effort "high"`）——所以这类路由下 Zed 里没有推理
  强度下拉是**正确行为**，不是桥接器 bug；换到暴露 efforts 的路由后下拉框会自动出现。
- **模型目录过滤（`includeAllProviders`，默认关）**：默认只广播 `config.provider` 的模型，
  避免把"幽灵 provider"（已挂载但不可路由的适配器，例如没有可用 API key 而仍挂载的
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
- **会话归档列表（session/list + session/delete）**：`initialize` 声明
  `sessionCapabilities: { list: {}, delete: {} }`；`session/list` 用
  `ctx.sessionPersistence.list()` 枚举已物化的会话（`SessionHeader`：id/cwd/createdAt），
  标题优先取实时 `session/title` 事件记录，缺失时用 `persistence.readRaw(id)` 扫存储日志里
  最后一个 `session/title` 事件（>8MB 的日志跳过）；按 `updatedAt` 倒序返回。`session/delete`
  先释放在线 agent（`sessions.delete` + `dispose`），再通过 `persistence.locate(header)` 拿到
  该会话目录物理路径并整体删除——注意 dsh 持久化面**没有官方的删除 API**，这一步是直接删
  后端目录。实时标题/活动变化通过 `session_info_update` 通知推送（`session/title` 与
  `turn/end` 事件）。
- **空 effort 抑制**：当前路由模型不暴露 reasoning efforts 时，不广播 `reasoning_effort`
  配置项——Zed 就不会渲染一个空的、无法操作的"Reasoning effort"chip。切到带 efforts 的
  模型后该选项自动重新出现（每次切换都会重播 `config_option_update`）。
- **模式**：权限预设被呈现为 ACP 会话模式，因此 Zed 的模式切换器驱动 sandbox/approval 预设。
- **已知限制**（继承自官方桥接器）：仅 baseline prompt（无图片/音频/MCP 附件）、不支持
  `additionalDirectories`/MCP server 附加、已确认文本按块粒度流式，且每个会话同时只能有一个
  in-flight prompt。会话恢复与归档列表已支持（见上），但 `session/close` / `session/fork` /
  `session/resume` 未实现（不声明能力，合规客户端不会调用）；`session/delete` 因 dsh 持久化
  面没有官方删除 API，采用直接删除后端目录的方式。
