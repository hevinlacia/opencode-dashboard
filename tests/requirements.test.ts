/**
 * Unit tests for the new Hermes-backed src/requirements.ts.
 *
 * The Hermes scanner reads from `~/.agents/req/`, which is hard to
 * isolate per-test, so these tests focus on the *association store*
 * (overridable via `_setStorePath`) and on functions whose behavior
 * is well-defined when no Hermes requirement directory is present:
 *
 *   - the synthetic default requirement
 *   - associateSession / getRequirementForSession / getRequirementTitleForSession
 *   - getAllAssociatedSessionIds
 *   - generateSessionId
 *   - buildInjectionContext for DEFAULT_REQ_ID
 *   - load/save round-trip + legacy migration
 *
 * Each test points the store at a fresh temp file under
 * /tmp/opencode/test-req-X/associations.json so the tests cannot
 * interfere with the real user store at
 * ~/.local/share/opencode-dashboard/associations.json.
 */

import { test } from "node:test"
import { strict as assert } from "node:assert"
import { join, dirname } from "node:path"
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs"
import { randomBytes } from "node:crypto"

import {
  _setStorePath,
  _getStorePath,
  _setReqDir,
  _getReqDir,
  loadAssociations,
  saveAssociations,
  associateSession,
  getRequirementForSession,
  getRequirementTitleForSession,
  getAllAssociatedSessionIds,
  generateSessionId,
  buildInjectionContext,
  scanHermesRequirements,
  DEFAULT_REQ_ID,
} from "../src/requirements.ts"

function freshStore(): string {
  const dir = join("/tmp", "opencode", "test-req-" + randomBytes(6).toString("hex"))
  mkdirSync(dir, { recursive: true })
  const path = join(dir, "associations.json")
  _setStorePath(path)
  return path
}

test("loadAssociations: returns empty store when file doesn't exist", async () => {
  const path = freshStore()
  assert.equal(existsSync(path), false)
  const store = await loadAssociations()
  assert.equal(store.version, 2)
  assert.deepEqual(store.associations, {})
  assert.equal(_getStorePath(), path)
})

test("associateSession: adds sessionId to requirement", async () => {
  freshStore()
  await associateSession("REQ-TEST-001", "ses_abc")
  const req = await getRequirementForSession("ses_abc")
  // Since no Hermes dir contains "REQ-TEST-001", the function falls
  // back to the synthetic default requirement.
  assert.equal(req.id, DEFAULT_REQ_ID)

  // But the association itself is recorded in the store.
  const all = await getAllAssociatedSessionIds()
  assert.ok(all.has("ses_abc"))
})

test("associateSession: moves session from one requirement to another", async () => {
  freshStore()
  await associateSession("REQ-A", "ses_move")
  await associateSession("REQ-B", "ses_move")

  const store = await loadAssociations()
  // REQ-A should no longer contain the session (and may have been deleted).
  const inA = store.associations["REQ-A"] ?? []
  assert.equal(inA.includes("ses_move"), false)
  // REQ-B should contain it.
  const inB = store.associations["REQ-B"] ?? []
  assert.deepEqual(inB, ["ses_move"])
})

test("getRequirementForSession: returns default for unassociated session", async () => {
  freshStore()
  const req = await getRequirementForSession("ses_orphan")
  assert.equal(req.id, DEFAULT_REQ_ID)
  assert.equal(req.title, "默认需求")
})

test("getRequirementTitleForSession: returns title", async () => {
  freshStore()
  await associateSession("REQ-TEST-001", "ses_titled")
  // No Hermes dir for REQ-TEST-001, so falls back to the synthetic
  // default requirement whose title is "默认需求".
  const title = await getRequirementTitleForSession("ses_titled")
  assert.equal(title, "默认需求")
})

test("getAllAssociatedSessionIds: returns correct set", async () => {
  freshStore()
  await associateSession("REQ-A", "ses_1")
  await associateSession("REQ-B", "ses_2")

  const all = await getAllAssociatedSessionIds()
  assert.equal(all.size, 2)
  assert.ok(all.has("ses_1"))
  assert.ok(all.has("ses_2"))
  assert.equal(all.has("ses_3"), false)
})

