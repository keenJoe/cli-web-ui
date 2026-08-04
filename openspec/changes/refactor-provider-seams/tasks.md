# Provider 公共接缝重构 实现任务

「构建什么」见 `specs/provider-seams/spec.md`，「怎么构建」见 `design.md`。

**前置约束**：
- Pi 代码已合入主干，代码层无阻塞。剩余前置是文档流程：`add-pi-provider` 归档、`pi-provider` 进入 `openspec/specs/`。
- characterization tests（任务组 1）必须先于任何替换完成并通过。
- 任务组 2（session 身份）修复的是生产环境正在删数据的缺陷，**可独立发布**，不必等待后续任务组。

## 0. 文件归属

路径已按真实仓库核实：数据库源码在 `server/modules/database/`，仓库根 `database/` 仅含 `auth.db` 二进制文件。

| 任务组 | 独占文件/目录 | 禁止改动 | 共享文件处理 |
|---|---|---|---|
| 1 | `server/modules/providers/tests/characterization/`、`server/modules/websocket/tests/` 与 `server/modules/agent/tests/` 新增用例 | 生产代码 | 只读生产代码，仅新增测试 |
| 2 | `server/modules/database/schema.ts`、`server/modules/database/migrations.ts`、`server/modules/database/repositories/sessions.db.ts`、`server/modules/database/repositories/scan-state.db.ts`、`server/modules/providers/services/session-synchronizer.service.ts`、`server/modules/providers/services/sessions-watcher.service.ts`、`server/modules/providers/services/sessions.service.ts`、新增 publisher port、新增 `scripts/rollback/` | registry、capability、runtime、agent 路由 | 串行在任务组 1 之后；可独立发布 |
| 3 | `server/shared/interfaces.ts`（facet 可选化 + descriptor）、`server/modules/providers/shared/base/abstract.provider.ts`、`server/modules/providers/provider.registry.ts`、`server/modules/providers/services/provider-capabilities.service.ts`、`server/modules/providers/services/provider-token-usage.service.ts`、`server/modules/providers/services/mcp.service.ts`、5 个 `list/*/*.provider.ts` | runtime `.js`、DB、agent 路由 | 串行在任务组 2 之后 |
| 4 | 新增 `ProviderRunCoordinator`、`LegacyProviderRuntimeAdapter`、typed runtime 类型（`server/shared/types.ts` 新增分组）、4 个 `.js` runtime 与 `pi-runtime.provider.ts` 的接入 | DB 迁移、registry | 串行在任务组 3 之后。**注意**：runtime facet 换绑需再次触碰任务组 3 的 `list/*/*.provider.ts`，由串行顺序保证无冲突 |
| 5 | `server/modules/agent/agent.routes.ts`、`server/modules/agent/agent.module.ts`、新增 agent application module、`server/modules/websocket/services/*` | provider `list/` | 串行在任务组 4 之后。**注意**：任务组 2 的 publisher port 生产实现落在 `websocket/services/`，由串行顺序保证无冲突 |
| 6 | `src/`（frontend model state 收敛、删除 fallback 矩阵、capability 驱动） | backend | 无（可与 5 并行，写集不相交） |
| 7 | 无（只运行验证） | 全部 | 只读 |

- [x] 独占文件按串行顺序去重：2→3→4→5 的重叠点已在表中显式标注，不依赖「无交集」这一不成立的假设。
- [x] 6 与 5 分属 `src/` 与 `server/`，可真正并行。

## 1. Characterization 基线（替换前必须完成）

- [ ] 1.1 为 **5 个 provider（claude/codex/cursor/opencode/pi）** 各录制 live event、resume、abort、history、usage、replay 的 golden 输出，落为可重跑的 characterization tests（对应 R15）。
      → 验证：5 份 golden fixture 存在且测试全绿。
- [ ] 1.2 为「一次 run 恰好一个终态」录制现状基线，**WebSocket 与 HTTP/SSE 两条传输各录一组**（正常/abort/异常各一），作为 R10–R12、R17 的回归锚点。
      → 验证：SSE 基线应如实记录当前**没有**去重的行为（E13b），不得用期望值伪造。
