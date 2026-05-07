/**
 * opencode-toolkit 总入口。
 *
 * package.json 的 `exports["./server"]` 指向这里——opencode 加载 toolkit 时
 * 第一个执行的就是本文件 default 导出的 Plugin 工厂。
 *
 * 当前只装载了一个插件实现（subagent-resumer）。未来加更多插件时，把它们各自
 * 放到 `src/<feature>.ts`，然后在这里把所有子插件的 hooks 合并起来一起返回——
 * 一个 Plugin 工厂一次性注册多组 hooks 给 opencode。
 *
 * 多插件合并模板（待新增第二个插件时启用）：
 *
 *     import type { Plugin, Hooks } from "@opencode-ai/plugin"
 *     import SubagentResumer from "./subagent-resumer.js"
 *     import OtherPlugin from "./other-plugin.js"
 *
 *     const ToolkitPlugin: Plugin = async (input) => {
 *       const all = await Promise.all([SubagentResumer(input), OtherPlugin(input)])
 *       return mergeHooks(all)   // 见下方 mergeHooks 实现
 *     }
 *
 * mergeHooks 思路：对每个 hook 名，若有任何一个子插件定义了它，就合成一个
 * 新 hook：依次 await 调用每个子插件的同名 hook，传同一份 (input, output)
 * 让它们能链式改 output。这与 opencode 多插件并存时各自注册 hook 的行为一致，
 * 只是把"两个 plugin"扁平化为"一个 plugin 内部多个 hook 实现"。
 */

export { default } from "./subagent-resumer.js"
