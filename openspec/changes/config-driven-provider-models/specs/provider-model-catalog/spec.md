## Purpose

定义模型目录（provider model catalog）的对外行为契约：目录的**可选性**以 provider 的连接与认证状态为准，且在**全部用户可见入口**（REST、内置 `/models` 命令、前端两处渲染）一致；目录的**来源**优先为本地配置声明的 base_url/api_key 驱动的 API 拉取（失败逐级回退既有来源）；目录的**缓存**以完整配置指纹为键且不缓存 fallback。仅登记对外可观测的行为变化，纯内部实现手段（共享 store 的具体形态、指纹算法）不进入本 spec。

## ADDED Requirements

### Requirement: 模型目录的可选性以连接与认证状态为准，且所有入口一致

未连接（CLI 未安装）或未登录（无可用凭证）的 provider，其模型目录在**所有**用户可见入口都不可选。连接与登录状态由 provider 的 auth status 表达（`installed` 与 `authenticated` 同时为真方为可用）；安装探测必须可靠，不得把 CLI 缺失误判为已安装。

The system SHALL 在「provider 未安装或未认证」时拒绝该 provider 的模型目录请求，返回认证错误而非模型列表。

The system SHALL 使「未安装或未认证」的拒绝语义在模型目录的**全部入口**一致——REST 目录端点、内置 `/models` 命令、前端模型选择器——不得存在可绕过的旁路。

The system SHALL 在「provider 未安装或未认证」时拒绝该 provider 的模型选择写入（active-model 记录），与目录读取同一认证标准。

The system SHALL 使前端在「确定未认证」时不呈现模型选择器；「认证检查中或检查失败」时呈现未就绪骨架而非隐藏。

The system SHALL 以可靠的安装探测判定 `installed`——CLI 缺失（ENOENT）、探测命令非零退出或超时均视为未安装。

The system SHALL NOT 用 fallback 模型列表把「未认证」伪装成「已登录且可用」。

The system SHALL NOT 以 provider 的静态能力注册状态代替认证状态作为模型可选性的依据。

#### Scenario: provider 未安装（CLI 缺失）
- **WHEN** 请求一个未安装 CLI 的 provider 的模型目录（CLI 缺失、探测命令非零退出或超时）
- **THEN** 后端以认证错误（`PROVIDER_NOT_AUTHENTICATED`，401）拒绝，不返回任何模型列表

#### Scenario: CLI 缺失但凭证存在
- **WHEN** 本地配置有有效凭证但 CLI 实际未安装
- **THEN** 安装探测返回 `installed=false`，请求仍被认证错误拒绝——凭证不能补足「未连接」

#### Scenario: provider 已安装但未登录
- **WHEN** 请求一个已安装但无可用凭证的 provider 的模型目录
- **THEN** 后端以认证错误拒绝，不返回 fallback 列表，也不写入模型缓存

#### Scenario: /models 命令与 REST 一致
- **WHEN** 通过内置 `/models` 命令请求一个未认证 provider 的模型目录
- **THEN** 命令与 REST 目录端点返回同一认证错误，不返回可选模型列表

#### Scenario: active-model 写入与读取一致
- **WHEN** 对未认证 provider 写入 session 的模型选择
- **THEN** 写入被认证错误拒绝

#### Scenario: 已认证的 provider 正常拉取
- **WHEN** 请求一个已安装且已认证的 provider 的模型目录
- **THEN** 后端正常返回模型列表（来源见下一 Requirement）

#### Scenario: 未注册的 provider
- **WHEN** 请求一个未注册的 provider id 的模型目录
- **THEN** 系统仍以既有的未注册错误拒绝，不落入认证检查（错误码区分保持）

#### Scenario: 前端仅对确定未认证隐藏
- **WHEN** 当前 provider 的认证状态为「确定未认证」
- **THEN** composer 与命令弹窗的模型选择器完全不渲染

#### Scenario: 前端认证检查中或失败
- **WHEN** 当前 provider 的认证状态为「检查中」或「检查失败」
- **THEN** 模型选择器呈现未就绪骨架（禁用占位），不隐藏也不展示可选列表

### Requirement: 模型目录来源优先为本地配置驱动的 API 拉取

已认证 provider 的模型目录优先从本地配置声明的 base_url 与凭证拉取真实模型列表；配置缺失或拉取失败时回退既有来源（CLI 缓存/命令输出/内置 fallback 列表）。配置解析与认证判定共用同一解析器与同一配置解释，base_url 语义统一（无缺省值、规范化到 API root）。

The system SHALL 在本地配置同时提供 base_url 与凭证时，以 `GET {base_url}/v1/models` 的响应作为模型目录，并按 provider 自身的 API 协议构造请求（Claude 用 Anthropic 协议，Codex 用 OpenAI 兼容协议）。

The system SHALL 将 base_url 规范化为 API root 后追加 `/v1/models`——base_url 已以 `/v1` 结尾时不得产生重复的 `/v1/v1/models`。

