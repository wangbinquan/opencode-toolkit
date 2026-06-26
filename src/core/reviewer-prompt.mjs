/**
 * 组装审查员 prompt。平台无关——各宿主 adapter 从自己的会话格式抽出 ReviewerInput
 * 字段后调用本函数生成统一的 markdown 报告喂给 reviewer。
 *
 * 章节标题与 task-completion-checker.md 的 system prompt 严格对齐——审查员是按
 * 这些标题定位字段的。
 *
 * 文件以 `## ORIGINAL_REQUEST` 开头是有意为之：审查员 agent 同时支持
 * "INPUT_FILE <path>"（推荐）和"直接 inline 这段 markdown"两种输入形式，
 * 后者用首行 `## ORIGINAL_REQUEST` 作为识别标志。
 *
 * @param {import("./types.js").ReviewerInput} input
 * @returns {string}
 */
export function buildReviewerPrompt(input) {
  const fc =
    input.fileChanges.length === 0
      ? "（无文件改动记录）"
      : input.fileChanges
          .map((c, i) => {
            const head = `${i + 1}. tool=${c.tool}` + (c.path ? ` path=${c.path}` : "")
            return c.detail ? `${head}\n   detail: ${c.detail}` : head
          })
          .join("\n")

  return [
    "## ORIGINAL_REQUEST",
    input.request || "(empty)",
    "",
    "## SUBAGENT_DESCRIPTION",
    input.description || "(empty)",
    "",
    "## SUBAGENT_TYPE",
    input.subagentType || "(empty)",
    "",
    "## FINISH_REASON",
    input.finishReason || "(unknown)",
    "",
    "## ERROR_INFO",
    input.errorInfo || "(none)",
    "",
    "## FINAL_OUTPUT",
    input.finalOutput || "(empty)",
    "",
    "## FILE_CHANGES",
    fc,
    "",
    "## CONVERSATION_TAIL",
    input.conversationTail || "(empty)",
  ].join("\n")
}
