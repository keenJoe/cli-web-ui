<!-- 复选框标记 `- [ ]` 由 apply 阶段按字面解析以跟踪进度，必须保持该格式；
     标题与任务描述用中文。 -->

## 0. 文件归属

| 任务组 | 独占文件/目录 | 禁止改动 | 共享文件处理 |
|---|---|---|---|
| 1 兼容性契约 | `scripts/probe-pi-vision-bridge.mts`、`server/modules/providers/list/pi/tests/pi-vision-contract.test.ts`、该测试专用 fixtures | 所有生产实现文件 | 无 |
| 2 图片与共享契约 | `shared/vision-bridge.ts`、`server/shared/image-attachments.ts`、`server/shared/types.ts`、`server/shared/tests/image-attachments.test.ts`、`server/modules/assets/services/image-assets.service.ts`、`server/modules/assets/tests/image-assets.service.test.ts` | `server/modules/vision-bridge/`、Pi provider 生产文件、`src/` | 串行到任务组 1 之后 |
| 3 配置与模型目录 | `server/modules/vision-bridge/`、`server/modules/providers/list/pi/pi-vision-model-catalog.provider.ts`、`server/modules/providers/list/pi/pi-vision-launch-policy.provider.ts`、`server/modules/providers/list/pi/index.ts`、`server/index.ts` | Pi runtime/session 文件、`src/` | 串行到任务组 2 之后；只通过 Pi barrel 暴露模型目录 adapter 和 launch-policy 配置函数 |
| 4 视觉桥扩展 | `server/modules/providers/list/pi/extensions/cloudcli-vision-bridge.ts`、`server/modules/providers/list/pi/tests/vision-bridge-extension.test.ts` | `server/modules/vision-bridge/`、前端文件 | 串行到任务组 3 之后；消费已冻结的共享契约和配置 schema |
| 5 Pi live runtime 与会话投影 | `server/modules/providers/list/pi/pi-runtime.provider.ts`、`pi-rpc-client.provider.ts`、`pi-session-store.provider.ts`、`pi-sessions.provider.ts`、对应现有测试及 `server/modules/providers/list/pi/tests/vision-bridge-runtime.test.ts`、`server/modules/providers/services/provider-runtime.service.ts`、`server/modules/providers/tests/provider-runtime.service.test.ts`、`server/modules/websocket/services/chat-websocket.service.ts`、对应 WebSocket 测试 | `server/modules/vision-bridge/`、`src/` | 串行到任务组 4 之后；配置只经 vision-bridge barrel 读取 |
| 6 设置页 | `src/components/settings/` 下视觉桥相关新文件及现有设置注册文件、`src/i18n/locales/*/settings.json` | `server/`、chat/store 文件 | 串行到任务组 5 之后 |
| 7 Chat 状态、历史与卡片 | `src/components/chat/` 下视觉桥相关文件及需要修改的 composer/realtime/message 文件、`src/stores/useSessionStore.ts`、`src/stores/sessionMessageReconciliation.ts` 及对应测试、`src/i18n/locales/*/chat.json` | `server/`、设置页文件 | 串行到任务组 6 之后 |
| 8 发布验证 | `scripts/release/verify-pi-vision-extension.mts`（若需新增）、测试报告文件 | 生产业务实现文件 | 只在任务组 1–7 完成后执行 |

- [x] 0.1 确认任意两个任务组的独占写集无交集；若实现发现需要跨组修改文件，先更新本表并改为串行，不以“注意协调”代替所有权。
- [x] 0.2 确认所有 backend 新模块经 `index.ts` 暴露最小公共接口、跨模块不 deep-import、`server/modules/vision-bridge/tests/` 存放模块测试，且 transport DTO 与 backend-only 类型分别归属根 `shared/` 和 `server/shared/`；Pi runtime 只依赖 Pi-owned launch-policy port，由 composition root 注入 vision-bridge resolver，不能形成模块循环。

