// 译文质量防线：OPUS-MT 在异常输入（表格碎片、重复词、超短句）上会进入重复循环，
// 输出"包信息 包信息 包信息…"这种。这里识别退化输出，宁可显示原文 + 提示，也不展示垃圾。

export type QualityVerdict = {
  ok: boolean;
  reason?: "empty" | "repeat-word" | "repeat-phrase" | "question-marks" | "too-short";
};

export function checkTranslation(source: string, output: string): QualityVerdict {
  const trimmed = output.trim();
  if (!trimmed) return { ok: false, reason: "empty" };
  if ((trimmed.match(/\?\?/g) || []).length >= 3) return { ok: false, reason: "question-marks" };

  // 同一片段连续重复（中文两个字起就能看出来；6 字以上重复两次也算）
  if (/(.{2,8}?)\1{2,}/.test(trimmed)) return { ok: false, reason: "repeat-phrase" };
  if (/(.{6,30}?)\1/.test(trimmed.replace(/\s+/g, ""))) return { ok: false, reason: "repeat-phrase" };

  // 字符/双字重复度：OPUS-MT 卡循环时输出会高度重复（"包信息包信息包信息"）
  const compact = trimmed.replace(/\s+/g, "");
  if (compact.length >= 10) {
    const unique = new Set(compact).size;
    if (unique / compact.length < 0.35) return { ok: false, reason: "repeat-phrase" };
    const bigrams = new Map<string, number>();
    for (let index = 0; index < compact.length - 1; index++) {
      const gram = compact.slice(index, index + 2);
      bigrams.set(gram, (bigrams.get(gram) || 0) + 1);
    }
    const maxBigram = Math.max(...bigrams.values()) / Math.max(1, compact.length - 1);
    if (maxBigram > 0.22) return { ok: false, reason: "repeat-phrase" };
  }

  const words = trimmed.split(/\s+/).filter(Boolean);
  if (words.length >= 8) {
    const frequency = new Map<string, number>();
    for (const word of words) frequency.set(word, (frequency.get(word) || 0) + 1);
    const maxRepeat = Math.max(...frequency.values());
    if (maxRepeat / words.length >= 0.35) return { ok: false, reason: "repeat-word" };
  }

  // 译文比原文短太多，通常意味着模型丢了内容
  if (source.trim().length > 60 && trimmed.length < source.trim().length * 0.18) {
    return { ok: false, reason: "too-short" };
  }
  return { ok: true };
}

export const QUALITY_LABEL: Record<NonNullable<QualityVerdict["reason"]>, string> = {
  empty: "模型没有输出",
  "repeat-word": "输出重复",
  "repeat-phrase": "输出重复",
  "question-marks": "占位符丢失",
  "too-short": "输出过短",
};
