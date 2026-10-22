# 变更日志

`dsh-acp-enhanced` 的发布历史，由新到旧。版本号与 git tag（`vX.Y.Z`）及 npm 发布一致。
格式参照 [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)。

[README](README-zh.md) 只描述这个桥*是什么*、当前支持哪些 harness 线；逐版本的变更记在这里。
完整工程记录（测了什么、否决了什么、还剩什么要验）在 [`docs/plans/`](docs/plans/) 下，每条都链过去。
英文原件见 [CHANGELOG.md](CHANGELOG.md)。

## [0.11.0] - 2026-10-22

支持 dsh **0.2.1**。没有放宽任何东西——`^0.2.0-rc.2` 本来就包含 `0.2.1-rc.2`——
`lib/` 一行未改：这个版本把这条线命名出来、在 CI 里真正启动它，并移除
`@deepseek-ai/dsh-invariants`。迁移记录：
[`docs/plans/2026-10-18-dsh-0.2.1-support.md`](docs/plans/2026-10-18-dsh-0.2.1-support.md)。

`dsh` 0.2.1（仍是 RC 线：`latest` 是 0.2.0-rc.2，`next` 是 0.2.1-rc.2）带来两处用户可见的变化，
都不需要本桥做任何事。其一是**宿主侧的 DeepSeek 搜索与抓取**：harness 的 `dsh-base` bundle——本桥
bundle 所扩展的那一层——新增了 `web-deepseek-api` 行，让 `web_search`/`web_fetch` 走 DeepSeek 专用
的 Search 与 Fetch 端点，而不是一次完整的辅助模型请求。它从 `DEEPSEEK_API_KEY` 取凭据，并在 harness
自己的网页搜索设置里选择启用；本桥没有任何行、peer 或 import 参与其中，在用户打开那个开关之前，
已有 profile 的搜索配置也不会被改动。其二是纯 UI：新增的客户端插件只为模型选择器里的 1017 检查点
加标签，而它挂在 **web/桌面** bundle 层，ACP profile 根本不加载它。

本桥链接的一切都没变：在其导入的包上，0.2.1 与 0.2.0 的差别只有 `package.json` 版本号；
agent-preset roster 仍是 0.1.7 引入的「registry + 声明行」形状；`cordis.patch.yml` 里的代际门控
（`minor > 1`）本来就把 0.2.1 归为 registry-roster 线。所以这次发布是声明变更加它的证据：

- 每个 `@deepseek-ai/dsh*` peer 加上 `|| ^0.2.1-rc.2`。这一段**什么都不放宽**：`^0.2.0-rc.2` 的上界
  是 `<0.3.0-0`，本来就包含 `0.2.1-rc.2`。之所以仍然写出来，是因为这个范围同时是守卫检查的「线
  清单」，而 `scripts/support-claim-test.mjs` 要求**每一段**都对应一个 CI 矩阵版本与一个链接检查
  代际——把线写进声明，才是让它背后真有一次启动的机制；
- `@deepseek-ai/dsh-invariants` 从 `peerDependencies` **和** `devDependencies` 里移除。它一直是纯
  版本跟踪的 peer（`lib/` 从不 import 它，也从不是 patch 行），而上游在 0.2.0-rc.2 之后就没再发布
  它，0.2.1 的闭包里没有它。留着这个声明只会让 pnpm 装进一个该线并不存在的包——正是 0.10.0 记录过
  的 ≤ 0.1.6 名册包的失效模式；
- 第四代 `compat-check`（`framesRegistry021`）按 `dsh-invariants` **缺席**来钉住 0.2.1 那一套，于是
  链接检查描述的是该线真实解析出的闭包，而不是上一条线的；
