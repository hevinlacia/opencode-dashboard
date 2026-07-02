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
| `/` | **Projects / Requirements** 需求管理默认页（从 Hermes `~/.agents/req/` 读取需求数据）。 |
| `/sessions` | **Sessions** 仪表盘。状态条 + session 列表 + 嵌入终端入口。 |
| `/session?id=<ses_...>` | 选中单个 session 的详情页，内嵌 xterm 终端直连 `opencode --session <id>`。 |
| `/projects` | 需求管理页面（从 Hermes `~/.agents/req/` 读取需求数据，按项目分组展示）。 |
| `/requirement?id=<req_...>` | 需求详情页（展示需求记忆、上线包、测试链路、Review、关联 session）。 |
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

### 需求生命周期记忆

- 需求目录来自 Hermes `~/.agents/req/<project>/.../<req-id>/`，dashboard 只维护 session 关联和状态写入。
- `memory.md` 是新建 session 的首要记忆入口：记录当前目标、当前进展、关键决策、已完成改动、待办/风险、影响范围和各 session 摘要索引。
- `branch.md` 和 `config-changes.md` 构成上线包：应用/仓库/分支/PR/Commit、DB 变更、Apollo/Nacos、RocketMQ Topic/Group、阿里云控制台配置等。
- `test.md` 维护 PRD/需求测试用例、自测记录和可复用验证链路，方便 test 自测后在 UAT/上线前复验。
- `review.md` 维护待上线 Code Review 范围、发现项、用户确认和复查结论。
- 「智能提取」会读取 `memory.md / branch.md / config-changes.md / test.md / notes.md / review.md` 并生成可预览的文件变更建议；人工确认后才写入发布事实文件。定时触发只在每天本地 00:00 执行一次，并且只检查最近 24 小时内创建或更新过的需求 session。
- 「召回历史」会从本机 OpenCode SQLite 只读读取指定 session 的 text part，过滤 reasoning/tool/step，用于在需求信息不明确时追溯原始对话证据。

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

`/sessions` 使用 Operator 风格：

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

### 自动同步

- dashboard 启动后会保留唯一的自动同步机制：每天本地 20:30 运行一次 `opencode-cron-sync.sh --full`。
- 旧的 systemd `opencode-sync-dirty.timer` / `opencode-sync-full.timer` 已改为远未来时间，不再负责高频自动同步。
- `opencode-sync-reminder` 插件只负责记录 dirty paths 和失败提示，不再承诺在 `session.idle` 时自动同步。

### OpenCode 进程队列

- dashboard 启动的非交互 OpenCode 任务（智能提取、经验总结、确认候选执行、新建需求 session）统一进入全局队列。
- 同一时间最多允许 6 个 dashboard-owned OpenCode 子进程活跃；超过上限的任务等待前面的任务结束后再启动。
- 每个 dashboard-owned OpenCode 子进程最长活跃 1 小时，超时后会被强制终止并释放队列槽位。
- 同一需求的自动智能提取仍保留 5 分钟间隔队列，避免多个历史 session 同时写同一组需求文件。

### Session 标记与自动总结

用户在 OpenCode 中通过 `opencode-session-summary-mark` skill 标记有总结价值的 session 后，dashboard 后台自动完成：

1. **每日检查**：每天本地 01:00 检查最近 24 小时内创建或更新过、且空闲 ≥1 小时的已标记 session。
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
