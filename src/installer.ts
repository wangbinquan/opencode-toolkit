/**
 * installer —— 把 toolkit 自带的 agent 文件铺到工程的 .opencode/agent/ 下。
 *
 * 跨平台兼容
 * ──────────
 * - Linux / macOS：优先 symlink（toolkit 升级即文件升级，零拷贝）。
 * - Windows：普通用户没建 symlink 权限，自动降级为 copy；marker 文件记录
 *   "本次安装是 copy 还是 symlink + 源文件 hash"，下次更新时用 hash 判定
 *   "是 toolkit 上次写的 copy" vs "用户后来改过的"，从而实现 copy 模式下
 *   也能自动升级而又不会覆盖用户改动。
 *
 * Marker 文件
 * ───────────
 * 写在 `<工程>/.opencode/agent/.opencode-toolkit.json`，结构：
 *   {
 *     "version": "0.2.0",                  // 上次安装的 toolkit 版本（仅供查阅）
 *     "files": {
 *       "task-completion-checker.md": {
 *         "kind": "symlink" | "copy",
 *         "srcHash": "sha256-hex"           // 仅 copy 模式记录
 *       }
 *     }
 *   }
 *
 * 用户改动保护
 * ────────────
 * 三种"不属于 toolkit 管辖"的情况都会跳过、报告为 conflict：
 *   1. 文件存在但不在 marker 里（用户自己写的）
 *   2. marker 说 kind=symlink，但实际是普通文件（用户替换过）
 *   3. marker 说 kind=copy + 期望 hash X，但实际文件 hash 不是 X（用户改过）
 *
 * 时机
 * ────
 * agent 在 opencode 配置启动期被扫描（早于 plugin load）。所以 plugin factory
 * 里第一次跑时写出来的 agent 对**当次启动**看不见，要**下次**启动才能扫到。
 * 想消除这一启动延迟，先跑一次 `npx opencode-toolkit-install`。
 */

import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"

const MARKER_FILE = ".opencode-toolkit.json"

/** marker 文件的 schema */
type Marker = {
  version: string
  files: Record<string, { kind: "symlink" | "copy"; srcHash?: string }>
}

/** 一次安装的统计结果。 */
export type InstallResult = {
  /** 实际写入或更新了多少个 agent 文件 */
  installed: number
  /** 已经是正确的 symlink/copy、跳过的数量 */
  unchanged: number
  /** 因为是用户文件 / 被用户改过 而跳过的目标路径 */
  conflicts: string[]
  /** 安装到的目标目录（绝对路径） */
  targetDir: string
}

/** 计算文件 sha256，hex 串。 */
function sha256OfFile(filepath: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(filepath)).digest("hex")
}

/** 读 marker，缺失或损坏返回空白结构。 */
function readMarker(targetDir: string): Marker {
  const markerPath = path.join(targetDir, MARKER_FILE)
  try {
    const data = JSON.parse(fs.readFileSync(markerPath, "utf8")) as Marker
    if (!data.files || typeof data.files !== "object") return { version: "0.0.0", files: {} }
    return data
  } catch {
    return { version: "0.0.0", files: {} }
  }
}

/** 写 marker。pretty-print 让人能直接读。 */
function writeMarker(targetDir: string, marker: Marker): void {
  fs.writeFileSync(path.join(targetDir, MARKER_FILE), JSON.stringify(marker, null, 2) + "\n")
}

/**
 * 试着建 symlink；失败（Windows 普通用户 / 跨设备 / 文件系统不支持）则降级为 copy。
 *
 * Windows 上 `fs.symlinkSync` 必须传第 3 参 `"file" | "dir" | "junction"`，否则报错。
 * 我们这里写的是文件 symlink，传 `"file"`。
 */
function writeLinkOrCopy(src: string, dst: string): "symlink" | "copy" {
  try {
    fs.symlinkSync(src, dst, process.platform === "win32" ? "file" : undefined)
    return "symlink"
  } catch {
    fs.copyFileSync(src, dst)
    return "copy"
  }
}

/** symlink 目标解析后是否等于源文件路径。 */
function symlinkPointsTo(linkPath: string, src: string): boolean {
  let cur = ""
  try {
    cur = fs.readlinkSync(linkPath)
  } catch {
    return false
  }
  return path.resolve(path.dirname(linkPath), cur) === src
}

/**
 * 把 srcDir 下的所有 .md 文件 symlink/copy 到 targetProjectDir/.opencode/agent/。
 *
 * @param srcDir            toolkit 包内的 agents/ 绝对路径
 * @param targetProjectDir  目标工程根目录（PluginInput.directory）
 * @param pkgVersion        当前 toolkit 包版本，写入 marker 仅供查阅
 * @param logger            可选日志回调，默认走 console.log
 */
