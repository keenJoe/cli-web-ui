<!-- 本文定义本次变更上线前「如何」被证明正确。依据来自 specs/，不来自 design.md 或实现。
     变更不涉及资金、数据删除、数据迁移；主要风险在并发（文件监听+防抖）与外部子进程（git）。 -->

## 测试目标与边界

证明 ChatComposer 的 git 分支标识在**显示、实时同步、入口跳转**三条 Requirement 上满足 spec 的全部 Scenario，且 watcher 与广播通路的边界与异常行为符合设计约束。

**范围内：**
- 后端 `git-status.service` 对分支/detached/未提交计数的计算正确性（含非 git 仓库）。
- `git-status-watcher.service` 的 `.git` 监听 → 防抖 → 计算 → 经端口广播的事件流，含 2s 时效与「不监听工作区」约束。
- `IGitStatusPublisher` 端口的注入与广播行为（内存实现 + WS 适配器）。
- 前端 `useComposerGitStatus` 的 WS 订阅、缓存回显、REST 兜底、多工程切换。
- `GitBranchChip` 的渲染分支（正常/干净/detached/非 git/窄屏）与点击跳转。
- 未提交计数口径（modified+added+deleted+untracked，不含 staged）。

**范围外：**
- GitPanel 自身的 REST 通路与 `useGitPanelController` 行为（已有测试，本次不动，E12）。
- `git.routes.ts` 的 `GET /status` 既有行为（不新增路由、不改 route，E1）。
- 多用户工程成员可见性权限（全量广播风险已在 design 登记，本次不做定向广播）。
- WS 鉴权与心跳（既有逻辑，本次只复用 `connectedClients`）。

## 覆盖策略

| 维度 | 是否覆盖 | 样本数 | 说明 |
|---|---|---|---|
| 正常路径 | 是 | 6 | git 仓库正常分支显示、干净工作区、chip 点击跳转、应用内/外切分支实时更新、多工程切换缓存回显 |
| 异常 | 是 | 5 | git 子进程失败/超时、chokidar 监听错误、`.git` 目录被删除、WS 断连保留最后状态、首次进入工程无缓存 |
| 边界 | 是 | 6 | detached HEAD 短哈希、空仓库（无提交但已 init）、分支名超长截断（140px）、未提交计数=0 不显徽标、staged 不计入计数、窄屏隐藏优先级 |
| 对抗 | 是 | 2 | 恶意/畸形 `.git/HEAD` 内容导致 `symbolic-ref` 异常输出；超长分支名/特殊字符注入 chip DOM |
| 高风险 | 是 | 3 | 防抖窗口内并发多次 `.git` 事件合并为一次广播；`.git/HEAD` 与 `.git/refs/heads` 同一切换产生的竞态；广播到全量连接的 best-effort 不阻塞 watcher |

## 评测集

样本来源：基于 spec 的 10 个 Scenario + design 的并发/超时约束构造；git 仓库样本用真实 `git init` + 提交 + checkout 的临时目录（与现有 `git.test.ts` 同构），不 mock git。

| 编号 | 输入 | 预期 | 维度 | 来源 |
|---|---|---|---|---|
| S01 | git 仓库，分支 `develop`，2 个 modified + 1 untracked | chip 渲染 `⎇ develop ·3` | 正常路径 | spec「正常显示」 |
| S02 | git 仓库，干净工作区 | chip 渲染 `⎇ develop`，无计数徽标 | 边界 | spec「干净工作区」 |
| S03 | detached HEAD（`git checkout <hash>`） | chip 显示 7 位短哈希，`isDetached:true`，样式灰色斜体 | 边界 | spec「Detached HEAD」 |
| S04 | 非 git 目录 | chip 不渲染，不占布局（`isGitRepository:false`） | 边界 | spec「非 git 仓库」 |
| S05 | 视口宽度低于 sm 断点 | chip 隐藏，清空输入按钮按其既有断点处理，输入与发送保留 | 边界 | spec「窄屏」 |
| S06 | 分支名长度渲染宽度 > 140px | 分支名以省略号截断 | 边界 | spec「正常显示」AND |
| S07 | watcher 监听中，外部 `git checkout feature` | 2s 内 chip 更新为 `feature` 与新计数 | 正常路径 | spec「应用外部切分支」 |
| S08 | GitPanel 内 checkout 成功 | 2s 内 chip 更新为新分支与新计数 | 正常路径 | spec「应用内切分支」 |
| S09 | 外部编辑工作区文件（不改分支） | chip 计数不立即更新；下一次分支事件或重入工程时刷新 | 异常 | spec「外部修改工作区文件」 |
| S10 | WS 断连 | chip 保留最后已知分支与计数；重连后由后端推送最新 | 异常 | spec「WebSocket 断连」 |
| S11 | 从工程 A 切到工程 B（B 有缓存） | chip 立即显示 B 缓存状态，后台 `GET /api/git/status` 校验 | 正常路径 | spec「多工程切换」 |
| S12 | 点击 chip | 主界面活动标签页切为 `git`，GitPanel 挂载加载 status/diff/branches | 正常路径 | spec「点击跳转」 |
| S13 | `git status` 子进程超时（>5s） | 丢弃本次广播，记 `console.error`，watcher 不崩 | 异常 | design 非功能-超时 |
| S14 | chokidar 监听 error 事件 | 记日志，该工程 watcher 进 `ERRORED`，其余工程不受影响 | 异常 | design 状态流转 |
| S15 | 工程的 `.git` 目录被删除 | 该工程发一次 `isGitRepository:false` 后移除条目，chip 隐藏 | 异常 | design 风险 |
| S16 | 首次进入工程，模块级缓存无该 projectId | 调 `GET /api/git/status` 兜底加载后渲染 | 异常 | spec 兜底 + design 决策 7 |
| S17 | 一次 checkout 同时改 `.git/HEAD` 与 `.git/refs/heads/feature`（防抖窗口内多次事件） | 合并为一次状态计算与一次广播 | 高风险 | design 非功能-并发 |
| S18 | 500ms 防抖窗口内连续 5 次 `.git` 事件 | 仅 1 次 `git status` 子进程调用 + 1 次广播 | 高风险 | design 非功能-并发 |
| S19 | 广播时部分 `connectedClients` 已关闭/非 OPEN | 跳过非 OPEN 连接，不抛错，watcher 继续运行 | 高风险 | design E4 + best-effort |
| S20 | `.git/HEAD` 内容畸形（非 `ref: ...` 也非哈希） | `symbolic-ref` 失败、`rev-parse --short HEAD` 失败 → 记错并跳过本次广播，不渲染异常分支名 | 对抗 | design 决策 2/6 |
| S21 | 分支名含特殊字符（空格、`<`、`&`） | chip 以纯文本渲染，不执行 HTML 注入 | 对抗 | spec 渲染安全 |
| S22 | 仓库已 init 但无任何提交 | `isGitRepository:true`、`branch:''`、计数为 untracked 数；chip 渲染为空分支名或隐藏（按实现约定，但不得崩溃） | 边界 | design 数据模型-空值语义 |

