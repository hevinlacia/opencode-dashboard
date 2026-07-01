/**
 * Requirement (需求) data layer — Hermes-backed.
 *
 * Requirement records live as Markdown directories under `~/.agents/req/`,
 * managed by the Hermes `req-tracker` skill. The dashboard owns only
 * session associations, persisted at
 * `~/.local/share/opencode-dashboard/associations.json`.
 *
 * Tests can override the associations store path via `_setStorePath`.
 *
 * Only `node:` built-ins are used. Never reads or writes any
 * `.env` / secret file.
 */

import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { randomBytes } from "node:crypto"

import { readRequirementState } from "./requirementState.ts"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ReqStatus = "待设计" | "待开发" | "开发中" | "自测中" | "测试中" | "待上线" | "已完成"

export const REQ_STATUSES: ReqStatus[] = [
  "待设计",
  "待开发",
  "开发中",
  "自测中",
  "测试中",
  "待上线",
  "已完成",
]

export interface Requirement {
  id: string
  title: string
  status: ReqStatus
  project: string
  /**
   * Sub-path of intermediate grouping directories between the project
   * root and this requirement. For example, a requirement at
   *   ~/.agents/req/WMS/disaster-recovery/mq-migration/<req>/meta.md
   * has project = "WMS" and groupPath = ["disaster-recovery", "mq-migration"].
   * Legacy flat layouts (~/.agents/req/<req>/meta.md) carry an empty
   * groupPath.
   */
  groupPath: string[]
  description: string
  sessionIds: string[]
  createdAt: number
  updatedAt: number
  metaPath?: string
  backgroundPath?: string
  branchPath?: string
  testPath?: string
  notesPath?: string
  configPath?: string
  /**
   * Directory holding this requirement's files. Stored on the record so
   * the status-write API can locate `state.json` without re-deriving the
   * path from project/groupPath/id.
   */
  reqDir?: string
  /**
   * If this requirement is a child of another requirement (nested inside
   * its directory), the parent's req-id. Undefined for top-level or
   * parent requirements.
   */
  parentReqId?: string
  /**
   * If this requirement has child requirements (sub-directories with
   * their own meta.md), their req-ids. Undefined/empty for leaf
   * requirements.
   */
  childIds?: string[]
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const DEFAULT_REQ_ID = "__default__"
export const DEFAULT_PROJECT_NAME = "默认项目"

const DEFAULT_REQ_DIR = join(homedir(), ".agents", "req")
let _reqDir: string = DEFAULT_REQ_DIR

/**
 * Override the Hermes requirement scan root. Test-only — production code
 * relies on the default `~/.agents/req/` path. Mirrors `_setStorePath`.
 */
export function _setReqDir(path: string): void {
  _reqDir = path
}

export function _getReqDir(): string {
  return _reqDir
}

// ---------------------------------------------------------------------------
// Associations store (test-overridable)
// ---------------------------------------------------------------------------

interface AssociationStore {
  version: 2
  associations: Record<string, string[]>
}

const DEFAULT_STORE_PATH = join(
  homedir(),
  ".local",
  "share",
  "opencode-dashboard",
  "associations.json"
)

let _storePath: string = DEFAULT_STORE_PATH

export function _setStorePath(path: string): void {
  _storePath = path
}

export function _getStorePath(): string {
  return _storePath
}

async function ensureStoreDir(): Promise<void> {
  const dir = dirname(_storePath)
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true })
  }
}

function emptyAssociations(): AssociationStore {
  return { version: 2, associations: {} }
}

function isReqStatus(v: unknown): v is ReqStatus {
  return typeof v === "string" && (REQ_STATUSES as string[]).includes(v)
}

/**
 * Load associations. Migrates the legacy `requirements.json` format
 * (which embedded sessionIds in each requirement record) into the new
 * shape on first read.
 */
