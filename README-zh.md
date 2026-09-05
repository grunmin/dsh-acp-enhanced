**[English](README.md) | 中文**

# dsh-acp-enhanced

面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）的增强版
[Agent Client Protocol](https://agentclientprotocol.com)（ACP）服务器，为 **Zed** 等 ACP
编辑器设计。它是官方 `@deepseek-ai/dsh-acp` 桥接器的即插即用替代品：官方桥只做纯文本
输出，本桥把 Web GUI 的能力（流式、遥测、模型/权限控制、会话管理、MCP）全部暴露到
ACP 线上。

## 特性

### 输出与遥测

- **块级流式 + 推理流式**：文本块与思考过程实时到达（`agent_message_chunk` /
  `agent_thought_chunk`），取消/重试不留半截输出。在 acp-enhanced 行设置
  `streamDeltas: true` 可切换为**逐 token 流式**——回复边生成边渲染（75ms 合并一次
  上线），代价是中途重试无法收回已发出的半截文本，会以可见的
  `_[stream interrupted — retrying]_` 标记隔开（默认关闭）
- **完整遥测**：上下文用量环 + 缓存命中率 / TPS / 输入-输出-推理 token / 工具耗时 /
  轮次计数（`usage_update._meta` 携带全量明细）
- **图片支持（多模态）**：当 dsh 组合挂载了附件存储（dsh 0.1.1-rc.2+，`dsh-base`
  默认装配 `dsh-attachment-local`）时，会声明 `promptCapabilities.image` 并把粘贴/
  上传的图片持久化进 harness 附件存储——支持视觉的模型（如 `deepseek-v4-flash-vision-exp`）
  可按线序原生读取，图文交替不乱序。旧版栈（无附件存储）自动降级：不声明 image、
  收到图片 prompt 明确报错。

### 模型与权限

- **模型切换**：实时 `provider/model` 目录下拉（按 ACP 规范分组线格式）
- **推理强度**：`reasoning_effort` 下拉——仅当当前路由暴露可选 efforts 时出现；
  每个模型都会记住它上次使用的强度（按 profile 持久化），切回时自动恢复，
  首次切换的模型则回退到它自己的默认值——没有默认值时取第一个可选值，
  绝不出现空的 "unknown" 选择
- **权限预设**：read-only / workspace-write / full-access 三种会话模式
- **审批**：工具调用弹出原生 allow-once / reject-once 审批
- **Agent 预设**：每个会话的模型侧组合（工具 + 提示词段）来自 dsh agent-presets
  名册。`standard` 为完整编码 agent（默认），`minimal`（极简模式）只有裸 shell +
  文件编辑器，**不含** subagent/web/todo/plan 等工具——极简 agent 不会泄漏任何
  host 层工具；`code` 与 `cordis` 随 dsh CLI 附带，`~/.dsh/.agent-presets` 下你
  自己的预设也会自动出现。通过 `agent_preset` 配置项、`/preset` 命令或
  `DSH_ACP_PRESET` 环境变量（会话默认）选择；**仅空会话可切换**（还没跑过对话），
  历史记录永远不会横跨两套工具面

### Zed 深度集成

- **工具卡片**：折叠态即显示一行摘要——`Read <路径>`、shell 命令显示模型自己给出的意图描述
  （`description`，Codex 风格，展开可见完整命令）、`Search: <模式>`、
  `Fetch: <URL>` 等。卡片正文遵循 ACP 最佳实践：文件编辑渲染为真实 **diff 视图**、
  **bash/pwsh 命令渲染为真实终端卡片**（codex-acp 线格式：命令 + 输出 + 退出码
   pill 都在终端面板里，告别 raw-JSON 卡片）、其他执行器渲染为高亮代码块并在下方
  附输出、涉及文件以**可点击路径**呈现（点击直达）；
  `rawInput` / `rawOutput` 保留在展开区备查，按工具类型渲染图标，
  状态机为进行中 → 完成/失败
- **Zed 文件与终端**：`zed_read_text_file` / `zed_write_text_file` / `zed_terminal` 把
  文件编辑放进 Zed 的"编辑文件"区（diff + 接受/拒绝）、命令跑在 Zed 真实终端
- **原生表单提问**：`ask_user_question` → `elicitation/create` 表单，选项即点即答；
  选项带描述展示，每个带选项的问题附一个"自定义答案"输入框——选项都不合适时可自由输入，
  单选时自定义答案覆盖所选、多选时与所选并存（与 dsh 原生提问卡片语义一致）
- **Plan 面板**：plan mode 开关 → Zed 底部"规划中"状态条

### 会话

- **恢复与归档**：`session/load` 恢复历史线程（完整回放）；`session/list` /
  `session/delete` 管理线程归档（带标题、按更新时间排序）；标题实时推送
- **多根工作区**：`sessionCapabilities.additionalDirectories` 已声明，Zed 不再提示
  "This agent doesn't currently support multi-root workspaces"，而是把所有工作区根
  通过 `session/new` / `session/load` 传入。所有根都会写进系统提示词并在
  `session/list` 上回报；沙箱仍以主 `cwd` 为唯一可写根（见已知限制）

### 命令

- **Slash 命令**：输入 `/` 即可见命令列表（`available_commands_update`）：`/status`
  查看路由与遥测、`/model` 列出或切换模型、`/preset` 列出或切换 agent 预设
  （列表以等宽代码块排版，一眼全见），其余（`/compact` `/goal` `/permission`
  `/plan`…）直通 harness 命令注册表，全部**不经过模型 turn** 即时执行。所有
  userInvocable 技能也会作为命令广播，`/ask-matt`、`/code-review`、`/tdd` 等能被
  编辑器放行到达桥，技能正文按 dsh-tool-skill 的用户调用方式注入消息。斜杠命令
  旁粘贴的图片会作为命令附件随行（例如 `/goal` 目标的参考截图），与 Web 端
  composer 的提交方式一致

### MCP

- **MCP servers**：`session/new` 的 `mcpServers` 挂载任意 MCP server（stdio +
  streamable HTTP），工具以 `mcp__<server>__<tool>` 注入；失败的 server 不会拖垮会话

## 效果预览

在 Zed 的 AI Agent 面板中选择 **dsh-acp-enhanced** 后：

<img src="assets/screenshots/approval-config-context.png" width="560">

<img src="assets/screenshots/tool-cards-elicitation.png" width="560">

## 快速开始

本包遵循 dsh 官方插件规范（声明了 `dsh.bundle`），安装与官方组合包一致：**一条命令**
完成，自动初始化 profile、安装包、追加 bundle 层，全程无需手写 profile YAML。

### 安装（2 步）

**第 1 步：安装**（从 npm registry，无需下载源码）

```sh
dsh plugin --profile acp-enhanced add dsh-acp-enhanced
```

> 开发/改源码时用 `link:` 指向本地 checkout（改动实时生效）：
> `dsh plugin --profile acp-enhanced add "link:/absolute/path/to/dsh-acp-enhanced"`

**第 2 步：注册进 Zed**（在 `~/.config/zed/settings.json` 的 `agent_servers` 里注册；
Zed 会用极简 PATH 拉起 agent，因此用随附启动器 `scripts/dsh-acp-zed.sh` 定位
`node`/`dsh`）

> **启动器随包发布**，绝对路径取决于第 1 步的安装方式：
> - **npm 安装（默认）**：`$HOME/.dsh/profiles/acp-enhanced/node_modules/dsh-acp-enhanced/scripts/dsh-acp-zed.sh`。Zed 不会展开 `~` 或环境变量，请把 `$HOME` 换成你的用户目录（如 `/Users/you`）后写全绝对路径。
> - **`link:` 开发安装**：`<你的 checkout 路径>/scripts/dsh-acp-zed.sh`。

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
        "DSH_ACP_MODEL": "deepseek-v4-flash",     // 官方模型 id
        "DSH_ACP_PRESET": "standard"              // 可选：agent 预设 id（minimal / standard / code / cordis / 自定义）
      }
    }
  }
}
```

> 这两项 env 与包自带 patch 的缺省值一致，**省略也能工作**——显式写上只是让路由意图
> 一目了然。`DSH_ACP_PRESET` 在名册侧默认 `standard`；想让每个新会话从一开始就是
> 某个特定模式就设置它。API key 不必写进 Zed：存入 `~/.dsh/.credentials.yaml`
> （`DEEPSEEK_API_KEY`）由 dsh 凭据服务解析即可；启动脚本还会兜底继承正在运行的
> `dsh web` 进程的 key。

可选：固定面板默认项（都可随时在面板里改）：

```jsonc
"dsh-acp-enhanced": {
  // ...上面的 type/command/args/env...
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

> `<KEY_ENV_NAME>` 也可以省掉，把 key 存进 `~/.dsh/.credentials.yaml` 统一管理。

Zed 会热重载设置。打开 **AI Agent 面板**（`Cmd+Shift+A`）→ agent 选择器选
**dsh-acp-enhanced** → 输入第一条消息即可：回复实时流式返回，状态栏显示上下文用量，
面板顶部有 Model / Permission preset / Plan mode 配置项与三种模式，线程归档可恢复
历史会话。

本地验证（无需 Zed）：

```sh
node scripts/acp-client.mjs                    # 官方默认路由，无需 env；期望 ALL CHECKS PASSED
DSH_ACP_PROVIDER=... DSH_ACP_MODEL=... node scripts/acp-client.mjs   # 自定义路由时再传
```

### Web 搜索

bridge 自身不携带、也不推荐任何搜索 provider：模型侧 `web_search` 工具走 `web`
seam 的 `searchProvider`，往 profile 里挂任意 `ctx.web` provider 即可——带
`dsh.bundle` 的包用 `dsh plugin --profile acp-enhanced add <package>` 安装，普通包
走用户层 `insert` 挂载（见下节）。你的 dsh 部署里有哪些 provider 是 profile 层的
事，与 bridge 无关。

### 管理 profile 的插件

dsh-acp-enhanced 跑在**独立的 profile** 里——`acp-enhanced`（由上面的安装命令创建于
`~/.dsh/profiles/acp-enhanced/`），与 `dsh web` 背后的 `web` profile 完全隔离，
在这里增删改插件不会影响 web 侧的任何配置。

profile 的插件树由三层组合而成，后层修补前层：

1. **bundle 层**：profile `package.json` 的 `dsh.profile.bundles`——模板自带的
   `@deepseek-ai/dsh-base` 在前，随后是每个声明了 `dsh.bundle` 的已安装包（如
   `dsh-acp-enhanced`），按数组顺序排列。
2. **用户层**：`~/.dsh/profiles/acp-enhanced/cordis.patch.yml`——按 id 定位的行配置
   覆写、`disabled: true` 行禁用，以及 `insert` 挂载（无 `dsh.bundle` 的包——如手工
   挂载的自写 provider——就靠它装配）。
3. **临时覆盖**：`dsh --profile acp-enhanced --patch extra.yml`。

调整插件集：

```sh
dsh plugin --profile acp-enhanced add <package>     # 安装；声明 dsh.bundle 的包自动加入层栈
dsh plugin --profile acp-enhanced remove <package>  # 卸载；自动退出层栈
dsh plugin --profile acp-enhanced update [package]  # 更新一个/全部并 reconcile
dsh --profile acp-enhanced --dump-config             # 查看组合后的完整树（标注每行来自哪一层）
```

`dsh plugin` 本质是在 profile 目录里转发 pnpm，并在每次运行后按安装状态 reconcile
`dsh.profile.bundles`。两个值得知道的推论：

- **靠从 `bundles` 里删条目来禁用 bundle 是禁不住的**——包仍是已安装依赖，下一次
  `dsh plugin` 运行会原样加回来。想不禁载地禁用某一行，请在用户层按**行 id**（不是
  包名，id 可在 `--dump-config` 输出里查）定位：

  ```yaml
  - id: mnemon
    disabled: true
  ```

- **无 `dsh.bundle` 的包自身不会装配**——它只作为普通依赖安装（带一次性警告），需要
   自己在用户层 `insert` 挂载；要改已有行的配置，用 `- id: <行>` + `config:` 覆写——
   patch 条目是整行替换、不做合并。

改动在**下一个**进程生效：Zed 为每个 agent 线程拉起一个全新的
`dsh --profile acp-enhanced`，编辑 profile 后新开 agent 线程（或重启 Zed）即可。

## 兼容性

同一个桥可运行在 **0.1.0-rc.6** 至 **0.1.2-rc.1** 的每一代 harness 上。0.1.2 线重写了本桥消费的多个
API，桥在运行期同时吸收各代——不分叉、不加版本开关：

| API | ≤ 0.1.1-rc.2（旧代） | ≥ 0.1.2-alpha.2（projection 代） | 桥的做法 |
|---|---|---|---|
| 会话的运行中 preset | `resolveSessionPreset({header, events})` 导出 | 导出已移除；`agentPreset` session projection | 自行折叠事件日志（最后一个 `agent-preset/selected` 胜出、header 兜底）——两代语义一致 |
| preset 解析失败 | `UnknownPresetError` / `PresetMountError` | `RemoteError`，错误码 `agent-preset/*` | `isPresetClientError`：RemoteError 按 `isDSHRemoteError` + `code` 鸭子类型识别；旧类按 `presetId` 结构识别（绝不跨副本 `instanceof`） |
| `permissionPresets.current(x)` | `current(events)` | `current(session)`（经 `permissionState`） | `currentPermissionMode` 每次调用前探测服务实例 |
| 会话事件日志读取 | 同步 `session.events` 数组 | `session.events` 已移除（0.1.2-rc.1）；改为 `snapshotEvents()` / `ownEvents()` / `eventAt()` | `sessionEventsOf`：有 `snapshotEvents()` 用之，否则用活数组 |
| 注册表 `execute` 签名 | `execute(agent, line, signal)` | `execute(agent, line, images, signal)`（images 插在 line 与 signal 之间，0.1.1-rc.1 起） | `executeRegistryCommand` 按声明参数个数探测（`Remote` 装饰器不包裹方法） |
| `userQuestions` 注册 | `registerProvider({ask})` | `user-questions/request` Cordis waterfall（0.1.2-alpha.2 起） | 探测服务实例；waterfall 监听只应答本桥会话、其余经 `next()` 传递 |

两条不变量保证其安全性（openma 的 `deepseek-harness-acp` 适配器独立得出了同样结论）：**只值导入纯
helper**（`createUserMessage`、`ReasoningEffortId`、`SessionId`、`defineTool`…… 外来副本功能等价）；**服务的代际问题按服务实例探测回答**——决定服务代际的是启动它的 CLI，不是本包的依赖范围。`dsh-agent-presets`
按 *命名空间* 导入：0.1.2-alpha.1 删除了其命名导出，命名导入会在 ESM 链接期直接失败。

从干净依赖树校验两代：

```sh
node scripts/compat-check.mjs   # 分别安装 0.1.0-rc.6 与 0.1.2-alpha.2+ 两套，逐一导入本桥
```

### 开发检出：仓库锁定 CLI + 独立 home

启动器**从检出目录**（`link:` 安装）运行时，按以下顺序解析 dsh CLI：

1. `$DSH_PATH` —— 显式指定的 dsh 二进制，或其 `node_modules/.bin/dsh` 内含 dsh 的目录
2. 仓库锁定的 CLI —— `<repo>/node_modules/.bin/dsh`（本包的 `@deepseek-ai/dsh`
   devDependency，当前 0.1.2-rc.1）
3. 全局兜底 —— PATH / npx 缓存 / npm 前缀 里的 `dsh`（旧行为；未 `pnpm install` 的全新检出退化为它）

命中 (1) 或 (2) 时，profile 在**独立 home**（`DSH_ACP_HOME`，默认 `~/.dsh-acp`）下启动：dsh
每次启动都会把自身依赖闭包 heal 进 `$DSH_HOME/profiles/node_modules`——该目录被同 home 下所有
profile 共享、内容随最后启动的 CLI 翻转——因此第二个 CLI 代际不得与运行中的 `dsh web`
等共享 home。此路径永不触碰默认 home。harness 注入到子进程的 `DSH_HOME=$HOME/.dsh`
（dsh 会向每个 agent/工具进程导出它）会被识别并覆盖而非沿用；只有指向默认 home 之外的
`DSH_HOME` 才被尊重；确要将锁定 CLI 跑在默认 home 上，请显式设 `DSH_ACP_HOME=$HOME/.dsh`。

一次性引导独立 home（建**不含** `dsh-mnemon` 的 profile——它不支持 0.1.2-alpha harness——并逐字移植旧
profile 的用户层行、迁移凭据/设置、挂 0.1.2-alpha `standard` preset 所需的
`subagent-model-selection-settings` 宿主服务、关闭 DeepSeek 插件清单上报）：

```sh
scripts/init-acp-home.sh            # 幂等；重跑不会覆盖你的文件
```

两代 harness 都把会话持久化在 `$DSH_HOME/sessions/<slug>/<id>/session.jsonl.zstd`，且新代可读旧代日志（已验证：历史回放与 preset 折叠跨代工作）。因此旧线程只需把会话历史拷到新 home——`scripts/init-acp-home.sh` 会打印这条命令（或加 `--copy-sessions`）；默认不拷贝，因为默认 home 的目录里还有全部 web profile 会话。

## 故障排查

| 症状 | 处理 |
|---|---|
| `exec: dsh: not found`（status 127） | 用随附 `dsh-acp-zed.sh` 启动器（自定位 node/dsh） |
| `no API key for provider route "xxx"` | 写入 `~/.dsh/.credentials.yaml`，或在 agent_servers 里设 `env.DEEPSEEK_API_KEY` |
| `SyntaxError: ... 'PresetMountError'` | 你在 0.1.2-alpha 宿主上运行 0.7.0 之前的桥副本——升级本包 |
| `modelSelectionSettings requires ... in the Host scope` | 0.1.2-alpha 宿主缺少 `subagent-model-selection-settings` 行——运行 `scripts/init-acp-home.sh`（或按脚本模板在用户层补 insert 行） |
| 宿主升级后旧线程变空白 | 会话存放在 `$DSH_HOME/sessions/<slug>/`；把旧 home 的历史拷进独立 home（`scripts/init-acp-home.sh --copy-sessions`）即可继续 |
| 无法切换模型 | 保存的 `reasoning_effort` 默认值（或会话当前 effort）被带到新模型上。0.3.6 起本桥按模型记住上次使用的强度（随 profile 持久化）：不被新模型支持的 effort 会被该模型记忆值替换——没有记忆则回退其默认值，再无默认则取第一个可选值，既不会切换失败也不会出现 "unknown"。另检查：是否选到了不可路由的"幽灵 provider"——本桥默认过滤（只广播 `config.provider` 的模型），确认 profile 的 provider 指向真实路由 |
| 上下文用量不显示 | 选到了不可路由的"幽灵 provider"；本桥默认过滤（只广播 `config.provider` 的模型），确认 profile 的 provider 指向真实路由 |
| 需要详细诊断 | `ACP_DEBUG=1 dsh --profile acp-enhanced`（stderr 生命周期 trace） |

## 开发

```sh
node scripts/compat-check.mjs         # 跨代链接检查（0.1.0-rc.6 + 0.1.2-alpha.2+ 临时安装）
node scripts/acp-client.mjs           # 端到端冒烟（需要 API key）
node scripts/acp-client-tools.mjs     # 客户端工具测试（模拟 Zed 的 fs/terminal/elicitation/plan）
node scripts/acp-mcp-test.mjs         # MCP 挂载测试（无模型调用）
node scripts/acp-smoke-keyless.mjs    # keyless 冒烟（CI 用）
node scripts/acp-resume-test.mjs      # 会话恢复测试
node scripts/codec-image-test.mjs     # 图片编解码单元测试（无网络，假 store）
node scripts/terminal-codec-test.mjs  # 终端卡片编解码单元测试（无网络）
node scripts/acp-image-e2e.mjs        # 图片能力端到端（vision 模型段需 API key）
scripts/init-acp-home.sh              # 引导/刷新独立 home（~/.dsh-acp）
```

harness 包的 devDependency 与锁定的 `@deepseek-ai/dsh` CLI 声明相同的 range（如
`^0.1.2-rc.1`），让仓库依赖树与全新 CLI 安装解析出同一个连贯家族——在此用精确 patch
锁定、与 CLI 的 range 闭包混存会得到分裂闭包（同名包两个版本），profile 启动时报
export-not-found。改这些锁定后务必整体重建 lockfile（`rm -rf node_modules pnpm-lock.yaml
&& pnpm install`）：原地增量安装既会留下污染 profile heal 的残留 store 条目，还会保留
lockfile 里的陈旧 peer 解析——从 0.1.2-alpha.2 原地升到 0.1.2-rc.1 时，rc.1 各包的
snapshot 里仍挂着 `dsh-session-persistence@0.1.2-alpha.3`（旧代 peer），boot 与
session/new 全部通过，直到第一个 turn 才以 `TypeError: Cannot read properties of
undefined (reading 'length')`（PersistenceCoordinator）崩掉。`pnpm-workspace.yaml` 放行
了 CLI 闭包的构建脚本（node-pty prebuild、koffi）——仓库 CLI 启动 profile 时它们就是
运行时依赖。

## 已知限制

不支持音频附件（不声明 audio 能力）、文本默认按块粒度流式（`streamDeltas: true`
可切换为逐 token 流式，见「特性」）、每会话同时一个 in-flight prompt。MCP 支持 stdio
与 streamable HTTP（不声明 legacy SSE / `acp` 传输）。
`session/close` / `session/fork` / `session/resume` 未实现（不声明能力，合规客户端
不会调用）；`session/delete` 因 dsh 持久化无官方删除 API，采用直接删除后端目录的方式。

多根工作区已声明、模型可见所有根，但 dsh 沙箱策略每会话只解析**一个可写根**（主
`cwd`，即 `session.header.cwd`），本地沙箱也只为该根开放写权限。读操作在所有根均可
用；`workspace-write` 下对附加根的写入会先被拒绝、需升级/批准，`danger-full-access`
下所有根均可写。真正的多根写支持需改 dsh 核心（`dsh-sandbox-policy` /
`dsh-sandbox-local` 需要根列表而非单根）。

Agent 预设接管了模型侧相关行：自带 `cordis.patch.yml` 会禁用 preset 拥有的 dsh-base
行（tool-bash/fs/subagent/todo/web/…——与官方 dsh-web-app/tui 清单逐行一致，仅少
`hmr`），并挂载 `agent-presets` 名册（默认 `standard`；`code`/`minimal`/`cordis`
随 dsh CLI 附带，`~/.dsh/.agent-presets` 下的自定义预设目录自动收录）。bundle 自带
patch 会自动装配（package.json `dsh.bundle.patch`）——**不要**把它复制进 profile
的用户层 `cordis.patch.yml`，否则 loader 在启动时因重复 entry id 拒绝装配。**升级**
一个已有自定义用户层 patch 的 profile 时，用户层只保留你自己的定制行（例如
acp-enhanced 行的 `includeAllProviders: true`，同时 restate provider/model/preset——
patch 条目是整体替换、不做合并）。升级前创建的会话恢复时会落到名册默认预设上。
