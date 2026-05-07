/**
 * opencode-toolkit —— 团队共享 opencode 工具包
 *
 * 这个包同时承载三类资产并保证它们能被 opencode 自动加载：
 *
 *   1. Plugin 本体：
 *      团队成员在工程 opencode.json 里声明 `"plugin": ["opencode-toolkit"]`，
 *      opencode 通过 npm 解析装载此包，然后调用本文件导出的 default Plugin
 *      工厂函数。
 *
 *   2. Agents（agents/*.md）：
 *      opencode 不会扫描 npm 包路径，所以本插件在 factory 入口处把包内 agent
 *      文件 symlink/copy 到工程 .opencode/agent/。effect 在**下一次** opencode
 *      启动时生效（agent 在 plugin load 之前就被扫描了，无法做到一次启动即用）。
 *      想消除这一启动延迟可手动跑 `npx opencode-toolkit-install`。
 *
 *   3. Skills（skills/*** /SKILL.md）：
 *      opencode 支持 `config.skills.paths` 让用户指任意目录里的 skill。本插件
 *      的 `config` 钩子把包内 `skills/` 路径推进去。skill 服务是惰性的
 *      （packages/opencode/src/skill/index.ts:177 才读 paths），单次启动就生效。
 *
 * 当前业务能力（来自原 demo/subagent-resumer）：
 *   - 监听 `tool.execute.after` 钩子，捕获 task 工具（subagent）调用结束。
 *   - 收集子 session 的全部消息、文件改动、最终输出、finish/error。
 *   - spawn 一个独立 opencode 进程跑 task-completion-checker agent 给出 JSON 判决。
 *   - 若 incomplete，向同一子 session 注入"续跑"prompt，最多 MAX_RETRIES 次。
 *   - 把最终结果改写回 task 工具 output，对父 agent 透明。
 */

import type { Plugin } from "@opencode-ai/plugin"
// cross-spawn：跨平台安全 spawn。Windows 上 `opencode` 是 `.cmd` 包装脚本，
// Node 18.20+/20.12+ 起 `child_process.spawn` 直接执行 .cmd 会拒绝（CVE 修复），
// 而 `shell: true` 兜底又有参数转义陷阱。cross-spawn 内部正确处理两种情况。
import crossSpawn from "cross-spawn"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { installAgents } from "./installer.js"

/** 跨平台 spawn —— 与 child_process.spawn 同签名，但 Windows 上能正确处理 .cmd/.bat。 */
const spawn = crossSpawn

// ─────────────────────────────────────────────────────────────────────────
// 包内资源路径（在运行时根据 import.meta.url 解析自身位置）
// ─────────────────────────────────────────────────────────────────────────

/** 当前文件 src/index.ts 的目录 */
const __dirname = path.dirname(fileURLToPath(import.meta.url))

/** toolkit 包根目录（src 上一级） */
const PKG_ROOT = path.resolve(__dirname, "..")

/** 包内 agent 源目录 */
const AGENTS_DIR = path.join(PKG_ROOT, "agents")

/** 包内 skill 源目录 */
const SKILLS_DIR = path.join(PKG_ROOT, "skills")

/** 当前 toolkit 版本（来自包根的 package.json，写入 marker 文件供查阅） */
const PKG_VERSION: string = (() => {
  try {
    return (JSON.parse(fs.readFileSync(path.join(PKG_ROOT, "package.json"), "utf8")) as { version: string }).version
  } catch {
    return "unknown"
  }
})()

// ─────────────────────────────────────────────────────────────────────────
// 业务可调常量（环境变量覆盖）
// ─────────────────────────────────────────────────────────────────────────

/** 续跑循环最大次数 */
const MAX_RETRIES = Number(process.env.OPENCODE_TOOLKIT_MAX_RETRIES ?? process.env.SUBAGENT_RESUMER_MAX_RETRIES ?? 3)

/** 审查员 agent 名（必须能被 `opencode run --agent <name>` 找到） */
const REVIEWER_AGENT =
  process.env.OPENCODE_TOOLKIT_REVIEWER_AGENT ??
  process.env.SUBAGENT_RESUMER_REVIEWER_AGENT ??
  "task-completion-checker"

