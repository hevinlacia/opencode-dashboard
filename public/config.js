/**
 * public/config.js
 *
 * Role: page-scoped script for the /settings page. Handles the config
 * form submission via fetch and shows a brief "已保存" confirmation.
 *
 * Constraints / safety:
 *   - No external deps; vanilla DOM only.
 *
 * Read-this-with:
 *   - src/config.ts (the store this script writes to)
 *   - src/server.tsx (/settings route + /api/config)
 */

(function () {
  "use strict"

  var form = document.getElementById("config-form")
  if (!form) return

  var saved = document.getElementById("config-saved")

  form.addEventListener("submit", function (ev) {
    ev.preventDefault()

    var data = {
      autoExtract: document.getElementById("cfg-auto-extract").checked,
      autoExtractSchedule: document.getElementById("cfg-auto-extract-schedule").checked,
      fullSyncSchedule: document.getElementById("cfg-full-sync-schedule").checked,
      extractModel: document.getElementById("cfg-model").value.trim(),
      minChangeMessages: parseInt(document.getElementById("cfg-min-change").value, 10),
      autoValuation: document.getElementById("cfg-auto-valuation").checked,
      valuationThreshold: parseInt(document.getElementById("cfg-valuation-threshold").value, 10),
    }

    fetch("/api/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    })
      .then(function (res) {
        if (!res.ok) throw new Error("HTTP " + res.status)
        return res.json()
      })
      .then(function () {
        if (saved) {
          saved.hidden = false
          setTimeout(function () { saved.hidden = true }, 2000)
        }
      })
      .catch(function (err) {
        alert("保存失败：" + (err && err.message ? err.message : err))
      })
  })
})()
