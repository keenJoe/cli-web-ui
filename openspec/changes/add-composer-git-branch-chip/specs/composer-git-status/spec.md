<!-- 本文件中的结构标记由解析器按字面匹配，必须保持英文原样：
     `## Purpose`、`## ADDED|MODIFIED|REMOVED|RENAMED Requirements`、
     `### Requirement:`、`#### Scenario:`、`- **WHEN**`、`- **THEN**`、`- **AND**`，
     以及需求正文里的 SHALL / MUST / SHALL NOT 关键字。
     除这些标记之外的一切内容都用中文书写。 -->

## Purpose

在对话框（ChatComposer）内显示当前工程所属的 git 分支与未提交更改摘要，作为查看 GitPanel 的轻量入口；当分支或未提交状态在工程内或工程外发生变化时，对话框内的显示必须实时同步。

## ADDED Requirements

### Requirement: 对话框显示当前 git 分支与未提交摘要
The system SHALL 在 ChatComposer 工具栏内显示一个 git 状态标识，包含当前分支名与未提交更改计数。

The system SHALL NOT 在该标识上提供 checkout、创建分支或任何写操作；点击该标识仅切换到 GitPanel 标签页。该标识 SHALL NOT 展示文件级详情列表。

未提交更改计数 SHALL 为 modified、added、deleted、untracked 四类文件数之和，不含已暂存（staged）状态。

#### Scenario: 正常显示
- **WHEN** 用户选中一个 git 仓库工程并打开对话框
- **THEN** 工具栏显示形如 `⎇ <分支名> ·<计数>` 的胶囊标识
- **AND** 分支名长度超过 140px 时以省略号截断

#### Scenario: 干净工作区
- **WHEN** 当前分支无未提交更改
- **THEN** 标识显示分支名，不显示计数徽标

#### Scenario: Detached HEAD
- **WHEN** 仓库处于 detached HEAD 状态
- **THEN** 标识显示 commit 短哈希（前 7 位），样式为灰色斜体

#### Scenario: 非 git 仓库
- **WHEN** 选中的工程目录不是 git 仓库
- **THEN** 不渲染该标识，且不占用布局位置

#### Scenario: 窄屏
- **WHEN** 视口宽度低于 sm 断点
- **THEN** 该标识优先于「清空输入」按钮隐藏，保留核心输入与发送控件

### Requirement: git 状态变化实时同步
The system SHALL 在当前工程的分支或未提交状态发生变化后 2 秒内更新对话框标识，无论变化来源于应用内操作还是应用外部（终端、编辑器）。

变化检测 SHALL 基于后端对每个工程 `.git/HEAD` 与 `.git/refs/heads` 的文件系统监听，并通过现有 WebSocket 连接向已认证的前端连接推送 `git_status_changed` 事件。

The system SHALL NOT 对工作区文件进行轮询以检测未提交更改；未提交计数在分支切换事件触发时刷新，以及前端首次进入工程时通过 `GET /api/git/status` 兜底加载。

#### Scenario: 应用内切分支
- **WHEN** 用户在 GitPanel 执行 checkout 成功
- **THEN** 对话框标识在 2 秒内更新为新分支名与新未提交计数

#### Scenario: 应用外部切分支
- **WHEN** 用户在终端或外部编辑器执行 `git checkout`
- **THEN** 对话框标识在 2 秒内更新为新分支名

#### Scenario: 外部修改工作区文件
- **WHEN** 用户在外部编辑器修改文件导致未提交计数变化
- **THEN** 标识不立即更新（后端不监听工作区文件）
- **AND** 在下一次分支切换事件触发或前端重新进入工程时刷新

#### Scenario: WebSocket 断连
- **WHEN** 前端 WebSocket 连接中断
- **THEN** 标识保留最后已知的分支名与计数
- **AND** 连接恢复后由后端推送最新状态，无需前端主动轮询

#### Scenario: 多工程切换
- **WHEN** 用户从工程 A 切换到工程 B
- **THEN** 标识立即显示工程 B 的缓存状态（若有），并在后台通过 `GET /api/git/status` 校验最新值
- **AND** 后续工程 B 的 git 变化通过 WS 推送持续更新

### Requirement: 标识作为 GitPanel 入口
The system SHALL 在用户点击该 git 状态标识时，切换主界面到 GitPanel 标签页。

The system SHALL NOT 在点击时执行任何 git 操作或展开浮层。

#### Scenario: 点击跳转
- **WHEN** 用户点击 git 状态标识
- **THEN** 主界面的活动标签页切换为 `git`
- **AND** GitPanel 挂载并加载完整的 status/diff/branches 视图
