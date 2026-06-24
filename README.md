# opencode-dashboard

OpenCode 的常驻 Web 控制面。浏览多个 OpenCode session、点击进入内嵌 web terminal
控制其中任意一个；同时保留原有的 experience report 审核/确认能力。

## 技术栈

- **Hono** — 轻量 Web 框架
- **@hono/node-server** — Node.js 适配器（HTTP + WebSocket）
- **hono/jsx** — 服务端 JSX 渲染（无需 React 构建链）
- **tsx** — 直接运行 TypeScript
- **ws** — WebSocket 服务端，配合 `@hono/node-server` 的 `upgradeWebSocket`
- **node-pty** — 本地伪终端，承载 `opencode --session <id>` 子进程
- **@xterm/xterm + @xterm/addon-fit** — 浏览器内嵌终端 UI

## 快速开始

```bash
cd ~/GitHub/opencode-dashboard
npm install
npm start
# → OpenCode Dashboard running at http://localhost:7331
```

开发模式（文件变更自动重启）：

```bash
npm run dev
```

类型检查（不需要启动服务）：

```bash
npm run typecheck
```

后台常驻（Linux + systemd user service）：

```bash
./scripts/install-systemd.sh
# → 安装并启动 opencode-dashboard.service
# → 默认端口 7331；PORT=8080 ./scripts/install-systemd.sh 可改
```

详细部署 / 升级 / 卸载 / 排障流程见 [`docs/DEPLOYMENT.md`](./docs/DEPLOYMENT.md)。

## 页面

| 路径 | 说明 |
| --- | --- |
| `/` | **Sessions** 仪表盘（默认落地页）。状态条 + session 列表 + 嵌入终端入口。 |
| `/session?id=<ses_...>` | 选中单个 session 的详情页，内嵌 xterm 终端直连 `opencode --session <id>`。 |
| `/projects` | 需求管理页面（从 Hermes `~/.agents/req/` 读取需求数据，按项目分组展示）。 |
| `/requirement?id=<req_...>` | 需求详情页（只读展示 Hermes 管理的需求元数据 + 关联 session）。 |
| `/reports` | Experience report 列表（原 `/` 路径平移到这里）。 |
| `/report?path=...` | 单个 report 详情与 candidate 勾选/确认。 |
| `/sessions/refresh` | 强制刷新 session 缓存后重新渲染列表。 |
| `/api/sessions` `/api/session?id=...` | JSON API |
| `/api/reports` `/api/report?path=...` `/api/confirm` | 原有 report API |
| `/api/experience/mark` `/api/experience/unmark` `/api/experience/markers` | Session 标记 API（配合 skill 自动总结） |
| `/ws/session-terminal?id=<ses_...>` | 嵌入终端的 WebSocket 端点 |

### Sessions 仪表盘（Operator 风格）

- 顶部 thin console 顶栏 + 4 列 flow 条（`BACKLOG / RUNNING / REPAIR / READY`），数字来自 `summarizeSessions`。
- 每条 session 一条 Operator lane：cyan rail、issue/run 标签、`Agent Run` 标题、`OpenCode {agent} thread is active.` 副标题、token 统计条、`CODEX THREAD / WORKTREE / MODEL / NEXT RETRY` 等 8 项详情网格。
- 点击 lane 跳转到 `/session?id=<id>` 打开内嵌终端；`/session` 详情页同时展示 agent、model、worktree 元数据。
- 数据来源在 header 右上角显示（`SQLITE / CLI / FS`）；横向滚动只在 ≥1080px 出现并被 2 列布局自动消除。

### 内嵌终端（核心点击流）

- 服务端：`src/terminal.ts` 用 `node-pty` 启动 `opencode --session <id>`；
  `src/server.tsx` 的 `/ws/session-terminal` 用 `@hono/node-server` 的
  `upgradeWebSocket` 桥接 PTY stdin/stdout。
- 客户端：`public/terminal.js` 动态加载 `/vendor/xterm/*` 与 `/vendor/xterm-addon-fit/*`，
  通过 `WebSocket` 双向通信，支持输入、resize、退出提示、错误回显。