test("generateSessionId: returns string matching ^ses_[A-Za-z0-9]+$", () => {
  for (let i = 0; i < 20; i++) {
    const id = generateSessionId()
    assert.match(id, /^ses_[A-Za-z0-9]+$/)
    // 24 hex chars after the prefix (12 random bytes hex-encoded).
    assert.equal(id.length, 4 + 24)
  }
})

test("buildInjectionContext: returns minimal context for DEFAULT_REQ_ID", async () => {
  freshStore()
  const ctx = await buildInjectionContext(DEFAULT_REQ_ID)
  assert.match(ctx, /需求：默认需求/)
  assert.match(ctx, /状态：开发中/)
  assert.match(ctx, /请阅读以上需求背景和进展信息/)
  // DEFAULT_REQ_ID fallback must NOT include the new path-listing /
  // file-modification hints — those are only for real Hermes requirements.
  assert.equal(ctx.includes("需求文件"), false)
  assert.equal(ctx.includes("你可以直接修改上述文件"), false)
  assert.equal(ctx.includes("需求文档维护"), false)
})

test("buildInjectionContext: lists file paths and content for a real requirement", async () => {
  freshStore()
  const reqId = "REQ-PATHS-" + randomBytes(4).toString("hex")
  // Legacy flat layout: <reqDir>/<req-id>/meta.md — matches
  // scanHermesRequirements' legacy branch.
  const reqDir = join(
    "/tmp",
    "opencode",
    "test-req-paths-" + randomBytes(6).toString("hex"),
  )
  const reqSubDir = join(reqDir, reqId)
  mkdirSync(reqSubDir, { recursive: true })

  const metaContent =
    "---\n" +
    "title: Path Test Requirement\n" +
    "status: 开发中\n" +
    "---\n" +
    "Path test description."
  const backgroundContent = "Background snippet line one."
  const branchContent = "Branch info snippet line one."
  const notesContent = "Notes snippet line one."
  writeFileSync(join(reqSubDir, "meta.md"), metaContent, "utf-8")
  writeFileSync(join(reqSubDir, "background.md"), backgroundContent, "utf-8")
  writeFileSync(join(reqSubDir, "branch.md"), branchContent, "utf-8")
  writeFileSync(join(reqSubDir, "notes.md"), notesContent, "utf-8")

  const prevReqDir = _getReqDir()
  _setReqDir(reqDir)
  try {
    const ctx = await buildInjectionContext(reqId)

    // Three labeled content sections must each carry their own file body
    // — no more combined "开发笔记" block, and the new "需求背景" /
    // "当前进展" / "分支与改动" sections must all appear.
    assert.match(ctx, /需求背景：/)
    assert.match(ctx, /当前进展：/)
    assert.match(ctx, /分支与改动：/)

    // Path-listing section must include all five known files (background,
    // branch, notes, test, config-changes) by absolute path.
    assert.match(ctx, /需求文件：/)
    assert.ok(ctx.includes(join(reqSubDir, "background.md")))
    assert.ok(ctx.includes(join(reqSubDir, "branch.md")))
    assert.ok(ctx.includes(join(reqSubDir, "notes.md")))
    assert.ok(ctx.includes(join(reqSubDir, "test.md")))
    assert.ok(ctx.includes(join(reqSubDir, "config-changes.md")))

    // Bodies of the three inlined files appear in the output.
    assert.ok(ctx.includes(backgroundContent))
    assert.ok(ctx.includes(branchContent))
    assert.ok(ctx.includes(notesContent))

    // Files we did NOT create (test.md, config-changes.md) still appear
    // in the path listing but their bodies are NOT inlined.
    assert.equal(ctx.includes("Test missing snippet"), false)
    assert.equal(ctx.includes("测试范围（"), false)
    assert.equal(ctx.includes("配置变更（"), false)

    // The new closing line tells the agent to wait for instructions.
    assert.match(ctx, /请阅读以上需求背景和进展信息/)
    assert.match(ctx, /不要自行开始执行任何任务/)
    // Old "continue and modify files" closing line is gone.
    assert.equal(ctx.includes("请基于以上需求上下文继续"), false)
    assert.equal(ctx.includes("你可以直接修改上述文件"), false)

    // Maintenance instructions are present for real requirements.
    assert.match(ctx, /【需求文档维护】/)
    assert.match(ctx, /请主动更新对应文件/)
    assert.match(ctx, /不要修改 meta\.md 的 status 字段/)
  } finally {
    _setReqDir(prevReqDir)
  }
})

