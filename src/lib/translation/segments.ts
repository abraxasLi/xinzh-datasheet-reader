// 跟随译读“中英对照”用：把一段 PDF 正文切成「一句一句」，每句原文保留它在 PDF 里的换行，
// 送翻时按句送，译回来一句中文对一句原文。只处理普通正文段落；表格、寄存器位表、图不在这里处理。
// 规则全部通用，不针对某本手册。

export type SegmentKind = "heading" | "bullet" | "sentence";

export type Segment = {
  /** 原文，保留 PDF 里的换行（\n），显示用 */
  source: string;
  /** 送翻文本：换行换成空格、去掉行首圆点 */
  mt: string;
  kind: SegmentKind;
  /** 这一条在 PDF 里是另起一行开始的（标题之后、列表项）：拼整段译文时前面换行 */
  breakBefore: boolean;
};

/** 一次请求最多送 24 条（/api/translate 的上限）。 */
export const MAX_SEGMENTS = 24;

// PDF 里 Symbol / Wingdings 字体的列表圆点落在私用区，直接显示是方块，按 PDF 上看到的样子换成 •。
const PRIVATE_BULLETS = new RegExp(`[${[0xf0b7, 0xf0a7, 0xf06c, 0xf076, 0xf0d8, 0xf0fc, 0xf0a8].map((code) => String.fromCharCode(code)).join("")}]`, "g");
const BULLET_LINE = /^\s*[•▪◦‣∙●○■□–—-]\s+/;
// 句点后面不切的缩写
const ABBREVIATION = /(?:^|[\s(])(?:e\.g|i\.e|etc|vs|approx|incl|resp|max|min|typ|no|nos|fig|figs|ref|refs|rev|sect|sec|ch|vol|cf|al|Mr|Ms|Dr)\.$/i;
// 句末：. ! ? 后面跟空白，再跟大写字母 / 数字 / 括号 / 引号 / 圆点
const SENTENCE_END = /[.!?](?=\s+["“(\[]?[A-Z0-9•])/g;

/** 把私用区圆点换成 •，供原文显示和送翻共用。 */
export function normalizeGlyphs(text: string): string {
  return text.replace(PRIVATE_BULLETS, "•");
}

function wordCount(line: string) {
  return line.trim().split(/\s+/).filter(Boolean).length;
}

/** 段首短行、无句末标点、后面还有内容 → 视为小标题。 */
function looksLikeHeading(line: string, hasNext: boolean) {
  const trimmed = line.trim();
  if (!hasNext || !trimmed) return false;
  if (BULLET_LINE.test(trimmed)) return false;
  if (/[.:;,!?]$/.test(trimmed)) return false;
  if (!/^[A-Z0-9]/.test(trimmed)) return false;
  return wordCount(trimmed) <= 6;
}

/** 先按“另起一行”的硬边界（标题、列表项）分块；块内仍保留 PDF 换行。 */
function splitBlocks(text: string): { text: string; kind: SegmentKind; breakBefore: boolean }[] {
  const lines = text.split("\n");
  const blocks: { text: string; kind: SegmentKind; breakBefore: boolean }[] = [];
  let current: { lines: string[]; kind: SegmentKind; breakBefore: boolean } | null = null;
  const flush = () => {
    if (current && current.lines.join("").trim()) blocks.push({ text: current.lines.join("\n"), kind: current.kind, breakBefore: current.breakBefore });
    current = null;
  };
  lines.forEach((line, index) => {
    const blockStart = current === null;
    if (BULLET_LINE.test(line)) {
      flush();
      current = { lines: [line], kind: "bullet", breakBefore: blocks.length > 0 };
      return;
    }
    if (blockStart && looksLikeHeading(line, index < lines.length - 1)) {
      blocks.push({ text: line, kind: "heading", breakBefore: blocks.length > 0 });
      return;
    }
    // 列表项以句号结束、下一行大写开头：列表已经结束，下一行是另起的正文，不再接在列表项后面。
    const previousLine = current?.lines.at(-1) ?? "";
    if (current?.kind === "bullet" && /[.!?]\s*$/.test(previousLine) && /^\s*[A-Z]/.test(line)) flush();
    if (current === null) current = { lines: [], kind: "sentence", breakBefore: blocks.length > 0 };
    current.lines.push(line);
    // 一行以句末标点结束、下一行像小标题时，让下一行有机会被识别为标题。
    if (/[.:!?]\s*$/.test(line) && index + 1 < lines.length && looksLikeHeading(lines[index + 1], index + 2 < lines.length)) flush();
  });
  flush();
  return blocks;
}

/** 块内按句末标点切句，切点处的空白（可能含换行）不保留在任一句里。 */
function splitSentences(block: string): string[] {
  const sentences: string[] = [];
  let start = 0;
  for (const match of block.matchAll(SENTENCE_END)) {
    const end = (match.index ?? 0) + 1;
    const piece = block.slice(start, end);
    if (ABBREVIATION.test(piece.trimEnd())) continue;
    if (piece.trim().length < 2) continue;
    sentences.push(piece);
    start = end;
  }
  sentences.push(block.slice(start));
  return sentences.map((sentence) => sentence.replace(/^\s*\n|\n\s*$/g, "").replace(/^[ \t]+|[ \t]+$/g, "")).filter((sentence) => sentence.trim());
}

function toMt(source: string, kind: SegmentKind) {
  const flat = source.replace(/\s*\n\s*/g, " ").replace(/[ \t]{2,}/g, " ").trim();
  return kind === "bullet" ? flat.replace(BULLET_LINE, "") : flat;
}

/** 把一段 PDF 正文切成句子级的对照单元。 */
export function segmentParagraph(paragraph: string): Segment[] {
  const text = normalizeGlyphs(paragraph).replace(/\r/g, "");
  const segments: Segment[] = [];
  for (const block of splitBlocks(text)) {
    if (block.kind === "heading") {
      segments.push({ source: block.text.trim(), mt: toMt(block.text, "heading"), kind: "heading", breakBefore: block.breakBefore });
      continue;
    }
    splitSentences(block.text).forEach((sentence, index) => {
      const kind: SegmentKind = block.kind === "bullet" && index === 0 ? "bullet" : "sentence";
      segments.push({ source: sentence, mt: toMt(sentence, kind), kind, breakBefore: index === 0 ? block.breakBefore : false });
    });
  }
  return capSegments(segments);
}

/** 超过一次请求的上限时，相邻句子两两（或多句）合并，仍然一一对得上。 */
function capSegments(segments: Segment[]): Segment[] {
  if (segments.length <= MAX_SEGMENTS) return segments;
  const size = Math.ceil(segments.length / MAX_SEGMENTS);
  const merged: Segment[] = [];
  for (let index = 0; index < segments.length; index += size) {
    const group = segments.slice(index, index + size);
    merged.push({
      source: group.map((segment, at) => (at > 0 && segment.breakBefore ? "\n" : at > 0 ? " " : "") + segment.source).join(""),
      mt: group.map((segment) => segment.mt).join(" "),
      kind: group[0].kind,
      breakBefore: group[0].breakBefore,
    });
  }
  return merged;
}

/** 按句译文拼回整段：另起一行的条目前面换行，其余句子直接接上（中文句间不加空格）。 */
export function joinTranslations(segments: Segment[], translations: string[]): string {
  return segments.map((segment, index) => {
    const text = (segment.kind === "bullet" ? "• " : "") + (translations[index] || "").trim();
    return (index > 0 && segment.breakBefore ? "\n" : "") + text;
  }).join("");
}
