## Why

Pi 可以运行 DeepSeek 等不支持图片输入的模型，但 Pi 会在 provider 序列化前把合法图片降级成 `(image omitted: model does not support images)`，模型因此失去全部视觉信息。当前工程还把服务器磁盘上的图片路径描述符直接传给 Pi RPC，而 RPC 实际要求 base64 `ImageContent`；在增加视觉桥之前，必须先建立正确且安全的图片输入边界。

## What Changes

- 为 Pi provider 新增安全图片适配：将经过上传目录校验的图片路径转换为 Pi 所需的 `{ type: "image", data, mimeType }`，同时保留 realpath、符号链接、MIME 和大小限制。
- 新增 CloudCLI 内置视觉桥扩展，只显式加载到 Pi 的 live runtime：
  - 使用 Pi 0.84.4 已支持的 provider-neutral `context` hook 作为唯一正确性拦截点，统一覆盖用户图片、工具结果图片和历史图片。
  - 当前模型原生支持图片时完全放行；当前模型不支持图片时，调用用户选定的视觉模型生成文字观察，并只改写本次发送给 LLM 的上下文，不重写原始用户消息或工具结果。
  - 优先通过 `ctx.modelRegistry.find()` 与 `ctx.modelRegistry.complete()` 复用 Pi 的模型、凭据、endpoint、headers 和 provider adapter，不在扩展内手写 OpenAI/Anthropic/Gemini HTTP 协议。
  - 转换失败或超时时按图片生成明确的非致命失败观察；运行取消时由现有 aborted run 终态驱动前端 store 合成 cancelled 状态，辅助能力失败不得使基础 Pi 文本会话、认证、模型目录或技能目录不可用。
- 新增版本化、按 CloudCLI 用户隔离的视觉桥配置（仅配置和运行策略隔离；现有 Pi host credentials、全局 assets 和 session ownership 不在本 change 内重新建模）：
  - 配置只保存视觉模型引用和运行参数，不复制 `models.json`/registry 中的 API key 或 baseUrl。
  - Server 将当前用户配置的绝对路径和消息关联信息显式传给 Pi live child；无用户身份的运行默认不启用视觉桥，且不新增绕过现有 session/asset 授权的读取路径。
  - 配置采用白名单校验、并发串行、`0600` 权限和同目录临时文件原子替换。
- 新增结构化的视觉桥运行状态与持久化结果：
  - 实时状态通过现有 Pi RPC `extension_ui_request` → ProviderRunEvent → WebSocket 链路传递，不使用全局 JSONL 轮询。
  - 最终结果写入 Pi session 的 namespaced custom entry，以 `runId`、`appSessionId`、`clientMessageId`、`toolCallId`、可用的 `sourceEntryId` 和图片内容哈希关联。
  - UI 只信任结构化事件或 session metadata；正文中形似视觉桥标记的普通文本不得伪造“视觉桥已查看”状态。
- 新增视觉模型目录与设置 UI：
  - 只列出声明支持 image input 的 Pi 模型；
  - 默认关闭视觉桥，用户图片转换可开启，工具结果图片外发默认关闭；
  - 明确提示图片会发送到所选第三方视觉模型；
  - 不向浏览器返回任何明文凭据。
- 新增会话投影和前端卡片：
  - 原始用户文字和图片继续作为会话事实源；
  - 视觉观察作为独立派生卡片展示；
  - 使用稳定消息/运行身份做实时与历史 reconciliation，不再以图片 hash 和时间戳猜测消息归属。
- 新增启动隔离：视觉桥只影响 live runtime；child `start()` 或 `getState()` 明确失败时最多无桥重试一次并报告非致命诊断，不把 bridge 注入 auth/model/skills probes；官方 `prompt()` 超时不自动重放。

## Capabilities

### New Capabilities

- `vision-bridge`: 为 Pi 的无视觉模型提供安全、可取消、可观测的图片转文字能力，并按 CloudCLI 用户隔离本能力新增的配置和运行策略；覆盖图片输入适配、live runtime 扩展注入、provider-neutral 上下文转换、配置管理、结构化状态、会话持久化和前端展示。

### Modified Capabilities

<!-- 当前 openspec/specs/ 中没有既有能力；本次只新增 vision-bridge。 -->

## Impact

- Backend：
  - `server/shared/image-attachments.ts`：安全读取图片并投影为 Pi `ImageContent`。
  - `server/modules/providers/list/pi/`：live runtime 扩展注入、扩展路径解析、结构化事件映射、Pi session custom entry 投影和视觉模型目录 adapter。
  - `server/modules/vision-bridge/`：按用户配置、模型目录接口与薄路由；通过构造参数消费 Pi adapter，不 deep-import 其他模块内部文件。
  - `server/index.ts`：装配并挂载受认证保护的视觉桥路由。
- Shared contract：
  - 根目录 `shared/` 中新增前后端共用的公开配置、模型目录和运行事件 DTO；
  - backend-only 类型仍遵循 `server/shared/` 约定。
- Frontend：
  - 设置页新增视觉桥 Tab；
  - chat store/runtime 处理结构化视觉桥事件；
  - Pi 会话渲染新增成功、失败、跳过、取消状态卡片；
  - optimistic user message 使用稳定 `clientMessageId` 与持久化结果对齐。
- 持久化：
  - Server-owned per-user 配置存放在 `~/.cloudcli/vision-bridge/users/<user-key>/config.json`；
  - 转换结果随 Pi session custom entry 生命周期保存；不新增全局描述事件文件。
- 依赖：
  - 不新增 `undici` 或直接 `@earendil-works/pi-ai` 运行时依赖；
  - 视觉模型调用复用当前锁定的 `@earendil-works/pi-coding-agent@0.84.4` model registry/provider runtime。
- 外部副作用：
  - 只有用户显式启用后，符合来源策略的图片才会发送到选定视觉供应商；
  - 工具图片默认不外发；已有 Pi host-level credentials、assets 和 session 的访问边界保持不变，本 change 不宣称新增完整租户隔离；
  - 其他四个非 Pi provider 的图片行为保持不变。
