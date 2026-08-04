# Provider 公共接缝重构设计

## 背景

动机见 proposal.md - Why。本 change 是 `add-pi-provider` 切出的另一半，范围包含把已存在的 5 个 provider 都迁进新接缝。

Pi 的**代码**已合入主干（`11fc015`、`6c5089b`），中央文件在代码层已无冲突；剩余前置是**文档流程**：`add-pi-provider` 归档、`pi-provider` 进入 `openspec/specs/`。

重构采用 Feathers「先加接缝、按可观测契约测试、再替换」的路线：先补齐 characterization tests（见 test-definition.md），再逐层替换，避免大范围一次性重写引入回归。

**阶段排序原则**：按「风险 × 独立性」排，不按「概念整洁度」排。阶段 1（session 身份）修复的是**正在生产环境删数据**的缺陷，且与 registry/capability 重构无任何依赖关系，因此排在最前并可独立发布；能力表达重构是纯维护性收益，排在其后。

## 证据登记

所有路径已按真实仓库结构核实。数据库代码位于 `server/modules/database/`，仓库根目录的 `database/` 目录只含一个 `auth.db` 二进制文件，不含源码。

| 编号 | 标签 | 陈述 | 依据 | 风险 |
|---|---|---|---|---|
| E1 | `[CONFIRMED]` | registry 仅是 `Record<LLMProvider,IProvider>` + `resolveProvider`，无 descriptor/facet 概念，全文件 38 行 | `server/modules/providers/provider.registry.ts:10-37` | 低 |
| E2 | `[CONFIRMED]` | `IProvider` 的 `mcp`/`skills` 为必选 readonly，非 optional；`AbstractProvider` 以 `abstract readonly` 同步声明 | `server/shared/interfaces.ts:47-56`（mcp:51, skills:53）、`server/modules/providers/shared/base/abstract.provider.ts:19-27`（mcp:23, skills:25） | 中 |
| E3 | `[CONFIRMED]` | capability 为中央手写静态矩阵，共 9 个字段；其中**没有** `supportsMcp`/`supportsSkills` | `server/modules/providers/services/provider-capabilities.service.ts:11-95` | 低 |
| E3b | `[CONFIRMED]` | 9 个字段里只有 `supportsTokenUsage` 可由 facet 派生；其余 7 个（`permissionModes`/`defaultPermissionMode`/`supportsImages`/`supportsFiles`/`supportsAbort`/`supportsPermissionRequests`/`supportsEffort`）是 provider 固有静态数据，无法由 facet 存在性推出 | 同上 | 中 |
| E3c | `[CONFIRMED]` | 前端另有一份静态 fallback 权限矩阵（第三份真相），在 capability 响应到达前使用 | `src/components/chat/hooks/useChatProviderState.ts:37-40` | 中 |
| E4 | `[CONFIRMED]` | token-usage 逐 provider `if`（cursor/opencode/codex/pi），未命中无条件落 `.claude` 目录；cursor 分支返回 200 空成功而非错误 | `provider-token-usage.service.ts:270,282,294,315,349` | 中 |
| E5 | `[CONFIRMED]` | watcher 路径为中央常量 `PROVIDER_WATCH_PATHS`，并被测试直接引用 | `sessions-watcher.service.ts:16,273`；`providers/tests/sessions-watcher-paths.test.ts:5` | 低 |
| E6 | `[CONFIRMED]` | 各 synchronizer 经 `Promise.allSettled` 独立执行，但只要**任一**失败就跳过全局游标推进；`processedByProvider` 是硬编码 5 键字面量 | `session-synchronizer.service.ts:20-26,29,46-52` | 中 |
| E7 | `[CONFIRMED]` | native lookup/merge 签名不含 provider；merge SQL 为 `WHERE (session_id = ? OR provider_session_id = ?)` 且命中后 `DELETE` 对方行 —— **当前生产环境的静默数据丢失路径** | `server/modules/database/repositories/sessions.db.ts:179,185-193,263-273` | 高 |
| E8 | `[CONFIRMED]` | agent 路由 `@ts-nocheck`（第 1 行）、5 个 `queryX` 依赖注入、逐 provider `if/else`；文件 1301 行 | `server/modules/agent/agent.routes.ts:1,21-25,987-1035` | 中 |
| E9 | `[CONFIRMED]` | `IProviderRuntime.run(command, options:AnyRecord, writer, context)`，`abort(sessionId)`；`ProviderRuntimeWriter.send(data: unknown)` 全无类型，并带 `isWebSocketWriter`/`isSSEStreamWriter` 传输标记 | `server/shared/interfaces.ts:30-39`、`server/shared/types.ts:287-293` | 中 |
| E10 | `[CONFIRMED]` | runtime 中**只有 4 个是 `.js`**（claude/codex/cursor/opencode）；**Pi runtime 已是 TypeScript** | `list/{claude,codex,cursor,opencode}/*-runtime.provider.js`、`list/pi/pi-runtime.provider.ts` | 低 |
| E11 | `[CONFIRMED]` | 已有 provider-native mapping 测试存在，路径在 `server/` 下（不在根 `database/`），已被 `npm test` 的 `server/**/*.test.ts` glob 覆盖 | `server/modules/database/tests/sessions-provider-mapping.test.ts` | 中 |
| E12 | `[PENDING_VERIFY]` | 现网 `sessions` 表是否已存在跨 provider 相同 native id 的碰撞行 | 迁移前须对真实库查询确认 | 高 |
| E13 | `[CONFIRMED]` | **WebSocket 路径已经实现「恰好一个终态」**：`decorateAndRecordEvent` 对 `complete` 做 first-wins 去重，注释明写 "Exactly-one-complete contract" | `websocket/services/chat-run-registry.service.ts:129-136`（注释 130，去重判断 134，接线 244） | 高 |
| E13b | `[CONFIRMED]` | **HTTP/SSE 路径不走 `chatRunRegistry`**，因此没有任何终态去重；`agent.routes.ts` 自建 SSE writer | `agent.routes.ts:486`；`chatRunRegistry` 仅被 `chat-websocket.service.ts` 引用 | 高 |
| E13c | `[CONFIRMED]` | 4 个 `.js` runtime 各自维护一套**互不相同**的终态簿记：claude 用模块级 `abortedSessionIds` Set、codex 用 `session.status`+`abortController.signal`、cursor/opencode 用 `completeSent`+`process.aborted` | `claude-runtime.provider.js:42,703`；`codex-runtime.provider.js:377,399`；`cursor-runtime.provider.js:307,336`；`opencode-runtime.provider.js:348,391` | 中 |
| E14 | `[CONFIRMED]` | 迁移系统是**只进不退**的：单个 `runMigrations` 幂等函数，靠 `tableExists`/`PRAGMA table_info` 判断，**无版本表、无 down migration 机制** | `server/modules/database/migrations.ts:1-495`（运行入口 440-495） | 高 |
| E15 | `[CONFIRMED]` | `sessions(provider_session_id)` 上已有非唯一索引 `idx_sessions_provider_session_id`；`sessions` 表无任何唯一约束（除 `PRIMARY KEY (session_id)`） | `migrations.ts:473`、`schema.ts:100-123` | 低 |
| E16 | `[CONFIRMED]` | `PROVIDER_CAPABILITY_UNSUPPORTED` 错误码**已存在于代码库**，Pi 的 MCP 写操作抛出、`mcp.service` 聚合层已处理；但 Pi 的 MCP **读**操作返回 200 空成功 | `list/pi/pi-mcp.provider.ts:13-18`（unsupported 抛出）、`28-33`/`35-40`（读路径空成功）、`42`/`46`（写路径抛出）；`services/mcp.service.ts:73,102` | 中 |
| E17 | `[CONFIRMED]` | `parseProvider` 已走 `providerRegistry.resolveProvider`，未注册 provider 在路由层已返回 `UNSUPPORTED_PROVIDER` | `provider.routes.ts:283-286` | 低 |

