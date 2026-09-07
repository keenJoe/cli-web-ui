<!-- 本文负责：技术决策、模块边界、契约语义、数据模型、非功能要求。
     本文不负责：需求动机（见 proposal.md）、行为契约（见 specs/）、
     任务拆分与进度（见 tasks.md）。
     修订日期：2026-09-04。 -->

## 背景

本设计实现 proposal.md 中的视觉桥能力，但不直接搬运 PiDeck 的 1114 行扩展。当前工程锁定 `@earendil-works/pi-coding-agent@0.84.4`，其真实图片输入、扩展 hook、RPC deadline、session 投影和多用户 Web server 信任边界与 PiDeck 不同。本设计先修复宿主附件到 Pi 图片载荷的缺口，再在 Pi provider-neutral context seam 中转换图片；原始消息保持不变，派生视觉结果通过现有 RPC 和 Pi session custom entry 传递。

## 证据登记

| 编号 | 标签 | 陈述 | 依据 | 风险 |
|---|---|---|---|---|
| E1 | `[CONFIRMED]` | `ProviderRunRequest.images` 当前是包含 path 的 `ChatAttachmentDescriptor[]`，Pi runtime 原样传给 `rpc.prompt()` | `server/shared/types.ts:366-381`、`server/modules/providers/list/pi/pi-runtime.provider.ts:435-440,781` | 高 |
| E2 | `[CONFIRMED]` | Pi RPC 要求 `ImageContent[]`，每项必须包含 `type:"image"`、base64 `data` 和 `mimeType` | `node_modules/@earendil-works/pi-coding-agent/dist/modes/rpc/rpc-client.d.ts:66`、其嵌套 `pi-ai/dist/types.d.ts:251-255` | 高 |
| E3 | `[CONFIRMED]` | Pi 0.84.4 支持 `context`、`before_provider_request`、`tool_result` 和 `input`，不支持 `before_provider_payload` | `node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts:919-942` | 高 |
| E4 | `[CONFIRMED]` | `context` 接收 provider-neutral `AgentMessage[]`；无视觉图片在更晚的 provider transform 中才降级为 omitted 文本 | `node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts:513-521`、`node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/api/transform-messages.js:19-50` | 高 |
| E5 | `[CONFIRMED]` | `ModelRegistry` 提供 `find()`、`getApiKeyAndHeaders()` 和 `complete()`，可复用 Pi 的模型与 provider runtime | `node_modules/@earendil-works/pi-coding-agent/dist/core/model-registry.d.ts:23-36` | 中 |
| E6 | `[CONFIRMED]` | RPC prompt response 要等 input preflight 完成，官方 command response timeout 固定为 30 秒 | `node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js:839-850,948-949`、`node_modules/@earendil-works/pi-coding-agent/dist/modes/rpc/rpc-client.js:456-462` | 高 |
| E7 | `[CONFIRMED]` | 当前工程每个 Pi run 创建并在 settle 后关闭一个 RPC child，进程内状态通常只存活一个 run | `server/modules/providers/list/pi/pi-runtime.provider.ts:449,552-593` | 中 |
| E8 | `[CONFIRMED]` | RPC 模式的 `ctx.ui.setStatus()` 会发出非阻塞 `extension_ui_request`，Pi extension 可用 `appendEntry()` 保存不参与 LLM context 的 custom entry | `node_modules/@earendil-works/pi-coding-agent/dist/modes/rpc/rpc-mode.js:101-108`、`node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.d.ts:59-70`、`node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts:984-985` | 中 |
| E9 | `[CONFIRMED]` | 通用 `PiRpcClient` 同时被 live runtime、auth、model 和 skills probes 使用 | `pi-runtime.provider.ts:107`、`pi-auth.provider.ts:39,96`、`pi.provider.ts:44`、`pi-skills.provider.ts:54` | 高 |
| E10 | `[CONFIRMED]` | 默认 `PI_ENABLE_EXTENSIONS` 关闭时 wrapper 添加 `--no-extensions`；值为 1 时移除该参数，显式 `-e` 在两种模式都可工作 | `pi-rpc-client.provider.ts:77-90`、`.../cli/args.js:293-294` | 中 |
| E11 | `[CONFIRMED]` | optimistic user reconciliation 当前严格比较 text、imageCount 和 fileCount，重写用户消息会导致无法合并 | `src/stores/sessionMessageReconciliation.ts:182-201,269-313` | 高 |
| E12 | `[CONFIRMED]` | Pi session store 已保留所有 active-branch entries，但当前 history adapter 只投影 message 的 text/thinking，不投影 image/custom entry | `pi-session-store.provider.ts:41-66,95-126`、`pi-sessions.provider.ts:48-75,101-118` | 中 |
| E13 | `[CONFIRMED]` | server 已有 JWT 用户身份，`ProviderRunRequest` 携带 `userId`，且服务默认可监听非 loopback 地址 | `server/shared/types.ts:366-384`、`server/index.ts:290-291` | 高 |
| E14 | `[CONFIRMED]` | server build 把扩展 TS 编译到 `dist-server`，发布 server bundle 只复制构建产物并执行 production dependency install | `server/tsconfig.json:23-35`、`scripts/release/build-server-bundle.js:121-137` | 高 |
| E15 | `[CONFIRMED]` | RPC `get_available_models` 的实际响应数据包含完整 `Model<any>`（含 `input`、`api`、`baseUrl` 等），但当前 wrapper 对外收窄为 `ModelInfo`，因此视觉模型目录必须在 Pi adapter 内做结构化解码而不能假设现有应用 DTO 已保留能力字段 | `node_modules/@earendil-works/pi-coding-agent/dist/modes/rpc/rpc-types.d.ts:225-228`、`node_modules/@earendil-works/pi-coding-agent/dist/modes/rpc/rpc-client.d.ts:28-33`、`server/modules/providers/list/pi/pi-models.provider.ts:27-67` | 中 |
| E16 | `[CONFIRMED]` | 当前 `sessions` 表没有 `user_id`，Pi auth、上传 assets 和历史 session 是宿主级资源；本 change 只能新增 per-user bridge config 和不新增绕权路径，不能单独宣称完整 tenant isolation | `server/modules/database/schema.ts:100-120`、`server/modules/assets/`、`server/modules/providers/services/sessions.service.ts` | 高 |
| E17 | `[CONFIRMED]` | `ProviderRunCoordinator.abortRun()` 先把 run 置为 aborted 并停止后续 sink.emit，扩展在 abort 后发送的状态不保证到达前端；现有 `complete(aborted:true)` 是客户端可依赖的终态信号 | `server/modules/providers/services/provider-run-coordinator.service.ts:135-155,184-206` | 高 |

