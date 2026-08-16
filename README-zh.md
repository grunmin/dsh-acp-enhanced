**[English](README-en.md) | 中文**

# dsh-acp-enhanced

面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）的增强版
[Agent Client Protocol](https://agentclientprotocol.com)（ACP）服务器，为 **Zed** 等 ACP
编辑器设计。它是官方 `@deepseek-ai/dsh-acp` 桥接器的即插即用替代品：官方桥只做纯文本
输出，本桥把 Web GUI 的能力（流式、遥测、模型/权限控制、会话管理、MCP）全部暴露到
ACP 线上。

## 特性

### 输出与遥测

- **块级流式 + 推理流式**：文本块与思考过程实时到达（`agent_message_chunk` /
  `agent_thought_chunk`），取消/重试不留半截输出
- **完整遥测**：上下文用量环 + 缓存命中率 / TPS / 输入-输出-推理 token / 工具耗时 /
  轮次计数（`usage_update._meta` 携带全量明细）

### 模型与权限

- **模型切换**：实时 `provider/model` 目录下拉（按 ACP 规范分组线格式）
- **推理强度**：`reasoning_effort` 下拉——仅当当前路由暴露可选 efforts 时出现
- **权限预设**：read-only / workspace-write / full-access 三种会话模式
- **审批**：工具调用弹出原生 allow-once / reject-once 审批

### Zed 深度集成

- **工具卡片**：展开可见每次调用的完整参数与结果预览（`rawInput` / `rawOutput`），
  按工具类型渲染图标
- **Zed 文件与终端**：`zed_read_text_file` / `zed_write_text_file` / `zed_terminal` 把
  文件编辑放进 Zed 的"编辑文件"区（diff + 接受/拒绝）、命令跑在 Zed 真实终端
- **原生表单提问**：`ask_user_question` → `elicitation/create` 表单，选项即点即答
- **Plan 面板**：plan mode 开关 → Zed 底部"规划中"状态条

### 会话

- **恢复与归档**：`session/load` 恢复历史线程（完整回放）；`session/list` /
  `session/delete` 管理线程归档（带标题、按更新时间排序）；标题实时推送

### 命令

- **Slash 命令**：输入 `/` 即可见命令列表（`available_commands_update`）：`/status`
  查看路由与遥测、`/model` 列出或切换模型，其余（`/compact` `/goal` `/permission`
  `/plan`…）直通 harness 命令注册表，全部**不经过模型 turn** 即时执行；未解析的
  slash 放行给模型（`/skill-name` 技能手势）

### MCP

- **MCP servers**：`session/new` 的 `mcpServers` 挂载任意 MCP server（stdio +
  streamable HTTP），工具以 `mcp__<server>__<tool>` 注入；失败的 server 不会拖垮会话

## 效果预览

在 Zed 的 AI Agent 面板中选择 **dsh-acp-enhanced** 后：

<img src="assets/screenshots/approval-config-context.png" alt="审批弹窗与模型/推理强度切换、上下文环" width="560">

- 工具调用需要许可时弹出**原生审批弹窗**；输入框下方是模型、推理强度、权限预设、
  Plan mode 配置项与上下文用量环。

<img src="assets/screenshots/tool-cards-elicitation.png" alt="工具调用入参与输出、Zed 原生提问表单" width="320">

- **工具卡片**可展开查看完整入参与结果预览；DSH 需要确认/选择时以 **Zed 原生表单**
  弹出，选项即点即答。

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

> 这两项 env 与包自带 patch 的缺省值一致，**省略也能工作**——显式写上只是让路由意图
> 一目了然。API key 不必写进 Zed：存入 `~/.dsh/.credentials.yaml`
> （`DEEPSEEK_API_KEY`）由 dsh 凭据服务解析即可；启动脚本还会兜底继承正在运行的
> `dsh web` 进程的 key。

可选：固定面板默认项（都可随时在面板里改）：

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

### 可选：web_search 走同一个网关

若网关实现 OpenAI Responses 的 `web_search` 服务端工具，可把搜索也路由到网关（复用
同一凭据）。装子包并给 profile 的 `cordis.patch.yml` 追加两段：

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

## 故障排查

| 症状 | 处理 |
|---|---|
| `exec: dsh: not found`（status 127） | 用随附 `dsh-acp-zed.sh` 启动器（自定位 node/dsh） |
| `no API key for provider route "xxx"` | 写入 `~/.dsh/.credentials.yaml`，或在 agent_servers 里设 `env.DEEPSEEK_API_KEY` |
| 无法切换模型 / 上下文用量不显示 | 选到了不可路由的"幽灵 provider"；本桥默认过滤（只广播 `config.provider` 的模型），确认 profile 的 provider 指向真实路由 |
| 需要详细诊断 | `ACP_DEBUG=1 dsh --profile acp-enhanced`（stderr 生命周期 trace） |

## 开发

```sh
node scripts/acp-client.mjs           # 端到端冒烟（需要 API key）
node scripts/acp-client-tools.mjs     # 客户端工具测试（模拟 Zed 的 fs/terminal/elicitation/plan）
node scripts/acp-mcp-test.mjs         # MCP 挂载测试（无模型调用）
node scripts/acp-smoke-keyless.mjs    # keyless 冒烟（CI 用）
node scripts/acp-resume-test.mjs      # 会话恢复测试
```

## 已知限制

仅 baseline prompt（无图片/音频附件）、不支持 `additionalDirectories`、文本按块粒度
流式、每会话同时一个 in-flight prompt。MCP 支持 stdio 与 streamable HTTP（不声明
legacy SSE / `acp` 传输）。`session/close` / `session/fork` / `session/resume` 未实现
（不声明能力，合规客户端不会调用）；`session/delete` 因 dsh 持久化无官方删除 API，
采用直接删除后端目录的方式。
