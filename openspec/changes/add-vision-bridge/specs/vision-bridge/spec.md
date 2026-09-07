<!-- 本文件中的结构标记由解析器按字面匹配，必须保持英文原样：
     `## Purpose`、`## ADDED|MODIFIED|REMOVED|RENAMED Requirements`、
     `### Requirement:`、`#### Scenario:`、`- **WHEN**`、`- **THEN**`、`- **AND**`，
     以及需求正文里的 SHALL / MUST / SHALL NOT 关键字。
     除这些标记之外的一切内容都用中文书写。 -->

## Purpose

为 Pi 中不支持图片输入的模型提供安全、可取消、可观测的图片转文字能力，同时修复宿主图片路径与 Pi 图片载荷之间的格式缺口。该能力必须保留原始用户消息和图片，以结构化派生结果展示视觉观察；它必须隔离本能力新增的配置和运行策略，不得新增绕过既有 host/session/asset 访问边界的通道，也不得破坏基础 Pi 能力。

## ADDED Requirements

### Requirement: 安全图片输入
The system SHALL 在将宿主上传图片交给 Pi 前，把受信任的图片附件转换为包含图片字节、媒体类型和图片类型标识的有效图片载荷；浏览器提交的附件只允许来自现有全局上传 store 的直接子文件。

The system SHALL NOT 读取上传 store 之外的文件，也不得把任意项目 cwd 作为浏览器附件的隐含允许目录；符号链接解析后的真实路径同样必须满足允许目录约束。

#### Scenario: 合法图片转换
- **WHEN** 用户向 Pi 会话发送一张位于受信上传 store、媒体类型受支持且未超过大小上限的图片
- **THEN** 系统读取图片字节并把它作为有效图片载荷交给 Pi
- **AND** 图片内容哈希基于原始字节计算，并随宿主附件元数据保留

#### Scenario: 越界或符号链接图片
- **WHEN** 图片路径位于允许目录之外，或符号链接解析后的真实路径越出允许目录
- **THEN** 系统拒绝读取该文件，并生成结构化的图片跳过状态
- **AND** 文本消息继续执行，不泄露目标文件内容

#### Scenario: 图片不可读或格式不支持
- **WHEN** 图片不存在、读取失败、媒体类型不受支持或超过大小上限
- **THEN** 系统不把非法图片载荷发送给 Pi，并为该图片生成明确的失败或跳过说明
- **AND** 其余合法图片和文本消息继续处理

### Requirement: 能力优先的视觉转换
The system SHALL 以当前 Pi 模型声明的输入能力作为视觉桥门控；当前模型支持图片时原图直接传递，当前模型不支持图片且视觉桥启用时，图片在进入当前模型前转换为文字观察。

The system SHALL NOT 对原生支持图片的当前模型调用视觉桥，也不得把视觉模型生成的观察写成用户原始输入的一部分。

#### Scenario: 当前模型原生支持图片
- **WHEN** 当前 Pi 模型声明支持 image input
- **THEN** 系统把原始图片载荷交给当前模型
- **AND** 不调用配置的视觉模型，不生成视觉桥成功或失败卡片

#### Scenario: 无视觉模型转换成功
- **WHEN** 当前 Pi 模型不支持 image input、当前用户已启用视觉桥且视觉模型成功返回描述
- **THEN** 当前模型收到按图片顺序组织的文字观察，不收到原始图片载荷
- **AND** 原始用户消息和图片仍作为会话事实源保留，视觉观察作为独立派生结果记录

#### Scenario: 视觉桥关闭
- **WHEN** 当前用户未启用视觉桥
- **THEN** 系统不调用任何额外视觉模型，也不把图片发送给第二个供应商
- **AND** Pi 按自身对当前模型图片能力的既有语义继续处理该会话

### Requirement: 用户、工具和历史图片覆盖
The system SHALL 在同一个 provider-neutral 消息阶段识别用户消息、工具结果和历史上下文中的图片，并依据图片来源策略决定是否转换；正确性转换必须发生在 provider-specific 图片降级之前。

