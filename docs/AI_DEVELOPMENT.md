# AI_DEVELOPMENT.md — opencode-dashboard handoff

> Long-form handoff for future AIs and developers continuing this project.
> For quick rules and the verification checklist, see [`AGENTS.md`](../AGENTS.md).
> For the user-facing tour, see [`README.md`](../README.md).

---

## 1. Quick orientation

`opencode-dashboard` is a single-process Node.js web app that you can run
locally and point at the same machine's OpenCode data directory. It does
two things:

1. **Browse and drive OpenCode sessions.** `/` is an Operator-styled
   dashboard. Click a lane to land on `/session?id=<ses_…>`, which spawns
   a real `opencode --session <id>` TUI inside a browser-embedded xterm.
2. **Review experience-summary reports.** `/reports` lists Markdown
   candidates from `experience-summarizer` runs. `/report?path=…` shows
   the candidate cards; `POST /api/confirm` writes confirmations to
   `/tmp/opencode/handoff/confirmations/`.

### Page map

| Path | Renders | Notes |
| --- | --- | --- |
| `GET /` | Sessions dashboard (Operator console) | Source chip top-right (`SQLITE / CLI / FS`) |
| `GET /session?id=<ses_…>` | Embedded terminal page | 404 page if id not in the current scan |
| `GET /sessions/refresh` | Same dashboard, force-rescan | Bypasses the 4 s cache |
| `GET /reports` | Experience report card grid | |
| `GET /report?path=…` | Report detail with candidate checkboxes | Path is gated by `resolveHandoffPath` |
| `GET /api/sessions` | `{ summary, sessions[] }` JSON | |
| `GET /api/session?id=…` | Single session JSON | |
| `GET /api/reports` | `ReportSummary[]` JSON | |
| `GET /api/report?path=…` | `ParsedReport` JSON | |
| `POST /api/confirm` | `{ ok, savedPath, executionTriggered }` | Path gated by `resolveHandoffPath`; auto-triggers execution fork if report has a marker |
| `POST /api/experience/mark` | `{ ok, marker }` | Mark a session for auto-summary |
| `POST /api/experience/unmark` | `{ ok, removed }` | Remove a marker |
| `GET /api/experience/markers` | `{ markers[] }` | List markers, optional `?status=` filter |
| `GET /ws/session-terminal?id=…` | WebSocket: PTY ↔ xterm | See §5 |
| `GET /static/*` | `public/` files | `..` rejected |
| `GET /vendor/xterm/xterm.css` | `@xterm/xterm/css/xterm.css` | Cache-Control: 1 h |
| `GET /vendor/xterm/xterm.js` | `@xterm/xterm/lib/xterm.js` | UMD bundle |
| `GET /vendor/xterm-addon-fit/addon-fit.js` | `@xterm/addon-fit/lib/addon-fit.js` | UMD bundle |

The app is SSR-only — `hono/jsx` renders the initial HTML and the
client-side scripts (`public/app.js`, `public/terminal.js`) are loaded
as ESM / classic scripts with `defer` and `type="module"` respectively.

---

## 2. Architecture / file map

```
opencode-dashboard/
├── src/
│   ├── server.tsx          # Hono app, JSX, upgradeWebSocket, vendor + static routes
│   ├── sessions.ts         # SQLite → CLI → fs scan, helpers, session-id guard
│   ├── terminal.ts         # node-pty wrapper (start/write/resize/kill)
│   ├── terminalProtocol.ts # PURE WS-frame parser; no native imports
│   ├── paths.ts            # resolveHandoffPath (single gate for report paths)
│   ├── parser.ts           # experience-summary markdown → structured candidates
│   ├── scanner.ts          # report scanner + saveConfirmation
│   ├── experienceMarkers.ts # persistent marker store (mark/unmark/list/TTL)
│   ├── experienceAutoSummary.ts # background worker (idle detect → fork → summarize → execute)
│   ├── views/              # (placeholder for future view fragments)
│   ├── client/             # (placeholder; current client code lives in public/)
│   └── public/             # (placeholder; real assets live in /public)
├── public/
│   ├── app.js              # report confirm/reject UI (page-scoped)
│   ├── terminal.js         # xterm + WS bridge for /session?id=…
│   └── style.css           # .op-* dashboard styles + .report-* / .candidate-*
├── tests/
│   ├── paths.test.ts       # resolveHandoffPath (escape attempts, siblings, nulls)
│   ├── sessions.test.ts    # parseModelString, deriveWorktree
│   └── terminal.test.ts    # parseClientMessage (raw input, resize, ping, fallthrough)
├── docs/
│   └── AI_DEVELOPMENT.md   # this file
├── AGENTS.md               # project rules (read first)
├── README.md               # one-page tour
├── package.json
├── tsconfig.json
└── .gitignore
```

