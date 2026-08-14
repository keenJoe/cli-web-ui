<!-- 本文负责：技术决策、模块边界、契约语义、数据模型、非功能要求。
     本文不负责：需求动机（见 proposal.md）、行为契约（见 specs/）、
     任务拆分与进度（见 tasks.md）。
     一个事实只写在一处。在此重述上游内容，必然与上游漂移。 -->

## 背景

动机见 proposal.md - Why。本方案的核心约束是**数据来源分离**：对话框内的 git 标识走「后端 watcher → WebSocket 推送」实时通路，GitPanel 标签页继续走自己的 REST 拉取通路，两者不复用同一份数据流，短暂不一致可接受（见 proposal.md - Impact 最后一条）。

两条来自现有代码的硬约束塑造了本设计：

1. `sessions-watcher` 显式 ignore `**/.git/**`（E3），故 git 状态监听必须是一个**独立 watcher**，不能挂在 sessions-watcher 上。
2. 后端 feature 模块不得直接依赖 websocket 传输层（E4/E5 的端口模式），git watcher 要推送事件，必须经由一个**应用端口**（`IGitStatusPublisher`），由 websocket 模块提供适配器、在 server 装配根注入——与 `ISessionChangePublisher` 完全同构。

另有一处对 proposal 的措辞修正：proposal 称「WebSocketContext 的 dispatch 增加 `git_status_changed` 分支」。实际 `WebSocketContext.dispatch` 把每一帧同步分发给所有 `subscribe(listener)`，**没有按 kind 分发的 switch**（E10），因此前端无需改动 `WebSocketContext`，只需新增一个订阅 `git_status_changed` 的消费者。

## 证据登记

| 编号 | 标签 | 陈述 | 依据 | 风险 |
|---|---|---|---|---|
| E1 | `[CONFIRMED]` | `git.routes.ts` 带 `@ts-nocheck`；`GET /status`（行 331）返回 `{branch, hasCommits, modified, added, deleted, untracked, staged}`；`getCurrentBranchName`（行 221）先用 `symbolic-ref --short HEAD`，失败回退 `rev-parse --abbrev-ref HEAD`，detached 时回退结果为 `'HEAD'` 而非短哈希 | `server/modules/git/git.routes.ts:1,221,224,331` | 中 |
| E2 | `[CONFIRMED]` | `parseGitStatusOutput`（TypeScript）将 NUL 分隔的 porcelain 输出解析为 modified/added/deleted/untracked/staged 五桶，已导出可复用 | `server/modules/git/git-parsing.service.ts:23` | 低 |
| E3 | `[CONFIRMED]` | `sessions-watcher` 的 `WATCHER_IGNORED_PATTERNS` 含 `'**/.git/**'`；chokidar 用 `usePolling:true, interval:6_000` | `server/modules/providers/services/sessions-watcher.service.ts:38,265,270` | 低 |
| E4 | `[CONFIRMED]` | `connectedClients` 是所有已认证 chat-WS 连接的扁平 `Set`；`WebSocketSessionChangePublisher.publishSessionUpserted` 遍历**全部**连接发送，**无 project 过滤** | `server/modules/websocket/services/websocket-state.service.ts`；`server/modules/websocket/services/session-application-ports.adapter.ts` | 中 |
| E5 | `[CONFIRMED]` | 应用端口模式：`ISessionChangePublisher` 定义在 `shared/interfaces.ts:361`；`configureSessionChangePublisher(publisher)` 注入式单例在 `session-change-publisher.service.ts`；WS 适配器 `webSocketSessionChangePublisher` 在 `server/index.ts:121` 注入 | `server/shared/interfaces.ts:361`；`server/modules/providers/services/session-change-publisher.service.ts`；`server/index.ts:121` | 低 |
| E6 | `[CONFIRMED]` | `projectsDb.getProjectPaths()` 返回全部未归档工程，含 `project_id` 与 `project_path` | `server/modules/database/repositories/projects.db.ts:89` | 低 |
| E7 | `[CONFIRMED]` | watcher 生命周期在 server 装配根管理：`initializeSessionsWatcher()` 在 `server.listen` 回调内（行 372），`closeSessionsWatcher()` 在关闭流程（行 380） | `server/index.ts:372,380` | 低 |
| E8 | `[CONFIRMED]` | ChatComposer footer 工具行是 `<PromptInputTools className="min-w-0">`（行 391）；「清空输入」按钮为 `hidden sm:flex`（行 448-449），即低于 sm 断点隐藏 | `src/components/chat/view/subcomponents/ChatComposer.tsx:391,448,449` | 低 |
| E9 | `[CONFIRMED]` | MainContent 在 `activeTab === 'git'` 时挂载 GitPanel（行 202）；`setActiveTab` 已下传（行 40）；ChatInterface 于行 162 渲染，**当前未接收任何「打开 GitPanel」回调** | `src/components/main-content/view/MainContent.tsx:40,162,202` | 低 |
| E10 | `[CONFIRMED]` | `WebSocketContext.dispatch` 把每帧同步派发给所有 `subscribe(listener)`，按 `event.kind` 由各消费者自行过滤，无集中 switch | `src/contexts/WebSocketContext.tsx`（`dispatch` / `subscribe`） | 低 |
| E11 | `[CONFIRMED]` | 前端状态管理为纯 React（`useSessionStore` 即 hook + 局部 state），项目**未引入 zustand** | `src/stores/useSessionStore.ts:1-15`；`grep -c zustand package.json` = 0 | 低 |
| E12 | `[CONFIRMED]` | GitPanel 走自己的 REST 通路：`useGitPanelController.fetchGitStatus` 调 `GET /api/git/status?project=<projectId>`，与本次新增的 WS 通路相互独立 | `src/components/git-panel/hooks/useGitPanelController.ts`（`fetchGitStatus`） | 低 |
| E13 | `[CONFIRMED]` | git 模块 barrel `index.ts` 仅导出 `createGitModule`；`git.module.ts` 用注入式依赖装配 router | `server/modules/git/index.ts`；`server/modules/git/git.module.ts` | 低 |
| E14 | `[CONFIRMED]` | server 装配根在行 121-122 注入 session publisher/reader；可在此处并列注入 git publisher | `server/index.ts:121,122` | 低 |

