# Provider 公共接缝重构 实现任务

「构建什么」见 `specs/provider-seams/spec.md`，「怎么构建」见 `design.md`。

**前置约束**：
- Pi 代码已合入主干，代码层无阻塞。剩余前置是文档流程：`add-pi-provider` 归档、`pi-provider` 进入 `openspec/specs/`。
- characterization tests（任务组 1）必须先于任何替换完成并通过。
- 任务组 2（session 身份）修复的是生产环境正在删数据的缺陷，**可独立发布**，不必等待后续任务组。

**已知既有 flake（先于本 change，勿误判为回归）**：
`server/modules/agent/tests/agent.routes.test.ts` 在**全量并发**跑时整文件失败，报
`Error: Unable to deserialize cloned data due to invalid or unsupported version`（栈在 `node:internal/test_runner/runner:485`）。
- **概率与用例总量正相关**（任务 1.3 审查实测的对照实验）：HEAD 干净树 **0/12**；HEAD + 1.1/1.2 的新测试（生产代码仍是 HEAD）**1/6**；当前分支 **5/10**。
  → 因果已定：由测试总量/并发负载触发，**与本 change 的生产代码无关**。
- 表现为该文件的用例数整体消失（381 → 380/378 等），而非断言失败。属 Node 测试运行器与子进程间的 IPC 消息损坏。Node v26.5.1。
- **判定规则**：若某次 `npm test` 只有这一个文件红、且错误文本为上述 deserialize 报错 → **重跑至多 2 次**再判，不计为回归（全量跑复现率已达 30–50%，连续两次红是常态，不要误判）。任何其他文件红、或该文件报的是真实断言失败 → 按回归处理。该文件单独跑稳定全绿，可用单跑复核。
- 修复不在本 change 范围，建议单独立项。


## 0. 文件归属

路径已按真实仓库核实：数据库源码在 `server/modules/database/`，仓库根 `database/` 仅含 `auth.db` 二进制文件。