**Module layering.** `server.tsx` is the only place that wires modules
together. The other `src/*.ts` files import each other only when
explicitly justified (e.g. `terminal.ts` re-exports
`parseClientMessage` for runtime callers, and pulls `isValidSessionId`
and `resolveCwd` from `sessions.ts`).

**Why `terminalProtocol.ts` is a separate file.** It is the only module
that can be loaded on a host without a working PTY toolchain. Unit tests
import it directly, and any future browser-side parser mirror should
copy this file rather than reach into `terminal.ts`.

---

## 3. Data source details — sessions

`scanSessions(force?)` in `src/sessions.ts` returns the most recent
`MAX_SESSIONS = 50` rows. The order is fixed and must not be changed:

### Source 1 — SQLite (preferred)

- Invokes `sqlite3 -json <dbPath> <SQLITE_QUERY>` via
  `child_process.spawn` with a fixed argv array. **No string
  interpolation into the SQL.** The DB path is the only runtime input
  and is the constant `DEFAULT_DB_PATH = ~/.local/share/opencode/opencode.db`.
- A 5 s timeout (`SQLITE_TIMEOUT_MS`) kills the child if the DB is
  locked. Failure modes that resolve to `null` (so the next source can
  try): binary missing, non-zero exit, non-array JSON, missing file.
- The query selects these columns, in this order:
  - `id, project_id, directory, path, title, time_created, time_updated, agent, model, cost, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write`
  - `where time_archived is null`
  - `order by time_updated desc limit 50`.

### Source 2 — `opencode` CLI fallback

- Invokes `opencode session list --format json --max-count 50` with a
  fixed argv array; the 5 s timeout (`SESSION_LIST_TIMEOUT_MS`) and
  error-handling are the same shape as the SQLite path.
- The CLI output shape is a JSON array of session records. The same
  `normalizeSession()` is used to coerce fields.

### Source 3 — filesystem fallback

- Reads filenames in
  `~/.local/share/opencode/storage/session_diff/`. The only thing it
  inspects is the file name pattern `^ses_[A-Za-z0-9]+\.json$` and the
  directory entry's `mtime` / `ctime`. **It never reads file
  contents.**
- For these rows `model` and `worktree` are not populated, and the
  source is reported as `"fs"`. The detail page handles missing
  metadata gracefully (the UI shows `none` / `unknown model`).

### Normalization

`normalizeSession(raw, source)` is the single funnel:

- `id` is revalidated against `SESSION_ID_RE = /^ses_[A-Za-z0-9]+$/`.
  If the regex fails, the row is dropped (so a malformed SQLite or
  CLI row cannot reach the UI or the PTY).
- `title` is truncated to 200 characters (`safeTruncate`) and falls
  back to `"(untitled)"` if missing.
- `model` is parsed by `parseModelString`, which accepts the canonical
  OpenCode JSON shape `{ id, providerID, variant }` and falls back to
  the raw text on any failure (including non-JSON, non-object, missing
  keys, or non-string values). The unit tests in
  `tests/sessions.test.ts` cover each branch.
- `worktree` is derived by `deriveWorktree({ directory, path })`:
  - `directory` under `$HOME` → render as `~/…`.
  - `directory === $HOME` → render as `~`.
  - `directory` outside `$HOME` → keep the absolute path (the session
    is on another mount; the user should see that).
  - No `directory`, only `path` → `~/<path>` (with leading slashes
    stripped).
  - Nothing usable → `none`.
- `status` is derived from `updated` recency:
  - `< 5 min` → `running`
  - `5 min – 24 h` → `idle`
  - `>= 24 h` or missing → `stale`

The cache (`cache: { at, data }`) is invalidated after `CACHE_TTL_MS =
4_000` ms or when `scanSessions(true)` is called. The
`/sessions/refresh` route is the only public way to force a rescan.

### Common sources of "no sessions"

- `~/.local/share/opencode/opencode.db` does not exist (new
  installation) → CLI path takes over.
