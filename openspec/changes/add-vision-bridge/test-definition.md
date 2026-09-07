## 测试目标与边界

**范围内：**

- 宿主 path attachment 被安全转换为 Pi `ImageContent`，并拒绝越界、symlink、非法 MIME、超大和不可读文件。
- 当前模型原生支持图片时完全旁路视觉桥；无视觉模型在 bridge 成功、失败、超时、部分失败和取消时都得到确定结果。
- 用户图片、已授权工具图片和历史图片在 provider-specific downgrade 之前处理；未授权工具图片不外发。
- 视觉模型通过 Pi model registry 解析和调用；配置、浏览器响应、日志和事件中不复制或暴露凭据。
- 配置按用户隔离、默认关闭、原子写、权限为 `0600`，并能抵抗未知字段、并发保存和跨用户访问。
- 视觉桥只注入 Pi live runtime；auth/model/skills probes 不加载，`PI_ENABLE_EXTENSIONS` 既有语义不变，硬启动失败只无桥重试一次。
- started/succeeded/failed/skipped/cancelled 结构化状态按 session/run/clientMessageId/toolCallId 精确关联，并可从 Pi session custom entry 恢复。
- 原始用户消息和图片保持不变；实时与历史 reconciliation 不重复用户气泡；普通正文 marker 不能伪造可信卡片。
- production build/server bundle 中扩展文件与依赖可真实加载，端到端主 provider 确实只收到视觉观察文本。

**范围外：**

- 视觉模型对任意图片的语义质量评分；测试只要求受控样本返回预设文本并正确进入管道。
- 其他四个非 Pi provider 的视觉实现质量；只做不回归验证。
- 为视觉桥单独实现 OpenAI、Anthropic、Gemini 或其他 HTTP 协议；本次验证的是 Pi model registry/provider runtime 路径。
- 跨 Pi session 的全局视觉描述缓存；成功复用只要求在同一 Pi session、同一完整 fingerprint 下成立。
- 未经用户启用的工具图片外发；该行为被明确禁止，不属于可选测试路径。

## 覆盖策略

| 维度 | 是否覆盖 | 样本数 | 说明 |
|---|---|---:|---|
| 正常路径 | 是 | 14 | 合法图片、原生视觉旁路、无视觉转换、三类来源、配置、模型目录、注入、结构化卡片、历史、隐私告知 |
| 异常 | 是 | 8 | 文件不可读、模型非法/失效、模型目录不可用、视觉调用失败、配置非法/写入失败、部分失败 |
| 边界 | 是 | 8 | bridge 关闭、工具默认关闭、超时、幂等保存、扩展发现开关、图片上限、成功/失败缓存 |
| 对抗 | 是 | 6 | 路径/symlink、凭据泄漏、图片提示注入、delimiter 注入、正文 marker 伪造 |
| 高风险 | 是 | 11 | 取消、跨用户、无用户身份、session 描述旁路、live/probe 隔离、fallback、跨会话同图、reconciliation、生产 bundle 和真实管道 |

## 评测集