- [ ] 1.3 全部基线测试通过并纳入 `npm test`（glob 为 `server/**/*.test.ts`，测试须放在 `server/` 下）；确认后方可进入替换。
      → 验证：`npm test` 全绿且用例数增加。

## 2. Session 身份、per-provider 游标与通知端口（可独立发布）

- [ ] 2.1 **迁移前**：对真实库查询 `(provider, provider_session_id)` 重复行（E12），记录并制定合并方案（一票否决门禁）。
      → 验证：查询结果与合并方案留证，无留证不得进入 2.2。
- [ ] 2.2 新增迁移：单事务内合并重复行 + 建部分唯一索引 `idx_sessions_provider_native_id`（`WHERE provider_session_id IS NOT NULL`）。因 `migrations.ts` 无 down 机制（E14），同时交付手工回滚脚本 `scripts/rollback/drop-provider-native-id-index.sql`。
      → 验证：R14 通过；回滚脚本在测试库上演练成功（R19）。
- [ ] 2.3 `server/modules/database/repositories/sessions.db.ts`：`assignProviderSessionId`/`getSessionByProviderSessionId` 签名加 `provider`（**BREAKING**），merge SQL 的 `WHERE` 加 `provider = ?`；调用方全部更新。补测 R5、R6、R7。
      → 验证：typecheck 列出的全部调用点已改；R5 证明跨 provider 相同 native id 不再互删。
- [ ] 2.4 新增 `provider_scan_state` 表（provider 为**开放取值** TEXT 主键，不加枚举约束）与 `scan-state.db.ts` 的 per-provider 读写；`session-synchronizer.service.ts` 改为各 provider 独立推进游标，并移除 `processedByProvider` 的硬编码 5 键字面量（改为从 registry 派生）。补测 R8、R9。
      → 验证：R8 证明单点失败不阻塞他人游标；新增 provider 无需改动本文件。
- [ ] 2.5 `sessions-watcher.service.ts` 的 watch roots 改由各 synchronizer 提供，移除中央 `PROVIDER_WATCH_PATHS`；同步更新引用该常量的 `providers/tests/sessions-watcher-paths.test.ts`。
      → 验证：常量不再存在，测试改为断言「roots 来自 registry 中的 provider」。
- [ ] 2.6 引入 application-owned session change publisher port（生产=WebSocket adapter，测试=内存），移除 `providers/services/sessions.service.ts:6` 与 `providers/services/sessions-watcher.service.ts:10` 对 `@/modules/websocket/index.js` 的 import。补测 R16（依赖扫描）。
      → 验证：R16 静态扫描零命中。
- [ ] 2.7 阶段验收：`npm test` + typecheck 全绿，characterization（1.1）保持全绿。此点可独立发布。

## 3. Registry descriptor、capability 单一真相与 facet 可选化

- [ ] 3.1 在 `interfaces.ts` 引入 `ProviderDescriptor` 与 `ProviderDefinition`；descriptor 承载 7 个静态能力字段（`permissionModes`、`defaultPermissionMode`、`supportsImages`、`supportsFiles`、`supportsAbort`、`supportsPermissionRequests`、`supportsEffort`）。
      → 验证：7 个字段在 descriptor 中有类型与文档注释。
- [ ] 3.2 将 `mcp`/`skills` 改为 optional、新增 optional `usage`（**BREAKING**）；同步修改 `abstract.provider.ts` 的 `abstract readonly` 声明。运行 typecheck 得到全部待改实现点清单。
      → 验证：typecheck 报错清单即待改点清单，逐条消除。
- [ ] 3.3 重塑 `ProviderRegistry`：`listProviders`/`resolveProvider`/`requireFacet`、注册期 descriptor 校验（`defaultPermissionMode` 必须 ∈ `permissionModes`，否则 `ERR-PROVIDER-DESCRIPTOR-INVALID`）。补测 R2、R4。
      → 验证：R2/R4 错误码精确匹配。