The system SHALL NOT 在工具图片外发未启用时把工具读取或工具生成的图片发送给视觉供应商。

#### Scenario: 用户消息图片
- **WHEN** 无视觉当前模型的上下文包含用户上传图片，且用户图片转换已启用
- **THEN** 系统转换该图片并把对应文字观察提供给当前模型

#### Scenario: 工具结果图片已授权
- **WHEN** 无视觉当前模型的上下文包含工具结果图片，且当前用户已显式启用工具图片转换
- **THEN** 系统转换该图片，并以工具调用身份关联转换状态和结果

#### Scenario: 工具结果图片未授权
- **WHEN** 上下文包含工具结果图片，但工具图片转换保持默认关闭
- **THEN** 系统不向视觉供应商发送该图片，不生成伪成功状态
- **AND** Pi 按自身既有无视觉图片降级语义继续处理该图片

#### Scenario: 历史图片兜底
- **WHEN** 恢复的 Pi 会话历史仍包含符合来源策略的图片，且当前模型不支持图片
- **THEN** 系统在图片被 provider-specific 序列化降级之前转换或复用已有成功观察
- **AND** 当前模型不会只收到通用的 image omitted 占位符

### Requirement: 视觉模型解析和凭据复用
The system SHALL 仅允许选择声明支持 image input 的可用 Pi 模型作为视觉模型，并在运行时通过 Pi 的模型注册表解析模型、凭据、endpoint、headers 和 provider 行为。

The system SHALL NOT 将 Pi registry、环境变量、认证文件或模型配置中的 API key/baseUrl 复制到视觉桥配置或返回给浏览器，也不得把一个来源的 endpoint 与另一个来源的凭据拼接使用。

#### Scenario: 选择有效视觉模型
- **WHEN** 用户选择一个当前 Pi 模型目录中声明支持 image input 的模型
- **THEN** 系统保存该模型的 provider/id 引用，并在运行时通过 Pi registry 调用它
- **AND** 浏览器只收到模型能力和凭据是否可用的布尔状态，不收到明文凭据

#### Scenario: 选择非视觉模型
- **WHEN** 用户尝试把未声明 image input 的模型保存为视觉模型
- **THEN** 系统以 `ERR-VB-MODEL-NOT-VISION` 拒绝保存，且不改变原配置
- **AND** 用户选择其他视觉模型后可重试

#### Scenario: 模型或凭据运行时不可用
- **WHEN** 已保存的视觉模型从目录中消失，或 Pi registry 无法解析可用凭据
- **THEN** 系统把受影响图片标记为转换失败，不向未知 endpoint 发送图片
- **AND** 当前 Pi 文本会话继续执行

#### Scenario: 视觉模型目录暂不可用
- **WHEN** 设置页请求视觉模型目录，但 clean Pi probe 无法返回可校验的完整模型能力
- **THEN** 系统以 `ERR-VB-MODELS-UNAVAILABLE` 返回可重试错误
- **AND** 不返回猜测的视觉模型，也不改变当前配置

### Requirement: 有界转换、失败降级和取消
The system SHALL 对每个受视觉桥接管的图片产生成功、失败、跳过或取消中的一个确定结果，并在总转换时限内结束本批处理。

The system SHALL NOT 因视觉模型超时、上游错误、配置损坏、扩展异常或用户取消而把整个 Pi turn 误报为视觉转换成功或无限等待。

#### Scenario: 视觉模型调用失败
- **WHEN** 视觉模型返回错误、空响应或无法解析的响应
- **THEN** 当前无视觉模型收到一段明确标记为转换失败的文字观察，原图不进入当前模型
- **AND** 会话继续执行，UI 显示失败状态及不含敏感信息的原因

#### Scenario: 转换总时限耗尽
- **WHEN** 本批图片转换达到配置的总时限
- **THEN** 未完成图片全部进入失败状态，系统停止等待额外视觉结果
- **AND** Pi turn 继续处理已经完成的观察和失败说明

