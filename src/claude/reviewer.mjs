/**
 * 跑审查员：spawn 一个 headless `claude -p` 子进程，喂 reviewer prompt，解析
 * `<task_completion_review>` XML 判决。对应 opencode adapter 的 consultReviewer
 * （那边 spawn `opencode run --agent`）。
 *
 * 审查员的"人设/清单/判决格式"直接复用包内 `agents/task-completion-checker.md`
 * 的正文（剥掉 opencode frontmatter）——单一真相源，不在 claude 侧另写一份 rubric。
 * 该正文支持 inline 输入：user message 以 `## ORIGINAL_REQUEST` 开头就直接处理。
 *
 * 传输方式：把 [rubric 正文] + [reviewer prompt] 合并经 **stdin** 喂给 claude，
 * argv 只放短 flag——避免大文本进 argv 撞 Windows 8191 字符上限（与 opencode
 * adapter 用临时文件同样的动机，这里用 stdin 更省事）。
 *
 * @module
 */

import crossSpawn from "cross-spawn"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { extractVerdict } from "../core/verdict.mjs"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
/** 包根（src/claude 上两级）。 */
const PKG_ROOT = path.resolve(__dirname, "..", "..")
const AGENT_FILE = path.join(PKG_ROOT, "agents", "task-completion-checker.md")

/** 递归哨兵——spawn 出去的 reviewer claude 自身触发的 hook 见到它即 no-op。 */
const RECURSION_GUARD = "CC_TOOLKIT_REVIEWING"

/** claude 可执行文件（Windows 上可能是 claude.cmd，cross-spawn 负责处理）。 */
const CLAUDE_BIN = process.env.CC_TOOLKIT_CLAUDE_BIN ?? "claude"

/** 审查员模型覆盖（不传 = claude 默认）。建议指便宜模型，如 claude-haiku-4-5-20251001。 */
const REVIEWER_MODEL = process.env.CC_TOOLKIT_REVIEWER_MODEL ?? ""

/** 一次审查最长等待（毫秒）。 */
const TIMEOUT_MS = Number(process.env.CC_TOOLKIT_TIMEOUT_MS ?? 180_000)

/** 读 agent 文件，剥掉 `---...---` frontmatter，返回正文（rubric）。 */
function rubricBody() {
  try {
    const raw = fs.readFileSync(AGENT_FILE, "utf8")
    const m = raw.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n([\s\S]*)$/)
    return (m ? m[1] : raw).trim()
  } catch {
    return ""
  }
}

/**
 * 咨询审查员，返回判决（解析失败 / 超时 / spawn 出错 → null，调用方据此**不**拦截）。
 *
 * @param {string} reviewerPrompt  buildReviewerPrompt 产出的 markdown（以 ## ORIGINAL_REQUEST 开头）
 * @param {string} cwd             宿主项目目录（claude 子进程的 cwd，便于 reviewer 用 read/grep 核对真实文件）
 * @returns {Promise<import("../core/types.js").Verdict | null>}
 */
export async function consultReviewer(reviewerPrompt, cwd) {
  const body = rubricBody()
  // rubric 正文（系统指令）+ 分隔 + reviewer 输入，合并成单个 user turn 经 stdin 传入。
  const stdinPayload = `${body}\n\n========================================\n\n${reviewerPrompt}`

  const argv = ["-p", "--output-format", "text"]
  if (REVIEWER_MODEL) argv.push("--model", REVIEWER_MODEL)

  return await new Promise((resolve) => {
    const env = { ...process.env, [RECURSION_GUARD]: "1" }
    let child
    try {
      child = crossSpawn(CLAUDE_BIN, argv, { cwd, env, stdio: ["pipe", "pipe", "pipe"] })
    } catch (err) {
      process.stderr.write(`[cc-toolkit] reviewer spawn threw: ${err}\n`)
      return resolve(null)
    }

    let stdout = ""
    let stderr = ""
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL")
      } catch {}
    }, TIMEOUT_MS)

    child.stdout?.on("data", (d) => (stdout += d.toString()))
    child.stderr?.on("data", (d) => (stderr += d.toString()))
    child.on("error", (err) => {
      clearTimeout(timer)
      process.stderr.write(`[cc-toolkit] reviewer spawn error: ${err}\n`)
      resolve(null)
    })
    child.on("close", (code) => {
      clearTimeout(timer)
      const verdict = extractVerdict(stdout)
      if (!verdict) {
        process.stderr.write(
          `[cc-toolkit] reviewer exit=${code}, no parseable verdict\n  stdout tail: ${stdout.slice(-400)}\n  stderr tail: ${stderr.slice(-400)}\n`,
        )
      }
      resolve(verdict)
    })

    try {
      child.stdin.write(stdinPayload)
      child.stdin.end()
    } catch (err) {
      clearTimeout(timer)
      process.stderr.write(`[cc-toolkit] reviewer stdin write failed: ${err}\n`)
      resolve(null)
    }
  })
}