- [x] 每条关于现存代码的陈述都已登记。
- [x] 每条 `[INFERRED]` 都写出了推理依据（本表无 INFERRED）。
- [x] 高风险结论（E4 涉及广播可见性）为 CONFIRMED，风险已在「风险与权衡」登记缓解措施。

## 目标 / 非目标

**目标：**
- 后端新增独立的 git 状态 watcher，监听每个工程 `.git/HEAD` 与 `.git/refs/heads` 变化，在分支或未提交状态变化后 2 秒内经现有 WebSocket 推送 `git_status_changed`。
- 经应用端口 `IGitStatusPublisher` 解耦 git 模块与 websocket 传输层，装配方式与 `ISessionChangePublisher` 同构。
- 前端新增轻量 `GitBranchChip` 组件，显示 `⎇ <分支名> ·<未提交计数>`，点击切换到 GitPanel 标签页；detached HEAD 显示短哈希，非 git 仓库不渲染。
- chip 首次进入工程时用现有 `GET /api/git/status` 兜底加载，之后由 WS 推送持续更新。

**非目标（本设计层面的边界，超出 proposal 已声明范围的部分）：**
- 不重构 `git.routes.ts`（`@ts-nocheck`，E1）——不抽取其中的 `getCurrentBranchName`/`spawnAsync`，不改变其行为；watcher 用独立 TS 服务计算状态，接受与 route 内联逻辑的少量重复（见决策 2）。
- 不新增 REST 路由（proposal 已声明）；`GET /api/git/status` 仅作为前端兜底，watcher 不经 HTTP 自调用。
- 不监听工作区文件（spec 明确 SHALL NOT 轮询工作区）；未提交计数仅在 `.git` 事件触发时刷新，外部编辑工作区文件不立即更新 chip（spec 已接受）。
- 不做服务端按工程成员过滤的定向广播（E4 现状为全量广播；见风险与权衡）。
- 不改动 `useGitPanelController` 与 GitPanel 的数据通路（E12，proposal 已声明）。
- 不改动 `WebSocketContext`（E10，proposal 措辞修正）。

## 设计决策