| 任务组 | 独占文件/目录 | 禁止改动 | 共享文件处理 |
|---|---|---|---|
| 1 | `server/modules/providers/tests/characterization/`、`server/modules/websocket/tests/` 与 `server/modules/agent/tests/` 新增用例 | 生产代码 | 只读生产代码，仅新增测试 |
| 2 | `server/modules/database/schema.ts`、`server/modules/database/migrations.ts`、`server/modules/database/repositories/sessions.db.ts`、`server/modules/database/repositories/scan-state.db.ts`、`server/modules/providers/services/session-synchronizer.service.ts`、`server/modules/providers/services/sessions-watcher.service.ts`、`server/modules/providers/services/sessions.service.ts`、`server/shared/interfaces.ts` 的 **`IProviderSessionSynchronizer` 段**、新增 publisher port、新增 `scripts/rollback/` | registry、capability、runtime、agent 路由、`interfaces.ts` 的 facet/descriptor 段 | 串行在任务组 1 之后；可独立发布 |
| 3 | `server/shared/interfaces.ts` 的 **facet/descriptor 段**（facet 可选化 + descriptor）、`server/shared/utils.ts` 的 **provider usage 数值解析 utility**、`server/modules/providers/shared/base/abstract.provider.ts`、`server/modules/providers/provider.registry.ts`、`server/modules/providers/services/provider-capabilities.service.ts`、`server/modules/providers/services/provider-token-usage.service.ts`、`server/modules/providers/services/mcp.service.ts`、5 个 `list/*/*.provider.ts` | runtime `.js`、DB、agent 路由、`interfaces.ts` 的 synchronizer 段 | 串行在任务组 2 之后；usage utility 被 Claude/Codex/OpenCode 三个 adapter 共用，按 backend module 规范归入 `server/shared/utils.ts` |
| 4 | 新增 `ProviderRunCoordinator`、`LegacyProviderRuntimeAdapter`、typed runtime 类型（`server/shared/types.ts` 新增分组）、`server/shared/interfaces.ts` 的 **runtime facet 段**、`server/shared/utils.ts` 的 **`createCompleteMessage` 终态契约注释**、`server/modules/providers/services/provider-runtime.service.ts`、provider runtime 相关 tests、4 个 `.js` runtime 与 `pi-runtime.provider.ts` 的接入、Pi characterization test/README、`server/modules/providers/README.md`、adapter 退出追踪文档 | DB 迁移、registry、非 Pi characterization golden | 串行在任务组 3 之后。**注意**：runtime facet 换绑需再次触碰任务组 3 的 `list/*/*.provider.ts`，由串行顺序保证无冲突；`provider-runtime.service.ts` 必须随 typed runtime 签名迁移以保持 application 调用端可编译；Pi typed 签名会要求 characterization 测试改走 coordinator，但不得重录 golden |
| 5 | `server/modules/agent/agent.routes.ts`、`server/modules/agent/agent.module.ts`、新增 agent application module及其直接测试、`server/modules/websocket/services/*`、`server/modules/websocket/README.md` 与直接 transport tests；generic singleton 接线另允许 `server/index.ts`、`server/modules/providers/index.ts`、`server/modules/websocket/index.ts`；5.3 另允许修改 `server/modules/providers/services/sessions.service.ts` 的 run identity 方法、`provider-run-coordinator.service.ts`、`provider-runtime.service.ts`、`server/shared/interfaces.ts` 的 `IProviderSessionIdentityStore` 段及其直接测试；5.4 另允许 `server/shared/interfaces.ts` 的 `IProviderModels` 缺省 run-model 策略字段、`server/modules/providers/services/provider-models.service.ts`、其直接测试及 `server/modules/providers/list/{codex,opencode,pi}/*-models.provider.ts` | 除 5.4 明列三个 model facet 外的 provider `list/`，特别是全部 runtime 文件；5.3 不得修改 DB repository/schema/migration | 串行在任务组 4 之后。**注意**：任务组 2 的 publisher port 生产实现落在 `websocket/services/`，由串行顺序保证无冲突；assembly root/barrel 例外只允许把 Agent 与 WebSocket 绑定到同一 `providerRuntimeService` singleton 并公开既有 application ports，不得加入 provider-id 分支；5.3 的例外仅用于让 coordinator 在向任一 transport 暴露 native identity 前同步持久化并校验 provider ownership，不得扩展 session API；5.4 的例外仅用于把既有 omitted-model 行为移入 provider-owned model seam，不得新增中央 provider-id 映射 |
| 6 | `src/`（frontend model state 收敛、删除 fallback 矩阵、capability 驱动） | backend | 无（可与 5 并行，写集不相交） |
| 7 | 无（只运行验证） | 全部 | 只读 |

- [x] 独占文件按串行顺序去重：2→3→4→5 的重叠点已在表中显式标注，不依赖「无交集」这一不成立的假设。
- [x] 6 与 5 分属 `src/` 与 `server/`，可真正并行。

## 1. Characterization 基线（替换前必须完成）

- [x] 1.1 为 **5 个 provider（claude/codex/cursor/opencode/pi）** 各录制 live event、resume、abort、history、usage、replay 的 golden 输出，落为可重跑的 characterization tests（对应 R15）。
      **录制边界（已决策）**：在各 provider 现有的依赖注入点喂入固定的 native 事件序列，录制**归一化后的事件形状与顺序**作为 golden。不调用真实 CLI——LLM 文本输出不确定，逐条比对不成立。此边界锁定的是适配层行为，锁不住上游 CLI 协议变化，后者由端到端冒烟（7.3）覆盖。
      → 验证：5 份 golden fixture 存在且测试全绿，且测试零网络、零真实进程 spawn。
- [x] 1.2 为「一次 run 恰好一个终态」录制现状基线，**WebSocket 与 HTTP/SSE 两条传输各录一组**（正常/abort/异常各一），作为 R10–R12、R17 的回归锚点。
      → 验证：SSE 基线应如实记录当前**没有**去重的行为（E13b），不得用期望值伪造。
