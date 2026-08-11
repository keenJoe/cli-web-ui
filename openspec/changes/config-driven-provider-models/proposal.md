## Why

模型选择器存在两个与用户真实可用性脱节的问题，且认证 gate 若只做 REST 层会被完全绕过：

1. **未连接/未登录的 provider 也能选模型**。composer 的模型可选性只 gate 在静态 capabilities（`provider.registry.ts` 注册即 `ready`），不感知认证状态。前端 `useChatProviderState.ts` 的 `currentProviderModel` 仅要求 `providerCapabilityStatus === 'ready'`；后端 `GET /:provider/models` 对未认证的 claude/codex 依然 200 + 返回写死的 fallback 列表。**且不止一个入口**：内置 `/models` 命令（`commands.routes.ts` 的 `executeModelsCommand`）直接调用 `providerModelsService.getProviderModels()`，不经任何认证检查，前端 `CommandResultModal` 用命令响应的 `availableOptions` 渲染可选列表并允许选择。只 gate REST 路由等于没 gate。
2. **模型列表不感知本地配置的 base_url/api_key**。各 provider 的模型来源要么写死（claude），要么读 CLI 自己的缓存（codex 读 `~/.codex/models_cache.json`）。用户配了第三方中转/自建网关（`~/.claude/settings.json` env、`~/.codex/config.toml` 的 `model_providers`）时，列表与真实可达模型脱节。Codex 的实测配置（`~/.codex/config.toml`）凭证字段是 `experimental_bearer_token`、`base_url` 以 `/v1` 结尾——通用「api_key + 拼 /v1/models」假设与真实配置不兼容。
3. **认证判定本身有两处缺陷**：① 三个 provider 的安装探测（`spawn.sync` 后直接 `return true`）不检查 `error`/退出码，`cross-spawn.sync` 对 ENOENT 不抛异常，CLI 缺失会误判 `installed=true`；② Codex 的认证只读 `auth.json`，配置了合法网关凭证但没有 OpenAI 登录的用户会被误判未认证。

**目标**：模型目录的「可选性」与「来源」都以 provider 的真实状态为准——未连接/未登录在所有用户可见入口（REST、`/models` 命令、前端两处渲染）都不可选；已登录时优先从本地配置声明的 base_url/api_key 拉取真实模型列表，配置与认证共用同一解析，缓存以配置为键且不缓存 fallback。

## What Changes

**需求 1 — 认证 gate：未连接/未登录的 provider 在所有入口不可选择模型**

gate 标准 = auth 状态 `installed && authenticated`。**认证检查下沉到 service 层**，而非路由层，使 REST 与 `/models` 命令共用同一 gate：

- `provider-models.service.ts` 的 `getProviderModels` 依赖注入 `assertProviderAuthenticated`（`provider-auth.service.ts` 新增），REST 路由与 `commands.routes.ts` 的 `executeModelsCommand` 都经它——`/models` 命令无法绕过。`POST /:provider/sessions/:sessionId/active-model` 同样 gate（命令弹窗选择模型会走该端点）。
- 未通过抛 `AppError('provider 未安装或未认证', { code: 'PROVIDER_NOT_AUTHENTICATED', statusCode: 401 })`（message 与 code 分离，避免 `INTERNAL_ERROR`）。
- **修复安装探测**：claude/codex/cursor 三个 `checkInstalled` 改为共享 probe helper（`server/shared/utils.ts`），检查 `spawn.sync` 返回的 `error`/退出码/超时，不再「返回 true + catch」。
- **Codex 认证补配置凭证**：`checkCredentials` 增加读 config.toml 的 `model_providers.<active>.experimental_bearer_token`/`api_key`/`env_key`，有合法网关凭证即 `authenticated=true`（与模型目录共用解析器，见需求 2）。

**需求 2 — 配置驱动：优先读本地配置的 base_url/api_key 获取模型列表，配置解析 auth/models/cache 共用**