## 1. 固化 Pi 0.84.4 兼容性契约

- [x] 1.1 新增最小真实扩展 probe，验证当前锁定的 `@earendil-works/pi-coding-agent@0.84.4` 能加载 `context` 与 `turn_end` handler、没有 `before_provider_payload` 事件、显式注册的 `cloudcli-vision-bridge-health-v1` 会出现在 live `getCommands()` 中，并保留 `--no-extensions -e <explicit-path>` 语义；运行 probe 并保存可审计输出。
- [x] 1.2 用本地 fake/native provider 为 `ModelRegistry` 建立契约测试：`find()` 能取得完整结构化模型快照（至少含 `input`、`api`、`baseUrl`），`complete()` 能接收含图片的 provider-neutral context、返回文字结果，并且不会递归触发宿主视觉桥 handler；若递归则验证 `inVisionCall` guard。
- [x] 1.3 建立 RPC/session 扩展契约测试：namespaced `ctx.ui.setStatus()` 会产生可识别的非阻塞 `extension_ui_request`，`pi.appendEntry()` 会生成不参与 LLM context 的 custom session entry，并验证在 `context`/`turn_end` 可从 `ctx.sessionManager.getEntries()` 对当前 user/tool/history 图片做唯一 `sourceEntryId` 匹配；无法唯一匹配时必须显式返回未绑定状态而非猜最近消息。
- [x] 1.4 运行 `node --import tsx --test server/modules/providers/list/pi/tests/pi-vision-contract.test.ts` 和 `node scripts/probe-pi-vision-bridge.mts`；任一核心契约失败时停止后续任务并更新本 change，不允许自动回退到手写三套 HTTP provider。

## 2. 建立安全图片载荷和共享协议

- [x] 2.1 在 `shared/vision-bridge.ts` 定义 schema version 1 的 `VisionBridgeStoredConfigV1`、`VisionBridgePublicConfigV1`、`VisionBridgeUpdateInputV1`、视觉模型选项、运行事件、图片结果和 batch session 派生条目 DTO，并提供浏览器/Node 均可用的纯 parser/normalizer（不得 import Node-only 模块）；配置字段固定为 `enabled`、`visionModel`、`maxImagesPerRun`、`timeoutMs`、`concurrency`、`maxTokens`、`promptTemplate`、`sources`，不得出现 `userId`、配置绝对路径、`apiKey` 或 `baseUrl`。
- [x] 2.2 先在 `server/shared/tests/image-attachments.test.ts` 增加失败测试，覆盖合法图片、允许目录外路径、symlink 越界、文件不存在、不支持 MIME、超大文件以及多图部分成功；断言绝不读取越界目标且每个失败有稳定原因。
- [x] 2.3 在 `server/shared/image-attachments.ts` 下沉一个可复用的受信图片读取实现，并提供 Pi 投影结果 `{ images, failures }`：浏览器附件只接受全局 upload store 的直接子文件，基于实际字节只允许 JPEG/PNG/GIF/WebP，成功项为 `{ type: "image", data: base64, mimeType }`，失败项保留原始序号和脱敏错误码；不得用 `as never` 掩盖图片类型不匹配，也不得把任意 cwd 文件开放给浏览器附件。
- [x] 2.4 在图片上传服务中计算原始字节 SHA-256，并把稳定 `contentHash` 放入附件响应和 backend attachment descriptor；更新上传测试，确认相同字节跨文件名得到相同 hash、不同字节得到不同 hash。
- [x] 2.5 更新 `ProviderRunRequest` 等 backend-only 类型以携带可选 `clientMessageId` 与带 `contentHash` 的附件描述符，新增 `MessageKind/ProviderRunEvent` 的 `vision_bridge` 变体，并为新增共享定义补充符合 backend standards 的详细 doc comment 和分组注释。
- [x] 2.6 运行 `npm test -- server/shared/tests/image-attachments.test.ts server/modules/assets/tests/image-assets.service.test.ts`（若 test runner 不接受路径参数则运行对应 `node --import tsx --test` 命令），确认新增图片边界测试全部通过。