- [x] 1.3 全部基线测试通过并纳入 `npm test`（glob 为 `server/**/*.test.ts`，测试须放在 `server/` 下）；确认后方可进入替换。
      → 验证：`npm test` 全绿且用例数增加。

## 2. Session 身份、per-provider 游标与通知端口（可独立发布）

- [x] 2.1 **迁移前**：对真实库查询 `(provider, provider_session_id)` 重复行（E12），记录并制定合并方案（一票否决门禁）。
      → **已执行**：真实库 `~/.cloudcli/auth.db`，506 行（claude 294 / codex 200 / opencode 6 / pi 6），native id 非空 506 行；**同 provider 重复 0 组，跨 provider 撞号 0 组**。门禁通过，迁移无需有损合并，直接建部分唯一索引即可。结论已回写 design.md 的 E12。
- [x] 2.2 新增迁移：单事务内合并重复行 + 建部分唯一索引 `idx_sessions_provider_native_id`（`WHERE provider_session_id IS NOT NULL`）。因 `migrations.ts` 无 down 机制（E14），同时交付手工回滚脚本 `scripts/rollback/drop-provider-native-id-index.sql`。
      → 验证：R14 通过；回滚脚本在测试库上演练成功（R19）。
- [x] 2.3 `server/modules/database/repositories/sessions.db.ts`：`assignProviderSessionId`/`getSessionByProviderSessionId` 签名加 `provider`（**BREAKING**），merge SQL 的 `WHERE` 加 `provider = ?`；调用方全部更新。补测 R5、R6、R7。
      → 验证：typecheck 列出的全部调用点已改；R5 证明跨 provider 相同 native id 不再互删。
- [x] 2.4 新增 `provider_scan_state` 表（provider 为**开放取值** TEXT 主键，不加枚举约束）与 `scan-state.db.ts` 的 per-provider 读写；`session-synchronizer.service.ts` 改为各 provider 独立推进游标，并移除 `processedByProvider` 的硬编码 5 键字面量（改为从 registry 派生）。补测 R8、R9。

      **迁移须播种旧全局游标，不可留空，且须覆盖全部已注册 provider**：`createSession` / `createProjectPath` 的 upsert 在两条路径上都无条件写 `isArchived = 0`（被 `sessions.db.integration.test.ts` 的 `createSession reactivates archived rows` 锁定），而软删除只改 DB 标志、不删 jsonl 产物。因此空游标导致的首轮全量扫描会把用户已归档的 session 与 project 集体复活。旧全局游标 T 只在**全员成功**的那一轮才推进，故 T 是所有已注册 provider 的有效下界，播种它不会让任何 provider 跳过自己没扫过的产物。
      播种范围**不能按 `sessions` 表现存行推导**：`projects` 表独立于 `sessions`，归档的 project 可由 A provider 建立，而复活它只需**任一** provider 往同一 `project_path` 写一行（`projects.db.ts` 的 upsert 专门 `SET isArchived = 0 WHERE isArchived = 1`）。因此「零 session 行 + 磁盘有产物」的已注册 provider（如 `provider.routes.ts` 的 `?force=true&deletedFromDisk=false` 删行留盘）也必须拿到游标。已注册 provider id 列表由组装根 `server/index.ts` 经 `initializeDatabase` → `runMigrations` **参数注入**，`migrations.ts` 不 import `providerRegistry`，避免 providers→database 的反向运行时环。
      播种仅在 `provider_scan_state` 整表为空时执行一次，故**后续版本新注册的 provider 不会被播种**，仍按 spec 第三 Scenario 走全量扫描。回归测试见 `providers/tests/session-synchronizer-archived-revival.test.ts`。
      → 验证：R8 证明单点失败不阻塞他人游标；新增 provider 无需改动本文件。