- xterm 资源通过 `app.get("/vendor/xterm/*")` 直接从 `node_modules` 读取，不复制到仓库。

### OpenCode 官方 web/serve/attach 提示

详情页底部提供 `opencode web`、`opencode serve --port 4096`、
`opencode attach http://localhost:4096 --session <id>` 命令提示，
但**主点击流仍是内嵌终端**。

## 数据源与会话解析

- `src/sessions.ts` 优先调用 `sqlite3 -json ~/.local/share/opencode/opencode.db "<query>"` 读取 `session` 表的元数据。
  - SQL 选列：`id, project_id, directory, path, title, time_created, time_updated, agent, model, cost, tokens_*`，按 `time_updated desc` 取最近 `MAX_SESSIONS` 行。
  - `model` 列是 JSON 字符串 (`{"id":..., "providerID":..., "variant":...}`)，由 `parseModelString` 安全解析；解析失败时保留原文。
  - `worktree` 由 `deriveWorktree` 派生：`directory` 在 `$HOME` 内则渲染为 `~/<relative>`，否则保留绝对路径；缺失字段时回落到 `~/path`，都没有则显示 `none`。
- SQLite 不可用时回退到 `opencode session list --format json --max-count 50`。
- CLI 也失败时回退到 `~/.local/share/opencode/storage/session_diff/*.json` 文件名 + mtime（无 model/worktree 元数据，`source: "fs"`）。
- 不会读取任何 `.env`、`.env.*`、`opencode.env`、凭证文件或私钥。
- session id 强制走 `^ses_[A-Za-z0-9]+$` 正则才会被允许进入下一步。
- `resolveCwd` 拒绝含 `..` 的路径并校验目录存在。

## Operator Sessions 页面

`/` 重新设计为 Operator 风格：

- 顶部 thin console 顶栏：`OpenCode Operator | SNAPSHOT READY` + `SYSTEM LIGHT DARK REFRESH` 状态行；下接 `/sessions /requirements /reports` 路由行。
- 顶部 flow 条：4 列 `BACKLOG / RUNNING / REPAIR / READY`（实际取 `stale / running / idle / total`），来自 `summarizeSessions`。
- `RUNNING LANES` 段：每条 session 是一个 Operator lane，依次展示
  `ISSUE / RUN-LANE-NNN` → `Agent Run` → `OpenCode {agent} thread is active.` → 状态短语 → token 统计条 →
  `CODEX THREAD / THREAD FLAGS / PROTOCOL EVENT / BRANCH / WORKTREE / BACKLOG OWNERSHIP / MODEL / NEXT RETRY` 详情网格。
- 工作区在 1080px 及以下自动折叠为 2 列，避免横向滚动。
- `/api/sessions` 与 `/api/session` 返回的 JSON 携带 `source: "db" | "cli" | "fs"` 和 SQLite 字段（`agent`, `modelId`, `modelProvider`, `modelVariant`, `worktree`, `tokensInput`, ...）。

## 体验报告功能

- 扫描 `/tmp/opencode/handoff/` 下的报告（`report.md` / `<sid>.report.md`）。
- 报告列表页：显示 session、日期、候选统计。
- 报告详情页：候选卡片，支持勾选。
- 确认/驳回：`POST /api/confirm`，结果写入 `/tmp/opencode/handoff/confirmations/`。

### Session 标记与自动总结

用户在 OpenCode 中通过 `opencode-session-summary-mark` skill 标记有总结价值的 session 后，dashboard 后台自动完成：

1. **等待空闲**：被标记 session 进入 idle 状态 ≥1 小时后触发。
2. **Fork 总结**：自动 `opencode run --session <id> --fork` 生成经验报告，写入 `/tmp/opencode/handoff/auto-summary/<sid>/report.md`。
3. **通知**：报告生成后在 dashboard 通知中心（🔔）弹出一键查看入口。
4. **审阅确认**：用户在 `/reports` → `/report?path=...` 页面勾选候选。
5. **自动执行**：确认后 dashboard 自动 fork session 执行选中的候选（写知识库、更新 skill 等），进度通过通知中心推送。

