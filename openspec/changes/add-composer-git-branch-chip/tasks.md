<!-- 复选框标记 `- [ ]` 由 apply 阶段按字面解析以跟踪进度，必须保持该格式；
     标题与任务描述用中文。 -->

## 0. 文件归属

| 任务组 | 独占文件/目录 | 禁止改动 | 共享文件处理 |
|---|---|---|---|
| 1 | `server/shared/interfaces.ts`、`server/shared/types.ts` | `server/modules/git/git.routes.ts`、`server/modules/websocket/services/session-application-ports.adapter.ts` | 无 |
| 2 | `server/modules/git/git-status.service.ts`、`server/modules/git/git-status-publisher.service.ts`、`server/modules/git/git-status-watcher.service.ts`、`server/modules/git/index.ts`、`server/modules/git/tests/git-status.service.test.ts`、`server/modules/git/tests/git-status-watcher.service.test.ts`、`server/modules/git/tests/git-status-publisher.service.test.ts` | `server/shared/*`、`server/index.ts`、`server/modules/websocket/*`、`git.routes.ts`、`git.module.ts` | 无 |
| 3 | `server/modules/websocket/services/git-status-websocket-publisher.service.ts`、`server/modules/websocket/index.ts`、`server/modules/websocket/tests/git-status-websocket-publisher.service.test.ts` | `server/shared/*`、`server/modules/git/*`、`server/index.ts`、`session-application-ports.adapter.ts` | 无 |
| 4 | `server/index.ts` | 任务组 1/2/3 的全部独占文件 | 串行到任务组 2、3 完成后 |
| 5 | `src/components/chat/view/subcomponents/GitBranchChip.tsx`、`src/components/chat/hooks/useComposerGitStatus.ts` | `src/contexts/WebSocketContext.tsx`、`src/components/chat/view/subcomponents/ChatComposer.tsx`、`src/components/chat/view/ChatInterface.tsx`、`src/components/main-content/view/MainContent.tsx` | 无 |
| 6 | `src/components/chat/view/subcomponents/ChatComposer.tsx`、`src/components/chat/view/ChatInterface.tsx`、`src/components/chat/types/types.ts`、`src/components/main-content/view/MainContent.tsx` | `WebSocketContext.tsx`、任务组 5 独占文件 | 串行到任务组 5 完成后 |

- [x] 任意两个任务组的「独占文件」无交集（`server/index.ts` 仅属组 4；`ChatComposer`/`ChatInterface`/`MainContent`/types 仅属组 6）。
- [x] 共享文件已指定串行顺序（组 4 在组 2/3 后；组 6 在组 5 后）。

## 1. 共享契约（后端端口与事件类型）

- [x] 1.1 在 `server/shared/types.ts` 新增 `GitStatusEvent` 类型（字段：`kind:'git_status_changed'`、`projectId`、`branch`、`uncommittedCount`、`isDetached`、`isGitRepository`、`timestamp`，定义与 design「数据模型」表一致，含详细 doc 注释）
- [x] 1.2 在 `server/shared/interfaces.ts` 新增 `IGitStatusPublisher` 接口（方法 `publishGitStatusChanged(event: GitStatusEvent): void`），附 doc 注释说明为 git watcher 与传输层的解耦端口

## 2. git 模块后端服务

