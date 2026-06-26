#!/usr/bin/env node
/**
 * Claude Code `SubagentStop` hook —— subagent 完成度审查 + 自动续跑。
 *
 * 这是 harness-toolkit 的 Claude Code adapter 入口。由 `.claude/settings.json`
 * 的 command hook 直接以 `node <abs>/src/claude/hook.mjs` exec，**不经过包的
 * exports/barrel**，所以保持纯 .mjs、零 opencode 符号。
 *
 * 与 opencode adapter（tool.execute.after + session.prompt 同步循环）等价的
 * 事件驱动实现：
 *
 *   stdin 读 hook JSON {session_id, agent_id, agent_type, transcript_path, cwd, stop_hook_active, ...}
 *     → 递归哨兵 / agent_type 过滤 / 计数上限 早退
 *     → 解析子 agent transcript（transcript.mjs）
 *     → buildReviewerPrompt → consultReviewer（spawn claude -p）
 *     → complete  ⇒ 清计数、exit 0（放行停止）
 *     → incomplete⇒ 计数+1、stdout 输出 {"decision":"block","reason": 续跑指令}、exit 0
 *                   （Claude 把 reason 喂回**同一** subagent，在原上下文续跑；它再停
 *                    时又触发本 hook，构成跨调用的续跑循环，由计数文件精确限次）
 *
 * 放行 = exit 0 且不输出 decision。拦截 = exit 0 且 stdout 输出 decision:block。
 *
 * 可调环境变量：
 *   CC_TOOLKIT_MAX_RETRIES     续跑次数上限（默认 3）
 *   CC_TOOLKIT_REVIEW_AGENTS   只审这些 agent_type（逗号分隔；空 = 全审）
 *   CC_TOOLKIT_REVIEWER_MODEL  审查员模型（默认 claude 默认；建议便宜模型）
 *   CC_TOOLKIT_CLAUDE_BIN      claude 可执行路径（默认 "claude"）
 *   CC_TOOLKIT_TIMEOUT_MS      单次审查超时（默认 180000）
 *   CC_TOOLKIT_TAIL_MESSAGES   传给审查员的尾部消息条数（默认 6）
 *   CC_TOOLKIT_TMP_DIR         计数文件目录覆盖
 */

import { buildContinuation } from "../core/continuation.mjs"
import { buildReviewerPrompt } from "../core/reviewer-prompt.mjs"
import { clearAttempts, getAttempts, setAttempts, sweepStale } from "./counter.mjs"
import { consultReviewer } from "./reviewer.mjs"
import { parseTranscript } from "./transcript.mjs"

const MAX_RETRIES = Number(process.env.CC_TOOLKIT_MAX_RETRIES ?? 3)
const RECURSION_GUARD = "CC_TOOLKIT_REVIEWING"
const REVIEW_AGENTS = (process.env.CC_TOOLKIT_REVIEW_AGENTS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)

/** 读全部 stdin。 */
function readStdin() {
  return new Promise((resolve) => {
    let data = ""
    process.stdin.setEncoding("utf8")
    process.stdin.on("data", (d) => (data += d))
    process.stdin.on("end", () => resolve(data))
    process.stdin.on("error", () => resolve(data))
  })
}

/** 放行 subagent 停止：exit 0，不输出 decision。 */
function allowStop() {
  process.exit(0)
}

/** 拦截并把续跑指令喂回同一 subagent。 */
function blockWith(reason) {
  process.stdout.write(JSON.stringify({ decision: "block", reason }))
  process.exit(0)
}

async function main() {
  // 递归哨兵：我们 spawn 的 reviewer claude 若触发 hook，直接放行（防无限派生）
  if (process.env[RECURSION_GUARD]) return allowStop()

  const raw = await readStdin()
  let input
  try {
    input = JSON.parse(raw)
  } catch {
    return allowStop()
  }

  // 只处理 SubagentStop（settings 里也只会注册它；防御性判断）
  if (input.hook_event_name && input.hook_event_name !== "SubagentStop") return allowStop()

  const cwd = input.cwd || process.cwd()
  const agentId = input.agent_id || input.session_id || "unknown"
  const agentType = input.agent_type || ""
  const transcriptPath = input.transcript_path

  // agent_type 过滤
  if (REVIEW_AGENTS.length && !REVIEW_AGENTS.includes(agentType)) return allowStop()
  if (!transcriptPath) return allowStop()

  try {
    sweepStale(cwd)
  } catch {}

  // 计数上限：到顶就放行（防跨调用死循环；平台的 stop_hook_active 是更外层的兜底）
  const attempts = getAttempts(cwd, agentId)
  if (attempts >= MAX_RETRIES) {
    clearAttempts(cwd, agentId)
    return allowStop()
  }

  let parsed
  try {
    parsed = parseTranscript(transcriptPath)
  } catch (err) {
    process.stderr.write(`[cc-toolkit] parseTranscript failed: ${err}\n`)
    return allowStop()
  }

  const reviewerPrompt = buildReviewerPrompt({
    description: "",
    subagentType: agentType,
    request: parsed.request,
    finalOutput: parsed.finalOutput,
    finishReason: parsed.finishReason,
    errorInfo: parsed.errorInfo,
    fileChanges: parsed.fileChanges,
    conversationTail: parsed.conversationTail,
  })

  let verdict
  try {
    verdict = await consultReviewer(reviewerPrompt, cwd)
  } catch (err) {
    process.stderr.write(`[cc-toolkit] consultReviewer threw: ${err}\n`)
    verdict = null
  }

  // 审不了（超时/解析失败）就别拦——宁可放过也不要卡死 subagent
  if (!verdict) return allowStop()

  if (verdict.verdict === "complete") {
    clearAttempts(cwd, agentId)
    return allowStop()
  }

  // incomplete → 拦截续跑
  setAttempts(cwd, agentId, attempts + 1)
  process.stderr.write(
    `[cc-toolkit] agent=${agentId} attempt=${attempts + 1}/${MAX_RETRIES} reasons: ${verdict.reasons.join(" | ")}\n`,
  )
  return blockWith(buildContinuation(verdict))
}

main().catch((err) => {
  process.stderr.write(`[cc-toolkit] hook fatal: ${err}\n`)
  process.exit(0) // 出任何意外都放行，绝不卡住用户的 subagent
})