- 启动矩阵与链接检查现在覆盖四条线，canary 的注释也记录了各 dist-tag 分别指向哪条线；
- 有一处行为差异是**如实记录、本次不改**：本桥内联的四条 preset 声明是它自己对宿主组合的拷贝，
  而 0.2.1-rc.2 把上游那四份全部重写了——去掉 `persona.config.suffix` 与两个子代理的
  `backgroundMode`，给 `standard` 加 `time-context`、`tool-schedule`、`tool-plugin-market`，
  给 `minimal` 加 `compaction` 组与 `tool-fs`，并改写了 plan mode 的措辞。这份拷贝在 0.2.1 上
  **挂得上**（keyless 冒烟会开一个会话，从而组合默认 preset），但「挂得上」只能证明挂载：它仍然
  携带的 suffix 不是过时而已，而是让该线每一个回合都死掉（见下方「修复」），而 `backgroundMode`
  与那些新增行仍未跟进——所以 0.2.1 上的 ACP 会话组合的是 **0.2.0** 那套：没有 `time-context`、
  没有 `tool-schedule`，plan mode 文案也是旧的。跟进其余部分需要按线声明，因为新增行里有两个包
  只在 0.2.1 存在，而安装路径会在每条声明线上解析每一行 `name`——见
  `docs/plans/2026-10-18-dsh-0.2.1-support.md` §2.3 与 §7。

验证的形状与 0.10.0 相同，同样把两件事留给维护者：需要模型的两条腿，以及一次真实的 Zed 会话。
本次发布在本机实测的部分：五个离线守卫（本版本给原来四个加上
`scripts/docs-claim-test.mjs`）、四代链接检查、安装路径、doctor，以及 0.2.1-rc.2 上的
keyless 启动冒烟——见 `docs/plans/2026-10-18-dsh-0.2.1-support.md` §5。

### 修复

- **内联 preset 仍在发送 `{{cwd}}`，而 0.2.1 已不再接受它——每个回合都会失败。** roster 里的
  `dsh-persona` 行带着这个变量，而 0.2.1 线上的 `dsh-agent-loop` 只注册 `provider` 与 `model`
  两个提示词变量（`cwd` 一直注册到 0.1.7）。插值是严格的，所以凡是走本桥内联
  `standard` / `ptc` / `cordis` roster 的会话，都在首个模型请求之前的提示词组装阶段死于
  `unknown prompt variable "{{cwd}}"`：启动正常，挂载也正常，回合全灭。这三条 persona 行现在与
  上游 0.2.1 自己的 preset 文件一致，只保留模型前缀，工作目录由 working-directory 服务提供。
  `profile/cordis.yml`（手写参考组合）的 spine persona 也删去了同一句。这是 §2.3 preset 对照表里
  唯一从来不算「保真度差异」的一行，也是本次发布唯一跟进的上游 preset 变更。

## [0.10.0] - 2026-10-01

支持 dsh **0.2.0**，同时把**下限上移到 `0.1.6-alpha.1`**（放弃 0.1.5-rc.2：它的启动冒烟在
GitHub runner 上从未通过）。新增守卫让声明范围、CI 矩阵与链接代际保持一致。迁移记录：
[`docs/plans/2026-09-30-dsh-0.2.0-support.md`](docs/plans/2026-09-30-dsh-0.2.0-support.md)。

`dsh` 0.2.0（RC 线，尚无 stable）是一次 **客户端/UI 版本**。本桥 import 的一切除版本号外都没变：
它链接的 harness 包与 0.1.7-rc.2 的差异只在 `package.json`（逐包审计覆盖十个包），`@deepseek-ai/dsh-session`
多了一个导出（`ToolCallRecovery`，上游修「工具调度失败后会话无法继续」），两份生成目录新增
`ctx.otel` 与 `ctx.productAnalytics`，**没有任何删除**——0 个服务、0 个事件消失。

真正变了的是宿主的 **peer 门控**，这次发版就是为它：

| | ≤ 0.1.7 | 对停在 0.1.7 的桥，≥ 0.2.0 会怎样 |
|---|---|---|
| `dsh plugin add` 安装该 bundle | 正常安装 | 硬失败 **`incompatible-version`**，并提示可申请精确版本豁免 |
| 启动已带该 bundle 的 profile | bundle 正常加载 | CLI **整层丢掉该 bundle 的 patch 层**，只打一行 stderr：`dsh: skipping profile bundle "dsh-acp-enhanced": … peerDependencies {…}` |
| launcher 自己的告警 | — | *什么也没有*：旧辅助函数的上界没有带 semver 的 `-0`，于是它把 `0.2.0-rc.2` 报成「支持」，而宿主早已丢弃桥 |