标记存储：`~/.local/share/opencode-dashboard/experience-markers.json`（7 天 TTL，活跃状态不淘汰）。

API：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `POST` | `/api/experience/mark` | 标记 session（`{sessionId, note?}`） |
| `POST` | `/api/experience/unmark` | 取消标记（`{sessionId}`） |
| `GET` | `/api/experience/markers` | 列出所有标记及状态（`?status=<status>` 可选） |

## Session 标记与自动经验总结

用户可以通过 `opencode-session-summary-mark` skill 标记当前 session 为"待总结"。Dashboard 后台 worker 会：

1. 每 5 分钟轮询标记队列（7 天窗口内、状态为 `marked` 的 session）。
2. 检测到 session 空闲 ≥1 小时后，自动 `opencode run --session <id> --fork` 生成经验报告。
3. 报告写入 `/tmp/opencode/handoff/auto-summary/<sid>/report.md`，可在 `/reports` 页面查看。
4. 用户在 `/report` 页面确认候选后，`POST /api/confirm` 自动检测关联 marker 并触发执行 fork，在副本 session 中执行确认的候选项。
5. 全程通过 dashboard 通知中心（🔔）推送进度。

标记 API：

| 路由 | 方法 | 说明 |
| --- | --- | --- |
| `/api/experience/mark` | POST | 标记 session，body: `{"sessionId":"ses_...","note":"..."}` |
| `/api/experience/unmark` | POST | 取消标记，body: `{"sessionId":"ses_..."}` |
| `/api/experience/markers` | GET | 列出所有标记及状态 |

标记存储：`~/.local/share/opencode-dashboard/experience-markers.json`

## Session 标记与自动经验总结

用户可以通过 OpenCode skill `opencode-session-summary-mark` 标记当前 session 为"待总结"，dashboard 后台会自动完成总结流程：

1. **标记**：skill 调用 `POST /api/experience/mark` 写入标记到 `~/.local/share/opencode-dashboard/experience-markers.json`。
2. **等待空闲**：后台 worker 每 5 分钟轮询，检测标记 session 空闲 ≥1 小时后触发总结。
3. **Fork 总结**：执行 `opencode run --session <id> --fork` 生成经验报告，写入 `/tmp/opencode/handoff/auto-summary/<sid>/report.md`。
4. **审阅**：用户在 `/reports` 或 `/report?path=...` 页面查看候选，勾选确认。
5. **Fork 执行**：确认后 `POST /api/confirm` 自动触发第二个 fork，执行确认的候选项。
6. **通知**：每个状态转换通过 dashboard 通知中心（🔔）推送给用户。

标记状态流转：`marked → summarizing → summarized → confirming → executed`（失败可重标记）。

## Session 标记与自动经验总结

用户可以通过 `opencode-session-summary-mark` skill 标记当前 session 为"待总结"，dashboard 后台会自动完成 fork 总结 → 报告审阅 → 确认执行的完整闭环。

### 流程

1. **标记**：用户在 OpenCode 中说"标记这个 session" → skill 调用 `POST /api/experience/mark`。
2. **自动 fork 总结**：dashboard 后台 worker 每 5 分钟轮询标记队列，当 session 空闲 ≥1 小时后自动 `opencode run --session <id> --fork` 生成经验报告。
3. **审阅**：报告写入 `/tmp/opencode/handoff/auto-summary/<sid>/report.md`，在 `/reports` 页面可见，通知中心🔔推送完成提示。
4. **确认执行**：用户在 `/report` 页面勾选候选并确认 → `POST /api/confirm` 自动检测关联 marker → 触发第二个 fork 执行确认候选。
5. **状态追踪**：`GET /api/experience/markers` 返回所有标记及其状态（marked → summarizing → summarized → confirming → executed）。

### API

| 路由 | 方法 | 说明 |
| --- | --- | --- |
| `/api/experience/mark` | POST | 标记 session，body: `{"sessionId":"ses_...","note":"..."}` |
| `/api/experience/unmark` | POST | 取消标记，body: `{"sessionId":"ses_..."}` |
| `/api/experience/markers` | GET | 列出所有标记，可选 `?status=summarized` 过滤 |
| `/api/confirm` | POST | 确认候选（扩展：自动触发关联 marker 的执行 fork） |