- [x] 2.5 `sessions-watcher.service.ts` 的 watch roots 改由各 synchronizer 提供，移除中央 `PROVIDER_WATCH_PATHS`；同步更新引用该常量的 `providers/tests/sessions-watcher-paths.test.ts`。
      → 验证：常量不再存在，测试改为断言「roots 来自 registry 中的 provider」。
- [x] 2.6 引入 application-owned session change publisher port（生产=WebSocket adapter，测试=内存），移除 `providers/services/sessions.service.ts:6` 与 `providers/services/sessions-watcher.service.ts:10` 对 `@/modules/websocket/index.js` 的 import。补测 R16（依赖扫描）。
      → 验证：R16 静态扫描零命中。
- [x] 2.7 阶段验收：`npm test` + typecheck 全绿，characterization（1.1）保持全绿。此点可独立发布。
      **发布前必须单独评估的叠加风险（2.3 审查提出）**：2.2 的迁移把同 provider 重复行的败者 `provider_session_id` 置 NULL 产生孤儿行，而这些孤儿正是 `findLatestPendingAppSession`（仅 opencode synchronizer 调用）的候选集，可能把新 session 的 native id 错绑到旧对话。
      真实库零实例（E12 已证 0 组重复），故本地不可达；但**发布正是把迁移推向未知安装环境的时刻**，这是该风险唯一能被触发的场景。后果为标题/绑定错位，不删数据、可由重扫纠正（2.3 的 provider 限定已确保它不会再引发跨 provider 删行）。
      可选加固：给 `findLatestPendingAppSession` 加时间下界，把迁移孤儿排除出候选集。
      → 验证：叠加风险已评估并给出结论（加固或接受），有留证方可发布。

## 2 的遗留待办（不阻塞本 change，须在 7.4 前有结论）

- [x] D1 `/sessions/:sessionId` 深链改为携带 provider（需同步改 `provider.routes.ts` 与 `src/hooks/useProjectsState.ts`），完成后删除 `getSessionByProviderSessionIdAcrossProviders`。
      **背景**：该方法是对 spec「所有 native session 的查找 SHALL 携带 provider」的一处**已知偏差**。深链 URL 只带裸 id，服务端无从得知 provider，改正需动 HTTP 契约与前端，超出任务组 2 的文件归属。
      现状为只读 best-effort（`ORDER BY updated_at DESC LIMIT 1`），行为与 HEAD 逐字节相同——是**未消除的既有风险**，非新增。不写不删，故不违反该 Requirement 的两条 SHALL NOT。
      残留瑕疵：两 provider 撞号时深链会解析到 `updated_at` 较新的那行。真实库 0 组撞号，当前不可达。
- [x] D2 `sessions.db.ts` 的 merge 重复行查询是 `LIMIT 1` 且无 `ORDER BY`，命中多行时选谁由 SQLite 决定。
      2.2 建唯一索引后存在构造性路径会让事务抛 UNIQUE 约束错（同 provider 下 A 的 `session_id` 等于目标 native id 但 `provider_session_id` 是别的值，同时 B 的 `provider_session_id` 等于该 native id）。
      该场景**先于 2.3 存在**，本次是「静默删数据」变为「抛错回滚不删数据」，方向正确、非新增数据丢失路径。加固方向：给 `LIMIT 1` 补 `ORDER BY`（`provider_session_id = ?` 优先）。
- [x] D3 `notifications/services/notification-orchestrator.service.js` 因签名传导被改了 1 行，仍是 `.js`，与 `backend-module-standards`「touched JS 迁 TS」冲突。
      整文件迁 TS 与「手术式修改」及任务组 2 的文件归属（notifications 模块不在其独占列表）冲突，建议单独立项。

## 3. Registry descriptor、capability 单一真相与 facet 可选化

- [x] 3.1 在 `interfaces.ts` 引入 `ProviderDescriptor` 与 `ProviderDefinition`；descriptor 承载 7 个静态能力字段（`permissionModes`、`defaultPermissionMode`、`supportsImages`、`supportsFiles`、`supportsAbort`、`supportsPermissionRequests`、`supportsEffort`）。
      → 验证：7 个字段在 descriptor 中有类型与文档注释。