export function installAgents(
  srcDir: string,
  targetProjectDir: string,
  pkgVersion: string,
  logger: (msg: string) => void = (m) => console.log(m),
): InstallResult {
  const result: InstallResult = {
    installed: 0,
    unchanged: 0,
    conflicts: [],
    targetDir: path.join(targetProjectDir, ".opencode", "agent"),
  }

  if (!fs.existsSync(srcDir)) return result
  const files = fs.readdirSync(srcDir).filter((f) => f.endsWith(".md"))
  if (files.length === 0) return result

  fs.mkdirSync(result.targetDir, { recursive: true })
  const marker = readMarker(result.targetDir)

  for (const file of files) {
    const src = path.resolve(srcDir, file)
    const dst = path.join(result.targetDir, file)
    const owned = marker.files[file]

    let lstat: fs.Stats | undefined
    try {
      lstat = fs.lstatSync(dst)
    } catch {
      lstat = undefined
    }

    // 情况 1：目标不存在 → 全新安装
    if (!lstat) {
      const kind = writeLinkOrCopy(src, dst)
      marker.files[file] = kind === "copy" ? { kind, srcHash: sha256OfFile(src) } : { kind }
      logger(`[opencode-toolkit] installed agent: ${file} (${kind})`)
      result.installed++
      continue
    }

    // 情况 2：目标存在但 marker 里没有 → 视作用户文件，不动
    if (!owned) {
      result.conflicts.push(dst)
      continue
    }

    // 情况 3：marker 说 kind=symlink，且实际也是 symlink
    if (owned.kind === "symlink" && lstat.isSymbolicLink()) {
      if (symlinkPointsTo(dst, src)) {
        result.unchanged++
        continue
      }
      // 指向变了（toolkit 路径改变）→ 重链
      try {
        fs.unlinkSync(dst)
      } catch {}
      const kind = writeLinkOrCopy(src, dst)
      marker.files[file] = kind === "copy" ? { kind, srcHash: sha256OfFile(src) } : { kind }
      logger(`[opencode-toolkit] updated agent: ${file} (relinked, ${kind})`)
      result.installed++
      continue
    }

    // 情况 4：marker 说 kind=copy，且实际是普通文件
    if (owned.kind === "copy" && lstat.isFile()) {
      const currentHash = sha256OfFile(dst)
      const expectedHash = owned.srcHash ?? ""

      // 4a：用户改过 → 不动
      if (currentHash !== expectedHash) {
        result.conflicts.push(dst)
        continue
      }

      // 4b：toolkit 写的 copy，且 src 内容没变 → 不动
      const newHash = sha256OfFile(src)
      if (newHash === expectedHash) {
        result.unchanged++
        continue
      }

      // 4c：toolkit 写的 copy，src 已升级 → 重写
      fs.copyFileSync(src, dst)
      marker.files[file] = { kind: "copy", srcHash: newHash }
      logger(`[opencode-toolkit] updated agent: ${file} (copy refreshed)`)
      result.installed++
      continue
    }

    // 情况 5：marker 与实际文件类型不一致（用户把 symlink 替换成文件，或反之）
    // 视作用户介入，不动
    result.conflicts.push(dst)
  }

  // 清掉 marker 里 src 已不存在的条目（toolkit 删了某个 agent）
  const validNames = new Set(files)
  for (const name of Object.keys(marker.files)) {
    if (!validNames.has(name)) delete marker.files[name]
  }
  marker.version = pkgVersion
  writeMarker(result.targetDir, marker)

  return result
}

/**
 * 卸载：把 marker 里登记为 toolkit 所有的 agent 删掉，未登记的留下。
 *
 * - kind=symlink：直接删
 * - kind=copy：先核对当前文件 hash 等于 marker 里记录的 srcHash；不等说明用户改过 → 留下
 *
 * 卸载完成后清 marker。
 */
export function uninstallAgents(
  targetProjectDir: string,
  logger: (msg: string) => void = (m) => console.log(m),
): { removed: number; preserved: string[] } {
  const targetDir = path.join(targetProjectDir, ".opencode", "agent")
  if (!fs.existsSync(targetDir)) return { removed: 0, preserved: [] }

  const marker = readMarker(targetDir)
  let removed = 0
  const preserved: string[] = []

  for (const [file, entry] of Object.entries(marker.files)) {
    const dst = path.join(targetDir, file)
    let lstat: fs.Stats | undefined
    try {
      lstat = fs.lstatSync(dst)
    } catch {
      // 已经被删 → 跳过
      continue
    }

    if (entry.kind === "copy" && lstat.isFile()) {
      const currentHash = sha256OfFile(dst)
      if (currentHash !== (entry.srcHash ?? "")) {
        // 用户改过 → 不删
        preserved.push(dst)
        logger(`[opencode-toolkit] preserved (user-edited): ${file}`)
        continue
      }
    }

    try {
      fs.unlinkSync(dst)
      logger(`[opencode-toolkit] removed agent: ${file}`)
      removed++
    } catch {}
  }

  // 删 marker
  try {
    fs.unlinkSync(path.join(targetDir, MARKER_FILE))
  } catch {}

  return { removed, preserved }
}
