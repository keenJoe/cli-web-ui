# 配置驱动模型目录与认证 gate 设计

## 背景

动机见 proposal.md - Why。核心问题是模型目录的「可选性」与「来源」都未对齐 provider 的真实状态，且认证 gate 存在可绕过的旁路与不可靠的安装判定。第一轮规格审查（2026-08-10）发现 12 处问题，本版设计已全部吸收：认证入口统一、真实 Codex 配置、前端认证状态共享、缓存来源契约。

**方案路线**：认证 gate 下沉到 models service（REST 与 `/models` 命令共用同一断言）；配置解析由各 provider 的 model facet 与 auth facet 共用同一解析器（中央 service 不解析配置文件）；HTTP 拉取上移 `server/shared/utils.ts`；缓存由 facet 提供原子化配置身份。全程无数据库、无迁移、无新注册概念。

## 证据登记

所有路径已按真实仓库核实（当前分支 `config-driven-provider-models`，基线 develop `292b410`）。第一轮审查（E12 消解、E13–E16 新增）已并入。

| 编号 | 标签 | 陈述 | 依据 | 风险 |
|---|---|---|---|---|
| E1 | `[CONFIRMED]` | composer 模型可选性只 gate 静态 capabilities：`currentProviderModel` 仅要求 `providerCapabilityStatus === 'ready'`，不感知认证 | `src/components/chat/hooks/useChatProviderState.ts:559-562` | 高 |
| E2 | `[CONFIRMED]` | 前端已有认证状态来源 `useProviderAuthStatus`，但只用于设置页/onboarding，未接入模型选择流程；且为组件级 hook，设置页刷新不传播到聊天页 | `src/components/provider-auth/hooks/useProviderAuthStatus.ts:75`；消费点仅 `useSettingsController.ts`、`Onboarding.tsx` | 高 |
| E3 | `[CONFIRMED]` | **内置 `/models` 命令绕过认证**：`executeModelsCommand` 直接调 `providerModelsService.getProviderModels()`，无任何认证检查；前端 `CommandResultModal` 用响应的 `availableOptions` 渲染可选列表 | `server/modules/commands/commands.routes.ts:65-67`；`src/components/chat/view/subcomponents/CommandResultModal.tsx:245` | 高 |
| E3b | `[CONFIRMED]` | `/models` 命令与 REST 共用同一 `providerModelsService` 单例（依赖注入 `models: typeof import('../providers/index.js').providerModelsService`）——认证 gate 下沉到 service 层即可同时覆盖两个入口 | `server/modules/commands/commands.routes.ts:12` | 低 |
| E4 | `[CONFIRMED]` | claude 的 `getSupportedModels` 直接 `return CLAUDE_FALLBACK_MODELS`（动态查询被注释禁用） | `server/modules/providers/list/claude/claude-models.provider.ts:228-241` | 高 |
| E5 | `[CONFIRMED]` | codex 的模型来源是 `~/.codex/models_cache.json`，不读 config.toml 的 `model_providers` | `server/modules/providers/list/codex/codex-models.provider.ts:136-148` | 中 |
| E6 | `[CONFIRMED]` | claude 的认证判定已把 `~/.claude/settings.json` env 的 `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN` 算作已认证，但 settings 读取是 auth 私有方法，models 侧将重复实现 | `server/modules/providers/list/claude/claude-auth.provider.ts:69-108`（`loadSettingsEnv` 私有） | 中 |
| E7 | `[CONFIRMED]` | 模型目录缓存 TTL 3 天，键仅 provider 维度；**任何结果（含 fallback）无条件缓存**；`pendingRequests` 按 provider 去重 | `server/modules/providers/services/provider-models.service.ts:17,19,207-221,238` | 高 |
| E8 | `[CONFIRMED]` | `ProviderAuthStatus` 含 `installed`/`authenticated`，5 个 provider 均有 auth 实现 | `server/shared/types.ts:677`；`list/*/*-auth.provider.ts` | 低 |
| E9 | `[CONFIRMED]` | 错误码先例：Pi 模型拉取未认证抛 `PI_NOT_AUTHENTICATED`；前端对失败请求返回 null | `server/modules/providers/list/pi/pi-models.provider.ts:82`；`useChatProviderState.ts:146-149` | 低 |
| E10 | `[CONFIRMED]` | Pi 模型目录已是 RPC 实时动态（`getAvailableModels` + `getState().model`），值域为 `<provider>/<id>` 限定格式 | `server/modules/providers/list/pi/pi-models.provider.ts:72-98` | 低 |
| E11 | `[CONFIRMED]` | 前端既有 readiness 测试与后端契约测试覆盖模型菜单现有渲染条件，是本 change 的回归锚点 | `provider-capability-readiness.test.tsx`（2965 行）、`frontend-provider-capability-contract.test.ts` | 中 |
| E12 | `[RESOLVED]` | **Codex 真实配置已实测**（第一轮审查消解）：`~/.codex/config.toml` 含 `model = "gpt-5.6-sol"`、`model_provider = "tc-credit"`、`[model_providers.tc-credit]` 下 `base_url = "https://aiapi.tcredit.com/v1"`（**以 /v1 结尾**）、凭证字段 `experimental_bearer_token`；且 **codex-auth 只读 auth.json 不读 config.toml**，配网关凭证但无 OpenAI 登录者被误判未认证 | 本机 `~/.codex/config.toml` 只读核查（凭证已脱敏）；`codex-auth.provider.ts:51-82` | 高（已消解） |
| E13 | `[CONFIRMED]` | claude/codex/cursor 三个 `checkInstalled` 均为 `spawn.sync(...)` 后直接 `return true`、`catch → false`，**不检查 `result.error`/退出码**；`cross-spawn.sync` 对 ENOENT 返回 error 字段不抛异常 → CLI 缺失误判 `installed=true` | `claude-auth.provider.ts:27-35`、`codex-auth.provider.ts:22-29`、`cursor-auth.provider.ts:25-31` | 高 |
| E14 | `[CONFIRMED]` | `AppError` 首参是 message，`code = options.code ?? 'INTERNAL_ERROR'`——不显式传 `options.code` 时响应码是 `INTERNAL_ERROR` | `server/shared/utils.ts:94-104` | 中 |
| E15 | `[CONFIRMED]` | `npm test` 只匹配 `server/**/*.test.*`，前端 readiness 测试不在任何脚本内（前端测试同为 `node:test` + tsx 风格，可复用同一 runner） | `package.json:49`；`src/components/chat/provider-capability-readiness.test.tsx:1-5` | 高 |
| E16 | `[CONFIRMED]` | Pi 的 auth 探测启动 RPC 并调 `getAvailableModels()`（`probeAuthenticated`），随后 pi-models 拉取再启动一次——单次页面加载（全量 auth 检查 + 全量 models 拉取 + 每请求认证复查）可能多次启动 CLI/RPC | `pi-auth.provider.ts:92-100`；`useChatProviderState.ts:117,129-149` | 中 |
| E17 | `[CONFIRMED]` | `README.md:268` 要求「本地 model facet 拥有目录策略」，中央服务不应解析 provider 配置文件或维护模型回退矩阵——缓存身份必须由 facet 提供 | `server/modules/providers/README.md:268`；`interfaces.ts:118-135`（`IProviderModels` 无 cache identity） | 中 |
| E18 | `[CONFIRMED]` | `backend-module-standards` 要求两处以上复用的 utility 放 `server/shared/utils.ts`，且不得建模块本地 `utils.ts`——HTTP 拉取被 claude/codex 两处复用，须上移 | `.agents/skills/backend-module-standards/SKILL.md:20` | 中 |