export async function loadAssociations(): Promise<AssociationStore> {
  if (!existsSync(_storePath)) {
    // Check for a legacy requirements.json sitting next to the new file
    // and migrate any sessionIds out of it.
    const legacyPath = join(dirname(_storePath), "requirements.json")
    if (existsSync(legacyPath) && legacyPath !== _storePath) {
      try {
        const raw = await readFile(legacyPath, "utf-8")
        const parsed = JSON.parse(raw) as unknown
        const store = emptyAssociations()
        if (parsed && typeof parsed === "object") {
          const reqArr = (parsed as { requirements?: unknown }).requirements
          if (Array.isArray(reqArr)) {
            for (const item of reqArr) {
              if (!item || typeof item !== "object") continue
              const o = item as Record<string, unknown>
              if (typeof o.id !== "string" || !o.id) continue
              const sids = Array.isArray(o.sessionIds)
                ? (o.sessionIds.filter((s) => typeof s === "string") as string[])
                : []
              if (sids.length > 0) {
                store.associations[o.id] = sids
              }
            }
          }
        }
        await saveAssociations(store)
        return store
      } catch {
        // Fall through to empty store.
      }
    }
    const empty = emptyAssociations()
    await saveAssociations(empty)
    return empty
  }
  let raw: string
  try {
    raw = await readFile(_storePath, "utf-8")
  } catch {
    return emptyAssociations()
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return emptyAssociations()
  }
  if (!parsed || typeof parsed !== "object") {
    return emptyAssociations()
  }
  const obj = parsed as Record<string, unknown>

  // Legacy format detection: presence of a `requirements` array.
  if (Array.isArray(obj.requirements)) {
    const store = emptyAssociations()
    for (const item of obj.requirements as unknown[]) {
      if (!item || typeof item !== "object") continue
      const o = item as Record<string, unknown>
      if (typeof o.id !== "string" || !o.id) continue
      const sids = Array.isArray(o.sessionIds)
        ? (o.sessionIds.filter((s) => typeof s === "string") as string[])
        : []
      if (sids.length > 0) {
        store.associations[o.id] = sids
      }
    }
    await saveAssociations(store)
    return store
  }

  // New format.
  const associations: Record<string, string[]> = {}
  const rawAssoc = obj.associations
  if (rawAssoc && typeof rawAssoc === "object") {
    for (const [k, v] of Object.entries(rawAssoc as Record<string, unknown>)) {
      if (Array.isArray(v)) {
        const sids = v.filter((s): s is string => typeof s === "string")
        if (sids.length > 0) associations[k] = sids
      }
    }
  }
  return { version: 2, associations }
}

export async function saveAssociations(store: AssociationStore): Promise<void> {
  await ensureStoreDir()
  await writeFile(_storePath, JSON.stringify(store, null, 2), "utf-8")
}

// ---------------------------------------------------------------------------
// Hermes scanner
// ---------------------------------------------------------------------------

interface Frontmatter {
  fields: Record<string, string>
  body: string
}

/**
 * Parse simple YAML-ish frontmatter:
 *   ---
 *   key: value
 *   key2: value2
 *   ---
 *   <body>
 * Quoted values have surrounding single/double quotes stripped.
 * If the file does not start with a `---` line, the entire content is
 * treated as the body.
 */
function parseFrontmatter(text: string): Frontmatter {
  const fields: Record<string, string> = {}
  // Normalize line endings.
  const normalized = text.replace(/\r\n/g, "\n")
  if (!normalized.startsWith("---\n") && normalized !== "---") {
    return { fields, body: normalized }
  }
  const lines = normalized.split("\n")
  // First line is `---`. Find the next `---`.
  let endIdx = -1
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === "---") {
      endIdx = i
      break
    }
  }
  if (endIdx === -1) {
    // Unterminated; treat as no frontmatter.
    return { fields, body: normalized }
  }
  for (let i = 1; i < endIdx; i++) {
    const line = lines[i]
    if (!line || !line.trim() || line.trim().startsWith("#")) continue
    const colonIdx = line.indexOf(":")
    if (colonIdx === -1) continue
    const key = line.slice(0, colonIdx).trim()
    let value = line.slice(colonIdx + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1)
    }
    if (key) fields[key] = value
  }
  const body = lines.slice(endIdx + 1).join("\n")
  return { fields, body }
}