- [x] 2.1 新建 `server/modules/git/git-status.service.ts`：导出 `resolveGitStatusSnapshot(projectPath: string): Promise<GitStatusSnapshot>`，内部用 `cross-spawn` 调 `git symbolic-ref --short HEAD`（失败则 `git rev-parse --short HEAD` 取 7 位短哈希并置 `isDetached:true`）+ `git status --porcelain=v1 -z`，复用 `parseGitStatusOutput`（从 `./git-parsing.service.js`）求未提交计数（modified+added+deleted+untracked，不含 staged）；`isGitRepository` 在 git 命令整体失败时为 `false`；附子进程超时 5s
- [x] 2.2 新建 `server/modules/git/git-status-publisher.service.ts`：导出 `gitStatusPublisher` 单例代理（默认未配置抛错）+ `configureGitStatusPublisher(publisher)` 注入函数（返回 cleanup）+ `createInMemoryGitStatusPublisher()`（返回带 `events: GitStatusEvent[]` 的实现），结构与 `session-change-publisher.service.ts` 同构
- [x] 2.3 新建 `server/modules/git/git-status-watcher.service.ts`：导出 `initializeGitStatusWatcher()`（按 `projectsDb.getProjectPaths()` 为每工程建 chokidar watcher 监听 `<path>/.git/HEAD` 与 `<path>/.git/refs/heads/**`，`ignoreInitial:true`、`usePolling:false`）、`closeGitStatusWatcher()`、`refreshGitStatusWatchers()`（diff 当前工程列表与已建 watcher，增删条目）；单工程 500ms 防抖后调 `resolveGitStatusSnapshot` 并经 `gitStatusPublisher.publishGitStatusChanged` 广播；`.git` 删除/监听 error 时记 `console.error`、发一次 `isGitRepository:false`、移除条目
- [x] 2.4 在 `server/modules/git/index.ts` barrel 增补导出 `initializeGitStatusWatcher`、`closeGitStatusWatcher`、`refreshGitStatusWatchers`、`configureGitStatusPublisher`、`createInMemoryGitStatusPublisher`、`IGitStatusPublisher` 类型（re-export from shared）
- [x] 2.5 新建 `server/modules/git/tests/git-status.service.test.ts`：覆盖 S01/S02/S03/S04/S22（正常/干净/detached/非仓库/空仓库）+ S20（畸形 `.git/HEAD`）+ 计数口径（staged 不计入）
- [x] 2.6 新建 `server/modules/git/tests/git-status-publisher.service.test.ts`：覆盖默认未配置抛错、configure 注入后转发、cleanup 还原、in-memory 实现收集事件
- [x] 2.7 新建 `server/modules/git/tests/git-status-watcher.service.test.ts`：覆盖初始化建表、`.git/HEAD` 变化触发一次广播（S07）、防抖合并多次事件为一次计算+广播（S17/S18）、`.git` 删除发 `isGitRepository:false`（S15）、watcher error 不影响其他工程（S14）、git 子进程超时不崩（S13，用 in-memory publisher 断言无广播）

## 3. WebSocket 传输适配器

- [x] 3.1 新建 `server/modules/websocket/services/git-status-websocket-publisher.service.ts`：导出 `webSocketGitStatusPublisher`（实现 `IGitStatusPublisher`，`publishGitStatusChanged` 把事件 `JSON.stringify` 后遍历 `connectedClients`、仅对 `readyState===WS_OPEN_STATE` 的连接 `client.send`，非 OPEN 跳过不抛错）
- [x] 3.2 在 `server/modules/websocket/index.ts` barrel 增补导出 `webSocketGitStatusPublisher`
- [x] 3.3 新建 `server/modules/websocket/tests/git-status-websocket-publisher.service.test.ts`：覆盖广播到所有 OPEN 连接（S19）、跳过非 OPEN 连接、payload 为 `GitStatusEvent` 的 JSON（含 `kind`）

## 4. Server 装配根集成

- [x] 4.1 在 `server/index.ts` import 侧新增 `configureGitStatusPublisher`、`webSocketGitStatusPublisher`、`initializeGitStatusWatcher`、`closeGitStatusWatcher`、`refreshGitStatusWatchers`
- [x] 4.2 在 `server/index.ts` 既有 `configureSessionChangePublisher(...)`（行 121）旁调用 `configureGitStatusPublisher(webSocketGitStatusPublisher)`
- [x] 4.3 在 `server/index.ts` `initializeSessionsWatcher()`（行 372）之后调用 `await initializeGitStatusWatcher()`；在 `closeSessionsWatcher()`（行 380）之后调用 `await closeGitStatusWatcher()`
- [x] 4.4 在工程创建/归档流程调用 `refreshGitStatusWatchers()`（若当前工程创建不在 server 装配根，定位调用点并在其成功路径调用；找不到合适钩子则暂留 TODO 并在 design「风险」已声明的 REST 兜底覆盖）