- [x] 3.2 将 `mcp`/`skills` 改为 optional、新增 optional `usage`（**BREAKING**）；同步修改 `abstract.provider.ts` 的 `abstract readonly` 声明。运行 typecheck 得到全部待改实现点清单。
      → 验证：typecheck 报错清单即待改点清单，逐条消除。
- [x] 3.3 重塑 `ProviderRegistry`：`listProviders`/`resolveProvider`/`requireFacet`、注册期 descriptor 校验（`defaultPermissionMode` 必须 ∈ `permissionModes`，否则 `ERR-PROVIDER-DESCRIPTOR-INVALID`）。补测 R2、R4。
      → 验证：R2/R4 错误码精确匹配。
- [x] 3.4 capability response 改为「7 个 descriptor 字段直出 + 3 个 `supportsX`（mcp/skills/tokenUsage）由 facet 存在性派生」，删除 `provider-capabilities.service.ts` 的中央静态矩阵。补测 R1、R3、R18。
      → 验证：R18 证明新增 provider 无需改动 capability service。
- [x] 3.5 `provider-token-usage.service.ts` 改为 optional usage facet 派发，移除逐 provider `if` 与 `.claude` 默认回退；cursor 因无 usage facet 改为返回 `PROVIDER_CAPABILITY_UNSUPPORTED`（**BREAKING**，见 proposal）。
      → 验证：文件中不再出现 `session.provider === '<id>'`；R3 覆盖 cursor 路径。
- [x] 3.6 5 个 provider 的 `*.provider.ts` 按 optional facet 重新挂载并提供 descriptor：不支持者不挂载对应 facet，删除 `PiMcpProvider` 这类临时空实现 adapter。
      → 验证：`PiMcpProvider` 文件删除；Pi 的 MCP 读路径返回 `PROVIDER_CAPABILITY_UNSUPPORTED`。
- [x] 3.7 核对 `mcp.service.ts` 聚合层：确认其已有的 `PROVIDER_CAPABILITY_UNSUPPORTED` 处理（第 73、102 行）在读路径同样生效，全局 MCP 列表不因某 provider 不支持而整体失败。
      → 验证：全局 MCP 列表在含 Pi 的情况下仍返回其他 provider 的数据。
- [x] 3.8 阶段验收：characterization（1.1）除 proposal 列明的三处 BREAKING 外保持全绿；BREAKING 项更新 golden 并在 commit 说明中标注。

## 4. Typed runtime 与 coordinator

前置认知（design 决策 3）：WS 路径的终态唯一性今天已由 `chatRunRegistry` 保证；本任务组的新增收益是为 **SSE 路径止血** 建立 transport-neutral coordinator，并 **消除 4 套重复簿记**。真实 SSE 止血还依赖任务 5.3 的 HTTP abort 入口与路由接线，不能把 4.2 + 4.5 单独宣称为可发布的最小子集。

- [x] 4.1 定义 typed `ProviderRunRequest` / `IProviderEventSink`（类型层排除 `complete`/`session_created`）/ `ProviderRunOutcome`，放入 `server/shared/types.ts` 与 `interfaces.ts` 的新增分组（按仓库规范加分组注释）。
      → 验证：typecheck 通过；类型层确实无法表达 `complete`。
- [x] 4.2 实现 `ProviderRunCoordinator`：校验/身份/生命周期/**唯一终态**/replay 保留，成为终态唯一生产者。补测 R10、R11、R12。
      → 验证：R10–R12 的 transport-neutral contract 通过；现有 `chatRunRegistry` replay/序号基线保持全绿，真实 WS 与 SSE 接线证据在任务组 5 完成。
- [x] 4.3 实现 `LegacyProviderRuntimeAdapter`：typed request↔旧 options、旧 writer event↔typed sink、`abort(sessionId)`↔`AbortSignal`，拦截旧 runtime 的 `complete/session_created`。文件头注明**退出条件**与任务 4.6。补测 R13。
      → 验证：R13 证明 legacy runtime 发出的 `complete` 被拦截。
