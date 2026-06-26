/**
 * public/req-detail.js
 *
 * Role: page-scoped script for the requirement detail page and the
 * "extract context from session" preview page. Handles four things:
 *   1. Intercepts `data-extract-trigger` POST forms so the spawn runs
 *      in the background; polls /api/extract/job/:id and shows a brief
 *      3-second flash toast on each state transition. Persistent state
 *      lives in the topbar notification center.
 *   2. Auto-poll on the preview page while the underlying job is still
 *      in `running` state — reloads once it transitions.
 *   3. Clipboard copy buttons (`data-copy-cmd`) for session commands.
 *   4. `req-new-session-btn` triggers background `opencode run` with
 *      the requirement's injection context; on success it renders a
 *      copyable `opencode -s <id>` command next to the button.
 *
 * Why a separate file from public/app.js: app.js is a single-IIFE
 * report-page-only script that early-returns on other pages. Mixing
 * the requirement-page logic in would break that early-return.
 *
 * Constraints / safety:
 *   - No external deps; vanilla DOM only.
 *   - Never logs or stores secrets — only opaque job ids.
 *   - Clipboard copy falls back to a temporary <textarea> + execCommand
 *     when the page is loaded over an insecure context (no `navigator.
 *     clipboard`).
 *
 * Read-this-with:
 *   - src/server.tsx (route shape: POST … /extract-context, GET
 *     /api/extract/job/:id, GET /requirement/extract?jobId=…)
 *   - src/notifications.ts (the persistent store)
 *   - public/style.css `.op-toast*` / `.req-extract-*` / `.req-copy-cmd-*`
 */