- [x] 每条关于现存代码的陈述都已登记。
- [x] 本设计没有把影响权限、外发或数据隔离的推断当作已确认事实。
- [x] 所有高风险决策均由已确认的当前代码/API 约束支撑。

## 目标 / 非目标

**目标：**

- 建立从受信 path attachment 到合法 Pi `ImageContent` 的安全 adapter，原生视觉与视觉桥共用该入口；浏览器提交的附件只允许现有全局上传 store 的直接子文件，不能把任意 cwd 暴露给 Pi。
- 以 `context` 为唯一 correctness seam，在 provider-specific downgrade 前统一处理用户、工具和历史图片。
- 通过 Pi model registry/provider runtime 调用视觉模型，不复制凭据、不重新实现多 provider HTTP。
- 原始消息和图片保持为会话事实源；派生观察结构化、可关联、可恢复且不可由正文伪造。
- 配置和运行策略按 CloudCLI 用户隔离，且不新增绕过既有 session/asset 授权的读取路径；live runtime 与 probes 隔离，失败有界且不降低基础 Pi 可用性。

**非目标：**

- 不兼容或读取 PiDeck 的 `pi-deck-vision.json`/events/log 文件；本能力使用 CloudCLI 自有 versioned contract。
- 不提供视觉桥专用 apiKey、baseUrl 或 provider HTTP 配置；自定义 provider 必须先在 Pi 中配置。
- 不新增机器全局 JSONL 事件总线或日志查看页。
- 不修改其他四个非 Pi provider 的图片管道。
- 不评测视觉模型对开放世界图片的主观识别质量。
- 不提供跨 Pi session 的全局视觉描述缓存。

## 设计决策

### D1：先在宿主边界把 path attachment 投影为合法 ImageContent

Pi runtime 在调用 RPC 前使用共享的受信图片读取实现：浏览器提交的附件只能来自现有全局 upload store 的直接子文件；实现验证允许根目录和 realpath、校验实际 MIME 与原始字节大小、读取 bytes、计算 raw-byte SHA-256、编码 base64。结果是 `{ images, failures }`；单图失败不会阻止文本和其他合法图片，runtime 为失败附件产生结构化 skipped/failed 结果。工具结果里的 `ImageContent` 已经是 Pi 内部信任边界的产物，不经过这个浏览器路径 adapter。

替代方案“让扩展按 path 读取文件”被否决：RPC input 类型不携带受信根目录，扩展无法复用宿主上传安全边界，也会把本地文件访问权限扩散到另一进程；把任意运行 cwd 作为浏览器附件根目录同样被否决，因为它会扩大客户端可读文件范围。

### D2：`context` 是唯一正确性 hook，`turn_end` 只负责持久化

扩展在 `context` 阶段看到 provider-neutral messages 中的 user/toolResult/history 图片，并在 provider transform 把图片降级前返回替换后的 clone。当前模型支持 image 时返回原 messages；当前模型不支持 image 时，符合来源策略的 image block 被不可信视觉观察或逐图失败说明替换。扩展另外注册 `turn_end`，只把已完成批次写为 namespaced custom entry；它不参与图片正确性转换。

不使用耗时 `input` 转换：它阻塞 RPC prompt preflight，受固定 30 秒 command timeout 影响，并会重写被持久化的用户消息。不用 `before_provider_request` 做历史兜底：该时点已经是 provider-specific payload，原图可能丢失。`tool_result` 不是 correctness 必需点；工具身份在 `context` 的 toolResult message 中已存在。`context` handler 必须自行把内部异常折叠为逐图失败观察，因为 Pi runner 会吞掉 handler 异常并继续使用原消息。

