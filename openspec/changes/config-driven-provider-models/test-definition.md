# 配置驱动模型目录与认证 gate 测试定义

依据 `specs/provider-model-catalog/spec.md`。本 change 的风险：**回归**（改动模型目录对外行为与前端渲染）、**外部依赖**（配置驱动的 API 拉取）、**绕过**（认证 gate 多入口一致性）、**误判**（安装探测、Codex 认证）。测试策略：既有行为用回归锚点锁定，新契约用 spec tests 验证，配置驱动全部 mock 化（零真实网络），认证 gate 逐入口断言，安装探测逐失败模式断言。

**测试落地位置**：后端测试落在 `server/` 下（`npm test` glob：`server/**/*.test.ts`、`server/**/*.test.js`）；前端测试沿用 `src/**/*.test.tsx`，**本 change 新增 `test:frontend` 脚本**纳入门禁（现状 `npm test` 不跑前端，见 E15）。

## 测试目标与边界

**范围内：**
- 认证 gate 的**全部入口**一致性：REST 目录端点、内置 `/models` 命令、`POST active-model`、前端两处渲染（composer 菜单 + 命令弹窗）。
- 安装探测的可靠性：ENOENT / 非零退出码 / 超时均判未安装；「CLI 缺失但凭证存在」仍被拒。
- Codex 认证与配置的联动：config.toml 网关凭证（`experimental_bearer_token`）判已认证；base_url 以 `/v1` 结尾不拼出 `/v1/v1/models`。
- 配置驱动：claude/codex 的「配置齐全 → API 列表」「配置缺失 → 回退」「配置齐全但 API 失败 → 回退且错误不外泄」。
- 缓存契约：完整配置指纹（base_url/凭证/model_provider/model 任一变更失效）、fallback 不进长缓存、端点恢复重试、pendingRequests 完整指纹去重、不落盘凭证。
- 前端：四态渲染（仅确定未认证隐藏，loading/error 骨架）、共享 store 传播、认证翻转重载。
- 既有模型行为的零回归：已认证且未配置路径下 claude/codex 目录与现状逐字节一致。

**范围外：**
- 真实网络的端到端拉取（mock fetch 全覆盖，真实链路由任务 4.2 手动冒烟覆盖）。
- Pi/Cursor/OpenCode 的模型来源实现（Pi 保持 RPC、其余不在本 change 范围）。
- 共享 auth store 对设置页/onboarding 的功能回归（保 API 签名不变，既有测试即回归锚点）。

**刻意的行为变更（不算回归，需单独断言）：**
- 未安装/未认证 provider 的 `GET /:provider/models`：200 + fallback → 401 `PROVIDER_NOT_AUTHENTICATED`
- 未认证 provider 的内置 `/models` 命令：返回列表 → 与 REST 一致的认证错误
- 未认证 provider 的 `POST active-model`：记录成功 → 401
- 未认证 provider 的前端模型选择器（两处）：显示 → 完全隐藏（仅确定未认证）
- Codex 认证判定：仅 auth.json → 增加 config.toml 网关凭证（配置合法凭证者从「未认证」变「已认证」，属修复）
- claude/codex 的 installed 判定：CLI 缺失误判已安装 → 正确判未安装（属修复）

## 覆盖策略

| 维度 | 是否覆盖 | 样本数 | 说明 |
|---|---|---|---|
| 正常路径 | 是 | 6 | 已认证正常拉取（无配置）、claude 配置驱动成功、codex 配置驱动成功、前端认证后渲染、认证翻转重载、Codex 网关凭证认证 |
| 异常 | 是 | 7 | 未安装 401（REST/命令/active-model）、未认证 401、API 超时/非 2xx/坏 JSON、probe ENOENT/非零码/超时 |
| 边界 | 是 | 5 | 只有 key 无 base_url、base_url 以 /v1 结尾、env_key 间接取值、配置部分缺失、缓存指纹各字段变更 |
| 对抗 | 是 | 2 | 配置齐全但 API 失败错误不外泄、CLI 缺失但凭证存在仍被拒 |
| 高风险 | 是 | 3 | 多入口 gate 一致性、fallback 不进长缓存且恢复重试、既有 readiness 测试零回归 |

