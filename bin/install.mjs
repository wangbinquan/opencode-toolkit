#!/usr/bin/env node
/**
 * harness-toolkit-install —— 一仓两宿主的命令行安装器（跨平台 Linux/macOS/Windows）。
 *
 * opencode（默认）：把 agents/*.md 铺到 <工程>/.opencode/agent/（symlink，Windows 降级 copy）。
 * Claude Code（--claude）：装 SubagentStop hook + 翻译分发 agents/skills 到 <工程>/.claude/{agents,skills}/。
 *
 * 用法：
 *   npx harness-toolkit-install                       # opencode: 装 agent 到 cwd
 *   npx harness-toolkit-install /path/to/proj
 *   npx harness-toolkit-install --uninstall           # opencode: 卸载 toolkit 自建项
 *   npx harness-toolkit-install --claude              # Claude Code: 装 SubagentStop hook
 *   npx harness-toolkit-install --claude --uninstall  # Claude Code: 卸载 hook
 *   npx harness-toolkit-install --help
 *
 * 注意：本文件是 .mjs 而不是 .ts，因为 npx 调用时不能依赖 bun/tsx。
 *       opencode 的 agent 安装逻辑必须与 src/opencode/installer.ts 同步——任一改了请同步另一个。
 */

import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { MARKER_PREFIX, isGeneratedByToolkit, translateAgent } from "./claude-assets.mjs"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PKG_ROOT = path.resolve(__dirname, "..")
const AGENTS_SRC = path.join(PKG_ROOT, "agents")
const SKILLS_SRC = path.join(PKG_ROOT, "skills")
const PKG_VERSION = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(PKG_ROOT, "package.json"), "utf8")).version
  } catch {
    return "unknown"
  }
})()

const MARKER_FILE = ".harness-toolkit.json"
// 旧版本（opencode-toolkit）写的 marker 文件名——升级时仍识别既有安装，避免误判冲突。
const LEGACY_MARKER_FILES = [".opencode-toolkit.json"]

function sha256OfFile(filepath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filepath)).digest("hex")
}

function readMarker(targetDir) {
  // 先读新 marker，找不到再回退旧名（opencode-toolkit 时期），实现平滑升级
  for (const name of [MARKER_FILE, ...LEGACY_MARKER_FILES]) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(targetDir, name), "utf8"))
      if (data.files && typeof data.files === "object") return data
    } catch {
      // 试下一个候选
    }
  }
  return { version: "0.0.0", files: {} }
}

function writeMarker(targetDir, marker) {
  fs.writeFileSync(path.join(targetDir, MARKER_FILE), JSON.stringify(marker, null, 2) + "\n")
  // 迁移：写了新 marker 后删掉旧名残留，避免两份并存
  for (const name of LEGACY_MARKER_FILES) {
    try {
      fs.unlinkSync(path.join(targetDir, name))
    } catch {
      // 不存在即可
    }
  }
}

function writeLinkOrCopy(src, dst) {
  try {
    fs.symlinkSync(src, dst, process.platform === "win32" ? "file" : undefined)
    return "symlink"
  } catch {
    fs.copyFileSync(src, dst)
    return "copy"
  }
}

function symlinkPointsTo(linkPath, src) {
  let cur = ""
  try {
    cur = fs.readlinkSync(linkPath)
  } catch {
    return false
  }
  return path.resolve(path.dirname(linkPath), cur) === src
}