### 标记存储

标记持久化在 `~/.local/share/opencode-dashboard/experience-markers.json`，7 天 TTL（`summarizing`/`confirming` 状态豁免）。

## Session 标记与自动经验总结

用户可以在任意 OpenCode 会话中使用 `opencode-session-summary-mark` skill 标记当前 session 为"待总结"。Dashboard 后台 worker 会：

1. **检测**：每 5 分钟轮询标记队列，检查 7 天内被标记且未处理的 session。
2. **触发**：当 session 空闲 ≥1 小时后，自动 fork 该 session 并让 agent 生成经验报告。
3. **通知**：报告生成后在 dashboard 通知中心（🔔）推送，用户点击进入 `/report?path=...` 审阅候选。
4. **执行**：用户在 report 页面勾选确认候选后，`POST /api/confirm` 自动检测关联的 marker 并触发第二个 fork session 执行确认的候选。

标记状态流转：`marked → summarizing → summarized → confirming → executed`（任何阶段可 `→ failed`）。

| API | 方法 | 说明 |
| --- | --- | --- |
| `/api/experience/mark` | POST | 标记 session，body: `{"sessionId":"ses_...","note":"..."}` |
| `/api/experience/unmark` | POST | 取消标记，body: `{"sessionId":"ses_..."}` |
| `/api/experience/markers` | GET | 列出所有标记及状态，可选 `?status=marked` |

标记数据持久化在 `~/.local/share/opencode-dashboard/experience-markers.json`。

## Session 标记与自动经验总结

用户可以在任意 OpenCode 会话中使用 `opencode-session-summary-mark` skill 标记当前 session 为"待总结"。Dashboard 后台 worker 会：

1. **轮询标记队列**（每 5 分钟），检查 7 天窗口内 status=`marked` 的 session。
2. **等待空闲**：session 最后活动时间 ≥1 小时后，自动 fork 并生成经验报告。
3. **通知用户**：报告生成后通过 dashboard 通知中心（🔔）推送，点击跳转 `/report?path=...`。
4. **采纳执行**：用户在 `/report` 页面勾选候选并确认后，`POST /api/confirm` 自动检测关联的 marker，触发第二个 fork session 执行确认的候选项。

状态流转：`marked → summarizing → summarized → confirming → executed`（任一步可 `→ failed`）。

标记存储：`~/.local/share/opencode-dashboard/experience-markers.json`（7 天 TTL，活跃状态豁免）。

API：

| 路由 | 方法 | 说明 |
| --- | --- | --- |
| `/api/experience/mark` | POST | 标记 session（body: `{sessionId, note?}`） |
| `/api/experience/unmark` | POST | 取消标记（body: `{sessionId}`） |
| `/api/experience/markers` | GET | 列出所有标记及状态（`?status=<status>` 过滤） |

## Session 标记与自动经验总结

用户在 OpenCode 会话中通过 `opencode-session-summary-mark` skill 标记有价值的 session 后，dashboard 后台自动完成总结全流程：

1. **标记**：skill 调用 `POST /api/experience/mark` 写入标记（持久化到 `~/.local/share/opencode-dashboard/experience-markers.json`）。
2. **等待空闲**：后台 worker 每 5 分钟轮询，检测到标记 session 空闲 ≥1 小时后触发。
3. **Fork 总结**：`opencode run --session <id> --fork` 生成经验报告，写入 `/tmp/opencode/handoff/auto-summary/<sid>/report.md`。
4. **审阅**：报告出现在 `/reports` 页面，用户勾选确认候选。
5. **Fork 执行**：`POST /api/confirm` 检测到关联标记后，自动 fork 执行确认的候选。
6. **通知**：每个状态转换通过通知中心（🔔）推送给用户。

标记状态机：`marked → summarizing → summarized → confirming → executed`（任一步可 `→ failed`）。

## Session 标记与自动经验总结

用户可以通过 `opencode-session-summary-mark` skill 或直接调用 API 标记一个 session 为"待经验总结"：