/** opencode 可执行文件路径 */
const OPENCODE_BIN = process.env.OPENCODE_TOOLKIT_OPENCODE_BIN ?? process.env.SUBAGENT_RESUMER_OPENCODE_BIN ?? "opencode"

/** 一次审查最长等待时间（毫秒） */
const REVIEWER_TIMEOUT_MS = Number(
  process.env.OPENCODE_TOOLKIT_TIMEOUT_MS ?? process.env.SUBAGENT_RESUMER_TIMEOUT_MS ?? 180_000,
)

/** 传给审查员的会话尾部消息条数 */
const TAIL_MESSAGES = Number(
  process.env.OPENCODE_TOOLKIT_TAIL_MESSAGES ?? process.env.SUBAGENT_RESUMER_TAIL_MESSAGES ?? 6,
)

/** CONVERSATION_TAIL 整体字符上限 */
const MAX_TAIL_TEXT = 4_000

/** 单条 tool detail 字符上限 */
const MAX_TOOL_DETAIL = 400

/**
 * 显式覆盖审查员 prompt 文件的临时目录。当默认候选都不可写时（受限的企业
 * Windows、只读容器 /tmp、用户 perm 错乱），团队成员可以指一个保证可写的
 * 目录绕开。
 */
const TMP_DIR_OVERRIDE = process.env.OPENCODE_TOOLKIT_TMP_DIR

/** 选中的临时目录缓存——一次会话内只 probe 一次。 */
let cachedTmpDir: string | null = null

/**
 * 选一个真的能写的临时目录。
 *
 * **关键点**：项目内目录优先于 os.tmpdir()。
 * 审查员子进程的 `read` 工具受 opencode 的 `external_directory` 权限规则约束
 * （默认 `ask`）；写到 `os.tmpdir()` 下的文件会被判为外部目录，触发权限询问，
 * 在 `opencode run` 非交互模式下会自动 deny / 挂起，导致审查员读不到 prompt
 * 文件、整个 review 链路失败。把 prompt 放到工程的 `.opencode/.toolkit-tmp/`
 * 下，read 走 within-project 路径，匹配 `read: *: allow` 直接通过。
 *
 * 候选顺序（短路返回第一个可写的）：
 *   1. 环境变量 OPENCODE_TOOLKIT_TMP_DIR（显式覆盖）
 *   2. <工程>/.opencode/.toolkit-tmp/（项目内 → 不触发 external_directory）
 *   3. os.tmpdir()（系统默认；触发权限提示，但有些场景仍要用）
 *   4. ~/.opencode-toolkit-tmp/（家目录兜底）
 *
 * Probe 方式：mkdirSync({recursive:true}) → 写一个 0 字节探针 → 立即 unlink。
 * 任一步抛错就跳到下一个候选。全部失败时返回最后一个候选并 warn——后续真实
 * 写入会以更明确的错误信息失败。
 */