**决策 1：watcher 独立成模块，生命周期由 server 装配根管理。**
理由：`sessions-watcher` 显式 ignore `.git/**`（E3），无法复用其 watcher；git 状态是独立领域，单列模块使职责清晰、可独立测试。生命周期挂在 `server/index.ts` 既有的 `initializeSessionsWatcher` / `closeSessionsWatcher` 两侧（E7），与现有 watcher 同进退。
替代方案：(a) 复用 sessions-watcher 去掉 `.git/**` ignore——被否，会向 sessions-watcher 注入 git 语义、破坏其 provider-only 边界，且 sessions-watcher 关注的是 transcript 文件而非 git refs；(b) 把 watcher 放进 `websocket` 模块——被否，git 业务逻辑不应下沉到传输层。

**决策 2：状态计算抽到 TS 服务 `git-status.service.ts`，不复用 route 内联逻辑。**
理由：`git.routes.ts` 带 `@ts-nocheck` 且为注入式 router（E1/E13），直接复用其 `getCurrentBranchName`/`spawnAsync` 会把 `@ts-nocheck` 污染进新代码并违反「新 backend 文件为 TS」约束。新建 `git-status.service.ts` 提供类型化的 `resolveGitStatusSnapshot(projectPath)`，内部用 `git symbolic-ref --short HEAD` 判分支、失败则 `git rev-parse --short HEAD`（7 位短哈希）判 detached，并复用已导出的 `parseGitStatusOutput`（E2）算未提交计数。与 route 的少量 `symbolic-ref` 调用重复可接受，待 `refactor-provider-seams` 轨道整体重构 route 时合并。
替代方案：(a) 抽取 route 逻辑为共享服务——被否，超出本次范围且触碰 `@ts-nocheck` 文件；(b) watcher 直接 HTTP 自调用 `/api/git/status`——被否，引入 localhost HTTP 往返与鉴权开销，且 route 返回的 `branch` 在 detached 时是 `'HEAD'`（E1）不满足 spec 的「短哈希」要求。

**决策 3：经应用端口 `IGitStatusPublisher` 推送，与 `ISessionChangePublisher` 同构。**
理由：后端 feature 模块不得直接依赖 websocket 传输层（E5 的端口模式）；watcher 依赖端口，websocket 模块提供 `WebSocketGitStatusPublisher` 适配器（遍历 `connectedClients` 发送，E4），server 装配根用 `configureGitStatusPublisher` 注入（E14）。watcher 测试可用内存实现替换，无需起 WS 服务。
替代方案：(a) git 模块直接 import `connectedClients`——被否，git→websocket 耦合，watcher 无法脱离 WS 测试；(b) 复用 `ISessionChangePublisher` 接口加 `publishGitStatusChanged` 方法——被否，把 git 语义塞进 session 端口，破坏单一职责。

**决策 4：全量广播 + 前端按 `projectId` 过滤（与 `session_upserted` 现状一致）。**
理由：`connectedClients` 是扁平集合，现有 `session_upserted` 即全量广播、前端各自过滤（E4）。git 事件沿用同模式，不引入按工程订阅的复杂度；前端 chip 只消费当前 `selectedProject.projectId` 的事件。
替代方案：服务端按工程成员定向广播——被否，需要把「连接 ↔ 工程成员」映射引入 WS 层，超出本次范围；全量广播的可见性风险见「风险与权衡」。

**决策 5：watcher 仅监听 `.git/HEAD` 与 `.git/refs/heads/**`，不监听工作区。**
理由：spec 明确「SHALL NOT 对工作区文件进行轮询」「未提交计数在分支切换事件触发时刷新」。`.git/HEAD` 变化覆盖分支切换，`.git/refs/heads/**` 覆盖分支增删；事件触发后调一次 `git status --porcelain` 刷新未提交计数，满足 spec 的 2 秒内更新与「外部修改工作区文件不立即更新」两条场景。
替代方案：监听整个工作区——被否，违反 spec 且开销巨大。

**决策 6：detached HEAD 由 watcher 计算短哈希，不走 route 的 `'HEAD'` 回退。**
理由：route 的 `getCurrentBranchName` 在 detached 时返回 `'HEAD'`（E1），不满足 spec「显示 commit 短哈希（前 7 位）、灰色斜体」。`git-status.service.ts` 在 `symbolic-ref` 失败时改用 `rev-parse --short HEAD` 取 7 位哈希，并在事件中置 `isDetached:true` 供前端样式区分。chip 与 GitPanel 的 detached 表现不同可接受（数据通路本就分离，proposal 已声明）。