- [x] 每条现存代码陈述已登记，路径与行号已按真实仓库核实。
- [x] 无 INFERRED 项混入实施结论。
- [x] 高风险项 E7、E13、E13b、E14 均为 CONFIRMED；E12 标 PENDING_VERIFY，迁移前必须核实真实数据（涉及不可逆数据合并，硬规则要求）。

## 目标 / 非目标

**目标：**
- 修复 E7 的生产缺陷（跨 provider 静默删 session）与 E4 的静默 Claude 回退。
- 把泄漏的中央接缝收回 provider 模块，使「加 provider」收敛到**三处**：registry 注册、`LLMProvider` 类型联合、前端静态品牌映射（见「不可消除的中央点」）。
- 对外可观测行为在重构前后保持一致，proposal 中列明的三处 BREAKING 除外（它们是刻意的行为收紧）。
- 5 个现有 provider（含 Pi）全部迁入新接缝。

**非目标：**
- 不改变任何 provider 的上游 CLI 行为或模型能力。
- 不新增产品功能（分支管理、session fork、extension UI 等）。
- 不把重构扩大到与 provider 无关的 Git workflow。
- 不引入迁移版本框架（E14）；本 change 沿用现有幂等式迁移，只额外提供手工回滚脚本。

### 不可消除的中央点

