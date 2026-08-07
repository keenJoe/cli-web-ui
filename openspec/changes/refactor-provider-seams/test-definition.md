# Provider 公共接缝重构 测试定义

依据 `specs/provider-seams/spec.md`。本 change 是重构，最大风险是**回归**（改动 5 个 provider 的公共接缝）与**不可逆数据迁移**（唯一约束合并）。因此测试分两类：锁定既有行为的 characterization tests，与验证新契约的 spec tests。

**测试落地位置**：`npm test` 的 glob 是 `server/**/*.test.ts` 与 `server/**/*.test.js`，所有新增测试必须落在 `server/` 下才会被执行（数据库测试位于 `server/modules/database/tests/`，仓库根 `database/` 目录不含源码与测试）。

## 测试目标与边界

**范围内：**
- 重构前后**全部 5 个** provider（claude/codex/cursor/opencode/pi）的 observable 行为一致（live event、resume、abort、history、usage、replay）。Pi 同样迁入新接缝（runtime 直接实现 typed 接口、facet 可选化），因此必须有自己的 golden 基线。
- 新契约：能力描述的单一真相（含 descriptor 字段）、unknown vs unsupported 错误码、native 身份隔离、per-provider 游标、跨传输的单一终态。
- 唯一约束迁移：重复行合并的正确性、provider-qualified 隔离、以及**无 down migration 框架下的手工回滚**。

**范围外：**
- Pi 的功能行为（由 `add-pi-provider` 覆盖）；本 change 只验证 Pi 迁入新接缝后 observable 不变。
- provider 上游 CLI 行为。
- 其余 7 个带 `@ts-nocheck` 的非本 change 文件。

**刻意的行为变更（不算回归，需更新 golden 并单独断言）：**
- Pi 的 MCP 读操作：200 空成功 → 400 `PROVIDER_CAPABILITY_UNSUPPORTED`
- Cursor 的 token usage：200 `{unsupported:true,...}` → 400 `PROVIDER_CAPABILITY_UNSUPPORTED`
- 未命中分支的 provider 的 token usage：静默按 `.claude` 解析 → 400 `PROVIDER_CAPABILITY_UNSUPPORTED`

## 覆盖策略

| 维度 | 是否覆盖 | 样本数 | 说明 |
|---|---|---|---|
| 正常路径 | 是 | 7 | 五类契约的正常场景 + 5 provider 各自 characterization 冒烟 |
| 异常 | 是 | 6 | unknown provider、unsupported facet（读/写各一）、descriptor 非法、runtime 抛错终态、同步单点失败 |
| 边界 | 是 | 5 | app id=native id 同值、相同 native id 跨 provider、部分索引空 native、失败 provider 下轮恢复、新 provider 无游标记录 |
| 对抗 | 是 | 4 | abort 与迟到 native event 竞争（WS 与 SSE 各一）、迁移遇真实重复行、runtime 试图发 complete 被拦 |
| 高风险 | 是 | 6 | 唯一约束迁移合并正确性、迁移回滚、终态唯一性、providers→WS 反向依赖移除、5 provider 零回归、中央点收敛 |

## 评测集

| 编号 | 输入 | 预期 | 维度 | 来源 |
|---|---|---|---|---|
| R1 | provider 有 usage facet / 无 mcp facet | `supportsTokenUsage=true` / `supportsMcp=false` | 正常 | spec: 能力单一真相 |
| R2 | 未注册 provider id 请求 facet | `ERR-UNSUPPORTED-PROVIDER` | 异常 | spec: 错误码区分 |
| R3 | 已注册 provider **读取**其缺失的 facet（Pi 的 MCP 列表、Cursor 的 usage） | `ERR-PROVIDER-CAPABILITY-UNSUPPORTED`，非空成功 | 异常 | spec: 错误码区分 |
| R4 | 默认权限模式不在列表的 descriptor | 注册期 `ERR-PROVIDER-DESCRIPTOR-INVALID` | 异常 | spec: 错误码区分 |
| R5 | provider A、B 相同 native id | 视为两个 session，两行都保留、都不被删除 | 边界/高风险 | spec: 身份隔离 |
| R6 | 同 provider 重复 native id | 唯一约束拒绝或确定性合并 | 异常 | spec: 身份隔离 |
| R7 | app id 与 native id 同值 | 仍完成 DB mapping | 边界 | spec: 身份隔离 |
| R8 | 一个 provider 同步失败 | 其他 provider 游标独立推进 | 异常 | spec: 同步隔离 |
| R9 | 失败 provider 下轮恢复 / 新 provider 无游标记录 | 各自从自身游标续扫；新 provider 走全量且不影响他人 | 边界 | spec: 同步隔离 |
| R10 | 一次 run 正常结束 | 恰好一个成功终态 | 正常 | spec: 单一终态 |
| R11 | abort 与迟到 native event 竞争（**WebSocket**） | 恰好一个 aborted 终态 | 对抗 | spec: 单一终态 |
| R12 | runtime 抛错/进程异常关闭 | coordinator 产生恰好一个失败终态 | 异常 | spec: 单一终态 |
| R13 | legacy runtime 试图发 `complete` | 被 adapter/类型拦截，不产生第二终态 | 对抗 | spec: 单一终态 |
| R14 | 真实库存在跨 provider 重复 native id，执行迁移 | provider-qualified 合并，不跨 provider 误并 | 高风险 | design: 迁移 |
| R15 | **5 个** provider（claude/codex/cursor/opencode/pi）各自 characterization 冒烟，并经 Agent HTTP 在未传 model 时派发 | 重构前后 observable 一致；Claude/Cursor 的 typed run model 为 `undefined`，Codex/OpenCode/Pi 为各自 catalog `DEFAULT`（三处刻意 BREAKING 除外） | 正常/高风险 | design: 兼容性 |
| R16 | providers 模块静态依赖扫描 | 无 providers→WebSocket import（当前 2 处：`sessions.service.ts:6`、`sessions-watcher.service.ts:10`） | 高风险 | design: 依赖单向 |
| R17 | abort 与迟到 native event 竞争（**HTTP/SSE**）；HTTP new→resume 与跨 provider resume | 恰好一个 aborted 终态，与 WS 观察一致；mapping 在暴露前持久化，跨 provider resume 在目标 runtime 启动前拒绝 | 对抗/高风险 | spec: 单一终态跨传输、身份隔离 |
| R18 | 注册一个测试 provider，统计需改动的中央文件 | 仅 `LLMProvider` 联合、registry 注册、前端品牌映射三处 | 高风险 | design: 中央点收敛 |
| R19 | 执行手工回滚脚本删除部分唯一索引 | 索引消失、旧代码路径可正常读写 | 高风险 | design: 迁移无 down 框架 |
| R20 | capability 请求失败或未返回 | UI 呈禁用骨架，不出现按 provider id 猜测的默认权限模式 | 异常 | spec: 能力未就绪不猜测 |