- [ ] 3.4 capability response 改为「7 个 descriptor 字段直出 + 3 个 `supportsX`（mcp/skills/tokenUsage）由 facet 存在性派生」，删除 `provider-capabilities.service.ts` 的中央静态矩阵。补测 R1、R3、R18。
      → 验证：R18 证明新增 provider 无需改动 capability service。
- [ ] 3.5 `provider-token-usage.service.ts` 改为 optional usage facet 派发，移除逐 provider `if` 与 `.claude` 默认回退；cursor 因无 usage facet 改为返回 `PROVIDER_CAPABILITY_UNSUPPORTED`（**BREAKING**，见 proposal）。
      → 验证：文件中不再出现 `session.provider === '<id>'`；R3 覆盖 cursor 路径。
- [ ] 3.6 5 个 provider 的 `*.provider.ts` 按 optional facet 重新挂载并提供 descriptor：不支持者不挂载对应 facet，删除 `PiMcpProvider` 这类临时空实现 adapter。
      → 验证：`PiMcpProvider` 文件删除；Pi 的 MCP 读路径返回 `PROVIDER_CAPABILITY_UNSUPPORTED`。
- [ ] 3.7 核对 `mcp.service.ts` 聚合层：确认其已有的 `PROVIDER_CAPABILITY_UNSUPPORTED` 处理（第 73、102 行）在读路径同样生效，全局 MCP 列表不因某 provider 不支持而整体失败。
      → 验证：全局 MCP 列表在含 Pi 的情况下仍返回其他 provider 的数据。
- [ ] 3.8 阶段验收：characterization（1.1）除 proposal 列明的三处 BREAKING 外保持全绿；BREAKING 项更新 golden 并在 commit 说明中标注。

## 4. Typed runtime 与 coordinator

前置认知（design 决策 3）：WS 路径的终态唯一性今天已由 `chatRunRegistry` 保证；本任务组的新增收益是 **SSE 路径止血** 与 **消除 4 套重复簿记**。若排期紧张，4.2 + 4.5 可作为最小止血子集先行交付。

- [ ] 4.1 定义 typed `ProviderRunRequest` / `IProviderEventSink`（类型层排除 `complete`/`session_created`）/ `ProviderRunOutcome`，放入 `server/shared/types.ts` 与 `interfaces.ts` 的新增分组（按仓库规范加分组注释）。
      → 验证：typecheck 通过；类型层确实无法表达 `complete`。
- [ ] 4.2 实现 `ProviderRunCoordinator`：校验/身份/生命周期/**唯一终态**/replay 保留，成为终态唯一生产者。补测 R10、R11、R12。
      → 验证：R10–R12 通过。
- [ ] 4.3 实现 `LegacyProviderRuntimeAdapter`：typed request↔旧 options、旧 writer event↔typed sink、`abort(sessionId)`↔`AbortSignal`，拦截旧 runtime 的 `complete/session_created`。文件头注明**退出条件**与任务 4.6。补测 R13。
      → 验证：R13 证明 legacy runtime 发出的 `complete` 被拦截。
- [ ] 4.4 逐个接入 4 个 `.js` runtime，**一次一个、每个独立验证**，顺序 claude → codex → cursor → opencode（按 E13c 簿记复杂度从高到低）。每接入一个即移除该 runtime 内部的终态簿记（`abortedSessionIds` / `session.status` / `completeSent` / `process.aborted`）。
      → 验证：每个 runtime 接入后其 characterization（1.1）单独跑绿方可进行下一个。
- [ ] 4.5 `pi-runtime.provider.ts` **直接实现 typed 接口**（已是 TypeScript，不经过 legacy adapter），保持 `agent_settled` 作为成功 outcome 的唯一依据。
      → 验证：Pi characterization 全绿；`agent_settled` 之前的进程退出仍产生失败终态。
