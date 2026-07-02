/**
 * Tests for `src/releaseChecklist.ts`.
 */

import { test } from "node:test"
import { strict as assert } from "node:assert"

import { buildReleaseChecklist } from "../src/releaseChecklist.ts"

const META = `
# Title Metadata

## Summary
- Title: Test Requirement
- Status: ready
- Projects: wms-yl-cwhsea-wms, oms-yl-cwhsea-oms
- Stakeholders: team-a

## Scope
- Include:
  - 队列迁移
  - wms-waybill 服务
- Exclude:
  - 无
`

const BRANCH = `
# Branches

| Item | Value |
| --- | --- |
| Source branch | \`feature/mq-migrate\` |
| Target branch | \`develop\` |
| PR/CR | 1234 |
| Merge status | merged |

## Commit / Diff Notes
- (暂无)
`

const CONFIG = [
  "# Config And Data Changes",
  "",
  "## MQ 切换",
  "| Item | Value | Environment | Status | Rollback |",
  "| --- | --- | --- | --- | --- |",
  "| RabbitMQ → RocketMQ | `mq.switch.waybill.use-rocket = true` | test | pending | 改回 false |",
  "",
  "## DB 变更",
  "ALTER TABLE `shipment_header` ADD COLUMN `rocket_mq_status` int DEFAULT 0;",
  "",
  "## Apollo 配置",
  "| Key | Value | Env |",
  "| --- | --- | --- |",
  "| `mq.switch.waybill-pdfdown.use-rocket` | true | UAT |",
  "",
  "## RocketMQ Topic / Group",
  "| 类型 | 环境 | 对象 | 操作 | 状态 |",
  "| --- | --- | --- | --- | --- |",
  "| Topic | PRO | `WMS_WAYBILL_TOPIC` | 创建 | 待创建 |",
  "| Group | PRO | `GID_WMS_WAYBILL` | 创建 | 待创建 |",
].join("\n")

const TEST = `
# Test Plan

## 测试入口
- WMS 系统 '下载 PDF' 按钮

## 注意事项
- 需要先在 UAT 环境验证 MQ 连接
- 回滚方案：将开关改回 false

## 可复用验证链路
| 链路名 | 适用环境 | 入口 | 步骤 | 验证点 |
| --- | --- | --- | --- | --- |
| PDF 下载链路 | test/UAT | 下载 PDF 按钮 | 创建订单后点击下载 | RocketMQ 消息发送成功 |
`

const NOTES = `
# Notes

## 上线注意事项
- 先发 wms 服务，等 5 分钟后再发 oms
- 验证 RocketMQ topic 是否创建
`

const REVIEW = `
# 待上线 Code Review

## 发现项
| 严重性 | 问题 | 处理结论 |
| --- | --- | --- |
| medium | MQ 失败日志缺少订单号 | 已补充并复查 |

## 用户确认
- 本轮 review 已处理，无需二次修改
`

test("extracts applications from meta.md", () => {
  const cl = buildReleaseChecklist({ meta: META })
  assert.ok(cl.applications.length > 0)
  assert.ok(cl.applications.some((a) => a.includes("wms")))
})

test("extracts branches from branch.md table", () => {
  const cl = buildReleaseChecklist({ branch: BRANCH })
  assert.ok(cl.branches.length >= 2)
  const src = cl.branches.find((b) => b.label === "Source branch")
  assert.ok(src)
  assert.equal(src!.value, "feature/mq-migrate")
})

test("extracts DB changes from config-changes.md", () => {
  const cl = buildReleaseChecklist({ config: CONFIG })
  assert.ok(cl.dbChanges.length > 0)
  assert.ok(cl.dbChanges.some((d) => d.includes("ALTER TABLE")))
})

test("extracts config changes from config-changes.md", () => {
  {
    const cl = buildReleaseChecklist({ config: CONFIG })
    assert.ok(cl.configChanges.length > 0)
    assert.ok(cl.configChanges.some((c) => c.includes("mq.switch")))
  }
})

test("extracts release notes from notes.md and test.md", () => {
  const cl = buildReleaseChecklist({ notes: NOTES, test: TEST, review: REVIEW })
  assert.ok(cl.releaseNotes.length > 0)
  assert.ok(cl.releaseNotes.some((n) => n.includes("先发 wms")))
  assert.ok(cl.releaseNotes.some((n) => n.includes("回滚")))
  assert.ok(cl.releaseNotes.some((n) => n.includes("review 已处理")))
})

test("extracts MQ cloud resources from config-changes.md", () => {
  const cl = buildReleaseChecklist({ config: CONFIG })
  assert.ok(cl.mqResources.some((r) => r.includes("WMS_WAYBILL_TOPIC")))
  assert.ok(cl.mqResources.some((r) => r.includes("GID_WMS_WAYBILL")))
})

test("extracts reusable verification chains from test.md", () => {
  const cl = buildReleaseChecklist({ test: TEST })
  assert.ok(cl.verificationChains.some((r) => r.includes("PDF 下载链路")))
})

test("extracts review items from review.md", () => {
  const cl = buildReleaseChecklist({ review: REVIEW })
  assert.ok(cl.reviewItems.some((r) => r.includes("MQ 失败日志")))
})

test("returns empty arrays for missing files", () => {
  const cl = buildReleaseChecklist({})
  assert.deepEqual(cl.applications, [])
  assert.deepEqual(cl.branches, [])
  assert.deepEqual(cl.dbChanges, [])
  assert.deepEqual(cl.configChanges, [])
  assert.deepEqual(cl.mqResources, [])
  assert.deepEqual(cl.verificationChains, [])
  assert.deepEqual(cl.reviewItems, [])
  assert.deepEqual(cl.releaseNotes, [])
})

test("handles unknown values gracefully", () => {
  const cl = buildReleaseChecklist({
    meta: "- Projects: unknown\n- Stakeholders: unknown",
    branch: "| Source branch | unknown |",
  })
  assert.deepEqual(cl.applications, [])
  // "unknown" values are filtered out
  assert.ok(cl.branches.every((b) => b.value.toLowerCase() !== "unknown"))
})
