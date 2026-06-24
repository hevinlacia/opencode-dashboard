// public/app.js
// Page-scoped: report confirm behavior only runs on /report?path=... detail pages.

(function () {
  "use strict"

  const forceRefresh = document.getElementById("op-force-refresh")
  if (forceRefresh) {
    forceRefresh.addEventListener("click", function () {
      const url = new URL(window.location.href)
      url.searchParams.set("_force", String(Date.now()))
      window.location.replace(url.toString())
    })
  }

  // ----- Sessions list (page-scoped) --------------------------------------
  // Refresh button is a plain link to /sessions/refresh; no JS required.

  // ----- Report detail (page-scoped) --------------------------------------
  const reportPath = window.__REPORT_PATH__
  if (!reportPath) return

  const checkboxes = document.querySelectorAll('input[type="checkbox"][data-cid]')
  if (checkboxes.length === 0) return
  const selectionInfo = document.getElementById("selection-info")
  const btnConfirm = document.getElementById("btn-confirm")
  const btnReject = document.getElementById("btn-reject")
  const btnSelectAll = document.getElementById("btn-select-all")
  const btnDeselectAll = document.getElementById("btn-deselect-all")

  function getSelectedIds() {
    return Array.from(checkboxes)
      .filter((cb) => cb.checked)
      .map((cb) => cb.dataset.cid)
  }

  function updateUI() {
    const ids = getSelectedIds()
    if (selectionInfo) selectionInfo.textContent = `${ids.length} selected`
    if (btnConfirm) btnConfirm.disabled = ids.length === 0
    if (btnReject) btnReject.disabled = ids.length === 0

    // Update card visual state
    document.querySelectorAll(".candidate-card").forEach((card) => {
      const cid = card.dataset.cid
      const cb = card.querySelector(`input[data-cid="${cid}"]`)
      card.classList.toggle("checked", cb && cb.checked)
    })
  }

  async function submitSelection(mode) {
    const ids = getSelectedIds()
    if (ids.length === 0) return

    btnConfirm.disabled = true
    btnReject.disabled = true

    try {
      const res = await fetch("/api/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          reportPath: reportPath,
          confirmedIds: mode === "confirm" ? ids : [],
          rejectedIds: mode === "reject" ? ids : [],
          mode: mode,
        }),
      })
      const data = await res.json()
      if (data.ok) {
        if (data.executionTriggered) {
          showToast(
            `✓ Confirmed ${ids.length} candidate(s): ${ids.join(", ")} — execution fork started`,
            "success"
          )
        } else {
          showToast(
            mode === "confirm"
              ? `✓ Confirmed ${ids.length} candidate(s): ${ids.join(", ")}`
              : `✗ Rejected ${ids.length} candidate(s): ${ids.join(", ")}`,
            "success"
          )
        }
      } else {
        showToast("Error: " + (data.error || "unknown"), "error")
      }
    } catch (err) {
      showToast("Network error: " + err.message, "error")
    } finally {
      updateUI()
    }
  }

  function showToast(msg, type) {
    const toast = document.createElement("div")
    toast.className = "toast" + (type === "error" ? " error" : "")
    toast.textContent = msg
    document.body.appendChild(toast)
    setTimeout(() => toast.remove(), 5000)
  }

  // Event listeners
  checkboxes.forEach((cb) => cb.addEventListener("change", updateUI))
  if (btnConfirm) btnConfirm.addEventListener("click", () => submitSelection("confirm"))
  if (btnReject) btnReject.addEventListener("click", () => submitSelection("reject"))
  if (btnSelectAll) btnSelectAll.addEventListener("click", () => {
    checkboxes.forEach((cb) => (cb.checked = true))
    updateUI()
  })
  if (btnDeselectAll) btnDeselectAll.addEventListener("click", () => {
    checkboxes.forEach((cb) => (cb.checked = false))
    updateUI()
  })

  updateUI()
})()
