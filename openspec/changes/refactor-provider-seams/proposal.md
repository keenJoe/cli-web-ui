## Why

现有 provider 集成的公共接缝在泄漏：`IProvider` 看似统一，实际是浅模块——新增或改动一个 provider 时，调用者仍需在多个中央位置了解该 provider 的差异。以 Pi 接入（commit `11fc015`）为样本，backend 侧实际需要改动的中央文件是 8 个：

| 中央文件 | 泄漏形式 |
|---|---|
| `server/shared/types.ts` | `LLMProvider` 联合新增成员 |
| `server/modules/providers/provider.registry.ts` | 注册（这是唯一**应该**保留的一处） |
| `server/modules/providers/services/provider-capabilities.service.ts` | 手写静态能力矩阵新增一整块 |
| `server/modules/providers/services/provider-token-usage.service.ts` | 新增一个 `if (session.provider === 'pi')` 分支 |
| `server/modules/providers/services/sessions-watcher.service.ts` | 中央常量 `PROVIDER_WATCH_PATHS` 新增硬编码路径 |
| `server/modules/providers/services/session-synchronizer.service.ts` | `processedByProvider` 字面量新增 key |
| `server/modules/providers/services/mcp.service.ts` | 聚合层新增「跳过不支持 MCP 的 provider」处理 |
| `server/modules/agent/agent.routes.ts` | 新增 `queryPi` 依赖项 + `else if (provider === 'pi')` 分支 |

加上 `server/modules/providers/shared/base/abstract.provider.ts`（必选 facet 的抽象声明）与前端的 per-provider model state / effort fallback，「加一个 provider」= 1 处干净注册 + 10 处以上中央改动。

其中两处不只是维护成本，而是**正在生产环境造成损害的缺陷**：

1. `sessions.db.ts:185-193` 的 native session 合并 SQL 是 `WHERE (session_id = ? OR provider_session_id = ?)`，**不带 provider 过滤**，命中后直接 `DELETE` 对方行。两个 provider 撞上相同 native session id 时会静默删除用户 session。
2. `provider-token-usage.service.ts` 的逐 provider `if` 链末尾是**无条件回落到 `.claude` 目录**，未命中的 provider 会被静默当作 Claude。

`add-pi-provider` 刻意沿用了现状、把这套重构切出去独立进行。本 change 就是被切出的另一半。

**与 `add-pi-provider` 的关系（已核实）**：Pi 的**代码**已经合入主干（`11fc015`、`6c5089b`），中央文件交集在代码层已不存在冲突风险。剩下的是**文档流程**前置：`add-pi-provider` 尚未归档（`openspec/archive/` 与 `openspec/specs/` 均为空，其 `tasks.md` 仅勾选 2/28）。本 change 的 spec 引用 `pi-provider` 的既有行为，因此应在 `add-pi-provider` 归档、`pi-provider` 进入 `openspec/specs/` 之后再落 delta。

## What Changes

**阶段 1 — session 身份隔离（可独立发布，最高优先级）**
- native session 身份改为 `(provider, provider_session_id)`：新增部分唯一索引与 provider-qualified lookup/merge，修复上述静默删数据缺陷。**BREAKING**：`assignProviderSessionId` / `getSessionByProviderSessionId` 签名新增 `provider` 参数。
- scan cursor 由全局单例 `scan_state` 改为 per-provider `provider_scan_state`；watcher roots 由各 synchronizer 动态提供；session 通知改为 application-owned publisher port，移除 providers→WebSocket 反向依赖。

**阶段 2 — registry 与能力表达**
- registry 成为 provider descriptor、facet 与能力的唯一真相：`listProviders` / `resolveProvider` / `requireFacet`，注册时校验 descriptor。
- 能力描述拆成两类，各有单一真相：
  - **descriptor 字段**（`permissionModes`、`defaultPermissionMode`、`supportsImages`、`supportsFiles`、`supportsAbort`、`supportsPermissionRequests`、`supportsEffort`）由 provider 自身随注册提供——这 7 个字段**无法**从 facet 存在性派生，只能从中央矩阵搬进 provider 模块。
  - **facet 派生字段**（`supportsMcp`、`supportsSkills`、`supportsTokenUsage`）等于对应 optional facet 是否存在。其中 `supportsMcp`/`supportsSkills` 是本 change **新增**字段（现有矩阵没有）。
- 删除中央静态矩阵，并删除前端 `useChatProviderState.ts` 里的静态 fallback 权限矩阵（第三份真相）。
- MCP、skills、token usage 改为 **optional facet**；不支持时返回 `PROVIDER_CAPABILITY_UNSUPPORTED`，与未注册 provider 的 `UNSUPPORTED_PROVIDER` 区分。**BREAKING**：`IProvider` 与 `AbstractProvider` 的 `mcp`/`skills` 由必选改为可选。