**决策 7：前端用模块级单例 store + hook，不引入 zustand。**
理由：项目无 zustand（E11），`useSessionStore` 即纯 React hook + 局部 state 的范式。新建 `useComposerGitStatus(selectedProject)` hook：模块级 `Map<projectId, GitStatusSnapshot>` 作缓存，`useWebSocket().subscribe` 订阅 `git_status_changed` 更新缓存，`selectedProject` 变化时先回显缓存、再 `GET /api/git/status` 校验（spec「多工程切换」场景）。
替代方案：Context Provider——被否，chip 是唯一消费者，Provider 包裹层级深、收益低；hook + 模块级缓存足够。

**决策 8：chip 点击回调沿 MainContent → ChatInterface → ChatComposer 三层 prop 下传。**
理由：`setActiveTab` 在 MainContent（E9），GitPanel 挂载条件为 `activeTab==='git'`（E9）。MainContent 传 `onOpenGitPanel={() => setActiveTab('git')}` 给 ChatInterface（当前无此 prop，E9），ChatInterface 透传给 ChatComposer，chip `onClick` 调用。纯 prop 下传，无新 Context。
替代方案：chip 直接发全局事件——被否，绕过 React 数据流、难测试。

**决策 9：未提交计数 = modified + added + deleted + untracked 之和（不含 staged）。**
理由：spec 明确「不含已暂存（staged）状态」。`parseGitStatusOutput` 已分出五桶（E2），watcher 与前端兜底统一按此公式求和，避免两套口径。`staged` 桶仍由 `GET /api/git/status` 返回供 GitPanel 使用，不受影响。

## 模块边界

| 模块 | 职责 | **不负责** | 输入 | 输出 | 依赖 | 状态归属 |
|---|---|---|---|---|---|---|
| `git-status.service`（新增） | 类型化计算单个工程的 git 状态快照（分支/短哈希/detached/未提交计数） | 监听、广播、REST 路由、DB | projectPath | `GitStatusSnapshot` | `parseGitStatusOutput`、`cross-spawn` | 无（纯计算） |
| `git-status-watcher.service`（新增） | 为每个工程监听 `.git/HEAD`+`.git/refs/heads`，防抖后调 `git-status.service` 计算并经端口广播；启停/刷新 watcher | 状态计算细节、传输层、REST | 工程列表（`projectsDb`） | `git_status_changed` 事件流 | `git-status.service`、`gitStatusPublisher` 端口、`projectsDb`、`chokidar` | `Map<projectId, FSWatcher>` + 每工程防抖 timer（进程内） |
| `git-status-publisher.service`（新增） | `IGitStatusPublisher` 注入式单例 + `configureGitStatusPublisher` + 测试用内存实现 | 事件内容、传输、watcher | 事件 | 广播 | `IGitStatusPublisher` 端口 | 当前已配置 publisher（单例） |
| `IGitStatusPublisher`（新增，`shared/interfaces.ts`） | git 状态推送的应用端口契约 | 实现 | `GitStatusEvent` | void | 无 | 无 |
| `WebSocketGitStatusPublisher`（新增，websocket 模块） | 遍历 `connectedClients` 发送 `GitStatusEvent` JSON | 计算事件、选工程 | `GitStatusEvent` | WS 帧 | `connectedClients`、`WS_OPEN_STATE` | 无（读共享 `connectedClients`） |
| `useComposerGitStatus`（新增，前端 hook） | 维护模块级 `Map<projectId, GitStatusSnapshot>` 缓存；订阅 WS `git_status_changed`；`selectedProject` 变化时缓存回显 + REST 校验 | 渲染、tab 切换 | `selectedProject` | `{branch, uncommittedCount, isDetached, isGitRepository}` | `useWebSocket().subscribe`、`GET /api/git/status` | 模块级缓存 `Map`（前端单例） |
| `GitBranchChip`（新增组件） | 渲染 `⎇ 分支·计数` 胶囊；detached 灰色斜体；非 git 不渲染；窄屏优先隐藏；点击触发 `onOpenGitPanel` | 数据获取、tab 切换实现 | `gitStatus`、`onOpenGitPanel` | JSX | `useComposerGitStatus`（由 ChatComposer 注入 projectId 后调用） | 无 |
| `ChatComposer`（重塑） | footer 工具行插入 `<GitBranchChip>`；新增 `gitStatus`/`onOpenGitPanel` props | chip 内部逻辑 | 新 props | JSX | `GitBranchChip` | 无 |
| `ChatInterface` / `MainContent`（重塑） | 透传 `onOpenGitPanel`；ChatInterface 调 `useComposerGitStatus` 取状态传给 composer | chip 渲染 | `onOpenGitPanel`、`selectedProject` | 同前 | 前述 hook | 无 |