## 5. 前端 hook 与 chip 组件

- [x] 5.1 新建 `src/components/chat/hooks/useComposerGitStatus.ts`：模块级 `Map<projectId, GitStatusSnapshot>` 缓存；`useComposerGitStatus(selectedProject)` hook 内用 `useWebSocket().subscribe` 订阅 `git_status_changed`（按 `event.projectId` 更新缓存并触发本地 state）；`selectedProject` 变化时若有缓存先回显、再 `authenticatedFetch('/api/git/status?project=<projectId>')` 校验（按 spec「多工程切换」与「兜底」）；WS 断连保留缓存（spec「WebSocket 断连」）；返回 `{branch, uncommittedCount, isDetached, isGitRepository} | null`
- [x] 5.2 新建 `src/components/chat/view/subcomponents/GitBranchChip.tsx`：props `{ gitStatus, onOpenGitPanel }`；`isGitRepository===false` 或无状态 → 返回 `null`（不占布局，S04/S16）；正常渲染 `⎇ <branch>` + 计数徽标（`uncommittedCount>0` 时显示，S02 不显）；`isDetached` 时灰色斜体显示短哈希（S03）；分支名超 140px 省略号截断（S06）；窄屏优先于清空按钮隐藏（S05，`hidden md:flex` 使其隐藏早于清空的 `hidden sm:flex`）；`onClick` → `onOpenGitPanel`，不展开浮层/不执行 git 操作（S12）；特殊字符纯文本渲染防注入（S21）
- [x] 5.3 为 chip 的 aria-label/title 补 i18n key（`src/i18n/locales/*/chat.json` 新增 `input.gitBranch` / `input.openGitPanel`，至少 en + zh-CN）

## 6. 前端接线（ChatComposer / ChatInterface / MainContent）

- [x] 6.1 在 `src/components/chat/types/types.ts` 的 `ChatInterfaceProps` 增加 `onOpenGitPanel: () => void`；在 `ChatComposerProps`（位于 `ChatComposer.tsx`）增加 `gitStatus` 与 `onOpenGitPanel` 两个 prop
- [x] 6.2 在 `src/components/chat/view/subcomponents/ChatComposer.tsx` 的 `<PromptInputTools>` 行（行 391 区域）插入 `<GitBranchChip gitStatus={gitStatus} onOpenGitPanel={onOpenGitPanel} />`，放在「清空输入」按钮之前
- [x] 6.3 在 `src/components/chat/view/ChatInterface.tsx` 调用 `useComposerGitStatus(selectedProject)`，把结果作为 `gitStatus` 连同 `onOpenGitPanel` 透传给 `<ChatComposer>`
- [x] 6.4 在 `src/components/main-content/view/MainContent.tsx` 给 `<ChatInterface>`（行 162）传入 `onOpenGitPanel={() => setActiveTab('git')}`
- [x] 6.5 验证：`npm run typecheck`、`npm run lint`、`npm test`、`npm run build` 均无新增失败；手测 chip 在正常/干净/detached/非仓库/窄屏的表现与点击跳转（对应 S01–S06、S12）

## 7. 验收与回归

- [x] 7.1 运行 `npm test`（server）确认组 2/3 的测试全绿
- [x] 7.2 运行 `npm run typecheck` + `npm run lint` + `npm run build` 全绿
- [x] 7.3 对照 test-definition.md 的 22 个样本逐项核对（至少正常路径 6/6、高风险 3/3、对抗 2/2 全通过），留存逐样本记录
- [x] 7.4 确认上线门禁全部满足（不监听工作区文件有显式断言、计数口径测试通过、逐样本记录留存）