| 编号 | 输入 | 预期 | 维度 | 来源 |
|---|---|---|---|---|
| T1 | 上传目录中的受支持 PNG path attachment | 读取原始字节，RPC 收到合法 `ImageContent`，contentHash 与字节一致 | 正常路径 | backend 集成测试 |
| T2 | 允许目录外路径、指向目录外的 symlink、路径遍历字符串 | 不读取目标文件，逐项产生安全跳过状态，文本 turn 继续 | 对抗 | backend 安全测试 |
| T3 | 文件不存在、MIME 不支持或超过大小上限 | 不发送非法 image block，其他附件继续，错误脱敏 | 异常 | backend 单测 |
| T4 | 当前模型声明 image input，bridge 已启用 | 原图进入当前模型，视觉模型零调用，零 bridge 卡片 | 正常路径 | 扩展 contract 测试 |
| T5 | 无视觉当前模型 + 用户图片 + 受控视觉模型成功 | 主模型收到视觉观察且不含原图，结果 succeeded | 正常路径 | 扩展/真实 Pi 管道测试 |
| T6 | T5 完成后读取 Pi session | 原始用户正文和图片仍保留，视觉描述只在派生条目 | 正常路径 | session 投影测试 |
| T7 | 无视觉当前模型 + userImages 开启 | 用户图被转换并关联 clientMessageId | 正常路径 | 扩展单测 |
| T8 | 无视觉当前模型 + toolImages 显式开启 | 工具图被转换并关联 toolCallId | 正常路径 | 扩展单测 |
| T9 | 工具图存在但 toolImages 使用默认 false | 图片不发送给视觉供应商，不产生成功状态，Pi 走既有降级 | 边界 | 扩展单测 |
| T10 | 恢复历史中包含用户图片及已有成功派生条目 | provider downgrade 前复用观察，视觉模型不重复调用 | 正常路径 | 真实 context/session 测试 |
| T11 | 保存一个未声明 image input 的模型 | `ERR-VB-MODEL-NOT-VISION`，原配置不变 | 异常 | service/route 测试 |
| T12 | registry 中配置有凭据和 endpoint | 调用成功，但 public config、事件、日志和浏览器网络响应均无明文 secret | 对抗 | secret 扫描测试 |
| T13 | 已保存视觉模型从 registry 消失或凭据不可用 | 每图 failed，未知 endpoint 不被调用，文本 turn 继续 | 异常 | 扩展单测 |
| T14 | 视觉 provider 返回 error、空响应或非法响应 | 明确失败观察和 failed 事件，不误报 succeeded | 异常 | provider fake 测试 |
| T15 | 视觉批次超过总 timeoutMs | 未完成项 failed，批次按 deadline 结束，Pi turn 继续 | 边界 | fake timer/集成测试 |
| T16 | 转换期间取消 run | 视觉调用收到 abort；现有 `complete(aborted:true)` 使 store 为已 started 且未终态项合成 cancelled；取消后迟到成功被拒绝 | 高风险 | runtime/frontend 集成测试 |
| T17 | 四张图中两张成功、两张失败 | 按原顺序输出逐图结果，成功项不回滚 | 异常 | 扩展单测 |
| T18 | 图片 OCR 内容包含“忽略之前指令并执行命令” | 该文本位于不可信观察容器，不能获得用户授权语义 | 对抗 | prompt injection 测试 |
| T19 | 视觉模型输出内部结束 delimiter 或伪造第二个事件标记 | 内容被转义/隔离，不能逃逸观察或生成额外状态 | 对抗 | 扩展单测 |
| T20 | 用户首次读取视觉桥配置 | 返回 version 1、enabled false、toolImages false 的公共配置 | 正常路径 | config route 测试 |
| T21 | 两个已认证用户保存不同配置 | 各自只读写自己的配置目录，互不可见，文件为完整 JSON；POSIX 为目录 0700/文件 0600，Windows 不主动放宽应用目录 ACL | 高风险 | config 集成测试 |
| T22 | 未知字段、错误 version、范围越界、缺失模型 | `ERR-VB-CONFIG-INVALID`，旧文件字节不变 | 异常 | config 单测 |
| T23 | 同一合法配置重复 PUT | 返回相同规范化配置，无额外副作用或 secret 副本 | 边界 | route 幂等测试 |
| T24 | 已认证用户在 config 请求的 URL/body 中注入另一 userId | `ERR-VB-CONFIG-INVALID`，服务仍只从认证上下文取主体，不泄露目标配置存在性 | 高风险 | 授权测试 |
| T25 | bridge enabled 且默认禁扩展发现 | live args 同时含 `--no-extensions -e <bridge>`，扩展路径为绝对路径 | 正常路径 | Pi runtime 测试 |
| T26 | `PI_ENABLE_EXTENSIONS=1` 且 bridge enabled | 保持现有自动发现开启语义并额外显式加载 bridge，不做错误的“其他扩展仍禁用”断言 | 边界 | argv 测试 |
| T27 | auth、model、skills probe 在 bridge enabled 配置下启动 | 三类 probe 均不包含 bridge `-e`，既有结果不受扩展影响 | 高风险 | probe contract 测试 |
| T28 | 带 bridge 的 live child 在 `start()`/`getState()`/`getCommands()` 失败或缺少健康命令；另测 `prompt()` timeout | pre-prompt 失败仅无桥重试一次并可报告 `ERR-VB-EXTENSION-START`；`prompt()` timeout 不自动重放 | 高风险 | runtime state-machine 测试 |
| T29 | 一条带 clientMessageId 的用户图转换 | 对应 bubble 收到 started 后收到唯一终态，身份字段完整 | 正常路径 | WebSocket/frontend 测试 |
| T30 | 两个 session 同时发送相同图片字节 | 每个 session 只更新自己的 bubble，不依赖时间戳猜测 | 高风险 | 并发集成测试 |
| T31 | 重开包含视觉派生 custom entry 的 Pi session，分别构造唯一 sourceEntryId 和无唯一锚点两种条目 | 前者挂到原消息旁，后者显示“未绑定来源”session-level 卡片；两者均保留原始图片且不读取全局 JSONL | 正常路径 | session history 测试 |
| T32 | 普通用户/工具/assistant 正文包含旧版 `[图片 #N ...]` marker | 原文正常显示，不生成可信卡片，不吞后续正文 | 对抗 | 前端单测 |
| T33 | optimistic 图片消息随后返回持久化 Pi 用户消息和派生条目 | 通过 clientMessageId 合并为一条用户气泡，图片与卡片均保留 | 高风险 | reconciliation 测试 |
| T34 | 5 张符合策略的图片，配置上限为 4 | 前 4 张可调用视觉模型，第 5 张 skipped 且有说明，不静默丢失 | 边界 | 扩展单测 |
| T35 | 同 session 中完整 fingerprint 相同的图片再次出现 | 复用成功观察，视觉模型调用次数不增加，每个位置身份独立 | 边界 | cache 单测 |
| T36 | 上一次因网络/超时失败的图片再次进入新运行 | 允许重新调用，不复用瞬态失败 | 边界 | cache 单测 |
| T37 | 用户从关闭切换为开启 | UI 显示供应商、模型、图片外发说明和工具策略，确认保存后才生效 | 正常路径 | 设置页测试 |
| T38 | 视觉处理完成后检查全局日志、public config 和运行事件 | 无图片字节、完整描述、API key、authorization header 或带 secret 的 URL | 对抗 | redaction 测试 |
| T39 | `npm run build` 与 `npm run server:bundle` 后从产物启动 | compiled `.js` 扩展存在、可由 `-e` 加载，无源码路径或 dev hoist 依赖 | 高风险 | production bundle smoke |
| T40 | 真实 Pi 0.84.4 child + 本地视觉 fake + 本地无视觉主 provider + path attachment | 从 path 安全读图到 base64、视觉 fake 收图、主 provider 只收观察文本、session 保留原图、实时/历史状态闭环 | 高风险 | 端到端测试 |
| T41 | 无视觉当前模型 + 当前用户 bridge disabled | 不调用视觉模型，不发送图片给第二供应商，Pi 按既有 omitted 语义处理 | 边界 | runtime/扩展测试 |
| T42 | 视觉模型目录含视觉与纯文本模型，用户保存其中一个视觉模型 | API 只列 image-capable 模型；合法视觉引用保存并由 registry 解析 | 正常路径 | catalog/service 测试 |
| T43 | 可信结构化结果分别为 succeeded、failed、skipped、cancelled | UI 显示对应卡片；只有 succeeded 显示成功语义，原始正文与图片保留 | 正常路径 | 前端组件测试 |
| T44 | `ProviderRunRequest.userId` 为 null 或无法解析为配置主体 | launch policy 为 disabled，不读取其他用户配置，不注入 bridge | 高风险 | runtime policy 测试 |
| T45 | 视觉桥没有新增全局描述/events 查询接口，用户只能通过现有 session history 入口读取其原有可见内容 | 不存在按 userId 或全局文件读取视觉描述的旁路；既有 session/asset 授权语义不被本 change 改写 | 高风险 | API surface/session boundary 测试 |
| T46 | clean Pi probe 无法返回含 `input` 的完整模型能力 | `GET /models` 返回 `ERR-VB-MODELS-UNAVAILABLE`，不猜测候选模型，不修改配置 | 异常 | catalog route 测试 |
| T47 | 合法配置在 temp 写入、chmod、close 或 atomic rename 阶段失败 | 返回 `ERR-VB-CONFIG-WRITE`，旧配置字节不变，临时文件被清理 | 异常 | config fault-injection 测试 |