```bash
# 标记 session
curl -X POST http://localhost:7331/api/experience/mark \
  -H "Content-Type: application/json" \
  -d '{"sessionId": "ses_xxx", "note": "MQ 幂等问题排查"}'

# 查看所有标记
curl http://localhost:7331/api/experience/markers

# 取消标记
curl -X POST http://localhost:7331/api/experience/unmark \
  -H "Content-Type: application/json" \
  -d '{"sessionId": "ses_xxx"}'
```

标记后的自动流程：

1. **等待空闲**：后台 worker（每 5 分钟轮询）检测到被标记 session 空闲 ≥1 小时后触发总结。
2. **Fork 总结**：自动 fork session，让 agent 按经验总结格式生成报告，写入 `/tmp/opencode/handoff/auto-summary/<sid>/report.md`。
3. **用户审阅**：报告出现在 `/reports` 页面，用户勾选要采纳的候选。
4. **确认执行**：点击 Confirm 后，`/api/confirm` 检测到关联的 marker，自动 fork session 执行确认的候选项。
5. **通知推送**：每个阶段（总结中/完成/执行中/完成/失败）都通过 dashboard 通知中心（🔔）推送状态。

标记状态流转：`marked → summarizing → summarized → confirming → executed`（任何阶段失败进入 `failed`）。

## Session 标记与自动经验总结

用户可以在任意 OpenCode 会话中说"标记这个 session"或"标记总结"，触发 `opencode-session-summary-mark` skill 调用 `POST /api/experience/mark`，把当前 session 写入 dashboard 的标记队列。

Dashboard 后台 worker 每 5 分钟轮询标记队列：

1. **7 天窗口**：标记超过 7 天未完成的 marker 自动标记为 `expired`。
2. **空闲 1 小时**：被标记 session 的 `time_updated` 距今 ≥1 小时时，自动 fork 该 session 并让 agent 生成经验报告（写入 `/tmp/opencode/handoff/auto-summary/<sid>/report.md`）。
3. **报告审阅**：报告生成后出现在 `/reports` 列表页，用户在 `/report?path=...` 页面查看候选、勾选确认。
4. **采纳执行**：用户点击 "Confirm Selected" 后，`POST /api/confirm` 检测到报告有关联的 marker，自动 fork 原 session 执行确认的候选（调用 writer/maintainer skill）。
5. **通知**：fork 进度的 starting/done/failed 状态通过 dashboard 通知中心（🔔）推送。

Marker 状态机：`marked → summarizing → summarized → confirming → executed`（任一步可 `→ failed`）。

API 路由：

| 路由 | 方法 | 说明 |
| --- | --- | --- |
| `/api/experience/mark` | POST | 标记 session，body: `{"sessionId": "...", "note": "..."}` |
| `/api/experience/unmark` | POST | 取消标记，body: `{"sessionId": "..."}` |
| `/api/experience/markers` | GET | 列出所有标记及状态，支持 `?status=marked` 过滤 |

## Session 标记与自动经验总结

用户在 OpenCode 中通过 `opencode-session-summary-mark` skill 标记有价值的 session 后，dashboard 后台自动完成"fork → 生成报告 → 审阅 → 确认 → 执行"闭环：

1. **标记**：skill 调用 `POST /api/experience/mark`，session 进入 `marked` 状态。
2. **自动 fork**：后台 worker 每 5 分钟轮询；session 空闲 ≥1 小时后自动 fork 生成经验报告（`summarizing` → `summarized`）。
3. **审阅**：报告出现在 `/reports` 页面，用户勾选候选。
4. **确认执行**：`POST /api/confirm` 检测到关联 marker 后，自动 fork 执行确认的候选（`confirming` → `executed`）。
5. **通知**：每个状态转换都推送 dashboard 通知中心（🔔）。

标记存储在 `~/.local/share/opencode-dashboard/experience-markers.json`，7 天后未完成的标记自动过期。

## Session 标记与自动经验总结

用户可以通过 OpenCode skill（`opencode-session-summary-mark`）标记当前 session 为"待总结"。Dashboard 后台 worker 会自动处理：