- [x] 没有任何模块跨越多个领域。
- [x] 每一行的「不负责」都已填写。
- [x] 每份状态数据都只有一个归属模块（watcher 的 watcher-map；publisher 的单例；前端缓存的模块级 Map）。
- [x] 「依赖」列中不存在循环（git watcher → 端口 ← WebSocketGitStatusPublisher ← connectedClients；前端 hook → WS subscribe + REST，无环）。

## 规则与约束

| 类型 | 规则 | 覆盖需求 |
|---|---|---|
| 业务规则 | 未提交计数 = modified + added + deleted + untracked，不含 staged | 对话框显示分支与未提交摘要 |
| 业务规则 | chip 点击仅切换到 GitPanel 标签页，不执行 checkout / 创建分支 / 展开文件列表 | 标识作为 GitPanel 入口 |
| 业务规则 | detached HEAD 显示 commit 短哈希（前 7 位），样式灰色斜体 | 对话框显示分支与未提交摘要 |
| 业务规则 | 非 git 仓库不渲染 chip，且不占用布局位置 | 对话框显示分支与未提交摘要 |
| 系统规则 | git 状态变化后 2 秒内更新 chip，无论变化来自应用内还是外部 | git 状态变化实时同步 |
| 系统规则 | 变化检测基于后端对 `.git/HEAD` 与 `.git/refs/heads` 的文件系统监听 + 现有 WS 推送 | git 状态变化实时同步 |
| 系统规则 | SHALL NOT 轮询工作区文件检测未提交更改；未提交计数在分支切换事件触发时刷新，前端首次进入工程时用 `GET /api/git/status` 兜底 | git 状态变化实时同步 |
| 系统规则 | 多工程切换时先回显目标工程缓存状态，后台再 `GET /api/git/status` 校验 | git 状态变化实时同步 |
| 系统规则 | WS 断连时保留最后已知状态，重连后由后端推送最新（无需前端轮询） | git 状态变化实时同步 |
| 技术约束 | 新增 backend 文件均为 TypeScript；不向 `git.routes.ts`（`@ts-nocheck`）引入改动 | 全部 |
| 技术约束 | git 模块不得直接 import websocket 传输层；推送须经 `IGitStatusPublisher` 端口 | 全部 |
| 技术约束 | 不新增 npm 依赖（chokidar 已是项目依赖） | 全部 |
| 技术约束 | 不新增 REST 路由；复用现有 `GET /api/git/status` 作前端兜底 | 全部 |
| 技术约束 | 不改动 `WebSocketContext`（`subscribe` 已按 kind 分发，无需集中 switch） | 全部 |

## 错误码注册表

本次不新增错误码。watcher 内部的 git 命令失败、文件监听错误均记 `console.error` 并跳过本次广播（best-effort，不向用户抛错）；非 git 仓库经事件 `isGitRepository:false` 让前端隐藏 chip，非异常态。现有 `GET /api/git/status` 的 `NOT_A_GIT_REPOSITORY`（E1）沿用，不重复定义。

## 数据模型

不新增数据库字段、不新增迁移。仅新增内存/传输用的 `GitStatusEvent` 类型（定义在 `server/shared/types.ts`，端口与适配器共用）。

| 字段 | 类型 | 必填 | 含义 | 示例 | 约束 | 枚举值 | 默认值 | 空值语义 |
|---|---|---|---|---|---|---|---|---|
| `kind` | `'git_status_changed'` | 是 | 事件类型 | `'git_status_changed'` | 字面量 | - | - | - |
| `projectId` | `string` | 是 | DB 工程 id | `'8f3c...'` | 非空 | - | - | - |
| `branch` | `string` | 否 | 分支名或 detached 短哈希 | `'develop'` / `'a1b2c3d'` | - | - | `''` | 空串=非 git 仓库或无提交 |
| `uncommittedCount` | `number` | 是 | 未提交文件数（不含 staged） | `3` | ≥0 整数 | - | `0` | `0`=干净工作区 |
| `isDetached` | `boolean` | 是 | 是否 detached HEAD | `true` | - | - | `false` | - |
| `isGitRepository` | `boolean` | 是 | 该工程是否 git 仓库 | `false` | - | - | `true` | `false`→前端不渲染 chip |
| `timestamp` | `string` | 是 | ISO 时间戳 | `'2026-08-14T...'` | ISO-8601 | - | - | - |