(function () {
  "use strict"

  const POLL_INTERVAL_MS = 1500
  const POLL_MAX_MS = 5 * 60_000
  const FLASH_MS = 3000

  const toastHost = document.getElementById("op-toast-host")

  // ------------------------------------------------------------------
  // Toast helpers — brief flash only. Persistent state goes to the
  // notification center.
  // ------------------------------------------------------------------

  /** Show a transient toast that auto-disappears after FLASH_MS. */
  function flashToast(opts) {
    if (!toastHost) return
    const el = document.createElement("div")
    el.className = "op-toast op-toast-extract op-toast-" + (opts.state || "running")
    const titleEl = document.createElement("div")
    titleEl.className = "op-toast-title"
    titleEl.textContent = opts.title || ""
    el.appendChild(titleEl)
    if (opts.subtitle) {
      const subEl = document.createElement("div")
      subEl.className = "op-toast-sub muted small"
      subEl.textContent = opts.subtitle
      el.appendChild(subEl)
    }
    toastHost.appendChild(el)
    setTimeout(function () { el.remove() }, FLASH_MS)
  }

  function showError(message) {
    flashToast({ state: "failed", title: message })
  }

  // ------------------------------------------------------------------
  // Job lifecycle: poll silently in the background; flash only on
  // start, transition to done, transition to failed.
  // ------------------------------------------------------------------

  function pollJob(jobId) {
    const startedAt = Date.now()
    let lastState = "running"

    function tick() {
      fetch("/api/extract/job/" + encodeURIComponent(jobId), { cache: "no-store" })
        .then(function (res) {
          if (res.status === 404) {
            flashToast({ state: "failed", title: "任务已过期", subtitle: "请去通知中心或重新点提取上下文。" })
            return null
          }
          if (!res.ok) throw new Error("HTTP " + res.status)
          return res.json()
        })
        .then(function (job) {
          if (!job) return
          if (job.state === "running") {
            if (Date.now() - startedAt < POLL_MAX_MS) {
              setTimeout(tick, POLL_INTERVAL_MS)
            }
            return
          }
          if (job.state !== lastState) {
            lastState = job.state
            const dur = job.elapsedMs ? (job.elapsedMs / 1000).toFixed(1) + "s" : "完成"
            if (job.state === "done") {
              var title
              if (job.mode === "auto") {
                title = "✓ 上下文分析完成（" + dur + "）"
              } else if (job.salvagedFromFork) {
                title = "✓ 已从 fork 救回摘要（" + dur + "）"
              } else {
                title = "✓ 摘要生成完成（" + dur + "）"
              }
              flashToast({ state: "done", title: title, subtitle: "点右上角 🔔 查看，或在通知中心进入预览页" })
            } else {
              flashToast({ state: "failed", title: "✗ 生成失败", subtitle: "点右上角 🔔 查看详情" })
            }
          }
        })
        .catch(function () {
          if (Date.now() - startedAt < POLL_MAX_MS) {
            setTimeout(tick, POLL_INTERVAL_MS)
          }
        })
    }

    tick()
  }

  /**
   * Submit a `data-extract-trigger` form via fetch; on success
   * (202 or 409) start polling the returned jobId.
   */
  function startExtract(form) {
    const reqId = form.querySelector('input[name="reqId"]').value
    const sessionId = form.querySelector('input[name="sessionId"]').value
    const button = form.querySelector('button[type="submit"]')
    const action = form.getAttribute("action") || "/api/requirement/extract-context"
    const isAuto = action.includes("auto-extract")

    flashToast({
      state: "running",
      title: isAuto ? "已提交智能提取任务" : "已提交摘要任务",
      subtitle: "session " + sessionId + " · 完成后在 🔔 通知中心查看",
    })
    if (button) {
      button.disabled = true
      // Match the server-side debounce window for auto-extract; use a
      // shorter disable for summary mode since it has no debounce guard.
      var disableMs = isAuto ? 5 * 60_000 : 5_000
      setTimeout(function () { button.disabled = false }, disableMs)
    }

    const body = new URLSearchParams()
    body.set("reqId", reqId)
    body.set("sessionId", sessionId)

    fetch(action, {
      method: "POST",
      body: body,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    })
      .then(function (res) {
        return res.json().then(function (data) { return { status: res.status, data: data } })
      })
      .then(function (r) {
        if ((r.status === 202 || r.status === 409) && r.data && r.data.jobId) {
          const jobId = r.data.jobId
          if (r.status === 409) {
            flashToast({ state: "running", title: "已有相同 session 的任务在跑", subtitle: "继续跟踪现有任务" })
          }
          pollJob(jobId)
        } else if (r.status === 409 && r.data && r.data.message) {
          // Debounce or no-new-content rejection from the server.
          flashToast({ state: "failed", title: "已跳过", subtitle: r.data.message })
        } else {
          showError("提交失败：HTTP " + r.status + " " + (r.data && r.data.error ? r.data.error : ""))
        }
      })
      .catch(function (err) {
        showError("提交失败：" + (err && err.message ? err.message : err))
      })
  }

  // ------------------------------------------------------------------
  // Bind triggers (detail page)
  // ------------------------------------------------------------------

  document.querySelectorAll("form[data-extract-trigger]").forEach(function (form) {
    form.addEventListener("submit", function (ev) {
      ev.preventDefault()
      startExtract(form)
    })
  })

  // ------------------------------------------------------------------
  // Auto-poll on preview-running page
  // ------------------------------------------------------------------

  const runningSection = document.querySelector(".req-extract-running[data-job-id]")
  if (runningSection) {
    const jobId = runningSection.getAttribute("data-job-id")
    if (jobId) {
      const startedAt = Date.now()
      const tick = function () {
        fetch("/api/extract/job/" + encodeURIComponent(jobId), { cache: "no-store" })
          .then(function (res) { return res.ok ? res.json() : null })
          .then(function (job) {
            if (!job) return
            const elapsedEl = runningSection.querySelector(".js-extract-elapsed")
            if (elapsedEl) {
              elapsedEl.textContent = String(Math.round((Date.now() - startedAt) / 1000))
            }
            if (job.state !== "running") {
              window.location.reload()
              return
            }
            if (Date.now() - startedAt < POLL_MAX_MS) {
              setTimeout(tick, POLL_INTERVAL_MS)
            }
          })
          .catch(function () {
            if (Date.now() - startedAt < POLL_MAX_MS) setTimeout(tick, POLL_INTERVAL_MS)
          })
      }
      setTimeout(tick, POLL_INTERVAL_MS)
    }
  }

  // ------------------------------------------------------------------
  // "另开新 session" buttons — POST /api/requirement/new-session which
  // spawns a detached `opencode run "<context>"` and polls for the new
  // session id. On success we render a copyable command next to the
  // button (the user pastes it into their own terminal, the dashboard
  // does NOT keep a PTY open).
  // ------------------------------------------------------------------

  function buildResultCommandEl(cmd) {
    const code = document.createElement("code")
    code.textContent = cmd

    const copyBtn = document.createElement("button")
    copyBtn.type = "button"
    copyBtn.className = "req-copy-cmd-inline req-copy-cmd-inline-new-session"
    copyBtn.setAttribute("data-copy-cmd", cmd)
    copyBtn.title = "复制 \`" + cmd + "\` 到剪贴板"
    copyBtn.textContent = "📋 复制"

    const wrap = document.createElement("span")
    wrap.appendChild(code)
    wrap.appendChild(document.createTextNode(" "))
    wrap.appendChild(copyBtn)
    return wrap
  }

  function attachNewSessionHandler(btn) {
    btn.addEventListener("click", function (ev) {
      ev.preventDefault()
      if (btn.disabled) return
      const reqId = btn.getAttribute("data-req-id") || ""
      if (!reqId) return
      const resultSpan = document.querySelector(
        ".req-new-session-result[data-req-id=\"" + cssEscape(reqId) + "\"]"
      )
      btn.disabled = true
      const restoreBtn = function () { btn.disabled = false }
      if (resultSpan) {
        resultSpan.textContent = "创建中…"
      }

      const body = new URLSearchParams()
      body.set("reqId", reqId)

      fetch("/api/requirement/new-session", {
        method: "POST",
        body: body,
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      })
        .then(function (res) {
          return res.json().then(function (data) {
            return { status: res.status, data: data }
          })
        })
        .then(function (r) {
          if (r.status >= 200 && r.status < 300 && r.data && r.data.sessionId && r.data.command) {
            if (resultSpan) {
              resultSpan.textContent = ""
              resultSpan.appendChild(buildResultCommandEl(r.data.command))
            }
          } else {
            const msg = (r.data && r.data.error) ? r.data.error : ("HTTP " + r.status)
            if (resultSpan) {
              resultSpan.textContent = "✗ " + msg
            }
            restoreBtn()
          }
        })
        .catch(function (err) {
          const msg = (err && err.message) ? err.message : String(err)
          if (resultSpan) {
            resultSpan.textContent = "✗ " + msg
          }
          restoreBtn()
        })
    })
  }

  // Minimal CSS.escape polyfill — req ids are URL-safe today, but be
  // defensive against any future character that needs escaping. The
  // value is interpolated into a [data-req-id="..."] selector, so we
  // only need to escape characters that would close the string or the
  // attribute selector.
  function cssEscape(s) {
    if (typeof CSS !== "undefined" && CSS && typeof CSS.escape === "function") {
      return CSS.escape(s)
    }
    return String(s).replace(/([\\"])/g, "\\$1")
  }

  document.querySelectorAll(".req-new-session-btn").forEach(attachNewSessionHandler)

  // ------------------------------------------------------------------
  // Clipboard copy: any element with `data-copy-cmd="..."` copies that
  // string when clicked, briefly swapping its label to "✓ 已复制".
  // ------------------------------------------------------------------

  document.addEventListener("click", function (ev) {
    const btn = ev.target && ev.target.closest ? ev.target.closest("[data-copy-cmd]") : null
    if (!btn) return
    ev.preventDefault()
    const cmd = btn.getAttribute("data-copy-cmd") || ""
    if (!cmd) return
    const finish = function () {
      const orig = btn.textContent
      btn.textContent = "✓ 已复制"
      btn.classList.add("req-copy-done")
      setTimeout(function () {
        btn.textContent = orig
        btn.classList.remove("req-copy-done")
      }, 1500)
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(cmd).then(finish).catch(function () {
        copyViaTextarea(cmd)
        finish()
      })
    } else {
      copyViaTextarea(cmd)
      finish()
    }
  })

  function copyViaTextarea(text) {
    const ta = document.createElement("textarea")
    ta.value = text
    ta.style.position = "fixed"
    ta.style.left = "-9999px"
    document.body.appendChild(ta)
    ta.select()
    try { document.execCommand("copy") } catch {}
    document.body.removeChild(ta)
  }
})()