1. **标记**：skill 调用 `POST /api/experience/mark` 把 session ID 写入 `~/.local/share/opencode-dashboard/experience-markers.json`。
2. **等待空闲**：后台 worker 每 5 分钟轮询标记队列，检测到 session 空闲 ≥1 小时后触发 fork。
3. **Fork 总结**：`opencode run --session <id> --fork` 生成经验报告，写入 `/tmp/opencode/handoff/auto-summary/<sid>/report.md`。
4. **审阅**：报告出现在 `/reports` 列表，用户在 `/report?path=...` 页面查看候选并勾选。
5. **采纳执行**：用户点击「Confirm Selected」后，`POST /api/confirm` 检测到关联 marker，自动 fork session 执行确认的候选项。
6. **通知**：fork 进度（开始/完成/失败）通过 dashboard 通知中心（🔔）推送。

标记状态流转：`marked → summarizing → summarized → confirming → executed`（任一步可 → `failed`）。

## Session 标记与自动经验总结

用户在任意 OpenCode 会话中通过 `opencode-session-summary-mark` skill 标记当前 session 后，dashboard 后台自动完成以下流程：

1. **标记**：`POST /api/experience/mark` 写入标记（`~/.local/share/opencode-dashboard/experience-markers.json`）。
2. **等待空闲**：后台 worker 每 5 分钟轮询，检测到 session 空闲 ≥1 小时后触发总结。
3. **Fork 总结**：`opencode run --session <id> --fork` 生成经验报告，写入 `/tmp/opencode/handoff/auto-summary/<sid>/report.md`。
4. **审阅**：报告出现在 `/reports` 页面，用户勾选候选。
5. **确认执行**：`POST /api/confirm` 检测到关联 marker 后自动 fork 执行确认候选，执行 fork 继承用户全局权限规则。
6. **通知**：整个流程的每个状态转换都通过 dashboard 通知中心（🔔）推送。

标记状态：`marked → summarizing → summarized → confirming → executed`（任何阶段可 `→ failed`）。7 天未完成自动过期。

## Session 标记与自动经验总结

用户在 OpenCode 会话中使用 `opencode-session-summary-mark` skill 标记当前 session 后，dashboard 后台自动完成以下流程：

1. **标记**：skill 调用 `POST /api/experience/mark` 写入标记队列。
2. **等待空闲**：后台 worker 每 5 分钟轮询，检测 session 空闲 ≥1 小时后触发总结。
3. **Fork 总结**：`opencode run --session <id> --fork` 生成经验报告，写入 `/tmp/opencode/handoff/auto-summary/<sid>/report.md`。
4. **审阅**：用户在 `/reports` 页面查看候选，勾选确认。
5. **Fork 执行**：`POST /api/confirm` 检测到关联 marker 后，自动 fork session 执行确认的候选。

标记状态存储在 `~/.local/share/opencode-dashboard/experience-markers.json`，7 天后自动过期。

## Session 标记与自动经验总结

用户在 OpenCode 会话中觉得某个 session 有总结价值时，可以通过 `opencode-session-summary-mark` skill 标记该 session。Dashboard 后台 worker 会自动处理后续流程：

1. **标记**：skill 调用 `POST /api/experience/mark` 把 session ID 写入标记队列（`~/.local/share/opencode-dashboard/experience-markers.json`）。
2. **等待空闲**：后台 worker 每 5 分钟轮询标记队列，检测到 session 空闲 ≥1 小时后触发总结。
3. **Fork 总结**：自动执行 `opencode run --session <id> --fork` 生成经验报告，写入 `/tmp/opencode/handoff/auto-summary/<sid>/report.md`。
4. **审阅**：报告出现在 `/reports` 页面，用户勾选确认候选。
5. **Fork 执行**：用户点击确认后，`POST /api/confirm` 自动检测关联标记并触发第二个 fork 执行确认的候选项。
6. **通知**：每个状态转换（开始总结/完成/失败/开始执行/执行完成）都通过通知中心（🔔）推送给用户。

标记队列有 7 天 TTL：超过 7 天未完成的标记自动过期。