function installAgents(targetProjectDir) {
  const targetDir = path.join(targetProjectDir, ".opencode", "agent")
  const result = { installed: 0, unchanged: 0, conflicts: [], targetDir }

  if (!fs.existsSync(AGENTS_SRC)) {
    console.warn(`[harness-toolkit-install] no agents/ directory at ${AGENTS_SRC}, nothing to do`)
    return result
  }
  const files = fs.readdirSync(AGENTS_SRC).filter((f) => f.endsWith(".md"))
  if (files.length === 0) {
    console.warn(`[harness-toolkit-install] agents/ is empty, nothing to do`)
    return result
  }

  fs.mkdirSync(targetDir, { recursive: true })
  const marker = readMarker(targetDir)

  for (const file of files) {
    const src = path.resolve(AGENTS_SRC, file)
    const dst = path.join(targetDir, file)
    const owned = marker.files[file]

    let lstat
    try {
      lstat = fs.lstatSync(dst)
    } catch {
      lstat = undefined
    }

    if (!lstat) {
      const kind = writeLinkOrCopy(src, dst)
      marker.files[file] = kind === "copy" ? { kind, srcHash: sha256OfFile(src) } : { kind }
      console.log(`  + ${file}  (${kind})`)
      result.installed++
      continue
    }

    if (!owned) {
      console.warn(`  ! ${file}  (skipped — exists, not registered as toolkit-managed)`)
      result.conflicts.push(dst)
      continue
    }

    if (owned.kind === "symlink" && lstat.isSymbolicLink()) {
      if (symlinkPointsTo(dst, src)) {
        console.log(`  = ${file}  (symlink up to date)`)
        result.unchanged++
        continue
      }
      try {
        fs.unlinkSync(dst)
      } catch {}
      const kind = writeLinkOrCopy(src, dst)
      marker.files[file] = kind === "copy" ? { kind, srcHash: sha256OfFile(src) } : { kind }
      console.log(`  ↻ ${file}  (relinked, ${kind})`)
      result.installed++
      continue
    }

    if (owned.kind === "copy" && lstat.isFile()) {
      const currentHash = sha256OfFile(dst)
      const expectedHash = owned.srcHash || ""
      if (currentHash !== expectedHash) {
        console.warn(`  ! ${file}  (skipped — copy modified by user, hash mismatch)`)
        result.conflicts.push(dst)
        continue
      }
      const newHash = sha256OfFile(src)
      if (newHash === expectedHash) {
        console.log(`  = ${file}  (copy up to date)`)
        result.unchanged++
        continue
      }
      fs.copyFileSync(src, dst)
      marker.files[file] = { kind: "copy", srcHash: newHash }
      console.log(`  ↻ ${file}  (copy refreshed)`)
      result.installed++
      continue
    }

    console.warn(`  ! ${file}  (skipped — marker/file type mismatch, treating as user intervention)`)
    result.conflicts.push(dst)
  }

  // 清掉 marker 里 src 已不存在的条目
  const validNames = new Set(files)
  for (const name of Object.keys(marker.files)) {
    if (!validNames.has(name)) delete marker.files[name]
  }
  marker.version = PKG_VERSION
  writeMarker(targetDir, marker)

  return result
}

function uninstallAgents(targetProjectDir) {
  const targetDir = path.join(targetProjectDir, ".opencode", "agent")
  if (!fs.existsSync(targetDir)) {
    console.warn(`[harness-toolkit-install] no ${targetDir}, nothing to remove`)
    return { removed: 0, preserved: [] }
  }

  const marker = readMarker(targetDir)
  let removed = 0
  const preserved = []

  for (const [file, entry] of Object.entries(marker.files)) {
    const dst = path.join(targetDir, file)
    let lstat
    try {
      lstat = fs.lstatSync(dst)
    } catch {
      continue
    }

    if (entry.kind === "copy" && lstat.isFile()) {
      const currentHash = sha256OfFile(dst)
      if (currentHash !== (entry.srcHash || "")) {
        preserved.push(dst)
        console.warn(`  ✋ ${file}  (preserved — user-edited)`)
        continue
      }
    }

    try {
      fs.unlinkSync(dst)
      console.log(`  - ${file}`)
      removed++
    } catch (err) {
      console.warn(`  ! ${file}  (remove failed: ${err.message})`)
    }
  }

  try {
    fs.unlinkSync(path.join(targetDir, MARKER_FILE))
  } catch {}

  return { removed, preserved }
}

// ─────────────────────────────────────────────────────────────────────────
// Claude Code adapter 安装：把 SubagentStop hook 合并进 <工程>/.claude/settings.json
//
// 识别"我们的" hook 项靠 command 含 `src/claude/hook.mjs`——幂等（重复装只更新不重复
// 追加）、可卸载（只删自己的项）、绝不动用户的其它 hook。
// ─────────────────────────────────────────────────────────────────────────

const CLAUDE_SETTINGS_REL = path.join(".claude", "settings.json")
const CLAUDE_HOOK_ABS = path.join(PKG_ROOT, "src", "claude", "hook.mjs")
const CLAUDE_HOOK_MARKER = "src/claude/hook.mjs" // 分隔符归一后子串匹配
const CLAUDE_HOOK_TIMEOUT = 600

