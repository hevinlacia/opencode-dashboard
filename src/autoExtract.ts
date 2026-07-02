/**
 * Auto-extract: reads all requirement context files, builds a rich
 * prompt that includes both the session transcript and the existing
 * file contents, then parses the agent's output into per-file diffs.
 *
 * Role: the "smart" extract mode. Instead of just summarizing the
 * session into notes.md, the agent sees the full requirement context
 * (meta.md, memory.md, branch.md, config-changes.md, test.md,
 * notes.md, review.md) and
 * decides which files need updating based on what happened in the
 * session.
 *
 * Public surface:
 *   - buildAutoExtractPrompt(req, files): string
 *   - parseAutoExtractOutput(output): { updates, appends, summary }
 *
 * Constraints / safety:
 *   - Pure functions only — no I/O, no spawn. The caller (server.tsx)
 *     reads files and spawns opencode.
 *   - The prompt explicitly forbids modifying the Status line in
 *     meta.md.
 *
 * Read-this-with:
 *   - `src/sessionExtract.ts` (the spawn mechanism is reused)
 *   - `src/requirements.ts` (Requirement type)
 *   - `src/server.tsx` (the /api/requirement/auto-extract route)
 */

import type { Requirement } from "./requirements.ts"

export interface ContextFiles {
  meta?: string
  memory?: string
  branch?: string
  config?: string
  test?: string
  notes?: string
  review?: string
}

export interface FileUpdate {
  /** Filename relative to reqDir, e.g. "branch.md". */
  filename: string
  /** Full new content for the file (replaces existing). */
  content: string
}

export interface FileAppend {
  filename: string
  /** Content to append to the end of the file. */
  content: string
}

export interface AutoExtractResult {
  updates: FileUpdate[]
  appends: FileAppend[]
  summary: string
}

/**
 * Build the prompt for auto-extract mode.
 *
 * The prompt includes:
 *   1. The requirement title and current status
 *   2. The full content of each context file (so the agent can see
 *      what's already there and decide what to update)
 *   3. Strict output format instructions using `===UPDATE:` and
 *      `===APPEND:` delimiters
 *   4. An explicit prohibition on touching the Status line in meta.md
 */
export function buildAutoExtractPrompt(
  req: Pick<Requirement, "id" | "title" | "status">,
  files: ContextFiles,
): string {
  const title = (req.title || "").trim() || req.id
  const status = (req.status || "").trim() || "未知"

  const parts: string[] = [
    `你是一个需求上下文维护助手。请根据本次会话内容，判断需求《${title}》（当前状态：${status}）的上下文文件中哪些需要更新或补充。`,
    "",
    "以下是需求目录下现有的上下文文件内容（如果某个文件为空说明尚未创建）：",
    "",
  ]

  if (files.meta !== undefined) {
    parts.push("=== 现有 meta.md ===", files.meta || "(空)", "")
  }
  if (files.memory !== undefined) {
    parts.push("=== 现有 memory.md（需求生命周期记忆）===", files.memory || "(空)", "")
  }
  if (files.branch !== undefined) {
    parts.push("=== 现有 branch.md ===", files.branch || "(空)", "")
  }
  if (files.config !== undefined) {
    parts.push("=== 现有 config-changes.md ===", files.config || "(空)", "")
  }
  if (files.test !== undefined) {
    parts.push("=== 现有 test.md ===", files.test || "(空)", "")
  }
  if (files.notes !== undefined) {
    // Only show the last ~80 lines of notes.md to keep the prompt short.
    const noteLines = (files.notes || "").split("\n")
    const shown = noteLines.length > 80 ? noteLines.slice(-80).join("\n") : files.notes || "(空)"
    parts.push("=== 现有 notes.md（仅末尾 80 行）===", shown, "")
  }
  if (files.review !== undefined) {
    parts.push("=== 现有 review.md ===", files.review || "(空)", "")
  }

  parts.push(
    "请分析本次会话内容，结合以上现有文件，判断哪些文件需要更新。",
    "",
    "## 输出格式（严格遵守）",
    "",
    "对于需要整体替换的文件，输出：",
    "===UPDATE: <文件名>===",
    "<完整的新文件内容>",
    "",
    "对于需要在末尾追加的文件（如 notes.md），输出：",
    "===APPEND: <文件名>===",
    "<追加的内容>",
    "",
    "如果某个文件不需要变更，不要输出它。",
    "",
    "最后必须输出变更说明：",
    "===SUMMARY===",
    "<简要说明本次更新了什么，不超过 5 行>",
    "",
    "## 规则",
    "1. 不要修改 meta.md 中的 Status 行（状态只有用户能改）",
    "2. 只输出有变更的文件，不要输出未变更的文件",
    "3. 保持原有文件的格式和风格（表格用 Markdown 表格，列表用 - 或 *）",
    "4. 对于 memory.md，维护跨 session 的需求记忆：当前目标、当前进展、关键决策、已完成改动、待办/风险、影响范围、Session 摘要索引",
    "5. 对于 branch.md，维护上线包中的应用、仓库、分支、基准分支、PR/Commit、是否需上线、备注",
    "6. 对于 config-changes.md，维护 DB、Apollo、Nacos、RocketMQ Topic/Group、阿里云控制台等非代码配置变更",
    "7. 对于 test.md，维护 PRD/需求测试用例、自测记录、可复用验证链路，方便 test/UAT/PRO 前重复验证",
    "8. 对于 review.md，仅在本次会话包含待上线 code review 或用户确认的 review 处理结论时更新",
    "9. 对于 notes.md，追加本次会话的关键决策、已完成验证、待办事项",
    "10. 如果会话内容与需求上下文无关或无需更新，只输出 SUMMARY 说明原因",
    "",
    "不要写客套话，不要用 markdown 代码块包裹整篇输出。",
  )

  return parts.join("\n")
}