function chooseTmpDir(projectDir: string): string {
  if (cachedTmpDir) return cachedTmpDir

  const projectInternal = path.join(projectDir, ".opencode", ".toolkit-tmp")
  const candidates: string[] = []
  if (TMP_DIR_OVERRIDE) candidates.push(TMP_DIR_OVERRIDE)
  candidates.push(projectInternal)
  candidates.push(os.tmpdir())
  candidates.push(path.join(os.homedir(), ".opencode-toolkit-tmp"))

  for (const dir of candidates) {
    try {
      fs.mkdirSync(dir, { recursive: true })
      const probe = path.join(dir, `.write-probe-${process.pid}-${Date.now()}`)
      fs.writeFileSync(probe, "")
      fs.unlinkSync(probe)
      cachedTmpDir = dir
      // 项目内候选被选中时写一个 .gitignore，避免 prompt 临时文件被意外 commit
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

  console.error(
    `[opencode-toolkit] WARNING: no writable tmp dir found. Tried in order: ${candidates.join(
      " | ",
    )}. Set OPENCODE_TOOLKIT_TMP_DIR to a known-writable absolute path to fix.`,
  )
  cachedTmpDir = candidates[candidates.length - 1]
  return cachedTmpDir
}

/**
 * 清理可能遗留的陈年 prompt 文件——spawn 中途被 SIGKILL / 进程崩溃时 finally
 * 没机会跑，文件会留下来。每次 plugin load 时扫一下，删超过 STALE_AGE_MS 的。
 */
const STALE_AGE_MS = 60 * 60 * 1000 // 1 小时
function sweepStaleTmpFiles(projectDir: string): void {
  const dir = chooseTmpDir(projectDir)
  let entries: string[]
  try {
    entries = fs.readdirSync(dir)
  } catch {
    return
  }
  const now = Date.now()
  for (const name of entries) {
    if (!name.startsWith("opencode-toolkit-reviewer-")) continue
    const filepath = path.join(dir, name)
    try {
      const stat = fs.statSync(filepath)
      if (now - stat.mtimeMs > STALE_AGE_MS) {
        fs.unlinkSync(filepath)
      }
    } catch {
      // ignore
    }
  }
}

/**
 * 防递归哨兵环境变量。
 *
 * spawn 出去的审查员子进程会再次加载本插件——若不阻断，审查员一旦触发任何
 * task 调用就会再 spawn 一个审查员，无限派生。
 *
 * 解决：spawn 时注入此环境变量；插件入口检测到就直接 no-op。
 */
const RECURSION_GUARD = "OPENCODE_TOOLKIT_REVIEWING"

// 兼容旧环境变量名（demo 阶段用过 SUBAGENT_RESUMER_*）
const LEGACY_RECURSION_GUARD = "SUBAGENT_RESUMER_REVIEWING"

// ─────────────────────────────────────────────────────────────────────────
// 类型 + 工具方法
// ─────────────────────────────────────────────────────────────────────────

type LooseRecord = Record<string, any>

type FileChange = { tool: string; path?: string; detail?: string }

type Verdict = {
  verdict: "complete" | "incomplete"
  confidence: "high" | "medium" | "low"
  reasons: string[]
  missing: string[]
  evidence: string[]
  next_steps: string
}

const FILE_MOD_TOOLS = new Set(["write", "edit", "multiedit", "patch"])
const SHELL_WRITE_RE =
  /\b(rm|mv|cp|touch|mkdir|chmod|chown|ln|tee|sed\s+-i|>>?|git\s+(add|rm|mv|reset|checkout|commit|push|stash|apply))\b/

function lastAssistant(messages: LooseRecord[]): LooseRecord | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.info?.role === "assistant") return messages[i]
  }
  return undefined
}

function lastTextOf(message: LooseRecord | undefined): string {
  if (!message) return ""
  const parts: LooseRecord[] = message.parts ?? []
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i]
    if (p?.type === "text" && typeof p.text === "string" && p.text.trim().length > 0) return p.text
  }
  return ""
}

function clip(text: string, max: number): string {
  if (text.length <= max) return text
  return text.slice(0, max) + `\n…(${text.length - max} chars truncated)`
}

function pickToolArgs(state: LooseRecord): LooseRecord {
  return state.input ?? state.args ?? state.parameters ?? {}
}

function pickToolOutput(state: LooseRecord): string {
  const out = state.output ?? state.result
  if (typeof out === "string") return out
  if (out == null) return ""
  try {
    return JSON.stringify(out)
  } catch {
    return String(out)
  }
}

/**
 * 从子 session 全部 assistant 消息里提取"产生过文件改动"的工具调用，归一化为
 * FileChange 列表。会被审查员用来核对"声称改了什么 vs 实际改了什么"。
 */
function extractFileChanges(messages: LooseRecord[]): FileChange[] {
  const changes: FileChange[] = []
  for (const m of messages) {
    if (m?.info?.role !== "assistant") continue
    for (const p of (m.parts ?? []) as LooseRecord[]) {
      if (p?.type !== "tool") continue
      const tool: string = p.tool ?? ""
      const state: LooseRecord = p.state ?? {}
      const args = pickToolArgs(state)

      if (FILE_MOD_TOOLS.has(tool)) {
        changes.push({
          tool,
          path: args.filePath ?? args.file_path ?? args.path,
          detail: clip(pickToolOutput(state), MAX_TOOL_DETAIL),
        })
      } else if (tool === "bash") {
        const cmd: string = args.command ?? ""
        if (SHELL_WRITE_RE.test(cmd)) {
          changes.push({ tool: "bash", detail: clip(cmd, MAX_TOOL_DETAIL) })
        }
      }
    }
  }
  return changes
}

