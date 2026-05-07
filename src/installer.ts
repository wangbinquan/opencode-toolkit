/**
 * installer —— 把 toolkit 自带的 agent 文件铺到工程的 .opencode/agent/ 下。
 *
 * 为什么需要这个模块
 * ──────────────────
 * opencode 的 agent 发现路径是固定的 ".opencode/agent(s)/" 目录扫描
 * （见 packages/opencode/src/config/agent.ts:112 的 Glob.scan），它**不会**
 * 自动从 npm 包里发现 agent 定义。所以 toolkit 作为 npm 包发布后，agent
 * 文件得想办法落到工程的 .opencode/agent/ 下，opencode 才看得见。
 *
 * 实现策略
 * ────────
 * 优先 symlink，失败回退到 copy（Windows 没管理员权限时 symlink 会失败）。
 * symlink 的好处：toolkit 升级一次（pnpm update），所有 agent 内容自动跟着
 * 升级，工程侧零操作。
 *
 * 用户改动保护
 * ────────────
 * 如果工程的 .opencode/agent/<name>.md 已经存在且**不是** symlink（普通文件），
 * 视为用户自己写了同名 agent，**不覆盖**，并把冲突报告给调用方。
 *
 * 时机
 * ────
 * agent 在 opencode 配置启动期被扫描（早于 plugin load）。所以本模块在
 * plugin factory 里第一次跑时，写出来的 symlink 对**当前这次** opencode 启动
 * 是看不见的，要**下次**启动才能用。给团队成员的指引里要说明这一点；或者
 * 让他们在第一次启动前手动跑 bin/install.mjs。
 */

import fs from "node:fs"
import path from "node:path"

/** 一次安装的统计结果。 */
export type InstallResult = {
  /** 实际写入或更新了多少个 agent 文件 */
  installed: number
  /** 已经是正确的 symlink、跳过的数量 */
  unchanged: number
  /** 因为存在用户自己的同名文件而跳过的目标路径 */
  conflicts: string[]
  /** 安装到的目标目录（绝对路径） */
  targetDir: string
}

/**
 * 把 srcDir 下的所有 .md 文件 symlink/copy 到 targetProjectDir/.opencode/agent/。
 *
 * @param srcDir            toolkit 包内的 agents/ 绝对路径
 * @param targetProjectDir  目标工程根目录（PluginInput.directory）
 * @param logger            可选日志回调，默认走 console.log
 */
export function installAgents(
  srcDir: string,
  targetProjectDir: string,
  logger: (msg: string) => void = (m) => console.log(m),
): InstallResult {
  const result: InstallResult = {
    installed: 0,
    unchanged: 0,
    conflicts: [],
    targetDir: path.join(targetProjectDir, ".opencode", "agent"),
  }

  // 源目录不存在或没文件：直接返回，不报错（toolkit 可能还没放 agent）
  if (!fs.existsSync(srcDir)) return result
  const files = fs.readdirSync(srcDir).filter((f) => f.endsWith(".md"))
  if (files.length === 0) return result

  // 确保目标目录存在
  fs.mkdirSync(result.targetDir, { recursive: true })

  for (const file of files) {
    const src = path.resolve(srcDir, file)
    const dst = path.join(result.targetDir, file)

    // 用 lstatSync 而非 statSync —— 我们要看 symlink 本身而不是它指向的目标
    let lstat: fs.Stats | undefined
    try {
      lstat = fs.lstatSync(dst)
    } catch {
      lstat = undefined
    }

    if (!lstat) {
      // 目标不存在：直接建 symlink（失败回退 copy）
      writeLinkOrCopy(src, dst)
      logger(`[opencode-toolkit] installed agent: ${file}`)
      result.installed++
      continue
    }

    if (lstat.isSymbolicLink()) {
      // 已经是 symlink：检查指向是否正确
      let cur = ""
      try {
        cur = fs.readlinkSync(dst)
      } catch {}
      const curResolved = path.resolve(path.dirname(dst), cur)
      if (curResolved === src) {
        result.unchanged++
        continue
      }
      // 指向变了（比如 toolkit 路径变了）：替换
      try {
        fs.unlinkSync(dst)
      } catch {}
      writeLinkOrCopy(src, dst)
      logger(`[opencode-toolkit] updated agent symlink: ${file}`)
      result.installed++
      continue
    }

    if (lstat.isFile()) {
      // 普通文件：可能是用户自己写的，**不**覆盖
      result.conflicts.push(dst)
      continue
    }

    // 目录或其它奇怪类型：报冲突
    result.conflicts.push(dst)
  }

  return result
}

/**
 * 试着建 symlink；失败（权限 / 跨设备 / Windows 限制）则降级为 copy。
 * 注意：copy 之后未来 toolkit 升级不会自动跟新——需要再跑一次 install 才行。
 */
function writeLinkOrCopy(src: string, dst: string): void {
  try {
    fs.symlinkSync(src, dst)
    return
  } catch {
    // 降级
  }
  fs.copyFileSync(src, dst)
}

/**
 * 卸载：把 .opencode/agent/ 下由本 toolkit 创建的 symlink 都删掉，普通文件保留。
 *
 * 判定"是本 toolkit 创建的 symlink"的依据是 readlink 后落点位于 srcDir 之内。
 */
export function uninstallAgents(
  srcDir: string,
  targetProjectDir: string,
  logger: (msg: string) => void = (m) => console.log(m),
): { removed: number } {
  const targetDir = path.join(targetProjectDir, ".opencode", "agent")
  if (!fs.existsSync(targetDir)) return { removed: 0 }

  let removed = 0
  for (const file of fs.readdirSync(targetDir)) {
    if (!file.endsWith(".md")) continue
    const dst = path.join(targetDir, file)
    let lstat: fs.Stats
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
    if (!curResolved.startsWith(srcDir)) continue // 不是我们的 symlink

    try {
      fs.unlinkSync(dst)
      logger(`[opencode-toolkit] removed agent: ${file}`)
      removed++
    } catch {}
  }
  return { removed }
}