## 3. 实现按用户隔离的配置和视觉模型目录

- [x] 3.1 在 `server/modules/vision-bridge/tests/` 先写配置 repository/service 失败测试：首次读取默认关闭、用户目录隔离、无用户身份禁用、未知字段/错误版本/范围越界拒绝、相同配置幂等、并发 PUT 串行、文件始终为完整 JSON；POSIX 断言目录 `0700`/文件 `0600`，Windows 断言写入位于当前用户应用目录且不主动放宽 ACL。
- [x] 3.2 实现 per-user 配置 repository：以 `sha256(UTF-8(String(userId)))` 的 64 位小写 hex 作为稳定目录键，写入 `~/.cloudcli/vision-bridge/users/<user-key>/config.json`；POSIX 目录 mode `0700`、文件 mode `0600`，Windows 沿用当前用户应用目录 ACL且不主动放宽；使用进程内写 mutex、同目录临时文件、close 后原子 rename，失败时清理 temp 并保留旧文件，读取时严格白名单解析 schema version 1。
- [x] 3.3 实现 `VisionBridgeConfigService` 的最小公共接口：读取公共配置、保存完整更新、为 live run 解析 `{ enabled, configPath }`；`userId` 缺失或配置损坏时返回非致命 disabled policy 和结构化诊断，不把异常抛给普通 Pi turn。
- [x] 3.4 新增 Pi 视觉模型目录 adapter，使用不带视觉桥的 clean `PiRpcClient` probe 读取实际可用模型；由于官方 wrapper 的 `ModelInfo` 类型收窄了 capability 字段，先扩展 Pi adapter 的本地结构化 decoder，从实际响应中验证 `input`、`api`、`baseUrl` 和 provider/id，再只返回声明 image input 的 provider/id/display metadata、api 摘要与 credential-available 布尔值；不得返回 key、headers 或 endpoint，缺少 `input` 的模型不得进入目录。
- [x] 3.5 在 `server/modules/vision-bridge/tests/` 增加 route 测试，覆盖 `GET /config`、`PUT /config`、`GET /models`、未认证、body/URL 任意 userId 被拒绝、非视觉模型 `ERR-VB-MODEL-NOT-VISION`、模型目录 `ERR-VB-MODELS-UNAVAILABLE`、配置校验 `ERR-VB-CONFIG-INVALID`、持久化 `ERR-VB-CONFIG-WRITE` 和统一 success/error envelope。
- [x] 3.6 创建 `server/modules/vision-bridge/index.ts`，只导出 router factory、per-user config service、launch-policy resolver 和必要类型；新增 Pi-owned launch-policy port，默认返回 disabled，并与模型目录 adapter 一起只经 `server/modules/providers/list/pi/index.ts` 导出给 `server/index.ts` 装配，不允许 vision-bridge deep-import Pi 内部文件。
- [x] 3.7 在 `server/index.ts` 以 `authenticateToken` 挂载 `/api/vision-bridge`，把当前用户 ID 和 Pi 视觉模型目录 port 注入模块，并把 resolver 注入 Pi-owned launch-policy port；运行 `node --import tsx --test "server/modules/vision-bridge/tests/*.test.ts"`。

## 4. 实现 provider-neutral 视觉桥扩展