## 评测集

| 编号 | 输入 | 预期 | 维度 | 来源 |
|---|---|---|---|---|
| R1 | 未安装 CLI 的 provider 请求 `GET /models`（probe 修复后） | 401 `PROVIDER_NOT_AUTHENTICATED`，无模型列表 | 异常 | spec: 可选性 |
| R2 | CLI 缺失但凭证存在（claude settings 配 key 无 CLI / codex 配网关凭证无 CLI） | `installed=false`，仍 401 | 对抗 | spec: 可选性 |
| R3 | 已安装未认证的 provider 请求 `GET /models` | 401，不进缓存 | 异常 | spec: 可选性 |
| R4 | 未认证 provider 执行内置 `/models` 命令 | 与 REST 同一认证错误，无可选列表 | 对抗 | spec: 入口一致 |
| R5 | 未认证 provider `POST active-model` | 401 | 异常 | spec: 入口一致 |
| R6 | 未注册 provider id 请求 `/models` | 既有未注册错误，不落入认证检查 | 异常 | spec: 可选性 |
| R7 | probe 探测 ENOENT | `installed=false` | 异常 | spec: 安装探测可靠 |
| R8 | probe 探测非零退出码 / 超时 | `installed=false` | 异常 | spec: 安装探测可靠 |
| R9 | codex config.toml 有 `experimental_bearer_token` 无 auth.json | `authenticated=true`（修复误判） | 正常 | design: 决策 4 |
| R10 | 已认证且未配置的 claude/codex 请求 `/models` | 200，目录与现状逐字节一致 | 正常/高风险 | spec: 来源回退 |
| R11 | claude settings.json 配 `ANTHROPIC_BASE_URL`+`ANTHROPIC_API_KEY`，端点可达 | 目录来自 `data[].id`，`x-api-key` 发送 | 正常 | spec: 配置驱动 |
| R12 | claude settings.json 配 `ANTHROPIC_AUTH_TOKEN` | 目录来自 API，`Authorization: Bearer` 发送 | 正常 | spec: 配置驱动 |
| R13 | claude 只有 key 无 base_url | 视为配置缺失，回退内置列表，**不联网** | 边界 | spec: 不默认官方地址 |
| R14 | claude 配置齐全但端点超时/非 2xx/坏 JSON | 回退内置列表，请求成功，错误不外泄 | 对抗 | spec: 配置驱动 |
| R15 | codex config.toml `base_url` 以 `/v1` 结尾 + `experimental_bearer_token` | 端点 = root + `/v1/models`（无 `/v1/v1/models`），目录来自 API | 边界 | spec: 配置驱动 |
| R16 | codex `api_key` / `env_key` 间接取值 | 目录来自 API | 正常 | spec: 配置驱动 |
| R17 | codex 配置缺失或 API 失败 | 回退 `models_cache.json` → 内置列表，既有回退链不回归 | 异常/高风险 | spec: 配置驱动 |
| R18 | base_url 从 A 改 B 后请求 `/models` | 旧缓存不命中，以 B 重新拉取 | 边界 | spec: 缓存以配置为键 |
| R19 | 凭证 / `model_provider` / 配置 `model` 任一变更 | 旧缓存不命中，以新配置拉取 | 边界 | spec: 缓存以配置为键 |
| R20 | 配置 API 失败返回 fallback，随后端点恢复 | fallback 未进长缓存；恢复后下一次请求重试成功 | 高风险 | spec: 缓存 fallback |
| R21 | 两个并发配置拉取（同一指纹） | `pendingRequests` 按完整指纹合并，不重复请求 | 正常 | spec: 缓存与去重同指纹 |
| R22 | 缓存落盘内容检查 | 无原始凭证（仅 hash 指纹） | 高风险 | spec: 不落盘凭证 |
| R23 | 当前 provider 确定未认证 | composer 菜单与命令弹窗的模型选择器**都不渲染** | 正常 | spec: 仅未认证隐藏 |
| R24 | 认证状态 loading / error | 两处均保持禁用骨架，不隐藏、不显示列表 | 边界 | spec: 检查中/失败呈现骨架 |
| R25 | 认证翻转 `false→true`（设置页登录/关闭、窗口聚焦刷新） | 共享 store 传播到聊天页，菜单出现并重载模型 | 正常 | design: 决策 9 |
| R26 | 单次「auth 检查 + models 拉取」流程 | Pi 的 RPC 启动次数 ≤ 2（auth 探测 + models 拉取，短期缓存合并后实际更少） | 高风险 | design: 决策 10 |
| R27 | 10s 内重复认证检查 | 命中短期缓存/在途合并，不重复探测 | 正常 | design: 决策 10 |
| R28 | 运行 `test:frontend` | readiness 测试等 `src/**` 用例全绿 | 高风险 | design: 决策 11 |

