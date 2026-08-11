# 配置驱动模型目录与认证 gate 实现任务

「构建什么」见 `specs/provider-model-catalog/spec.md`，「怎么构建」见 `design.md`。

**前置约束**：
- 任务组 1（认证 gate 与安装探测）改变 `/:provider/models`、`/models` 命令与 active-model 的对外行为，必须先落地并验证，否则未认证 provider 拉配置 API 产生无意义请求。
- 任务组 2（配置驱动与缓存契约）依赖任务组 1 的 gate 语义（已认证才拉取），串行在 1 之后；其内部 2.1–2.3（解析器/拉取）先于 2.4–2.5（facet 接入与缓存）。
- 任务组 3（前端与性能）写集在 `src/` 与 `package.json`，可与任务组 2 并行，但依赖任务组 1 的 gate 语义验证；`test:frontend` 脚本（3.4）须在 3.2 之前存在以跑前端用例。
- Pi/Cursor/OpenCode 的模型来源生产代码零改动（Pi 只受益于 gate 与性能优化）。

## 0. 文件归属

| 任务组 | 独占文件/目录 | 禁止改动 | 共享文件处理 |
|---|---|---|---|
| 1 | `server/modules/providers/services/provider-models.service.ts`（gate 注入段）、`provider-auth.service.ts`、`provider.routes.ts`、`server/modules/commands/commands.routes.ts`、`server/shared/utils.ts` 的 **probe helper 段**、`list/{claude,codex,cursor}/*-auth.provider.ts`、`list/codex/codex-auth.provider.ts`（凭证补判段）及各自直接测试 | `list/` 的模型来源实现、前端 | 串行先于任务组 2；`provider-models.service.ts` 与 2.5 共享该文件，由串行顺序保证无冲突 |
| 2 | 新增 `list/codex/codex-config.ts`、`list/claude/claude-settings.ts`、`server/shared/utils.ts` 的 **fetcher 段**、`server/shared/interfaces.ts` 的 **`IProviderModels` 段**、`list/claude/claude-models.provider.ts`、`list/codex/codex-models.provider.ts`、`provider-models.service.ts`（缓存段）及各自直接测试 | 前端、runtime 文件、DB | 串行在任务组 1 之后；2.4/2.5 依赖 2.1–2.3 |
| 3 | `src/components/provider-auth/types.ts`、`hooks/useProviderAuthStatus.ts`、`src/components/chat/hooks/useChatProviderState.ts`、`view/subcomponents/ComposerModelMenu.tsx`、`CommandResultModal.tsx`、`ChatComposer.tsx`、`package.json`（test:frontend）、`src/**` 对应测试 | server 生产代码 | 可与 2 并行（写集不相交）；`test:frontend`（3.4）先于 3.2 落地 |
| 4 | 无（只运行验证） | 全部 | 只读 |

## 1. 认证 gate、安装探测与命令入口（先于一切实现）

- [ ] 1.1 **修复安装探测（E13）**：`server/shared/utils.ts` 新增 `runCliVersionProbe(bin, args)`——检查 `spawn.sync` 返回的 `error`（ENOENT）、`status !== 0`、`signal`（超时），任一异常 → `false`；claude/codex/cursor 三个 `checkInstalled` 改为调用它。
      → 验证：R7、R8（ENOENT / 非零退出码 / 超时各一，mock `spawn.sync`）。
- [ ] 1.2 **gate 下沉到 service（E3/E3b）**：`provider-auth.service.ts` 新增 `assertProviderAuthenticated(provider)`（未 `installed` 或未 `authenticated` 抛 `AppError('provider 未安装或未认证', { code: 'PROVIDER_NOT_AUTHENTICATED', statusCode: 401 })`——**message 与 code 分离**，E14）；`provider-models.service.ts` 的 `getProviderModels`/`setSessionModel` 依赖注入该断言；`provider.routes.ts` 与 `commands.routes.ts` 的 `/models` 经同一 service 自动共享。
      → 验证：R1、R3、R4、R5（REST 401、命令 401、active-model 401、未注册仍走既有错误）。
- [ ] 1.3 **Codex 认证补 config 凭证（E12）**：`codex-auth.checkCredentials` 读 config.toml 的 `model_providers.<active>` 凭证（`experimental_bearer_token`/`api_key`/`env_key`），有合法凭证即 `authenticated=true`——**先实现 2.1 的 `codex-config.ts` 解析器再接入本任务**（解析器先于依赖它的认证）。
      → 验证：R9（有网关凭证无 auth.json → 已认证）。
- [ ] 1.4 阶段验收：`npm test` 全绿；任务组 2/3 可在本组通过后并行开始。

## 2. 配置驱动与缓存契约

- [ ] 2.1 **Codex 配置解析器**（新增 `list/codex/codex-config.ts`）：解析 `~/.codex/config.toml` 的 `model`、`model_provider`、`model_providers.<active>.base_url` 与凭证（含 `env_key` 间接取值）；`normalizeModelsEndpoint`（去尾部 `/` 与 `/v1` 后追加 `/v1/models`）供模型端点使用。auth（1.3）与 models（2.4）共用。
      → 验证：R15、R16（`/v1` 结尾不产生 `/v1/v1/models`；env_key 场景）；E12 消解留证（本机实测配置结构记录于 design.md）。