- [x] 4.1 在 `server/modules/providers/list/pi/tests/vision-bridge-extension.test.ts` 建立 fake ExtensionAPI/ExtensionContext 测试夹具，先覆盖：只用 `context` 做转换并用 `turn_end` 做持久化、原生视觉模型零调用、无视觉模型转换成功、用户/工具/历史三种图片来源、来源策略、部分失败、超限、总时限、取消和异常降级。
- [x] 4.2 新建 `extensions/cloudcli-vision-bridge.ts`，只依赖 Node 内置模块、`@earendil-works/pi-coding-agent` 和纯 `shared/vision-bridge` contract/parser；不得直接 import `@earendil-works/pi-ai` 或 `undici`，不得注册 `before_provider_payload` 或解析 provider-specific payload；只额外注册无副作用健康命令 `cloudcli-vision-bridge-health-v1` 供 live runtime pre-prompt 握手。
- [x] 4.3 实现严格 runtime config parser：只从 `CLOUDCLI_VISION_BRIDGE_CONFIG_PATH` 读取 schema version 1 配置；每个 Pi child 第一次 `context` 调用时读取并缓存一个完整快照，缺失、损坏或 disabled 时不调用视觉模型；不得自行推断 `~/.pi/agent` 或读取其他用户配置。
- [x] 4.4 实现单一 `context` transformer：复制并遍历 provider-neutral messages，依据当前模型能力与 user/tool 来源策略收集图片；将本次 context 的最后一个 user message 作为当前 prompt 候选，用 child env 中的 contentHash 多重集合做一致性校验，并把（如有）clientMessageId 仅用于新消息关联；校验不唯一时仍可转换但不发布可归属 realtime card；工具消息使用 `toolCallId`，历史消息只有能唯一匹配 session entry 时才附 `sourceEntryId`；当前模型支持 image 时返回原消息，当前模型不支持 image 时仅替换本次 LLM context，绝不修改 session 中的原始消息对象。
- [x] 4.5 使用 `ctx.modelRegistry.find()` 验证视觉模型存在且支持 image，并用 `ctx.modelRegistry.complete()` 调用；整个 CloudCLI/Pi provider run 共享 `maxImagesPerRun` 调用预算，多个 `context` 回调不能重置计数；每批共享总 deadline，默认 20 秒、最多 4 张、并发 2、单图输出上限 1024 tokens，不实现额外 provider-specific HTTP 或协议重试；内部 completion 必须受 `inVisionCall` guard 保护。
- [x] 4.6 实现安全视觉观察封装：明确标记为系统生成但不可信的数据，转义内部 delimiter，禁止图片内指令获得用户授权语义；逐图保留 success/failed/skipped/cancelled 结果及原始序号。
- [x] 4.7 实现成功缓存：cache key 包含原始字节 hash、MIME、视觉模型 provider/id、规范化 prompt fingerprint、maxTokens、source policy 和 schema/config version；只复用成功结果，不持久缓存超时、限流、网络或取消失败；重复图片位置仍生成独立 observationId，session success 优先复用且不消耗 `maxImagesPerRun` 调用预算。
- [x] 4.8 用 namespaced `ctx.ui.setStatus("cloudcli.vision-bridge.v1", json)` 发布 started 与终态，用 `turn_end` 将已完成批次通过 `pi.appendEntry("cloudcli.vision-bridge.v1", data)` 保存；status text 严格限制为 16 KiB，事件不得包含图片字节、凭据或未经截断的底层错误；取消终态由 runtime authoritative 合成，不能依赖 abort 后扩展事件。
- [x] 4.9 运行扩展测试并用 TypeScript strict build 验证扩展无 TS2307、TS2339、TS2769；保留 PiDeck MIT 来源说明仅限实际复用的代码片段，不整文件复制旧实现。

## 5. 接入 Pi live runtime、结构化事件和 session 历史