watcher 进程内状态（非持久化）：`Map<projectId, { watcher: FSWatcher, debounceTimer?: ReturnType<setTimeout> }>`。

**watcher 状态流转：** `UNINITIALIZED -> WATCHING -> CLOSED`；任一工程的 `.git` 被删除则该工程条目 `WATCHING -> ERRORED`（记日志、关闭该 watcher、发一次 `isGitRepository:false` 后移除条目），其余工程不受影响。`CLOSED` 为终态。

## 非功能要求

| 维度 | 要求 |
|---|---|
| 延迟 / 吞吐 | `.git` 变化到 WS 推出 ≤2s（spec）：防抖 500ms + `git status` 子进程 ≤500ms + 广播 <50ms；单工程广播载荷 <200B |
| 并发 | 每工程一个 chokidar watcher；防抖窗口内多次 `.git` 事件合并为一次状态计算与广播 |
| 超时 | watcher 内 `git status` 子进程超时 5s 后丢弃本次广播并记日志；chokidar `usePolling:false`（`.git` 目录小、事件驱动即可，不照搬 sessions-watcher 的 6s 轮询） |
| 重试策略 | 不对 git 命令自动重试；下一次 `.git` 事件自然触发重新计算 |
| 一致性 | chip（WS）与 GitPanel（REST）短暂不一致可接受（proposal 已声明）；多工程切换时乐观回显缓存 + REST 校验 |
| 可观测性 | watcher 启停、单工程 watcher 错误、git 命令超时均 `console.error`（与 sessions-watcher 一致）；广播为 best-effort |

## 风险与权衡

- [全量广播可见性] -> `connectedClients` 扁平广播（E4），所有已认证连接都会收到所有工程的 `git_status_changed`。与现有 `session_upserted` 同构（已携带 project 路径与显示名），不引入新的可见性等级。服务端按工程成员定向广播留待后续多用户权限硬化变更，本次不做。
- [外部编辑工作区文件不更新计数] -> spec 明确接受（SHALL NOT 轮询工作区）。下一次分支切换事件或前端重新进入工程时刷新。GitPanel 打开时其自身 REST 拉取为准确值。
- [运行期新增工程无 watcher] -> 启动时按 `projectsDb.getProjectPaths()` 建表（E6）；运行期新增工程在 chip 首次进入时由 `GET /api/git/status` 兜底显示，其 watcher 经 `refreshGitStatusWatchers()` 在 server 装配根或工程创建流程调用后建立。未建立期间仅缺实时推送，显示仍正确。
- [detached 表现与 GitPanel 不一致] -> chip 显示 7 位短哈希灰色斜体（决策 6），GitPanel 的 `currentBranch` 回退 `DEFAULT_BRANCH`（E12）。数据通路分离，可接受。
- [`git.routes.ts` 状态计算重复] -> `git-status.service` 与 route 内联 `symbolic-ref`/`status` 调用有少量重复（决策 2），待 `refactor-provider-seams` 轨道重构 route 时合并，本次不扩范围。
- [`.git` 目录被删除] -> 该工程 watcher 进入 `ERRORED`，发一次 `isGitRepository:false` 让 chip 隐藏，移除条目；若目录重建需 `refreshGitStatusWatchers()` 重新注册。

## 迁移计划

纯新增，无数据库迁移。

| 项 | 内容 |
|---|---|
| 上线步骤 | 新增 `git-status.service`/`git-status-publisher.service`/`git-status-watcher.service` → barrel 导出 → `IGitStatusPublisher` 入 `shared/interfaces.ts`、`GitStatusEvent` 入 `shared/types.ts` → `WebSocketGitStatusPublisher` 适配器入 websocket 模块 → server 装配根 `configureGitStatusPublisher` + `initialize/closeGitStatusWatcher` → 前端 hook + chip + 三层 prop 下传 |
| 回滚策略 | 移除 server 装配根的 `configureGitStatusPublisher` 与 watcher init/close 调用 + 移除前端 chip 渲染即可；端口、服务、适配器文件可保留不动（无消费者即不生效） |
| 回滚后数据处理 | 无已写入数据（纯内存/传输事件），无需处理 |