- [ ] 2.2 **Claude settings 解析器**（新增 `list/claude/claude-settings.ts`）：读 `~/.claude/settings.json` env 的 `ANTHROPIC_BASE_URL`/`ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN`；`claude-auth` 现有 `loadSettingsEnv` 改为委托它（E6 去重）。**base_url 无缺省**（只有 key 视为配置缺失）。
      → 验证：R13（只有 key 无 base_url → 回退不联网）；claude-auth 既有认证行为零回归。
- [ ] 2.3 **HTTP 拉取上移**（E18）：`server/shared/utils.ts` 新增 `fetchAnthropicModels`（`x-api-key` 或 `Authorization: Bearer` + `anthropic-version: 2023-06-01`）、`fetchOpenAICompatModels`（`Authorization: Bearer`）、`normalizeModelsEndpoint`；均 ~8s 超时、失败返回 `null` 不抛错。
      → 验证：两种协议的成功/超时/非 2xx/坏 JSON 各一（mock fetch + fake timer）。
- [ ] 2.4 **facet 接入配置优先**：`claude-models.provider.ts`、`codex-models.provider.ts` 的 `getSupportedModels()` 增加第一优先级「配置齐全 → API 拉取 → 解析」，失败逐级回退既有来源（claude 内置列表；codex `models_cache.json` → 内置列表）；成功结果与配置 API 成功结果带 cache identity（见 2.5 契约）。Pi/Cursor/OpenCode 不动。
      → 验证：R10、R11、R12、R14、R17（含配置缺失/API 失败回退与现状逐字节一致）。
- [ ] 2.5 **缓存契约（E7/E17）**：`interfaces.ts` 的 `IProviderModels.getSupportedModels` 返回形状扩展为含 **cache identity**（`fingerprint` = `hash(base_url + 凭证hash + model_provider + model)`、`cacheable`）；`provider-models.service` 缓存 key 与 `pendingRequests` 均用 `${provider}:${fingerprint}`；`cacheable=false`（配置 API 失败 fallback）不写磁盘缓存（内存短驻 ~5min）；不落盘原始凭证。
      → 验证：R18、R19（base_url/凭证/model_provider/model 变更失效）、R20（fallback 不进长缓存、恢复重试）、R21（同指纹并发合并）、R22（缓存文件无凭证）。

## 3. 前端认证状态与性能

- [ ] 3.1 **共享 auth store（E2）**：`provider-auth/types.ts` 的 `ProviderAuthStatus` 补 `installed`；`useProviderAuthStatus` 改造为模块级单例 store（`useSyncExternalStore`），对外 API 签名不变；失效机制：登录完成（`ProviderLoginModal` 关闭）、设置页关闭、窗口重新聚焦时 `refreshProviderAuthStatuses()`。
      → 验证：设置页/onboarding 既有消费零回归；R25 的传播链路有测试。
- [ ] 3.2 **四态渲染（E2 续）**：`useChatProviderState` 输出认证四态（`loading | authenticated | unauthenticated | error`）；`ComposerModelMenu` 与 `CommandResultModal` 仅对 `unauthenticated` 隐藏（loading/error 保持现有禁用骨架）；认证翻转 `false→true` 触发 `loadProviderModels()`。
      → 验证：R23、R24、R25（未认证两入口都不渲染；loading/error 骨架；翻转重载）。**前置**：3.4 的 `test:frontend` 已存在。
- [ ] 3.3 **性能（E16）**：`provider-auth.service` 的 `getProviderAuthStatus` 加短期缓存（~10s）与在途 promise 合并；前端 `loadProviderModels` 与 auth 刷新在 store 层合并触发。
      → 验证：R26（单次 auth+models 流程 Pi RPC 启动 ≤ 2）、R27（10s 内复查命中缓存/合并）。
- [ ] 3.4 **前端测试脚本（E15）**：`package.json` 新增 `test:frontend`（`cross-env TSX_TSCONFIG_PATH=tsconfig.json node --import tsx --test "src/**/*.test.ts" "src/**/*.test.tsx"`）。
      → 验证：`npm run test:frontend` 跑通 `provider-capability-readiness.test.tsx` 等全部 `src/**` 用例。

## 4. 验收

- [ ] 4.1 `npm run build`、`npm run typecheck`、`npm run lint`、`npm test`、`npm run test:frontend` 全绿（R28）；任务组 1/2/3 新增用例全部纳入对应 glob。
- [ ] 4.2 手动冒烟（test-definition 上线门禁的 a–d 四场景）：未登录不可选（两入口）、settings.json 配置生效、codex 真实 `experimental_bearer_token` 配置认证+目录、认证翻转传播。
- [ ] 4.3 缓存核验：未认证 401 后 `~/.cloudcli/provider-models-cache.json` 无新增条目；配置 API 失败后缓存仅内存、无凭证字段。
