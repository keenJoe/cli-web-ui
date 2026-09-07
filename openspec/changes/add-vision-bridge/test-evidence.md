# 视觉桥测试证据报告

修订日期：2026-09-04（与 design.md 一致，避免将相对日期解释为未来门禁）。

本报告把 `test-definition.md` 的 T1–T47 逐样本映射到实际落地的测试文件与测试名，并记录门禁命令的最终结果。所有测试均以 `node --import tsx --test <file>`（后端）或 `npm run test:frontend`（前端）运行，退出码 0。

## 一、门禁命令最终结果

| 门禁 | 命令 | 结果 |
|---|---|---|
| 后端全量 | `npm test` | 730 pass / 0 fail |
| 前端全量 | `npm run test:frontend` | 162 pass / 0 fail |
| 类型检查 | `npm run typecheck` | 0 error |
| Lint | `npm run lint` | 0 error（237 warning 非阻塞） |
| 构建 | `npm run build` | exit 0 |
| 生产 bundle | `npm run server:bundle`（8.2） | compiled 扩展 + shared contract + 526 prod deps 存在；compiled probe `healthCommandPresent:true` |

## 二、T1–T47 逐样本映射

映射规则：每个 T 编号 → 覆盖它的测试文件:测试名。凡 T 编号对应的 SHALL/SHALL NOT 已由下列测试的直接断言覆盖。

### 后端图片/共享契约（T1–T3, T21–T24, T44–T47）
| T | 测试位置 |
|---|---|
| T1 | `server/shared/tests/image-attachments.test.ts` — `readTrustedPiImages reads a store image into a Pi image payload` / `detects JPEG/PNG/GIF/WebP from magic bytes` |
| T2 | 同文件 — `rejects paths outside the upload store` / `refuses symlinks that escape the upload store` / `uses cwd only for relative resolution, never as an allowed root` |
| T3 | 同文件 — `reports missing files as IMAGE_UNREADABLE` / `rejects unsupported magic bytes` / `skips images over the per-image byte cap` / `enforces the cumulative byte budget` / `returns partial success` |
| T21 | `server/modules/vision-bridge/tests/vision-bridge-config.repository.test.ts` — `different user ids map to different directories` / `POSIX config file is 0600 and directory is 0700`；`vision-bridge-config.service.test.ts` — `users are isolated` |
| T22 | 同组 — `config validation rejects unknown fields` / `rejects wrong schema version` / `rejects out-of-range numeric fields` |
| T23 | 同组 — `saving identical config is idempotent` / `idempotent save returns same public config` |
| T24 | `vision-bridge.routes.test.ts` — `request with an arbitrary userId in the URL is rejected` / `request body userId is rejected` |
| T44 | `vision-bridge-config.service.test.ts` — `resolveLaunchPolicy returns disabled for missing/null/empty userId` |
| T45 | `vision-bridge.routes.test.ts` — 仅 GET/PUT config + GET models（无全局描述/events 查询）；8.4 报告 grep 确认无 readdir/glob/JSONL 全局描述路径 |
| T46 | `vision-model-catalog.test.ts` — `decoder returns empty for non-array snapshots` + service `mapped to MODELS_UNAVAILABLE code` |
| T47 | `vision-bridge-config.repository.test.ts` — `write failure preserves the old file and leaves no temp file` |

### Pi 契约（E3/E5/E8）
| T | 测试位置 |
|---|---|
| （契约） | `pi-vision-contract.test.ts` — 9 个测试覆盖 context/turn_end 存在、before_provider_payload 不存在、ModelRegistry.find/complete/getApiKeyAndHeaders、inVisionCall guard、sourceEntryId 唯一/未绑定、真实 spawn setStatus/appendEntry |