#### Scenario: 用户取消运行
- **WHEN** 用户在图片转换期间取消当前 Pi run
- **THEN** 系统请求取消仍在进行的视觉调用，并由客户端 store 根据现有 `complete(aborted:true)` 和已发布的 started 状态为尚未完成的图片合成唯一 cancelled 终态
- **AND** 取消后扩展发出的迟到 succeeded/failed 状态不得更新该 run 的前端或历史状态

#### Scenario: 部分图片失败
- **WHEN** 同一批图片中只有部分图片转换成功
- **THEN** 当前模型按原始图片顺序收到成功观察和逐图失败说明
- **AND** 单张失败不撤销其他图片的成功结果

### Requirement: 视觉观察的来源和提示注入隔离
The system SHALL 把视觉模型输出标记为系统生成但不可信的图片观察，使当前模型能够区分用户指令和图片内文字或视觉模型推断。

The system SHALL NOT 把图片中识别到的命令、提示词或操作指令自动提升为新的用户指令，也不得宣称视觉模型无法确认的身份、真伪或来源为确定事实。

#### Scenario: 图片包含指令文本
- **WHEN** 图片中包含“忽略之前指令”、命令行或其他操作性文字
- **THEN** 系统把这些内容作为图片观察中的被引用数据提供给当前模型
- **AND** 明确指示当前模型不得把它当作新的用户授权或系统指令

#### Scenario: 视觉模型输出伪造结构标记
- **WHEN** 视觉模型输出包含与视觉桥内部标记相似的文本
- **THEN** 系统转义或隔离该文本，不允许它结束当前观察块或伪造另一条结构化状态

### Requirement: 按用户隔离且原子保存的配置
The system SHALL 为每个已认证 CloudCLI 用户保存独立、版本化的视觉桥配置；默认状态为关闭，配置只包含视觉模型引用、来源策略和有界运行参数。

The system SHALL NOT 让一个用户读取或修改另一个用户的视觉桥配置；没有可用用户身份的运行不得启用视觉桥。该要求只覆盖本能力新增的配置和运行策略，不改变现有 Pi host-level credentials、全局 assets 或 session ownership 的既有信任模型。

#### Scenario: 首次读取配置
- **WHEN** 已认证用户从未保存视觉桥配置
- **THEN** 系统返回 schema version 为 1 的默认关闭配置
- **AND** 工具图片转换默认关闭

#### Scenario: 保存合法配置
- **WHEN** 已认证用户提交字段、范围和视觉模型都合法的完整配置
- **THEN** 系统以受限文件权限原子保存完整配置并返回脱敏后的公共配置
- **AND** 扩展在后续 live run 中读取到完整旧配置或完整新配置，不会读到半写入状态

#### Scenario: 参数错误
- **WHEN** 配置包含未知字段、错误 schema version、非法数值范围或缺失的必填模型引用
- **THEN** 系统以 `ERR-VB-CONFIG-INVALID` 拒绝请求，且原配置保持不变
- **AND** 用户修正后可重试

#### Scenario: 重复请求
- **WHEN** 同一用户再次提交完全相同的合法配置
- **THEN** 系统返回相同公共配置，磁盘上的规范化内容保持一致
- **AND** 不产生额外运行事件或 secret 副本

#### Scenario: 跨用户访问
- **WHEN** 一个已认证用户尝试通过本能力指定其他用户身份读取或修改视觉桥配置
- **THEN** 系统以 `ERR-VB-CONFIG-INVALID` 拒绝请求
- **AND** 不泄露目标用户配置是否存在；路由不得接受 body 或 URL 中的任意 userId 作为授权依据

#### Scenario: 配置持久化失败
- **WHEN** 已校验配置因文件权限、磁盘或原子替换失败而无法保存
- **THEN** 系统以 `ERR-VB-CONFIG-WRITE` 返回可重试错误
- **AND** 旧配置保持完整，临时文件被清理