修了五处，都不在 `lib/`：

- 其余每个 `@deepseek-ai/dsh*` peer 都加上 `|| ^0.2.0-rc.2`；门控是拿*运行版本*逐个比对声明的
  范围，所以只要有一条没放宽，整个 bundle 就没了；
- `@deepseek-ai/dsh-agent-presets` 从 `peerDependencies` 中**移除**。它是 ≤ 0.1.6 各线的名册，而
  0.1.6 之后再无发布，把它声明成 peer 会让 pnpm 在**每个** 0.2.0 profile 里装上它——而*安装*路径
  检查的不只是清单：`bundleComponentManifests` 会把 bundle 各 patch 文件里**每一行的 `name`** 解析
  出来，对解析到的包跑同一个门控，于是那个根本没被 import 的 0.1.6 包会让整个安装以
  `incompatible-version` 失败——即使范围已经放宽也一样。被拒的是**要装进去的东西**（新装的包，以及它
  自己的行与 peer 解析到的包）；profile 里只是**已经有**一个不兼容的第三方成员时，只会收到警告、照常
  留在安装里，但在启动时被拒（升级它、移除它，或授予精确版本豁免——实测见迁移记录
  `docs/plans/2026-09-30-dsh-0.2.0-support.md` §5 row 23）。行本身保留（在后续各代由代际门控设为
  `disabled`），它仍然从运行中 CLI 自己的安装闭包里解析——这正是自 0.9.1 起兄弟行
  `@deepseek-ai/dsh-agent-preset-registry` 一直用的机制。各线实测：旧名册包能从 0.1.6 的
  安装里解析到，从 0.1.7 与 0.2.0 解析不到，所以 0.1.6 上日志仍是*旧名册*的
  `preset "…" not found`，0.1.7/0.2.0 上则是注册表的 `Unknown agent preset`；
- `scripts/lib/dsh-version.mjs` 现在把 caret 上界展开成 `<x.y.0-0`，与
  `semver.satisfies(…, { includePrerelease: true })` 一致，因此上界版本自身的预发布版
  （`0.2.0-rc.2` 对 `^0.1.7-alpha.1`）被正确判为*范围外*；doctor 的失败信息也区分「CLI 太旧」与
  「该 CLI 线未经验证」；
- `scripts/support-claim-test.mjs`（新增，CI 阻塞项）断言声明的范围、CI 启动矩阵、`compat-check`
  各代与辅助函数完全一致，辅助函数在每条线边界上与 npm 自己的 semver 一致，并且**每个声明的 peer
  都同时是 devDependency**——也就是 `lib/` 真正链接的那份闭包。最后这条保证了「只被某代 patch 行
  需要」的包不会再次混进 `peerDependencies`。
- **doctor 与启动器**会把它报出来。`acp-doctor.mjs` 只在 boot 确实因此挂掉时归为 `LAYER manifest-gate`
  （崩溃签名优先于它；若 boot 仍开了线程则报 `DEGRADED <n> inactive items`——被跳过是少了项能力，
  不等于 profile 一定死），其 `FIX` 区分*本桥*与*第三方*；启动器把同一行 stderr 翻译成
  `dsh-acp-zed: MANIFEST-GATE …`，且不占用它唯一那条致命提示的名额。
  这一步很关键：它是唯一一类不是堆栈的失败——启动会带着缺层继续跑，日志里不会有别的东西提醒你。

两条门控路径都有覆盖：安装路径由四个矩阵格各自执行 `dsh plugin add`，而
`scripts/acp-smoke-keyless.mjs` 断言启动 stderr 里**没有** `skipping profile bundle` 行。

`cordis.patch.yml` 的代际门控不需要新边界：`minor > 1` 已把 0.2.0 归为注册表名册线，四条内联的
preset 声明与 `@deepseek-ai/dsh-web-app@0.2.0-rc.2` 的 `config` 子树相同（声明行本身另带本桥的
`disabled` 代际门控与展示元数据）。