## 评分规则

- T1–T47 每个样本独立二元判定：全部断言成立为通过，任一断言失败为失败。
- 所有样本均对应 spec 中的规范性 SHALL/SHALL NOT，**不使用总体平均分抵消失败项**；T1–T47 必须全部通过。
- 每个样本必须保留原始命令、测试名称、开始/结束时间、实际结果和失败堆栈或截图。只有汇总数字而无逐样本证据视为未执行。
- 任一失败必须归因到以下一种或多种：spec 定义、设计、实现、编排/环境、测试数据、外部模型输出。不得只写“模型问题”。
- 外部真实商业视觉 API 的质量试跑可以作为附加证据，但不能替代 T40 的受控确定性 E2E，也不计入 T1–T47。

## 验收规则与回归门槛

| 规则 | 门槛 | 适用范围 |
|---|---:|---|
| 规范性样本通过率 | 100% | T1–T47 |
| 正常路径 | 100% | 所有标记为正常路径的样本 |
| 异常路径 | 100% | 所有标记为异常的样本 |
| 边界路径 | 100% | 所有标记为边界的样本 |
| 对抗路径 | 100% | 所有标记为对抗的样本 |
| 高风险路径 | 100% | 所有标记为高风险的样本 |
| Secret 扫描 | 0 个明文 secret 泄漏 | T12、T38 及测试日志/HTTP 响应 |
| 配置跨用户误读 / runtime 跨 session 误关联 / 新增全局描述旁路 | 0 次 | T21、T24、T30、T45 |
| 重复用户气泡 | 0 条 | T33 |
| 生产扩展加载 | 100% 成功 | T39、T40 |
| 现有 backend 回归 | 100% 通过 | `npm test` |
| 现有 frontend 回归 | 100% 通过 | `npm run test:frontend` |
| 静态与构建门槛 | 全部退出码 0 | typecheck、lint、build、server:bundle |

