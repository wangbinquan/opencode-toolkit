#!/usr/bin/env node
/**
 * opencode-toolkit-install —— 一仓两宿主的命令行安装器（跨平台 Linux/macOS/Windows）。
 *
 * opencode（默认）：把 agents/*.md 铺到 <工程>/.opencode/agent/（symlink，Windows 降级 copy）。
 * Claude Code（--claude）：把 SubagentStop 审查/续跑 hook 合并进 <工程>/.claude/settings.json。
 *
 * 用法：
 *   npx opencode-toolkit-install                       # opencode: 装 agent 到 cwd
 *   npx opencode-toolkit-install /path/to/proj
 *   npx opencode-toolkit-install --uninstall           # opencode: 卸载 toolkit 自建项
 *   npx opencode-toolkit-install --claude              # Claude Code: 装 SubagentStop hook
 *   npx opencode-toolkit-install --claude --uninstall  # Claude Code: 卸载 hook
 *   npx opencode-toolkit-install --help
 *
 * 注意：本文件是 .mjs 而不是 .ts，因为 npx 调用时不能依赖 bun/tsx。
 *       opencode 的 agent 安装逻辑必须与 src/opencode/installer.ts 同步——任一改了请同步另一个。
 */

import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PKG_ROOT = path.resolve(__dirname, "..")
const AGENTS_SRC = path.join(PKG_ROOT, "agents")
const PKG_VERSION = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(PKG_ROOT, "package.json"), "utf8")).version
  } catch {
    return "unknown"
  }
})()

const MARKER_FILE = ".opencode-toolkit.json"

function sha256OfFile(filepath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filepath)).digest("hex")
}

function readMarker(targetDir) {
  const markerPath = path.join(targetDir, MARKER_FILE)
  try {
    const data = JSON.parse(fs.readFileSync(markerPath, "utf8"))
    if (!data.files || typeof data.files !== "object") return { version: "0.0.0", files: {} }
    return data
  } catch {
    return { version: "0.0.0", files: {} }
  }
}

function writeMarker(targetDir, marker) {
  fs.writeFileSync(path.join(targetDir, MARKER_FILE), JSON.stringify(marker, null, 2) + "\n")
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
    console.warn(`[opencode-toolkit-install] no agents/ directory at ${AGENTS_SRC}, nothing to do`)
    return result
  }
  const files = fs.readdirSync(AGENTS_SRC).filter((f) => f.endsWith(".md"))
  if (files.length === 0) {
    console.warn(`[opencode-toolkit-install] agents/ is empty, nothing to do`)
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
    console.warn(`[opencode-toolkit-install] no ${targetDir}, nothing to remove`)
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
      console.error(`[opencode-toolkit-install] ${settingsPath} 不是合法 JSON，已中止以免覆盖。请手动修复后重试。`)
      process.exit(2)
    }
    settings = parsed
  }
  if (typeof settings !== "object" || settings === null || Array.isArray(settings)) {
    console.error(`[opencode-toolkit-install] ${settingsPath} 顶层不是对象，已中止。`)
    process.exit(2)
  }

  settings.hooks ??= {}
  settings.hooks.SubagentStop ??= []
  const groups = settings.hooks.SubagentStop
  if (!Array.isArray(groups)) {
    console.error(`[opencode-toolkit-install] settings.hooks.SubagentStop 不是数组，已中止。`)
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
  console.log(`[opencode-toolkit-install] ${updated ? "updated" : "added"} SubagentStop hook → ${settingsPath}`)
  console.log(`  command: ${claudeHookCommand()}  (timeout ${CLAUDE_HOOK_TIMEOUT}s)`)
  console.log(`  续跑上限 CC_TOOLKIT_MAX_RETRIES（默认 3）；审查员模型 CC_TOOLKIT_REVIEWER_MODEL（默认 claude 默认）`)
}

function uninstallClaudeHook(projectDir) {
  const settingsPath = path.join(projectDir, CLAUDE_SETTINGS_REL)
  if (!fs.existsSync(settingsPath)) {
    console.warn(`[opencode-toolkit-install] no ${settingsPath}, nothing to remove`)
    return
  }
  const settings = readJsonSafe(settingsPath)
  if (!settings || typeof settings.hooks !== "object" || !Array.isArray(settings.hooks.SubagentStop)) {
    console.warn(`[opencode-toolkit-install] no SubagentStop hooks in ${settingsPath}, nothing to remove`)
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
  console.log(`[opencode-toolkit-install] removed ${removed} toolkit SubagentStop hook(s) from ${settingsPath}`)
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
      "opencode-toolkit-install — 安装/卸载 toolkit（opencode 或 Claude Code 两个宿主）",
      "",
      "opencode（默认）：把 agents/*.md 铺到 <工程>/.opencode/agent/",
      "  opencode-toolkit-install [target-dir]",
      "  opencode-toolkit-install --uninstall [target-dir]",
      "",
      "Claude Code：把 SubagentStop 审查/续跑 hook 合并进 <工程>/.claude/settings.json",
      "  opencode-toolkit-install --claude [target-dir]",
      "  opencode-toolkit-install --claude --uninstall [target-dir]",
      "",
      "  --help    显示本帮助",
    ].join("\n"),
  )
  process.exit(0)
}

const knownFlags = new Set(["--help", "-h", "--uninstall", "-u", "--claude"])
const unknown = args.find((a) => a.startsWith("-") && !knownFlags.has(a))
if (unknown) {
  console.error(`[opencode-toolkit-install] unknown flag: ${unknown}\n  run with --help for usage`)
  process.exit(2)
}

if (claudeMode) {
  if (uninstall) {
    console.log(`[opencode-toolkit-install] removing Claude Code SubagentStop hook from ${targetDir}/.claude/settings.json`)
    uninstallClaudeHook(targetDir)
  } else {
    console.log(`[opencode-toolkit-install] installing Claude Code SubagentStop hook into ${targetDir}/.claude/settings.json`)
    installClaudeHook(targetDir)
  }
} else if (uninstall) {
  console.log(`[opencode-toolkit-install] uninstalling toolkit agents from ${targetDir}/.opencode/agent/`)
  const r = uninstallAgents(targetDir)
  console.log(`[opencode-toolkit-install] removed=${r.removed} preserved=${r.preserved.length}`)
  if (r.preserved.length > 0) {
    console.log("[opencode-toolkit-install] preserved (user-edited, not removed):")
    for (const p of r.preserved) console.log(`  - ${p}`)
  }
} else {
  console.log(`[opencode-toolkit-install] installing toolkit agents into ${targetDir}/.opencode/agent/`)
  const r = installAgents(targetDir)
  console.log(
    `[opencode-toolkit-install] done. installed=${r.installed} unchanged=${r.unchanged} conflicts=${r.conflicts.length}`,
  )
  if (r.conflicts.length > 0) {
    console.log("[opencode-toolkit-install] conflicts (left untouched):")
    for (const p of r.conflicts) console.log(`  - ${p}`)
  }
}
