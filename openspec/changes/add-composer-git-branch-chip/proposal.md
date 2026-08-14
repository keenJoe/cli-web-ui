## Why

用户在对话框（ChatComposer）里和 AI 对话时，无法一眼看到当前工程处于哪个 git 分支、有多少未提交更改。这容易导致"在错的分支上发了消息"或"带着脏工作区让 AI 误操作"。GitPanel 虽有完整 git 能力，但它是一个独立标签页，切走即卸载，用户在对话框内没有轻量的实时入口。

## What Changes

- 新增后端 git 状态监听服务：监听每个工程的 `.git/HEAD` 与 `.git/refs/heads` 变化，计算分支名与未提交摘要，通过现有 WebSocket 连接推送 `git_status_changed` 事件。覆盖用户在外部终端/编辑器切分支的场景。
- 新增前端 git 状态 store：接收 WS 推送，首次进入时用 `GET /api/git/status` 兜底。
- 新增 `GitBranchChip` 组件：在 ChatComposer footer 工具行显示 `⎇ <分支名> ·<未提交计数>` 胶囊标签，点击跳转到 GitPanel 标签页。chip 仅作入口，不执行 checkout、不展开文件列表。
- 复用现有 `/api/git/status` 端点，不新增 REST 路由。

## Capabilities

### New Capabilities
- `composer-git-status`: 对话框内显示当前工程的 git 分支与未提交摘要，并在分支或未提交状态变化时实时更新；点击跳转 GitPanel。

### Modified Capabilities
<!-- 无。openspec/specs/ 当前为空，本次为首个能力。 -->

## Impact

- **后端**：新增 `server/modules/git/` 下的 git 状态监听服务（仿 `sessions-watcher.service.ts` 用 chokidar）；`websocket-server` 增加 git 事件广播能力。`server/index.ts` 启动/关闭时管理 watcher 生命周期。`sessions-watcher` 显式 ignore `.git/**`，故本 watcher 独立，不复用。
- **前端**：新增 git 状态 store 与 `GitBranchChip` 组件；`WebSocketContext` 的 dispatch 增加 `git_status_changed` 分支；`ChatComposer` 加 prop 并在 footer 插入 chip；`ChatInterface`/`MainContent` 接 `onOpenGitPanel` 切 `activeTab='git'`。
- **依赖**：无新依赖（chokidar 已是项目依赖）。
- **现有功能**：`useGitPanelController` 不改动，继续在 git 标签页独立工作；chip 与它的数据来源不同（chip 走 WS 推送，GitPanel 走自己的 REST 拉取），两者短暂不一致可接受。