以下三处在类型系统与产品约束下无法消除，重构后仍需随新 provider 改动。任何「只需注册一次」的表述都以此为准：

| 中央点 | 为什么不可消除 |
|---|---|
| `server/shared/types.ts` 的 `LLMProvider` 联合 | 去掉就退化为 `string`，全链路失去编译期 provider 校验 |
| `provider.registry.ts` 的注册 | 这就是设计上唯一应该保留的接入点 |
| 前端品牌映射（logo / 展示名 / i18n key） | 静态资源与文案无法由 backend capability 描述 |

## 设计决策

**决策 1：registry 升级为 descriptor + facet 真相；能力描述分两类，各有单一真相。**
- descriptor 承载 E3b 的 7 个静态字段，随 provider 定义一同注册。
- `supportsMcp` / `supportsSkills` / `supportsTokenUsage` 从 optional facet 存在性派生。
- 替代方案：保留静态矩阵并加校验——被否，双真相必然漂移（E3）。
- **注意**：把「能力从 facet 派生」当成全部答案是错的。9 个字段里 7 个只能搬位置，不能派生；spec 因此必须同时约束 descriptor 的单一真相，否则重构只是把手写矩阵换了个地方（见 spec「provider 能力描述的单一真相」）。

**决策 2：mcp/skills/usage 改 optional facet；unknown provider 与 unsupported facet 用不同错误码。**
替代方案：保留必选 facet + 空实现（如 Pi 的 `PiMcpProvider`）——被否，空成功掩盖「不支持」，违反 `pi-provider` spec 自身的声明（E2/E16）。迁移期可临时保留空实现 adapter，optional 化完成后删除。
错误码基础设施已就位（E16、E17），本决策主要是把已有模式贯彻到读路径。

**决策 3：引入 typed runtime + `ProviderRunCoordinator`，4 个 `.js` runtime 经 `LegacyProviderRuntimeAdapter` 接入，Pi 直接实现 typed 接口。**

**收益必须诚实界定**（E13/E13b/E13c）：
- WebSocket 客户端的「恰好一个终态」**今天已经成立**（`chatRunRegistry` 的 first-wins 去重）。coordinator 在 WS 上买到的不是新保证，而是把这条 invariant 从传输层搬到 application 层。
- coordinator 的**真实新增收益**有两条：
  1. **HTTP/SSE 路径当前完全没有终态去重**（E13b）。这是唯一「修复了实际缺陷」的部分。
  2. **消除 E13c 的四套互不相同的终态簿记**（`abortedSessionIds` / `session.status` / `completeSent` / `process.aborted`），这是维护性收益，也是本阶段成本最高的部分。
- 因此本阶段排在阶段 3，**在身份修复与能力收敛之后**；若排期紧张，可只做「SSE 路径接入 coordinator」这一子集先行止血，runtime 迁移延后。

替代方案：直接重写 4 个 runtime——被否，回归风险过大。适配器把 typed request↔旧 options、旧 writer event↔typed sink、`abort(sessionId)`↔`AbortSignal` 互转，并拦截旧 runtime 的 `complete/session_created`（E9/E10）。

**adapter 退出条件（硬性）**：`.agents/skills/backend-module-standards/SKILL.md` 要求 `server/modules/` 下全 TypeScript。`LegacyProviderRuntimeAdapter` 是过渡件，不是终态架构。退出条件写入任务 4.6：4 个 `.js` runtime 全部迁 TS 并直接实现 typed 接口后删除 adapter；在此之前 adapter 文件头必须标注该条件与追踪任务号。