/**
 * 把最近 TAIL_MESSAGES 条 assistant 消息压缩成可读文本，给审查员看 subagent
 * 临结束前几轮的行为（工具反复失败？某步骤截断？）。
 */
function extractConversationTail(messages: LooseRecord[]): string {
  const assistantMsgs = messages.filter((m) => m?.info?.role === "assistant").slice(-TAIL_MESSAGES)
  const out: string[] = []
  for (const m of assistantMsgs) {
    const parts: LooseRecord[] = m.parts ?? []
    const lines: string[] = [`---- assistant msg ${m.info?.id ?? ""} (finish=${m.info?.finish ?? "?"}) ----`]
    for (const p of parts) {
      if (p?.type === "text" && typeof p.text === "string") {
        const t = p.text.trim()
        if (t) lines.push(`[text] ${clip(t, 600)}`)
      } else if (p?.type === "tool") {
        const state: LooseRecord = p.state ?? {}
        const args = pickToolArgs(state)
        const argSummary = clip(JSON.stringify(args), 200)
        const status = state.status ?? state.state ?? "?"
        lines.push(`[tool ${p.tool} status=${status}] args=${argSummary}`)
      }
    }
    out.push(lines.join("\n"))
  }
  return clip(out.join("\n"), MAX_TAIL_TEXT)
}

/**
 * 组装审查员 prompt。章节标题与 task-completion-checker.md 的 system prompt
 * 严格对齐——审查员是按这些标题定位字段的。
 */
function buildReviewerPrompt(input: {
  description: string
  subagentType: string
  request: string
  finalOutput: string
  finishReason: string
  errorInfo: string
  fileChanges: FileChange[]
  conversationTail: string
}): string {
  const fc =
    input.fileChanges.length === 0
      ? "（无文件改动记录）"
      : input.fileChanges
          .map((c, i) => {
            const head = `${i + 1}. tool=${c.tool}` + (c.path ? ` path=${c.path}` : "")
            return c.detail ? `${head}\n   detail: ${c.detail}` : head
          })
          .join("\n")

  // 文件以 `## ORIGINAL_REQUEST` 开头是有意为之：审查员 agent 同时支持
  // "INPUT_FILE <path>"（推荐）和"直接 inline 这段 markdown"两种输入形式，
  // 后者用首行 `## ORIGINAL_REQUEST` 作为识别标志。
  return [
    "## ORIGINAL_REQUEST",
    input.request || "(empty)",
    "",
    "## SUBAGENT_DESCRIPTION",
    input.description || "(empty)",
    "",
    "## SUBAGENT_TYPE",
    input.subagentType || "(empty)",
    "",
    "## FINISH_REASON",
    input.finishReason || "(unknown)",
    "",
    "## ERROR_INFO",
    input.errorInfo || "(none)",
    "",
    "## FINAL_OUTPUT",
    input.finalOutput || "(empty)",
    "",
    "## FILE_CHANGES",
    fc,
    "",
    "## CONVERSATION_TAIL",
    input.conversationTail || "(empty)",
  ].join("\n")
}

/**
 * 从审查员 stdout 文本里抽判决。
 *
 * 主路径：XML 标签格式（v0.2.5 起的协议）。
 * 兜底：旧的 JSON 格式（pre-v0.2.5 agent 的输出，或模型 hallucinate 回退到 JSON）。
 *
 * 为什么主路径换成 XML？
 *   LLM 生成 JSON 字符串值时频繁忘记转义内嵌引号——尤其中文模型在 reasons
 *   这种长描述里写 `"做完了"` 之类的强调引号，整段 JSON 就崩，JSON.parse
 *   失败、verdict=null、整个 review 链路废掉。XML 标签内的文本是字面量，
 *   引号 / 换行 / 单引号 / 中文标点全部宽容、零转义负担。
 */
function extractVerdict(text: string): Verdict | null {
  return extractVerdictXML(text) ?? extractVerdictJsonLegacy(text)
}

/**
 * 解析 XML 标签格式的判决（主路径）。
 *
 * 期望文本里至少有一组：
 *   <task_completion_review>
 *     <verdict>complete|incomplete</verdict>
 *     <confidence>high|medium|low</confidence>
 *     <reasons>- ...\n- ...</reasons>
 *     <missing>- ...</missing>
 *     <evidence>- ...</evidence>
 *     <next_steps>...</next_steps>
 *   </task_completion_review>
 *
 * 找不到块或 verdict 字段非法都返回 null（让调用方走 JSON 兜底）。
 */
