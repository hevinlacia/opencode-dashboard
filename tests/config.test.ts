/**
 * Tests for `src/config.ts`.
 */

import { test } from "node:test"
import { strict as assert } from "node:assert"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  getConfig,
  setConfig,
  initConfig,
  _resetForTest,
} from "../src/config.ts"

function newTmpPath(): string {
  return join(mkdtempSync(join(tmpdir(), "opencode-config-")), "config.json")
}

test("getConfig returns defaults when no file exists", async () => {
  _resetForTest(newTmpPath())
  const cfg = await getConfig()
  assert.equal(cfg.autoExtract, false)
  assert.equal(cfg.extractModel, "litellm-local/deepseek-v4-flash-auto")
  assert.equal(cfg.minChangeMessages, 5)
  assert.equal(cfg.fullSyncSchedule, true)
})

test("setConfig persists and reloads", async () => {
  const p = newTmpPath()
  _resetForTest(p)
  await setConfig({ autoExtract: true, extractModel: "gpt-4o", minChangeMessages: 10, fullSyncSchedule: false })
  _resetForTest(p)
  await initConfig()
  const cfg = await getConfig()
  assert.equal(cfg.autoExtract, true)
  assert.equal(cfg.extractModel, "gpt-4o")
  assert.equal(cfg.minChangeMessages, 10)
  assert.equal(cfg.fullSyncSchedule, false)
})

test("setConfig merges partial updates", async () => {
  const p = newTmpPath()
  _resetForTest(p)
  await setConfig({ autoExtract: true })
  await setConfig({ minChangeMessages: 20 })
  const cfg = await getConfig()
  assert.equal(cfg.autoExtract, true)
  assert.equal(cfg.minChangeMessages, 20)
  assert.equal(cfg.extractModel, "litellm-local/deepseek-v4-flash-auto")
  assert.equal(cfg.fullSyncSchedule, true)
})
