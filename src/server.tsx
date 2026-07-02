/** @jsxImportSource hono/jsx */
import { Hono, type Context } from "hono"
import { sessionsDaysPath, SESSIONS_PATH } from "./navigation.ts"
import { type FC } from "hono/jsx"
import { serve } from "@hono/node-server"
import { upgradeWebSocket } from "@hono/node-server"
import { WebSocketServer } from "ws"
import { readFile, writeFile, appendFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { spawn } from "node:child_process"
import { join, dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { scanReports, getReport, saveConfirmation, getConfirmationStatus, type Confirmation, type ConfirmationStatus } from "./scanner.ts"
import type { Candidate, ParsedReport } from "./parser.ts"
import {
  scanSessions,
  getSession,
  summarizeSessions,
  groupSessionsByParent,
  isValidSessionId,
  clearSessionCache,
  type SessionInfo,
} from "./sessions.ts"
import {
  startSession,
  writeToSession,
  resizeSession,
  killSession,
  parseClientMessage,
  type TerminalSession,
} from "./terminal.ts"
import { resolveHandoffPath } from "./paths.ts"
import { shouldAutoInjectRequirementContext } from "./terminalUrl.ts"
import { writeRequirementStatus, nextStatus, readRequirementState, type RequirementState } from "./requirementState.ts"
import {
  REQ_STATUSES,
  type ReqStatus,
  type Requirement,
  listRequirementsByProject,
  getRequirement,
  associateSession,
  dissociateSession,
  replaceAssociatedSession,
  getRequirementForSession,
  getAllAssociatedSessionIds,
  buildInjectionContext,
  scanHermesRequirements,
  loadAssociations,
  DEFAULT_REQ_ID,
  DEFAULT_PROJECT_NAME,
} from "./requirements.ts"
import {
  buildExtractPrompt,
  appendSummaryToNotes,
} from "./sessionExtract.ts"
import {
  createExtractJob,
  getExtractJob,
  findRunningJobForSession,
  findRecentJobForSession,
  checkExtractGuard,
  EXTRACT_DEBOUNCE_MS,
  JobConflictError,
  type ExtractJob,
} from "./extractJobs.ts"
import { enqueueAutoExtract, getQueueStatus } from "./extractQueue.ts"
import {
  initNotifications,
  getNotifications,
  getNotification,
  getUnreadCount,
  dismissNotification,
  dismissAll,
  markAllRead,
} from "./notifications.ts"
import {
  getConfig,
  setConfig,
  initConfig,
  type AppConfig,
} from "./config.ts"
import {
  buildReleaseChecklist,
  type ReleaseChecklist,
  type ChecklistFiles,
} from "./releaseChecklist.ts"
import {
  buildAutoExtractPrompt,
  parseAutoExtractOutput,
  filterAllowed,
  type AutoExtractResult,
  type ContextFiles,
} from "./autoExtract.ts"
import {
  FORK_TITLE_RE,
  recommendSessionsForRequirement,
  type SessionRecommendation,
} from "./sessionRecommendations.ts"
import {
  getExtractHistoryForRequirement,
  getLastExtractForSession,
  type ExtractHistoryRecord,
} from "./extractHistory.ts"
import {
  initMarkers,
  markSession,
  unmarkSession,
  getMarker,
  listMarkers,
  type ExperienceMarker,
  type MarkerStatus,
} from "./experienceMarkers.ts"
import {
  startAutoSummaryWorker,
  triggerExecutionForMarker,
  isAutoSummaryWorkerRunning,
} from "./experienceAutoSummary.ts"
import {
  startAutoExtractScheduler,
  isAutoExtractSchedulerRunning,
  POLL_INTERVAL_MS as AUTO_EXTRACT_POLL_MS,
} from "./autoExtractScheduler.ts"
import {
  startAutoValuationWorker,
  stopAutoValuationWorker,
  isAutoValuationWorkerRunning,
  getValuationStats,
  getRecentCandidates,
  pollOnce as valuationPollOnce,
  POLL_INTERVAL_MS as VALUATION_POLL_MS,
  type ValuationStats,
} from "./autoValuation.ts"
import {
  buildRecallMarkdown,
  readSessionTranscript,
} from "./sessionTranscript.ts"
import {
  FULL_SYNC_HOUR,
  FULL_SYNC_MINUTE,
  getLastFullSyncResult,
  isFullSyncSchedulerRunning,
  POLL_INTERVAL_MS as FULL_SYNC_POLL_MS,
  startFullSyncScheduler,
} from "./fullSyncScheduler.ts"
import {
  getOpencodeProcessQueueStatus,
  runQueuedOpencodeProcess,
} from "./opencodeProcessQueue.ts"

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const PROJECT_ROOT = resolve(__dirname, "..")
const PUBLIC_DIR = join(PROJECT_ROOT, "public")
const NODE_MODULES_DIR = join(PROJECT_ROOT, "node_modules")

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

type Tab = "sessions" | "reports" | "requirements" | "settings" | "schedulers"

/**
 * Operator-style topbar: thin console header with a logo block, optional
 * status badge, and a route strip below it. Both Sessions and Reports nav
 * still work — the route strip keeps them visible in the new style.
 */
const Layout: FC<{ title: string; active: Tab; children: any }> = ({ title, active, children }) => (
  <html lang="zh-CN">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>{title} — OpenCode Dashboard</title>
      <link rel="stylesheet" href="/static/style.css" />
    </head>
    <body>
      <header class="op-topbar">
        <div class="op-topbar-row">
          <div class="op-brand">
            <span class="op-brand-name">OpenCode Operator</span>
            <span class="op-brand-sep">|</span>
            <span class="op-brand-status">SNAPSHOT READY</span>
          </div>
          <div class="op-meta">
            <button type="button" class="op-meta-item op-refresh" id="op-force-refresh" title="强制刷新当前页面">↻ 强制刷新</button>
            <div class="op-notify" id="op-notify">
              <button type="button" class="op-notify-bell" id="op-notify-bell" aria-label="通知中心" aria-expanded="false">
                <span class="op-notify-icon" aria-hidden="true">🔔</span>
                <span class="op-notify-badge" id="op-notify-badge" hidden>0</span>
              </button>
              <div class="op-notify-panel" id="op-notify-panel" hidden role="dialog" aria-label="通知列表">
                <div class="op-notify-panel-head">
                  <span class="op-notify-panel-title">通知中心</span>
                  <div class="op-notify-panel-actions">
                    <button type="button" class="op-notify-link" id="op-notify-mark-read">全部标记已读</button>
                    <button type="button" class="op-notify-link" id="op-notify-dismiss-all">全部清除</button>
                  </div>
                </div>
                <ul class="op-notify-list" id="op-notify-list"></ul>
                <div class="op-notify-empty" id="op-notify-empty" hidden>暂无通知</div>
              </div>
            </div>
          </div>
        </div>
        <div class="op-topbar-row op-topbar-routes">
          <nav class="op-routes">
            <a href="/" class={active === "requirements" ? "op-route op-route-active" : "op-route"}>Projects</a>
            <a href="/sessions" class={active === "sessions" ? "op-route op-route-active" : "op-route"}>Sessions</a>
            <a href="/reports" class={active === "reports" ? "op-route op-route-active" : "op-route"}>Reports</a>
            <a href="/schedulers" class={active === "schedulers" ? "op-route op-route-active" : "op-route"}>Schedulers</a>
            <a href="/settings" class={active === "settings" ? "op-route op-route-active" : "op-route"}>Settings</a>
          </nav>
          <span class="op-embedded">embedded web terminal · {title}</span>
        </div>
      </header>
      <main class={(active === "sessions" || active === "requirements") ? "op-main op-main-sessions" : "op-main"}>{children}</main>
      <div id="op-toast-host" class="op-toast-host" aria-live="polite" aria-atomic="false"></div>
      <script src="/static/notifications.js" defer></script>
      <script src="/static/app.js" defer></script>
    </body>
  </html>
)

// ---------------------------------------------------------------------------
// Sessions dashboard
// ---------------------------------------------------------------------------

const StatusDot: FC<{ status: string }> = ({ status }) => (
  <span class={`status-dot status-${status}`} title={status} aria-hidden="true" />
)

const statusLabel = (status: SessionInfo["status"]): string => {
  if (status === "running") return "RUNNING"
  if (status === "idle") return "IDLE"
  return "STALE"
}

const shortSessionId = (id: string): string => {
  // "ses_12512136bffeLb0e0B1Z8epxiX" -> "1251 2136 BFFE LB0E"
  const core = id.startsWith("ses_") ? id.slice(4) : id
  if (core.length <= 16) return core.toUpperCase()
  return (core.slice(0, 4) + " " + core.slice(4, 8) + " " + core.slice(8, 12) + " " + core.slice(12, 16)).toUpperCase()
}

const formatUpdated = (ms: number): string => {
  if (!ms) return "—"
  const d = new Date(ms)
  if (!isFinite(d.getTime())) return "—"
  // Operator-style: 2026-06-18 16:32 UTC
  return d.toISOString().replace("T", " ").slice(0, 16) + " UTC"
}

const formatRelAgo = (ms: number, now = Date.now()): string => {
  if (!ms) return "—"
  const age = Math.max(0, now - ms)
  const sec = Math.floor(age / 1000)
  if (sec < 60) return `${sec}s ago`
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  const d = Math.floor(hr / 24)
  return `${d}d ago`
}

const formatTokens = (n?: number): string => {
  if (!n) return "0"
  if (n < 1000) return String(n)
  if (n < 1_000_000) return (n / 1000).toFixed(n < 10000 ? 1 : 0) + "K"
  return (n / 1_000_000).toFixed(2) + "M"
}

const modelDisplay = (s: SessionInfo): string => {
  if (s.modelId) {
    const variant = s.modelVariant && s.modelVariant !== "default" ? ` · ${s.modelVariant}` : ""
    return s.modelId + variant
  }
  return "unknown model"
}

const sourceLabel = (source: SessionInfo["source"]): string => {
  if (source === "db") return "SQLITE"
  if (source === "cli") return "CLI"
  return "FS"
}

const AGENT_BADGE_COLOR_CLASS: Record<string, string> = {
  orchestrator: "op-lane-child-agent-agent-orchestrator",
  "code-writer": "op-lane-child-agent-agent-code-writer",
  "code-reviewer": "op-lane-child-agent-agent-code-reviewer",
  "test-runner": "op-lane-child-agent-agent-test-runner",
  "code-explorer": "op-lane-child-agent-agent-code-explorer",
  debugger: "op-lane-child-agent-agent-debugger",
  general: "op-lane-child-agent-agent-general",
}

function childAgentBadgeClass(agent?: string): string {
  if (agent && Object.prototype.hasOwnProperty.call(AGENT_BADGE_COLOR_CLASS, agent)) {
    return AGENT_BADGE_COLOR_CLASS[agent]
  }
  return AGENT_BADGE_COLOR_CLASS.general
}

function childAgentDisplay(agent?: string): string {
  if (!agent) return "general"
  return agent
}

const ChildSessionCard: FC<{ child: SessionInfo }> = ({ child }) => {
  const badge = childAgentBadgeClass(child.agent)
  const label = childAgentDisplay(child.agent)
  return (
    <a class="op-lane-child" href={`/session?id=${encodeURIComponent(child.id)}`}>
      <StatusDot status={child.status} />
      <span class={`op-lane-child-agent ${badge}`}>{label}</span>
      <span class="op-lane-child-title" title={child.title}>{child.title}</span>
      <span class="op-lane-child-time">{formatRelAgo(child.updated || child.created)}</span>
    </a>
  )
}

const SessionLane: FC<{ session: SessionInfo; index: number; total: number; childSessions?: SessionInfo[] }> = ({ session, index, total, childSessions }) => {
  const updatedText = formatUpdated(session.updated || session.created)
  const relText = formatRelAgo(session.updated || session.created)
  const runTag = "RUN-LANE-" + String(total - index).padStart(3, "0")
  const titleLine = "Agent Run"
  const agentName = session.agent || "session"
  const subtitle = `OpenCode ${agentName} thread is active.`
  const statusPhrase = session.status === "running"
    ? `OpenCode ${agentName} thread is live — last touched ${relText}.`
    : session.status === "idle"
    ? `OpenCode ${agentName} thread is paused — last touched ${relText}.`
    : `OpenCode ${agentName} thread is stale — last touched ${relText}.`
  const worktree = session.worktree || "none"
  const branch = session.directory ? session.directory.split("/").filter(Boolean).pop() || worktree : worktree
  const totalTokens = (session.tokensInput || 0) + (session.tokensOutput || 0) + (session.tokensCacheRead || 0)
  const childList = childSessions && childSessions.length > 0 ? childSessions : null
  return (
    <div class="op-lane">
      <a class="op-lane-main" href={`/session?id=${encodeURIComponent(session.id)}`}>
        <div class="op-lane-rail" aria-hidden="true" />
        <div class="op-lane-body">
          <div class="op-lane-head">
            <span class="op-lane-issue">ISSUE / {runTag}</span>
            <span class={`op-lane-status op-lane-status-${session.status}`}>
              <StatusDot status={session.status} /> {statusLabel(session.status)}
            </span>
          </div>
          <h2 class="op-lane-title">{titleLine} <span class="op-lane-title-sep">·</span> <span class="op-lane-title-name">{session.title}</span></h2>
          <p class="op-lane-subtitle">{subtitle}</p>
          <p class="op-lane-phrase">{statusPhrase}</p>
          <div class="op-lane-stats">
            <span class="op-stat"><span class="op-stat-k">INPUT</span><span class="op-stat-v">{formatTokens(session.tokensInput)}</span></span>
            <span class="op-stat"><span class="op-stat-k">OUTPUT</span><span class="op-stat-v">{formatTokens(session.tokensOutput)}</span></span>
            <span class="op-stat"><span class="op-stat-k">CACHE&nbsp;R</span><span class="op-stat-v">{formatTokens(session.tokensCacheRead)}</span></span>
            <span class="op-stat"><span class="op-stat-k">REASON</span><span class="op-stat-v">{formatTokens(session.tokensReasoning)}</span></span>
            <span class="op-stat"><span class="op-stat-k">TOTAL</span><span class="op-stat-v">{formatTokens(totalTokens)}</span></span>
          </div>
          <div class="op-lane-grid">
            <div class="op-grid-cell">
              <span class="op-grid-k">CODEX THREAD</span>
              <span class="op-grid-v mono">{shortSessionId(session.id)}</span>
            </div>
            <div class="op-grid-cell">
              <span class="op-grid-k">THREAD FLAGS</span>
              <span class="op-grid-v mono">{statusLabel(session.status)} · {sourceLabel(session.source)}</span>
            </div>
            <div class="op-grid-cell">
              <span class="op-grid-k">PROTOCOL EVENT</span>
              <span class="op-grid-v mono">opencode.pty.start</span>
            </div>
            <div class="op-grid-cell">
              <span class="op-grid-k">BRANCH</span>
              <span class="op-grid-v mono" title={session.directory}>{branch}</span>
            </div>
            <div class="op-grid-cell">
              <span class="op-grid-k">WORKTREE</span>
              <span class="op-grid-v mono" title={session.directory || ""}>{worktree}</span>
            </div>
            <div class="op-grid-cell">
              <span class="op-grid-k">BACKLOG OWNERSHIP</span>
              <span class="op-grid-v mono">{session.projectId || "global"}</span>
            </div>
            <div class="op-grid-cell">
              <span class="op-grid-k">MODEL</span>
              <span class="op-grid-v mono" title={session.modelProvider ? `${session.modelProvider}` : ""}>{modelDisplay(session)}</span>
            </div>
            <div class="op-grid-cell">
              <span class="op-grid-k">NEXT RETRY</span>
              <span class="op-grid-v mono">{updatedText} · {relText}</span>
            </div>
          </div>
        </div>
      </a>
      {childList && (
        <details class="op-lane-children">
          <summary class="op-lane-children-toggle">
            <span class="op-lane-children-count">{childList.length}</span>
            <span>子 Session</span>
            <span class="op-lane-children-arrow" aria-hidden="true">{"▾"}</span>
          </summary>
          <div class="op-lane-children-list">
            {childList.map((c) => <ChildSessionCard child={c} />)}
          </div>
        </details>
      )}
    </div>
  )
}

const SessionsPage: FC<{ sessions: SessionInfo[]; summary: ReturnType<typeof summarizeSessions>; days: number }> = ({ sessions, summary, days }) => {
  const { top, childrenByParent } = groupSessionsByParent(sessions)
  // Flow strip and totals count only top-level sessions, not subagent children.
  const topSummary = summarizeSessions(top)
  const source = top[0]?.source ?? sessions[0]?.source ?? "db"
  const sourceText = source === "db" ? "sqlite store" : source === "cli" ? "opencode CLI" : "fs fallback"
  return (
    <Layout title="Sessions" active="sessions">
      <section class="op-flow" aria-label="operator flow">
        <div class="op-flow-cell op-flow-backlog">
          <span class="op-flow-k">BACKLOG</span>
          <span class="op-flow-v">{topSummary.stale}</span>
          <span class="op-flow-hint">stale &gt; 24h</span>
        </div>
        <div class="op-flow-cell op-flow-running">
          <span class="op-flow-k">RUNNING</span>
          <span class="op-flow-v">{topSummary.running}</span>
          <span class="op-flow-hint">&lt; 5m touched</span>
        </div>
        <div class="op-flow-cell op-flow-repair">
          <span class="op-flow-k">REPAIR</span>
          <span class="op-flow-v">{topSummary.idle}</span>
          <span class="op-flow-hint">idle 5m–24h</span>
        </div>
        <div class="op-flow-cell op-flow-ready">
          <span class="op-flow-k">READY</span>
          <span class="op-flow-v">{topSummary.total}</span>
          <span class="op-flow-hint">total leased</span>
        </div>
      </section>

      <header class="op-section-head">
        <h1 class="op-section-title">RUNNING LANES</h1>
        <div class="op-section-meta">
          <details class="op-time-filter">
            <summary class="op-time-filter-toggle">
              <span class="op-time-filter-icon">◷</span>
              <span class="op-time-filter-label">{days === 0 ? "全部时间" : `近 ${days} 天`}</span>
            </summary>
            <div class="op-time-filter-menu">
              <a href={sessionsDaysPath(1)} class={days === 1 ? "op-time-filter-option active" : "op-time-filter-option"}>近 1 天</a>
              <a href={sessionsDaysPath(3)} class={days === 3 ? "op-time-filter-option active" : "op-time-filter-option"}>近 3 天</a>
              <a href={sessionsDaysPath(7)} class={days === 7 ? "op-time-filter-option active" : "op-time-filter-option"}>近 7 天</a>
              <a href={sessionsDaysPath(14)} class={days === 14 ? "op-time-filter-option active" : "op-time-filter-option"}>近 14 天</a>
              <a href={sessionsDaysPath(30)} class={days === 30 ? "op-time-filter-option active" : "op-time-filter-option"}>近 30 天</a>
              <a href={sessionsDaysPath(0)} class={days === 0 ? "op-time-filter-option active" : "op-time-filter-option"}>全部时间</a>
            </div>
          </details>
          <span class="op-section-meta-item">{topSummary.running} RUNNING · {topSummary.total} LEASED</span>
          <span class="op-section-meta-item muted">via {sourceText}</span>
        </div>
      </header>

      {top.length === 0 ? (
        <div class="op-empty">
          <p>No OpenCode sessions found.</p>
          <p class="muted small">No sessions in the selected time range. Try a wider range or <a href={sessionsDaysPath(0)}>view all</a>.</p>
          <p class="muted small">
            Start one with <code>opencode</code> in any project, or ensure{" "}
            <code>~/.local/share/opencode/opencode.db</code> is readable.
          </p>
          <p class="muted small">
            Useful commands: <code>opencode web</code>, <code>opencode serve --port 4096</code>,
            <code>opencode attach http://localhost:4096 --session &lt;id&gt;</code>
          </p>
        </div>
      ) : (
        <div class="op-lanes">
          {top.map((s, i) => <SessionLane session={s} index={i} total={top.length} childSessions={childrenByParent.get(s.id)} />)}
        </div>
      )}

      <section class="op-hints">
        <h2 class="op-hints-title">OPENCODE WEB / SERVE / ATTACH</h2>
        <ul class="op-hints-list">
          <li><code>opencode web</code> — start server and open web interface in your browser.</li>
          <li><code>opencode serve --port 4096</code> — run a headless server on port 4096.</li>
          <li><code>opencode attach http://localhost:4096 --session &lt;id&gt;</code> — attach a TTY client to a running server.</li>
        </ul>
        <p class="op-hints-note muted small">
          The dashboard's primary attach path is the embedded terminal — those commands are provided as a fallback.
        </p>
      </section>
    </Layout>
  )
}

// ---------------------------------------------------------------------------
// Report list page
// ---------------------------------------------------------------------------

const RatingBadge: FC<{ rating: string }> = ({ rating }) => {
  const cls = rating === "高" ? "badge badge-high" : rating === "中" ? "badge badge-medium" : "badge badge-low"
  return <span class={cls}>{rating}</span>
}

const ReportListPage: FC<{ reports: (Awaited<ReturnType<typeof scanReports>>[number] & { confirmedCount?: number; rejectedCount?: number })[] }> = ({ reports }) => (
  <Layout title="Reports" active="reports">
    <div class="page-header">
      <h1>Experience Reports</h1>
      <p class="muted">{reports.length} report(s) found in /tmp/opencode/handoff/</p>
    </div>

    {reports.length === 0 ? (
      <div class="empty-state">
        <p>No reports yet.</p>
        <p class="muted">Run <code>/experience-summary</code> in OpenCode to generate a report.</p>
      </div>
    ) : (
      <div class="report-grid">
        {reports.map((r) => (
          <a class={`report-card${r.confirmedCount ? " report-card-confirmed" : ""}`} href={`/report?path=${encodeURIComponent(r.reportPath)}`}>
            <div class="report-card-header">
              <span class="report-session">{r.session}</span>
              <span class="report-date">{r.generated || "unknown date"}</span>
            </div>
            <div class="report-card-body">
              <span class="stat stat-high">{r.highCount} 高</span>
              <span class="stat stat-medium">{r.mediumCount} 中</span>
              <span class="stat stat-total">{r.candidateCount} total</span>
              {r.confirmedCount ? <span class="stat stat-confirmed">✓ {r.confirmedCount} confirmed</span> : null}
              {r.rejectedCount ? <span class="stat stat-rejected">✗ {r.rejectedCount} rejected</span> : null}
            </div>
            <div class="report-card-footer muted">{r.scope}</div>
          </a>
        ))}
      </div>
    )}
  </Layout>
)

// ---------------------------------------------------------------------------
// Report detail page
// ---------------------------------------------------------------------------

const CandidateCard: FC<{ c: Candidate; confirmed?: boolean }> = ({ c, confirmed }) => (
  <div class={`candidate-card${confirmed ? " checked" : ""}`} data-cid={c.id}>
    <div class="candidate-header">
      <label class="candidate-check">
        <input type="checkbox" data-cid={c.id} checked={confirmed ?? false} />
        <span class="cid">[{c.id}]</span>
      </label>
      <span class="candidate-title">{c.title}</span>
      <RatingBadge rating={c.valueRating} />
    </div>
    <div class="candidate-body">
      {c.valueReason && <div class="field"><span class="field-label">理由</span><span>{c.valueReason}</span></div>}
      {c.evidenceDetail && <div class="field"><span class="field-label">验证依据</span><span>{c.evidenceDetail}</span></div>}
      {c.source && <div class="field"><span class="field-label">来源</span><span>{c.source}</span></div>}
      {c.targetFile && <div class="field"><span class="field-label">目标</span><code>{c.targetFile}</code></div>}
      {c.changeSummary && <div class="field"><span class="field-label">变更</span><span>{c.changeSummary}</span></div>}
      {c.followUpSkill && <div class="field"><span class="field-label">Skill</span><span>{c.followUpSkill}</span></div>}
      {c.keyEvidence && <div class="field"><span class="field-label">证据</span><span class="muted">{c.keyEvidence}</span></div>}
      {c.executionNotes && <div class="field"><span class="field-label">注意</span><span class="muted">{c.executionNotes}</span></div>}
    </div>
  </div>
)

const ReportDetailPage: FC<{ report: ParsedReport; reportPath: string; confirmation: ConfirmationStatus }> = ({ report, reportPath, confirmation }) => {
  const confirmedSet = new Set(confirmation.confirmedIds)
  return (
  <Layout title={`Report — ${report.meta.session}`} active="reports">
    <div class="page-header">
      <a href="/reports" class="back-link">← Back to reports</a>
      <h1>{report.meta.session || "Session"}</h1>
      <div class="meta-grid">
        {report.meta.scope && <div><span class="field-label">Scope</span> {report.meta.scope}</div>}
        {report.meta.generated && <div><span class="field-label">Generated</span> {report.meta.generated}</div>}
        {report.meta.artifact && <div><span class="field-label">Artifact</span> <code>{report.meta.artifact}</code></div>}
        {confirmation.confirmedIds.length > 0 && <div><span class="field-label">Confirmed</span> <span class="stat stat-confirmed">{confirmation.confirmedIds.length} candidate(s)</span></div>}
        {confirmation.rejectedIds.length > 0 && <div><span class="field-label">Rejected</span> <span class="stat stat-rejected">{confirmation.rejectedIds.length} candidate(s)</span></div>}
      </div>
    </div>

    {report.candidates.length === 0 ? (
      <div class="empty-state"><p>No candidates in this report.</p></div>
    ) : (
      <>
        <div class="action-bar" id="action-bar">
          <span class="muted" id="selection-info">0 selected</span>
          <button class="btn btn-primary" id="btn-confirm">Confirm Selected</button>
          <button class="btn btn-reject" id="btn-reject">Reject Selected</button>
          <button class="btn btn-secondary" id="btn-select-all">Select All</button>
          <button class="btn btn-secondary" id="btn-deselect-all">Deselect All</button>
        </div>

        <div class="candidate-list">
          {report.candidates
            .filter((c) => c.category === "candidate")
            .map((c) => <CandidateCard c={c} confirmed={confirmedSet.has(c.id)} />)}
        </div>

        {report.candidates.some((c) => c.category === "interaction") && (
          <>
            <h2 class="section-title">主/子 Agent 互动优化</h2>
            <div class="candidate-list">
              {report.candidates
                .filter((c) => c.category === "interaction")
                .map((c) => <CandidateCard c={c} confirmed={confirmedSet.has(c.id)} />)}
            </div>
          </>
        )}
      </>
    )}

    {report.risksGaps && (
      <div class="risks-section">
        <h2>Risks / Gaps</h2>
        <pre>{report.risksGaps}</pre>
      </div>
    )}

    <script dangerouslySetInnerHTML={{
      __html: `window.__REPORT_PATH__ = ${JSON.stringify(reportPath)}; window.__CONFIRMED_IDS__ = ${JSON.stringify(confirmation.confirmedIds)}; window.__REJECTED_IDS__ = ${JSON.stringify(confirmation.rejectedIds)};`,
    }} />
  </Layout>
  )
}

// ---------------------------------------------------------------------------
// Session detail (embedded terminal) page
// ---------------------------------------------------------------------------

const SessionTerminalPage: FC<{ session: SessionInfo; req?: Requirement | null; reqContext?: string; createNew?: boolean }> = ({ session, req, reqContext, createNew }) => {
  const updatedText = formatUpdated(session.updated || session.created)
  const worktree = session.worktree || "none"
  const model = modelDisplay(session)
  const reqId = req ? req.id : ""
  const ctx = reqContext ?? ""
  const descSnippet = req && req.description ? req.description.slice(0, 200) : ""
  const isNew = createNew === true
  const initJs = `window.__REQ_ID__ = ${JSON.stringify(reqId)}; window.__REQ_CONTEXT__ = ${JSON.stringify(ctx)}; window.__CREATE_NEW__ = ${JSON.stringify(isNew)};`
  const terminalTitle = isNew
    ? (req ? `opencode run -i --title ${JSON.stringify(req.title).slice(1, -1)}` : "opencode run -i")
    : `opencode --session ${session.id}`
  return (
    <Layout title={`Session ${session.id || "new"}`} active="sessions">
      <div class="page-header session-detail-header">
        <a href={SESSIONS_PATH} class="back-link">← All sessions</a>
        <h1 class="mono">{session.title || session.id || "New session"}</h1>
        <div class="meta-grid">
          <div><span class="field-label">Session</span> <code>{session.id || (isNew ? "(pending — opencode 创建中)" : "—")}</code></div>
          <div><span class="field-label">Status</span> <span class={`status-pill status-${session.status}`}>{statusLabel(session.status)}</span></div>
          <div><span class="field-label">Project</span> {session.projectId || "global"}</div>
          <div><span class="field-label">Agent</span> {session.agent || "—"}</div>
          <div><span class="field-label">Model</span> <code>{model}</code></div>
          <div><span class="field-label">Worktree</span> <code>{worktree}</code></div>
          <div><span class="field-label">Updated</span> {updatedText}</div>
          {session.directory ? <div><span class="field-label">Cwd</span> <code>{session.directory}</code></div> : null}
          <div><span class="field-label">Source</span> {sourceLabel(session.source)}</div>
          {req ? <div><span class="field-label">Requirement</span> <a href={`/requirement?id=${encodeURIComponent(req.id)}`}>{req.title}</a></div> : null}
        </div>
      </div>

      {req ? (
        <details class="req-context-panel" open>
          <summary>需求上下文 — {req.title} <span class={`req-status-badge req-status-${req.status}`}>{req.status}</span></summary>
          <div class="req-context-panel-body">
            {descSnippet ? <div><strong>描述：</strong><pre>{descSnippet}</pre></div> : null}
            <button id="inject-req-btn" type="button" class="btn btn-secondary">注入需求上下文</button>
          </div>
        </details>
      ) : null}

      <div class="terminal-wrap">
        <div class="terminal-header">
          <div class="terminal-header-left">
            <span class="dot dot-red" />
            <span class="dot dot-yellow" />
            <span class="dot dot-green" />
            <span class="terminal-title mono">{terminalTitle}</span>
          </div>
          <div class="terminal-header-right muted small">
            <span>WebSocket: /ws/session-terminal</span>
          </div>
        </div>
        <div class="terminal-host-shell">
          <div id="terminal" class="terminal-host" data-session-id={session.id} data-req-id={reqId} />
        </div>
        <div id="terminal-status" class="terminal-status muted small">connecting…</div>
      </div>

      <section class="hints-section">
        <h2>OpenCode CLI hints</h2>
        <ul class="hints-list">
          <li><code>opencode web</code> — start OpenCode's own web interface in your browser.</li>
          <li><code>opencode serve --port 4096</code> — start a headless server, then attach with:</li>
          <li><code>opencode attach http://localhost:4096 --session {session.id || "<id>"}</code></li>
        </ul>
        <p class="muted small">
          This page runs an embedded <code>node-pty</code> terminal locally; it is independent of any
          remote <code>opencode serve</code> process.
        </p>
      </section>

      <script dangerouslySetInnerHTML={{ __html: initJs }} />
      <script
        type="module"
        src="/static/terminal.js"
        data-session-id={session.id}
        data-req-id={reqId}
        data-create-new={isNew ? "1" : ""}
        dangerouslySetInnerHTML={undefined}
      />
    </Layout>
  )
}

const SessionMissingPage: FC<{ id: string; backReqId?: string }> = ({ id, backReqId }) => (
  <Layout title={`Session ${id} not found`} active="sessions">
    <div class="page-header">
      <a href={SESSIONS_PATH} class="back-link">← All sessions</a>
      <h1>Session not available</h1>
      <p class="muted">
        <code>{id || "(empty)"}</code> 在 OpenCode 数据库里找不到。可能已归档，或这是一个曾经记在需求里、但 OpenCode 从未真正创建过的"幽灵 id"。
      </p>
      {backReqId ? (
        <p>
          <a class="btn btn-primary" href={`/requirement?id=${encodeURIComponent(backReqId)}`}>
            返回需求页面选择「新建」或「关联已有 session」 →
          </a>
        </p>
      ) : null}
    </div>
  </Layout>
)

// ---------------------------------------------------------------------------
// Requirement pages
// ---------------------------------------------------------------------------

const REQ_STATUS_SLUG: Record<ReqStatus, string> = {
  "待设计": "design",
  "待开发": "pending",
  "开发中": "dev",
  "自测中": "selftest",
  "测试中": "testing",
  "待上线": "deploy",
  "已完成": "done",
}

function reqStatusBadgeClass(status: ReqStatus): string {
  return `req-status-badge req-status-${REQ_STATUS_SLUG[status]}`
}

function bucketByGroupPath(requirements: Requirement[]): { key: string; segments: string[]; reqs: Requirement[] }[] {
  const buckets = new Map<string, { segments: string[]; reqs: Requirement[] }>()
  for (const r of requirements) {
    const segs = r.groupPath ?? []
    const key = segs.join("/")
    const cur = buckets.get(key)
    if (cur) cur.reqs.push(r)
    else buckets.set(key, { segments: segs, reqs: [r] })
  }
  // Sort: root group ("") first, then groups by their joined key.
  const entries = [...buckets.entries()].sort((a, b) => {
    if (a[0] === b[0]) return 0
    if (a[0] === "") return -1
    if (b[0] === "") return 1
    return a[0].localeCompare(b[0])
  })
  return entries.map(([key, value]) => ({ key, segments: value.segments, reqs: value.reqs }))
}

const RequirementCard: FC<{ r: Requirement; childReqs?: Requirement[] }> = ({ r, childReqs }) => {
  const snippet = (r.description || "").trim().slice(0, 120) || "暂无描述"
  const isParent = !!(r.childIds && r.childIds.length > 0)
  const childList = childReqs ?? []
  if (isParent) {
    return (
      <details class="req-card req-card-parent" open={false}>
        <summary class="req-card-header">
          <span class="req-card-title">{r.title}</span>
          <span class="req-card-child-count">{childList.length} 子需求</span>
        </summary>
        <div class="req-card-children">
          <div class="req-list">
            {childList.map((cr) => <RequirementCard r={cr} />)}
          </div>
        </div>
      </details>
    )
  }
  return (
    <a class="req-card" href={`/requirement?id=${encodeURIComponent(r.id)}`}>
      <div class="req-card-header">
        <span class="req-card-title">{r.title}</span>
        <span class={reqStatusBadgeClass(r.status)}>{r.status}</span>
      </div>
      <div class="req-card-body">{snippet}</div>
      <div class="req-card-footer">
        <span>{r.sessionIds.length} session(s)</span>
        <span>更新于 {formatRelAgo(r.updatedAt)}</span>
      </div>
    </a>
  )
}

/**
 * Search-as-you-type session picker built on the native HTML `<datalist>`
 * element. Each option's `value` is "ses_xxx — <title>" so the browser's
 * built-in matching works against both the id prefix and any fragment
 * of the title. The server-side handler extracts the `ses_...` portion
 * from whatever value the user submits.
 */
const SessionPicker: FC<{ candidates: SessionInfo[]; listId: string; placeholder?: string }> = ({ candidates, listId, placeholder }) => {
  return (
    <>
      <input
        type="text"
        name="sessionId"
        list={listId}
        autocomplete="off"
        spellcheck={false}
        placeholder={placeholder ?? "输入 ses_ 前缀或标题片段筛选…"}
        required
      />
      <datalist id={listId}>
        {candidates.map((s) => {
          const title = (s.title || "(untitled)").replace(/\s+/g, " ").trim()
          const label = `${s.id} — ${title}`
          return <option value={label} />
        })}
      </datalist>
    </>
  )
}

const ProjectsPage: FC<{
  groups: { project: string; requirements: Requirement[] }[]
  counts: Record<ReqStatus, number>
  statusFilter: string
  showCompleted: boolean
}> = ({ groups, counts, statusFilter, showCompleted }) => {
  const filterActive = statusFilter !== "" && (REQ_STATUSES as string[]).includes(statusFilter)
  // Hide "已完成" requirements by default when no status filter is active.
  const hideCompleted = !filterActive && !showCompleted
  const filteredGroups = filterActive
    ? groups
        .map((g) => {
          const matching = g.requirements.filter((r) => r.status === statusFilter)
          // Include parents of matching children so they're not orphaned.
          const parentIds = new Set(matching.filter((r) => r.parentReqId).map((r) => r.parentReqId!))
          const matchingIds = new Set(matching.map((r) => r.id))
          const needed = g.requirements.filter((r) => matchingIds.has(r.id) || parentIds.has(r.id))
          return { ...g, requirements: needed }
        })
        .filter((g) => g.requirements.length > 0)
    : groups
        .map((g) => ({
            ...g,
            requirements: hideCompleted
              ? g.requirements.filter((r) => r.status !== "已完成")
              : g.requirements,
          }))
        .filter((g) => g.requirements.length > 0)
  const totalReqs = filteredGroups.reduce(
    (acc, g) => acc + g.requirements.filter((r) => !r.parentReqId).length,
    0,
  )
  return (
    <Layout title="Projects" active="requirements">
      <section class="req-flow" aria-label="requirement flow">
        {REQ_STATUSES.map((s) => {
          const isActive = statusFilter === s
          const href = isActive ? "/" : `/?status=${encodeURIComponent(s)}`
          return (
            <a
              href={href}
              class={`op-flow-cell req-flow-cell-${REQ_STATUS_SLUG[s]}${isActive ? " req-flow-cell-active" : ""}`}
              title={isActive ? `取消筛选：${s}` : `筛选状态：${s}`}
            >
              <span class="op-flow-k">{s}</span>
              <span class="op-flow-v">{counts[s]}</span>
            </a>
          )
        })}
      </section>

      <header class="op-section-head">
        <h1 class="op-section-title">REQUIREMENT BACKLOG</h1>
        <div class="op-section-meta">
          <span class="op-section-meta-item">{totalReqs} TRACKED</span>
          {filterActive ? (
            <a class="op-section-meta-item req-filter-clear" href="/" title="清除状态筛选">
              ✕ 筛选：{statusFilter}
            </a>
          ) : (
            <>
              {hideCompleted ? (
                <a class="op-section-meta-item" href="/?showCompleted=1" title="显示已完成需求">
                  + 显示已完成
                </a>
              ) : (
                <a class="op-section-meta-item req-filter-clear" href="/" title="隐藏已完成需求">
                  ✕ 隐藏已完成
                </a>
              )}
              <span class="op-section-meta-item muted">via hermes req-tracker</span>
            </>
          )}
        </div>
      </header>

      {filteredGroups.length === 0 ? (
        <div class="op-empty">
          <p>{filterActive ? `没有状态为「${statusFilter}」的需求。` : "No projects yet."}</p>
          {filterActive ? <p><a href="/">查看全部需求</a></p> : null}
        </div>
      ) : (
        <div class="proj-list">
          {filteredGroups.map(({ project, requirements }, i) => {
            const isOpen = project === DEFAULT_PROJECT_NAME
            const latest = requirements.reduce((m, r) => (r.updatedAt > m ? r.updatedAt : m), 0)
            // Top-level requirements only — children are rendered inside
            // their parent's collapsible card via findChildren.
            const topLevel = requirements.filter((r) => !r.parentReqId)
            const buckets = bucketByGroupPath(topLevel)
            // Helper: find children of a parent req within the same project.
            const findChildren = (parentId: string): Requirement[] =>
              requirements.filter((r) => r.parentReqId === parentId)
            return (
              <details class="proj-card" open={isOpen}>
                <summary class="proj-card-header">
                  <span class="proj-card-name">{project}</span>
                  <span class="proj-card-meta">
                    <span class="proj-card-count">{topLevel.length} 需求</span>
                    {latest > 0 ? <span>更新于 {formatRelAgo(latest)}</span> : null}
                  </span>
                </summary>
                <div class="proj-card-body">
                  {requirements.length === 0 ? (
                    <p class="muted small" style="padding: 8px 0">暂无需求</p>
                  ) : (
                    <div class="req-group-list">
                      {buckets.map((bucket) => {
                        if (bucket.segments.length === 0) {
                          // Root group: render flat without an outer wrapper.
                          return (
                            <div class="req-list">
                              {bucket.reqs.map((r) => <RequirementCard r={r} childReqs={r.childIds ? findChildren(r.id) : undefined} />)}
                            </div>
                          )
                        }
                        const bucketLatest = bucket.reqs.reduce((m, r) => (r.updatedAt > m ? r.updatedAt : m), 0)
                        return (
                          <details class="req-subgroup" open={false}>
                            <summary class="req-subgroup-header">
                              <span class="req-subgroup-crumbs">
                                {bucket.segments.map((seg, idx) => (
                                  <>
                                    {idx > 0 ? <span class="req-subgroup-sep"> / </span> : null}
                                    <span class="req-subgroup-seg">{seg}</span>
                                  </>
                                ))}
                              </span>
                              <span class="req-subgroup-meta">
                                <span class="req-subgroup-count">{bucket.reqs.length} 需求</span>
                                {bucketLatest > 0 ? <span class="muted small">更新于 {formatRelAgo(bucketLatest)}</span> : null}
                              </span>
                            </summary>
                            <div class="req-list">
                              {bucket.reqs.map((r) => <RequirementCard r={r} childReqs={r.childIds ? findChildren(r.id) : undefined} />)}
                            </div>
                          </details>
                        )
                      })}
                    </div>
                  )}
                </div>
              </details>
            )
          })}
        </div>
      )}
    </Layout>
  )
}

const HermesFileSection: FC<{ title: string; content?: string }> = ({ title, content }) => {
  if (!content) return null
  return (
    <section class="req-hermes-section">
      <h2 class="op-section-title">{title}</h2>
      <pre style="white-space: pre-wrap; max-height: 320px; overflow: auto; padding: 10px; border: 1px solid var(--op-border, #2a2a2a); border-radius: 4px; background: var(--op-bg-soft, #181818);">{content}</pre>
    </section>
  )
}

const ACTIVE_STATUSES: ReqStatus[] = ["开发中", "自测中", "测试中"]

function pickMostRecentSession(sessions: SessionInfo[]): SessionInfo | null {
  if (sessions.length === 0) return null
  return [...sessions].sort((a, b) => (b.updated || b.created || 0) - (a.updated || a.created || 0))[0]
}

function sortByLastUsedDesc(sessions: SessionInfo[]): SessionInfo[] {
  return [...sessions].sort((a, b) => (b.updated || b.created || 0) - (a.updated || a.created || 0))
}

/**
 * Release checklist card — shown only when status = "待上线".
 * Displays 4 sections parsed from the Hermes context files:
 * 涉及应用, 涉及分支, 数据库变更, Apollo/Nacos 配置变更.
 */
const ReleaseChecklistCard: FC<{ checklist: ReleaseChecklist }> = ({ checklist }) => {
  const hasData =
    checklist.applications.length > 0 ||
    checklist.branches.length > 0 ||
    checklist.dbChanges.length > 0 ||
    checklist.configChanges.length > 0 ||
    checklist.mqResources.length > 0 ||
    checklist.verificationChains.length > 0 ||
    checklist.reviewItems.length > 0
  return (
    <section class="release-checklist" aria-label="上线检查">
      <h2 class="op-section-title">📋 上线检查清单</h2>
      {!hasData ? (
        <p class="muted small">尚未从上下文文件中提取到上线信息。请先运行「智能提取」补充 branch.md / config-changes.md / test.md / review.md。</p>
      ) : (
        <div class="release-checklist-grid">
          {checklist.applications.length > 0 ? (
            <div class="release-checklist-section">
              <h3>涉及应用</h3>
              <ul>{checklist.applications.map((a) => <li><code>{a}</code></li>)}</ul>
            </div>
          ) : null}
          {checklist.branches.length > 0 ? (
            <div class="release-checklist-section">
              <h3>涉及分支</h3>
              <table class="release-checklist-table">
                <tbody>
                  {checklist.branches.map((b) => (
                    <tr><td class="muted small">{b.label}</td><td><code>{b.value}</code></td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
          {checklist.dbChanges.length > 0 ? (
            <div class="release-checklist-section">
              <h3>数据库变更</h3>
              <ul>{checklist.dbChanges.map((d) => <li><code>{d}</code></li>)}</ul>
            </div>
          ) : null}
          {checklist.configChanges.length > 0 ? (
            <div class="release-checklist-section">
              <h3>Apollo / Nacos 配置变更</h3>
              <ul>{checklist.configChanges.map((c) => <li><code>{c}</code></li>)}</ul>
            </div>
          ) : null}
          {checklist.mqResources.length > 0 ? (
            <div class="release-checklist-section">
              <h3>Topic / Group / 云资源</h3>
              <ul>{checklist.mqResources.map((c) => <li><code>{c}</code></li>)}</ul>
            </div>
          ) : null}
          {checklist.verificationChains.length > 0 ? (
            <div class="release-checklist-section">
              <h3>上线前复验链路</h3>
              <ul>{checklist.verificationChains.map((c) => <li>{c}</li>)}</ul>
            </div>
          ) : null}
          {checklist.reviewItems.length > 0 ? (
            <div class="release-checklist-section">
              <h3>Code Review 结论</h3>
              <ul>{checklist.reviewItems.map((c) => <li>{c}</li>)}</ul>
            </div>
          ) : null}
          {checklist.releaseNotes.length > 0 ? (
            <div class="release-checklist-section release-checklist-notes">
              <h3>上线注意事项</h3>
              <ul>{checklist.releaseNotes.map((n) => <li>{n}</li>)}</ul>
            </div>
          ) : null}
        </div>
      )}
    </section>
  )
}

const RequirementDetailPage: FC<{
  req: Requirement
  associated: SessionInfo[]
  unassociated: SessionInfo[]
  recommendations: SessionRecommendation[]
  extractHistory: ExtractHistoryRecord[]
  backgroundContent?: string
  branchContent?: string
  notesContent?: string
  testContent?: string
  configContent?: string
  memoryContent?: string
  reviewContent?: string
  state?: RequirementState | null
  childReqs?: Requirement[]
  parentReq?: Requirement | null
}> = ({ req, associated, unassociated, recommendations, extractHistory, backgroundContent, branchContent, notesContent, testContent, configContent, memoryContent, reviewContent, state, childReqs, parentReq }) => {
  const isParent = !!(req.childIds && req.childIds.length > 0)
  const currentIdx = REQ_STATUSES.indexOf(req.status)
  const description = (req.description || "").trim()
  const canSwitch = !!req.reqDir && !isParent
  const next = nextStatus(req.status)
  const history = state?.history ?? []
  // Reverse-chronological display, but keep a stable copy.
  const historyDesc = [...history].sort((a, b) => b.at - a.at)
  return (
    <Layout title={`Requirement ${req.title}`} active="requirements">
      <div class="req-detail">
      <div class="page-header">
        {parentReq ? (
          <a href={`/requirement?id=${encodeURIComponent(parentReq.id)}`} class="back-link">← {parentReq.title}</a>
        ) : (
          <a href="/projects" class="back-link">← All requirements</a>
        )}
        <h1>
          {req.title}
          {isParent ? null : <span class={reqStatusBadgeClass(req.status)} style="margin-left: 8px;">{req.status}</span>}
        </h1>
        <div class="meta-grid">
          <div><span class="field-label">项目</span> {req.project}{req.groupPath && req.groupPath.length > 0 ? <span class="muted small"> / {req.groupPath.join(" / ")}</span> : null}</div>
          <div><span class="field-label">Req ID</span> <code>{req.id}</code></div>
          <div><span class="field-label">更新于</span> {formatRelAgo(req.updatedAt)}</div>
          {isParent ? <div><span class="field-label">子需求</span> {req.childIds!.length}</div> : null}
        </div>
      </div>

      {isParent ? (
        <>
          {description ? (
            <section class="req-hermes-section">
              <h2 class="op-section-title">描述</h2>
              <pre style="white-space: pre-wrap; padding: 10px; border: 1px solid var(--op-border, #2a2a2a); border-radius: 4px; background: var(--op-bg-soft, #181818);">{description}</pre>
            </section>
          ) : null}

          <HermesFileSection title="需求背景" content={backgroundContent} />

          <section class="req-children-section" aria-label="子需求">
            <h2 class="op-section-title">子需求（{childReqs?.length ?? 0}）</h2>
            <div class="req-list">
              {(childReqs ?? []).map((cr) => <RequirementCard r={cr} />)}
            </div>
          </section>
        </>
      ) : (
        <>
      {(() => {
        const orderedAssociated = sortByLastUsedDesc(associated)
        const recent = orderedAssociated[0] ?? null
        const others = orderedAssociated.slice(1)
        const isActive = ACTIVE_STATUSES.includes(req.status)
        return (
          <section class="req-session-panel" aria-label="需求 Session 选择">
            {recent ? (
              <div class="req-session-panel-row">
                <a class="btn btn-primary" href={`/session?id=${encodeURIComponent(recent.id)}&req=${encodeURIComponent(req.id)}`}>
                  继续任务 →
                </a>
                <span class="muted small">
                  上次使用 session <code>{recent.id.slice(0, 16)}…</code> · {formatRelAgo(recent.updated || recent.created)}
                </span>
                <button
                  type="button"
                  class="btn btn-secondary req-copy-cmd-btn"
                  data-copy-cmd={`opencode -s ${recent.id}`}
                  title={`复制 \`opencode -s ${recent.id}\` 到剪贴板`}
                >
                  📋 复制命令
                </button>
                <form method="post" action="/api/requirement/extract-context" class="req-extract-trigger-form" data-extract-trigger="">
                  <input type="hidden" name="reqId" value={req.id} />
                  <input type="hidden" name="sessionId" value={recent.id} />
                  <button
                    type="submit"
                    class="btn btn-secondary req-extract-link"
                    title="让 opencode 后台总结这个 session 的对话，完成后弹出提示进入预览页"
                  >
                    从此 session 提取上下文 →
                  </button>
                </form>
                <form method="post" action="/api/requirement/auto-extract" class="req-extract-trigger-form" data-extract-trigger="">
                  <input type="hidden" name="reqId" value={req.id} />
                  <input type="hidden" name="sessionId" value={recent.id} />
                  <button
                    type="submit"
                    class="btn btn-secondary req-extract-link"
                    title="让 agent 读取需求上下文文件，根据 session 内容判断哪些文件需要更新"
                  >
                    🤖 智能提取上下文 →
                  </button>
                </form>
                <button type="button" class="btn btn-secondary req-new-session-btn" data-req-id={req.id} title="为该需求再创建一个 session">另开新 session</button>
                <span class="req-new-session-result" data-req-id={req.id}></span>
                <form method="post" action="/api/requirement/dissociate" class="req-dissociate-form" onsubmit="return confirm('确认解除此 session 与该需求的绑定？');">
                  <input type="hidden" name="reqId" value={req.id} />
                  <input type="hidden" name="sessionId" value={recent.id} />
                  <button type="submit" class="btn btn-secondary req-dissociate-btn" title="解除此 session 与该需求的绑定">解除绑定</button>
                </form>
              </div>
            ) : (
              <div class="req-session-panel-empty">
                <p class="req-session-panel-prompt">
                  该需求{isActive ? <> 当前状态 <span class={reqStatusBadgeClass(req.status)}>{req.status}</span>，</> : "尚"}未绑定任何 session。请选择：
                </p>
                <div class="req-session-panel-actions">
                  <div class="req-session-inline-form">
                    <button type="button" class="btn btn-primary req-new-session-btn" data-req-id={req.id}>新建并绑定 session</button>
                    <span class="req-new-session-result" data-req-id={req.id}></span>
                    <span class="muted small" style="margin-left: 8px;">将在后台运行 <code>opencode run</code> 并把新 session 关联到此需求</span>
                  </div>
                  {unassociated.length > 0 ? (
                    <form method="post" action="/api/requirement/associate" class="req-session-inline-form">
                      <input type="hidden" name="reqId" value={req.id} />
                      <SessionPicker
                        candidates={unassociated}
                        listId={`unbound-sessions-top-${req.id}`}
                        placeholder={`筛选 ${unassociated.length} 个孤儿 session…`}
                      />
                      <button type="submit" class="btn btn-secondary">绑定到此需求</button>
                    </form>
                  ) : (
                    <span class="muted small">（没有可关联的孤儿 session）</span>
                  )}
                </div>
              </div>
            )}
            {others.length > 0 ? (
              <details class="req-session-panel-others">
                <summary>其它已绑定的 session（{others.length}）</summary>
                <ul class="req-session-list">
                  {others.map((s) => (
                    <li>
                      <a href={`/session?id=${encodeURIComponent(s.id)}&req=${encodeURIComponent(req.id)}`}>
                        <code>{s.id}</code>
                      </a>
                      <span class="muted small">{s.title || ""}</span>
                      <span class="muted small">{formatRelAgo(s.updated || s.created)}</span>
                      <button
                        type="button"
                        class="req-copy-cmd-inline"
                        data-copy-cmd={`opencode -s ${s.id}`}
                        title={`复制 \`opencode -s ${s.id}\` 到剪贴板`}
                      >
                        📋 复制
                      </button>
                      <form
                        method="post"
                        action="/api/requirement/extract-context"
                        class="req-extract-trigger-form req-extract-trigger-inline"
                        data-extract-trigger=""
                      >
                        <input type="hidden" name="reqId" value={req.id} />
                        <input type="hidden" name="sessionId" value={s.id} />
                        <button
                          type="submit"
                          class="muted small req-extract-link-inline"
                          title="让 opencode 后台总结这个 session 的对话，完成后顶部提示进入预览页"
                        >
                          提取上下文 →
                        </button>
                      </form>
                      <form
                        method="post"
                        action="/api/requirement/auto-extract"
                        class="req-extract-trigger-form req-extract-trigger-inline"
                        data-extract-trigger=""
                      >
                        <input type="hidden" name="reqId" value={req.id} />
                        <input type="hidden" name="sessionId" value={s.id} />
                        <button
                          type="submit"
                          class="muted small req-extract-link-inline"
                          title="让 agent 读取需求上下文文件，根据 session 内容判断哪些文件需要更新"
                        >
                          🤖 智能提取 →
                        </button>
                      </form>
                      <form
                        method="post"
                        action="/api/requirement/dissociate"
                        class="req-dissociate-form req-dissociate-inline"
                        onsubmit="return confirm('确认解除此 session 与该需求的绑定？');"
                      >
                        <input type="hidden" name="reqId" value={req.id} />
                        <input type="hidden" name="sessionId" value={s.id} />
                        <button
                          type="submit"
                          class="muted small req-dissociate-link-inline"
                          title="解除此 session 与该需求的绑定"
                        >
                          解除绑定
                        </button>
                      </form>
                      <a class="muted small req-extract-link-inline" href={`/requirement/recall?reqId=${encodeURIComponent(req.id)}&sessionId=${encodeURIComponent(s.id)}`} title="只读召回这个历史 session 的文本上下文">
                        召回历史 →
                      </a>
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}
          </section>
        )
      })()}

      {recommendations.length > 0 ? (
        <section class="req-recommendations" aria-label="疑似相关 session">
          <h2 class="op-section-title">疑似相关 Session（{recommendations.length}）</h2>
          <p class="muted small" style="margin-bottom: 8px;">根据标题、路径和关键词匹配推荐，点击右侧按钮一键绑定。</p>
          <ul class="req-reco-list">
            {recommendations.map((reco) => (
              <li class="req-reco-item">
                <div class="req-reco-info">
                  <a href={`/session?id=${encodeURIComponent(reco.session.id)}`}>
                    <code>{reco.session.id.slice(0, 20)}…</code>
                  </a>
                  <span class="req-reco-title">{reco.session.title || ""}</span>
                  <span class="muted small">{formatRelAgo(reco.session.updated || reco.session.created)}</span>
                </div>
                <div class="req-reco-meta">
                  <span class="req-reco-score muted small">{reco.score} 分</span>
                  <span class="req-reco-reasons muted small">{reco.reasons.slice(0, 3).join(" · ")}</span>
                  <form method="post" action="/api/requirement/associate" class="req-extract-trigger-form">
                    <input type="hidden" name="reqId" value={req.id} />
                    <input type="hidden" name="sessionId" value={reco.session.id} />
                    <button type="submit" class="btn btn-secondary req-reco-bind" title="绑定此 session 到当前需求">绑定</button>
                  </form>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <div class="req-status-flow">
        {REQ_STATUSES.map((s, i) => {
          const cls = i === currentIdx ? "req-flow-step active" : i < currentIdx ? "req-flow-step done" : "req-flow-step"
          return <span class={cls}>{s}</span>
        })}
      </div>

      {canSwitch ? (
        <section class="req-status-switcher" aria-label="切换需求状态">
          <div class="req-status-switcher-row">
            <form method="post" action="/api/requirement/status" class="req-status-form">
              <input type="hidden" name="reqId" value={req.id} />
              <input type="hidden" name="redirect" value={`/requirement?id=${encodeURIComponent(req.id)}`} />
              <label class="field-label" for={`req-status-select-${req.id}`}>切换到</label>
              <select id={`req-status-select-${req.id}`} name="status" required>
                {REQ_STATUSES.map((s) => (
                  <option value={s} selected={s === req.status}>{s}</option>
                ))}
              </select>
              <input type="text" name="note" placeholder="备注（可选）" class="req-status-note" maxlength={200} />
              <button type="submit" class="btn btn-secondary">应用</button>
            </form>
            {next ? (
              <form method="post" action="/api/requirement/status" class="req-status-form req-status-next">
                <input type="hidden" name="reqId" value={req.id} />
                <input type="hidden" name="status" value={next} />
                <input type="hidden" name="redirect" value={`/requirement?id=${encodeURIComponent(req.id)}`} />
                <button type="submit" class="btn btn-primary" title={`从 ${req.status} 推进到 ${next}`}>
                  推进到「{next}」 →
                </button>
              </form>
            ) : (
              <span class="muted small">已是末态</span>
            )}
          </div>
          {historyDesc.length > 0 ? (
            <details class="req-status-history">
              <summary>状态变更历史（{historyDesc.length}）</summary>
              <ol class="req-status-history-list">
                {historyDesc.map((h) => (
                  <li>
                    <span class="muted small mono">{new Date(h.at).toLocaleString("zh-CN", { hour12: false })}</span>
                    <span class={reqStatusBadgeClass(h.status)} style="margin-left: 8px;">{h.status}</span>
                    {h.from ? <span class="muted small" style="margin-left: 6px;">← {h.from}</span> : null}
                    {h.note ? <span class="muted small" style="margin-left: 8px;">— {h.note}</span> : null}
                  </li>
                ))}
              </ol>
            </details>
          ) : null}
        </section>
      ) : (
        <p class="muted small" style="margin: 6px 0 0;">合成的默认需求不支持状态切换。</p>
      )}

      {req.status === "待上线" && req.reqDir ? (() => {
        const checklist = buildReleaseChecklist({
          meta: undefined,
          branch: branchContent,
          config: configContent,
          test: testContent,
          notes: notesContent,
          review: reviewContent,
        })
        return <ReleaseChecklistCard checklist={checklist} />
      })() : null}

      {description ? (
        <section class="req-hermes-section">
          <h2 class="op-section-title">描述</h2>
          <pre style="white-space: pre-wrap; padding: 10px; border: 1px solid var(--op-border, #2a2a2a); border-radius: 4px; background: var(--op-bg-soft, #181818);">{description}</pre>
        </section>
      ) : null}

      <HermesFileSection title="需求记忆" content={memoryContent} />
      <HermesFileSection title="需求背景" content={backgroundContent} />
      <HermesFileSection title="分支信息" content={branchContent} />
      <HermesFileSection title="开发笔记" content={notesContent} />
      <HermesFileSection title="测试范围" content={testContent} />
      <HermesFileSection title="配置变更" content={configContent} />
      <HermesFileSection title="上线 Review" content={reviewContent} />

      {extractHistory.length > 0 ? (
        <section class="req-extract-history" aria-label="上下文提取历史">
          <h2 class="op-section-title">提取历史（最近 {extractHistory.length} 次）</h2>
          <ol class="req-extract-history-list">
            {extractHistory.map((h) => (
              <li class={`req-extract-history-item req-extract-history-${h.state}`}>
                <span class="muted small mono">{new Date(h.doneAt).toLocaleString("zh-CN", { hour12: false })}</span>
                <span class={`req-status-badge req-status-${h.state === "done" ? "done" : "testing"}`} style="margin-left: 6px;">
                  {h.state === "done" ? "✓" : "✗"} {h.mode === "auto" ? "智能提取" : "摘要"}
                </span>
                <span class="muted small" style="margin-left: 6px;">{h.sessionId.slice(0, 16)}…</span>
                {h.salvagedFromFork ? <span class="muted small" style="margin-left: 4px;">（fork 救回）</span> : null}
                {h.summary ? <div class="req-extract-history-summary muted small">{h.summary}</div> : null}
                {h.errorMessage ? <div class="req-extract-history-error muted small">{h.errorMessage}</div> : null}
              </li>
            ))}
          </ol>
        </section>
      ) : null}

      <section class="req-sessions">
        <h2 class="op-section-title">关联 Sessions ({associated.length})</h2>
        {associated.length === 0 ? (
          <p class="muted small">暂无关联的 session。</p>
        ) : (
          <ul class="req-session-list">
            {sortByLastUsedDesc(associated).map((s, i) => (
              <li>
                <a href={`/session?id=${encodeURIComponent(s.id)}&req=${encodeURIComponent(req.id)}`}>
                  <code>{s.id}</code>
                </a>
                {i === 0 ? <span class="req-session-badge">上次使用</span> : null}
                <span class="muted small">{s.title || ""}</span>
                <span class="muted small">{formatRelAgo(s.updated || s.created)}</span>
                <button
                  type="button"
                  class="req-copy-cmd-inline"
                  data-copy-cmd={`opencode -s ${s.id}`}
                  title={`复制 \`opencode -s ${s.id}\` 到剪贴板`}
                >
                  📋 复制
                </button>
                <form
                  method="post"
                  action="/api/requirement/extract-context"
                  class="req-extract-trigger-form req-extract-trigger-inline"
                  data-extract-trigger=""
                >
                  <input type="hidden" name="reqId" value={req.id} />
                  <input type="hidden" name="sessionId" value={s.id} />
                  <button
                    type="submit"
                    class="muted small req-extract-link-inline"
                    title="让 opencode 后台总结这个 session 的对话，完成后顶部提示进入预览页"
                  >
                    提取上下文 →
                  </button>
                </form>
                <a class="muted small req-extract-link-inline" href={`/requirement/recall?reqId=${encodeURIComponent(req.id)}&sessionId=${encodeURIComponent(s.id)}`} title="只读召回这个历史 session 的文本上下文">
                  召回历史 →
                </a>
              </li>
            ))}
          </ul>
        )}

        <div class="req-form-actions" style="margin-top: 12px;">
          <button type="button" class="btn btn-primary req-new-session-btn" data-req-id={req.id}>新建 Session</button>
          <span class="req-new-session-result" data-req-id={req.id}></span>
        </div>

        {unassociated.length > 0 ? (
          <form method="post" action="/api/requirement/associate" class="req-form-actions" style="margin-top: 12px;">
            <input type="hidden" name="reqId" value={req.id} />
            <SessionPicker
              candidates={unassociated}
              listId={`unbound-sessions-bottom-${req.id}`}
              placeholder={`筛选 ${unassociated.length} 个孤儿 session…`}
            />
            <button type="submit" class="btn btn-secondary">关联已有 Session</button>
          </form>
        ) : null}
      </section>
      </>
      )}
      </div>
      <script src="/static/req-detail.js" defer></script>
    </Layout>
  )
}

/**
 * Preview page for the "extract context from session" flow.
 *
 * The page is rendered in three modes, driven by `job`:
 *   - `job === null`            : "no in-flight job" placeholder with
 *     a "回到需求页" button. Reachable when the user opens a stale URL.
 *   - `job.state === "running"` : "still working" card; the inline JS
 *     polls /api/extract/job/:id and reloads the page when state flips.
 *   - `job.state === "done"`    : the editable textarea + commit form.
 *   - `job.state === "failed"`  : a read-only error block with stderr
 *     snippet + a "retry" button (POSTs a fresh start through the
 *     existing detail-page button rather than spawning here).
 *
 * Why a dedicated page: we want a human-in-the-loop checkpoint between
 * "opencode generated a summary" and "the summary is committed to
 * notes.md". The body lives in an editable <textarea> so the user can
 * trim or rewrite before committing.
 */
const RequirementExtractPreviewPage: FC<{
  req: Requirement
  sessionId: string
  job: ExtractJob | null
}> = ({ req, sessionId, job }) => {
  const backHref = `/requirement?id=${encodeURIComponent(req.id)}`
  const elapsedMs = job ? (job.doneAt ?? Date.now()) - job.startedAt : 0
  return (
    <Layout title={`提取上下文 — ${req.title}`} active="requirements">
      <div class="req-extract">
        <div class="page-header">
          <a href={backHref} class="back-link">← 返回需求 {req.title}</a>
          <h1>从 session 提取上下文</h1>
          <div class="meta-grid">
            <div><span class="field-label">需求</span> {req.title} <span class={reqStatusBadgeClass(req.status)} style="margin-left: 6px;">{req.status}</span></div>
            <div><span class="field-label">Session</span> <code>{sessionId}</code></div>
            {job ? <div><span class="field-label">耗时</span> {(elapsedMs / 1000).toFixed(1)}s</div> : null}
          </div>
        </div>

        {job === null ? (
          <section class="req-extract-error" aria-label="无任务">
            <p class="req-extract-error-msg">
              <strong>找不到任务</strong>：可能已超过 30 分钟被自动清理，或服务重启后任务丢失。
            </p>
            <div class="req-extract-actions">
              <a href={backHref} class="btn btn-secondary">返回需求</a>
              <span class="muted small">回到需求页后重新点击「提取上下文」即可重启一次。</span>
            </div>
          </section>
        ) : job.state === "running" ? (
          <section class="req-extract-running" aria-label="生成中" data-job-id={job.id} data-req-id={req.id}>
            <p>
              <span class="req-extract-spinner" aria-hidden="true"></span>
              <strong>opencode 正在生成摘要…</strong>
            </p>
            <p class="muted small">
              已运行 <span class="js-extract-elapsed">{(elapsedMs / 1000).toFixed(0)}</span> 秒。完成后此页会自动刷新；你也可以关闭页面，稍后通过需求页顶部 toast 进入。
            </p>
            <div class="req-extract-actions">
              <a href={backHref} class="btn btn-secondary">返回需求页等待</a>
            </div>
          </section>
        ) : job.state === "done" ? (
          <section class="req-extract-preview" aria-label="摘要预览">
            {job.salvagedFromFork ? (
              <div class="req-extract-salvage-banner" role="status">
                <strong>已从 fork session 救回摘要</strong>
                ：opencode 子进程虽未正常退出，但 LLM 已在副本会话里写完了内容。下面的文本直接取自该 fork。
                {job.forkSessionId ? (
                  <>
                    {" "}副本：<code>{job.forkSessionId}</code>
                    {job.forkTitle ? <span class="muted small"> · {job.forkTitle}</span> : null}
                    {" "}<a href={`/session?id=${encodeURIComponent(job.forkSessionId)}`} class="op-toast-btn" target="_blank" rel="noopener">打开 fork session</a>
                  </>
                ) : null}
              </div>
            ) : null}
            <p class="muted small">
              下面是 <code>opencode</code> 生成的摘要。<strong>不会自动写入</strong> notes.md —
              你可以直接编辑文本框内的内容，确认后点击「合并到 notes.md」。如不满意，直接「取消」即可。
            </p>
            <form method="post" action="/api/requirement/extract-context/commit" class="req-extract-form">
              <input type="hidden" name="reqId" value={req.id} />
              <input type="hidden" name="sessionId" value={sessionId} />
              <textarea
                name="body"
                class="req-extract-body"
                rows={24}
                spellcheck={false}
                aria-label="摘要正文"
              >{job.stdout}</textarea>
              <div class="req-extract-actions">
                <button type="submit" class="btn btn-primary">合并到 notes.md</button>
                <a href={backHref} class="btn btn-secondary">取消</a>
                <span class="muted small">
                  追加到需求目录下的 <code>notes.md</code>，附时间戳与 session id 标题。
                </span>
              </div>
            </form>
          </section>
        ) : (
          <section class="req-extract-error" aria-label="摘要失败">
            <p class="req-extract-error-msg">
              <strong>生成失败</strong>：{job.errorMessage || "未知错误"}
            </p>
            <dl class="req-extract-error-detail">
              <dt>退出码</dt><dd>{String(job.exitCode)}</dd>
              <dt>超时</dt><dd>{job.timedOut ? "是" : "否"}</dd>
              <dt>已捕获</dt><dd>{job.stdout.length} 字节</dd>
              {job.stderr ? (<>
                <dt>stderr 摘要</dt>
                <dd><pre class="req-extract-stderr">{job.stderr.slice(0, 2000)}</pre></dd>
              </>) : null}
            </dl>
            {/*
              Salvage branch: when the LLM already wrote markdown before
              we killed the process, let the user keep it. The same
              commit endpoint is used; we just exit the read-only error
              card into an editable form.
            */}
            {job.stdout.length > 0 ? (
              <div class="req-extract-salvage" aria-label="抢救已捕获的摘要">
                <p class="muted small">
                  虽然 opencode 没有按时退出，但 stdout 里已经有一段可用的摘要文本。下面是抢救出来的部分；你可以编辑后照常合并到 notes.md。
                </p>
                <form method="post" action="/api/requirement/extract-context/commit" class="req-extract-form">
                  <input type="hidden" name="reqId" value={req.id} />
                  <input type="hidden" name="sessionId" value={sessionId} />
                  <textarea
                    name="body"
                    class="req-extract-body"
                    rows={18}
                    spellcheck={false}
                    aria-label="抢救摘要正文"
                  >{job.stdout}</textarea>
                  <div class="req-extract-actions">
                    <button type="submit" class="btn btn-primary">合并已捕获文本到 notes.md</button>
                  </div>
                </form>
              </div>
            ) : null}
            <div class="req-extract-actions">
              <form method="post" action="/api/requirement/extract-context" class="req-extract-retry-form">
                <input type="hidden" name="reqId" value={req.id} />
                <input type="hidden" name="sessionId" value={sessionId} />
                <button type="submit" class="btn btn-secondary">重试</button>
              </form>
              <a href={backHref} class="btn btn-secondary">返回需求</a>
            </div>
          </section>
        )}
      </div>
      <script src="/static/req-detail.js" defer></script>
    </Layout>
  )
}

const RequirementRecallPage: FC<{
  req: Requirement
  sessionId: string
  markdown: string
  partCount: number
}> = ({ req, sessionId, markdown, partCount }) => {
  const backHref = `/requirement?id=${encodeURIComponent(req.id)}`
  return (
    <Layout title={`召回历史 — ${req.title}`} active="requirements">
      <div class="req-extract">
        <div class="page-header">
          <a href={backHref} class="back-link">← 返回需求 {req.title}</a>
          <h1>历史 Session 召回</h1>
          <div class="meta-grid">
            <div><span class="field-label">需求</span> {req.title}</div>
            <div><span class="field-label">Session</span> <code>{sessionId}</code></div>
            <div><span class="field-label">Text parts</span> {partCount}</div>
          </div>
        </div>
        <section class="req-extract-preview" aria-label="历史 session 召回内容">
          <p class="muted small">
            这是从 OpenCode SQLite 直接读取的只读文本片段；已过滤 reasoning、tool、step 和非文本 part。用于人工或 AI 按需追溯，不会自动写入需求文件。
          </p>
          {markdown ? (
            <pre class="req-extract-body" style="white-space: pre-wrap; overflow: auto; max-height: 70vh;">{markdown}</pre>
          ) : (
            <div class="auto-extract-empty">
              <p>没有读到可召回的文本片段。可能该 session 不在本机 SQLite 中，或只有工具/流程片段。</p>
              <a href={backHref} class="btn btn-secondary">返回需求</a>
            </div>
          )}
        </section>
      </div>
    </Layout>
  )
}

// ---------------------------------------------------------------------------
// Hono app
// ---------------------------------------------------------------------------

/**
 * Parse the `days` query parameter for the sessions page time filter.
 * - missing / invalid / negative -> default 7 days
 * - 0 -> "all time" (no filter)
 * - positive integer -> that many days
 */
function parseDaysParam(raw: string | undefined): number {
  if (!raw) return 7
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 0) return 7
  return Math.floor(n)
}

const app = new Hono()

// Static files under /static/* (public/ dir).
app.get("/static/*", async (c) => {
  const path = c.req.path.replace("/static/", "")
  // Refuse to escape public/ via "..".
  if (path.includes("..") || path.startsWith("/")) return c.text("Forbidden", 403)
  const filePath = join(PUBLIC_DIR, path)
  try {
    const content = await readFile(filePath)
    const ext = path.split(".").pop()?.toLowerCase() ?? ""
    const contentType =
      ext === "css" ? "text/css" :
      ext === "js" ? "application/javascript" :
      ext === "mjs" ? "application/javascript" :
      "text/plain"
    return new Response(content, { headers: { "Content-Type": contentType, "Cache-Control": "no-cache" } })
  } catch {
    return c.text("Not found", 404)
  }
})

// Vendor xterm browser assets out of node_modules without copying.
function vendorFile(pkg: string, rel: string, contentType: string) {
  return async (c: any) => {
    const safeRel = rel.replace(/^\/+/, "")
    if (safeRel.includes("..") || safeRel.startsWith("/")) return c.text("Forbidden", 403)
    const filePath = join(NODE_MODULES_DIR, pkg, safeRel)
    if (!existsSync(filePath)) return c.text("Not found", 404)
    try {
      const content = await readFile(filePath)
      return new Response(content, {
        headers: {
          "Content-Type": contentType,
          "Cache-Control": "public, max-age=3600",
        },
      })
    } catch {
      return c.text("Not found", 404)
    }
  }
}

app.get("/vendor/xterm/xterm.css", vendorFile("@xterm/xterm", "css/xterm.css", "text/css"))
app.get("/vendor/xterm/xterm.js", vendorFile("@xterm/xterm", "lib/xterm.js", "application/javascript"))
app.get("/vendor/xterm-addon-fit/addon-fit.js", vendorFile("@xterm/addon-fit", "lib/addon-fit.js", "application/javascript"))

// Projects (requirements) landing page — the site homepage.
async function renderProjectsPage(c: Context) {
  const statusFilter = c.req.query("status") || ""
  const showCompleted = c.req.query("showCompleted") === "1"
  const groups = await listRequirementsByProject()
  const counts: Record<ReqStatus, number> = {
    "待设计": 0,
    "待开发": 0,
    "开发中": 0,
    "自测中": 0,
    "测试中": 0,
    "待上线": 0,
    "已完成": 0,
  }
  for (const g of groups) {
    for (const r of g.requirements) counts[r.status] += 1
  }
  return c.html(<ProjectsPage groups={groups} counts={counts} statusFilter={statusFilter} showCompleted={showCompleted} />)
}

app.get("/", async (c) => renderProjectsPage(c))

// Sessions landing page (was previously at "/")
app.get("/sessions", async (c) => {
  const days = parseDaysParam(c.req.query("days"))
  const maxAgeMs = days > 0 ? days * 24 * 60 * 60 * 1000 : undefined
  const sessions = await scanSessions(false, maxAgeMs)
  const summary = summarizeSessions(sessions)
  return c.html(<SessionsPage sessions={sessions} summary={summary} days={days} />)
})

// Refresh cache: re-scan sessions.
app.get("/sessions/refresh", async (c) => {
  const days = parseDaysParam(c.req.query("days"))
  const maxAgeMs = days > 0 ? days * 24 * 60 * 60 * 1000 : undefined
  const sessions = await scanSessions(true, maxAgeMs)
  const summary = summarizeSessions(sessions)
  return c.html(<SessionsPage sessions={sessions} summary={summary} days={days} />)
})

// Reports list (the original / path moved here)
app.get("/reports", async (c) => {
  const reports = await scanReports()
  const enriched = await Promise.all(
    reports
      .filter((r) => r.highCount > 0 || r.mediumCount > 0)
      .map(async (r) => {
        const status = await getConfirmationStatus(r.reportPath)
        return { ...r, confirmedCount: status.confirmedIds.length, rejectedCount: status.rejectedIds.length }
      }),
  )
  return c.html(<ReportListPage reports={enriched} />)
})

// Backwards-compatible redirect: /report (no s) -> /reports
app.get("/report", async (c) => {
  const rawPath = c.req.query("path")
  if (!rawPath) {
    return c.redirect("/reports", 302)
  }
  const reportPath = resolveHandoffPath(rawPath)
  if (!reportPath) {
    return c.text("Forbidden path", 403)
  }
  const report = await getReport(reportPath)
  if (!report) return c.text("Report not found", 404)
  const confirmation = await getConfirmationStatus(reportPath)
  return c.html(<ReportDetailPage report={report} reportPath={reportPath} confirmation={confirmation} />)
})

// Embedded terminal page
app.get("/session", async (c) => {
  const id = c.req.query("id")
  const reqIdParam = c.req.query("req")
  const newMode = c.req.query("new") === "1"

  // In "new" mode we don't require an id — opencode will create a real
  // session id when the PTY starts, and we'll push it back to the page.
  if (!newMode) {
    if (!id) {
      return c.text("Missing session id", 400)
    }
    if (!isValidSessionId(id)) {
      return c.text("Invalid session id", 400)
    }
  } else if (id && !isValidSessionId(id)) {
    return c.text("Invalid session id", 400)
  }

  let session: SessionInfo | null = id ? await getSession(id) : null
  let req: Requirement | null = null
  if (reqIdParam) {
    req = await getRequirement(reqIdParam)
  }
  if (!session && newMode) {
    // "new" mode: synthesize a placeholder row so the terminal page can
    // render before opencode has created the underlying session row.
    // The WS handler will spawn `opencode run -i` and push back the
    // real id once OpenCode persists it.
    const now = Date.now()
    session = {
      id: id ?? "",
      title: "New session",
      status: "running",
      source: "fs",
      created: now,
      updated: now,
      projectId: "",
      directory: "",
    }
  }
  if (!session) {
    // Either no id was given (already handled above) OR the given id is
    // a "ghost" — not present in the OpenCode store. Refuse to spawn
    // `opencode --session <ghost>` because OpenCode will exit with
    // "Session not found". Direct the user back to the requirement so
    // they can pick "新建" or "关联已有 session" explicitly.
    return c.html(<SessionMissingPage id={id ?? ""} backReqId={req?.id} />, 404)
  }
  // If req param wasn't supplied, fall back to the requirement that
  // already owns this session (so the panel renders even without a
  // ?req= query string).
  if (!req && id) {
    req = await getRequirementForSession(id)
  }
  const reqContext = req ? await buildInjectionContext(req.id) : ""
  return c.html(<SessionTerminalPage session={session} req={req} reqContext={reqContext} createNew={newMode} />)
})

// ---------------------------------------------------------------------------
// Requirement routes
// ---------------------------------------------------------------------------

app.get("/projects", async (c) => renderProjectsPage(c))

app.get("/requirements", (c) => c.redirect("/projects", 302))

app.get("/requirement", async (c) => {
  const id = c.req.query("id")
  if (!id) return c.text("Missing requirement id", 400)
  const req = await getRequirement(id)
  if (!req) return c.text("Requirement not found", 404)

  // Do NOT auto-create a session here, even when the requirement is in
  // an active stage with no bound sessions. The detail page renders an
  // explicit "新建" / "关联已有 Session" choice and only acts on a
  // direct user submit.

  const readFileSafe = async (path?: string): Promise<string | undefined> => {
    if (!path || !existsSync(path)) return undefined
    try {
      const raw = await readFile(path, "utf-8")
      return raw
    } catch {
      return undefined
    }
  }
  const [backgroundContent, branchContent, notesContent, testContent, configContent, memoryContent, reviewContent] = await Promise.all([
    readFileSafe(req.backgroundPath),
    readFileSafe(req.branchPath),
    readFileSafe(req.notesPath),
    readFileSafe(req.testPath),
    readFileSafe(req.configPath),
    readFileSafe(req.memoryPath),
    readFileSafe(req.reviewPath),
  ])

  const sessions = await scanSessions()
  const associatedAll = await getAllAssociatedSessionIds()
  const associated = sessions.filter((s) => req.sessionIds.includes(s.id))
  const unassociated = sessions.filter(
    (s) =>
      !s.parentId &&
      !FORK_TITLE_RE.test(s.title || "") &&
      !associatedAll.has(s.id) &&
      !req.sessionIds.includes(s.id)
  )
  const state = req.reqDir ? await readRequirementState(req.reqDir) : null

  const recommendations = req.id !== DEFAULT_REQ_ID
    ? recommendSessionsForRequirement(req, unassociated, 6)
    : []
  const extractHistory = req.id !== DEFAULT_REQ_ID
    ? await getExtractHistoryForRequirement(req.id, 6)
    : []

  // If this is a parent requirement, load its children for the detail page.
  let childReqs: Requirement[] = []
  if (req.childIds && req.childIds.length > 0) {
    const allReqs = await scanHermesRequirements()
    childReqs = allReqs.filter((r) => req.childIds!.includes(r.id))
    // Attach session counts.
    const store = await loadAssociations()
    for (const cr of childReqs) {
      cr.sessionIds = store.associations[cr.id] ?? []
    }
  }

  // If this is a child requirement, load the parent for a back-link.
  let parentReq: Requirement | null = null
  if (req.parentReqId) {
    parentReq = await getRequirement(req.parentReqId)
  }

  return c.html(
    <RequirementDetailPage
      req={req}
      associated={associated}
      unassociated={unassociated}
      backgroundContent={backgroundContent}
      branchContent={branchContent}
      notesContent={notesContent}
      testContent={testContent}
      configContent={configContent}
      memoryContent={memoryContent}
      reviewContent={reviewContent}
      state={state}
      recommendations={recommendations}
      extractHistory={extractHistory}
      childReqs={childReqs}
      parentReq={parentReq}
    />
  )
})

/**
 * POST /api/requirement/new-session
 *
 * Spawn `opencode run "<injection-context>" --title "<title>"` as a
 * detached background process, then poll the session DB for the new
 * session id. Once we have it, associate the new session with the
 * requirement and return `{ sessionId, command }` as JSON.
 *
 * The user copies the returned `opencode -s <id>` command and pastes it
 * into their terminal. This replaces the old behavior of redirecting to
 * /session?new=1 (the web-terminal PTY path) — the copyable command
 * works in any terminal without keeping a browser tab open.
 *
 * Errors:
 *   400 — missing reqId
 *   404 — requirement not found
 *   504 — opencode did not register a new session within 15s
 */
app.post("/api/requirement/new-session", async (c) => {
  const form = await c.req.formData()
  const reqId = String(form.get("reqId") || "")
  if (!reqId) return c.json({ error: "Missing reqId" }, 400)
  const req = await getRequirement(reqId)
  if (!req) return c.json({ error: "Requirement not found" }, 404)

  const ctx = await buildInjectionContext(reqId)
  const title = req.title || reqId
  const startMs = Date.now()

  // Run via the dashboard-owned process queue so background session
  // creation cannot exceed the global OpenCode process cap.
  void runQueuedOpencodeProcess({
    bin: "opencode",
    args: ["run", ctx, "--title", title],
    spawnOptions: { stdio: ["ignore", "pipe", "pipe"] },
  }).catch(() => {})

  // Poll for the newly created session id. clearSessionCache forces the
  // next scanSessions() to re-query sqlite/CLI/fs so we see the new
  // row the moment opencode commits it.
  clearSessionCache()
  const deadline = Date.now() + 15_000
  let sessionId = ""
  while (!sessionId && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500))
    clearSessionCache()
    const list = await scanSessions(true)
    const candidate = list.find(
      (s) => (s.created || 0) >= startMs,
    )
    if (candidate) {
      sessionId = candidate.id
      break
    }
  }

  if (!sessionId) {
    return c.json(
      { error: "Session creation timed out — opencode may still be starting. Check the sessions list in a moment." },
      504,
    )
  }

  // Best-effort association: do not fail the response if persistence
  // hiccups; the user can re-bind manually.
  try {
    await associateSession(reqId, sessionId)
  } catch { /* noop */ }

  return c.json({ sessionId, command: `opencode -s ${sessionId}` })
})

app.post("/api/requirement/associate", async (c) => {
  const form = await c.req.formData()
  const reqId = String(form.get("reqId") || "")
  const raw = String(form.get("sessionId") || "")
  if (!reqId || !raw) return c.text("Missing reqId or sessionId", 400)
  // Extract a `ses_...` id from the input value. The datalist-backed
  // search field stores values like "ses_xxx — title …" so users can
  // search by either id prefix or title fragment; we accept either as
  // long as a valid session id appears anywhere in the string.
  const match = raw.match(/ses_[A-Za-z0-9]+/)
  const sessionId = match ? match[0] : raw.trim()
  if (!isValidSessionId(sessionId)) {
    return c.text(`Invalid session id: ${raw}`, 400)
  }
  const exists = await getRequirement(reqId)
  if (!exists) return c.text("Requirement not found", 404)
  await associateSession(reqId, sessionId)
  return c.redirect(`/requirement?id=${encodeURIComponent(reqId)}`, 303)
})

/**
 * POST /api/requirement/dissociate
 * Body: reqId, sessionId
 *
 * Removes a session from a requirement's association list. The session
 * becomes an orphan (visible in the default requirement) unless re-associated
 * elsewhere. Used by the "解除绑定" buttons on the requirement detail page.
 */
app.post("/api/requirement/dissociate", async (c) => {
  const form = await c.req.formData()
  const reqId = String(form.get("reqId") || "")
  const sessionId = String(form.get("sessionId") || "")
  if (!reqId || !sessionId) return c.text("Missing reqId or sessionId", 400)
  if (!isValidSessionId(sessionId)) {
    return c.text("Invalid session id", 400)
  }
  const exists = await getRequirement(reqId)
  if (!exists) return c.text("Requirement not found", 404)
  await dissociateSession(reqId, sessionId)
  return c.redirect(`/requirement?id=${encodeURIComponent(reqId)}`, 303)
})

/**
 * Shared validation for both job-start and preview routes.
 *
 * Returns either a ready-to-use {req, sessionId} pair or a Hono Response
 * carrying the appropriate 4xx text. The session must already be
 * associated with the requirement — otherwise any caller could spam any
 * requirement's notes.md with any session's summary.
 */
async function resolveExtractTarget(
  reqId: string,
  sessionId: string,
): Promise<{ ok: true; req: Requirement } | { ok: false; status: 400 | 403 | 404; message: string }> {
  if (!reqId || !sessionId) return { ok: false, status: 400, message: "Missing reqId or sessionId" }
  if (!isValidSessionId(sessionId)) return { ok: false, status: 400, message: "Invalid sessionId" }
  const req = await getRequirement(reqId)
  if (!req) return { ok: false, status: 404, message: "Requirement not found" }
  if (!req.sessionIds.includes(sessionId)) {
    return { ok: false, status: 403, message: "Session is not associated with this requirement" }
  }
  if (!req.reqDir) {
    return { ok: false, status: 400, message: "This requirement has no on-disk directory; cannot extract." }
  }
  return { ok: true, req }
}

/**
 * Serialize an `ExtractJob` for the polling endpoint.
 *
 * We do NOT include the full stdout/stderr while the job is still
 * running (they're empty anyway) and we clip stderr to 2KB on the
 * client-facing payload so a runaway opencode log can't bloat polling.
 */
function jobToJson(j: ExtractJob): Record<string, unknown> {
  return {
    id: j.id,
    reqId: j.reqId,
    sessionId: j.sessionId,
    state: j.state,
    mode: j.mode,
    model: j.model,
    startedAt: j.startedAt,
    doneAt: j.doneAt,
    exitCode: j.exitCode,
    timedOut: j.timedOut,
    errorMessage: j.errorMessage,
    stdoutLength: j.stdout.length,
    stderrSnippet: j.stderr.slice(0, 2048),
    elapsedMs: (j.doneAt ?? Date.now()) - j.startedAt,
    // Fork-salvage hints surfaced to the toast / preview page.
    forkSessionId: j.forkSessionId,
    forkTitle: j.forkTitle,
    salvagedFromFork: j.salvagedFromFork,
    // Auto-extract result summary (file counts only; full content
    // is on the preview page).
    autoFileCount: j.autoResult
      ? j.autoResult.updates.length + j.autoResult.appends.length
      : 0,
  }
}

/**
 * POST /api/requirement/extract-context
 * Body: reqId, sessionId
 *
 * Kicks off a background extract job and returns 202 with `{ jobId }`.
 * If a job for the same sessionId is already in-flight, returns 409
 * with the existing jobId so the UI can re-attach.
 */
app.post("/api/requirement/extract-context", async (c) => {
  const form = await c.req.formData()
  const reqId = String(form.get("reqId") || "")
  const sessionId = String(form.get("sessionId") || "")
  const guard = await resolveExtractTarget(reqId, sessionId)
  if (!guard.ok) return c.text(guard.message, guard.status)
  const prompt = buildExtractPrompt(guard.req)
  const cfg = await getConfig()
  try {
    const job = createExtractJob({ reqId, sessionId, prompt, model: cfg.extractModel })
    return c.json({ jobId: job.id, state: job.state }, 202)
  } catch (err) {
    if (err instanceof JobConflictError) {
      return c.json({ error: "conflict", jobId: err.existingJobId }, 409)
    }
    const msg = err instanceof Error ? err.message : String(err)
    return c.text(`Failed to start job: ${msg}`, 500)
  }
})

/**
 * GET /api/extract/job/:id
 * Returns the current job snapshot as JSON. 404 if missing or evicted.
 */
app.get("/api/extract/job/:id", (c) => {
  const id = c.req.param("id")
  const job = getExtractJob(id)
  if (!job) return c.json({ error: "not found" }, 404)
  return c.json(jobToJson(job))
})

/**
 * GET /requirement/extract?jobId=<id>
 *   or
 * GET /requirement/extract?reqId=<r>&sessionId=<s>
 *
 * Renders the preview page using a completed job's stdout. The two
 * accepted query shapes:
 *   - jobId  : the toast on the detail page links here after polling
 *     reports state ∈ {done, failed}.
 *   - reqId+sessionId : back-compat / direct deep link. If a finished
 *     job for this (sid) is in the store, we use it; if a running one
 *     exists, we render a "still working" preview that auto-redirects
 *     once it finishes (handled client-side). If neither, we surface a
 *     "no job" failure card with a "start one" button.
 */
app.get("/requirement/extract", async (c) => {
  const jobIdParam = c.req.query("jobId")
  let job: ExtractJob | null = null

  if (jobIdParam) {
    job = getExtractJob(jobIdParam)
    if (!job) return c.text("Job not found or expired", 404)
  } else {
    const reqId = String(c.req.query("reqId") || "")
    const sessionId = String(c.req.query("sessionId") || "")
    const guard = await resolveExtractTarget(reqId, sessionId)
    if (!guard.ok) return c.text(guard.message, guard.status)
    job = findRunningJobForSession(sessionId)
    // If none in-flight, we don't auto-spawn — the user is expected to
    // arrive here only via the toast. Render a minimal "no job" card
    // with a back link.
    if (!job) {
      return c.html(
        <RequirementExtractPreviewPage
          req={guard.req}
          sessionId={sessionId}
          job={null}
        />,
      )
    }
  }

  const req = await getRequirement(job.reqId)
  if (!req) return c.text("Requirement not found", 404)

  return c.html(
    <RequirementExtractPreviewPage
      req={req}
      sessionId={job.sessionId}
      job={job}
    />,
  )
})

app.get("/requirement/recall", async (c) => {
  const reqId = String(c.req.query("reqId") || "")
  const sessionId = String(c.req.query("sessionId") || "")
  const guard = await resolveExtractTarget(reqId, sessionId)
  if (!guard.ok) return c.text(guard.message, guard.status)
  const parts = await readSessionTranscript({ sessionId, limitParts: 240, maxTextChars: 6_000 })
  const markdown = buildRecallMarkdown(parts)
  return c.html(<RequirementRecallPage req={guard.req} sessionId={sessionId} markdown={markdown} partCount={parts.length} />)
})

app.get("/api/session/transcript", async (c) => {
  const sessionId = String(c.req.query("id") || "")
  if (!isValidSessionId(sessionId)) return c.json({ error: "Invalid session id" }, 400)
  const parts = await readSessionTranscript({ sessionId })
  return c.json({ sessionId, parts, markdown: buildRecallMarkdown(parts) })
})

// POST /api/requirement/extract-context/commit
// Append the (user-edited) summary body to <reqDir>/notes.md and
// redirect back to the requirement page. Same validation as GET above.
app.post("/api/requirement/extract-context/commit", async (c) => {
  const form = await c.req.formData()
  const reqId = String(form.get("reqId") || "")
  const sessionId = String(form.get("sessionId") || "")
  const body = String(form.get("body") || "")
  const guard = await resolveExtractTarget(reqId, sessionId)
  if (!guard.ok) return c.text(guard.message, guard.status)
  if (!body.trim()) return c.text("Body is empty; refusing to commit.", 400)
  const notesPath = guard.req.notesPath ?? join(guard.req.reqDir!, "notes.md")
  try {
    await appendSummaryToNotes(notesPath, sessionId, body)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return c.text(`Failed to write notes.md: ${msg}`, 500)
  }
  return c.redirect(`/requirement?id=${encodeURIComponent(reqId)}`, 303)
})

// Switch a requirement's status. Writes <reqDir>/state.json atomically
// and appends a history entry. Refuses synthetic / non-Hermes requirements
// (DEFAULT_REQ_ID has no reqDir).
app.post("/api/requirement/status", async (c) => {
  const form = await c.req.formData()
  const reqId = String(form.get("reqId") || "")
  const rawStatus = String(form.get("status") || "")
  const note = String(form.get("note") || "")
  const redirectBack = String(form.get("redirect") || "") || `/requirement?id=${encodeURIComponent(reqId)}`
  if (!reqId) return c.text("Missing reqId", 400)
  if (!(REQ_STATUSES as readonly string[]).includes(rawStatus)) {
    return c.text(`Invalid status: ${rawStatus}`, 400)
  }
  const status = rawStatus as ReqStatus
  const req = await getRequirement(reqId)
  if (!req) return c.text("Requirement not found", 404)
  if (!req.reqDir) {
    return c.text("Requirement has no on-disk directory (synthetic default cannot be updated)", 400)
  }
  try {
    await writeRequirementStatus(req.reqDir, status, note || undefined)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return c.text(`Failed to write state: ${message}`, 500)
  }
  // Tolerate fetch/XHR callers that prefer JSON; default to redirect.
  const accept = c.req.header("accept") || ""
  if (accept.includes("application/json")) {
    return c.json({ ok: true, status })
  }
  return c.redirect(redirectBack, 303)
})

// ---------------------------------------------------------------------------
// Schedulers page
// ---------------------------------------------------------------------------

const SchedulersPage: FC<{
  schedulers: {
    name: string
    running: boolean
    pollIntervalMs: number | null
    pollIntervalLabel: string
    enabled: boolean
    description: string
    details: { label: string; value: string }[]
  }[]
  extractQueues: { reqId: string; queueLength: number; nextAvailableAt: number }[]
  valuationCandidates: { sessionId: string; score: number; reasons: string[]; signals: string[] }[]
  valuationStats: { lastPollAt: number | null; sessionsScanned: number; candidatesFound: number; threshold: number }
}> = ({ schedulers, extractQueues, valuationCandidates, valuationStats }) => {
  return (
    <Layout title="Schedulers" active="schedulers">
      <header class="op-section-head">
        <h1 class="op-section-title">BACKGROUND SCHEDULERS</h1>
        <div class="op-section-meta">
          <span class="op-section-meta-item">{schedulers.filter((s) => s.running).length} / {schedulers.length} RUNNING</span>
        </div>
      </header>

      <div class="sched-list">
        {schedulers.map((s) => (
          <div class={`sched-card${s.running ? " sched-card-running" : ""}`}>
            <div class="sched-card-head">
              <span class={`sched-dot sched-dot-${s.running ? "on" : "off"}`}></span>
              <span class="sched-card-name">{s.name}</span>
              <span class="sched-card-status">{s.running ? "running" : "stopped"}</span>
            </div>
            <div class="sched-card-body">
              <p class="sched-card-desc muted small">{s.description}</p>
              <div class="sched-card-meta">
                <span class="sched-meta-item">间隔 <code>{s.pollIntervalLabel}</code></span>
                <span class="sched-meta-item">配置 <code>{s.enabled ? "enabled" : "disabled"}</code></span>
              </div>
              {s.details.length > 0 ? (
                <dl class="sched-card-details">
                  {s.details.map((d) => (
                    <div class="sched-detail-row">
                      <dt class="sched-detail-k muted small">{d.label}</dt>
                      <dd class="sched-detail-v">{d.value}</dd>
                    </div>
                  ))}
                </dl>
              ) : null}
            </div>
          </div>
        ))}
      </div>

      {valuationCandidates.length > 0 ? (
        <section class="sched-queues">
          <h2 class="op-section-title" style="font-size: 0.9rem; margin-top: 20px;">VALUATION CANDIDATES</h2>
          <p class="muted small">自动发现的高价值 session 候选（score ≥ {valuationStats.threshold}），点击 session ID 可查看详情。</p>
          <table class="sched-queue-table">
            <thead>
              <tr><th>Session</th><th>Score</th><th>Signals</th><th>Reasons</th><th>操作</th></tr>
            </thead>
            <tbody>
              {valuationCandidates.map((c) => (
                <tr>
                  <td><a href={`/session?id=${encodeURIComponent(c.sessionId)}`}><code>{c.sessionId.slice(0, 16)}…</code></a></td>
                  <td><strong>{c.score}</strong></td>
                  <td>{c.signals.join(", ")}</td>
                  <td class="muted small" style="max-width: 400px">{c.reasons.slice(0, 3).join("； ")}</td>
                  <td>
                    <form method="post" action="/api/valuation/mark" style="display:inline">
                      <input type="hidden" name="sessionId" value={c.sessionId} />
                      <button type="submit" class="btn btn-sm btn-primary">标记</button>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : null}

      {extractQueues.length > 0 ? (
        <section class="sched-queues">
          <h2 class="op-section-title" style="font-size: 0.9rem; margin-top: 20px;">EXTRACT QUEUES</h2>
          <p class="muted small">同需求智能提取延时队列，每个需求排队中的任务间隔 5 分钟。</p>
          <table class="sched-queue-table">
            <thead>
              <tr><th>需求 ID</th><th>排队数</th><th>下一个可用时间</th></tr>
            </thead>
            <tbody>
              {extractQueues.map((q) => (
                <tr>
                  <td><code>{q.reqId}</code></td>
                  <td>{q.queueLength}</td>
                  <td>{q.nextAvailableAt > Date.now() ? formatRelAgo(q.nextAvailableAt) : "现在"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : null}
    </Layout>
  )
}

app.get("/schedulers", async (c) => {
  const cfg = await getConfig()
  const allMarkers = listMarkers()
  const processable = allMarkers.filter((m) => m.status === "marked")
  const summarizing = allMarkers.filter((m) => m.status === "summarizing")
  const summarized = allMarkers.filter((m) => m.status === "summarized")
  const failed = allMarkers.filter((m) => m.status === "failed")

  // Collect active extract queues from all requirements.
  const extractQueues: { reqId: string; queueLength: number; nextAvailableAt: number }[] = []

  const schedulers = [
    {
      name: "OpenCode 全量同步",
      running: isFullSyncSchedulerRunning(),
      pollIntervalMs: FULL_SYNC_POLL_MS,
      pollIntervalLabel: `${String(FULL_SYNC_HOUR).padStart(2, "0")}:${String(FULL_SYNC_MINUTE).padStart(2, "0")}`,
      enabled: cfg.fullSyncSchedule,
      description: "每天本地 20:30 触发一次 OpenCode 配置全量同步；这是唯一保留的自动同步机制。",
      details: (() => {
        const last = getLastFullSyncResult()
        return [
          { label: "配置开关", value: cfg.fullSyncSchedule ? "✅ fullSyncSchedule = true" : "❌ fullSyncSchedule = false" },
          { label: "上次结果", value: last ? (last.ok ? "success" : `failed: ${last.stderr || last.exitCode}`) : "本进程尚未执行" },
        ]
      })(),
    },
    {
      name: "定时智能提取",
      running: isAutoExtractSchedulerRunning(),
      pollIntervalMs: AUTO_EXTRACT_POLL_MS,
      pollIntervalLabel: "00:00",
      enabled: cfg.autoExtractSchedule,
      description: "每天本地 00:00 触发一次：只检查最近 24 小时内创建或更新过的需求 session；首次未提取或有新增内容时生成智能提取预览。",
      details: [
        { label: "配置开关", value: cfg.autoExtractSchedule ? "✅ autoExtractSchedule = true" : "❌ autoExtractSchedule = false" },
        { label: "提取模型", value: cfg.extractModel || "(default)" },
      ],
    },
    {
      name: "经验自动总结",
      running: isAutoSummaryWorkerRunning(),
      pollIntervalMs: 24 * 60 * 60 * 1000,
      pollIntervalLabel: "01:00",
      enabled: true,
      description: "每天本地 01:00 触发一次：只检查最近 24 小时内创建或更新过、且已空闲 ≥1 小时的已标记 session，自动 fork 生成经验报告。",
      details: [
        { label: "待处理标记", value: `${processable.length} 个（status=marked）` },
        { label: "总结中", value: `${summarizing.length} 个（status=summarizing）` },
        { label: "已完成", value: `${summarized.length} 个（status=summarized）` },
        { label: "失败", value: `${failed.length} 个（status=failed）` },
        { label: "总计标记", value: `${allMarkers.length} 个` },
      ],
    },
    {
      name: "智能提取延时队列",
      running: extractQueues.length > 0,
      pollIntervalMs: 5 * 60 * 1000,
      pollIntervalLabel: "on-demand",
      enabled: true,
      description: "同一需求的多个 session 智能提取按 5 分钟间隔排队执行，避免并发写入冲突。",
      details: extractQueues.length > 0
        ? extractQueues.map((q) => ({
            label: q.reqId,
            value: `${q.queueLength} 个排队中，下一个 ${q.nextAvailableAt > Date.now() ? formatRelAgo(q.nextAvailableAt) : "现在"}`,
          }))
        : [{ label: "状态", value: "空闲（无排队中的任务）" }],
    },
  ]

  // Valuation worker stats (always collected for display, even when disabled).
  const valStats = getValuationStats()
  const valCandidates = getRecentCandidates(10)

  const valuationScheduler = {
    name: "Session 价值发现",
    running: isAutoValuationWorkerRunning(),
    pollIntervalMs: VALUATION_POLL_MS,
    pollIntervalLabel: "10 min",
    enabled: cfg.autoValuation,
    description: "每 10 分钟扫描近 48h 的 session，通过元数据 + SQLite 内容两层评分识别有经验总结价值的 session（日志/DB 验证、skill 发现、经验纠错等）。开启后自动标记超阈值的 session 进入经验总结流程。",
    details: [
      { label: "自动标记", value: cfg.autoValuation ? "✅ autoValuation = true" : "❌ autoValuation = false（仅发现，不自动标记）" },
      { label: "阈值", value: `${cfg.valuationThreshold ?? 25}` },
      { label: "上次扫描", value: valStats.lastPollAt ? formatRelAgo(valStats.lastPollAt) : "未运行" },
      { label: "新扫描", value: `${valStats.sessionsScanned} 个` },
      { label: "内容评分", value: `${valStats.contentScored} 个` },
      { label: "候选发现", value: `${valStats.candidatesFound} 个` },
      { label: "已自动标记", value: `${valStats.autoMarked} 个` },
      { label: "已有标记跳过", value: `${valStats.alreadyMarked} 个` },
    ],
  }

  schedulers.push(valuationScheduler)

  return c.html(<SchedulersPage schedulers={schedulers} extractQueues={extractQueues} valuationCandidates={valCandidates} valuationStats={valStats} />)
})

// ---------------------------------------------------------------------------
// Settings page + config API
// ---------------------------------------------------------------------------

const SettingsPage: FC<{ config: AppConfig }> = ({ config }) => (
  <Layout title="Settings" active="requirements">
    <div class="settings-page">
      <div class="page-header">
        <a href="/projects" class="back-link">← Back to projects</a>
        <h1>Dashboard 设置</h1>
      </div>

      <section class="settings-section">
        <h2 class="op-section-title">上下文提取</h2>
        <form id="config-form" class="settings-form">
          <div class="settings-field">
            <label class="settings-label">
              <input
                type="checkbox"
                name="fullSyncSchedule"
                id="cfg-full-sync-schedule"
                checked={config.fullSyncSchedule}
              />
              <span>每日 20:30 全量同步</span>
            </label>
            <p class="muted small">
              开启后，dashboard 每晚 20:30 运行一次 <code>opencode-cron-sync.sh --full</code>。其它高频自动同步机制应保持关闭。
            </p>
          </div>

          <div class="settings-field">
            <label class="settings-label">
              <input
                type="checkbox"
                name="autoExtract"
                id="cfg-auto-extract"
                checked={config.autoExtract}
              />
              <span>自动提取模式</span>
            </label>
            <p class="muted small">
              开启后，当关联 session 进入 idle 状态且消息增量超过阈值时，自动触发上下文提取。关闭则只能手动点击「提取上下文」。
            </p>
          </div>

          <div class="settings-field">
            <label class="settings-label">
              <input
                type="checkbox"
                name="autoExtractSchedule"
                id="cfg-auto-extract-schedule"
                checked={config.autoExtractSchedule}
              />
              <span>定时智能提取</span>
            </label>
            <p class="muted small">
              开启后，后台每天本地 00:00 触发一次：只检查最近 24 小时内创建或更新过的需求 session；首次未提取或有新增内容时生成智能提取预览。
            </p>
          </div>

          <div class="settings-field">
            <label class="settings-label" for="cfg-model">提取模型</label>
            <input
              type="text"
              id="cfg-model"
              name="extractModel"
              value={config.extractModel}
              class="settings-input"
              spellcheck={false}
            />
            <p class="muted small">
              用于 <code>opencode run --fork</code> 的模型 ID。默认 <code>litellm-local/deepseek-v4-flash-auto</code>。
            </p>
          </div>

          <div class="settings-field">
            <label class="settings-label" for="cfg-min-change">最小消息增量</label>
            <input
              type="number"
              id="cfg-min-change"
              name="minChangeMessages"
              value={config.minChangeMessages}
              min={1}
              max={100}
              class="settings-input settings-input-narrow"
            />
            <p class="muted small">
              自动模式下，session 新增消息数低于此值时不触发提取（避免浪费 token）。
            </p>
          </div>

          <h2 class="op-section-title" style="font-size: 0.85rem; margin-top: 24px;">Session 价值发现</h2>

          <div class="settings-field">
            <label class="settings-label">
              <input
                type="checkbox"
                name="autoValuation"
                id="cfg-auto-valuation"
                checked={config.autoValuation}
              />
              <span>自动标记高价值 session</span>
            </label>
            <p class="muted small">
              开启后，后台每 10 分钟扫描近 48h 的 session，通过元数据 + SQLite 内容两层评分识别有经验总结价值的 session，自动标记进入经验总结流程。关闭则只发现在 <a href="/schedulers">Schedulers</a> 页面展示候选列表，不自动标记。
            </p>
          </div>

          <div class="settings-field">
            <label class="settings-label" for="cfg-valuation-threshold">价值评分阈值</label>
            <input
              type="number"
              id="cfg-valuation-threshold"
              name="valuationThreshold"
              value={config.valuationThreshold}
              min={1}
              max={100}
              class="settings-input settings-input-narrow"
            />
            <p class="muted small">
              分数 ≥ 此阈值的 session 被视为候选。信号类别（验证/纠错/skill/知识/调试）各 +15 分，代码工具调用和 token 量也有加分。默认 25。
            </p>
          </div>

          <button type="submit" class="btn btn-primary">保存设置</button>
          <span id="config-saved" class="settings-saved muted small" hidden>✓ 已保存</span>
        </form>
      </section>
    </div>
    <script src="/static/config.js" defer></script>
  </Layout>
)

app.get("/settings", async (c) => {
  const config = await getConfig()
  return c.html(<SettingsPage config={config} />)
})

app.get("/api/config", async (c) => {
  const config = await getConfig()
  return c.json(config)
})

app.post("/api/config", async (c) => {
  const body = await c.req.json().catch(() => null) ?? {}
  const partial: Partial<AppConfig> = {}
  if (typeof body.autoExtract === "boolean") partial.autoExtract = body.autoExtract
  if (typeof body.autoExtractSchedule === "boolean") partial.autoExtractSchedule = body.autoExtractSchedule
  if (typeof body.fullSyncSchedule === "boolean") partial.fullSyncSchedule = body.fullSyncSchedule
  if (typeof body.extractModel === "string" && body.extractModel.trim()) partial.extractModel = body.extractModel.trim()
  if (typeof body.minChangeMessages === "number" && body.minChangeMessages > 0) partial.minChangeMessages = Math.floor(body.minChangeMessages)
  if (typeof body.autoValuation === "boolean") partial.autoValuation = body.autoValuation
  if (typeof body.valuationThreshold === "number" && body.valuationThreshold > 0) partial.valuationThreshold = Math.floor(body.valuationThreshold)
  const next = await setConfig(partial)
  return c.json(next)
})

// ---------------------------------------------------------------------------
// Auto-extract: reads all context files, asks agent to produce per-file diffs
// ---------------------------------------------------------------------------

/**
 * Read all Hermes context files from a requirement directory.
 * Returns undefined for missing files.
 */
async function readContextFiles(reqDir: string): Promise<ContextFiles> {
  const readSafe = async (name: string): Promise<string | undefined> => {
    const p = join(reqDir, name)
    if (!existsSync(p)) return undefined
    try {
      return await readFile(p, "utf-8")
    } catch {
      return undefined
    }
  }
  const [meta, memory, branch, config, test, notes, review] = await Promise.all([
    readSafe("meta.md"),
    readSafe("memory.md"),
    readSafe("branch.md"),
    readSafe("config-changes.md"),
    readSafe("test.md"),
    readSafe("notes.md"),
    readSafe("review.md"),
  ])
  return { meta, memory, branch, config, test, notes, review }
}

/**
 * POST /api/requirement/auto-extract
 * Body: reqId, sessionId
 *
 * Kicks off a background auto-extract job that reads all context files,
 * builds a rich prompt, and asks the agent to produce per-file diffs.
 */
app.post("/api/requirement/auto-extract", async (c) => {
  const form = await c.req.formData()
  const reqId = String(form.get("reqId") || "")
  const sessionId = String(form.get("sessionId") || "")
  const guard = await resolveExtractTarget(reqId, sessionId)
  if (!guard.ok) return c.text(guard.message, guard.status)

  // Debounce + no-new-content guard: prevent rapid re-triggering and
  // redundant extracts when the session has no new conversation.
  const recentJob = findRecentJobForSession(sessionId, EXTRACT_DEBOUNCE_MS)
  const lastExtract = await getLastExtractForSession(sessionId)
  const sessions = await scanSessions(true)
  const sessionInfo = sessions.find((s) => s.id === sessionId)
  const sessionUpdated = sessionInfo?.updated || sessionInfo?.created || 0
  const guardResult = checkExtractGuard({
    recentJob,
    lastExtract,
    sessionUpdated,
    now: Date.now(),
  })
  if (!guardResult.ok) {
    return c.json({ error: guardResult.reason, message: guardResult.message }, 409)
  }

  const files = await readContextFiles(guard.req.reqDir!)
  const prompt = buildAutoExtractPrompt(guard.req, files)

  const cfg = await getConfig()

  try {
      const result = enqueueAutoExtract({
        reqId,
        sessionId,
        prompt,
        model: cfg.extractModel,
        autoAdopt: false,
        reqDir: guard.req.reqDir,
      })
    if (result.status === "immediate") {
      return c.json({ jobId: result.jobId, state: "running" }, 202)
    }
    // Queued — return 202 with scheduled time so the client can show
    // an estimated start time in the toast.
    return c.json({
      queued: true,
      scheduledAt: result.scheduledAt,
      delayMs: result.delayMs,
      queuePosition: result.queuePosition,
      sessionId,
    }, 202)
  } catch (err) {
    if (err instanceof JobConflictError) {
      return c.json({ error: "conflict", jobId: err.existingJobId }, 409)
    }
    const msg = err instanceof Error ? err.message : String(err)
    return c.text(`Failed to start job: ${msg}`, 500)
  }
})

/**
 * GET /requirement/auto-extract?jobId=<id>
 *
 * Preview page for auto-extract results. Shows per-file diffs with
 * accept/reject controls.
 */
app.get("/requirement/auto-extract", async (c) => {
  const jobIdParam = c.req.query("jobId")
  if (!jobIdParam) return c.text("Missing jobId", 400)
  const job = getExtractJob(jobIdParam)
  if (!job) return c.text("Job not found or expired", 404)
  const req = await getRequirement(job.reqId)
  if (!req) return c.text("Requirement not found", 404)

  // Read current file contents for diff display
  const currentFiles = req.reqDir ? await readContextFiles(req.reqDir) : {}

  return c.html(
    <AutoExtractPreviewPage req={req} sessionId={job.sessionId} job={job} currentFiles={currentFiles} />,
  )
})

const AutoExtractPreviewPage: FC<{
  req: Requirement
  sessionId: string
  job: ExtractJob
  currentFiles: ContextFiles
}> = ({ req, sessionId, job }) => {
  const backHref = `/requirement?id=${encodeURIComponent(req.id)}`
  const elapsedMs = (job.doneAt ?? Date.now()) - job.startedAt
  const autoResult = job.autoResult

  return (
    <Layout title={`智能提取 — ${req.title}`} active="requirements">
      <div class="req-extract">
        <div class="page-header">
          <a href={backHref} class="back-link">← 返回需求 {req.title}</a>
          <h1>智能上下文提取</h1>
          <div class="meta-grid">
            <div><span class="field-label">需求</span> {req.title}</div>
            <div><span class="field-label">Session</span> <code>{sessionId}</code></div>
            <div><span class="field-label">耗时</span> {(elapsedMs / 1000).toFixed(1)}s</div>
          </div>
        </div>

        {job.state === "running" ? (
          <section class="req-extract-running" data-job-id={job.id}>
            <p><span class="req-extract-spinner" aria-hidden="true"></span> <strong>agent 正在分析会话和上下文文件…</strong></p>
            <p class="muted small">已运行 <span class="js-extract-elapsed">{Math.round(elapsedMs / 1000)}</span> 秒。完成后此页自动刷新。</p>
          </section>
        ) : job.state === "done" && autoResult ? (
          <section class="auto-extract-result">
            {autoResult.summary ? (
              <div class="auto-extract-summary">
                <strong>变更说明：</strong> {autoResult.summary}
              </div>
            ) : null}

            {autoResult.updates.length === 0 && autoResult.appends.length === 0 ? (
              <div class="auto-extract-empty">
                <p>Agent 判断本次会话无需更新上下文文件。</p>
                <a href={backHref} class="btn btn-secondary">返回需求</a>
              </div>
            ) : (
              <form method="post" action="/api/requirement/auto-extract/commit" class="auto-extract-form">
                <input type="hidden" name="reqId" value={req.id} />
                <input type="hidden" name="sessionId" value={sessionId} />

                {autoResult.updates.map((u, i) => (
                  <div class="auto-extract-file" data-filename={u.filename}>
                    <div class="auto-extract-file-head">
                      <label class="auto-extract-accept">
                        <input type="checkbox" name={`update_${i}`} value={u.filename} checked />
                        <span>更新 <code>{u.filename}</code></span>
                      </label>
                      <details class="auto-extract-original">
                        <summary class="muted small">查看现有内容</summary>
                        <pre class="auto-extract-diff">{(job as any)._originalFiles?.[u.filename] ?? "(文件不存在)"}</pre>
                      </details>
                    </div>
                    <textarea
                      name={`update_content_${i}`}
                      class="req-extract-body auto-extract-textarea"
                      rows={Math.min(24, u.content.split("\n").length + 2)}
                      spellcheck={false}
                    >{u.content}</textarea>
                  </div>
                ))}

                {autoResult.appends.map((a, i) => (
                  <div class="auto-extract-file" data-filename={a.filename}>
                    <div class="auto-extract-file-head">
                      <label class="auto-extract-accept">
                        <input type="checkbox" name={`append_${i}`} value={a.filename} checked />
                        <span>追加到 <code>{a.filename}</code></span>
                      </label>
                    </div>
                    <textarea
                      name={`append_content_${i}`}
                      class="req-extract-body auto-extract-textarea"
                      rows={Math.min(20, a.content.split("\n").length + 2)}
                      spellcheck={false}
                    >{a.content}</textarea>
                  </div>
                ))}

                <div class="req-extract-actions">
                  <button type="submit" class="btn btn-primary">提交已接受的变更</button>
                  <a href={backHref} class="btn btn-secondary">全部取消</a>
                </div>
              </form>
            )}
          </section>
        ) : (
          <section class="req-extract-error">
            <p class="req-extract-error-msg"><strong>分析失败</strong>：{job.errorMessage || "未知错误"}</p>
            {job.stderr ? <pre class="req-extract-stderr">{job.stderr.slice(0, 2000)}</pre> : null}
            <div class="req-extract-actions">
              <a href={backHref} class="btn btn-secondary">返回需求</a>
            </div>
          </section>
        )}
      </div>
    </Layout>
  )
}

/**
 * POST /api/requirement/auto-extract/commit
 *
 * Writes the accepted file updates and appends to the requirement
 * directory. Each update replaces the file; each append adds content.
 */
app.post("/api/requirement/auto-extract/commit", async (c) => {
  const form = await c.req.formData()
  const reqId = String(form.get("reqId") || "")
  const sessionId = String(form.get("sessionId") || "")
  const guard = await resolveExtractTarget(reqId, sessionId)
  if (!guard.ok) return c.text(guard.message, guard.status)
  if (!guard.req.reqDir) return c.text("Requirement has no directory", 400)

  const reqDir = guard.req.reqDir
  const allowedFiles = new Set(["memory.md", "branch.md", "config-changes.md", "test.md", "notes.md", "review.md", "meta.md"])
  let written = 0

  // Process updates and appends from form fields
  const entries = [...form.entries()]
  for (const [key, value] of entries) {
    const updateMatch = key.match(/^update_(\d+)$/)
    if (updateMatch) {
      const idx = updateMatch[1]
      const filename = String(value)
      if (!allowedFiles.has(filename)) continue
      const content = String(form.get(`update_content_${idx}`) || "")
      if (!content.trim()) continue
      const filePath = join(reqDir, filename)
      // Safety: ensure the resolved path is still inside reqDir
      if (!filePath.startsWith(reqDir + "/") && filePath !== reqDir) continue
      await writeFile(filePath, content, "utf-8")
      written++
      continue
    }

    const appendMatch = key.match(/^append_(\d+)$/)
    if (appendMatch) {
      const idx = appendMatch[1]
      const filename = String(value)
      if (!allowedFiles.has(filename)) continue
      const content = String(form.get(`append_content_${idx}`) || "")
      if (!content.trim()) continue
      const filePath = join(reqDir, filename)
      if (!filePath.startsWith(reqDir + "/") && filePath !== reqDir) continue
      await appendFile(filePath, "\n\n" + content + "\n", "utf-8")
      written++
    }
  }

  return c.redirect(`/requirement?id=${encodeURIComponent(reqId)}`, 303)
})

app.get("/api/requirements", async (c) => {
  const groups = await listRequirementsByProject()
  const requirements = groups.flatMap((g) => g.requirements)
  return c.json({ requirements })
})

// ---------------------------------------------------------------------------
// Notification center routes
// ---------------------------------------------------------------------------

/**
 * GET /api/notifications
 *
 * Returns { unreadCount, notifications: [...] } for the bell panel.
 * Includes only non-dismissed notifications, newest-first.
 */
app.get("/api/notifications", (c) => {
  const notifications = getNotifications(false)
  return c.json({
    unreadCount: getUnreadCount(),
    notifications,
  })
})

/**
 * GET /api/notifications/unread-count
 *
 * Lightweight counter for the bell badge poll. Returns `{ count }`.
 */
app.get("/api/notifications/unread-count", (c) => {
  return c.json({ count: getUnreadCount() })
})

/**
 * POST /api/notifications/dismiss
 * Body: id=<notificationId> | all=1
 */
app.post("/api/notifications/dismiss", async (c) => {
  const form = await c.req.formData()
  const all = String(form.get("all") || "") === "1"
  if (all) {
    dismissAll()
    return c.json({ ok: true })
  }
  const id = String(form.get("id") || "")
  if (!id) return c.text("Missing id", 400)
  if (!getNotification(id)) return c.text("Notification not found", 404)
  dismissNotification(id)
  return c.json({ ok: true })
})

/**
 * POST /api/notifications/mark-read
 *
 * Mark all non-running notifications as read. Running ones stay unread
 * because they represent in-flight work the user hasn't seen the
 * outcome of yet.
 */
app.post("/api/notifications/mark-read", (c) => {
  markAllRead()
  return c.json({ ok: true })
})

// ---------------------------------------------------------------------------
// Experience marker routes (manual session marking for auto-summary)
// ---------------------------------------------------------------------------

/**
 * POST /api/experience/mark
 * Body (JSON): { sessionId, note? }
 *
 * Mark a session for auto experience summarization. The background
 * worker will fork the session and generate a report once it has been
 * idle for ≥1 hour.
 */
app.post("/api/experience/mark", async (c) => {
  const body = await c.req.json().catch(() => null) ?? {}
  const sessionId = String(body.sessionId || "")
  if (!sessionId) return c.json({ error: "Missing sessionId" }, 400)
  if (!isValidSessionId(sessionId)) return c.json({ error: "Invalid sessionId" }, 400)
  const note = typeof body.note === "string" ? body.note : undefined
  const marker = await markSession(sessionId, { note })
  return c.json({ ok: true, marker })
})

/**
 * POST /api/experience/unmark
 * Body (JSON): { sessionId }
 *
 * Remove a marker. No-op if the session was not marked.
 */
app.post("/api/experience/unmark", async (c) => {
  const body = await c.req.json().catch(() => null) ?? {}
  const sessionId = String(body.sessionId || "")
  if (!sessionId) return c.json({ error: "Missing sessionId" }, 400)
  if (!isValidSessionId(sessionId)) return c.json({ error: "Invalid sessionId" }, 400)
  const removed = await unmarkSession(sessionId)
  return c.json({ ok: true, removed })
})

/**
 * GET /api/experience/markers
 *
 * List all markers, optionally filtered by `?status=<status>`.
 */
app.get("/api/experience/markers", (c) => {
  const statusParam = c.req.query("status") as MarkerStatus | undefined
  const markers = listMarkers(statusParam)
  return c.json({ markers })
})

// ---------------------------------------------------------------------------
// Session valuation API
// ---------------------------------------------------------------------------

/**
 * GET /api/valuation/candidates
 * Returns recent valuation candidates (score ≥ threshold), newest/highest first.
 */
app.get("/api/valuation/candidates", (c) => {
  const limit = parseInt(c.req.query("limit") || "20", 10)
  const candidates = getRecentCandidates(limit)
  const stats = getValuationStats()
  return c.json({ candidates, stats })
})

/**
 * POST /api/valuation/mark
 * Body (JSON or form-encoded): { sessionId }
 * Manually mark a session from the valuation candidate list.
 * Also accepts form-encoded POST from the schedulers page table.
 */
app.post("/api/valuation/mark", async (c) => {
  const contentType = c.req.header("content-type") || ""
  let sessionId = ""
  if (contentType.includes("application/json")) {
    const body = await c.req.json().catch(() => null) ?? {}
    sessionId = String(body.sessionId || "")
  } else {
    const form = await c.req.formData().catch(() => null)
    sessionId = String(form?.get("sessionId") || "")
  }
  if (!sessionId) return c.json({ error: "Missing sessionId" }, 400)
  if (!isValidSessionId(sessionId)) return c.json({ error: "Invalid sessionId" }, 400)
  const marker = await markSession(sessionId, { note: "manual: from valuation candidates" })
  // Redirect back to /schedulers for form POSTs.
  if (!contentType.includes("application/json")) {
    return c.redirect("/schedulers")
  }
  return c.json({ ok: true, marker })
})

/**
 * POST /api/valuation/poll
 * Manually trigger a valuation poll cycle (useful for testing/debugging).
 */
app.post("/api/valuation/poll", async (c) => {
  await valuationPollOnce()
  const stats = getValuationStats()
  return c.json({ ok: true, stats })
})

// API: confirm or reject candidates.
// Extended: if the confirmed report has an associated marker (i.e. it
// was auto-generated from a marked session), trigger the execution fork
// for the confirmed candidate IDs so the user's accepted items get
// implemented without leaving the dashboard.
app.post("/api/confirm", async (c) => {
  const body = await c.req.json<Confirmation>()
  const reportPath = resolveHandoffPath(body.reportPath)
  if (!reportPath) {
    return c.json({ error: "Invalid reportPath" }, 400)
  }

  const confirmation: Confirmation = {
    reportPath,
    confirmedIds: body.confirmedIds || [],
    rejectedIds: body.rejectedIds || [],
    mode: body.mode || "confirm",
    timestamp: new Date().toISOString(),
  }

  const savedPath = await saveConfirmation(confirmation)

  // If this report came from a marked session and the user confirmed
  // candidates, trigger the execution fork. The fork runs in the
  // background; the marker's status tracks progress.
  let executionTriggered = false
  if (confirmation.mode === "confirm" && confirmation.confirmedIds.length > 0) {
    // Find a marker whose reportPath matches this report.
    const allMarkers = listMarkers("summarized")
    const matched = allMarkers.find((m) => m.reportPath === reportPath)
    if (matched) {
      // Fire and forget — the marker store tracks the fork's progress.
      void triggerExecutionForMarker(matched.sessionId, confirmation.confirmedIds).catch(() => {})
      executionTriggered = true
    }
  }

  return c.json({ ok: true, savedPath, executionTriggered })
})

// API: list reports (JSON, unchanged)
app.get("/api/reports", async (c) => {
  const reports = await scanReports()
  return c.json(reports)
})

// API: get report detail (JSON, unchanged)
app.get("/api/report", async (c) => {
  const reportPath = resolveHandoffPath(c.req.query("path"))
  if (!reportPath) {
    return c.json({ error: "Invalid path" }, 400)
  }
  const report = await getReport(reportPath)
  if (!report) return c.json({ error: "Not found" }, 404)
  return c.json(report)
})

// API: list sessions (JSON)
app.get("/api/sessions", async (c) => {
  const sessions = await scanSessions()
  return c.json({ summary: summarizeSessions(sessions), sessions })
})

// API: get a single session
app.get("/api/session", async (c) => {
  const id = c.req.query("id")
  if (!id) return c.json({ error: "Missing id" }, 400)
  const session = await getSession(id)
  if (!session) return c.json({ error: "Not found" }, 404)
  return c.json(session)
})

// ---------------------------------------------------------------------------
// WebSocket: /ws/session-terminal?id=...
// ---------------------------------------------------------------------------

const wss = new WebSocketServer({ noServer: true })

app.get(
  "/ws/session-terminal",
  upgradeWebSocket(() => {
    let session: TerminalSession | null = null
    let exited = false
    return {
      onOpen: async (_evt, ws) => {
        try {
          const url = ws.url ? new URL(ws.url) : null
          const id = url?.searchParams.get("id") ?? ""
          const createNew = url?.searchParams.get("new") === "1"
          const reqId = url?.searchParams.get("req") ?? ""
          const autoInject = shouldAutoInjectRequirementContext(url)

          // Resolve a working directory + optional title for the spawn.
          // Non-new mode: trust the SessionInfo row we already have.
          // New mode: use the requirement's working directory hint if
          // present (via getRequirement); otherwise fall back to
          // resolveCwd's default in startSession.
          let directory: string | null = null
          let title: string | undefined
          if (!createNew) {
            const sessionInfo = await getSession(id)
            directory = sessionInfo?.directory ?? null
          } else if (reqId) {
            const req = await getRequirement(reqId)
            if (req) title = req.title || undefined
          }

          const startMs = Date.now()
          const result = startSession(id, directory, {
            onOutput: (chunk) => {
              if (exited) return
              try {
                ws.send(chunk)
              } catch {
                // ignore send failures (closed)
              }
            },
            onExit: (code, signal) => {
              exited = true
              try {
                ws.send(JSON.stringify({ type: "exit", code, signal: signal ?? null }))
              } catch {
                // ignore
              }
              try { ws.close(1000, "process exited") } catch { /* noop */ }
            },
            onError: (message) => {
              try {
                ws.send(JSON.stringify({ type: "error", message }))
              } catch {
                // ignore
              }
              try { ws.close(1011, "spawn error") } catch { /* noop */ }
            },
          }, { createNew, title })
          if ("error" in result) {
            try {
              ws.send(JSON.stringify({ type: "error", message: result.error }))
            } catch { /* noop */ }
            try { ws.close(1008, result.error) } catch { /* noop */ }
            return
          }
          session = result
          try {
            ws.send(JSON.stringify({ type: "ready", id: result.id, cols: result.cols, rows: result.rows }))
          } catch { /* noop */ }

          // In "new" mode opencode creates a real session row on startup.
          // Poll the DB for ~10s to find the freshest session under our
          // cwd that didn't exist before `startMs`, then push the real
          // id back to the page and associate it with the requirement.
          let discoveredId = ""
          if (createNew) {
            const cwd = result.cwd
            const deadline = Date.now() + 10_000
            while (!discoveredId && Date.now() < deadline && !exited) {
              await new Promise((r) => setTimeout(r, 500))
              clearSessionCache()
              const list = await scanSessions(true)
              const candidate = list.find(
                (s) => s.directory === cwd && (s.created || 0) >= startMs,
              )
              if (candidate) {
                discoveredId = candidate.id
                break
              }
            }
            if (discoveredId) {
              if (reqId) {
                try {
                  await replaceAssociatedSession(reqId, id, discoveredId)
                } catch { /* noop */ }
              }
              try {
                ws.send(JSON.stringify({ type: "session", id: discoveredId }))
              } catch { /* noop */ }
            }
          }

          // If a requirement is associated, inject the context after a
          // short delay so opencode's TUI has time to settle into its
          // input prompt before we feed it text + Enter.
          if (reqId && autoInject) {
            try {
              const req = await getRequirement(reqId)
              if (req) {
                const ctx = await buildInjectionContext(req.id)
                setTimeout(() => {
                  if (exited || !session) return
                  try {
                    writeToSession(session, ctx + "\r")
                    ws.send(JSON.stringify({ type: "injected" }))
                  } catch { /* noop */ }
                }, 3000)
              }
            } catch { /* noop */ }
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          try {
            ws.send(JSON.stringify({ type: "error", message }))
          } catch { /* noop */ }
          try { ws.close(1011, "open error") } catch { /* noop */ }
        }
      },
      onMessage: (evt, ws) => {
        if (!session) return
        const data = typeof evt.data === "string" ? evt.data : ""
        if (!data) return
        const msg = parseClientMessage(data)
        if (msg.kind === "input") {
          writeToSession(session, msg.data)
        } else if (msg.kind === "resize") {
          resizeSession(session, msg.cols, msg.rows)
        }
      },
      onClose: () => {
        if (session) {
          killSession(session)
          session = null
        }
        exited = true
      },
      onError: () => {
        if (session) {
          killSession(session)
          session = null
        }
        exited = true
      },
    }
  })
)

// ---------------------------------------------------------------------------
// Server bootstrap
// ---------------------------------------------------------------------------

const port = parseInt(process.env.PORT || "7331", 10)

// Load any persisted notifications before opening the port so the first
// request to /api/notifications returns the saved state.
await initNotifications()
await initConfig()
await initMarkers()

// Start the background worker that polls for marked sessions and
// triggers auto-summary forks once sessions are idle ≥1 hour.
startAutoSummaryWorker()

// Start the nightly scheduler for automated smart context extraction.
// Fires at midnight (local time) each night; also runs a startup poll
// 30 s after boot to catch missed runs. Controlled by the
// `autoExtractSchedule` config toggle.
startAutoExtractScheduler()

// Start the background worker for session value discovery.
// Polls every 10 min; scans sessions updated within 48h, scores them
// using metadata + SQLite content, and auto-marks sessions above the
// configured threshold (when autoValuation is enabled).
startAutoValuationWorker()

// Start the single retained automatic config sync mechanism: a daily
// full sync at local 20:30, controlled by `fullSyncSchedule`.
startFullSyncScheduler()

serve({ fetch: app.fetch, websocket: { server: wss }, port }, (info) => {
  console.log(`OpenCode Dashboard running at http://localhost:${info.port}`)
})