**第三方 bundle 只能自己放宽门控。** 声明只含 0.1.x 的第三方 bundle 会在 0.2.0 profile 上被跳过，
直到它的发布者自己放宽范围——本包修不了这个。被跳过的代价是**那条 bundle 的能力**，不是 profile。实测：用 0.1.6 CLI 建出的一个 profile
（桥 + 这样一条 bundle，在 0.1.7-rc.2 上是 `RESULT READY`），改由 0.2.0-rc.2 启动时，一个
直接 spawn CLI 的独立 ACP 探针（不经 doctor／启动器）在 ~0.5s 内应答了 `initialize`、进程存活、开出了
`session/new` 线程，`session/prompt` 一路走到模型调用——用户层为空、以及用户层带一行配置被跳过 bundle 的
条目（正是「别的行依赖它」那种形状）两种情况下都是如此。`scripts/acp-doctor.mjs`
报的就是这个：`BOOT OK` + `DEGRADED <n> inactive items`。只有当 boot 确实因此挂掉时它才打
`LAYER manifest-gate`，而这对本桥意味着**自跳过**（连握手都没有），其 `FIX` 会区分两种情况，不会在被跳过
的是别人的 bundle 时叫你去升级本桥。上游还有一条逃生口：当某个 bundle 在新线上没有发布时，可以用精确版本
豁免 `dsh plugin allow-version <pkg@ver> --dsh-version <exact> --accept-risk --profile <p>`——实测能撤掉
跳过、boot 照常稳定；但授予它就等于接下警告里写的崩溃/数据损坏风险，而那条 bundle 的代码在新线上是否真的
能用，恰恰是没有验证的部分。

## [0.9.1] - 2026-09-25

支持 dsh **0.1.7**：上游把 agent-preset roster 换了包，所以桥同时下发两种形状（代际门控行），
并把四条 preset 声明内联进 patch。迁移记录：
[`docs/plans/2026-09-24-dsh-0.1.7-support.md`](docs/plans/2026-09-24-dsh-0.1.7-support.md)。

`dsh` 0.1.7 **重新打包了 agent-preset roster**。`@deepseek-ai/dsh-agent-presets`（把
standard/ptc/minimal/cordis 组合打进去、并作为只读 `system` root 前置的那个包）在 0.1.7 线
完全没有发布；该线改为 `@deepseek-ai/dsh-agent-preset-registry` 加上每个 preset 一条
`@deepseek-ai/dsh-agent-preset` 声明行。三处表面发生了位移，桥在不放弃任何受支持线的前提下
全部吸收：

| 表面 | ≤ 0.1.6 | ≥ 0.1.7 | 桥的做法 |
|---|---|---|---|
| roster 行 | `@deepseek-ai/dsh-agent-presets` + `config.default` | `@deepseek-ai/dsh-agent-preset-registry` + `config.default` | 两行都下发，各自由代际门控 `disabled`，因此恰好只有一行激活（两者提供同一个服务名，第二次 `provide` 会抛错）。两行都从运行中 CLI 自己的安装闭包里解析——它们都不是本包的 `peerDependency`，0.10.0 正是为此移除了旧名册那条（见下） |
| 随包 preset | 打在 roster 包内（`system` root） | 每个 preset 一条 `@deepseek-ai/dsh-agent-preset` 声明，谁需要谁下发（`@deepseek-ai/dsh-web-app` 以 `presets/*.patch.yml` 层下发） | 四条声明按 web-app 组合包原样（MIT，0.1.7-rc.2）内联进 `cordis.patch.yml`，并补回旧 roster 每个 preset 的 `preset.yml` 里的展示元数据——0.1.7 对内置 id 不再发布 `name` |
| 可挂载解析 | 私有 `presets.resolveMountable(id)` | `presets.resolve(id)` 会**故意**返回损坏行；各挂载路径在解析之后才拒绝 | 成员探测：有 `resolveMountable` 就用它，否则 `resolve()` 加该行自身的 `broken` 理由 |