The system SHALL 在配置缺失、凭证缺失或 API 拉取失败（超时、非 2xx、响应不可解析）时回退到该 provider 的既有模型来源，且不使请求整体失败。

The system SHALL 使配置解析与认证判定对同一配置文件只有一种解释——模型目录与认证不得各自解析并得出不同结论。

The system SHALL NOT 在配置齐全且 API 可达时使用内置写死列表代替真实列表。

The system SHALL NOT 因 API 拉取失败向调用方暴露底层错误——回退结果与「未配置」的目录表现一致。

The system SHALL NOT 在没有明确配置 base_url 时默认到任何官方地址联网拉取——只有凭证没有 base_url 视为配置缺失，回退既有来源。

#### Scenario: 配置齐全且 API 可达（Claude）
- **WHEN** `~/.claude/settings.json` 的 env 配置了 `ANTHROPIC_BASE_URL` 与 `ANTHROPIC_API_KEY`（或 `ANTHROPIC_AUTH_TOKEN`），且该端点 `/v1/models` 可访问
- **THEN** Claude 的模型目录来自该端点的响应（`data[].id`），而非内置写死列表；`ANTHROPIC_API_KEY` 以 `x-api-key` 发送，`ANTHROPIC_AUTH_TOKEN` 以 `Authorization: Bearer` 发送

#### Scenario: Claude 只有凭证没有 base_url
- **WHEN** settings.json 配置了 `ANTHROPIC_API_KEY` 但无 `ANTHROPIC_BASE_URL`
- **THEN** 视为配置缺失，回退内置列表，不联网拉取官方目录

#### Scenario: Codex 真实配置格式
- **WHEN** `~/.codex/config.toml` 的 `model_providers.<active>` 配置了 `base_url`（可能以 `/v1` 结尾）与 `experimental_bearer_token`（或 `api_key`、`env_key` 间接取值）
- **THEN** 模型端点 = 规范化后的 API root + `/v1/models`（不产生 `/v1/v1/models`），目录来自该端点，且认证判定基于同一解析器认其为已认证

#### Scenario: 配置缺失
- **WHEN** 本地配置没有 base_url 或没有凭证
- **THEN** provider 的模型目录来自既有来源（claude 为内置列表，codex 为 `models_cache.json` 后内置列表）

#### Scenario: 配置齐全但 API 不可达
- **WHEN** 配置齐全但端点超时、返回非 2xx 或响应无法解析
- **THEN** provider 的模型目录回退到既有来源，请求仍成功返回目录

#### Scenario: Pi 保持既有动态来源
- **WHEN** 请求 Pi 的模型目录
- **THEN** 仍来自 Pi RPC 的实时模型列表，不受本 Requirement 的配置读取影响（其未认证行为以既有的 Pi 认证错误表达）

### Requirement: 模型目录缓存以完整配置指纹为键，且不缓存 fallback

配置驱动的模型目录结果可缓存，但缓存必须感知**完整配置**（base_url、凭证、活动 provider、默认模型），任一变化不得命中旧缓存；配置 API 拉取失败的 fallback 结果不得进入长缓存，端点恢复后应能重试。

The system SHALL 使模型目录缓存的键包含配置指纹（base_url 与凭证与活动 model provider 与配置 model 的哈希），任一配置项变更后旧缓存不命中。

The system SHALL 使缓存键与在途请求去重（pendingRequests）使用同一完整指纹。

The system SHALL 使「配置 API 拉取失败」产生的 fallback 目录不进长缓存（仅内存短驻），下次请求仍尝试真实拉取。

The system SHALL 使缓存键与在途去重由 provider 的 model facet 提供原子化的配置身份（指纹与可缓存性元数据），中央缓存服务不解析任何 provider 配置文件。

The system SHALL NOT 在缓存与持久化中落盘原始凭证（只落凭证的哈希）。

The system SHALL NOT 使「无配置」与「任一配置」共享同一缓存条目。

#### Scenario: base_url 变更立即生效
- **WHEN** 某 provider 的 base_url 从 A 改为 B
- **THEN** 下一次模型目录请求以 B 拉取，不返回 A 的缓存目录，也不等待 TTL 过期

#### Scenario: 凭证或活动 provider 变更立即生效
- **WHEN** 凭证更换、`model_provider` 切换或配置 `model` 变更
- **THEN** 旧缓存不命中，以新配置重新拉取

#### Scenario: fallback 不进长缓存，端点恢复后重试
- **WHEN** 配置 API 拉取失败返回 fallback，随后端点恢复
- **THEN** fallback 未写入长缓存，端点恢复后的下一次请求重新拉取成功，不再返回错误目录

#### Scenario: 未配置路径缓存等价于现状
- **WHEN** provider 无配置
- **THEN** 缓存键与现状等价（空指纹），既有缓存行为不回归

## MODIFIED Requirements

<!-- 无。既有 provider 的模型目录行为在已认证且未配置路径下与现状逐字节一致；本 spec 仅新增可选性、来源与缓存的契约。 -->
