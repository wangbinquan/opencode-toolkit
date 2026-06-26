/**
 * 把审查员判决转成发回 subagent 的"续跑指令"。平台无关——opencode 通过
 * session.prompt 注入这段文本，claude 通过 SubagentStop hook 的 decision:block
 * reason 注入同一段文本，语义一致。
 *
 * 措辞硬性禁止三种偷懒模式：重复劳动 / 用总结代替执行 / 用提问拖延。
 *
 * @param {import("./types.js").Verdict} verdict
 * @returns {string}
 */
export function buildContinuation(verdict) {
  return [
    "[task-completion-checker] 审核员判定你尚未完成任务。请认真处理：",
    "",
    "## 判定理由",
    ...verdict.reasons.map((r) => `- ${r}`),
    "",
    "## 缺失/未完成项",
    ...(verdict.missing.length > 0 ? verdict.missing.map((m) => `- ${m}`) : ["- (审核员未明确列出，但判定未完成)"]),
    "",
    "## 续跑指令",
    verdict.next_steps?.trim() || "请从你停下的地方继续，把上面缺失项逐条做完，并在最终回复中明确指出每一项的完成情况。",
    "",
    "请直接继续执行，不要重新开始、不要总结之前的内容、不要再问问题。",
  ].join("\n")
}