门控读的是**正在启动的这套安装自身的身份**：打开 `profileContext.installAnchor`（即运行中 CLI
自己的 `package.json`），用它的 `version` 决定形状（registry roster 从 0.1.x 线的 0.1.7 开始）。
更老的线上根本没有 `profileContext`（`≤ 0.1.6`），这本身就是答案；任何读不到、解析不了、
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

### 0.1.7 对「会话库很大」意味着什么

0.1.7 上读一个已存会话日志的代价高得多（约 217ms/个，0.1.5 约 9ms），而 `session/list` 需要
给每个已存会话一个标题。修复前，这个调用会对每个会话同时做 `stat()` **和**一次完整解码，
于是几百个会话的库会让该调用耗时约 **60 秒**——超过客户端 30 秒的线路超时，侧边栏会话列表
因此空白。临时 profile 看不到这个问题：全新的 home 会话太少。

现在列表只从**一次**存储遍历里取每个会话的体积与 revision，并且只解码「短预算」内放行的
那些日志，**按最近活动优先**（也就是侧边栏展示的顺序）。预算没覆盖到的部分会继续在后台解析，
以 `session_info_update` 逐条送达；标题按 revision 缓存，因此再次列取就是一次 map 查找。在真实
的 302 会话库上实测：每次调用 **60s → 2.7s**，其余标题随后陆续到达。可用
`DSH_ACP_LIST_BUDGET_MS` 调整预算（默认 2500）。

### 升级到 0.1.7 前要检查的两件事

两者出错时都是静默的：

- **每条第三方 bundle 都要有为该线发布的版本**。旧版本可能 import `SettingsProvider`，而 0.1.7 的
  `dsh-settings` 把它换成了 `SettingsForms`；该条目 import 失败、loader 继续跑，那个能力
  就这么消失了。`scripts/acp-doctor.mjs` 现在会把这种启动报告成降级（`RESULT DEGRADED` 并列出
  条目名、退出码 1），而不是 `RESULT READY`。
- **`$DSH_HOME/.agent-presets/` 里的自建 preset 不再被发现**——见上文「自建 preset」。

## [0.9.0] - 2026-09-19

**破坏性变更**：只消费已声明表面，下限 `0.1.5-rc.2`，移除 `session/delete`，launcher 不再改写
`DSH_HOME`。迁移记录：
[`docs/plans/2026-09-20-public-api-only-migration.md`](docs/plans/2026-09-20-public-api-only-migration.md)。

| 变更 | 影响 | 中招了怎么办 |
|---|---|---|
| 下限提升到 dsh **≥ 0.1.5-rc.2** | 更老的宿主在挂载期就以具名错误失败，而不是静默降级 | 升级 CLI（`npm install -g @deepseek-ai/dsh@0.1.5-rc.2`），或留在 `feat/dsh-0.1.3-plus-support` 分支（≤ 0.1.2-rc.1） |
| **移除 `session/delete`** | 不再广播该能力，也永不删除已持久化的会话——harness 未声明公开的持久化删除接口 | 文件仍在 `$DSH_HOME/sessions/<slug>/<id>/`，确有需要请手工删除。上游已有 issue 追踪公开删除 API |
| 启动器**不再改写 `DSH_HOME`** | ACP profile 在启动器所处的 home 中启动（`${DSH_HOME:-$HOME/.dsh}`），与 `dsh web` 共享凭据、设置、会话与 preset | 之前用的是隐式隔离的 `~/.dsh-acp`？在 Zed 的 `agent_servers.env` 里显式指回它（`"DSH_HOME": "<home>/.dsh-acp"`），或迁回共享 home |
| `assistant/chunk` seam 移除 | 实时流只剩 `agent/assistant-stream`（下限已覆盖该代） | 升级 CLI；完全不发流的宿主仍由已提交的 `assistant/message` 兜底 |

## [0.8.x] - 未发布

0.1.3+ 实时 seam 与 0.1.5 持久化 handle API。从未发布，被 0.9.0
取代。

## [0.7.0] - 2026-09-04

运行期同时探测两代（≤ 0.1.2-rc.1）。更早的版本早于本 changelog。