function claudeHookCommand() {
  // 双引号包裹绝对路径：跨 cmd.exe / sh 都安全（空格被引号吃掉；Windows 反斜杠字面量，不转义）。
  return `node "${CLAUDE_HOOK_ABS}"`
}

function isOurClaudeHook(h) {
  return h && typeof h.command === "string" && h.command.replace(/\\/g, "/").includes(CLAUDE_HOOK_MARKER)
}

function readJsonSafe(p) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"))
  } catch {
    return undefined
  }
}

function installClaudeHook(projectDir) {
  const settingsPath = path.join(projectDir, CLAUDE_SETTINGS_REL)
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true })

  let settings = {}
  if (fs.existsSync(settingsPath)) {
    const parsed = readJsonSafe(settingsPath)
    if (parsed === undefined) {
      console.error(`[harness-toolkit-install] ${settingsPath} 不是合法 JSON，已中止以免覆盖。请手动修复后重试。`)
      process.exit(2)
    }
    settings = parsed
  }
  if (typeof settings !== "object" || settings === null || Array.isArray(settings)) {
    console.error(`[harness-toolkit-install] ${settingsPath} 顶层不是对象，已中止。`)
    process.exit(2)
  }

  settings.hooks ??= {}
  settings.hooks.SubagentStop ??= []
  const groups = settings.hooks.SubagentStop
  if (!Array.isArray(groups)) {
    console.error(`[harness-toolkit-install] settings.hooks.SubagentStop 不是数组，已中止。`)
    process.exit(2)
  }

  let updated = false
  for (const g of groups) {
    if (!g || !Array.isArray(g.hooks)) continue
    for (const h of g.hooks) {
      if (isOurClaudeHook(h)) {
        h.type = "command"
        h.command = claudeHookCommand()
        h.timeout = CLAUDE_HOOK_TIMEOUT
        updated = true
      }
    }
  }
  if (!updated) {
    groups.push({ hooks: [{ type: "command", command: claudeHookCommand(), timeout: CLAUDE_HOOK_TIMEOUT }] })
  }

  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n")
  console.log(`[harness-toolkit-install] ${updated ? "updated" : "added"} SubagentStop hook → ${settingsPath}`)
  console.log(`  command: ${claudeHookCommand()}  (timeout ${CLAUDE_HOOK_TIMEOUT}s)`)
  console.log(`  续跑上限 CC_TOOLKIT_MAX_RETRIES（默认 3）；审查员模型 CC_TOOLKIT_REVIEWER_MODEL（默认 claude 默认）`)
}

function uninstallClaudeHook(projectDir) {
  const settingsPath = path.join(projectDir, CLAUDE_SETTINGS_REL)
  if (!fs.existsSync(settingsPath)) {
    console.warn(`[harness-toolkit-install] no ${settingsPath}, nothing to remove`)
    return
  }
  const settings = readJsonSafe(settingsPath)
  if (!settings || typeof settings.hooks !== "object" || !Array.isArray(settings.hooks.SubagentStop)) {
    console.warn(`[harness-toolkit-install] no SubagentStop hooks in ${settingsPath}, nothing to remove`)
    return
  }

  let removed = 0
  for (const g of settings.hooks.SubagentStop) {
    if (g && Array.isArray(g.hooks)) {
      const before = g.hooks.length
      g.hooks = g.hooks.filter((h) => !isOurClaudeHook(h))
      removed += before - g.hooks.length
    }
  }
  // 丢掉空 group；SubagentStop / hooks 变空则删键，保持 settings 干净
  settings.hooks.SubagentStop = settings.hooks.SubagentStop.filter(
    (g) => g && Array.isArray(g.hooks) && g.hooks.length > 0,
  )
  if (settings.hooks.SubagentStop.length === 0) delete settings.hooks.SubagentStop
  if (Object.keys(settings.hooks).length === 0) delete settings.hooks

  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n")
  console.log(`[harness-toolkit-install] removed ${removed} toolkit SubagentStop hook(s) from ${settingsPath}`)
}

// ─────────────────────────────────────────────────────────────────────────
// Claude agents：翻译 agents/*.md → <工程>/.claude/agents/（opencode frontmatter
// → Claude frontmatter；详见 bin/claude-assets.mjs 的映射，含 task:allow → Agent）。
// marker 在文件末尾，幂等覆盖自己生成的、不碰用户同名手写文件。
// ─────────────────────────────────────────────────────────────────────────

