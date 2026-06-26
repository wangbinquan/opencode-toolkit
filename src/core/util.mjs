/**
 * 平台无关的小工具。被 core 与各宿主 adapter 的 transcript 解析共用。
 *
 * **铁律**：core/ 下的文件不许 import 任何宿主 SDK（@opencode-ai/* 或 Claude
 * 相关），保持纯 JS + node 内置，这样 opencode（吃 .ts）与 claude（裸 .mjs hook）
 * 都能零编译直接 import。
 */

/**
 * 把超长文本截断到 max 字符，尾部标注被截掉多少。
 * @param {string} text
 * @param {number} max
 * @returns {string}
 */
export function clip(text, max) {
  if (text.length <= max) return text
  return text.slice(0, max) + `\n…(${text.length - max} chars truncated)`
}