### D3：视觉调用复用 ModelRegistry，而不是手写 HTTP

配置只保存 `{provider,id}`。扩展用 `modelRegistry.find()` 取得模型并验证 `input` 包含 image，然后用 `modelRegistry.complete()` 发送一条只含提示文本和当前图片的 provider-neutral 请求。视觉调用设置 `inVisionCall` guard；若 0.84.4 contract test 发现 completion 会重新进入同一扩展，则 guard 必须让内部调用直接旁路。凭据、endpoint、headers、OAuth、API kind、proxy 和响应由 Pi provider runtime 负责。

替代方案“复制 PiDeck 的 OpenAI/Anthropic/Gemini adapter”被否决：它重复 Pi 的深模块、只覆盖部分 API、会产生 endpoint/secret 拼接风险，并引入未声明的 `undici` 依赖。

### D4：原始消息与派生观察分离

`context` 返回的是 clone，不修改 agent/session 中的原始 user 或 toolResult message。实时 started/终态通过 `ctx.ui.setStatus("cloudcli.vision-bridge.v1", JSON.stringify(event))` 进入现有 RPC；status text 的 JSON 只包含 schemaVersion、eventId、observationId、batchId、phase、source、imageIndex、contentHash、模型摘要、脱敏 reason 和受限描述。运行时覆盖 child 提供的 `runId/appSessionId`，并限制 payload 大小。`turn_end` 再用 `pi.appendEntry("cloudcli.vision-bridge.v1", data)` 保存已完成终态；中止时可能没有 `turn_end`，现有 `complete(aborted:true)` 由前端/store 对该 run 已 started 且未终态的 observation 合成 authoritative `cancelled`，不承诺扩展写入 cancelled custom entry。Pi session adapter 把原始 image block 和 custom entry 分别投影为原消息与视觉卡片。

正文 marker 方案被否决：自然语言可被用户、图片或模型伪造，regex 还会吞掉普通正文。UI 只信任经过 server schema 校验的结构化事件和 session entry。

### D5：配置按用户隔离、无 secret，并由宿主传入绝对路径

每个用户配置写入：

```text
~/.cloudcli/vision-bridge/users/<sha256(String(userId))>/config.json
```

`<user-key>` 固定为 `sha256(UTF-8(String(userId)))` 的 64 位小写 hex；hash 只用于构造无路径字符的稳定目录名，不替代授权。Server 以 mutex + 同目录 temp file + atomic rename 保存；POSIX 配置目录为 `0700`、文件为 `0600`，Windows 沿用当前用户应用目录 ACL 且不主动放宽；写失败后清理 temp 并保留旧文件。Pi live child 仅收到 `CLOUDCLI_VISION_BRIDGE_CONFIG_PATH`，扩展不自行推断 home/agentDir。`userId` 缺失时 policy 为 disabled。配置无 apiKey/baseUrl，因此浏览器 public DTO 与磁盘配置不存在 secret 回显问题；模型凭据只在 Pi registry 内解析。该路径只隔离 bridge 配置，不改变 Pi host-level credentials、全局 assets 或既有 session ownership。

替代方案“共享 `~/.pi/agent/pi-deck-vision.json`”被否决：它是机器全局状态，会与多用户 server、`PI_CODING_AGENT_DIR` 和 PiDeck schema 产生隔离及兼容问题。

### D6：只给 live runtime 注入扩展，并限制可证明安全的启动回退

vision-bridge 模块公开 `resolveLaunchPolicy(userId)`；Pi live runtime 在启动前调用它并显式追加 `-e`。auth/model/skills probes 不调用该 policy。默认仍保留 `--no-extensions`；`PI_ENABLE_EXTENSIONS=1` 时保持现有“允许发现其他扩展”的语义。

扩展注册唯一的无副作用健康命令 `cloudcli-vision-bridge-health-v1`。live runtime 启动顺序固定为 `start → getState → getCommands/health → bind native session → subscribe → prompt`；只有健康检查成功后才能把新 child 的 native session identity 持久化或发给客户端。该检查只发生在 live child，clean auth/model/skills probes 不加载扩展，因此不会把命令暴露进普通 slash menu。若本次注入 bridge 后 `rpc.start()`、`getState()`、`getCommands()` 明确失败，或健康命令缺失，runtime 在尚未绑定 session、尚未发送 prompt 时去掉 bridge最多重试一次并发出非致命诊断。当前官方 wrapper 不暴露“prompt 尚未被接受”的 acknowledgement，因此 `rpc.prompt()` 超时、connection timeout 或 child close 均不得自动重放；prompt 已发送后、已经开始模型输出、普通上游模型失败或第二次失败均不回退，避免重复执行有副作用的 turn。

### D7：消息身份优先，content hash 只用于缓存