function installClaudeAgents(projectDir) {
  const targetDir = path.join(projectDir, ".claude", "agents")
  if (!fs.existsSync(AGENTS_SRC)) return { installed: 0, skipped: [] }
  const files = fs.readdirSync(AGENTS_SRC).filter((f) => f.endsWith(".md"))
  if (files.length === 0) {
    console.warn(`  (agents/ 为空，无 agent 可装)`)
    return { installed: 0, skipped: [] }
  }
  fs.mkdirSync(targetDir, { recursive: true })
  let installed = 0
  const skipped = []
  const allWarnings = []
  for (const file of files) {
    const name = file.replace(/\.md$/, "")
    const raw = fs.readFileSync(path.join(AGENTS_SRC, file), "utf8")
    const { content, tools, warnings } = translateAgent(raw, name, file, PKG_VERSION)
    allWarnings.push(...warnings)
    const dst = path.join(targetDir, file)
    if (fs.existsSync(dst) && !isGeneratedByToolkit(fs.readFileSync(dst, "utf8"))) {
      console.warn(`  ! ${file}  (skipped — 已存在且非 toolkit 生成，视为你手写的)`)
      skipped.push(dst)
      continue
    }
    fs.writeFileSync(dst, content)
    console.log(`  + ${file}  (tools: ${tools ? tools.join(", ") || "(空)" : "继承全部"})`)
    installed++
  }
  for (const w of allWarnings) console.warn(`  ⚠ ${w}`)
  return { installed, skipped }
}

function uninstallClaudeAgents(projectDir) {
  const targetDir = path.join(projectDir, ".claude", "agents")
  if (!fs.existsSync(targetDir)) return { removed: 0 }
  let removed = 0
  for (const file of fs.readdirSync(targetDir).filter((f) => f.endsWith(".md"))) {
    const dst = path.join(targetDir, file)
    try {
      if (isGeneratedByToolkit(fs.readFileSync(dst, "utf8"))) {
        fs.unlinkSync(dst)
        console.log(`  - agents/${file}`)
        removed++
      }
    } catch {}
  }
  return { removed }
}

// ─────────────────────────────────────────────────────────────────────────
// Claude skills：拷贝 skills/<name>/ → <工程>/.claude/skills/<name>/。
// SKILL.md 规范两宿主同源，无需翻译——整目录拷贝 + 在 SKILL.md 末尾打 marker。
// ─────────────────────────────────────────────────────────────────────────

function installClaudeSkills(projectDir) {
  const targetRoot = path.join(projectDir, ".claude", "skills")
  if (!fs.existsSync(SKILLS_SRC)) return { installed: 0, skipped: [] }
  const dirs = fs
    .readdirSync(SKILLS_SRC, { withFileTypes: true })
    .filter((e) => e.isDirectory() && fs.existsSync(path.join(SKILLS_SRC, e.name, "SKILL.md")))
  if (dirs.length === 0) {
    console.warn(`  (skills/ 下没有含 SKILL.md 的 skill，无可装)`)
    return { installed: 0, skipped: [] }
  }
  fs.mkdirSync(targetRoot, { recursive: true })
  let installed = 0
  const skipped = []
  for (const e of dirs) {
    const name = e.name
    const dstDir = path.join(targetRoot, name)
    const dstSkill = path.join(dstDir, "SKILL.md")
    if (fs.existsSync(dstSkill) && !isGeneratedByToolkit(fs.readFileSync(dstSkill, "utf8"))) {
      console.warn(`  ! ${name}/  (skipped — 已存在且非 toolkit 生成)`)
      skipped.push(dstDir)
      continue
    }
    fs.rmSync(dstDir, { recursive: true, force: true }) // 清掉上次我们装的，再整目录重拷
    fs.cpSync(path.join(SKILLS_SRC, name), dstDir, { recursive: true })
    const sk = fs.readFileSync(dstSkill, "utf8").replace(/\s*$/, "")
    fs.writeFileSync(
      dstSkill,
      `${sk}\n\n${MARKER_PREFIX} from skills/${name}/ by harness-toolkit@${PKG_VERSION} — reinstall 会覆盖 -->\n`,
    )
    console.log(`  + skills/${name}/`)
    installed++
  }
  return { installed, skipped }
}

