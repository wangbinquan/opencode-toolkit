/**
 * 跨 hook 调用的续跑计数器（agent_id 维度）。
 *
 * 为什么需要落盘：opencode 的续跑循环在**单次** `tool.execute.after` 里同步跑完，
 * 计数是局部变量。Claude Code 的模型是**事件驱动**——每次 `decision:block` 让
 * subagent 续跑后它会再次停止、再次触发 SubagentStop，循环被摊到多次无状态的
 * hook 进程里。要精确限制 MAX_RETRIES 次，必须把计数持久化、用 agent_id 当 key。
 *
 * 目录选择与 opencode adapter 同思路：项目内 `.claude/.toolkit-tmp/` 优先
 * （避免散落系统 tmp），带候选链 + 可写探测兜底受限环境。
 *
 * @module
 */

import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const STALE_AGE_MS = 60 * 60 * 1000 // 1 小时

let cachedDir = null

/** 选一个真能写的计数目录（候选链 + probe + 缓存）。 */
function counterDir(cwd) {
  if (cachedDir) return cachedDir
  const projectInternal = path.join(cwd, ".claude", ".toolkit-tmp")
  const candidates = []
  if (process.env.CC_TOOLKIT_TMP_DIR) candidates.push(process.env.CC_TOOLKIT_TMP_DIR)
  candidates.push(projectInternal)
  candidates.push(path.join(os.tmpdir(), "cc-toolkit"))
  candidates.push(path.join(os.homedir(), ".cc-toolkit-tmp"))

  for (const dir of candidates) {
    try {
      fs.mkdirSync(dir, { recursive: true })
      const probe = path.join(dir, `.probe-${process.pid}`)
      fs.writeFileSync(probe, "")
      fs.unlinkSync(probe)
      cachedDir = dir
      if (dir === projectInternal) {
        const gi = path.join(dir, ".gitignore")
        if (!fs.existsSync(gi)) {
          try {
            fs.writeFileSync(gi, "*\n!.gitignore\n")
          } catch {}
        }
      }
      return dir
    } catch {
      continue
    }
  }
  cachedDir = candidates[candidates.length - 1]
  return cachedDir
}

/** agent_id → 计数文件路径（key 做文件名安全化）。 */
function fileFor(cwd, agentId) {
  const safe = String(agentId).replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80)
  return path.join(counterDir(cwd), `resume-${safe}.json`)
}

/** 读当前已续跑次数（无文件 = 0）。 */
export function getAttempts(cwd, agentId) {
  try {
    const data = JSON.parse(fs.readFileSync(fileFor(cwd, agentId), "utf8"))
    return typeof data.attempts === "number" ? data.attempts : 0
  } catch {
    return 0
  }
}

/** 写续跑次数。 */
export function setAttempts(cwd, agentId, n) {
  try {
    fs.writeFileSync(fileFor(cwd, agentId), JSON.stringify({ attempts: n, ts: Date.now(), agentId }))
  } catch {}
}

/** 清掉某 agent 的计数文件（complete 或到顶时调用）。 */
export function clearAttempts(cwd, agentId) {
  try {
    fs.unlinkSync(fileFor(cwd, agentId))
  } catch {}
}

/** 清理陈年残留计数文件（subagent 异常消失时计数文件可能不会被清）。 */
export function sweepStale(cwd) {
  const dir = counterDir(cwd)
  let entries
  try {
    entries = fs.readdirSync(dir)
  } catch {
    return
  }
  const now = Date.now()
  for (const name of entries) {
    if (!name.startsWith("resume-") || !name.endsWith(".json")) continue
    const fp = path.join(dir, name)
    try {
      if (now - fs.statSync(fp).mtimeMs > STALE_AGE_MS) fs.unlinkSync(fp)
    } catch {}
  }
}