**决策 4：native 身份加 `(provider, provider_session_id)` 部分唯一索引 + provider-qualified lookup/merge，作为阶段 1 独立发布。**
替代方案：仅靠 UUID 唯一性（即 add-pi-provider 现状）——被否，那是临时兜底；E7 是正在删数据的缺陷，本 change 的首要职责就是根治。迁移前必须先合并真实库中的重复行（E12）。
现有非唯一索引 `idx_sessions_provider_session_id`（E15）在新索引落地后是否保留，按查询计划实测决定，不预设。

**决策 5：scan cursor 迁 per-provider 表；watcher roots 由 synchronizer 提供；session 通知走 application publisher port。**
替代方案：保留全局游标——被否，一个 provider 失败拖累全体重扫（E6）。
`provider_scan_state.provider` 为**开放取值**的 TEXT 主键，不做枚举约束——把 provider 列表写进 schema 会重新制造一个中央改动点，与本 change 目标相悖。

**决策 6：删除前端静态 fallback 权限矩阵，首屏呈现「能力未就绪」而非猜测。**
E3c 的 fallback 是第三份真相。替代方案：保留 fallback 只作首屏占位——被否，它会在 capability 请求失败时长期生效并与 backend 漂移，且正是本 change 要消灭的模式。
**权衡**：删除后，capability 响应到达前 permission/effort/model picker 呈现禁用态（骨架），首屏交互延后一个 RTT。这是刻意接受的代价，换取「能力真相唯一」。若实测首屏体感不可接受，允许的补救是**服务端把 capability 内联进首屏文档**，而不是恢复前端硬编码。

## 模块边界

| 模块 | 职责 | **不负责** | 输入 | 输出 | 依赖 | 状态归属 |
|---|---|---|---|---|---|---|
| `ProviderRegistry`（重塑，`providers/provider.registry.ts`） | descriptor/facet 真相、`requireFacet`、descriptor 校验、生成 capability response | 运行、DB、transport | provider 定义 | provider/能力 | provider 定义 | 无 |
| `IProvider` / `AbstractProvider`（`shared/interfaces.ts`、`providers/shared/base/abstract.provider.ts`） | facet 契约声明（`mcp`/`skills`/`usage` 转 optional） | 具体实现 | - | - | - | 无 |
| `ProviderRunCoordinator`（新，application 层） | 校验/身份/生命周期/唯一终态/replay 保留，**对 WS 与 SSE 两条传输一致生效** | 事件语义映射、native 协议 | run 请求 | 归一化事件/终态 | registry、runtime、run registry | active run + 终态 |
| `LegacyProviderRuntimeAdapter`（新，**过渡件**） | typed↔旧 `.js` runtime 互转（仅 claude/codex/cursor/opencode） | 终态生产（交回 coordinator） | typed request | typed outcome | 4 个旧 runtime | 无 |
| session identity（重塑 `database/repositories/sessions.db.ts`） | provider-qualified lookup/merge | 能力、runtime | `(provider, nativeId)` | session 行 | DB | `sessions` 表 |
| `provider_scan_state`（新表 + `scan-state.db.ts` + synchronizer service 改造） | per-provider 游标 | 能力、runtime | 同步结果 | 游标推进 | DB | `provider_scan_state` 表 |
| session change publisher port（新） | application→transport 通知端口 | provider 逻辑 | upsert 事件 | 通知 | WebSocket adapter（生产）/内存（测试） | 无 |
| agent application module（提取自 `agent.routes.ts`） | generic run 编排 | provider dispatch 分支 | HTTP 请求 | 响应 | coordinator | 无 |
| frontend model state（收敛） | `Partial<Record<LLMProvider,string>>` 统一处理 | 逐 provider setter、能力猜测 | provider/model | UI state | capability response | localStorage |