## 评分规则

二值判定，断言全满足=通过。R10/R17 是回归锚点，以**本 change 前**的行为为准逐条比对；刻意的行为变更（R1、R3–R5、R23、R9、R2）单独断言，不得混入「无变化」结论。配置驱动与探测全部 mock/注入（fetch、配置文件路径、probe 命令），逐样本记录实际来源路径（config→api→cache→fallback）与失败归因。R28 必须给出实际命令输出。

## 验收规则与回归门槛

| 规则 | 门槛 | 适用范围 |
|---|---|---|
| 认证 gate 多入口一致 | 100% | R1、R3–R6、R23 |
| 安装探测可靠 | 100% | R2、R7、R8 |
| Codex 认证修复 | 100% | R9 |
| 配置驱动 | 100% | R11–R16 |
| 缓存契约 | 100% | R18–R22 |
| 回退链零回归 | 100% | R10、R17 |
| 前端渲染零回归 | 100% | R23–R25 及既有 `provider-capability-readiness.test.tsx` 全量 |
| 性能上限 | 100% | R26、R27 |
| 边界 | ≥ 90% | R13、R15、R19、R24 |

## 上线门禁

- [ ] `npm run build`、`npm run typecheck`、`npm run lint` 全绿。
- [ ] `npm test`（server）**与** `test:frontend`（前端，新增脚本）全绿；基线为当前分支全绿（若见既有 agent.routes 全量并发 flake，按 refactor-provider-seams tasks.md 的判定规则重跑至多 2 次再判）。
- [ ] 既有 `provider-capability-readiness.test.tsx` 与 `frontend-provider-capability-contract.test.ts` 全量通过（R23–R25 之外）。
- [ ] 未认证 provider 的 `GET /models` 与内置 `/models` 命令均返回认证错误，且**不写入** `~/.cloudcli/provider-models-cache.json`。
- [ ] 安装探测修复后手动验证：`codex --version` 不可达的环境下 auth status `installed=false`（临时改 PATH 复现）。
- [ ] 手动冒烟：a) 未登录 claude → composer 与 `/models` 命令均不可选、`/models` 401；b) settings.json 配 base_url+key → claude 目录来自该端点；c) codex config.toml 现有 `experimental_bearer_token` 配置 → auth 状态已认证、目录来自 `root/v1/models`；d) 认证翻转（设置页登录/登出）→ 菜单出现/隐藏，刷新传播。

## 报告审核清单

| 审核项 | 必须确认 | 不通过情形 | 结论影响 |
|---|---|---|---|
| 入口覆盖 | REST、`/models` 命令、active-model、前端两处均断言 | 只测 REST 路由 | 不得放行 |
| 探测失败模式 | ENOENT、非零码、超时各一 | 只测 CLI 存在路径 | 不得放行 |
| 来源路径断言 | 每条配置驱动用例断言实际来源（config→api→cache→fallback） | 只断言最终列表内容 | 报告不可信 |
| 缓存证据 | fallback 未进长缓存、指纹变更失效、无凭证落盘均留证 | 未核验缓存文件 | 不能判定通过 |
| BREAKING 标注 | 六处刻意变更（R1/R3–R5/R23/R9/R2）单独列出并核对前端消费点 | 混入「无变化」结论 | 报告不可信 |
| 性能证据 | R26/R27 的实际启动次数/请求数 | 无计数断言 | 结论不成立 |

**结论：** 待执行 — 依上述门禁判定。多入口一致、探测可靠、零回归为一票否决项。