## 评分规则

二值判定，断言全满足=通过。characterization tests（R15）以**重构前**录制的 golden 输出为基准逐条比对；三处刻意 BREAKING 的 golden 需单独更新并在 diff 中显式标注，不得混入「无变化」结论。逐样本记录含实际错误码/终态数量/依赖扫描结果/中央改动文件清单与失败归因，留存于测试输出。放行看分维度门槛。

**R11 与 R17 的基线注意事项**：`chat-run-registry.service.ts` 今天已对 WebSocket 路径实现 first-wins 终态去重，因此 R11 在重构**前**即应通过——它是回归锚点，不是新增能力。R17 在重构前应**失败**（SSE 路径无去重），录制基线时须如实记录该失败，重构后转绿即为该阶段的真实收益证明。

## 验收规则与回归门槛

| 规则 | 门槛 | 适用范围 |
|---|---|---|
| 5 provider 零回归 | 100% | R15（characterization 全绿，三处刻意 BREAKING 除外） |
| 高风险全通过 | 100% | R5、R14、R16、R17、R18、R19 |
| 契约异常全通过 | 100% | R2、R3、R4、R6、R12（错误码精确匹配） |
| 单一终态 | 100% | R10、R11、R12、R13、R17 |
| 能力单一真相 | 100% | R1、R18、R20 |
| 边界 | ≥ 90% | R7、R9 等 |

## 上线门禁

- [ ] characterization tests 在**重构前**先建立并通过（5 个 provider 的 golden 基准存在），否则不得开始替换。
- [ ] R17 的重构前失败基线已录制（证明 SSE 路径当前无终态去重）。
- [ ] `npm run build`、`npm run typecheck`、`npm run lint`、`npm test` 全绿。
      **前提已修正**：`npm test` 在本 change 开始前为 47/108 通过（61 失败，`@/` 别名解析），该门禁此前从未成立。已由 `package.json` 的 `test` 脚本加 `cross-env TSX_TSCONFIG_PATH=server/tsconfig.json` 修复（见 proposal「附带修复」），修复后该门禁才首次可用。基线为 375 用例全绿。
- [ ] 唯一约束迁移前已对真实库查询确认重复行情况（E12），合并在单事务内完成。
- [ ] 手工回滚脚本已交付并在测试库演练成功（R19）——因 `migrations.ts` 无 down migration 框架，此项不可用「框架回滚」替代。
- [ ] 一次 run 恰好一个终态，WebSocket 与 HTTP/SSE 两条传输均满足（R10–R13、R17 全通过）。
- [ ] providers 模块无对 WebSocket 的反向 import（R16）。
- [ ] 5 个 provider 的端到端冒烟不回归。
- [ ] `agent.routes.ts` 的 `@ts-nocheck` 已移除且 typecheck 通过。
- [ ] 中央点收敛已实测（R18），且 `LegacyProviderRuntimeAdapter` 的退出条件已建立追踪项。

## 报告审核清单

| 审核项 | 必须确认 | 不通过情形 | 结论影响 |
|---|---|---|---|
| 场景覆盖 | 五维均覆盖 | 只跑契约正常路径，缺 characterization | 不得放行 |
| 样本结构 | characterization 基于重构前真实录制，含 Pi | 用重构后代码反推 golden；或漏掉 Pi | 报告不可信 |
| 传输覆盖 | 终态用例 WS 与 SSE 各跑一遍 | 只跑 WS（该路径本就已通过，证明不了收益） | 结论不成立 |
| 评分规则 | 逐样本记录含错误码/终态计数/中央改动清单/归因 | 只有总分 | 结论不可审计 |
| 验收规则 | 各维度达门槛 | 高风险或零回归未满足 | 不能判定通过 |
| 迁移证据 | 真实库重复行查询、合并结果与回滚演练均留证 | 直接建索引未查重；或未演练回滚 | 直接不放行 |
| BREAKING 标注 | 三处刻意行为变更单独列出并核对前端消费点 | 混入「无变化」结论 | 报告不可信 |
| 问题归因 | 每个失败归因到 spec/设计/编排/数据 | 只写「重构副作用」 | 无法闭环 |
| 回归结果 | 修复后重跑并附证据 | 只有修复说明 | 问题不得关闭 |
| 门禁结论 | 全部硬门禁满足 | 任一未达标 | 直接不放行 |

**结论：** 待执行 — 依上述门禁判定。zero-regression、迁移查重与回滚演练为一票否决项。
