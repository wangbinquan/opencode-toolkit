#!/usr/bin/env node
/**
 * opencode-toolkit-install —— 手动把 toolkit 自带的 agent 文件铺到当前工程的
 * .opencode/agent/ 目录。
 *
 * 用途：消除"插件 factory 安装的 agent 要等下次启动 opencode 才生效"这条
 *      启动延迟。新拉一个工程 / 升级 toolkit 后跑一次，本次启动 opencode 就能
 *      看到所有 agent。
 *
 * 用法：
 *   npx opencode-toolkit-install              # 安装到 cwd
 *   npx opencode-toolkit-install /path/to/proj  # 安装到指定工程
 *   npx opencode-toolkit-install --uninstall  # 卸载（仅删 toolkit 自己建的 symlink）
 *
 * 注意：这个文件是 .mjs 而不是 .ts，因为 npx 调用的二进制不能依赖 bun/tsx。
 *      逻辑与 src/installer.ts 同步——任一改了请同步另一个。
 */

import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PKG_ROOT = path.resolve(__dirname, "..")
const AGENTS_SRC = path.join(PKG_ROOT, "agents")

function tryLink(src, dst) {
  try {
    fs.symlinkSync(src, dst)
    return "symlink"
  } catch {
    fs.copyFileSync(src, dst)
    return "copy"
  }
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

  for (const file of files) {
    const src = path.resolve(AGENTS_SRC, file)
    const dst = path.join(targetDir, file)

    let lstat
    try {
      lstat = fs.lstatSync(dst)
    } catch {
      lstat = undefined
    }

    if (!lstat) {
      const how = tryLink(src, dst)
      console.log(`  + ${file}  (${how})`)
      result.installed++
      continue
    }

    if (lstat.isSymbolicLink()) {
      let cur = ""
      try {
        cur = fs.readlinkSync(dst)
      } catch {}
      const curResolved = path.resolve(path.dirname(dst), cur)
      if (curResolved === src) {
        console.log(`  = ${file}  (already linked)`)
        result.unchanged++
        continue
      }
      try {
        fs.unlinkSync(dst)
      } catch {}
      const how = tryLink(src, dst)
      console.log(`  ↻ ${file}  (updated, ${how})`)
      result.installed++
      continue
    }

    if (lstat.isFile()) {
      console.warn(`  ! ${file}  (skipped — already exists as a regular file, leaving user copy alone)`)
      result.conflicts.push(dst)
      continue
    }

    console.warn(`  ! ${file}  (skipped — exists as non-file, non-symlink)`)
    result.conflicts.push(dst)
  }

  return result
}

function uninstallAgents(targetProjectDir) {
  const targetDir = path.join(targetProjectDir, ".opencode", "agent")
  if (!fs.existsSync(targetDir)) {
    console.warn(`[opencode-toolkit-install] no ${targetDir}, nothing to remove`)
    return { removed: 0 }
  }

  let removed = 0
  for (const file of fs.readdirSync(targetDir)) {
    if (!file.endsWith(".md")) continue
    const dst = path.join(targetDir, file)
    let lstat
    try {
      lstat = fs.lstatSync(dst)
    } catch {
      continue
    }
    if (!lstat.isSymbolicLink()) continue

    let cur = ""
    try {
      cur = fs.readlinkSync(dst)
    } catch {}
    const curResolved = path.resolve(path.dirname(dst), cur)
    if (!curResolved.startsWith(AGENTS_SRC)) continue

    try {
      fs.unlinkSync(dst)
      console.log(`  - ${file}`)
      removed++
    } catch (err) {
      console.warn(`  ! ${file}  (remove failed: ${err.message})`)
    }
  }
  return { removed }
}

// ── argv 解析
const args = process.argv.slice(2)
const wantHelp = args.includes("--help") || args.includes("-h")
const uninstall = args.includes("--uninstall") || args.includes("-u")
const positional = args.find((a) => !a.startsWith("-"))
const targetDir = positional ? path.resolve(positional) : process.cwd()

if (wantHelp) {
  console.log(
    [
      "opencode-toolkit-install — 安装/卸载 toolkit 自带的 agent 到指定工程的 .opencode/agent/",
      "",
      "用法：",
      "  opencode-toolkit-install [target-dir]                安装到 cwd 或指定目录",
      "  opencode-toolkit-install --uninstall [target-dir]    仅删 toolkit 自己创建的 symlink",
      "  opencode-toolkit-install --help                      显示本帮助",
    ].join("\n"),
  )
  process.exit(0)
}

// 兜底：未知 flag 直接报错，避免被当成 cwd 安装
const knownFlags = new Set(["--help", "-h", "--uninstall", "-u"])
const unknown = args.find((a) => a.startsWith("-") && !knownFlags.has(a))
if (unknown) {
  console.error(`[opencode-toolkit-install] unknown flag: ${unknown}\n  run with --help for usage`)
  process.exit(2)
}

if (uninstall) {
  console.log(`[opencode-toolkit-install] uninstalling toolkit agents from ${targetDir}/.opencode/agent/`)
  const r = uninstallAgents(targetDir)
  console.log(`[opencode-toolkit-install] removed ${r.removed} symlink(s)`)
  process.exit(0)
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
  process.exit(0)
}
