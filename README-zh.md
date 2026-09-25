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
- **图片支持（多模态）**：当 dsh 组合挂载了附件存储（`dsh-base` 默认装配
  `dsh-attachment-local`）时，会声明 `promptCapabilities.image` 并把粘贴/
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
- **Agent 预设**：每个会话的模型侧组合（工具 + 提示词段）来自 dsh agent-preset
  名册。`standard` 为完整编码 agent（默认），`minimal`（极简模式）只有裸 shell +
  文件编辑器，**不含** subagent/web/todo/plan 等工具——极简 agent 不会泄漏任何
  host 层工具；`ptc` 与 `cordis` 随 dsh CLI 附带。**自建预设写在 profile 里**
  （见「自建 preset」）——dsh 0.1.7 起不再扫描 `~/.dsh/.agent-presets`。
  通过 `agent_preset` 配置项、`/preset` 命令或
  `DSH_ACP_PRESET` 环境变量（会话默认）选择；**仅空会话可切换**（还没跑过对话），
  历史记录永远不会横跨两套工具面。配置了一个本名册已没有的 preset 不会把面板弄死：
  空会话会改用名册默认值组合，并在 stderr 说明。

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

- **恢复与归档**：`session/load` 恢复历史线程（完整回放）；`session/list` 列出线程
  归档（带标题、按更新时间排序）；`session/close` 释放内存中的会话记录，之后的
  `session/load` 会从持久化日志完整恢复；标题实时推送。`session/delete` **有意不广播**——
  harness 未声明公开的持久化删除接口（见「兼容性」）
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

