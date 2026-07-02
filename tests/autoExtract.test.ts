/**
 * Tests for `src/autoExtract.ts`.
 */

import { test } from "node:test"
import { strict as assert } from "node:assert"

import {
  buildAutoExtractPrompt,
  parseAutoExtractOutput,
  filterAllowed,
} from "../src/autoExtract.ts"

test("buildAutoExtractPrompt includes file contents and rules", () => {
  const prompt = buildAutoExtractPrompt(
    { id: "req1", title: "Test Req", status: "开发中" },
    {
      meta: "- Title: Test Req\n- Status: dev",
      memory: "## 当前进展\n- 已完成建模",
      branch: "| Source branch | `feature/x` |",
      config: "## MQ\nmq.switch.x = true",
      test: "## 测试入口\n- 按钮",
      notes: "## 旧摘要\n老内容",
      review: "## 发现项\n- 无阻塞问题",
    },
  )
  assert.match(prompt, /Test Req/)
  assert.match(prompt, /开发中/)
  assert.match(prompt, /meta\.md/)
  assert.match(prompt, /memory\.md/)
  assert.match(prompt, /branch\.md/)
  assert.match(prompt, /config-changes\.md/)
  assert.match(prompt, /test\.md/)
  assert.match(prompt, /notes\.md/)
  assert.match(prompt, /review\.md/)
  assert.match(prompt, /===UPDATE:/)
  assert.match(prompt, /===APPEND:/)
  assert.match(prompt, /不要修改 meta\.md 中的 Status 行/)
  assert.match(prompt, /需求生命周期记忆/)
  assert.match(prompt, /可复用验证链路/)
})

test("buildAutoExtractPrompt truncates long notes.md to last 80 lines", () => {
  const longNotes = Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n")
  const prompt = buildAutoExtractPrompt(
    { id: "req1", title: "T", status: "开发中" },
    { notes: longNotes },
  )
  assert.match(prompt, /line 199/)
  assert.doesNotMatch(prompt, /line 100\n/)
})

test("parseAutoExtractOutput parses UPDATE blocks", () => {
  const output = [
    "===UPDATE: branch.md===",
    "# Branches",
 "| Source branch | `feature/new` |",
    "",
    "===APPEND: notes.md===",
    "## 新摘要",
    "新增了分支信息",
    "",
    "===SUMMARY===",
    "更新了分支信息，追加了摘要",
  ].join("\n")

  const result = parseAutoExtractOutput(output)
  assert.equal(result.updates.length, 1)
  assert.equal(result.updates[0].filename, "branch.md")
  assert.match(result.updates[0].content, /feature\/new/)
  assert.equal(result.appends.length, 1)
  assert.equal(result.appends[0].filename, "notes.md")
  assert.match(result.appends[0].content, /新摘要/)
  assert.equal(result.summary, "更新了分支信息，追加了摘要")
})

test("parseAutoExtractOutput handles missing SUMMARY", () => {
  const output = "===UPDATE: test.md===\nsome content"
  const result = parseAutoExtractOutput(output)
  assert.equal(result.updates.length, 1)
  assert.equal(result.summary, "")
})

test("parseAutoExtractOutput handles empty output", () => {
  const result = parseAutoExtractOutput("")
  assert.equal(result.updates.length, 0)
  assert.equal(result.appends.length, 0)
  assert.equal(result.summary, "")
})

test("filterAllowed removes non-whitelisted filenames", () => {
  const result = parseAutoExtractOutput([
    "===UPDATE: state.json===",
    '{"status": "已完成"}',
    "===UPDATE: branch.md===",
    "new content",
    "===UPDATE: memory.md===",
    "memory content",
    "===UPDATE: review.md===",
    "review content",
    "===APPEND: /etc/passwd===",
    "hacked",
    "===UPDATE: config-changes.md===",
    "config content",
  ].join("\n"))

  const filtered = filterAllowed(result)
  const updateNames = filtered.updates.map((u) => u.filename).sort()
  assert.deepEqual(updateNames, ["branch.md", "config-changes.md", "memory.md", "review.md"])
  assert.equal(filtered.appends.length, 0)
})

test("filterAllowed allows appending to memory.md, notes.md, meta.md, and review.md", () => {
  const result = parseAutoExtractOutput([
    "===APPEND: memory.md===",
    "memory content",
    "===APPEND: notes.md===",
    "note content",
    "===APPEND: meta.md===",
    "extra meta",
    "===APPEND: review.md===",
    "review content",
  ].join("\n"))

  const filtered = filterAllowed(result)
  assert.equal(filtered.appends.length, 4)
})