## 评分规则

逐样本判定，保留原始记录（样本编号、实际输出、通过/失败、失败原因归因）。

- **通过**：实际行为与「预期」列完全一致；含时效的样本（S07/S08/S10/S17/S18）需在 2s 内完成且仅触发预期次数的计算/广播。
- **失败**：行为偏离预期，或时效/次数超标。失败必须归因到以下之一：① spec 定义不清、② 设计缺陷、③ 编排执行错误、④ 外部 git 行为、⑤ 测试数据问题。不得归因到「模型问题」。
- **总分** = 通过样本数 / 22 × 100%，分维度单独统计（正常路径 6/6、异常 5/5、边界 6/6、对抗 2/2、高风险 3/3）。

## 验收规则与回归门槛

| 规则 | 门槛 | 适用范围 |
|---|---|---|
| 正常路径通过率 | 100%（6/6） | 正常路径样本 |
| 异常通过率 | ≥80%（4/5） | 异常样本 |
| 边界通过率 | 100%（6/6） | 边界样本 |
| 对抗通过率 | 100%（2/2） | 对抗样本 |
| 高风险通过率 | 100%（3/3） | 高风险样本 |
| 时效达标率 | 100% | S07/S08/S10/S17/S18 |
| 总体通过率 | ≥95% | 全部 22 样本 |
| 单元测试 | `npm test`（server）与相关模块测试全绿 | 后端新增服务 |
| 类型与 lint | `npm run typecheck` + `npm run lint` 无新增错误 | 全部新增/重塑文件 |

## 上线门禁

- [ ] 正常路径样本 100% 通过（6/6）
- [ ] 高风险样本 100% 通过（3/3）——并发合并与时效不可退化
- [ ] 对抗样本 100% 通过（2/2）——畸形 `.git/HEAD` 与特殊字符不致崩/注入
- [ ] 未提交计数口径测试通过：staged 不计入、modified+added+deleted+untracked 求和正确
- [ ] watcher 不监听工作区文件的约束有显式断言（外部改工作区文件不触发广播）
- [ ] `npm run typecheck`、`npm run lint`、`npm test` 均无新增失败
- [ ] 逐样本评分记录已留存（非仅汇总分）

## 报告审核清单

| 审核项 | 必须确认 | 不通过情形 | 结论影响 |
|---|---|---|---|
| 场景覆盖 | 所有适用维度均已覆盖 | 只跑了正常路径样本 | 不得放行 |
| 样本结构 | 样本能代表真实风险分布（含并发/超时/对抗） | 只挑容易的样本 | 报告不可信 |
| 评分规则 | 按既定规则评分且保留逐样本原始记录 | 只有汇总分，无逐样本记录 | 结论不可审计 |
| 验收规则 | 各维度均达门槛 | 主流程达标但高风险样本失败 | 不能判定通过 |
| 问题归因 | 每个失败归因到明确原因 | 只写「模型问题」或无具体指向 | 无法闭环修复 |
| 回归结果 | 修复后已重新验证并附证据 | 有修复说明，无回归结果 | 问题不得关闭 |
| 门禁结论 | 所有硬性门禁均已满足 | 任意硬性门禁未达标 | 直接不放行 |

**结论：** 待执行后填写 —— 理由：22 样本逐项通过且门禁全满足方准予上线；任一高风险/对抗样本失败即不通过。

## E2E 验证配置（可选）

本次变更涉及可浏览器验证的 UI 行为（chip 渲染、点击跳转、窄屏隐藏），但实时同步依赖后端 watcher + WS，浏览器 E2E 仅覆盖正常路径与部分异常；对抗、边界、高风险由单元/集成测试补充。

| 字段 | 值 |
|---|---|
| VisionE2E 项目 | 待 apply 后确认本地是否配置 VisionE2E MCP；未配置则跳过 E2E，以单元/集成测试为准 |
| 目标 URL | 本地 dev server（`npm run dev`） |
| 用例来源 | 生成 |
| 生成策略 | smoke |
| 登录方式 | none |

### E2E 验收门槛

| 维度 | 通过率门槛 | 说明 |
|---|---|---|
| 正常路径 | ≥ 100% | chip 渲染与点击跳转主流程必须全通过 |
| 异常 | ≥ 80% | 非仓库工程不渲染等可预期场景 |