- The `opencode` binary is not on `PATH` and the DB is unreadable →
  `fs` fallback kicks in. If the diff directory is also empty, the
  page renders the "No OpenCode sessions found" empty state with
  hint commands.

---

## 4. UI design notes (match the Operator look)

The dashboard was redesigned to match a "Maestro / Operator console"
screenshot: thin console top bar + 4-column flow strip + per-session
lane cards. When changing the UI:

- **Top bar** (`op-topbar`, `op-topbar-row`, `op-brand`, `op-meta`):
  two rows in a sticky element; route strip on the second row uses
  `op-routes` and `op-route-active`. Reuse these classes instead of
  adding a new header.
- **Flow strip** (`op-flow`, `op-flow-cell`, `op-flow-k`, `op-flow-v`,
  `op-flow-hint`): 4 cells `BACKLOG / RUNNING / REPAIR / READY` bound
  to `summary.stale / running / idle / total` (yes, the labels are
  repurposed; the cells map to real recency buckets — see
  `summarizeSessions`).
- **Lane card** (`op-lane`, `op-lane-rail`, `op-lane-body`,
  `op-lane-head`, `op-lane-issue`, `op-lane-status`, `op-lane-title`,
  `op-lane-subtitle`, `op-lane-phrase`, `op-lane-stats`, `op-stat`,
  `op-lane-grid`, `op-grid-cell`, `op-grid-k`, `op-grid-v`): the
  cyan rail is a 3 px pseudo-strip; status dot uses `.status-dot`
  with `.status-running / .status-idle / .status-stale`. Detail
  grid always has 8 cells in this order:
  `CODEX THREAD / THREAD FLAGS / PROTOCOL EVENT / BRANCH / WORKTREE
  / BACKLOG OWNERSHIP / MODEL / NEXT RETRY`. Keep the order so
  visual diffing against the screenshot stays stable.
- **Avoid horizontal overflow.** The 8-cell grid collapses to 2
  columns at `max-width: 1080px` via `.op-lane-grid` — do not add
  fixed widths that would force a horizontal scrollbar.
- **Report surface is class-namespaced.** Anything under `/reports`
  and `/report?path=…` uses `.report-card`, `.candidate-card`,
  `.action-bar`, `.badge`, `.toast`, etc. Do not reuse `.op-*` for
  report UI.
- **Color tokens.** Define new colors as CSS custom properties on
  `:root` in `public/style.css`; do not hardcode hex values in
  inline styles or in additional stylesheets.

### Status color references

| Status | Class | Color (current) |
| --- | --- | --- |
| running | `.status-running` | `--green` (`#22c55e`) |
| idle | `.status-idle` | `--amber` (`#f59e0b`) |
| stale | `.status-stale` | `--red` (`#ef4444`) |

The cyan primary accent is used for the lane rail, active route, and
selected checkboxes.

---

## 5. Embedded terminal flow

### Server side

1. Browser opens `/session?id=<ses_…>`. The route handler
   `app.get("/session")` calls `getSession(id)` (which re-validates
   the id against `SESSION_ID_RE`) and either renders the
   `SessionTerminalPage` or the 404 `SessionMissingPage`.
2. The page loads `public/terminal.js` as a module and the vendor
   assets from `/vendor/xterm/xterm.css`,
   `/vendor/xterm/xterm.js`, `/vendor/xterm-addon-fit/addon-fit.js`.
3. The browser script opens a WebSocket to
   `/ws/session-terminal?id=<ses_…>`. The Hono route uses
   `upgradeWebSocket` with a `noServer` `WebSocketServer`.
4. On `onOpen` the server calls
   `startSession(id, sessionInfo?.directory, handler)` in
   `src/terminal.ts`. The function:
   - Re-checks `isValidSessionId(id)`.
   - Picks the `opencode` binary: prefers `/usr/bin/opencode` if it
     exists, otherwise relies on `PATH`.
   - Calls `nodePtySpawn(bin, ["--session", id], { cwd, env: { TERM:
     "xterm-256color" } })`.
   - Wires `onData → handler.onOutput` and `onExit → handler.onExit`.
5. The Hono handler echoes PTY stdout to the WebSocket and
   translates client `resize` messages into
   `pty.resize(cols, rows)`. `parseClientMessage` is the **only**
   logic that classifies inbound WS frames (see
   `src/terminalProtocol.ts`).

### Why the protocol parser is pure