**阶段 3 — typed runtime 与终态所有权**
- 引入 typed runtime 接缝（typed request / typed event sink / typed outcome）与 `ProviderRunCoordinator` 作为终态唯一所有者。
- claude/codex/cursor/opencode 这 **4 个 `.js` runtime** 通过 `LegacyProviderRuntimeAdapter` 分阶段接入，不一次性重写；**Pi runtime 已是 TypeScript**，直接实现 typed 接口，不经过 adapter。
- adapter 设**退出条件**：4 个 `.js` runtime 全部迁为 TS 并直接实现 typed 接口后删除该 adapter（见 design 决策 3）。

**阶段 4 — dispatcher 与前端收敛**
- Agent API 与 WebSocket 统一走 generic coordinator，移除逐 provider `queryX` 与 `if/else`；从 `agent.routes.ts`（1301 行、`@ts-nocheck`）分步提取业务编排并移除 `@ts-nocheck`。
- frontend 每-provider model state 收敛为 `Partial<Record<LLMProvider, string>>`，行为由 backend capability 驱动。

## BREAKING（对外可观测）

本 change 刻意收紧三处「空成功伪装成支持」的行为，须同步核对前端消费点：

| 端点 | 现状 | 变更后 |
|---|---|---|
| Pi 的 MCP 列表（`PiMcpProvider.listServers` / `listServersForScope`） | 200 + 空数组 | 400 `PROVIDER_CAPABILITY_UNSUPPORTED` |
| Cursor 的 token usage（`provider-token-usage.service.ts:270-280`） | 200 `{ unsupported: true, used: 0, ... }` | 400 `PROVIDER_CAPABILITY_UNSUPPORTED` |
| 未命中任何分支的 provider 的 token usage | 静默按 `.claude` 目录解析 | 400 `PROVIDER_CAPABILITY_UNSUPPORTED` |

前两项与 `add-pi-provider` spec 中「不支持的能力 SHALL 以明确的不支持错误而非空成功表达」一致——当前实现是对该 spec 的偏离，本 change 令实现回到 spec，因此**不产生 `pi-provider` delta**。
聚合层 `mcp.service.ts:73,102` 已经具备该错误码的处理模式，可直接复用。

## Capabilities

### New Capabilities
- `provider-seams`: provider 公共接缝的对外行为契约——能力描述的单一真相（descriptor + facet 派生）、unknown provider 与 unsupported facet 的错误码区分、跨 provider native session 身份隔离、per-provider 同步失败隔离、跨传输（WebSocket 与 HTTP/SSE）的单一终态所有权。

### Modified Capabilities
<!-- 无。`pi-provider` 的对外契约不变：本 change 只是让 Pi 的 MCP 实现回到其 spec 已声明的「明确不支持错误」语义，属实现修正而非契约变更，故不产生 delta。 -->

## Impact

- **数据库**（`server/modules/database/`）：
  - `schema.ts` / `migrations.ts`：新增部分唯一索引 `(provider, provider_session_id) WHERE provider_session_id IS NOT NULL`（迁移前须合并重复行）；新增 `provider_scan_state` 表。注意现有 `idx_sessions_provider_session_id`（非唯一）需一并评估是否被新索引取代。
  - `repositories/sessions.db.ts`、`repositories/scan-state.db.ts`。
  - **迁移机制约束**：`migrations.ts` 是单个只进不退的幂等 `runMigrations`，**没有版本表也没有 down migration 框架**。回滚不能依赖框架，必须提供独立的手工 `DROP INDEX` 脚本（详见 design 迁移计划）。
- **类型 / 契约**：`server/shared/interfaces.ts`（facet 可选化 + typed runtime）、`server/shared/types.ts`（`LLMProvider` 联合、typed run 类型）、`server/modules/providers/shared/base/abstract.provider.ts`（必选 facet 声明）。
- **Backend**：`provider.registry.ts`、`services/provider-capabilities.service.ts`、`services/provider-token-usage.service.ts`、`services/mcp.service.ts`、`services/sessions-watcher.service.ts`、`services/session-synchronizer.service.ts`、`modules/agent/agent.routes.ts`、`modules/agent/agent.module.ts`、`modules/websocket/services/*`，以及 5 个 provider 的 facet 挂载与 runtime 适配。
- **Frontend**：`src/components/chat/hooks/useChatProviderState.ts`（model state 收敛 + 删除静态 fallback 矩阵）、`src/components/chat/constants/providerEffort.ts`、依赖 per-provider model 的 4 个组件。
- **仓库规范**：`.agents/skills/backend-module-standards/SKILL.md` 要求 `server/modules/` 下全 TypeScript、动到的 JS 需迁 TS。legacy adapter 是过渡措施，必须带退出条件，不得成为永久中间层。