- [x] 5.1 为前端 optimistic 用户消息生成稳定 `clientMessageId`，把它放入 `chat.send`；WebSocket route 只接受受限长度/字符集的 ID 并传入 `ProviderRunRequest`，缺失时 server 生成仅用于本次 run 的 correlation，并继续使用既有 text/image/file fingerprint fallback，客户端不得指定 runId/providerSessionId。
- [x] 5.2 在 Pi runtime 启动前调用 Pi-owned、由 composition root 注入的 launch-policy port；只有 `userId` 有效且配置启用时才给 live RPC args 追加 `-e <resolved-extension-path>`，并通过 child env 传 `CLOUDCLI_VISION_BRIDGE_CONFIG_PATH`、run/app-session/client-message correlation；auth/model/skills probes 不调用该 policy。
- [x] 5.3 实现 dev/prod 扩展路径 resolver：基于 `import.meta.url` 在开发态选择 sibling `.ts`、编译/发布态选择 sibling `.js`，只返回存在的绝对路径；添加 source build、`dist-server` build 和缺失文件测试。
- [x] 5.4 保持 `PiRpcClient` 的既有 `PI_ENABLE_EXTENSIONS` 语义：默认固定参数仍为 `--no-extensions`，显式 `-e` 与其共存；环境变量为 1 时允许既有扩展发现，不编写“其他扩展仍禁用”的错误断言。
- [x] 5.5 在 Pi runtime 订阅并解析 `method:"setStatus"`、key 为 `cloudcli.vision-bridge.v1` 的非阻塞扩展事件，拒绝超过 16 KiB 的 statusText，使用共享 parser 校验 schema，以当前 `ProviderRunRequest` 覆盖 child 声称的 `runId/appSessionId/userId`，映射为新的 `vision_bridge` ProviderRunEvent；其他 setStatus 或畸形 payload 只做脱敏忽略/诊断，不把整个 Pi run 判为协议失败。
- [x] 5.6 为视觉桥硬启动失败实现一次性无桥重试，并把 live 启动顺序改为 `start → getState → getCommands/health → bind native session → subscribe → prompt`：健康成功前不得持久化或广播首次 child 的 native session ID；只在 `start/getState/getCommands` 明确失败或健康命令缺失时触发；官方 `rpc.prompt()` 超时、connection timeout 或 child close 无法证明 prompt 未接受时禁止重放；第二次不得再次重试；重试成功发布 `ERR-VB-EXTENSION-START` 非致命状态，重试失败走现有 Pi run failure。
- [x] 5.7 扩展 Pi session store/sessions projection：保留 user message 的 image blocks，并按现有 Claude history 约定映射为 `ChatImage.data` data URL（附 `mimeType/contentHash`，受单页 32 MiB 图片总字节上限约束）；把 `customType:"cloudcli.vision-bridge.v1"` 条目投影成稳定的 `vision_bridge` normalized message；custom entry 保存 `sourceEntryId`/client identity，无法唯一锚定时不通过最近消息猜测；完整描述只沿用既有 app session/history 访问边界返回。
- [x] 5.8 新增 runtime/session 测试，覆盖合法 `ImageContent` 真正传给 RPC、native vision path、live-only `-e`、probe 无 bridge、`PI_ENABLE_EXTENSIONS=1`、事件 schema、相同图片跨会话隔离、一次 fallback、取消后无迟到事件、custom entry 历史恢复和原始图片保留。
- [x] 5.9 运行全部 Pi provider、provider runtime 与 WebSocket 相关 backend 测试，确认现有文本、权限、中止、模型目录和技能目录行为无回归。

## 6. 实现视觉桥设置页

- [x] 6.1 新建设置 hook/client，读取 `/api/vision-bridge/config` 与 `/models`，只使用公共 DTO；测试响应中即使出现未知 secret 字段也不会写入表单或日志。
- [x] 6.2 新建 `VisionBridgeSettingsTab`：默认关闭、只列 image-capable 模型、配置图片上限/总时限/并发/输出上限、用户图片开关和默认关闭的工具图片开关，不提供 API key/baseUrl 输入框。
- [x] 6.3 在从关闭切换为开启时展示并要求确认数据外发说明，明确显示视觉供应商、模型和工具图片策略；模型缺失或 credential unavailable 时禁止保存并展示可恢复错误。
- [x] 6.4 在 Settings type、sidebar/main content 中注册视觉桥 Tab，并补全全部 `src/i18n/locales/*/settings.json` 文案；保持移动端和桌面设置布局一致。
- [x] 6.5 增加设置页测试，覆盖默认关闭、模型过滤、脱敏、确认外发、工具图片默认关闭、保存成功、保存失败保持旧配置和跨 Tab 重开状态。