- [x] 4.4 逐个接入 4 个 `.js` runtime，**一次一个、每个独立验证**，顺序 claude → codex → cursor → opencode（按 E13c 簿记复杂度从高到低）。每接入一个即移除该 runtime 内部的终态簿记（`abortedSessionIds` / `session.status` / `completeSent` / `process.aborted`）。
      **前置发现（任务 1.1 审查实测）之一**：`cursor-runtime.provider.js:33` 的 `spawnCursor` 用 `new Promise(async (resolve, reject) => {...})` 反模式，第 48 行 `await context.resolveResumeModel(...)` 一旦拒绝，rejection 逃逸为 unhandled rejection，run promise **永不 settle**。接入 coordinator 时必须一并修正此反模式，否则 cursor 的失败终态无法交给 coordinator。这也是 `cursor.runtime-failure-terminal` golden 缺席、`cursor.resume` 改用"挂起而非拒绝"录制的原因。
      **前置发现（任务 1.1 审查实测）之二**：4 个 `.js` runtime 的 abort characterization **只锁定了 unknown-session 分支**（`{"abortUnknownSession": false}`）。`abortedSessionIds` / `process.aborted` / `session.status` / `completeSent` 的终态抢占簿记因 active-session map 为模块私有、无写入接缝而**无基线保护**。移除这些簿记时 characterization 不会报警，必须靠 R11/R12 与 7.3 冒烟兜底。
      → 验证：每个 runtime 接入后其 characterization（1.1）单独跑绿方可进行下一个。
- [x] 4.5 `pi-runtime.provider.ts` **直接实现 typed 接口**（已是 TypeScript，不经过 legacy adapter），保持 `agent_settled` 作为成功 outcome 的唯一依据。
      → 验证：Pi characterization 全绿；`agent_settled` 之前的进程退出仍产生失败终态。
- [x] 4.6 记录 adapter 退出条件到追踪项：4 个 `.js` runtime 迁 TS 并直接实现 typed 接口后删除 `LegacyProviderRuntimeAdapter`（符合 `backend-module-standards` 的全 TS 要求）。本 change 内不要求完成迁 TS，但必须留下明确的退出任务而非无限期保留。
      → 验证：追踪项已建立且被 adapter 文件头引用。

## 5. Generic dispatcher 与去 @ts-nocheck

`agent.routes.ts` 为 1301 行、带 `@ts-nocheck`，是本 change 单点最大改动，按下列子步骤分次提交，每步独立可回滚。

- [x] 5.1 只读盘点：列出 `agent.routes.ts` 中全部业务编排片段与其依赖，产出提取清单（不改代码）。
      → 验证：清单覆盖第 21-25 行依赖注入与第 987-1035 行 dispatch 分支。
- [x] 5.2 新建 agent application module（TypeScript，无 `@ts-nocheck`），迁入**非 dispatch** 的编排逻辑（会话解析、附件处理、历史拼装等），route 侧改为调用。
      → 验证：`agent.routes.ts` 行数下降；现有 `agent/tests/agent.routes.test.ts` 全绿。
- [x] 5.3 SSE writer 路径接入 coordinator（止血 E13b），HTTP 与 WebSocket 两条传输走同一终态所有者。补测 R17。
      **前置发现（任务 1.2 审查实测）**：`agent.routes.ts` 全文**没有 abort 入口**——HTTP/SSE 路径今天根本无法发起 abort。因此 1.2 录制的 R17 基线是在 writer 接缝上模拟 abort 终态。本任务若要让 R17 真正成立，**必须先为 SSE 路径补上 abort 通路**，否则 R17 转绿仍只是 writer 层的模拟。
      **接线约束**：Agent HTTP 自行分配的 app session 必须在 runtime 启动前建行，首次 native binding 必须在 writer/SSE/WS 可见前同步持久化；resume lookup 必须携带 selected provider，跨 provider app id 按既有 `SESSION_NOT_FOUND` fail-closed。coordinator 是 mapping 持久化唯一所有者，WebSocket registry 仅维护 replay/broadcast，不得二次写库。
      → 验证：R17 证明 SSE 请求在 abort + 迟到事件下恰好一个终态，且 abort 经由真实路由入口触发；真实 HTTP new→resume 保持 app id/native id 映射，跨 provider resume 在目标 runtime 启动前被拒绝；WS mapping 仅写一次。