## 决策记录

### 决策 1：认证 gate 下沉到 models service，REST 与 `/models` 命令共用

E3b 证实两入口共用同一 `providerModelsService` 单例。gate 实现为 `provider-models.service.ts` 的 `getProviderModels` 依赖注入 `assertProviderAuthenticated`（`provider-auth.service.ts` 新增），REST 路由（`provider.routes.ts`）与 `/models` 命令（`commands.routes.ts`）零改动即共享。`POST active-model` 的 `setSessionModel` 同样注入断言（命令弹窗选择路径会走到它）。models service 保持可测试（依赖注入）。未注册 provider 仍走既有 `UNSUPPORTED_PROVIDER`（路由 `parseProvider`），在认证断言之前。

### 决策 2：gate 标准 = `installed && authenticated`

「未连接」= CLI 未安装（`installed: false`），「未登录」= 无可用凭证（`authenticated: false`）。凭证存在但 CLI 缺失（E12 的 Codex 场景修正后、及 claude settings 配 key 但未装 CLI）仍被拒——符合「未连接不可选」。

### 决策 3：修复安装探测（E13），共享 probe helper

`server/shared/utils.ts` 新增 `runCliVersionProbe(bin, args)`：检查 `spawn.sync` 返回的 `error`（ENOENT）、`status !== 0`、`signal`（超时），任一异常 → `false`。claude/codex/cursor 三个 `checkInstalled` 改为调用它（三处复用，符合 E18 落位）。补 ENOENT / 非零退出码 / 超时测试。