- [x] 每模块单一领域。
- [x] 「不负责」列已填。
- [x] `sessions` 表由 session identity 归属；`provider_scan_state` 由 synchronizer 归属，无双写。
- [x] 依赖单向：transport → application(coordinator/agent module) → registry → provider；providers 不再反向依赖 WebSocket。当前反向依赖共 2 处，均经 barrel 引入：`providers/services/sessions.service.ts:6` 与 `providers/services/sessions-watcher.service.ts:10` 引入 `@/modules/websocket/index.js`，由 publisher port 打破。

## 规则与约束

| 类型 | 规则 | 覆盖需求 |
|---|---|---|
| 业务规则 | 一个 app session 同时最多一个 active run | 单一终态所有权 |
| 系统规则 | 终态只能由 coordinator 产生；runtime 只发非终态事件；**WS 与 SSE 两条传输一致** | 单一终态所有权 |
| 系统规则 | 所有 native lookup/merge 必须携带 provider | 身份隔离 |
| 系统规则 | 每个 provider 独立推进自身游标 | 同步失败隔离 |
| 系统规则 | descriptor 是 7 个静态能力字段的唯一真相；3 个 `supportsX` 从 facet 存在性派生；前端不得保留任何能力猜测 | 能力表达一致 |
| 系统规则 | provider 列表不得出现在 DB schema、能力矩阵或服务层字面量中 | 中央点收敛 |
| 技术约束 | 4 个 `.js` runtime 经 legacy adapter 接入，不一次性重写；adapter 必须带退出条件 | 迁移安全 + 仓库 TS 规范 |
| 技术约束 | 唯一约束迁移前必须合并真实库重复行，且在单事务内完成 | 身份隔离 |
| 技术约束 | 迁移无 down 框架（E14），回滚须提供独立手工脚本 | 迁移安全 |
| 技术约束 | 新增/改造 backend 文件为 TypeScript，逐步移除 `@ts-nocheck` | 全部 |

## 错误码注册表

| ERR ID | 常量名 | 错误码 | 提示文案 | 引用位置 | 现状 |
|---|---|---|---|---|---|
| ERR-UNSUPPORTED-PROVIDER | `UNSUPPORTED_PROVIDER` | 400 | 「不支持的 provider」 | `registry.resolveProvider` | 已存在 |
| ERR-PROVIDER-CAPABILITY-UNSUPPORTED | `PROVIDER_CAPABILITY_UNSUPPORTED` | 400 | 「该 provider 不支持此能力」 | `registry.requireFacet` | 已存在（E16），本 change 扩展到读路径 |
| ERR-PROVIDER-DESCRIPTOR-INVALID | `PROVIDER_DESCRIPTOR_INVALID` | 500 | 「provider descriptor 非法」 | registry 注册校验 | 新增 |

## 数据模型

| 字段 | 类型 | 必填 | 含义 | 示例 | 约束 | 枚举值 | 默认值 | 空值语义 |
|---|---|---|---|---|---|---|---|---|
| `idx_sessions_provider_native_id` | 部分唯一索引 | 是 | `(provider, provider_session_id)` 唯一 | - | `WHERE provider_session_id IS NOT NULL` | - | - | native id 为空的行不受约束 |
| `provider_scan_state.provider` | TEXT PK | 是 | 每 provider 一行游标 | `'pi'` | 主键，**取值开放不加枚举约束** | 不约束 | - | 无行=该 provider 从未扫描 |
| `provider_scan_state.last_scanned_at` | TEXT | 是 | 该 provider 上次扫描时间 | ISO 字符串 | - | - | - | - |
| `IProvider.mcp` | optional facet | 否 | MCP 能力 | - | - | - | `undefined` | `undefined`=不支持 MCP |
| `IProvider.skills` | optional facet | 否 | skills 能力 | - | - | - | `undefined` | `undefined`=不支持 skills |
| `IProvider.usage` | optional facet | 否 | token usage 能力 | - | - | - | `undefined` | `undefined`=不支持 usage |
| `ProviderDescriptor.permissionModes` | `string[]` | 是 | 该 provider 接受的权限模式，按循环顺序 | `['plan','bypassPermissions']` | 非空 | - | - | - |
| `ProviderDescriptor.defaultPermissionMode` | string | 是 | 默认权限模式 | `'bypassPermissions'` | 必须 ∈ `permissionModes`，否则注册期报 `ERR-PROVIDER-DESCRIPTOR-INVALID` | - | - | - |

