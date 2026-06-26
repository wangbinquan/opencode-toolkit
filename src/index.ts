/**
 * opencode-toolkit —— opencode 宿主入口 barrel。
 *
 * package.json 的 `exports["./server"]`（与 `.`）指向这里——opencode 加载 toolkit
 * 时第一个执行的就是本文件 re-export 的 default Plugin 工厂（实现在
 * `src/opencode/index.ts`）。
 *
 * ── 一仓两宿主的目录约定 ─────────────────────────────────────────────────
 * 本仓同时服务 opencode 与 Claude Code 两个宿主，按"平台"分目录、靠一条依赖
 * 铁律保证互不影响：
 *
 *   src/core/     平台无关纯逻辑（.mjs + JSDoc）。reviewer prompt 组装 / 判决
 *                 解析 / 续跑指令生成 / 文本工具。**不许 import 任何宿主 SDK**，
 *                 这样 opencode（吃 .ts）与 Claude（裸 .mjs hook）都能零编译复用。
 *   src/opencode/ opencode adapter。唯一可 import `@opencode-ai/*` 的目录。
 *                 入口 index.ts = `tool.execute.after` 钩子上的 subagent 完成度
 *                 审查 + 自动续跑；installer.ts 把 agent 铺到 .opencode/agent/。
 *   src/claude/   Claude Code adapter（纯 .mjs，零 opencode 符号）。SubagentStop
 *                 hook：读 transcript → 审 → `decision:block` 把续跑指令喂回同一
 *                 subagent。由 `.claude/settings.json` 的 command hook 直接 exec，
 *                 **不经过本 barrel**。
 *
 * 两个 adapter 的模块图 disjoint，宿主各走各的 entry（opencode→本文件；
 * Claude→src/claude/hook.mjs），运行期从不在同一进程共存。core 是唯一交集。
 *
 * ── 未来在 opencode 侧加更多插件 ─────────────────────────────────────────
 * 把新插件放到 `src/opencode/<feature>.ts`，在这里把各子插件的 hooks 合并后一并
 * 返回（一个 Plugin 工厂一次注册多组 hooks）：
 *
 *     import type { Plugin } from "@opencode-ai/plugin"
 *     import SubagentResumer from "./opencode/index.js"
 *     import OtherPlugin from "./opencode/other-plugin.js"
 *
 *     const ToolkitPlugin: Plugin = async (input) => {
 *       const all = await Promise.all([SubagentResumer(input), OtherPlugin(input)])
 *       return mergeHooks(all)   // 对每个 hook 名依次 await 各子插件同名 hook，
 *     }                          // 传同一份 (input, output) 让它们链式改 output
 */

export { default } from "./opencode/index.js"