test("scanHermesRequirements: picks up backgroundPath when background.md exists", async () => {
  freshStore()
  const reqId = "REQ-BG-" + randomBytes(4).toString("hex")
  const reqDir = join(
    "/tmp",
    "opencode",
    "test-req-bg-" + randomBytes(6).toString("hex"),
  )
  const reqSubDir = join(reqDir, reqId)
  mkdirSync(reqSubDir, { recursive: true })

  const metaContent =
    "---\n" +
    "title: BG Test Requirement\n" +
    "status: 开发中\n" +
    "---\n"
  writeFileSync(join(reqSubDir, "meta.md"), metaContent, "utf-8")
  writeFileSync(
    join(reqSubDir, "background.md"),
    "Background body for the BG test.",
    "utf-8",
  )

  const prevReqDir = _getReqDir()
  _setReqDir(reqDir)
  try {
    const list = await scanHermesRequirements()
    const hit = list.find((r) => r.id === reqId)
    assert.ok(hit, "requirement should be discovered by scanHermesRequirements")
    assert.equal(
      hit!.backgroundPath,
      join(reqSubDir, "background.md"),
      "backgroundPath must be set when background.md exists",
    )
    assert.equal(
      hit!.backgroundPath?.endsWith("background.md"),
      true,
    )
  } finally {
    _setReqDir(prevReqDir)
  }
})

test("scanHermesRequirements: leaves backgroundPath undefined when background.md is missing", async () => {
  freshStore()
  const reqId = "REQ-NO-BG-" + randomBytes(4).toString("hex")
  const reqDir = join(
    "/tmp",
    "opencode",
    "test-req-no-bg-" + randomBytes(6).toString("hex"),
  )
  const reqSubDir = join(reqDir, reqId)
  mkdirSync(reqSubDir, { recursive: true })

  const metaContent =
    "---\n" +
    "title: No-BG Test Requirement\n" +
    "status: 开发中\n" +
    "---\n"
  writeFileSync(join(reqSubDir, "meta.md"), metaContent, "utf-8")
  // Intentionally NOT writing background.md.
  assert.equal(existsSync(join(reqSubDir, "background.md")), false)

  const prevReqDir = _getReqDir()
  _setReqDir(reqDir)
  try {
    const list = await scanHermesRequirements()
    const hit = list.find((r) => r.id === reqId)
    assert.ok(hit)
    assert.equal(
      hit!.backgroundPath,
      undefined,
      "backgroundPath must be undefined when no background.md exists",
    )
  } finally {
    _setReqDir(prevReqDir)
  }
})

test("saveAssociations + loadAssociations: round-trip", async () => {
  freshStore()
  const written = {
    version: 2 as const,
    associations: {
      "REQ-X": ["ses_x1", "ses_x2"],
      "REQ-Y": ["ses_y1"],
    },
  }
  await saveAssociations(written)
  const loaded = await loadAssociations()
  assert.equal(loaded.version, 2)
  assert.deepEqual(loaded.associations, written.associations)
})

test("migration: old requirements.json format migrates to associations", async () => {
  // freshStore() picks a brand-new directory; the new store path does
  // NOT exist yet. Drop a legacy `requirements.json` next to it so
  // loadAssociations() finds and migrates it.
  const newPath = freshStore()
  const legacyPath = join(dirname(newPath), "requirements.json")
  const legacy = {
    requirements: [
      { id: "req_old1", sessionIds: ["ses_a", "ses_b"] },
      { id: "req_old2", sessionIds: ["ses_c"] },
      // legacy entry with no sessionIds — should be skipped (sids.length > 0).
      { id: "req_old3" },
    ],
  }
  writeFileSync(legacyPath, JSON.stringify(legacy), "utf-8")

  const store = await loadAssociations()
  assert.equal(store.version, 2)
  assert.deepEqual(store.associations["req_old1"], ["ses_a", "ses_b"])
  assert.deepEqual(store.associations["req_old2"], ["ses_c"])
  assert.equal(store.associations["req_old3"], undefined)

  // After migration, the new associations file should now exist.
  assert.equal(existsSync(newPath), true)
  const onDisk = JSON.parse(readFileSync(newPath, "utf-8"))
  assert.equal(onDisk.version, 2)
  assert.deepEqual(onDisk.associations["req_old1"], ["ses_a", "ses_b"])
})