- It has no native binding imports and no `node-pty` reference, so
  `node --test --import tsx tests/terminal.test.ts` can run on any
  host. The browser-side mirror in `public/terminal.js` re-implements
  the same classification rules (control frames are JSON objects with
  `type: "ready" | "exit" | "error"`; everything else is raw PTY
  bytes). Keep the two implementations in sync; the existing tests
  in `tests/terminal.test.ts` document the exact contract.

### Vendor route contract

- `app.get("/vendor/xterm/xterm.css", vendorFile("@xterm/xterm",
  "css/xterm.css", "text/css"))` etc. — the `vendorFile` helper:
  - strips leading `/` and rejects any `..` or absolute paths,
  - joins with `NODE_MODULES_DIR + pkg + rel`,
  - returns 404 if the file does not exist,
  - serves with `Cache-Control: public, max-age=3600`.
- The browser script loads the JS via `<script>` injection (UMD
  bundles), not via an ESM `import`. This keeps the page usable
  without a bundler and survives `node --test` runs that resolve
  the package.
- To upgrade xterm: bump `@xterm/xterm` and `@xterm/addon-fit` in
  `package.json`, run `npm install`, and re-verify the three vendor
  routes return 200 (the file paths inside the package may move
  between major versions).

---

## 6. Test strategy and how to add tests

### Run

```bash
mise list                # confirm node/npm are installed
mise current             # see the active version
mise exec -- npm test          # node --test --import tsx tests/*.test.ts
mise exec -- npm run typecheck # tsc --noEmit
```

Tests are pure unit tests for the side-effect-free modules. They
intentionally avoid:

- Spawning `sqlite3` / `opencode` (the runtime paths use real
  child processes; the helpers around them are tested instead).
- Loading `node-pty` (the terminal tests exercise only
  `parseClientMessage`).
- Touching `/tmp/opencode/handoff/` (the paths tests cover
  `resolveHandoffPath` only).

### How to add a new test

1. Pick the smallest side-effect-free module that owns the logic.
   - SQL/CLI/fs scan? Add a test in `tests/sessions.test.ts` for
     `normalizeSession`, `parseModelString`, or `deriveWorktree` —
     do not try to mock the spawn layer.
   - WS frames? Add a test in `tests/terminal.test.ts` for
     `parseClientMessage`.
   - Path safety? Add a test in `tests/paths.test.ts` for
     `resolveHandoffPath`.
2. The test runner is `node --test` (`node:test`). Each test file
   imports `test` from `node:test` and `strict as assert` from
   `node:assert`. Use `assert.equal` for primitives,
   `assert.deepEqual` for objects, and `assert.match` only when a
   string needs a regex check.
3. Prefer one `test("helper: behavior", …)` per behavior. Group
   edge cases in the same file (e.g. `parseModelString` already has
   six small tests for the failure modes).
4. New helpers should be exported (or re-exported) from a
   non-`server.tsx` module so tests can import them without booting
   Hono.
5. Do not introduce a test framework. `node --test` is the contract
   and runs without `npm` glue.

### What to test when you change a feature

- Adding a new SQL column? Add a `normalizeSession` test in
  `tests/sessions.test.ts` (you cannot easily exercise the SQLite
  scan in a unit test — but `normalizeSession` is the contract).
- Adding a new WS frame type? Add a `parseClientMessage` test in
  `tests/terminal.test.ts` **and** mirror the change in
  `public/terminal.js`. The test file documents the existing
  policy: only `resize` and `ping` are recognized control frames;
  everything else is forwarded as raw input.
- Tightening `resolveHandoffPath`? Add the new escape attempt to
  `tests/paths.test.ts` (sibling directory, `..`, null byte,
  non-string, relative path are all already covered).

---

## 7. Browser-harness workflow (visual verification)

The repo does not ship Playwright / Cypress / Storybook. For UI
changes, use the `browser-harness` skill (or the `browser` skill
if you only need screenshots) against `http://localhost:7331`.

### Standard commands

The `browser-harness` CLI is invoked as a Python heredoc. Helpers
(`new_tab`, `wait_for_load`, `page_info`, `capture_screenshot`,
`js`, `click_at_xy`) are pre-imported by the daemon. The first
navigation on a page is always `new_tab(url)` — never reuse the
user's active tab. Screenshot after every meaningful action, and
read DOM state with `js(...)` for non-visual checks.