新客户端为 optimistic user message 生成 `clientMessageId` 并随 `chat.send` 发送；server 校验后放入 run request。旧客户端缺失该字段时，server 只生成 run-local correlation，并沿用现有 text/image/file fingerprint fallback，不承诺精确的实时气泡绑定。Runtime 已知 `runId/appSessionId`，并把当前请求图片的 contentHash 多重集合和（如有）clientMessageId 放入受限 child env；扩展把本次 context 中最后一个 user message 视为当前 prompt 的候选，并用 contentHash 多重集合作一致性校验，不使用 hash+timestamp 在历史消息中猜测当前身份；校验不唯一时仍可转换，但不发布可归属的 realtime card。toolResult 自带 `toolCallId`。事件主身份为 session/run/clientMessageId 或 toolCallId/imageIndex；历史项若能在 `ctx.sessionManager.getEntries()` 中唯一匹配则附 `sourceEntryId`，否则只做 LLM 转换并以未绑定的 session-level history item 展示；raw-byte contentHash 只用于内容校验与缓存，绝不以 `hash + timestamp` 猜消息。

### D8：成功观察可在同一 Pi session 复用，失败不持久缓存

cache fingerprint 为：

```text
rawByteHash + mimeType + visionProvider + visionModelId
+ promptFingerprint + maxTokens + sourcePolicy
+ configSchemaVersion
```

扩展先扫描当前 session 的 namespaced success entries，再查本 child/run 内存结果。`maxImagesPerRun` 是整个 CloudCLI/Pi provider run 的新视觉调用预算，多个 `context` 回调共享计数且不会重置；可复用的 session success 不消耗预算。新调用选择顺序固定为：当前 client message 的新图片；当前 run 新产生的 tool results；尚无结果的历史图片。只有 succeeded 描述可复用；timeout、network、rate-limit、cancelled 和 config/model failure 可在后续 run 重试。重复图片位置各自保留独立 item identity；当前工程每轮重建 Pi child，不能把 child-local Map 误称为跨 run 缓存。

### D9：视觉模型目录是脱敏的专用 port，并显式解码完整模型快照

Pi 模块新增只读 adapter，以 clean probe 读取实际可用模型快照，并在 wrapper 的窄 `ModelInfo` 类型之外对原始对象做结构化运行时解码，过滤 `input.includes("image")`；若运行时数据缺少 `input`，该模型不得进入视觉目录。它通过 Pi barrel 暴露给 assembly；vision-bridge router 通过构造参数消费该 port，不 deep-import Pi 内部文件。返回字段只有 provider、model id、display metadata、api kind 摘要和 credentialAvailable，不返回 endpoint、headers 或 secret。`credentialAvailable:true` 只表示模型出现在 Pi available snapshot 中，不暴露凭据来源；已保存选择不在 snapshot 中时为 false。若某个 Pi CLI 版本只返回窄 `ModelInfo`，目录服务返回 `ERR-VB-MODELS-UNAVAILABLE`，不得猜测能力。

### D10：工具图片外发默认关闭，观察内容按不可信数据处理

配置默认 `enabled:false`、`sources.userImages:true`、`sources.toolImages:false`。启用前 UI 展示供应商、模型和外发说明。发送给主模型的描述被包在稳定的“不可信视觉观察”容器中；内部 delimiter 必须转义，图片中的命令不得获得用户授权语义。运行日志只记录身份、状态、耗时、模型和稳定错误码。用户图片的浏览器附件只来自现有 upload store；工具图片是已经由 Pi 读取的另一信任边界。

### D11：取消状态由 runtime/store 负责收口，不让扩展与 coordinator 争夺终态

`ProviderRunCoordinator.abortRun()` 会先把 run 标记为 aborted，再停止后续 sink.emit。因此扩展在 abort 后发出的 `cancelled` status 只能作为 best-effort，不能作为 UI 的唯一来源。现有 `complete(aborted:true)` 是 authoritative 的 run 终态；frontend/store 根据该 run 已收到的 started observation 合成一次幂等的 cancelled `vision_bridge` 状态，并拒绝终态后的迟到 succeeded/failed。由于 Pi 可能不会触发 `turn_end`，取消批次不要求写入 session custom entry；这不会影响 run 终态的可见性。

### D12：由 composition root 注入 launch policy，避免 provider 与配置模块成环

`server/modules/vision-bridge` 不 import Pi provider 的内部文件；Pi live runtime 也不直接读取配置 JSON。Pi 模块只提供一个默认 disabled 的 `VisionBridgeLaunchPolicy` port，`server/index.ts` 在组装 `vision-bridge` service 后注入该 policy。现有 import-time `PiProvider` singleton 通过延迟读取这个 port 工作，未配置时保持 disabled，因此不会形成 `providers → vision-bridge → providers` 的循环。auth/model/skills probe 不调用该 port。

## 模块边界