- [ ] 4.6 记录 adapter 退出条件到追踪项：4 个 `.js` runtime 迁 TS 并直接实现 typed 接口后删除 `LegacyProviderRuntimeAdapter`（符合 `backend-module-standards` 的全 TS 要求）。本 change 内不要求完成迁 TS，但必须留下明确的退出任务而非无限期保留。
      → 验证：追踪项已建立且被 adapter 文件头引用。

## 5. Generic dispatcher 与去 @ts-nocheck

`agent.routes.ts` 为 1301 行、带 `@ts-nocheck`，是本 change 单点最大改动，按下列子步骤分次提交，每步独立可回滚。

- [ ] 5.1 只读盘点：列出 `agent.routes.ts` 中全部业务编排片段与其依赖，产出提取清单（不改代码）。
      → 验证：清单覆盖第 21-25 行依赖注入与第 987-1035 行 dispatch 分支。
- [ ] 5.2 新建 agent application module（TypeScript，无 `@ts-nocheck`），迁入**非 dispatch** 的编排逻辑（会话解析、附件处理、历史拼装等），route 侧改为调用。
      → 验证：`agent.routes.ts` 行数下降；现有 `agent/tests/agent.routes.test.ts` 全绿。
- [ ] 5.3 SSE writer 路径接入 coordinator（止血 E13b），HTTP 与 WebSocket 两条传输走同一终态所有者。补测 R17。
      → 验证：R17 证明 SSE 请求在 abort + 迟到事件下恰好一个终态。
- [ ] 5.4 删除 `queryClaude/queryCursor/queryCodex/queryOpenCode/queryPi` 依赖项与逐 provider `if/else`，改为 generic coordinator 派发；同步更新 `agent.module.ts` 的依赖装配。
      → 验证：文件中不再出现 `provider === '<id>'`。
- [ ] 5.5 移除 `agent.routes.ts` 的 `@ts-nocheck`，typecheck 通过（其余 7 个带 `@ts-nocheck` 的文件不在本 change 范围）。
      → 验证：`npm run typecheck` 全绿。

## 6. Frontend state 收敛

- [ ] 6.1 model state 由逐 provider（`claudeModel`/`cursorModel`/`codexModel`/`opencodeModel`/`piModel`）收敛为 `Partial<Record<LLMProvider,string>>`，统一初始化/localStorage/catalog 校验/setter；更新 4 个消费组件。
      → 验证：`grep -c 'claudeModel' src` 为 0；model restore 行为不回归。
- [ ] 6.2 删除 `useChatProviderState.ts` 的静态 fallback 权限矩阵（design 决策 6）；capability 未就绪期间 picker 呈禁用骨架，不猜测默认权限模式。补测 R20。
      → 验证：R20 通过——断网/接口 500 时 picker 显示禁用态而非错误默认值。
- [ ] 6.3 permission/effort/usage/mcp/skills 显示改由 backend capability response 驱动；`providerEffort.ts` 的 `FALLBACK_PROVIDER_EFFORT_VALUES` 随之移除或退化为纯类型。前端仅保留 logo/展示名/i18n key 等静态品牌映射。
      → 验证：新增 provider 时前端只需改品牌映射。

## 7. 验证

- [ ] 7.1 characterization + 契约测试（R1–R20）全绿。
- [ ] 7.2 `npm run build`、`npm run typecheck`、`npm run lint`、`npm test` 全绿。
- [ ] 7.3 端到端冒烟：5 个 provider（含 Pi）新建/resume/abort/reconnect/history/sidebar/model restore 不回归；HTTP 与 WebSocket 两条传输各跑一遍。
- [ ] 7.4 验证中央点收敛达成度：加一个测试 provider 时，改动**仅限**三处——`LLMProvider` 联合、registry 注册、前端品牌映射；**不需要**改动 capability service、token usage service、watcher、synchronizer、mcp service、agent route、abstract provider。
      → 验证：以 diff 逐文件列举，超出三处即未达成。
- [ ] 7.5 回滚演练（R19）：在测试库上执行 `scripts/rollback/drop-provider-native-id-index.sql` 并确认旧代码可正常运行。