### 决策 4：配置解析与认证共用同一解析器（E6、E12）

- **Codex**：新增 `codex-config.ts`（codex 模块内）解析 `~/.codex/config.toml`：`model`、`model_provider`、`model_providers.<active>.base_url` 与凭证（`experimental_bearer_token` / `api_key` / `env_key` 间接取值）。`codex-auth.checkCredentials` 与 `codex-models.getSupportedModels` 都经它——认证与目录对同一配置只有一种解释（spec: 配置解析唯一）。**base_url 规范化**：去尾部 `/` 与 `/v1` 得 API root，端点恒为 `{root}/v1/models`（E12 的 `/v1` 结尾不再拼出 `/v1/v1/models`）。
- **Claude**：新增 `claude-settings.ts`（claude 模块内）读取 `~/.claude/settings.json` env（`ANTHROPIC_BASE_URL`/`ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN`），`claude-auth` 现有 `loadSettingsEnv` 改为委托它。**base_url 无缺省**：只有 key 无 base_url 视为配置缺失（回退），不联网官方（spec: 不默认官方地址）。凭证 header 与字段类型绑定：API_KEY → `x-api-key`，AUTH_TOKEN → `Authorization: Bearer`。

### 决策 5：HTTP 拉取上移 `server/shared/utils.ts`（E18）

`fetchAnthropicModels` / `fetchOpenAICompatModels` / `normalizeModelsEndpoint` 放 `server/shared/utils.ts`（被 claude/codex 两处复用，符合 SKILL.md 落位）；配置解析器留在各 provider 模块（facet 拥有目录策略，E17）。均带 ~8s 超时，失败返回 `null` 不抛错。

### 决策 6：Pi 不加配置驱动，保持 RPC

E10：Pi 已有实时动态列表且值域为 `<provider>/<id>`，通用 API 无法表达。Pi 只受益于认证 gate 与性能优化（决策 10），生产模型来源零改动。

### 决策 7：Cursor/OpenCode 不在本 change 范围

同一抽象留作扩展：opencode 的 provider 配置在 `~/.config/opencode/`，cursor 无配置文件概念。本 change 只覆盖 claude/codex 两个「用户最可能配 base_url 中转」的 provider。OpenCode 的模型来源（命令输出）保持现状。

### 决策 8：缓存身份由 facet 提供，中央 service 不解析配置（E7、E17）