| 模块 | 职责 | **不负责** | 输入 | 输出 | 依赖 | 状态归属 |
|---|---|---|---|---|---|---|
| `server/shared/image-attachments` | 受信路径校验、读取 upload-store 图片、MIME/大小约束、raw-byte hash、Pi 图片投影 | 不选择模型、不调用视觉模型、不决定 bridge 开关、不开放任意 cwd 文件 | attachment descriptors、upload store root | Pi images、逐项失败 | Node fs/path/crypto | 无持久状态 |
| Pi vision extension | 在 context clone 中转换图片、调用 registry、发实时状态，并在 turn_end 追加 session 派生条目 | 不读取宿主 path、不管理用户配置、不手写 provider HTTP、不修改原始消息、不负责取消后的 runtime 终态 | provider-neutral messages、child env、model registry | transformed messages、结构化状态/custom entry | Pi extension API、纯 `shared/vision-bridge` contract | child-local cache；最终结果归 Pi session |
| Pi live runtime adapter | 通过注入的 launch-policy port 注入可信扩展/env、映射 RPC 状态、一次性 fallback | 不解析配置 JSON、不选择视觉模型、不为 probes 注入 bridge、不直接 import vision-bridge implementation | ProviderRunRequest、launch policy | Pi RPC 生命周期、ProviderRunEvent | PiRpcClient、Pi-owned policy port | run-local lifecycle |
| Pi vision model catalog adapter | 用 clean probe 枚举并过滤 image-capable 模型 | 不保存配置、不返回 secret、不启动视觉桥 | Pi model snapshot | 脱敏模型选项 | PiRpcClient | 无持久状态 |
| `server/modules/vision-bridge` | per-user 配置、校验、原子持久化、launch policy、REST orchestration | 不读取图片、不调用模型、不声明 tenant session ownership、不 import Pi provider 内部实现 | userId、公共 DTO、模型目录 port | public config、模型目录、launch policy | fs/crypto、注入的模型目录 port | per-user config 唯一归属 |
| Pi session projection | 从 active branch 投影原始图片和 namespaced 派生条目 | 不执行视觉转换、不读取全局事件文件 | Pi session entries | normalized user/tool/vision messages | Pi session store | 无额外状态 |
| WebSocket/provider event projection | 校验 namespaced RPC status、添加可信 run/session identity并转发现有 aborted terminal | 不信任 child 提供的 app identity、不持久化 config、不读取全局事件文件、不在 coordinator 终态后补发 provider event | extension_ui_request、当前 run context | vision_bridge ProviderRunEvent、既有 complete terminal | shared contract | run-local |
| Frontend settings | 展示/保存脱敏配置和外发告知 | 不处理 secret、不自行解析 models.json | config/models API | 用户配置请求 | authenticated HTTP | 表单草稿 |
| Frontend chat/store | 用稳定 identity 合并事件、根据 aborted terminal 合成取消状态、恢复卡片、保持原图和用户消息 | 不解析自然语言 marker 为可信状态、不重新下载图片算身份 | realtime events、complete terminal、history projection | message/card state | shared contract | session store |

- [x] 没有模块同时拥有配置、视觉调用和 UI 三个领域。
- [x] 每一行都声明了不负责事项。
- [x] per-user config 只归 vision-bridge；最终观察只归 Pi session。
- [x] 依赖为 assembly → ports/adapters，vision-bridge 不反向 deep-import Pi，未形成循环。

## 规则与约束

| 类型 | 规则 | 覆盖需求 |
|---|---|---|
| 业务规则 | 当前模型原生支持 image 时完全旁路 bridge | 能力优先 |
| 业务规则 | 用户图片在 bridge 开启时默认允许；工具图片必须用户显式开启 | 来源策略、隐私 |
| 业务规则 | 原始用户/工具消息不可被视觉描述覆盖；描述是独立派生数据 | 消息保真、可信卡片 |
| 业务规则 | 超过图片上限的每张图都产生 skipped，不得静默丢失 | 有界图片数量 |
| 业务规则 | 只有完整 fingerprint 相同的成功结果可复用；失败可重试 | 缓存语义 |
| 系统规则 | 配置按 userId 隔离；无 userId 时 bridge disabled；既有 Pi host resources 的 ownership 不在本 change 内扩展 | 配置隔离 |
| 系统规则 | public API、WebSocket 和日志不返回 API key、authorization、图片字节或跨用户完整描述 | 数据最小化 |
| 系统规则 | 实时/历史卡片必须有结构化身份；正文 marker 没有信任意义 | 防伪造、事件关联 |
| 系统规则 | bridge 硬失败只在输出前无桥重试一次 | 故障隔离 |
| 技术约束 | Pi 输入必须是合法 `ImageContent`，不允许 path descriptor cast；浏览器附件只允许现有 upload store 直接子文件 | 安全图片输入 |
| 技术约束 | 扩展只使用 Pi 0.84.4 的 `context` hook，不注册不存在的事件 | 版本兼容 |
| 技术约束 | 视觉调用必须走 model registry/provider runtime，不引入 bridge 专用 `undici`；server、extension、frontend 共用纯 `shared/vision-bridge` schema/parser | Provider 复用、契约一致性 |
| 技术约束 | 默认 `--no-extensions` 不变；显式 `-e` 只作用 live runtime；`PI_ENABLE_EXTENSIONS=1` 继续允许既有扩展发现 | 扩展隔离 |
| 技术约束 | config file 使用 mutex、temp 和 atomic rename；POSIX 为目录 `0700`/文件 `0600`，Windows 不主动放宽应用目录 ACL | 一致性 |

