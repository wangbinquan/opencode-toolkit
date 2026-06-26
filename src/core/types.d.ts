/**
 * 共享类型——opencode 与 claude 两个 adapter 都从这里取 Verdict / FileChange /
 * ReviewerInput 的结构。纯类型声明，无运行时代码。
 *
 * .mjs 文件用 JSDoc `@param {import("./types.js").Xxx}` 引用这里；adapter 的
 * .ts 文件用 `import type { Xxx } from "../core/types.js"`（import type 在打包
 * 时被擦除，不需要真实存在 types.js）。
 */

/** 审查员判决——XML（主）/ JSON（兜底）解析后的归一结构。 */
export interface Verdict {
  verdict: "complete" | "incomplete"
  confidence: "high" | "medium" | "low"
  reasons: string[]
  missing: string[]
  evidence: string[]
  next_steps: string
}

/** 一次"产生过文件改动"的工具调用归一记录。 */
export interface FileChange {
  tool: string
  path?: string
  detail?: string
}

/**
 * buildReviewerPrompt 的输入。各宿主 adapter 从自己的会话/transcript 格式里抽出
 * 这些字段后传入——章节标题与 task-completion-checker 审查员 prompt 严格对齐。
 */
export interface ReviewerInput {
  description: string
  subagentType: string
  request: string
  finalOutput: string
  finishReason: string
  errorInfo: string
  fileChanges: FileChange[]
  conversationTail: string
}
