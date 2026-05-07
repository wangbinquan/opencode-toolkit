#!/usr/bin/env node
/**
 * opencode-toolkit-install —— 把 toolkit 自带的 agent 文件铺到工程的
 * .opencode/agent/ 目录。跨平台（Linux / macOS / Windows）。
 *
 * 用法：
 *   npx opencode-toolkit-install              # 安装到 cwd
 *   npx opencode-toolkit-install /path/to/proj
 *   npx opencode-toolkit-install --uninstall  # 卸载（仅删 toolkit 自己创建的项）
 *   npx opencode-toolkit-install --help
 *
 * 注意：本文件是 .mjs 而不是 .ts，因为 npx 调用时不能依赖 bun/tsx。
 *       逻辑必须与 src/installer.ts 同步——任一改了请同步另一个。
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
      "  opencode-toolkit-install --uninstall [target-dir]    仅删 marker 中登记的 toolkit 文件",
      "  opencode-toolkit-install --help                      显示本帮助",
    ].join("\n"),
  )
  process.exit(0)
}

const knownFlags = new Set(["--help", "-h", "--uninstall", "-u"])
const unknown = args.find((a) => a.startsWith("-") && !knownFlags.has(a))
if (unknown) {
  console.error(`[opencode-toolkit-install] unknown flag: ${unknown}\n  run with --help for usage`)
  process.exit(2)
}

if (uninstall) {
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
