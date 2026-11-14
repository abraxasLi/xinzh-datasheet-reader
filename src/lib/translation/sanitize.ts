// 送翻前的文本清洗与"垃圾页"判定。
// 数据手册的目录/索引页充满点线和页码，直接送进翻译模型会诱发幻觉
//（实测 NM25Q128 的目录行被译成"诸法性相. 皆有四谛."）。这里先挡掉。

export type Sanitized = {
  text: string;
  skip: boolean;
  reason?: "toc" | "page-number" | "punctuation" | "too-short";
};

const DOT_LEADER = /\.{3,}/g;

export function sanitizeParagraph(input: string): Sanitized {
  const normalized = input.replace(/\s+/g, " ").trim();
  if (!normalized) return { text: "", skip: true, reason: "too-short" };

  const letters = (normalized.match(/[A-Za-z]/g) || []).length;
  const dots = (normalized.match(/\./g) || []).length;
  const digits = (normalized.match(/\d/g) || []).length;
  const spaces = (normalized.match(/\s/g) || []).length;
  const significant = Math.max(1, normalized.length - spaces);

  // 目录行：点线 + 页码结尾
  if (/\.{3,}\s*\d+\s*$/.test(normalized) || (dots >= 6 && dots / significant > 0.2)) {
    return { text: normalized, skip: true, reason: "toc" };
  }
  // 纯页码 / 纯数字行
  if (/^[\d\s./\-–—]+$/.test(normalized)) {
    return { text: normalized, skip: true, reason: "page-number" };
  }
  // 标点占比过高（表格残片、点线混合）
  if (dots / significant > 0.35 || digits / significant > 0.6) {
    return { text: normalized, skip: true, reason: "punctuation" };
  }
  // 没有足够英文内容：只挡掉 1–3 个字母的碎片（rw、0 这类），
  // 不能挡掉 "Tamper"、"SCLK" 这种用户主动选中的单词/单元格。
  if (letters < 4) {
    return { text: normalized, skip: true, reason: "too-short" };
  }

  // 清洗：把点线折叠掉，丢掉页眉页脚里的 "123/456" 页码
  const cleaned = normalized
    .replace(DOT_LEADER, " ")
    .replace(/\b\d{1,4}\s*\/\s*\d{1,4}\b/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();

  return { text: cleaned, skip: false };
}

export const SKIP_LABEL: Record<NonNullable<Sanitized["reason"]>, string> = {
  toc: "目录/索引行，未翻译",
  "page-number": "页码行，未翻译",
  punctuation: "表格残片，未翻译",
  "too-short": "内容过短，未翻译",
};

/**
 * 数据手册里大量使用全大写（TEMPERATURE CONVERSION COMMAND）。
 * OPUS-MT 这类模型对全大写输入几乎不出中文，会吐"电磁交流电 指挥反射 狂犬病"这种。
 * 送翻前统一降成句首大写；占位符 [[Z0]] 不受影响（还原时大小写不敏感）。
 */
export function decapitalizeForModel(text: string): string {
  const letters = (text.match(/[A-Za-z]/g) || []).length;
  if (letters < 10) return text;
  const upper = (text.match(/[A-Z]/g) || []).length;
  if (upper / letters < 0.65) return text;
  const lowered = text.toLowerCase();
  return lowered.charAt(0).toUpperCase() + lowered.slice(1);
}