### 扩展转换（T4–T10, T13–T19, T34–T36, T41）
| T | 测试位置 |
|---|---|
| T4 | `vision-bridge-extension.test.ts` — `native vision model short-circuits with zero vision calls` |
| T5 | 同文件 — `non-vision model + user image transforms to an untrusted observation` |
| T6 | `pi-sessions.provider.test.ts` — `preserves user image blocks as data URLs` / `projects a vision-bridge custom entry` |
| T7/T8/T9 | `vision-bridge-extension.test.ts` — `converts user, tool and history image sources` / `tool images are not converted when toolImages is off` |
| T10 | 同文件 — `session success is reused` / `different model or content does not reuse` / `legacy session entry without cacheFingerprint is not reused` |
| T13 | `vision-bridge-failure-e2e.test.ts` — `vision provider error yields an explicit failure observation`；扩展单测 `VISION_UPSTREAM` |
| T14 | 同文件 8.4.2 |
| T15 | `vision-bridge-extension.test.ts` — `batch deadline ... VISION_TIMEOUT` |
| T16 | `vision-bridge-failure-e2e.test.ts` — 8.4.4 取消；前端 `visionBridgeState.test.ts` — `synthesizeCancelledOnAbort` / `late succeeded rejected` |
| T17 | `vision-bridge-extension.test.ts` — `partial failure: N in a batch, M fail in original order` |
| T18/T19 | 同文件 — `untrusted observation escapes internal delimiters and does not elevate image commands` |
| T34 | 同文件 — `budget: maxImagesPerRun=4 skips the 5th` |
| T35/T36 | 同文件 — session success reuse 三测试 |
| T41 | 同文件 — `disabled config does not call the vision model` |

### 配置/目录/设置页（T11, T12, T20, T37, T42）
| T | 测试位置 |
|---|---|
| T11/T42 | `vision-bridge-config.service.test.ts` — `save rejects a non-vision model with ERR-VB-MODEL-NOT-VISION`；`vision-model-catalog.test.ts` |
| T12 | `vision-model-catalog.test.ts` — `decoder never leaks baseUrl, headers, or api keys`（secret 扫描） |
| T20 | `vision-bridge-config.service.test.ts` — `first read returns default disabled config` |
| T37 | `VisionBridgeSettingsTab.test.tsx` — 默认关闭/外发确认/模型过滤/脱敏（13 测试） |

### 注入/事件/会话（T25–T33, T38–T40, T43）
| T | 测试位置 |
|---|---|
| T25/T26/T27 | `vision-bridge-runtime.test.ts` — `live runtime injects -e and bridge env when policy is enabled` / `injects no bridge when disabled` / probe 无 bridge（组 5） |
| T28 | 同文件 — `missing health command retries once` / `prompt-time error does not retry` / `second bridge hard failure does not retry again` |
| T29 | 同文件 — `namespaced setStatus maps to a vision_bridge event with trusted identity override` |
| T30 | 前端 `visionBridgeState.test.ts` — 跨 app session 隔离；后端 identity override |
| T31 | `pi-sessions.provider.test.ts` — custom entry 投影 + 未绑定 sourceEntryId |
| T32 | 前端 `useChatMessages.test.ts` — marker spoof 不生成卡片、原样渲染 |
| T33 | `sessionMessageReconciliation.test.ts` — clientMessageId 优先合并、不生成第二条气泡 |
| T38 | `vision-bridge-failure-e2e.test.ts` — `secret scan: no apiKey/baseUrl/Bearer/image-bytes` |
| T39 | 8.2 compiled probe（`pi-vision-bridge-compiled-probe.json`） |
| T40 | `scripts/e2e/vision-bridge-success-e2e.mts` — 真实 subprocess，14/14 断言 |
| T43 | `VisionBridgeCard` + `visionBridgeState.test.ts` — 四种终态卡片 |

## 三、Secret 扫描结论

8.4 内置 `scanSecrets`（覆盖图片 base64 魔数 / apiKey / baseUrl / authorization / Bearer / sk- / secret URL）。每个失败场景 audit sink 断言 `===[]`，且有一个毒化样本证明扫描器能捕获泄漏。stdout 排除通过/失败标记行后 grep 扫描 CLEAN。

## 四、跨用户 / 跨 session 隔离结论

- 跨用户：真实 repository/service，alice/bob 目录 `sha256(userId)` 互异、字节独立、互不可见。
- 跨 session：前端 `applyVisionBridgeEvent` 的 appSessionId guard + 后端 runtime 用 request.appSessionId 覆盖 child 声明。
- 无新增全局描述/events 查询：routes 仅 GET/PUT config + GET models。

## 五、门禁结论

T1–T47 全部由上述测试覆盖且通过（后端 730 pass / 前端 162 pass / 0 fail）；secret 扫描 0 泄漏；生产 bundle smoke 通过；高风险样本（T16 取消、T21/T24 跨用户、T30 跨 session、T40 真实 E2E、T45 无旁路）均有直接证据。全部硬性门禁满足，准予放行。