## 错误码注册表

| ERR ID | 常量名 | 错误码 | 提示文案 | 引用位置 |
|---|---|---:|---|---|
| ERR-VB-CONFIG-INVALID | `VISION_BRIDGE_CONFIG_INVALID` | 4001 | 视觉桥配置无效，请检查模型和参数 | 配置 PUT、运行时损坏诊断 |
| ERR-VB-MODEL-NOT-VISION | `VISION_BRIDGE_MODEL_NOT_VISION` | 4002 | 所选模型未声明图片输入能力 | 配置 PUT |
| ERR-VB-MODELS-UNAVAILABLE | `VISION_BRIDGE_MODELS_UNAVAILABLE` | 5031 | 暂时无法读取可用视觉模型，请稍后重试 | 视觉模型目录 GET |
| ERR-VB-CONFIG-WRITE | `VISION_BRIDGE_CONFIG_WRITE_FAILED` | 5002 | 无法保存视觉桥配置，请稍后重试 | 配置 PUT |
| ERR-VB-EXTENSION-START | `VISION_BRIDGE_EXTENSION_START_FAILED` | 5001 | 视觉桥扩展不可用，已回退到基础 Pi 运行 | live runtime 非致命诊断 |

运行时逐图失败不使用 HTTP AppError；它们进入 `VisionBridgeItem.errorCode`：`IMAGE_UNSAFE`、`IMAGE_UNREADABLE`、`IMAGE_UNSUPPORTED`、`IMAGE_TOO_LARGE`、`LIMIT_EXCEEDED`、`VISION_MODEL_UNAVAILABLE`、`VISION_UPSTREAM`、`VISION_TIMEOUT`、`VISION_CANCELLED`。面对用户的详细原因必须脱敏。

## 数据模型

### `VisionBridgeConfigV1`

磁盘使用 `VisionBridgeStoredConfigV1`，字段如下表。`VisionBridgeUpdateInputV1` 只允许同一组用户可编辑字段，不允许 `userId`、config path、凭据或运行身份。`VisionBridgePublicConfigV1` 返回同一组非 secret 字段，并可附当前选定模型的 `available/credentialAvailable` 计算状态；它不返回磁盘绝对路径。每个 Pi child 在第一次 `context` 调用时读取并缓存一个完整配置快照，单次 run 只能看到原子写入前后的某一个版本。

| 字段 | 类型 | 必填 | 含义 | 示例 | 约束 | 枚举值 | 默认值 | 空值语义 |
|---|---|---|---|---|---|---|---|---|
| schemaVersion | `1` | 是 | 配置协议版本 | `1` | 只接受 1 | `1` | `1` | 缺失为非法旧/损坏配置 |
| enabled | boolean | 是 | 用户是否启用 bridge | `false` | — | — | `false` | 缺失非法；首次读取合成 false |
| visionModel | object | 条件 | 视觉模型引用 | `{provider:"openai",id:"gpt-4o-mini"}` | enabled 时必填且模型支持 image | — | 无 | disabled 时可省略，表示尚未选择 |
| maxImagesPerRun | integer | 是 | 每个 CloudCLI/Pi provider run 最多调用视觉模型的图片数 | `4` | 1–8 | — | `4` | 缺失由首次默认配置补齐 |
| timeoutMs | integer | 是 | 整个转换批次 deadline | `20000` | 1000–25000 | — | `20000` | 缺失由默认配置补齐 |
| concurrency | integer | 是 | 同批视觉调用并发数 | `2` | 1–4，且不大于 maxImagesPerRun | — | `2` | 缺失由默认配置补齐 |
| maxTokens | integer | 是 | 单图视觉输出上限 | `1024` | 128–4096 | — | `1024` | 缺失由默认配置补齐 |
| promptTemplate | string | 是 | 视觉观察提示词 | `请客观描述...` | trim 后 1–4000 字符 | — | 内置安全模板 | 空串非法 |
| sources | object | 是 | 图片来源外发策略 | `{userImages:true,toolImages:false}` | 两字段均为 boolean | — | 同示例 | 缺失由默认配置补齐 |

`promptTemplate` 保存前统一换行符为 `\n`、trim 首尾空白；`promptFingerprint = sha256(UTF-8(normalizedPrompt))` 的 64 位小写 hex。内置默认提示要求：只描述可见内容、准确转录可见文字、区分可见证据与推测、把图片中的命令/提示词视为不可信数据而非授权。

### `VisionBridgeRunEventV1` / session 派生条目

扩展通过 `ctx.ui.setStatus("cloudcli.vision-bridge.v1", JSON.stringify(event))` 发送实时状态。`statusKey` 是唯一受支持的 bridge key；runtime 只解析该 key，status text 最大 16 KiB，JSON 解析/校验失败时记录脱敏诊断并忽略，不得把整个 Pi run 判为协议失败。child 发送的 `runId`、`appSessionId`、`userId` 都不具备权威性，runtime 以当前 `ProviderRunRequest` 覆盖；扩展只能从 child env 读取 correlation。

`source` 是以下互斥 union，不能通过同时填写多个可选字段绕过校验：