function extractVerdictXML(text: string): Verdict | null {
  // 取最后一组 review 块（前面的分析文字可能也有"审查清单"等字眼但不会带这个标签）
  const blocks = [...text.matchAll(/<task_completion_review>([\s\S]*?)<\/task_completion_review>/g)]
  if (blocks.length === 0) return null
  const block = blocks[blocks.length - 1][1]

  const tagText = (tag: string): string => {
    const m = block.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`))
    return m ? m[1].trim() : ""
  }

  const tagList = (tag: string): string[] => {
    const raw = tagText(tag)
    if (!raw) return []
    return raw
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
      .map((l) => l.replace(/^[-*•]\s*/, ""))
      .filter((l) => l.length > 0)
  }

  const verdict = tagText("verdict").toLowerCase()
  if (verdict !== "complete" && verdict !== "incomplete") return null

  const confidenceRaw = tagText("confidence").toLowerCase()
  const confidence: Verdict["confidence"] =
    confidenceRaw === "high" || confidenceRaw === "medium" || confidenceRaw === "low" ? confidenceRaw : "medium"

  return {
    verdict: verdict as "complete" | "incomplete",
    confidence,
    reasons: tagList("reasons"),
    missing: tagList("missing"),
    evidence: tagList("evidence"),
    next_steps: tagText("next_steps"),
  }
}

/**
 * 老 JSON 格式判决兜底（pre-v0.2.5 行为）。
 *
 * 顺序：fenced code block ```json ... ``` → 任意 balanced {...}。
 * 都从最后一个开始尝试解析。任何 JSON.parse 错误（包括内嵌引号未转义这类经典
 * LLM 错误）就放弃这条候选；都失败返回 null。
 */
function extractVerdictJsonLegacy(text: string): Verdict | null {
  const fences = [...text.matchAll(/```json\s*([\s\S]*?)```/g)]
  for (let i = fences.length - 1; i >= 0; i--) {
    try {
      const v = JSON.parse(fences[i][1])
      if (v && (v.verdict === "complete" || v.verdict === "incomplete")) return v as Verdict
    } catch {}
  }
  const candidates = [...text.matchAll(/\{[\s\S]*?\}/g)]
  for (let i = candidates.length - 1; i >= 0; i--) {
    try {
      const v = JSON.parse(candidates[i][0])
      if (v && (v.verdict === "complete" || v.verdict === "incomplete")) return v as Verdict
    } catch {}
  }
  return null
}

/**
 * 启动独立 opencode 进程跑审查员，等待结束并解析 JSON 判决。
 *
 * 关键：promptText **不**作为 argv 直接传——Windows 上 `cmd.exe` 包装 `.cmd`
 * 时会把含 `\n` 的 argv 在第一行截断、命令行长度上限 8191 字符也容易爆掉，
 * 导致审查员看不到任何输入。改成把 promptText 写到 OS 临时目录，argv 只传
 * 两个 ASCII token：`INPUT_FILE` + `<绝对路径>`。审查员 system prompt 见到
 * 后会用 `read` 工具读文件——三平台一致行为。
 *
 * - cwd 必须是宿主项目目录，子进程才能在 .opencode/agent/ 找到审查员。
 * - 注入 RECURSION_GUARD 防自循环。
 * - REVIEWER_TIMEOUT_MS 后强杀子进程，verdict 视为 null（调用方应停止重试）。
 * - 临时文件由 finally 兜底删除（即便子进程异常退出也不留垃圾）。
 */
/**
 * 审查员模型覆盖配置（运行时计算）。
 *
 * 优先级：env > opencode.json plugin options > undefined（让 opencode 走默认）。
 * 调用方传入 options（可来自插件第二个参数），env 总是最高优先级。
 */
type ReviewerOverride = {
  model?: string
  variant?: string
}

async function consultReviewer(
  promptText: string,
  cwd: string,
  override: ReviewerOverride,
): Promise<Verdict | null> {
  // 选一个真能写的临时目录（带候选链 + probe + 缓存），适配受限环境。
  const tmpDir = chooseTmpDir(cwd)
  const tmpFile = path.join(
    tmpDir,
    `opencode-toolkit-reviewer-${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 10)}.md`,
  )

  try {
    fs.writeFileSync(tmpFile, promptText, "utf8")
  } catch (err) {
    console.error(
      `[opencode-toolkit] failed to write reviewer prompt to ${tmpFile}: ${err instanceof Error ? err.message : err}\n` +
        `  Set OPENCODE_TOOLKIT_TMP_DIR to a writable absolute path to override the tmp dir candidate chain.`,
    )
    return null
  }

  // 组装 spawn 参数。--model / --variant 仅在显式覆盖时附加，否则让 opencode 走自身默认
  // （agent frontmatter > config.model > opencode default）。
  const argv: string[] = ["run", "--agent", REVIEWER_AGENT]
  if (override.model) argv.push("--model", override.model)
  if (override.variant) argv.push("--variant", override.variant)
  // 两个 token "INPUT_FILE" + 临时文件路径——跨 cmd.exe / sh / cross-spawn 安全（短、纯 ASCII）
  argv.push("INPUT_FILE", tmpFile)

  try {
    return await new Promise<Verdict | null>((resolve) => {
      const env = { ...process.env, [RECURSION_GUARD]: "1", [LEGACY_RECURSION_GUARD]: "1" }
      const child = spawn(OPENCODE_BIN, argv, {
        cwd,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      })
      let stdout = ""
      let stderr = ""
      const timer = setTimeout(() => {
        try {
          child.kill("SIGKILL")
        } catch {}
      }, REVIEWER_TIMEOUT_MS)
      child.stdout?.on("data", (d) => (stdout += d.toString()))
      child.stderr?.on("data", (d) => (stderr += d.toString()))
      child.on("error", (err) => {
        clearTimeout(timer)
        console.error("[opencode-toolkit] reviewer spawn error:", err)
        resolve(null)
      })
      child.on("close", (code) => {
        clearTimeout(timer)
        const verdict = extractVerdict(stdout)
        if (!verdict) {
          console.error(
            `[opencode-toolkit] reviewer exit=${code}, no parseable JSON verdict\n  stdout tail: ${stdout.slice(-500)}\n  stderr tail: ${stderr.slice(-500)}`,
          )
        }
        resolve(verdict)
      })
    })
  } finally {
    // 子进程已退出（resolve 完成 await 才到这里），可以安全删
    try {
      fs.unlinkSync(tmpFile)
    } catch {}
  }
}

/**
 * 把审查员判决转成发回 subagent 的"续跑指令"。
 * 措辞硬性禁止三种偷懒模式：重复劳动 / 用总结代替执行 / 用提问拖延。
 */
function buildContinuation(verdict: Verdict): string {
  return [
    "[task-completion-checker] 审核员判定你尚未完成任务。请认真处理：",
    "",
    "## 判定理由",
    ...verdict.reasons.map((r) => `- ${r}`),
    "",
    "## 缺失/未完成项",
    ...(verdict.missing.length > 0 ? verdict.missing.map((m) => `- ${m}`) : ["- (审核员未明确列出，但判定未完成)"]),
    "",
    "## 续跑指令",
    verdict.next_steps?.trim() || "请从你停下的地方继续，把上面缺失项逐条做完，并在最终回复中明确指出每一项的完成情况。",
    "",
    "请直接继续执行，不要重新开始、不要总结之前的内容、不要再问问题。",
  ].join("\n")
}

/**
 * 把 task 工具原始 output.output 中的 <task_result> 块替换为续跑后的最终文本，
 * 并附 banner 描述插件做了什么。task_id 行保持不变。
 */
function rewriteTaskResult(original: string, finalText: string, attempts: number, lastVerdict: Verdict | null): string {
  const banner = [
    `[opencode-toolkit] resumed ${attempts} time(s) under reviewer "${REVIEWER_AGENT}"`,
    lastVerdict ? `[opencode-toolkit] final verdict: ${lastVerdict.verdict} (${lastVerdict.confidence})` : "",
  ]
    .filter(Boolean)
    .join("\n")
  const block = `<task_result>\n${finalText.trim()}\n</task_result>`
  if (original.includes("<task_result>") && original.includes("</task_result>")) {
    return original.replace(/<task_result>[\s\S]*?<\/task_result>/, block) + "\n" + banner
  }
  return original + "\n" + block + "\n" + banner
}

// ─────────────────────────────────────────────────────────────────────────
// Plugin 入口
// ─────────────────────────────────────────────────────────────────────────

/**
 * 工程 opencode.json 里能传给 toolkit 的可选项。元组形式声明插件即可：
 *
 *     "plugin": [["opencode-toolkit@github:...", {
 *        "reviewerModel": "anthropic/claude-haiku-4-5-20251001",
 *        "reviewerVariant": "minimal"
 *     }]]
 *
 * 字段：
 *   - reviewerModel:    审查员调用 `opencode run` 时附加 `--model <value>`，
 *                       格式 `provider/model`，例如 `anthropic/claude-haiku-4-5-20251001`。
 *                       不传时 opencode 走默认（agent frontmatter > config.model）。
 *   - reviewerVariant:  附加 `--variant <value>`（reasoning 努力度，provider 相关，
 *                       常见值 `high` / `medium` / `low` / `minimal`）。
 *
 * 同名环境变量优先级更高（per-shell 覆盖语义）：
 *   - OPENCODE_TOOLKIT_REVIEWER_MODEL
 *   - OPENCODE_TOOLKIT_REVIEWER_VARIANT
 */
type ToolkitOptions = {
  reviewerModel?: unknown
  reviewerVariant?: unknown
}

function resolveReviewerOverride(options: ToolkitOptions | undefined): ReviewerOverride {
  const fromOpts = (key: keyof ToolkitOptions): string | undefined => {
    const v = options?.[key]
    return typeof v === "string" && v.trim().length > 0 ? v.trim() : undefined
  }
  return {
    model: process.env.OPENCODE_TOOLKIT_REVIEWER_MODEL ?? fromOpts("reviewerModel"),
    variant: process.env.OPENCODE_TOOLKIT_REVIEWER_VARIANT ?? fromOpts("reviewerVariant"),
  }
}

/**
 * 插件主体。opencode 加载本包时调用一次，返回的对象就是 Hooks 配置。
 *
 * 入参：
 *   - input:   PluginInput（含 client / project / directory / worktree / serverUrl / $ ）
 *   - options: opencode.json 里 `["opencode-toolkit", { ... }]` 元组形式传入的对象，
 *              当前可选字段见 ToolkitOptions
 *
 * 启动期副作用（在返回 hooks 对象之前完成）：
 *   1. 把包内 agents/*.md 安装到 directory/.opencode/agent/。**对当次启动无效**，
 *      下次启动 opencode 才能扫到。手动加速：跑 `npx opencode-toolkit-install`。
 *
 * 注册的钩子：
 *   - config: 把包内 skills/ 路径推进 config.skills.paths（skill 服务惰性读取，
 *     单次启动即生效）。
 *   - tool.execute.after: 在每次 task 工具调用结束后做完成度审查 + 续跑。
 */
const ToolkitPlugin: Plugin = async ({ client, directory }, options) => {
  const reviewerOverride = resolveReviewerOverride(options as ToolkitOptions | undefined)
  if (reviewerOverride.model || reviewerOverride.variant) {
    console.log(
      `[opencode-toolkit] reviewer override: ${reviewerOverride.model ? `model=${reviewerOverride.model} ` : ""}${
        reviewerOverride.variant ? `variant=${reviewerOverride.variant}` : ""
      }`.trim(),
    )
  }
  // ── 启动期：安装/更新 agent 文件
  // 仅在非递归环境（即不是审查员子进程）里跑，避免在子进程里反复写 symlink。
  if (!process.env[RECURSION_GUARD] && !process.env[LEGACY_RECURSION_GUARD]) {
    try {
      const r = installAgents(AGENTS_DIR, directory, PKG_VERSION, (m) => console.log(m))
      if (r.installed > 0) {
        console.log(
          `[opencode-toolkit] installed ${r.installed} agent file(s) into ${r.targetDir}` +
            ` (effective on next opencode launch; run \`npx opencode-toolkit-install\` to skip the wait)`,
        )
      }
      if (r.conflicts.length > 0) {
        console.warn(
          `[opencode-toolkit] skipped ${r.conflicts.length} agent file(s) — already exist as user-owned files (not managed symlinks): ` +
            r.conflicts.join(", "),
        )
      }
    } catch (err) {
      console.error("[opencode-toolkit] failed to install agents:", err)
    }

    // 顺手清理上次 spawn 异常退出可能遗留的陈年 prompt 文件
    try {
      sweepStaleTmpFiles(directory)
    } catch {}
  }

  return {
    /**
     * 配置钩子：把 toolkit 自带的 skills/ 路径推进 config.skills.paths。
     * skill 服务（packages/opencode/src/skill/index.ts:177）会从这个数组读路径
     * 做扫描，且其状态是 lazy 的（首次访问时才构建），所以这里的 mutation
     * 在**当前**这次 opencode 启动里就能让 skill 可用。
     */
    config: async (config) => {
      try {
        if (!fs.existsSync(SKILLS_DIR)) return
        const skillsCfg = (config.skills ??= {})
        const list = (skillsCfg.paths = (skillsCfg.paths ?? []).slice() as string[])
        if (!list.includes(SKILLS_DIR)) {
          list.push(SKILLS_DIR)
          console.log(`[opencode-toolkit] registered skills path: ${SKILLS_DIR}`)
        }
      } catch (err) {
        console.error("[opencode-toolkit] failed to register skills path:", err)
      }
    },

    /**
     * 工具执行后钩子：subagent 完成度审查 + 自动续跑。
     */
    "tool.execute.after": async (input, output) => {
      // 早退 1：自身递归保护
      if (process.env[RECURSION_GUARD] || process.env[LEGACY_RECURSION_GUARD]) return
      // 早退 2：只关心 task 工具
      if (input.tool !== "task") return
      // 早退 3：必须能拿到子 session id
      const sessionId: string | undefined = output.metadata?.sessionId
      if (!sessionId) return

      // 从 task 工具入参里取原始任务描述
      const args = (input as any).args ?? {}
      const originalRequest: string = args.prompt ?? ""
      const description: string = args.description ?? ""
      const subagentType: string = args.subagent_type ?? ""

      let attempts = 0
      let lastVerdict: Verdict | null = null

      while (attempts < MAX_RETRIES) {
        // 拉取子 session 全部消息，重新计算上下文（每轮都要 refetch）
        const list = await client.session.messages({ path: { id: sessionId } })
        const messages: LooseRecord[] = ((list as any)?.data ?? []) as LooseRecord[]
        const last = lastAssistant(messages)
        const finalOutput = lastTextOf(last)
        const fileChanges = extractFileChanges(messages)
        const conversationTail = extractConversationTail(messages)

        const reviewerPrompt = buildReviewerPrompt({
          description,
          subagentType,
          request: originalRequest,
          finalOutput,
          finishReason: last?.info?.finish ?? "",
          errorInfo: last?.info?.error ? clip(JSON.stringify(last.info.error), 800) : "",
          fileChanges,
          conversationTail,
        })

        const verdict = await consultReviewer(reviewerPrompt, directory, reviewerOverride)
        lastVerdict = verdict

        if (!verdict) {
          console.warn(`[opencode-toolkit] session=${sessionId}: no verdict, stopping resume loop`)
          break
        }

        if (verdict.verdict === "complete") {
          console.log(
            `[opencode-toolkit] session=${sessionId}: reviewer says complete (${verdict.confidence}) after ${attempts} resume(s)`,
          )
          break
        }

        attempts++
        console.warn(
          `[opencode-toolkit] session=${sessionId} attempt=${attempts}/${MAX_RETRIES} reasons: ${verdict.reasons.join(" | ")}`,
        )

        try {
          await client.session.prompt({
            path: { id: sessionId },
            body: { parts: [{ type: "text", text: buildContinuation(verdict) }] },
          })
        } catch (err) {
          console.error(`[opencode-toolkit] resume prompt failed for session=${sessionId}:`, err)
          break
        }
      }

      if (attempts === 0) return

      // 收尾：拉最新 messages，把 final text 改写回 output.output
      const list = await client.session.messages({ path: { id: sessionId } })
      const messages: LooseRecord[] = ((list as any)?.data ?? []) as LooseRecord[]
      const finalText = lastTextOf(lastAssistant(messages))
      output.output = rewriteTaskResult(output.output, finalText, attempts, lastVerdict)
    },
  }
}

export default ToolkitPlugin
export const Plugin = ToolkitPlugin