**需要 `dsh ≥ 0.1.5-rc.2`**（`npm install -g @deepseek-ai/dsh@0.1.5-rc.2`，或下方 peer 范围内的
任意版本）：本桥在每条受支持线（0.1.5-rc.2 直到 0.1.7）上只消费同一套已声明表面，不在运行期
探测更老的代际。

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
node <pkg>/scripts/acp-doctor.mjs              # bundle + 版本、peer 范围，并真实启动一次
node scripts/acp-client.mjs                    # 仅限仓库检出：完整 ACP 端到端，期望 ALL CHECKS PASSED
DSH_ACP_PROVIDER=... DSH_ACP_MODEL=... node scripts/acp-client.mjs   # 自定义路由时再传
```

### Web 搜索

bridge 自身不携带、也不推荐任何搜索 provider：模型侧 `web_search` 工具走 `web`
seam 的 `searchProvider`，往 profile 里挂任意 `ctx.web` provider 即可——带
`dsh.bundle` 的包用 `dsh plugin --profile acp-enhanced add <package>` 安装，普通包
走用户层 `insert` 挂载（见下节）。你的 dsh 部署里有哪些 provider 是 profile 层的
事，与 bridge 无关。

代价要说清楚：provider bundle 位于**每个 ACP 线程的启动路径**上，一旦加载失败整个
profile 都会挂掉，Zed 侧表现为无输出的卡死。若插件只是新增模型侧工具，优先放进 preset
composition（见[保持 profile 最小化](#保持-profile-最小化)）；而必须配置宿主 `web` 行的
provider 只能待在宿主组合（即 profile）里——那就明确接受这一风险，并在每次改动后重跑
doctor。

### 管理 profile 的插件

dsh-acp-enhanced 跑在**独立的 profile** 里——`acp-enhanced`，位于
`~/.dsh/profiles/acp-enhanced/`，与 `dsh web` 同处一个 dsh home。被隔离的是**组合**
本身，所以在
这里增删改插件不会影响 web 侧的配置，而凭据、设置、会话与 preset 仍是共享的。

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

#### 保持 profile 最小化

profile 是一个**单一故障域**：`cordis-plugin-loader` 会等待每个条目，并把第一个 reject
原样抛出，因此只要有一行加载失败，整棵插件树就会中止——进程甚至可能先正常应答 ACP
`initialize` 再立刻退出，客户端只会表现为无输出的卡死，而不是报错。

把 `dsh.profile.bundles` 控制在这两行以内，它们的版本不可能与启动它的 CLI 不匹配：

```json
"bundles": ["@deepseek-ai/dsh-base", "dsh-acp-enhanced"]
```

`@deepseek-ai/dsh-base` 随 CLI 一起发布，版本天然等同于启动它的 CLI；其他任何 bundle 都是
第三方，其依赖闭包可能漂移。额外插件请挂到「坏了只废掉一个 preset」的位置：

- **只新增模型侧工具/命令的插件** → 把行写进某个 preset composition。**0.1.7 线**上是
  profile 用户层里的一条 `@deepseek-ai/dsh-agent-preset` 行（见「自建 preset」）；
  0.1.5/0.1.6 上是 `$DSH_HOME/.agent-presets/<id>/` 目录（组合写 `agent.cordis.yml`，
  选择器里的名称写 `preset.yml`）。两种方式下 ACP 的 `agent_preset` 下拉都会列出它；
  组合加载失败的 preset 只会被标记为 broken 并从列表里剔除，不会拖垮进程。
- **需要配置宿主服务的插件**（例如要覆写宿主 `web` 行 `searchProvider` 的搜索 provider）
  → 它属于宿主组合，也就是 profile。这是有意的取舍：接受启动路径上的风险，并在每次改动
  后重跑 doctor。

改动后先验证再信任：

```sh
node <pkg>/scripts/acp-doctor.mjs          # bundle 与版本、peer 范围，并真实启动一次
dsh --profile acp-enhanced --dump-config   # 每一行来自哪一层
```

## 兼容性

同一个桥只对应**一套已声明的 harness 表面**：**dsh ≥ 0.1.5-rc.2**（peer 范围
`^0.1.5-rc.2 || ^0.1.6-alpha.1 || ^0.1.7-alpha.1`）。该范围内的**三条线**每次 CI 都会做真实启动
验证——握手、profile settle 与真实 `session/new`——另有跨代链接检查。桥只消费 harness
**已声明**的表面：`docs/capability-seams.md` 里的服务、`docs/event-producer-consumer.md` 里的
事件、以及已发布包的导出。`scripts/api-surface-check.mjs` 会对其他一切报错（CI 的阻塞步骤）。
这里没有特性嗅探，也没有代际矩阵：0.1.7 只需要两处适配——一处**成员探测**
（`presets.resolveMountable` 在 0.1.6 及以前是私有成员、0.1.7 直接删除，改用 `resolve()` 加该行
自身的 `broken` 判定），以及 `cordis.patch.yml` 里一行**代际门控行**（agent-preset roster 被上游
重新打包，门控读取正在启动的安装自身 manifest 的版本，见下）。缺少任一者时会回退到旧形状，
两条路径都不会让启动失败。

### 支持策略

| 桥版本 | 支持的 dsh 线 | 变化 |
|---|---|---|
| **0.9.1** | `^0.1.5-rc.2 \|\| ^0.1.6-alpha.1 \|\| ^0.1.7-alpha.1` | 支持 0.1.7：agent-preset roster 上游换包，桥同时下发两种形状（代际门控行），并把四个 preset 声明内联进来 |
| **0.9.0** | `^0.1.5-rc.2 \|\| ^0.1.6-alpha.1` | 只消费已声明表面；下限 0.1.5-rc.2；移除 `session/delete` |
| 0.8.x | `^0.1.0-rc.6 … ^0.1.6-alpha.1`（未发布） | 0.1.3+ 实时 seam；0.1.5 持久化 handle API |
| 0.7.x 及更早 | ≤ 0.1.2-rc.1 | 运行期同时探测两代 |

这张表背后的规则：

- **新的 dsh API 线对应一次新的桥发布，而不是把运行期探测写得更宽。** 0.7.x 正是靠探测吞下
  0.1.1 → 0.1.5，也正是它悄悄腐烂的原因。0.1.7 属于重新打包而非新的 API 线，所以 0.9.1 用
  一个 patch 版本吸收它——所需的探测只有一次成员检查，而不是一张代际矩阵。
- **下限只随桥的 minor 移动，且绝不静默**：CLI 低于范围时启动器会在启动前告警，doctor 会以
  `RESULT FAIL — CLI too old` 停下。
- **放弃某条线的方式是发布一个明确这么说的桥**；旧线留在 `feat/dsh-0.1.3-plus-support` 分支上，
  供无法迁移的用户使用。
- **在下一条线发布之前就盯住它**：定时 `canary` workflow 会安装 `alpha` dist-tag 并跑表面守卫、
  链接检查与启动冒烟，因此破坏性变更表现为 canary 变红，而不是用户侧故障。

### 0.9.0 的破坏性变更

| 变更 | 影响 | 中招了怎么办 |
|---|---|---|
| 下限提升到 dsh **≥ 0.1.5-rc.2** | 更老的宿主在挂载期就以具名错误失败，而不是静默降级 | 升级 CLI（`npm install -g @deepseek-ai/dsh@0.1.5-rc.2`），或留在 `feat/dsh-0.1.3-plus-support` 分支（≤ 0.1.2-rc.1） |
| **移除 `session/delete`** | 不再广播该能力，也永不删除已持久化的会话——harness 未声明公开的持久化删除接口 | 文件仍在 `$DSH_HOME/sessions/<slug>/<id>/`，确有需要请手工删除。上游已有 issue 追踪公开删除 API |
| 启动器**不再改写 `DSH_HOME`** | ACP profile 在启动器所处的 home 中启动（`${DSH_HOME:-$HOME/.dsh}`），与 `dsh web` 共享凭据、设置、会话与 preset | 之前用的是隐式隔离的 `~/.dsh-acp`？在 Zed 的 `agent_servers.env` 里显式指回它（`"DSH_HOME": "<home>/.dsh-acp"`），或迁回共享 home |
| `assistant/chunk` seam 移除 | 实时流只剩 `agent/assistant-stream`（下限已覆盖该代） | 升级 CLI；完全不发流的宿主仍由已提交的 `assistant/message` 兜底 |

### 0.9.1 的变更（增量：支持 dsh 0.1.7）

`dsh` 0.1.7 **重新打包了 agent-preset roster**。`@deepseek-ai/dsh-agent-presets`（把
standard/ptc/minimal/cordis 组合打进去、并作为只读 `system` root 前置的那个包）在 0.1.7 线
完全没有发布；该线改为 `@deepseek-ai/dsh-agent-preset-registry` 加上每个 preset 一条
`@deepseek-ai/dsh-agent-preset` 声明行。三处表面发生了位移，桥在不放弃任何受支持线的前提下
全部吸收：

| 表面 | ≤ 0.1.6 | ≥ 0.1.7 | 桥的做法 |
|---|---|---|---|
| roster 行 | `@deepseek-ai/dsh-agent-presets` + `config.default` | `@deepseek-ai/dsh-agent-preset-registry` + `config.default` | 两行都下发，各自由代际门控 `disabled`，因此恰好只有一行激活（两者提供同一个服务名，第二次 `provide` 会抛错） |
| 随包 preset | 打在 roster 包内（`system` root） | 每个 preset 一条 `@deepseek-ai/dsh-agent-preset` 声明，谁需要谁下发（`@deepseek-ai/dsh-web-app` 以 `presets/*.patch.yml` 层下发） | 四条声明按 web-app 组合包原样（MIT，0.1.7-rc.2）内联进 `cordis.patch.yml`，并补回旧 roster 每个 preset 的 `preset.yml` 里的展示元数据——0.1.7 对内置 id 不再发布 `name` |
| 可挂载解析 | 私有 `presets.resolveMountable(id)` | `presets.resolve(id)` 会**故意**返回损坏行；各挂载路径在解析之后才拒绝 | 成员探测：有 `resolveMountable` 就用它，否则 `resolve()` 加该行自身的 `broken` 理由 |

门控读的是**正在启动的这套安装自身的身份**：打开 `profileContext.installAnchor`（即运行中 CLI
自己的 `package.json`），用它的 `version` 决定形状（registry roster 从 0.1.x 线的 0.1.7 开始）。
0.1.5 上根本没有 `profileContext`，这本身就已经是「≤ 0.1.6」的答案；任何读不到、解析不了、
归类不了的情况都保留旧行。`!!js` 表达式以 `with (ctx)` 在 loader context 加全局上求值，因此版本
只能「读」而不能「问」——作用域里没有任何东西暴露它。

最初的做法是解析器探测（`ctx.pluginPackages.packageOf(…, <profile URL>)`），它对 `link:`
安装的桥是**错的**：那种解析从 profile 出发，能够触达*被 link 的检出目录*自己的依赖树，于是
一个带着 0.1.7 包的开发检出会让 0.1.6 宿主误以为 registry 存在——它禁用了本来可用的 roster 行，
随后五个 0.1.7 行全部导入失败（`agent-preset-registry: failed to import`）。安装锚点没有这种
触达范围：它是运行中 CLI 内部的固定路径，与 profile、link 目标、以及布局（npm 扁平或 pnpm 严格）
都无关。这里没有任何一处能让启动失败——最坏情况就是 0.1.7 在本版之前本来就有的优雅降级（只是
不提供 `agent_preset`）。

`DSH_ACP_PRESET`、`agent_preset` 配置项与 `/preset` 在每条线上行为一致。

#### 自建 preset

0.1.7 起名册变成了由声明行喂给 registry：它**不扫描任何用户目录**，因此
`$DSH_HOME/.agent-presets/<id>/` 不再被收录，profile 默认值指向这类 preset 时每个
`session/new` 都会以 `Unknown agent preset: <id>` 失败。把预设写在 registry 真正读的地方：

```yaml
# ~/.dsh/profiles/acp-enhanced/cordis.patch.yml
- insert:
    - id: preset-my-agent
      name: '@deepseek-ai/dsh-agent-preset'
      config:
        id: my-agent              # DSH_ACP_PRESET / 下拉框使用的 id
        name: 我的 agent            # 可选；0.1.7 只本地化内置 id 的展示名
        description: …            # 可选
        order: 5                  # 可选
        plugins:                  # 整套组合，形状同官方 preset
          - id: persona
            name: '@deepseek-ai/dsh-persona'
```

官方 `presets/*.patch.yml` 层（以及本桥内联的那四条）遵循的两条规则，因为 preset 就是
loader 要挂载的数据：

- **整装重述。** preset 行携带完整的 `config.plugins` 列表——不存在「只 patch 已有 preset
  的某个子行」——所以 fork `standard` 必须按新代的行集重新 baseline（0.1.7 把
  `workflow-worker-thread` 换成了 `workflow-ptc`）。差异只在配置（模型路由、审批、沙箱）时
  优先放在宿主面：只有**工具集**不同才值得 fork。
- **默认值写在当代读它的地方。** 0.1.7 上是 `agent-preset-registry.config.default`，
  ≤ 0.1.6 上是 `agent-presets.config.default`（或 Settings 里的 `selectedDefault`）。
  profile 指向一个已不存在的 preset 时：*空*会话仍可用（改用名册默认值并在 stderr 说明），
  但**恢复**一个跑过它的会话仍会失败——把另一套工具面接到已有转录上，正是「仅空会话可切换」
  这条规则要防的事。

### 从已发布的 ≤ 0.7.0 升级

npm 上的 `latest` 是 **0.7.0**，属于 0.1.3 之前的 API 线，因此桥和 CLI **必须一起动**——只升一半，
两种顺序都会坏：

| 顺序 | 结果 |
|---|---|
| 先升 CLI，桥留在 0.7.0 | profile 能启动、`initialize` 也成功，但**每个 `session/new` 都失败**（Internal error：`tool-subagent: modelSelectionSettings requires … in the Host scope`）。我们无法给出任何提示——那份桥代码已经装好了；而且 0.7.0 既没有 `agent/assistant-stream` seam 也没有 `assistant/message` 兜底，回复同样渲染不出来 |
| 先升桥，CLI 留在旧版 | profile 在加载期就死（`… subpath './model-selection-settings' is not defined by "exports"`）。启动器会在它**之前**向 stderr 告警，`scripts/acp-doctor.mjs` 则以 `RESULT FAIL — CLI too old` 直接停下 |
| 两者一起升 | 受支持的状态 |

升级清单：

1. `npm install -g @deepseek-ai/dsh@0.1.5-rc.2`（或上面 peer 范围内的任意版本）。
2. `dsh plugin --profile acp-enhanced add dsh-acp-enhanced@0.9.1`。升级桥是显式动作：profile 里的依赖
   是对 0.x 的 caret，所以 `dsh plugin update` **不会**自行把你带到新的 minor。
3. 以前是从检出目录启动、或设过 `DSH_PATH`？旧启动器会自行切到 `~/.dsh-acp`，现在不会了。请在 Zed 的
   `agent_servers.env` 里设 `DSH_HOME=<那个 home>`，或在默认 home 里重建 profile。启动器若在那里
   发现 profile，会主动提示。
4. 以前照旧 README 在 profile 用户层里塞过 `subagent-model-selection-settings`？把它删掉：现在由桥的
   patch 提供该行，重复 id 会让启动中止。`scripts/init-acp-home.sh` 会自动清理；启动器会告警，doctor
   会点名该 id。
5. 确认 profile 里的第三方 bundle 支持 0.1.5（`dsh-free-search` ≥ 0.4.24 已验证）——profile 是单一故障域。
6. 重启 Zed（或新开一个 agent 线程）；先用 `node <pkg>/scripts/acp-doctor.mjs` 验证整条链路（它现在连
   开线程都会实测）。

### 一个 home 只跑一个 CLI 代际

`$DSH_HOME/profiles/node_modules` 是同 home 下所有 profile 共享的**同一个**依赖闭包，
dsh 每次启动都会把它 heal 成最后启动的那个 CLI。因此：

> 这是 **0.1.5 线**的行为。到 0.1.6-alpha.2 及之后，这个共享闭包已完全不存在（harness 从 CLI
> 自身的安装位置解析；profile 的 `node_modules` 只放外部插件），所以启动器的漂移检查是「按线」
> 的，路径消失时会静默跳过。



- **不要让两个 CLI 代际同时跑在一个 home 下。** 第二次启动会在第一个进程运行期间翻转闭包，
  那个进程随后会惰性地解析到不匹配的模块。启动器会把闭包里的 `dsh-agent` 版本与即将启动的
  CLI 对比，不一致时向 **stderr** 告警——遇到这种启动后，请重启该 home 下其他 dsh 进程
  （`dsh web` 等）。
- **逃生阀是 CLI，不是 home。** 用 `DSH_PATH=<dsh>`（或下面的仓库锁定）指定启动哪个 dsh：
  启动器只决定*用哪个 dsh*，绝不决定*用哪个 home*。

当前解析结果随时可查：

```sh
node scripts/compat-check.mjs   # 仅限仓库检出：分别安装 0.1.5-rc.2、0.1.6-alpha.2、0.1.7-rc.2 三套，逐一导入本桥
node <pkg>/scripts/acp-doctor.mjs   # CLI 与闭包版本、bundle 列表，并真实启动一次（随包发布）
```

### 开发检出：仓库锁定 CLI + 共享 home

启动器**从检出目录**（`link:` 安装）运行时，按以下顺序解析 dsh CLI：

1. `$DSH_PATH` —— 显式指定的 dsh 二进制，或其 `node_modules/.bin/dsh` 内含 dsh 的目录
2. 仓库锁定的 CLI —— `<repo>/node_modules/.bin/dsh`（本包的 `@deepseek-ai/dsh`
   devDependency，当前 0.1.7-rc.2）
3. 全局兜底 —— PATH / npx 缓存 / npm 前缀 里的 `dsh`（未 `pnpm install` 的全新检出退化为它）

命中任何一个，profile `acp-enhanced` 都在**启动器所处的 home**（`${DSH_HOME:-$HOME/.dsh}`）中启动。
home 永不被改写。若想让桥跑在自己的依赖闭包上，请另建一个 home 并显式指过去：

```sh
DSH_ACP_HOME=~/.dsh-acp scripts/init-acp-home.sh   # 可选、幂等：创建并填充一个独立 home
# 然后在 Zed 的 agent_servers env 里：  "DSH_HOME": "/Users/you/.dsh-acp"
```

独立 home 是明确的可选项，不是默认值：profile 必须存在于启动器实际使用的 home 里，否则启动器
会以 127 退出，并打印出创建它的那条 `dsh plugin … add link:` 命令。`init-acp-home.sh` 会逐字移植旧
profile 的用户层行、复制凭据/设置、关闭 DeepSeek 插件清单上报，并从用户层清掉遗留的
`subagent-model-selection-settings` 行——该宿主行现在由 bridge 的 bundle patch 插入，再留一份会以
`duplicate loader entry id` 中止启动。

两种 home 都把会话持久化在 `$DSH_HOME/sessions/<slug>/<id>/session.jsonl.zstd`；默认不在 home 之间
拷贝任何东西，因为默认 home 的目录里还有全部 web profile 会话。迁移既有环境时请加
`--copy-sessions`（或直接执行脚本打印的 `rsync`）。

## 故障排查

先跑 doctor：它会完全按 Zed 的方式启动一次 profile，并指出失败层、出问题的 bundle 与修法。

```sh
node <pkg>/scripts/acp-doctor.mjs              # 已安装副本
node scripts/acp-doctor.mjs                    # 仓库检出（npm run doctor）
node <pkg>/scripts/acp-doctor.mjs --profile <name> --home <dsh-home> --timeout 60000
```

它会打印 CLI 与版本、home、profile、每个 bundle 及其版本、支持的 peer 范围与共享闭包版本，
然后把启动失败归入三层之一：

| 层 | `dsh` stderr 里的特征 | 含义 | 修法 |
|---|---|---|---|
| **link-time** | `does not provide an export named …`、`SyntaxError: The requested module …` | 启动的 CLI 闭包无法满足本桥的某个 import | 见 doctor 的 `LAYER link-time`：对齐代次——重启该 home 下其他 dsh 进程（共享闭包会愈合到最后启动的那个 CLI），或用 `DSH_PATH=<匹配的 dsh>` 锁定本启动器 |
| **mount-time** | `failed to apply loader entry …`、`… requires … in the Host scope`、`duplicate loader entry id: …` | loader 拒绝了某一个条目并向上抛出，整棵插件树因此中止 | doctor 会打印 `SUBJECT <条目> (<模块>)`——补装缺失模块、在用户层禁用该行（`- id: <条目>` + `disabled: true`），或把 `dsh.profile.bundles` 收敛为 `@deepseek-ai/dsh-base` + `dsh-acp-enhanced`；若为重复 id，请从用户层删除该行（它归 bundle patch 所有） |
| **run-time** | 握手成功后出现 `… is not a function` | 桥调用到了该 CLI 代次不提供的 harness 服务方法 | `npm install -g @deepseek-ai/dsh@<支持范围内的版本>`（见[兼容性](#兼容性)） |

启动器在 Zed 启动过程中会把同样三类特征翻译到 **stderr**（stdout 是 ACP 协议线），
所以 agent 日志里已经带有失败层与修法。

| 症状 | 定位 | 处理 |
|---|---|---|
| Zed 卡死无输出、线程始终不应答 | `node <pkg>/scripts/acp-doctor.mjs` | 会打印 `BOOT FAILED` 与 `LAYER`/`SUBJECT`/`FIX`，照 `FIX` 做即可。先应答 `initialize` 再立刻退出的 profile 也会被如实报出 |
| `exec: dsh: not found`（status 127） | `which dsh` | 用随附 `dsh-acp-zed.sh` 启动器（自定位 node/dsh），或安装 CLI |
| `no API key for provider route "xxx"` | `ls -l $DSH_HOME/.credentials.yaml` | 写入 `~/.dsh/.credentials.yaml`，或在 agent_servers 里设 `env.DEEPSEEK_API_KEY` |
| `SyntaxError: … 'PresetMountError'` | agent 日志里的桥版本 | 你在 0.1.5 宿主上跑 0.9.0 之前的桥副本——升级本包 |
| `modelSelectionSettings requires … in the Host scope` | `dsh --profile acp-enhanced --dump-config \| grep subagent-model-selection` | `standard` preset 需要的宿主行缺失——该行由 bridge 的 bundle patch 提供，请重装/升级 bridge（`dsh plugin --profile acp-enhanced add dsh-acp-enhanced`），并检查用户层没有把它 `disabled: true` |
| `duplicate loader entry id: <行>` | doctor 会打印 `LAYER mount-time` 与该 id | 两层都插了同一行。请从 profile 用户层（`$DSH_HOME/profiles/acp-enhanced/cordis.patch.yml`）删掉它——这类宿主行归 bundle patch 所有；`scripts/init-acp-home.sh` 会自动清掉遗留的 `subagent-model-selection-settings` 副本 |
| 宿主升级后旧线程变空白 | `ls $DSH_HOME/sessions` | 会话存放在 `$DSH_HOME/sessions/<slug>/`；把旧 home 的历史拷进来（`scripts/init-acp-home.sh --copy-sessions`）即可继续 |
| 无法切换模型 | `ACP_DEBUG=1 dsh --profile acp-enhanced`，然后尝试切换 | 携带的 `reasoning_effort` 在目标模型上不受支持：本桥按模型记住上次使用的强度（随 profile 持久化），会回退到该模型默认值而不是让切换失败。另检查路由是否真实——幽灵 provider 会被过滤，只广播 `config.provider` 的模型 |
| 上下文用量不显示 | 线程里执行 `/status` | 选到了不可路由的"幽灵 provider"；确认 profile 的 provider 指向真实路由 |
| 轮次以 usage 结束但**面板没有回复文本**（空白） | `ACP_DEBUG=1`，看是否有 `agent/assistant-stream frame=chunk` | 0.9.0 起唯一的实时 seam 是 `agent/assistant-stream` 帧，某个 step 完全没有上线文本时由已提交的 `assistant/message` 兜底。有帧却无文本 = 客户端渲染问题；完全没有帧 = 正在走兜底路径（桥太旧就升级） |
| 升级 dsh 后报 `Unknown agent preset: <id>` | `ls $DSH_HOME/.agent-presets` 与 profile 的 `cordis.patch.yml` | 该 preset 已不在名册里——0.1.7 起不再扫描 `$DSH_HOME/.agent-presets`。把它改成一条 `@deepseek-ai/dsh-agent-preset` 声明行（见「自建 preset」）；0.9.1 下*空*会话会先用名册默认值打开（stderr 有说明），但恢复已跑过它的线程在补上行之前仍然失败 |
| profile 以前有的能力静默消失（例如 `web_search`） | `node <pkg>/scripts/acp-doctor.mjs`——降级启动会打印 `DEGRADED <n> loader entries never activated` 并列出条目名 | 某个 entry 导入失败不会拖垮 profile，它只是不存在。给这条 dsh 线升级该 bundle——`dsh-free-search` 在 0.1.7 上需要 ≥ 0.4.39，因为 0.4.24 import 的 `SettingsProvider` 已被 `dsh-settings` 删除——或直接移除它 |
| 改了插件却不生效 | profile `cordis.patch.yml` 的 mtime | 改动只在**下一个**进程生效：新开 agent 线程（或重启 Zed） |
| 需要详细诊断 | — | `ACP_DEBUG=1`（stderr 生命周期 trace）与 `ACP_LOG=/tmp/acp.jsonl`（逐事件 JSONL，带耗时） |

## 开发

```sh
pnpm install                          # 安装开发依赖（仓库锁定 CLI 与测试脚本）
node scripts/compat-check.mjs         # 支持线上的链接检查（0.1.5-rc.2 / 0.1.6-alpha.2 / 0.1.7-rc.2 临时安装）
node scripts/api-surface-check.mjs    # 公开表面守卫：不得使用未声明的 harness API（CI 阻塞步骤）
node scripts/pack-check.mjs           # 包完整性：入口文件、权限位、所引用文件是否都随包发布（CI 阻塞步骤）
node scripts/acp-client.mjs           # 端到端冒烟（需要 API key）
node scripts/acp-client-tools.mjs     # 客户端工具测试（模拟 Zed 的 fs/terminal/elicitation/plan）
node scripts/acp-mcp-test.mjs         # MCP 挂载测试（无模型调用）
node scripts/acp-smoke-keyless.mjs    # keyless 冒烟（CI 用）
node scripts/acp-resume-test.mjs      # 会话恢复测试
node scripts/codec-image-test.mjs     # 图片编解码单元测试（无网络，假 store）
node scripts/terminal-codec-test.mjs  # 终端卡片编解码单元测试（无网络）
node scripts/replay-order-test.mjs    # 重放/回退的分块顺序：思考块先于它产出的回复（无网络）
node scripts/acp-image-e2e.mjs        # 图片能力端到端（vision 模型段需 API key）
node scripts/acp-message-fallback-test.mjs  # 实时 seam + assistant/message 回退：seam 确实触发且回复恰好到达一次
node scripts/acp-launcher-test.mjs    # 启动器契约：home 不被改写、代次漂移告警、启动失败翻译
node scripts/acp-doctor.mjs           # 真实启动一次 profile，指出失败层与出问题的 bundle
scripts/init-acp-home.sh              # 可选：引导**独立** home（启动器不会自行切过去）
```

harness 包的 devDependency 与锁定的 `@deepseek-ai/dsh` CLI 声明相同的 range（如
`^0.1.7-alpha.1`），让仓库依赖树与全新 CLI 安装解析出同一个连贯家族——在此用精确 patch
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
`session/fork` / `session/resume` 未实现（不声明能力，合规客户端
不会调用）。`session/delete` 同样不广播：harness 未声明公开的持久化删除接口，因此本桥
永不删除已持久化的会话（见「兼容性」）。

多根工作区已声明、模型可见所有根，但 dsh 沙箱策略每会话只解析**一个可写根**（主
`cwd`，即 `session.header.cwd`），本地沙箱也只为该根开放写权限。读操作在所有根均可
用；`workspace-write` 下对附加根的写入会先被拒绝、需升级/批准，`danger-full-access`
下所有根均可写。真正的多根写支持需改 dsh 核心（`dsh-sandbox-policy` /
`dsh-sandbox-local` 需要根列表而非单根）。

Agent 预设接管了模型侧相关行：自带 `cordis.patch.yml` 会禁用 preset 拥有的 dsh-base
行（tool-bash/fs/subagent/todo/web/…——与官方 dsh-web-app/tui 清单逐行一致，仅少
`hmr`；清单保持跨代通用：某一代没有的行会被 patch applier 告警并跳过），并挂载 `agent-presets` 名册（默认 `standard`；`ptc`/`minimal`/`cordis`
随 dsh CLI 附带；自建预设从 0.1.7 起写成 `@deepseek-ai/dsh-agent-preset` 声明行，见「自建 preset」）。bundle 自带
patch 会自动装配（package.json `dsh.bundle.patch`）——**不要**把它复制进 profile
的用户层 `cordis.patch.yml`，否则 loader 在启动时因重复 entry id 拒绝装配。**升级**
一个已有自定义用户层 patch 的 profile 时，用户层只保留你自己的定制行（例如
acp-enhanced 行的 `includeAllProviders: true`，同时 restate provider/model/preset——
patch 条目是整体替换、不做合并）。会话恢复时用日志里记的 preset（最后一条 `agent-preset/selected`，
否则取创建时的 header）；只有日志里什么都没记的会话才落到名册默认预设上。