function uninstallClaudeSkills(projectDir) {
  const targetRoot = path.join(projectDir, ".claude", "skills")
  if (!fs.existsSync(targetRoot)) return { removed: 0 }
  let removed = 0
  for (const e of fs.readdirSync(targetRoot, { withFileTypes: true }).filter((x) => x.isDirectory())) {
    const skillMd = path.join(targetRoot, e.name, "SKILL.md")
    try {
      if (isGeneratedByToolkit(fs.readFileSync(skillMd, "utf8"))) {
        fs.rmSync(path.join(targetRoot, e.name), { recursive: true, force: true })
        console.log(`  - skills/${e.name}/`)
        removed++
      }
    } catch {}
  }
  return { removed }
}

// ── argv 解析
const args = process.argv.slice(2)
const wantHelp = args.includes("--help") || args.includes("-h")
const uninstall = args.includes("--uninstall") || args.includes("-u")
const claudeMode = args.includes("--claude")
const positional = args.find((a) => !a.startsWith("-"))
const targetDir = positional ? path.resolve(positional) : process.cwd()

if (wantHelp) {
  console.log(
    [
      "harness-toolkit-install — 安装/卸载 toolkit（opencode 或 Claude Code 两个宿主）",
      "",
      "opencode（默认）：把 agents/*.md 铺到 <工程>/.opencode/agent/",
      "  harness-toolkit-install [target-dir]",
      "  harness-toolkit-install --uninstall [target-dir]",
      "",
      "Claude Code：装 SubagentStop hook + 翻译分发 agents → .claude/agents/ + skills → .claude/skills/",
      "  harness-toolkit-install --claude [target-dir]",
      "  harness-toolkit-install --claude --uninstall [target-dir]",
      "",
      "  --help    显示本帮助",
    ].join("\n"),
  )
  process.exit(0)
}

const knownFlags = new Set(["--help", "-h", "--uninstall", "-u", "--claude"])
const unknown = args.find((a) => a.startsWith("-") && !knownFlags.has(a))
if (unknown) {
  console.error(`[harness-toolkit-install] unknown flag: ${unknown}\n  run with --help for usage`)
  process.exit(2)
}

if (claudeMode) {
  if (uninstall) {
    console.log(`[harness-toolkit-install] removing Claude Code adaptation from ${targetDir}/.claude/`)
    uninstallClaudeHook(targetDir)
    const a = uninstallClaudeAgents(targetDir)
    const s = uninstallClaudeSkills(targetDir)
    console.log(`[harness-toolkit-install] removed: hook + agents=${a.removed} skills=${s.removed}`)
  } else {
    console.log(`[harness-toolkit-install] installing Claude Code adaptation into ${targetDir}/.claude/`)
    console.log(`  hook → .claude/settings.json`)
    installClaudeHook(targetDir)
    console.log(`  agents → .claude/agents/  (从 opencode frontmatter 翻译)`)
    const a = installClaudeAgents(targetDir)
    console.log(`  skills → .claude/skills/`)
    const s = installClaudeSkills(targetDir)
    console.log(
      `[harness-toolkit-install] done. hook ✓  agents=${a.installed}(skip ${a.skipped.length})  skills=${s.installed}(skip ${s.skipped.length})`,
    )
  }
} else if (uninstall) {
  console.log(`[harness-toolkit-install] uninstalling toolkit agents from ${targetDir}/.opencode/agent/`)
  const r = uninstallAgents(targetDir)
  console.log(`[harness-toolkit-install] removed=${r.removed} preserved=${r.preserved.length}`)
  if (r.preserved.length > 0) {
    console.log("[harness-toolkit-install] preserved (user-edited, not removed):")
    for (const p of r.preserved) console.log(`  - ${p}`)
  }
} else {
  console.log(`[harness-toolkit-install] installing toolkit agents into ${targetDir}/.opencode/agent/`)
  const r = installAgents(targetDir)
  console.log(
    `[harness-toolkit-install] done. installed=${r.installed} unchanged=${r.unchanged} conflicts=${r.conflicts.length}`,
  )
  if (r.conflicts.length > 0) {
    console.log("[harness-toolkit-install] conflicts (left untouched):")
    for (const p of r.conflicts) console.log(`  - ${p}`)
  }
}