- [x] 5.4 删除 `queryClaude/queryCursor/queryCodex/queryOpenCode/queryPi` 依赖项与逐 provider `if/else`，改为 generic coordinator 派发；同步更新 `agent.module.ts` 的依赖装配。缺省 model 行为由 `IProviderModels` 的 provider-owned 策略表达：Claude/Cursor 保持 implicit runtime/CLI default，Codex/OpenCode/Pi 保持 catalog `DEFAULT`；Agent route/service 不得出现 provider-id 策略分支。
      → 验证：Agent 文件中无 `provider === '<id>'`、无五个 `queryX`、无 provider whitelist；五 provider 未传 model 的 runtime 输入与重构前一致，新增 runtime-registered test provider 无需修改 Agent。
- [x] 5.5 移除 `agent.routes.ts` 的 `@ts-nocheck`，typecheck 通过（其余 7 个带 `@ts-nocheck` 的文件不在本 change 范围）。
      → 验证：`npm run typecheck` 全绿。

## 6. Frontend state 收敛

- [x] 6.1 model state 由逐 provider（`claudeModel`/`cursorModel`/`codexModel`/`opencodeModel`/`piModel`）收敛为 `Partial<Record<LLMProvider,string>>`，统一初始化/localStorage/catalog 校验/setter；更新 4 个消费组件。
      → 验证：`grep -c 'claudeModel' src` 为 0；model restore 行为不回归。
- [x] 6.2 删除 `useChatProviderState.ts` 的静态 fallback 权限矩阵（design 决策 6）；capability 未就绪期间 picker 呈禁用骨架，不猜测默认权限模式。补测 R20。
      → 验证：R20 通过——断网/接口 500 时 picker 显示禁用态而非错误默认值。
- [x] 6.3 permission/effort/usage/mcp/skills 显示改由 backend capability response 驱动；`providerEffort.ts` 的 `FALLBACK_PROVIDER_EFFORT_VALUES` 随之移除或退化为纯类型。前端仅保留 logo/展示名/i18n key 等静态品牌映射。
      **顺带处理（任务 6.1 审查发现）**：`ProviderSelectionEmptyState.tsx` 对 `providerModels[provider]` 的兜底用 `?? ""`，而 hook 内部统一用 `?? FALLBACK_DEFAULT_MODEL[provider]`。当前初始化会填满全部键故不可达，但类型已是 `Partial<>`，两处兜底不一致是隐患，本任务一并统一。
      → 验证：新增 provider 时前端只需改品牌映射；兜底策略全仓一致。

## 7. 验证

- [x] 7.1 characterization + 契约测试（R1–R20）全绿。
- [x] 7.2 `npm run build`、`npm run typecheck`、`npm run lint`、`npm test` 全绿。
- [ ] 7.3 端到端冒烟：5 个 provider（含 Pi）新建/resume/abort/reconnect/history/sidebar/model restore 不回归；HTTP 与 WebSocket 两条传输各跑一遍。
- [x] 7.4 验证中央点收敛达成度：加一个测试 provider 时，改动**仅限**三处——`LLMProvider` 联合、registry 注册、前端品牌映射；**不需要**改动 capability service、token usage service、watcher、synchronizer、mcp service、agent route、abstract provider。
      → 验证：以 diff 逐文件列举，超出三处即未达成。
- [x] 7.5 回滚演练（R19）：在测试库上执行 `scripts/rollback/drop-provider-native-id-index.sql` 并确认旧代码可正常运行。