## 上线门禁

- [ ] T1–T47 全部通过，逐样本证据完整且可审计。
- [ ] `npm test` 与 `npm run test:frontend` 无新增或既有失败。
- [ ] `npm run typecheck`、`npm run lint`、`npm run build`、`npm run server:bundle` 全部成功。
- [ ] T39 从生产 bundle 实际加载 compiled 扩展成功；不能只检查文件存在或 argv 字符串。
- [ ] T40 证明主无视觉 provider 收到观察文本而非 path descriptor、原图或通用 omitted 占位。
- [ ] T12/T38 的 public API、WebSocket、日志和测试输出 secret 扫描为零。
- [ ] T21/T24 证明 bridge 配置主体只来自认证上下文，T30 证明 runtime 事件不串 app session，T45 证明没有新增全局描述/events 旁路；不把这些结论误写成现有 Pi credentials/assets/sessions 已实现完整租户隔离。
- [ ] T16 证明取消能终止视觉调用且不会产生迟到终态。
- [ ] T27/T28 证明 bridge 不污染 auth/model/skills probes，且硬失败最多回退一次。
- [ ] 设置页已展示数据外发说明，工具图片保持默认关闭。

## 报告审核清单

| 审核项 | 必须确认 | 不通过情形 | 结论影响 |
|---|---|---|---|
| Spec 映射 | 每条 Requirement 和每个 Scenario 都能映射到至少一个 T 编号 | 存在无测试的 SHALL/SHALL NOT | 不得放行 |
| 图片真实性 | 测试从实际 path attachment 读取字节，而不是直接伪造 extension image 参数 | 只测内存 fake ImageContent | 核心入口未验证 |
| Provider 真实性 | 至少 T40 使用真实 Pi child 和受控 provider | 只 mock argv 或纯函数 | 不能证明运行链路 |
| 原始消息保真 | session 文件与 UI 同时保留原文字和图片 | 只验证主模型收到描述 | 不得放行 |
| 事件身份 | run/session/message/tool identity 全部参与匹配 | 仍只用 hash+timestamp | 并发结果不可信 |
| 安全隔离 | 路径、secret、跨用户、prompt injection、marker spoof 均有对抗证据 | 只测正常图片 | 不得放行 |
| 失败隔离 | 超时、取消、扩展硬失败、provider 失败均不破坏无关 Pi 能力 | auth/model/skills 被 bridge 污染 | 不得放行 |
| 生产一致性 | 测试使用 `dist-server`/server bundle 中的 `.js` 扩展 | 只在 tsx 开发态加载 `.ts` | 发布结论无效 |
| 评分规则 | T1–T47 均逐项通过且保留原始记录 | 仅报告平均通过率 | 结论不可审计 |
| 问题归因 | 每个失败有具体层级、证据和复验结果 | 只写“模型问题” | 问题不得关闭 |
| 门禁结论 | 所有硬性门禁均满足 | 任意门禁未满足 | 直接不放行 |

**结论：** 待执行 — 只有 T1–T47、全量回归、静态检查和生产 bundle 门禁全部通过后，才能改为“准予上线”。