### Requirement: Live runtime 扩展隔离
The system SHALL 仅在当前用户配置有效且启用时，把受信视觉桥扩展显式加载到 Pi live runtime；认证、模型目录和技能目录探测不得加载视觉桥。

The system SHALL NOT 因加载视觉桥而改变 `PI_ENABLE_EXTENSIONS` 的既有含义，也不得在默认情况下开启其他扩展的自动发现。

#### Scenario: 默认扩展发现关闭且视觉桥启用
- **WHEN** 视觉桥启用且 `PI_ENABLE_EXTENSIONS` 未开启
- **THEN** Pi live runtime 同时保留扩展发现禁用参数并显式加载唯一的视觉桥扩展
- **AND** auth/model/skills probes 不加载该扩展

#### Scenario: 用户显式开启全部 Pi 扩展
- **WHEN** `PI_ENABLE_EXTENSIONS=1`
- **THEN** 系统保持现有的扩展发现开启语义，并额外显式加载视觉桥扩展（若配置启用）
- **AND** 不声称其他已发现扩展仍被禁用

#### Scenario: 视觉桥硬启动失败
- **WHEN** 注入视觉桥后的 Pi live runtime 在 `start()`、`getState()`、pre-prompt 健康命令检查阶段明确失败，或健康命令缺失
- **THEN** 系统记录 `ERR-VB-EXTENSION-START`，最多去掉视觉桥重试一次
- **AND** 健康检查成功前不得持久化或向客户端发布首次 child 的 native session identity；官方 `prompt()` 超时、连接超时、child close 或普通上游模型失败不得触发重放；重试成功时基础 Pi turn 继续执行并显示视觉桥不可用状态，重试失败时沿用 Pi 原有运行失败语义

### Requirement: 结构化运行事件和会话持久化
The system SHALL 为视觉转换发布结构化的 started、succeeded、failed、skipped 和 cancelled 状态，并使用应用会话、运行、客户端消息、工具调用、可用的 Pi source entry 和图片序号等稳定身份关联实时结果。

The system SHALL 将在 Pi `turn_end` 前完成的终态视觉结果保存为不参与主模型上下文的 namespaced session 派生条目；存在唯一 source entry 锚点时投影回原始用户消息或工具结果旁，不存在唯一锚点时显示为明确“未绑定来源”的 session-level 卡片而不得猜测；run 被取消时，cancelled 状态可以只由实时 run 终态合成而不写入 session。

The system SHALL NOT 使用机器全局 JSONL 描述文件作为实时 UI 的 source of truth，也不得只依赖图片 hash 和时间戳猜测消息归属。

#### Scenario: 用户图片实时转换
- **WHEN** 已关联 `clientMessageId` 的用户消息开始转换图片
- **THEN** 对应会话和运行收到 started 状态，完成后收到同一身份下的终态
- **AND** 其他会话即使发送相同图片也不会收到或匹配该状态

#### Scenario: 工具图片实时转换
- **WHEN** 工具结果图片开始转换
- **THEN** 状态包含所属应用会话、run 和 `toolCallId`
- **AND** UI 把结果显示在对应工具调用而非最近的任意图片消息上

#### Scenario: 历史恢复
- **WHEN** 用户重新打开包含视觉桥派生条目的 Pi 会话
- **THEN** 系统从 session 中恢复视觉卡片及其终态，并保留原始用户文字和图片；有唯一 source entry 时显示在其旁边，否则显示为未绑定来源卡片
- **AND** 不需要读取机器全局事件文件

#### Scenario: 相同图片并发会话
- **WHEN** 两个会话同时处理内容相同的图片
- **THEN** 每个会话只接收属于自己的结构化状态和持久化结果
- **AND** 本能力不得新增一个绕过现有 session/asset 授权的跨用户读取接口