```bash
# Start the server (background).
cd /home/hevin/GitHub/opencode-dashboard
npm start &
SERVER_PID=$!
sleep 2

# Open the dashboard in a fresh tab and confirm it loaded.
browser-harness <<'PY'
new_tab("http://localhost:7331/")
wait_for_load()
print(page_info())
capture_screenshot("/tmp/opencode/dash-home.png")
PY

# DOM invariants on /: laneCount, no horizontal overflow, MODEL + WORKTREE visible.
browser-harness <<'PY'
print(js("""JSON.stringify((() => {
  const labels = [...document.querySelectorAll('.op-grid-k')].map(e => e.textContent);
  return {
    laneCount: document.querySelectorAll('.op-lane').length,
    overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    hasModel: labels.includes('MODEL'),
    hasWorktree: labels.includes('WORKTREE'),
    source: document.querySelector('.op-section-meta')?.textContent?.trim() ?? null
  };
})())""")
PY

# Open a session, screenshot, and check xterm mounted + terminal status text.
browser-harness <<'PY'
new_tab("http://localhost:7331/session?id=<ses_…>")
wait_for_load()
capture_screenshot("/tmp/opencode/dash-session.png")
print(js("!!document.querySelector('.xterm')"))
print(js("document.getElementById('terminal-status').textContent"))
PY

# Confirm the reports surface still renders cards.
browser-harness <<'PY'
new_tab("http://localhost:7331/reports")
wait_for_load()
capture_screenshot("/tmp/opencode/dash-reports.png")
print(js("document.querySelectorAll('.report-card').length"))
PY

kill $SERVER_PID
```

If `browser-harness` is not on `PATH`, load the `browser-harness`
skill first and follow its one-time install steps (the skill's
`Prerequisite` section). The `playwright-screenshot` skill is an
acceptable fallback for one-off screenshots.

### Expected DOM invariants

On `/`:

- `document.querySelectorAll('.op-lane').length === <scanSessions length>`.
  This is the `laneCount` check.
- `document.documentElement.scrollWidth - document.documentElement.clientWidth === 0`
  at every viewport between 360 px and 1920 px wide. Horizontal
  scroll must not appear.
- `document.querySelectorAll('.op-grid-k')` contains the strings
  `MODEL` and `WORKTREE` (case-insensitive) on every lane.
- `document.querySelector('.op-brand-status')` is present and shows
  `SNAPSHOT READY` (purely cosmetic but it's the visual anchor for
  the top bar).
- The source chip in `op-section-meta` is one of
  `SQLITE / CLI / FS`, in that priority order.

On `/session?id=<ses_…>`:

- `document.querySelector('.xterm')` mounts within 1 s of `DOMContentLoaded`.
- `document.getElementById('terminal-status')` transitions
  `connecting… → connected, awaiting shell… → connected: opencode --session <id>`.
- No errors in the dev console (`[error]` in the terminal status
  string is a failure).
- The WebSocket URL is `ws://<host>/ws/session-terminal?id=<encoded id>`.

On `/reports`:

- Cards render under `.report-card`. If a session had no reports,
  the empty state under `.empty-state` is acceptable.
- `document.querySelectorAll('.badge').length` is consistent with
  the candidate count returned by `/api/reports`.

### Resizing / cross-viewport

Run the same `laneCount` and overflow check at three viewport
widths — 720 px, 1080 px, 1440 px. The 1080 px breakpoint is the
one that flips the lane grid from 8 columns to 2 columns; verify
that no overflow appears in either regime.

---

## 8. Common troubleshooting

### `EADDRINUSE` on port 7331

- `lsof -i :7331` (or `ss -ltnp 'sport = :7331'`) to find the
  conflicting PID. Common offenders: a previous `npm start` whose
  parent shell was killed but the Node child survived, or a
  long-running `mise exec -- npm run dev` from another terminal.
- Kill the owner with `kill <pid>`; do not blindly `pkill node`
  because the host may be running other OpenCode-related services.
- Or run on another port: `PORT=7401 npm start`.

### `sqlite3: command not found`

- The CLI fallback (`opencode session list --format json`) and the
  fs fallback (filenames in `~/.local/share/opencode/storage/session_diff/`)
  both still work. The page renders with `source: "cli"` or
  `source: "fs"` and the `RUNNING LANES` block keeps working.
