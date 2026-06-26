/**
 * 解析 Claude Code 的 transcript JSONL → core 的 ReviewerInput 字段。
 *
 * 这是 claude adapter 唯一全新的逻辑——opencode 侧从 `client.session.messages()`
 * 拿结构化 message，claude 侧改从 SubagentStop hook 给的 `transcript_path` 读
 * JSONL。schema（基于真实 transcript 核实）：
 *
 *   {type:"assistant", message:{role, content:[{type:"thinking"|"text"|"tool_use", ...}], stop_reason}, uuid, isSidechain, ...}
 *   {type:"user",      message:{role, content: string | [{type:"text"|"tool_result", tool_use_id, content, is_error}]}, isMeta, ...}
 *   （还有 mode / permission-mode / file-history-snapshot / system / ... 等非消息条目，忽略）
 *
 * tool_use 块的工具名是**首字母大写**（Write/Edit/MultiEdit/Bash/...），与 opencode
 * 的小写（write/edit/...）不同——所以工具名集合在本文件本地定义，不与 opencode 共用。
 *
 * 注意：SubagentStop 的 transcript_path 指向**子 agent 自己的** transcript 文件，
 * 整个文件就是该 subagent 的会话，因此这里解析全部 user/assistant 条目、不按
 * isSidechain 过滤。
 *
 * @module
 */

import fs from "node:fs"
import { clip } from "../core/util.mjs"

/** 产生文件改动的 Claude 工具名（首字母大写）。 */
const FILE_MOD_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"])

/** Bash 命令里被视作"写操作"的模式——与 opencode adapter 同源。 */
const SHELL_WRITE_RE =
  /\b(rm|mv|cp|touch|mkdir|chmod|chown|ln|tee|sed\s+-i|>>?|git\s+(add|rm|mv|reset|checkout|commit|push|stash|apply))\b/

const MAX_TOOL_DETAIL = 400
const MAX_TAIL_TEXT = 4_000
const TAIL_MESSAGES = Number(process.env.CC_TOOLKIT_TAIL_MESSAGES ?? 6)

/** 读 JSONL，逐行 parse，坏行跳过。 */
function readEntries(path) {
  const raw = fs.readFileSync(path, "utf8")
  /** @type {any[]} */
  const entries = []
  for (const line of raw.split("\n")) {
    const t = line.trim()
    if (!t) continue
    try {
      entries.push(JSON.parse(t))
    } catch {
      // 跳过坏行（截断写入等）
    }
  }
  return entries
}

const isAssistant = (e) => e?.type === "assistant" && e?.message
const isUser = (e) => e?.type === "user" && e?.message

/** 取 assistant 条目里 text 块拼接（忽略 thinking / tool_use）。 */
function assistantText(entry) {
  const content = entry?.message?.content
  if (typeof content === "string") return content.trim()
  if (!Array.isArray(content)) return ""
  return content
    .filter((b) => b?.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("\n")
    .trim()
}

/** 从 tool_result 块/字符串里取文本。 */
function toolResultText(b) {
  if (typeof b?.content === "string") return b.content
  if (Array.isArray(b?.content)) return b.content.filter((x) => x?.type === "text").map((x) => x.text).join("\n")
  return ""
}

/** 建 tool_use_id → {text, isError} 映射，供 fileChanges detail / tail 状态用。 */
function buildToolResultMap(entries) {
  const map = new Map()
  for (const e of entries) {
    if (!isUser(e)) continue
    const content = e.message.content
    if (!Array.isArray(content)) continue
    for (const b of content) {
      if (b?.type === "tool_result" && b.tool_use_id) {
        map.set(b.tool_use_id, { text: toolResultText(b), isError: b.is_error === true })
      }
    }
  }
  return map
}

/**
 * 解析 transcript 文件，抽出 reviewer 需要的字段。
 *
 * @param {string} path  transcript JSONL 绝对路径（来自 hook 的 transcript_path）
 * @returns {{request:string, finalOutput:string, finishReason:string, errorInfo:string, fileChanges:import("../core/types.js").FileChange[], conversationTail:string}}
 */
export function parseTranscript(path) {
  const entries = readEntries(path)
  const assistants = entries.filter(isAssistant)
  const resultMap = buildToolResultMap(entries)

  // request：第一条有实际文本、非 tool_result、非 meta 的 user message（= 派给 subagent 的任务）
  let request = ""
  for (const e of entries) {
    if (!isUser(e) || e.isMeta) continue
    const c = e.message.content
    let text = ""
    if (typeof c === "string") text = c
    else if (Array.isArray(c)) text = c.find((b) => b?.type === "text")?.text ?? ""
    text = (text || "").trim()
    if (text) {
      request = text
      break
    }
  }

  // finalOutput：最后一条有非空文本的 assistant message
  let finalOutput = ""
  for (let i = assistants.length - 1; i >= 0; i--) {
    const t = assistantText(assistants[i])
    if (t) {
      finalOutput = t
      break
    }
  }

  // finishReason：**最后一条** assistant 的 stop_reason（end_turn / tool_use / max_tokens / ...）
  const finishReason = assistants.length ? assistants[assistants.length - 1]?.message?.stop_reason ?? "" : ""

  // fileChanges：扫所有 assistant 的 tool_use
  /** @type {import("../core/types.js").FileChange[]} */
  const fileChanges = []
  for (const e of assistants) {
    const content = e.message?.content
    if (!Array.isArray(content)) continue
    for (const b of content) {
      if (b?.type !== "tool_use") continue
      const name = b.name ?? ""
      const input = b.input ?? {}
      if (FILE_MOD_TOOLS.has(name)) {
        const res = resultMap.get(b.id)
        fileChanges.push({
          tool: name,
          path: input.file_path ?? input.notebook_path ?? input.path,
          detail: clip(res?.text ?? "", MAX_TOOL_DETAIL),
        })
      } else if (name === "Bash") {
        const cmd = input.command ?? ""
        if (SHELL_WRITE_RE.test(cmd)) fileChanges.push({ tool: "Bash", detail: clip(cmd, MAX_TOOL_DETAIL) })
      }
    }
  }

  // errorInfo：最后一个 is_error=true 的 tool_result（终点附近的异常信号）
  let errorInfo = ""
  for (const e of entries) {
    if (!isUser(e)) continue
    const content = e.message.content
    if (!Array.isArray(content)) continue
    for (const b of content) {
      if (b?.type === "tool_result" && b.is_error === true) errorInfo = clip(toolResultText(b), 800)
    }
  }

  // conversationTail：最近 TAIL_MESSAGES 条 assistant 的文本 + 工具调用摘要
  const out = []
  for (const e of assistants.slice(-TAIL_MESSAGES)) {
    const lines = [`---- assistant msg ${e.uuid?.slice(0, 8) ?? ""} (stop=${e.message?.stop_reason ?? "?"}) ----`]
    const content = e.message?.content
    if (Array.isArray(content)) {
      for (const b of content) {
        if (b?.type === "text" && b.text?.trim()) {
          lines.push(`[text] ${clip(b.text.trim(), 600)}`)
        } else if (b?.type === "tool_use") {
          const argSummary = clip(JSON.stringify(b.input ?? {}), 200)
          const res = resultMap.get(b.id)
          const status = res ? (res.isError ? "error" : "ok") : "?"
          lines.push(`[tool ${b.name} status=${status}] args=${argSummary}`)
        }
      }
    }
    out.push(lines.join("\n"))
  }
  const conversationTail = clip(out.join("\n"), MAX_TAIL_TEXT)

  return { request, finalOutput, finishReason, errorInfo, fileChanges, conversationTail }
}