### Requirement: 可信卡片和消息一致性
The system SHALL 仅依据结构化视觉桥运行事件或 Pi session 派生条目渲染视觉桥卡片，并使用稳定 `clientMessageId` 对齐 optimistic 用户消息与持久化用户消息；历史条目无法唯一锚定时不得通过最近消息猜测。

The system SHALL NOT 仅因普通正文包含类似“视觉桥已查看”的字符串而显示可信成功徽章或从正文删除内容。

#### Scenario: 成功卡片
- **WHEN** 当前消息存在可信的 succeeded 视觉桥结果
- **THEN** UI 在原始图片旁显示视觉桥成功卡片和派生描述
- **AND** 原始用户正文不因卡片渲染被改写或隐藏

#### Scenario: 失败或取消卡片
- **WHEN** 当前图片存在 failed、skipped 或 cancelled 终态
- **THEN** UI 显示对应的非成功卡片和安全错误说明
- **AND** 不显示“视觉桥已查看”成功徽章

#### Scenario: 伪造标记文本
- **WHEN** 用户、工具或模型正文中直接出现形似视觉桥标记的普通字符串，但没有匹配的结构化结果
- **THEN** UI 按普通正文显示该字符串
- **AND** 不生成视觉桥卡片，不吞掉后续正文

#### Scenario: 实时消息与历史消息对齐
- **WHEN** 带图片的 optimistic 用户消息随后从 Pi session 历史返回
- **THEN** 系统通过稳定消息身份把它们合并为一条用户消息，并保留图片附件
- **AND** 视觉桥派生卡片不会造成重复用户气泡

### Requirement: 有界图片数量和成功结果复用
The system SHALL 对每个 CloudCLI/Pi provider run 应用配置的图片调用数量上限，并为超过上限的每张图片产生 skipped 结果；同一 Pi session 中，输入完全相同的成功视觉观察可以复用且不消耗新的调用预算。

The system SHALL NOT 复用仅图片 hash 相同但视觉模型、媒体类型、提示模板或配置版本不同的结果，也不得把瞬态失败作为长期成功缓存。

#### Scenario: 超过图片上限
- **WHEN** 符合转换策略的图片数量超过当前配置上限
- **THEN** 系统只调用视觉模型处理允许数量的图片，并为每张超限图片生成 skipped 状态和文字说明
- **AND** 不静默丢弃超限图片

#### Scenario: 成功结果复用
- **WHEN** 同一 Pi session 再次需要处理图片字节、媒体类型、视觉模型、提示模板和配置版本完全相同的图片
- **THEN** 系统复用已有成功观察，不再次调用视觉模型
- **AND** 每个图片位置仍获得独立且正确的结构化关联

#### Scenario: 失败后重试
- **WHEN** 图片上一次因超时、限流或网络错误而失败，之后再次进入新的转换运行
- **THEN** 系统允许重新调用视觉模型
- **AND** 不把上一次瞬态失败当作可长期复用的结果

### Requirement: 数据外发告知和最小化
The system SHALL 在启用视觉桥前明确告知用户，符合来源策略的图片将发送到所选视觉模型供应商，并显示供应商和模型身份。

The system SHALL NOT 在全局运行日志、公共配置响应或新建的跨用户可见存储中记录图片字节、明文凭据或完整视觉描述；完整视觉描述只能随所属 Pi session 派生条目保存，并沿用现有 session history endpoint 的访问语义，本能力不得新增独立的跨用户描述查询。

#### Scenario: 启用前告知
- **WHEN** 用户尝试从关闭状态启用视觉桥
- **THEN** 设置界面展示图片外发说明、所选供应商和工具图片策略
- **AND** 用户确认并保存后，后续 live run 才能启用视觉桥

#### Scenario: 最小化诊断
- **WHEN** 视觉转换成功或失败
- **THEN** 运行日志只记录会话关联、状态、耗时、模型身份和脱敏错误码
- **AND** 完整描述只随所属 Pi session 派生条目保存并受该会话访问控制约束
