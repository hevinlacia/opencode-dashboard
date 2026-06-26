/**
 * Pure tests for the nav/URL contracts in `src/navigation.ts`.
 *
 * The dashboard intentionally has no route-level tests (no Hono server is
 * booted in tests), so these contracts guard against accidental regressions
 * in the nav order, the homepage path, and the sessions time-filter URLs.
 */

import { test } from "node:test"
import { strict as assert } from "node:assert"

import {
  HOME_PATH,
  NAV_ITEMS,
  PROJECTS_ALIAS_PATH,
  PROJECTS_PATH,
  REPORTS_PATH,
  SCHEDULERS_PATH,
  SESSIONS_PATH,
  sessionsDaysPath,
} from "../src/navigation.ts"

test("NAV_ITEMS labels are projects, sessions, reports, schedulers in that order", () => {
  assert.deepEqual(
    NAV_ITEMS.map((i) => i.label),
    ["/projects", "/sessions", "/reports", "/schedulers"],
  )
})

test("NAV_ITEMS hrefs are /, /sessions, /reports, /schedulers in that order", () => {
  assert.deepEqual(
    NAV_ITEMS.map((i) => i.href),
    ["/", "/sessions", "/reports", "/schedulers"],
  )
})

test("NAV_ITEMS keys are requirements, sessions, reports, schedulers in that order", () => {
  assert.deepEqual(
    NAV_ITEMS.map((i) => i.key),
    ["requirements", "sessions", "reports", "schedulers"],
  )
})

test("HOME_PATH equals PROJECTS_PATH (projects is the site home)", () => {
  assert.equal(HOME_PATH, PROJECTS_PATH)
  assert.equal(HOME_PATH, "/")
})

test("PROJECTS_ALIAS_PATH is /projects and is distinct from HOME_PATH", () => {
  assert.equal(PROJECTS_ALIAS_PATH, "/projects")
  assert.notEqual(PROJECTS_ALIAS_PATH, HOME_PATH)
})

test("SESSIONS_PATH, REPORTS_PATH and SCHEDULERS_PATH constants", () => {
  assert.equal(SESSIONS_PATH, "/sessions")
  assert.equal(REPORTS_PATH, "/reports")
  assert.equal(SCHEDULERS_PATH, "/schedulers")
})

test("sessionsDaysPath builds /sessions?days=<n>", () => {
  assert.equal(sessionsDaysPath(7), "/sessions?days=7")
  assert.equal(sessionsDaysPath(0), "/sessions?days=0")
  assert.equal(sessionsDaysPath(30), "/sessions?days=30")
  assert.equal(sessionsDaysPath(1), "/sessions?days=1")
})