/**
 * Parse the agent's output into per-file updates and appends.
 *
 * Expected format:
 *   ===UPDATE: branch.md===
 *   <content>
 *   ===APPEND: notes.md===
 *   <content>
 *   ===SUMMARY===
 *   <summary text>
 *
 * Robust against:
 *   - Missing SUMMARY (returns empty string)
 *   - Extra whitespace around delimiters
 *   - Content that contains "===" (only matches at line start)
 *   - Unknown filenames (ignored)
 */
export function parseAutoExtractOutput(output: string): AutoExtractResult {
  const result: AutoExtractResult = {
    updates: [],
    appends: [],
    summary: "",
  }

  const lines = output.split("\n")
  let i = 0

  while (i < lines.length) {
    const line = lines[i]

    const updateMatch = line.match(/^===UPDATE:\s*(.+?)\s*===/)
    if (updateMatch) {
      const filename = updateMatch[1].trim()
      const collected = collectUntilDelimiter(lines, i + 1)
      if (filename && collected.text) {
        result.updates.push({ filename, content: collected.text })
      }
      i = collected.nextIndex
      continue
    }

    const appendMatch = line.match(/^===APPEND:\s*(.+?)\s*===/)
    if (appendMatch) {
      const filename = appendMatch[1].trim()
      const collected = collectUntilDelimiter(lines, i + 1)
      if (filename && collected.text) {
        result.appends.push({ filename, content: collected.text })
      }
      i = collected.nextIndex
      continue
    }

    const summaryMatch = line.match(/^===SUMMARY===/)
    if (summaryMatch) {
      const collected = collectUntilDelimiter(lines, i + 1)
      result.summary = collected.text.trim()
      i = collected.nextIndex
      continue
    }

    i++
  }

  return result
}

/**
 * Collect lines until the next `===` delimiter or end of input.
 * Returns the joined text and the index to resume from.
 */
function collectUntilDelimiter(
  lines: string[],
  start: number,
): { text: string; nextIndex: number } {
  const collected: string[] = []
  let i = start
  while (i < lines.length) {
    if (/^===/.test(lines[i])) break
    collected.push(lines[i])
    i++
  }
  // Trim trailing empty lines
  while (collected.length > 0 && collected[collected.length - 1].trim() === "") {
    collected.pop()
  }
  return { text: collected.join("\n"), nextIndex: i }
}

/**
 * Whitelist of filenames the agent is allowed to modify.
 * meta.md is NOT in updates (only appends for non-Status content).
 */
export const ALLOWED_UPDATE_FILES = new Set([
  "memory.md",
  "branch.md",
  "config-changes.md",
  "test.md",
  "notes.md",
  "review.md",
])

export const ALLOWED_APPEND_FILES = new Set([
  "memory.md",
  "notes.md",
  "meta.md",
  "review.md",
])

/**
 * Filter the parsed result to only allow whitelisted filenames.
 * This is a safety net — even if the agent tries to write
 * "state.json" or "../../etc/passwd", we ignore it.
 */
export function filterAllowed(result: AutoExtractResult): AutoExtractResult {
  return {
    updates: result.updates.filter((u) => ALLOWED_UPDATE_FILES.has(u.filename)),
    appends: result.appends.filter((a) => ALLOWED_APPEND_FILES.has(a.filename)),
    summary: result.summary,
  }
}
