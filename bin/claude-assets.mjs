/**
 * Claude Code 资产翻译/分发的纯逻辑——被 bin/install.mjs 的 `--claude` 调用。
 *
 * 单独成文件（不在 install.mjs 里内联）是为了**可单测**：install.mjs 是脚本，
 * import 即执行 argv 逻辑，不便测试；本文件只导出纯函数，无副作用。
 *
 * 核心是把 opencode agent 的 frontmatter 翻译成 Claude Code 的：
 *   - opencode `permission: {read/edit/write/bash/glob/grep/webfetch/websearch/task}: allow|deny`
 *     → Claude `tools:` allowlist（只列被 allow 的工具；deny 的不列 = 不可用）
 *   - 关键：`permission: task: allow` → tools 含 `Agent`（= 可在 subagent 里启动 subagent，
 *     ≤5 层）；`task: deny` → 不含 `Agent`（= 不能派生）
 *   - opencode 的 bash 细粒度白名单（`"git diff*": allow` 之类）Claude 的 agent
 *     `tools` 表达不了，只能粗到整个 `Bash`——只要 bash 有任一 allow 就给 Bash。
 *
 * @module
 */

/** 生成文件的标记（放在文件末尾的 HTML 注释，不影响 frontmatter / 正文）。
 *  用于：reinstall 幂等覆盖、uninstall 只删自己生成的、不碰用户手写的同名文件。 */
export const MARKER_PREFIX = "<!-- harness-toolkit:generated"

/** 旧版本（opencode-toolkit）生成文件用的 marker 前缀——升级时仍能识别/覆盖/卸载既有生成物。 */
export const LEGACY_MARKER_PREFIXES = ["<!-- opencode-toolkit:generated"]

/** 文本是否由本 toolkit（任一版本）生成。 */
export function isGeneratedByToolkit(text) {
  return text.includes(MARKER_PREFIX) || LEGACY_MARKER_PREFIXES.some((p) => text.includes(p))
}

/** opencode permission key → Claude 工具名。edit/patch 都映射到 Edit 家族。 */
const PERM_TO_TOOLS = [
  ["read", ["Read"]],
  ["edit", ["Edit", "MultiEdit"]],
  ["patch", ["Edit"]],
  ["write", ["Write"]],
  ["bash", ["Bash"]],
  ["glob", ["Glob"]],
  ["grep", ["Grep"]],
  ["webfetch", ["WebFetch"]],
  ["websearch", ["WebSearch"]],
  ["task", ["Agent"]],
]

/** Claude tools 输出的稳定顺序。 */
const TOOL_ORDER = ["Read", "Edit", "MultiEdit", "Write", "Bash", "Glob", "Grep", "WebFetch", "WebSearch", "Agent"]

/** 拆 `---\n<fm>\n---\n<body>`。无 frontmatter 时 fm="" body=原文。 */
export function splitFrontmatter(raw) {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
  if (!m) return { fm: "", body: raw }
  return { fm: m[1], body: m[2] }
}

/**
 * 解析 opencode 的 permission 块（缩进敏感的 YAML 子集）。
 *
 * 支持两种形态：
 *   read: allow                 → perms.read = "allow"
 *   bash:                       → perms.bash = { map: true, hasAllow: <是否有任一 allow> }
 *     "*": deny
 *     "ls *": allow
 *
 * 无 `permission:` 块返回 null（调用方据此**不**输出 tools 字段 = 继承全部工具）。
 */
export function parsePermissions(fm) {
  const lines = fm.split(/\r?\n/)
  let i = lines.findIndex((l) => /^permission:\s*$/.test(l))
  if (i === -1) return null
  const perms = {}
  for (i = i + 1; i < lines.length; i++) {
    const line = lines[i]
    if (/^\S/.test(line)) break // 回到顶层 key，permission 块结束
    if (line.trim() === "") continue
    const flat = line.match(/^ {2}([A-Za-z_]+):\s*(.*)$/)
    if (!flat) continue
    const key = flat[1]
    const val = flat[2].trim().replace(/^["']|["']$/g, "")
    if (val) {
      perms[key] = val // allow / deny / ask
    } else {
      // 嵌套 map：往下扫缩进-4 的 `"pattern": value`
      let hasAllow = false
      let j = i + 1
      for (; j < lines.length; j++) {
        if (!/^ {4}/.test(lines[j])) break
        if (/:\s*["']?allow["']?\s*$/.test(lines[j])) hasAllow = true
      }
      perms[key] = { map: true, hasAllow }
      i = j - 1
    }
  }
  return perms
}

/** 某 permission 值是否"放行"。allow/ask → true；deny → false；map → 看 hasAllow；缺失 → null。 */
function permits(v) {
  if (v == null) return null
  if (typeof v === "string") return v === "allow" || v === "ask"
  if (typeof v === "object") return !!v.hasAllow
  return null
}

/**
 * 由 perms 构造 Claude tools allowlist。
 * perms=null（无 permission 块）→ 返回 null（调用方不写 tools 字段 = 继承全部）。
 * 返回 []（有块但全 deny）→ 调用方应警示（几乎不会发生）。
 */
export function buildTools(perms) {
  if (!perms) return null
  const set = new Set()
  for (const [key, tools] of PERM_TO_TOOLS) {
    if (permits(perms[key]) === true) for (const t of tools) set.add(t)
  }
  return TOOL_ORDER.filter((t) => set.has(t))
}

/** YAML 双引号标量，转义 \ 和 "。用于 description（含冒号/中文/反引号也安全）。 */
function yamlQuote(s) {
  return '"' + String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"'
}

/**
 * 把一份 opencode agent .md 翻译成 Claude Code agent .md 文本。
 *
 * @param {string} raw         opencode agent 文件原文
 * @param {string} name        agent 名（来自文件名去掉 .md）
 * @param {string} srcFile     源文件名（写进 marker，便于溯源）
 * @param {string} pkgVersion  toolkit 版本（写进 marker）
 * @returns {{ content: string, tools: string[]|null, warnings: string[] }}
 */
export function translateAgent(raw, name, srcFile, pkgVersion) {
  const warnings = []
  const { fm, body } = splitFrontmatter(raw)

  const desc = (fm.match(/^description:\s*(.+)$/m)?.[1] ?? "").trim().replace(/^["']|["']$/g, "")

  let model = (fm.match(/^model:\s*(.+)$/m)?.[1] ?? "").trim().replace(/^["']|["']$/g, "")
  if (model.includes("/")) model = model.split("/").slice(1).join("/") // 去掉 provider 前缀，如 anthropic/

  const perms = parsePermissions(fm)
  const tools = buildTools(perms)
  if (tools && tools.length === 0) {
    warnings.push(`${srcFile}: permission 块把所有工具都 deny 了，翻译后 tools 为空——已跳过 tools 字段（= 继承全部），请人工确认`)
  }

  const head = ["---", `name: ${name}`]
  if (desc) head.push(`description: ${yamlQuote(desc)}`)
  if (tools && tools.length > 0) head.push(`tools: ${tools.join(", ")}`)
  if (model) head.push(`model: ${model}`)
  head.push("---")

  const marker = `${MARKER_PREFIX} from agents/${srcFile} by harness-toolkit@${pkgVersion} — reinstall 会覆盖，勿手改 -->`
  const content = `${head.join("\n")}\n\n${body.trim()}\n\n${marker}\n`
  return { content, tools, warnings }
}