`IProviderModels.getSupportedModels` 返回形状扩展为目录结果，含原子化的 **cache identity**：`fingerprint`（`hash(base_url + 凭证hash + model_provider + model)`）与 `cacheable`（是否可进长缓存）。`provider-models.service` 缓存 key = `${provider}:${fingerprint}`，`pendingRequests` 用同一完整指纹；`cacheable=false`（配置 API 失败的 fallback）**不写磁盘缓存**（仅内存短驻，TTL ~5min），端点恢复后下轮重试。**不落盘原始凭证**，只落 hash。facet 负责解析配置 → 计算指纹，service 只按指纹缓存——E17 的「facet 拥有目录策略」保持。

### 决策 9：前端认证状态共享 + 四态渲染（E2、E16）

- `ProviderAuthStatus` 补 `installed`（前端 `types.ts` 目前丢弃）。
- `useProviderAuthStatus` 改造为共享 store（模块级单例 + `useSyncExternalStore`，仓库无 zustand，沿用自写 store 风格）；设置页、onboarding、聊天页消费同一状态。失效机制：登录完成（`ProviderLoginModal` 关闭）、设置页关闭、窗口重新聚焦时 `refreshProviderAuthStatuses()`。
- 渲染状态机四态：`loading | authenticated | unauthenticated | error`。`ComposerModelMenu` 与 `CommandResultModal` 都**仅对 `unauthenticated`（确定未认证）隐藏**；loading/error 保持现有禁用骨架（`ComposerModelMenu.tsx:69` 骨架逻辑不回归）。认证翻转 `false→true` 触发 models 重载。

### 决策 10：性能——认证短期缓存 + 在途合并 + 启动次数上限（E16）

- `provider-auth.service` 的 `getProviderAuthStatus` 加短期缓存（~10s）与在途 promise 合并——同一页面内的全量 auth 检查、`/models` 每请求复查共享一次真实探测。
- 对 Pi/Cursor 的 CLI/RPC 启动次数设测试上限：单次「auth 检查 + models 拉取」流程中 Pi 的 RPC 启动 ≤ 2 次（auth 探测 1 + models 拉取 1），靠短期缓存合并后实际更少。
- 前端 `loadProviderModels` 与 auth 检查的触发时机在 store 层合并，避免竞态双拉。

### 决策 11：前端测试纳入脚本（E15）

新增 `test:frontend` 脚本：`cross-env TSX_TSCONFIG_PATH=tsconfig.json node --import tsx --test "src/**/*.test.ts" "src/**/*.test.tsx"`（前端 tsconfig 含 `@/` 映射）。本 change 的验收门禁同时跑 `npm test`（server）与 `test:frontend`。

## 风险与缓解

| 风险 | 缓解 |
|---|---|
| claude 每次实时拉 API（UNCACHED），base_url 不可达拖慢 `/models` | fetch ~8s 超时 + 快速失败回退，失败表现与「未配置」一致（spec: 配置齐全但 API 不可达）；fallback 不进长缓存，恢复后重试 |
| 认证 gate 每请求多一次 auth 检查 | 决策 10 短期缓存 + 在途合并；`/models` 单端点成本从「每次读文件/跑命令」降为「每 10s 一次」 |
| `experimental_bearer_token` 等字段为 Codex 内部实现，可能随版本变化 | 解析器集中在 `codex-config.ts` 单点，字段变更只改一处；`api_key`/`env_key` 仍支持 |
| 配置 API 瞬时失败进长缓存导致长期错误目录 | 决策 8：`cacheable=false` 不进磁盘缓存，恢复后重试 |
| 前端 auth 与 capabilities 两个异步源先后到达 | 四态状态机：两者都就绪才 `authenticated`；任一未就绪保持骨架（spec: 检查中/失败呈现骨架） |
| 共享 auth store 改造影响设置页/onboarding 既有消费 | 保持 `useProviderAuthStatus` 对外 API 签名不变，内部改 store 订阅；既有测试不回归 |