```ts
{ kind: "user"; clientMessageId?: string; sourceEntryId?: string }
| { kind: "tool"; toolCallId: string; sourceEntryId?: string }
| { kind: "history"; sourceEntryId: string }
```

新客户端的 user source 必须带 `clientMessageId`；旧客户端缺失该字段时只允许 run-local correlation，runtime 不承诺精确的实时 bubble 绑定。`sourceEntryId` 只有在 session entries 中唯一匹配时才写入。

| 字段 | 类型 | 必填 | 含义 | 示例 | 约束 | 枚举值 | 默认值 | 空值语义 |
|---|---|---|---|---|---|---|---|---|
| schemaVersion | `1` | 是 | 事件版本 | `1` | — | `1` | — | 缺失则丢弃并诊断 |
| eventId | string | 是 | 幂等事件 ID | UUID | 每个状态事件唯一 | — | — | 不可为空 |
| batchId | string | 是 | 一次 context 图片批次 | UUID | 同批 started/终态一致 | — | — | 不可为空 |
| observationId | string | 是 | 一个图片位置的逻辑观察身份 | UUID | 同一图片位置的所有 phase 一致 | — | — | 不可为空 |
| phase | string | 是 | item 状态 | `succeeded` | 合法状态机 | `started/succeeded/failed/skipped/cancelled` | — | 不可为空 |
| source | object | 是 | 图片来源及消息锚点 | `{kind:"user",clientMessageId:"msg_1"}` | 互斥 union；user 必须有 clientMessageId（旧客户端可为空并降级为 run-local），tool 必须有 toolCallId，history 必须有 sourceEntryId | `user/tool/history` | — | 不可为空 |
| runId | string | 是 | CloudCLI run 关联 | `run_...` | server 以当前 run 覆盖 child 值 | — | — | 不可为空 |
| appSessionId | string | 是 | CloudCLI session 关联 | `session_...` | server 以当前 run 覆盖 child 值 | — | — | 不可为空 |
| nativeSessionId | string | 否 | Pi session 关联 | UUID | 来自 Pi context | — | — | 新 session 尚未可取时允许空 |
| imageIndex | integer | 是 | 原消息中的图片序号 | `1` | ≥1 | — | — | 不可为空 |
| contentHash | 64-char hex | 是 | raw-byte SHA-256 | `abc...` | 仅缓存/校验 | — | — | 不可为空 |
| model | object | 否 | 实际视觉模型 | `{provider,id}` | started 后可用 | — | — | 配置/模型失败时可空 |
| description | string | 否 | 成功观察 | `截图显示...` | 实时事件可截断，session entry 保存完整受限输出 | — | — | 非 succeeded 为空 |
| errorCode | string | 否 | 稳定逐图错误码 | `VISION_TIMEOUT` | 失败/跳过/取消必填 | 上述枚举 | — | succeeded 为空 |
| errorMessage | string | 否 | 脱敏说明 | `视觉请求超时` | 最长 500 字符 | — | — | 无说明时为空 |
| durationMs | integer | 否 | 处理耗时 | `420` | ≥0 | — | — | started 时为空 |
| cached | boolean | 是 | 是否复用成功观察 | `false` | — | — | `false` | 缺失按 false |

**状态流转：** 每个 `observationId` 必须且只能从 `started` 进入一个终态 `succeeded | failed | skipped | cancelled`；在调用前已知的超限/策略拒绝项可直接生成 `skipped`。终态幂等，任何终态之后的状态均被拒绝。`started`/终态 status 通过 RPC 是实时 best-effort；客户端 store 依据 authoritative `complete(aborted:true)` 合成的 `cancelled` 获胜。`turn_end` 只保存已完成的终态，取消批次可没有 custom entry。Custom session entry 只保存终态。`source` 是互斥 union：`user` 携带 `clientMessageId`，`tool` 携带 `toolCallId`，`history` 携带唯一 `sourceEntryId`；当前 user entry 在 session 尚未能唯一锚定时，实时事件仍可用 `clientMessageId`，历史投影不得通过最近消息猜测。

Pi session 每个完成的 Pi turn 最多追加一个 `customType: "cloudcli.vision-bridge.v1"` 的 `VisionBridgeBatchEntryV1`。其 `data` 为 `{ schemaVersion, batchId, runId, appSessionId, nativeSessionId, items }`，`items` 只含本批终态，不含 `started`；每项沿用上述 `observationId/source/imageIndex/contentHash/model/description/error/duration/cached` 字段。未知 schemaVersion 的 custom entry 被 history adapter 忽略并记录诊断，不能使整个 Pi session 损坏。

### 相关既有模型扩展

- `ChatAttachmentDescriptor.contentHash?: string`：上传时计算的 raw-byte SHA-256；旧附件为空时 Pi adapter 重新计算。
- `ProviderRunRequest.clientMessageId?: string`：当前 optimistic user message 身份；server 校验或生成，不允许客户端控制 run/provider session identity。
- `NormalizedMessage.kind = "vision_bridge"`：承载可信结构化卡片；不复用普通 `text` marker。
- Pi user message 中的 `ImageContent` 在 history adapter 中映射为现有 `ChatImage.data` data URL（并附 `contentHash`/`mimeType`），沿用当前前端 `ChatMessageImages` 的懒加载/回收行为；单次历史响应仍受 32 MiB 图片总字节上限约束，超限时只返回安全的图片不可用占位。

