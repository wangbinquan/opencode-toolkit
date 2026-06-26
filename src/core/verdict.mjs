/**
 * 从审查员 stdout 文本里抽判决。平台无关——opencode 与 claude 两侧的 reviewer
 * 都输出同一套 `<task_completion_review>` XML 协议，这里统一解析。
 *
 * 主路径：XML 标签格式（v0.2.5 起的协议）。
 * 兜底：旧的 JSON 格式（pre-v0.2.5 agent 的输出，或模型 hallucinate 回退到 JSON）。
 *
 * 为什么主路径换成 XML？
 *   LLM 生成 JSON 字符串值时频繁忘记转义内嵌引号——尤其中文模型在 reasons
 *   这种长描述里写 `"做完了"` 之类的强调引号，整段 JSON 就崩，JSON.parse
 *   失败、verdict=null、整个 review 链路废掉。XML 标签内的文本是字面量，
 *   引号 / 换行 / 单引号 / 中文标点全部宽容、零转义负担。
 */

/**
 * @param {string} text
 * @returns {import("./types.js").Verdict | null}
 */
export function extractVerdict(text) {
  return extractVerdictXML(text) ?? extractVerdictJsonLegacy(text)
}

/**
 * 解析 XML 标签格式的判决（主路径）。
 *
 * 期望文本里至少有一组：
 *   <task_completion_review>
 *     <verdict>complete|incomplete</verdict>
 *     <confidence>high|medium|low</confidence>
 *     <reasons>- ...\n- ...</reasons>
 *     <missing>- ...</missing>
 *     <evidence>- ...</evidence>
 *     <next_steps>...</next_steps>
 *   </task_completion_review>
 *
 * 找不到块或 verdict 字段非法都返回 null（让调用方走 JSON 兜底）。
 *
 * @param {string} text
 * @returns {import("./types.js").Verdict | null}
 */
function extractVerdictXML(text) {
  // 取最后一组 review 块（前面的分析文字可能也有"审查清单"等字眼但不会带这个标签）
  const blocks = [...text.matchAll(/<task_completion_review>([\s\S]*?)<\/task_completion_review>/g)]
  if (blocks.length === 0) return null
  const block = blocks[blocks.length - 1][1]

  /** @param {string} tag @returns {string} */
  const tagText = (tag) => {
    const m = block.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`))
    return m ? m[1].trim() : ""
  }

  /** @param {string} tag @returns {string[]} */
  const tagList = (tag) => {
    const raw = tagText(tag)
    if (!raw) return []
    return raw
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
      .map((l) => l.replace(/^[-*•]\s*/, ""))
      .filter((l) => l.length > 0)
  }

  const verdict = tagText("verdict").toLowerCase()
  if (verdict !== "complete" && verdict !== "incomplete") return null

  const confidenceRaw = tagText("confidence").toLowerCase()
  const confidence =
    confidenceRaw === "high" || confidenceRaw === "medium" || confidenceRaw === "low" ? confidenceRaw : "medium"

  return {
    verdict,
    confidence,
    reasons: tagList("reasons"),
    missing: tagList("missing"),
    evidence: tagList("evidence"),
    next_steps: tagText("next_steps"),
  }
}

/**
 * 老 JSON 格式判决兜底（pre-v0.2.5 行为）。
 *
 * 顺序：fenced code block ```json ... ``` → 任意 balanced {...}。
 * 都从最后一个开始尝试解析。任何 JSON.parse 错误（包括内嵌引号未转义这类经典
 * LLM 错误）就放弃这条候选；都失败返回 null。
 *
 * @param {string} text
 * @returns {import("./types.js").Verdict | null}
 */
function extractVerdictJsonLegacy(text) {
  const fences = [...text.matchAll(/```json\s*([\s\S]*?)```/g)]
  for (let i = fences.length - 1; i >= 0; i--) {
    try {
      const v = JSON.parse(fences[i][1])
      if (v && (v.verdict === "complete" || v.verdict === "incomplete")) return v
    } catch {}
  }
  const candidates = [...text.matchAll(/\{[\s\S]*?\}/g)]
  for (let i = candidates.length - 1; i >= 0; i--) {
    try {
      const v = JSON.parse(candidates[i][0])
      if (v && (v.verdict === "complete" || v.verdict === "incomplete")) return v
    } catch {}
  }
  return null
}