## 7. 实现实时卡片、历史卡片和消息一致性

- [x] 7.1 扩展前端 normalized message/store 类型，按 `appSessionId + runId + clientMessageId/toolCallId + imageIndex` 保存视觉桥 started/终态；图片 `contentHash` 只作为内容校验和缓存提示，不作为消息主身份。
- [x] 7.2 在 realtime handler/store 中处理 `vision_bridge` ProviderRunEvent，并在收到现有 `complete(aborted:true)` 时为该 run 已 started 且未终态的 observation 同步合成 cancelled；保证首个终态获胜、取消后拒绝迟到成功、其他 session 的相同图片事件不能修改当前气泡。
- [x] 7.3 新增 `VisionBridgeCard`，结构化渲染 processing/succeeded/failed/skipped/cancelled；成功描述作为派生内容展示，失败原因只显示脱敏文案，原始用户图片继续由 `ChatMessageImages` 展示，并补齐全部 `src/i18n/locales/*/chat.json` 状态文案。
- [x] 7.4 修改用户消息与工具结果渲染，把结构化卡片挂到对应 `clientMessageId`、`toolCallId` 或唯一 `sourceEntryId`；无唯一锚点的历史结果显示为明确的 session-level“未绑定来源”卡片，不猜最近消息；删除依赖自然语言 marker 的可信判定，普通 `[图片 #N ...]` 文本必须原样进入 Markdown/文本渲染。
- [x] 7.5 修改 session message reconciliation，优先以稳定 `clientMessageId` 合并 optimistic 与持久化 Pi user message；fallback 指纹仍保持兼容，视觉桥 custom entry 不得生成第二条用户气泡。
- [x] 7.6 增加前端测试：started→success、failed/skipped/cancelled、同图跨会话、终态重放幂等、迟到事件、历史恢复、原图保留、marker spoof 不生成卡片、不吞正文、optimistic/history 只保留一个用户气泡。
- [x] 7.7 运行 `npm run test:frontend`，确认视觉桥及现有 chat/session/settings 测试全部通过。

## 8. 构建、发布和端到端收口

- [x] 8.1 运行 `npm test`、`npm run test:frontend`、`npm run typecheck`、`npm run lint` 和 `npm run build`，所有 deterministic spec contract 必须 100% 通过。
- [x] 8.2 运行 `npm run server:bundle`，从 staging/archive 中确认 compiled `cloudcli-vision-bridge.js`、共享 contract 和全部 production dependencies 存在；用发布产物实际启动 Pi RPC 并完成扩展加载 probe。
- [x] 8.3 使用真实 Pi 0.84.4 subprocess、受控本地视觉 provider 和无视觉主 provider 做 E2E：发送 path attachment，断言安全 adapter 生成 base64、视觉 provider 收图、主 provider 只收不可信观察文本、原始 session 消息仍保留图片、实时和历史卡片关联同一 `clientMessageId`。
- [x] 8.4 做失败 E2E：视觉 provider 超时、返回错误、扩展缺失、用户取消、工具图片未授权、相同图片跨两个 session；确认 per-user bridge 配置不串用户、runtime 状态不串 app session、没有新增全局描述/events 查询、无 secret/图片字节日志，基础 Pi 文本 turn 可继续或按既有语义失败。
- [x] 8.5 保存逐样本测试证据并按 `test-definition.md` 审核；任一 SHALL 场景、生产 bundle smoke 或高风险样本失败时不得完成本 change。记录修订日期为 2026-09-04，避免将相对日期解释为未来门禁。