## 非功能要求

| 维度 | 要求 |
|---|---|
| 图片大小 | 视觉桥单图原始字节最多 10 MiB；在读取完整内容前先 stat/验证，超限跳过 |
| 总图片字节 | 单次 Pi run 读取的用户附件原始字节最多 32 MiB；超限图片逐项 skipped，不把额外路径交给 Pi |
| 图片格式 | 只把实际字节可确认为 JPEG、PNG、GIF 或 WebP 的文件投影为 Pi image；SVG、BMP 和其他格式保留为普通文件/失败附件，不送视觉模型 |
| 图片数量 | 默认每个 CloudCLI/Pi provider run 4 张，可配置 1–8；超限逐图 skipped |
| 延迟 / 吞吐 | 整批默认 deadline 20 秒、最大 25 秒；deadline 到达后不再等待未完成调用 |
| 并发 | 默认 2，范围 1–4；同时受图片上限约束 |
| 输出 | 单图默认 1024 tokens，范围 128–4096；实时 event 序列化后最多 16 KiB，完整受限描述在 session entry |
| 重试策略 | bridge 层不做协议/HTTP 重试；失败可由用户或后续 context 重新运行；child 硬启动只无桥重试一次 |
| 取消 | 所有视觉调用共享当前 run abort 和批次 deadline；前端 store 收到 `complete(aborted:true)` 后同步合成取消终态并拒绝迟到成功；扩展自身 cancelled status 仅 best-effort |
| 一致性 | config 写使用单用户 mutex + atomic rename；事件以 eventId 幂等；终态只写一次 |
| 缓存 | 只缓存 succeeded；session cache fingerprint 包含内容、MIME、模型、prompt 和 schema/config version |
| 可观测性 | 日志不含图片字节、完整描述、API key/header/secret URL；记录 run/session、模型、状态、耗时、稳定错误码 |
| 隔离 | 配置与 REST 按用户隔离；runtime event 必须按 app session/run 过滤；相同 hash 不允许跨 session 匹配 |
| 发布 | source `.ts` 和 compiled `.js` path 均测试；production server bundle 必须真实加载扩展并执行受控转换 |

## 风险与权衡

- **[ModelRegistry.complete 的扩展内调用行为随 Pi 版本变化]** -> 固定 0.84.4 contract test；`PI_RPC_CLI_ENTRY` 覆盖到不兼容版本时禁用 bridge 并报告诊断，不回退手写 HTTP。
- **[context 会在同一 run 多次执行]** -> 以完整 fingerprint 查 run/session success cache，eventId/batchId 做幂等；失败仍允许后续 run 重试。
- **[session custom entry 增加 session 文件大小]** -> 不复制图片字节，只保存受 maxTokens 限制的描述和必要 metadata；随 session 删除/保留策略处理。
- **[使用 setStatus 承载 JSON 是 namespaced 协议复用]** -> key 固定为 `cloudcli.vision-bridge.v1`，server 严格 schema 校验且覆盖 app identity；其他扩展 status 不受影响。
- **[一次性无桥 fallback 可能重复 preflight]** -> 只允许在任何模型输出和工具执行之前、且本次确实注入 bridge 的硬失败；最多一次。
- **[工具图片包含敏感项目数据]** -> 默认关闭，UI 明示外发；启用后仍受用户/session 权限和最小日志策略约束。
- **[机器级 Pi credentials、assets 和 sessions 仍由宿主级信任边界管理]** -> 本 change 只隔离 bridge 配置并不新增绕权 API；若部署需要 tenant-owned provider credentials/session ownership，应由独立认证能力变更解决。
- **[原始 Pi 图片进入 session 会增大历史响应]** -> history adapter 沿用现有 data URL 能力并受图片上传/视觉大小限制；前端懒加载缩略图，不把 base64写入视觉事件。

## 迁移计划

| 项 | 内容 |
|---|---|
| 上线步骤 | 1) 兼容性 contract gate（含完整模型快照、context 时序、completion recursion、status/appendEntry 和 safe fallback）；2) 图片 adapter；3) per-user config/model catalog；4) context + turn_end extension；5) live-only runtime/event/session；6) UI；7) production E2E。默认 disabled，上线不会自动外发图片。 |
| 回滚策略 | 停止 live runtime 注入 `-e` 并隐藏设置入口即可恢复基础 Pi；图片 adapter 可保留，因为它同时修复原生 Pi 图片输入。 |
| 回滚后数据处理 | per-user config 保留但不读取；Pi session 中 namespaced custom entry 由旧代码忽略，原始消息不受影响。无全局 JSONL 需要清理。旧的 PiDeck `~/.pi/agent/pi-deck-vision.json` 和旧事件文件不自动导入、不自动删除；如未来提供导入，必须由当前用户显式触发并重新校验非 secret 字段。 |