- **Codex 配置解析器**（`codex-config.ts`，codex 模块内）：解析 `~/.codex/config.toml` 的 `model`、`model_provider`、`model_providers.<id>.base_url` 与凭证（`experimental_bearer_token`/`api_key`/`env_key` 间接取值）。**base_url 规范化**：去掉尾部 `/` 与 `/v1` 得 API root，模型端点恒为 `{root}/v1/models`——实测 `base_url = "https://aiapi.tcredit.com/v1"` 不会再拼出 `/v1/v1/models`。auth、models、cache 三处共用该解析器，认证与目录对同一配置只有一种解释。
- **Claude settings 解析器**（`claude-settings.ts`，claude 模块内）：读 `~/.claude/settings.json` env 的 `ANTHROPIC_BASE_URL`/`ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN`，与 `claude-auth.provider.ts` 现有的 settings 读取合并为同一解析器。**base_url 无缺省**——只有明确配置了 base_url **且** 有凭证才走 API；「只有 key 无 base_url」回退内置列表，不联网。凭证 header：`ANTHROPIC_API_KEY` → `x-api-key`，`ANTHROPIC_AUTH_TOKEN` → `Authorization: Bearer`。
- **HTTP 拉取上移 `server/shared/utils.ts`**（`fetchAnthropicModels` / `fetchOpenAICompatModels` / `normalizeModelsEndpoint`，均带 ~8s 超时、失败返回 `null` 不抛错）——被 claude/codex 两处复用，符合 backend-module-standards「两处复用的 utility 放 `server/shared/utils.ts`」。
- 各 models provider 的 `getSupportedModels()` 增加第一优先级「配置 → API → 解析」，失败逐级回退既有来源（claude 内置列表；codex `models_cache.json` → 内置列表）。**Pi 保持 RPC 现状**；Cursor/OpenCode 留作后续扩展。

**需求 3 — 缓存以完整配置为键，fallback 不进长缓存**

- `IProviderModels` 契约扩展：`getSupportedModels` 返回原子化的目录结果，含 **cache identity**（指纹 + `cacheable` 元数据），由 facet 自身提供——中央 service 不解析任何 provider 配置文件，维持「本地 model facet 拥有目录策略」（`README.md:268`）。
- 指纹 = `hash(base_url + 凭证hash + model_provider + model)`；`provider-models.service` 缓存 key = `${provider}:${fingerprint}`，`pendingRequests` 用同一完整指纹去重。**不落盘原始凭证**（只落 hash）。
- `cacheable=false`（配置 API 失败的 fallback）**不写入 3 天磁盘缓存**，仅内存短驻——端点恢复后下轮即重试，不长期返回错误目录。

**需求 4 — 前端认证状态共享与四态渲染**

- 前端 `ProviderAuthStatus` 补回 `installed` 字段；`useProviderAuthStatus` 提升为**共享 store**（模块级单例，`useSyncExternalStore`/context），设置页与聊天页消费同一状态；失效机制：登录完成、设置页关闭、窗口重新聚焦时刷新。
- 渲染改为**四态**：`loading | authenticated | unauthenticated | error`。**仅 `unauthenticated`（确定未认证）完全隐藏**模型选择器；loading/error 保持现有禁用骨架（现有 `ComposerModelMenu.tsx:69` 的骨架逻辑不回归）。
- 两处渲染入口（composer 菜单与 `CommandResultModal`）消费同一状态；认证翻转 `false→true` 触发模型列表重载。
- **性能**：认证检查加短期缓存（~10s）与在途请求合并；对 Pi 的 CLI/RPC 启动次数设测试上限（`pi-auth` 探测与 `pi-models` 拉取当前各启动一次 RPC）。

**需求 5 — 前端测试纳入脚本**

- 新增 `test:frontend` 脚本（`node --import tsx --test "src/**/*.test.ts" "src/**/*.test.tsx"`，`TSX_TSCONFIG_PATH=tsconfig.json`），纳入本 change 的验收门禁——现状 `npm test` 只匹配 `server/**`，readiness 测试（本 change 的关键回归锚点）不在任何脚本里。

## BREAKING（对外可观测）