- To restore the SQLite source, install `sqlite3` (Arch:
  `sudo pacman -S sqlite`; macOS: preinstalled; Debian/Ubuntu:
  `sudo apt install sqlite3`). Re-run `npm start`; the cache TTL is
  4 s, so the new source should be picked up within a refresh.

### `node-pty` native binding fails to build or load

- `node-pty` is a native module. On a fresh checkout run
  `npm rebuild node-pty` (or `npm install` if it has never been
  built). On Linux you may need `python3`, `make`, and a C++
  toolchain (`gcc/g++`); on macOS Xcode CLT.
- If rebuild fails, the `/session?id=…` page still renders but
  the WebSocket will close with `Failed to spawn /usr/bin/opencode:
  …` and the terminal status will show
  `error: Failed to spawn …`. Sessions list and reports are
  unaffected because they don't import `terminal.ts`.
- Tests are deliberately structured so `parseClientMessage` is
  tested without loading the binding.

### `opencode` CLI returns no output (or exits 1)

- The 5 s timeout in `runOpencodeList` will fire and the scan will
  fall through to the fs fallback. The page will render with
  `source: "fs"`. Verify by hand:
  - `opencode session list --format json --max-count 50` — should
    print a JSON array.
  - `which opencode` — should resolve to `/usr/bin/opencode` or
    a `PATH` entry. If not, install OpenCode and re-run.
- The `/session?id=…` page's embedded terminal will also fail in
  the same way (`PTY exited code=1`). The fallback hint commands
  (`opencode web`, `opencode serve --port 4096`,
  `opencode attach http://localhost:4096 --session <id>`) are
  intentionally listed in the UI so users can attach a different
  TTY client.

### Default source is `fs` even when `sqlite3` is available

- Almost always means the SQLite scan errored. Set
  `DEBUG_OPENCODE_DASH=1` in the env before starting the server
  to log the SQLite stderr to your console; the warning is
  intentionally only emitted in debug mode so the default log
  stays clean.
- A common cause: the DB file is at a non-default path because
  `XDG_DATA_HOME` is overridden. Either set
  `HOME=<expected-home>` for the dashboard or change
  `DEFAULT_DB_PATH` in `src/sessions.ts` to match your layout.

### Report page returns `Forbidden path`

- The input was not inside `/tmp/opencode/handoff/`. The strict
  prefix check is intentional — see §3 of `AGENTS.md` and the
  sibling-directory test in `tests/paths.test.ts`.
- If the handoff directory actually moved, update `HANDOFF_ROOT`
  in `src/paths.ts` and `REPORT_DIRS` in `src/scanner.ts`
  together. They are intentionally separate constants; the
  scanner's "report dirs" must remain a subset of
  `paths.ts#HANDOFF_ROOT_PREFIX` or `resolveHandoffPath` will
  reject them at runtime.

### xterm vendor routes 404

- The three routes are hard-coded to the current xterm package
  layout (`css/xterm.css`, `lib/xterm.js`, `lib/addon-fit.js`).
  When upgrading, check the new layout under
  `node_modules/@xterm/xterm/` and `node_modules/@xterm/addon-fit/`
  and update `src/server.tsx` accordingly.

### Port already in use but `lsof` shows nothing

- Rare, but a previous `tsx` watcher can leave a zombie. Try
  `pkill -f "tsx src/server.tsx"` then restart.

---

## 9. Future work / known gaps

- The `views/` and `client/` directories under `src/` are empty
  placeholders for a future split. Do not move code there without
  a stated reason; the current single-file JSX in `server.tsx`
  is intentional and keeps the build chain trivial.
- `app.js` and `terminal.js` are page-scoped IIFEs. If a second
  page needs a new client script, follow the same page-scoped
  pattern (gate on a DOM marker like `#terminal` or
  `window.__REPORT_PATH__`).
- `summarizeSessions` reports counts but the UI uses repainted
  labels (`BACKLOG / RUNNING / REPAIR / READY`). The mapping is
  documented in `src/server.tsx#SessionsPage`; if the label set
  changes, update both the JSX and this doc.
- `parseModelString` is forgiving by design. Do not tighten the
  parser without auditing every consumer — the UI relies on
  `modelId` being a string even when the input is not canonical.
- The embedded terminal uses an absolute `/usr/bin/opencode`
  fallback first, then `PATH`. If you ship this to a different
  distro, update `OPENCODE_BIN_CANDIDATES` in `src/terminal.ts`.
