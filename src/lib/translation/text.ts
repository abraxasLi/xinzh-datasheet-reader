export function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 归一化 PDF 文字层常见的断行、连字符和多余空白。 */
export function normalizeText(value: string) {
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/\u00ad/g, "")
    .replace(/([a-z])-\n([a-z])/g, "$1$2")
    .replace(/[\t\u00a0]+/g, " ")
    .replace(/ {2,}/g, " ")
    .trim();
}