function firstParagraph(body: string): string {
  const trimmed = body.replace(/^\s+/, "")
  if (!trimmed) return ""
  // Split on blank lines.
  const paragraphs = trimmed.split(/\n\s*\n/)
  for (const p of paragraphs) {
    const cleaned = p
      .split("\n")
      // Drop pure heading lines so the description isn't just `# 标题`.
      .filter((l) => !/^\s*#{1,6}\s+/.test(l))
      .join("\n")
      .trim()
    if (cleaned) return cleaned
  }
  return ""
}

function parseStartDate(value: string | undefined): number | null {
  if (!value) return null
  const s = value.trim()
  if (!s) return null
  // Accept YYYY-MM-DD, YYYY/MM/DD, or full ISO.
  const ts = Date.parse(s.replace(/\//g, "-"))
  if (Number.isNaN(ts)) return null
  return ts
}

async function loadRequirementFromDir(
  dirPath: string,
  dirName: string,
  parentProject: string,
  groupPath: string[] = [],
  parentReqId?: string,
): Promise<Requirement | null> {
  let st
  try {
    st = await stat(dirPath)
  } catch {
    return null
  }
  if (!st.isDirectory()) return null

  const metaPath = join(dirPath, "meta.md")
  const backgroundPath = join(dirPath, "background.md")
  const branchPath = join(dirPath, "branch.md")
  const testPath = join(dirPath, "test.md")
  const notesPath = join(dirPath, "notes.md")
  const configPath = join(dirPath, "config-changes.md")

  let title = dirName
  let status: ReqStatus = "开发中"
  let project = parentProject
  let description = ""
  let id = dirName
  let createdAt = st.mtimeMs
  let updatedAt = st.mtimeMs

  let metaPresent = false
  if (existsSync(metaPath)) {
    metaPresent = true
    try {
      const raw = await readFile(metaPath, "utf-8")
      const fm = parseFrontmatter(raw)
      const fields = fm.fields
      if (fields["req-id"]) id = fields["req-id"]
      if (fields["title"]) title = fields["title"]
      const rawStatus = fields["status"]
      if (isReqStatus(rawStatus)) status = rawStatus
      if (fields["project"] && fields["project"].trim()) {
        project = fields["project"].trim()
      }
      const sd = parseStartDate(fields["start-date"])
      if (sd !== null) createdAt = sd
      const desc = firstParagraph(fm.body)
      if (desc) description = desc

      // Markdown-list fallback for hermes meta.md (e.g. "- Title: Foo").
      // Only used when YAML frontmatter didn't already provide a value.
      const titleMatch = raw.match(/^\s*-\s*Title\s*:\s*(.+?)\s*$/im)
      if (titleMatch && (title === dirName || !title)) {
        title = titleMatch[1].trim()
      }
    } catch {
      // Keep defaults.
    }
  }

  // state.json wins over both frontmatter and the markdown-list status.
  // readRequirementState also migrates `- Status: <english>` from
  // meta.md the first time it runs.
  try {
    const state = await readRequirementState(dirPath)
    if (state) {
      status = state.status
      updatedAt = Math.max(updatedAt, state.updatedAt)
    }
  } catch {
    // ignore; fall back to whatever we already have.
  }

  return {
    id,
    title,
    status,
    project,
    groupPath,
    description,
    sessionIds: [],
    createdAt,
    updatedAt,
    metaPath: metaPresent ? metaPath : undefined,
    backgroundPath: existsSync(backgroundPath) ? backgroundPath : undefined,
    branchPath: existsSync(branchPath) ? branchPath : undefined,
    testPath: existsSync(testPath) ? testPath : undefined,
    notesPath: existsSync(notesPath) ? notesPath : undefined,
    configPath: existsSync(configPath) ? configPath : undefined,
    reqDir: dirPath,
    parentReqId,
  }
}

/**
 * Recursively collect requirements (directories that contain meta.md)
 * under `rootPath`. Any directory without meta.md is treated as an
 * intermediate grouping directory and its segment name is appended to
 * `groupPath` for descendants.
 *
 * When a directory has meta.md, it is recorded as a requirement AND the
 * scan continues into its sub-directories to discover child requirements.
 * This supports the parent-child pattern where a top-level requirement
 * acts as a grouping container (e.g. WMS-003-rabbitmq-to-rocketmq/
 *   WMS-003-stock-diff-adjust/meta.md). Child requirements carry
 * `parentReqId` pointing back to the parent.
 *
 * Bounded recursion: max depth 6 to keep accidental symlink loops or
 * deeply nested test fixtures from spinning.
 */
async function collectRequirementsRecursive(
  rootPath: string,
  project: string,
  groupPath: string[],
  out: Requirement[],
  depth = 0,
  parentReqId?: string,
  skipSelfMeta = false,
  parentReqRef?: Requirement,
): Promise<void> {
  if (depth > 6) return
  let st
  try {
    st = await stat(rootPath)
  } catch {
    return
  }
  if (!st.isDirectory()) return

  let currentParent = parentReqId
  let currentGroupPath = groupPath
  let parentReq: Requirement | null = null

  // If skipSelfMeta is true, the caller already loaded this requirement
  // and passed it as parentReqRef. Use it directly so childIds can be
  // tracked on the already-pushed record.
  if (skipSelfMeta && parentReqRef) {
    parentReq = parentReqRef
    currentParent = parentReqRef.id
  }

  // If this directory itself has a meta.md, it IS a requirement.
  // Record it, then continue scanning sub-directories for children.
  // skipSelfMeta is used when we recurse into a child requirement's
  // directory to find grand-children — the child was already loaded by
  // the caller, so we must not load it again.
  if (!skipSelfMeta && existsSync(join(rootPath, "meta.md"))) {
    const dirName = rootPath.split("/").filter(Boolean).pop() || rootPath
    parentReq = await loadRequirementFromDir(rootPath, dirName, project, groupPath, parentReqId)
    if (parentReq) {
      out.push(parentReq)
      currentParent = parentReq.id
      currentGroupPath = groupPath
    }
  }

  let children: string[]
  try {
    children = await readdir(rootPath)
  } catch {
    return
  }
  for (const childName of children) {
    if (childName.startsWith(".") || childName === "README.md") continue
    // Skip non-directory files (meta.md, branch.md, notes.md, etc.)
    const childPath = join(rootPath, childName)
    let childSt
    try {
      childSt = await stat(childPath)
    } catch {
      continue
    }
    if (!childSt.isDirectory()) continue

    // If child has meta.md, load it as a child requirement. If not,
    // recurse as an intermediate grouping directory.
    if (existsSync(join(childPath, "meta.md"))) {
      const req = await loadRequirementFromDir(childPath, childName, project, currentGroupPath, currentParent)
      if (req) {
        out.push(req)
        if (parentReq) {
          if (!parentReq.childIds) parentReq.childIds = []
          parentReq.childIds.push(req.id)
        }
        // Continue scanning into the child for grand-children.
        // skipSelfMeta=true so the child is not loaded a second time;
        // pass req as parentReqRef so grand-children can be tracked.
        await collectRequirementsRecursive(childPath, project, currentGroupPath, out, depth + 1, req.id, true, req)
      }
    } else {
      await collectRequirementsRecursive(
        childPath,
        project,
        [...currentGroupPath, childName],
        out,
        depth + 1,
        currentParent,
      )
    }
  }
}

export async function scanHermesRequirements(): Promise<Requirement[]> {
  const reqDir = _reqDir
  if (!existsSync(reqDir)) return []
  let topEntries: string[]
  try {
    topEntries = await readdir(reqDir)
  } catch {
    return []
  }
  const out: Requirement[] = []
  for (const name of topEntries) {
    if (name === "README.md" || name.startsWith(".")) continue
    const topPath = join(reqDir, name)
    let topSt
    try {
      topSt = await stat(topPath)
    } catch {
      continue
    }
    if (!topSt.isDirectory()) continue

    // Resolve this directory's display project name. `_default` maps to
    // the synthetic default project name.
    const projectDisplay =
      name === "_default" ? DEFAULT_PROJECT_NAME : name

    const hasOwnMeta = existsSync(join(topPath, "meta.md"))

    if (hasOwnMeta) {
      // Legacy flat layout: ~/.agents/req/<req-id>/meta.md
      // project comes from frontmatter or defaults to DEFAULT_PROJECT_NAME.
      // Use collectRequirementsRecursive so children are discovered too.
      await collectRequirementsRecursive(topPath, DEFAULT_PROJECT_NAME, [], out)
      continue
    }

    // Project-level directory. Walk it recursively, accumulating the
    // intermediate grouping path under `groupPath` for each leaf.
    await collectRequirementsRecursive(topPath, projectDisplay, [], out)
  }
  return out
}

// ---------------------------------------------------------------------------
// Synthetic default requirement
// ---------------------------------------------------------------------------

function buildDefaultRequirement(sessionIds: string[]): Requirement {
  const now = Date.now()
  return {
    id: DEFAULT_REQ_ID,
    title: "默认需求",
    status: "开发中",
    project: DEFAULT_PROJECT_NAME,
    groupPath: [],
    description:
      "未关联到具体需求的 session 归属到此默认需求。如需独立管理，可在 ~/.agents/req/ 下创建对应需求目录后重新关联。",
    sessionIds,
    createdAt: now,
    updatedAt: now,
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function getRequirement(id: string): Promise<Requirement | null> {
  const [hermes, store] = await Promise.all([
    scanHermesRequirements(),
    loadAssociations(),
  ])
  if (id === DEFAULT_REQ_ID) {
    // Mirror listRequirementsByProject: the default requirement also owns
    // sessions associated with reqIds that no longer exist in Hermes
    // (orphaned associations), so /projects and /requirement?id=__default__
    // agree on session count.
    const hermesIds = new Set(hermes.map((r) => r.id))
    const orphanSessions: string[] = []
    for (const [reqId, sids] of Object.entries(store.associations)) {
      if (reqId === DEFAULT_REQ_ID) continue
      if (!hermesIds.has(reqId)) {
        for (const s of sids) orphanSessions.push(s)
      }
    }
    const defaultSessions = [
      ...(store.associations[DEFAULT_REQ_ID] ?? []),
      ...orphanSessions,
    ]
    return buildDefaultRequirement(defaultSessions)
  }
  const found = hermes.find((r) => r.id === id)
  if (!found) return null
  found.sessionIds = store.associations[found.id] ?? []
  return found
}

export async function listRequirementsByProject(): Promise<
  { project: string; requirements: Requirement[] }[]
> {
  const [hermes, store] = await Promise.all([
    scanHermesRequirements(),
    loadAssociations(),
  ])

  // Attach sessionIds from associations.
  const hermesIds = new Set(hermes.map((r) => r.id))
  for (const r of hermes) {
    r.sessionIds = store.associations[r.id] ?? []
  }

  // Build the synthetic default requirement: it owns sessions under
  // DEFAULT_REQ_ID *and* any sessions associated with reqIds that no
  // longer exist in Hermes (orphaned associations).
  const orphanSessions: string[] = []
  for (const [reqId, sids] of Object.entries(store.associations)) {
    if (reqId === DEFAULT_REQ_ID) continue
    if (!hermesIds.has(reqId)) {
      for (const s of sids) orphanSessions.push(s)
    }
  }
  const defaultSessions = [
    ...(store.associations[DEFAULT_REQ_ID] ?? []),
    ...orphanSessions,
  ]
  const defaultReq = buildDefaultRequirement(defaultSessions)

  // Group by project.
  const groups = new Map<string, Requirement[]>()
  // Track the latest updatedAt per non-default project to drive sort order.
  const projectLatest = new Map<string, number>()
  for (const r of hermes) {
    const proj = r.project || DEFAULT_PROJECT_NAME
    const bucket = groups.get(proj) ?? []
    bucket.push(r)
    groups.set(proj, bucket)
    const cur = projectLatest.get(proj) ?? 0
    if (r.updatedAt > cur) projectLatest.set(proj, r.updatedAt)
  }

  // Always include the default project (even if empty, it carries the
  // synthetic default requirement and any orphan sessions).
  const defaultBucket = groups.get(DEFAULT_PROJECT_NAME) ?? []
  defaultBucket.push(defaultReq)
  groups.set(DEFAULT_PROJECT_NAME, defaultBucket)

  // Sort: non-default projects by updatedAt desc, default project last.
  const nonDefault = [...groups.keys()]
    .filter((p) => p !== DEFAULT_PROJECT_NAME)
    .sort((a, b) => (projectLatest.get(b) ?? 0) - (projectLatest.get(a) ?? 0))
  const ordered = [...nonDefault, DEFAULT_PROJECT_NAME]

  return ordered.map((p) => {
    const reqs = (groups.get(p) ?? [])
      .slice()
      .sort((a, b) => b.updatedAt - a.updatedAt)
    return { project: p, requirements: reqs }
  })
}

export async function associateSession(
  reqId: string,
  sessionId: string
): Promise<void> {
  if (!sessionId) return
  const store = await loadAssociations()
  // Remove the session from any other association first.
  for (const [k, sids] of Object.entries(store.associations)) {
    if (k === reqId) continue
    const idx = sids.indexOf(sessionId)
    if (idx !== -1) {
      sids.splice(idx, 1)
      if (sids.length === 0) {
        delete store.associations[k]
      } else {
        store.associations[k] = sids
      }
    }
  }
  const cur = store.associations[reqId] ?? []
  if (!cur.includes(sessionId)) {
    cur.push(sessionId)
  }
  store.associations[reqId] = cur
  await saveAssociations(store)
}

export async function replaceAssociatedSession(
  reqId: string,
  oldSessionId: string,
  newSessionId: string
): Promise<void> {
  if (!newSessionId) return
  const store = await loadAssociations()
  for (const [k, sids] of Object.entries(store.associations)) {
    if (k === reqId) continue
    const next = sids.filter((s) => s !== newSessionId)
    if (next.length === 0) delete store.associations[k]
    else store.associations[k] = next
  }

  const cur = store.associations[reqId] ?? []
  const next = cur.filter((s) => s !== oldSessionId && s !== newSessionId)
  next.push(newSessionId)
  store.associations[reqId] = next
  await saveAssociations(store)
}

/**
 * Remove a session association from a requirement. If the session is not
 * currently associated, this is a no-op. The session becomes an orphan
 * (visible in the default requirement's list) unless re-associated.
 */
export async function dissociateSession(
  reqId: string,
  sessionId: string
): Promise<void> {
  if (!sessionId || !reqId) return
  const store = await loadAssociations()
  const cur = store.associations[reqId]
  if (!cur) return
  const next = cur.filter((s) => s !== sessionId)
  if (next.length === 0) {
    delete store.associations[reqId]
  } else {
    store.associations[reqId] = next
  }
  await saveAssociations(store)
}

export async function getRequirementForSession(
  sessionId: string
): Promise<Requirement> {
  const store = await loadAssociations()
  let foundReqId: string | null = null
  for (const [reqId, sids] of Object.entries(store.associations)) {
    if (sids.includes(sessionId)) {
      foundReqId = reqId
      break
    }
  }
  if (foundReqId && foundReqId !== DEFAULT_REQ_ID) {
    const hermes = await scanHermesRequirements()
    const hit = hermes.find((r) => r.id === foundReqId)
    if (hit) {
      hit.sessionIds = store.associations[hit.id] ?? []
      return hit
    }
  }
  // Default / orphaned / unassociated → synthetic default.
  const defaultSessions = store.associations[DEFAULT_REQ_ID] ?? []
  return buildDefaultRequirement(defaultSessions)
}

export async function getRequirementTitleForSession(
  sessionId: string
): Promise<string> {
  const req = await getRequirementForSession(sessionId)
  return req.title || "默认需求"
}

export async function getAllAssociatedSessionIds(): Promise<Set<string>> {
  const store = await loadAssociations()
  const out = new Set<string>()
  for (const sids of Object.values(store.associations)) {
    for (const s of sids) out.add(s)
  }
  return out
}

// ---------------------------------------------------------------------------
// Session-id and PTY injection helpers
// ---------------------------------------------------------------------------

export function generateSessionId(): string {
  return "ses_" + randomBytes(12).toString("hex")
}

async function readFileSnippet(path: string | undefined, limit = 500): Promise<string> {
  if (!path || !existsSync(path)) return ""
  try {
    const raw = await readFile(path, "utf-8")
    const trimmed = raw.replace(/^\uFEFF/, "").trim()
    if (!trimmed) return ""
    if (trimmed.length <= limit) return trimmed
    return trimmed.slice(0, limit)
  } catch {
    return ""
  }
}

/**
 * Build the agent-context preamble injected into a session that is bound
 * to a Hermes requirement. The output is concise, background-first:
 *   1. requirement title + status (always)
 *   2. background.md content (up to 500 chars) — the why/what of the work
 *   3. notes.md (current progress, up to 300 chars)
 *   4. branch.md (branch / commit context, up to 300 chars)
 *   5. absolute paths to all five known files so the agent knows where
 *      to read further or write updates
 *   6. a closing line that tells the agent NOT to start work and to wait
 *      for the user to issue the next instruction
 *
 * test.md and config-changes.md are listed by path but their bodies are
 * NOT inlined — the agent can read them on demand once the user gives it
 * a concrete task. Files that do not exist on disk are still listed by
 * path (the agent may create them).
 *
 * The DEFAULT_REQ_ID / "req not found" fallbacks return a minimal
 * 4-line block that only carries the new closing instruction.
 */
export async function buildInjectionContext(reqId: string): Promise<string> {
  const closing =
    "请阅读以上需求背景和进展信息。不要自行开始执行任何任务，等待用户下达具体任务安排。"
  if (reqId === DEFAULT_REQ_ID) {
    return [
      "【需求上下文】",
      "需求：默认需求",
      "状态：开发中",
      closing,
    ].join("\n")
  }
  const hermes = await scanHermesRequirements()
  const req = hermes.find((r) => r.id === reqId)
  if (!req) {
    return [
      "【需求上下文】",
      "需求：默认需求",
      "状态：开发中",
      closing,
    ].join("\n")
  }
  const lines: string[] = []
  lines.push("【需求上下文】")
  lines.push(`需求：${req.title}`)
  lines.push(`状态：${req.status}`)
  if (req.reqDir) {
    // Prefer the per-record *Path populated by loadRequirementFromDir;
    // fall back to <reqDir>/<basename> so paths are always emitted, even
    // for files that don't exist yet (the agent may create them).
    const backgroundFile = req.backgroundPath ?? join(req.reqDir, "background.md")
    const branchFile = req.branchPath ?? join(req.reqDir, "branch.md")
    const notesFile = req.notesPath ?? join(req.reqDir, "notes.md")
    const testFile = req.testPath ?? join(req.reqDir, "test.md")
    const configFile = req.configPath ?? join(req.reqDir, "config-changes.md")

    lines.push("")
    lines.push("需求背景：")
    const background = await readFileSnippet(backgroundFile, 500)
    if (background) {
      lines.push(background)
    } else {
      lines.push(`（未提供 background.md，路径：${backgroundFile}）`)
    }

    lines.push("")
    lines.push("当前进展：")
    const notes = await readFileSnippet(notesFile, 300)
    if (notes) {
      lines.push(notes)
    } else {
      lines.push(`（未提供 notes.md，路径：${notesFile}）`)
    }

    lines.push("")
    lines.push("分支与改动：")
    const branch = await readFileSnippet(branchFile, 300)
    if (branch) {
      lines.push(branch)
    } else {
      lines.push(`（未提供 branch.md，路径：${branchFile}）`)
    }

    lines.push("")
    lines.push("需求文件：")
    lines.push(`  - 需求背景：${backgroundFile}`)
    lines.push(`  - 分支信息：${branchFile}`)
    lines.push(`  - 开发笔记：${notesFile}`)
    lines.push(`  - 测试范围：${testFile}`)
    lines.push(`  - 配置变更：${configFile}`)
  } else {
    // No reqDir on the record (should not happen for real Hermes
    // requirements, but stays defensive): fall back to the old behavior.
    const background = await readFileSnippet(req.backgroundPath, 500)
    if (background) lines.push(`需求背景：${background}`)
    const branch = await readFileSnippet(req.branchPath, 300)
    if (branch) lines.push(`分支与改动：${branch}`)
    const notes = await readFileSnippet(req.notesPath, 300)
    if (notes) lines.push(`当前进展：${notes}`)
    const test = await readFileSnippet(req.testPath)
    if (test) lines.push(`测试范围：${test}`)
  }
  lines.push("")
  lines.push(closing)

  // Maintenance instructions — only injected for real requirements with a
  // reqDir, not for DEFAULT_REQ_ID or not-found fallbacks. This shifts
  // requirement-document upkeep from a delayed fork-based extraction into
  // the live session, so the agent that does the work also records it.
  if (req.reqDir) {
    lines.push("")
    lines.push("【需求文档维护】")
    lines.push(
      "本 session 关联了上述需求文件。在开发过程中达成以下成果时，请主动更新对应文件：",
    )
    lines.push("- 确定或变更分支策略、关键 commit → branch.md")
    lines.push("- 发现 DB/Apollo/Nacos 配置变更 → config-changes.md")
    lines.push("- 明确测试场景、回归范围 → test.md")
    lines.push("- 阶段性进展、关键决策、踩坑 → 追加到 notes.md")
    lines.push(
      "更新方式：直接用文件工具编辑上述路径的文件，保持简洁，只记录关键信息。不要修改 meta.md 的 status 字段（由 dashboard 管理）。",
    )
  }

  return lines.join("\n")
}