## Session 标记与自动经验总结

用户在 OpenCode 中使用 `opencode-session-summary-mark` skill 标记有价值的 session 后，dashboard 后台自动完成以下流程：

1. **标记**：skill 调用 `POST /api/experience/mark` 写入标记到 `~/.local/share/opencode-dashboard/experience-markers.json`。
2. **等待空闲**：后台 worker 每 5 分钟轮询，检测标记 session 是否空闲 ≥1 小时。
3. **Fork 总结**：空闲达标后自动 `opencode run --session <id> --fork` 生成经验报告，写入 `/tmp/opencode/handoff/auto-summary/<sid>/report.md`。
4. **审阅**：报告出现在 `/reports` 页面，用户勾选确认候选。
5. **Fork 执行**：`POST /api/confirm` 检测到关联 marker 后自动触发执行 fork，让 agent 执行确认的候选项。

标记状态流转：`marked → summarizing → summarized → confirming → executed`（任一阶段可 `failed`）。7 天未完成自动过期。

## 目录结构

```
src/
  server.tsx              — Hono 路由、JSX 页面、WS upgrade
  sessions.ts             — SQLite → CLI → fs 三级 session 扫描、id 校验、cwd 解析
  paths.ts                — 报告路径解析（src/paths.ts，安全边界）
  terminal.ts             — node-pty 包装、消息分发
  terminalProtocol.ts     — 纯函数 WS 帧解析（无原生依赖）
  parser.ts               — experience report 解析（原有）
  scanner.ts              — experience report 扫描（原有）
  experienceMarkers.ts    — session 标记持久化存储（mark/unmark/list/TTL）
  experienceAutoSummary.ts — 后台 worker（空闲检测 → fork 总结 → 执行）
tests/
  paths.test.ts           — 报告路径解析回归测试
  sessions.test.ts        — parseModelString / deriveWorktree 单元测试
  terminal.test.ts        — WS 帧解析回归测试
  experienceMarkers.test.ts — 标记存储 CRUD + TTL 测试
  experienceAutoSummary.test.ts — fork 总结/执行全链路测试
public/
  app.js                  — 报告页 confirm 交互（page-scoped）
  terminal.js             — 内嵌终端客户端（page-scoped）
  style.css               — Operator 暗色 / 终端风格
node_modules/@xterm/      — 通过 /vendor/* 路由直接服务
```

## 验证

```bash
npm test            # 跑 tests/*.test.ts (node --test + tsx)
npm run typecheck   # tsc --noEmit，覆盖 src 与 tests
npm start
# 打开 http://localhost:7331
# 点击任意 session 卡片 → 看到内嵌终端 → 看到 opencode TUI
```

## 安全约束

- 不读取任何 `.env*`、`credentials.json`、`secrets.json`、私钥文件。
- 不允许把 `..` 拼进 session 路径或工作目录。
- vendor 路由与 static 路由都强制拒绝包含 `..` 的相对路径。
- session id 严格匹配 `^ses_[A-Za-z0-9]+$`，spawn 前再校验一次。
- report 路径 (`/report`、`/api/confirm`、`/api/report`) 必须先经 `resolve()` 规范化，再做 `/tmp/opencode/handoff/` 严格前缀边界校验（带尾部 `/`），防止 `..` 逃逸和兄弟目录绕过。

## 继续开发 / AI handoff

如果你是 AI 或新加入的开发者，请按以下顺序读：

1. [`AGENTS.md`](./AGENTS.md) — 项目级规则、安全约束、验证清单、Personal
   Project Hooks 托管区块。**先读这个再动手。**
2. [`docs/AI_DEVELOPMENT.md`](./docs/AI_DEVELOPMENT.md) — 长篇交接文档，
   包含数据源细节、UI 设计规范、内嵌终端协议、测试与浏览器-harness
   验证流程、常见排障。
3. 本 README — 用户视角的功能/路由/目录结构导览。

本 README 保持一页篇幅；详细设计、数据源解析和验证流程都放在
`AGENTS.md` 和 `docs/AI_DEVELOPMENT.md` 里。