| 端点/界面 | 现状 | 变更后 |
|---|---|---|
| `GET /api/providers/:provider/models`（未安装或未认证） | 200 + fallback 列表 | 401 `PROVIDER_NOT_AUTHENTICATED` |
| 内置 `/models` 命令（未安装或未认证） | 返回 fallback 列表供选择 | 与 REST 一致的认证错误，不可选 |
| `POST /:provider/sessions/:sessionId/active-model`（未认证） | 记录成功 | 401 `PROVIDER_NOT_AUTHENTICATED` |
| composer / 命令弹窗模型选择器（确定未认证） | 显示（fallback 可选） | 完全隐藏（loading/error 保持骨架） |
| Codex 认证判定 | 仅 auth.json | 增加 config.toml 网关凭证（误判未认证 → 正确认证） |
| `IProviderModels.getSupportedModels` 返回形状 | `ProviderModelsDefinition` | 含 cache identity 的目录结果（内部契约，HTTP 响应形状不变） |

前端消费点核对：`useChatProviderState` 的 `currentProviderModel`/`currentProviderModelOptions`、`CommandResultModal` 的 `availableOptions` 回退路径、`provider-capability-readiness.test.tsx`（现有 2965 行）与 `frontend-provider-capability-contract.test.ts` 的既有断言。

## Capabilities

### New Capabilities
- `provider-model-catalog`: 模型目录的可选性与来源契约——未连接/未登录 provider 的模型目录在全部入口（REST、`/models` 命令、前端）不可选（401 + 隐藏）；已认证 provider 的目录来源优先为本地配置（base_url/api_key）驱动的 API 拉取（配置解析与认证共用），失败回退既有来源；缓存以完整配置指纹为键且不缓存 fallback。

### Modified Capabilities
<!-- 无。既有 provider 的模型目录行为在已认证且未配置路径下保持兼容：配置驱动仅新增来源，失败回退路径与现状逐字节一致。 -->

## Impact

- **Backend**：
  - `server/shared/interfaces.ts`：`IProviderModels` 返回形状扩展（cache identity + cacheable 元数据）。
  - `server/shared/utils.ts`：新增 `runCliVersionProbe`、`fetchAnthropicModels`、`fetchOpenAICompatModels`、`normalizeModelsEndpoint`（多处复用，按仓库标准落位）。
  - `server/modules/providers/services/provider-models.service.ts`：认证 gate 注入 + 缓存 key 完整指纹 + `cacheable=false` 不落盘。
  - `server/modules/providers/services/provider-auth.service.ts`：`assertProviderAuthenticated` + 认证短期缓存/请求合并。
  - `server/modules/providers/provider.routes.ts`：gate 接线（检查移入 service）。
  - `server/modules/commands/commands.routes.ts`：`/models` 命令经同一 gate。
  - `server/modules/providers/list/{claude,codex,cursor}/*-auth.provider.ts`：probe 修复；codex 认证补 config 凭证。
  - `server/modules/providers/list/claude/claude-models.provider.ts`、`server/modules/providers/list/codex/codex-models.provider.ts`：配置优先 + cache identity。
  - 新增 `codex-config.ts`、`claude-settings.ts`（各 provider 模块内配置解析器，auth/models 共用）。
- **Frontend**：
  - `src/components/provider-auth/types.ts`：补 `installed`。
  - `src/components/provider-auth/hooks/useProviderAuthStatus.ts`：改造为共享 store + 失效机制。
  - `src/components/chat/hooks/useChatProviderState.ts`：四态、`modelMenuAvailable`、认证翻转重载。
  - `src/components/chat/view/subcomponents/ComposerModelMenu.tsx`：`available` 改为四态，仅 unauthenticated 隐藏。
  - `src/components/chat/view/subcomponents/CommandResultModal.tsx`：同一状态 gate。
  - `src/components/chat/view/subcomponents/ChatComposer.tsx`：传参。
  - `package.json`：`test:frontend` 脚本。
- **Tests**：后端各改动文件单测（mock fetch / mock 配置文件 / probe 注入）；前端 readiness 测试补四态与两入口用例。
- **文档**：本 change 的 `design.md`、`test-definition.md`。