**状态流转（一次 run，由 coordinator 拥有）：** `REGISTERED -> RUNNING -> (COMPLETED | ABORTED | FAILED)`；后三者为终态，且对外恰好观察到一个，**与传输通道无关**。

## 非功能要求

| 维度 | 要求 |
|---|---|
| 延迟 / 吞吐 | 重构不得引入额外流式延迟；事件路径保持零额外缓冲 |
| 并发 | 一个 app session 同时最多一个 active run（沿用现有 run registry） |
| 一致性 | 唯一约束迁移在单事务内完成合并+建索引；provider-qualified merge |
| 可观测性 | 一次 run 恰好一个终态（WS 与 SSE 均是）；unknown/unsupported 错误码可区分并被日志记录 |
| 兼容性 | 重构前后现有 **5 个** provider 的 observable 行为由 characterization tests 锁定，除 proposal 列明的三处 BREAKING 外零回归 |
| 首屏 | 删除前端 fallback 后，capability 未就绪期间 picker 呈禁用骨架，不得出现错误的默认权限模式 |

## 风险与权衡

- [唯一约束迁移在真实库遇到重复 native id] -> E12 迁移前查询并合并；provider-qualified merge SQL 含 `provider = ?`；单事务。此为不可逆数据操作，须 `[PENDING_VERIFY]` 核实后执行。
- [**索引会在代码回滚后残留**] -> E14 迁移系统只进不退，回滚旧代码不会删除新索引。残留的部分唯一索引在旧 merge 逻辑下不会破坏正确性（旧逻辑先 DELETE 再 UPDATE），但仍须提供并演练手工 `DROP INDEX idx_sessions_provider_native_id` 脚本。
- [大范围 runtime 迁移引入现有 provider 回归] -> 先补 characterization tests（含 Pi，共 5 个），legacy adapter 分阶段替换。
- [facet optional 化触及 `IProvider` 所有实现] -> BREAKING，但由类型系统兜底：改 `interfaces.ts` 与 `abstract.provider.ts` 后 typecheck 会列出全部待改点。
- [**coordinator 的收益被高估**] -> E13 已确认 WS 路径的终态唯一性今天就成立。决策 3 已把收益重新界定为「SSE 路径止血 + 消除四套簿记」，并允许只做 SSE 子集先行。`chatRunRegistry` 的去重保留为 invariant assertion 与兼容期保护，不作正常控制流。
- [legacy adapter 变成永久中间层] -> 决策 3 的退出条件 + 任务 4.6 追踪；adapter 文件头注明退出条件。
- [删除前端 fallback 拖慢首屏] -> 决策 6 已给出唯一允许的补救路径（服务端内联 capability），禁止恢复硬编码。

## 迁移计划

| 项 | 内容 |
|---|---|
| 上线步骤 | 0) 补 characterization tests（5 个 provider）；1) **session 身份唯一约束（先查重合并）+ per-provider 游标 + publisher port**（可独立发布）；2) registry descriptor + capability 单一真相 + facet optional 化；3) typed runtime + coordinator（先 SSE 止血，再迁 4 个 legacy runtime，Pi 直接 typed）；4) agent/websocket 走 generic dispatcher，去 `@ts-nocheck`；5) frontend state 收敛 + 删 fallback 矩阵 |
| 回滚策略 | 分阶段，每阶段可独立回滚代码。**数据库无 down migration 框架（E14）**：回滚需执行随本 change 交付的手工脚本 `scripts/rollback/drop-provider-native-id-index.sql`（删索引）与 `provider_scan_state` 保留策略 |
| 回滚后数据处理 | 唯一约束回滚：删除新增索引即可，已合并的重复行**不自动拆回**——须人工核对（合并是有损操作）。`provider_scan_state` 回滚：保留表，回退读写到旧 `scan_state`（旧表不删除，保证可来回切换） |

## 待明确问题

- 新索引 `idx_sessions_provider_native_id` 落地后，现有非唯一索引 `idx_sessions_provider_session_id`（E15）是否保留，按实际查询计划实测决定。
- 若阶段 3 排期不足，是否只交付「SSE 接入 coordinator」子集，runtime 迁移单独立项——决策 3 已允许，具体取舍在排期时确定。
