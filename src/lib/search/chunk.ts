// 把整本手册的逐页文字切成"一节 / 一个寄存器"一段，而不是整页。
// 每段记好页码、章节、寄存器名、所属手册。纯确定性，不调用任何模型。

export type Chunk = {
  id: string;
  doc: string;
  page: number;
  section: string;
  register: string;
  text: string;
};

const MAX_CHARS = 1600;
const MIN_CHARS = 160;

const REGISTER_HEADING = /(?:^|\s)(\d+(?:\.\d+){1,4})\s+([^.()]{3,140}?)\s*\(\s*([A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)+)\s*\)/g;
const SECTION_HEADING = /(?:^|\s)(\d+(?:\.\d+){1,3})\s+([A-Z][A-Za-z0-9 ,()/-]{3,90})/g;

type Boundary = { index: number; section: string; register: string };

function isContentsPage(text: string) {
  return /table of contents|list of (?:tables|figures)/i.test(text.slice(0, 600)) || (text.match(/(?:\.\s?){6,}/g) || []).length > 3;
}

function pageOf(offsets: number[], index: number) {
  let low = 0;
  let high = offsets.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (offsets[mid] <= index) low = mid; else high = mid - 1;
  }
  return low + 1;
}

function splitLong(text: string): string[] {
  if (text.length <= MAX_CHARS) return [text];
  const parts: string[] = [];
  let rest = text;
  while (rest.length > MAX_CHARS) {
    const window = rest.slice(0, MAX_CHARS);
    const cut = Math.max(window.lastIndexOf(". "), window.lastIndexOf("; "));
    const at = cut > MAX_CHARS * 0.5 ? cut + 1 : MAX_CHARS;
    parts.push(rest.slice(0, at).trim());
    rest = rest.slice(at).trim();
  }
  if (rest) parts.push(rest);
  return parts;
}

export function chunkDocument(pages: string[], docName: string): Chunk[] {
  const offsets: number[] = [];
  const skip: boolean[] = [];
  let full = "";
  pages.forEach((text) => {
    offsets.push(full.length);
    skip.push(isContentsPage(text));
    // 目录/索引页只占位不入索引：否则页码点线会被当成正文，还会被并进前一小节。
    full += (skip[skip.length - 1] ? "" : text) + "\n";
  });

  const boundaries: Boundary[] = [];
  for (const match of full.matchAll(REGISTER_HEADING)) {
    const index = (match.index ?? 0) + (match[0].length - match[0].trimStart().length);
    if (skip[pageOf(offsets, index) - 1]) continue;
    if (!/Address(?:\s+offset)?\s*:/i.test(full.slice(index, index + 900))) continue;
    boundaries.push({ index, section: `${match[1]} ${match[2].trim()} (${match[3]})`, register: match[3] });
  }
  for (const match of full.matchAll(SECTION_HEADING)) {
    const index = (match.index ?? 0) + (match[0].length - match[0].trimStart().length);
    if (skip[pageOf(offsets, index) - 1]) continue;
    if (boundaries.some((item) => Math.abs(item.index - index) < 4)) continue;
    boundaries.push({ index, section: `${match[1]} ${match[2].trim()}`, register: "" });
  }
  boundaries.sort((a, b) => a.index - b.index);
  if (!boundaries.length || boundaries[0].index > 0) boundaries.unshift({ index: 0, section: "", register: "" });

  const chunks: Chunk[] = [];
  let currentSection = "";
  let pending: { page: number; section: string; register: string; text: string } | null = null;
  // 长小节会跨好几页再被切成几段：每一段要按它自己开头那句话去找实际所在页，不能都记成小节起始页。
  // （否则卡片写“第 N 页”，跳过去却找不到那句话。）
  const normalizedPages = pages.map((text) => text.replace(/\s+/g, " "));
  const actualPage = (part: string, fromPage: number) => {
    for (const length of [60, 30]) {
      const opening = part.slice(0, length);
      if (opening.length < 12) break;
      for (let page = fromPage; page <= Math.min(pages.length, fromPage + 12); page += 1) {
        if (normalizedPages[page - 1].includes(opening)) return page;
      }
    }
    return fromPage;
  };
  const flush = () => {
    if (!pending) return;
    let page = pending.page;
    for (const part of splitLong(pending.text)) {
      page = actualPage(part, page);
      if (part.length < 20) continue;
      chunks.push({ id: `c${chunks.length}`, doc: docName, page, section: pending.section, register: pending.register, text: part });
    }
    pending = null;
  };

  boundaries.forEach((boundary, order) => {
    const end = order + 1 < boundaries.length ? boundaries[order + 1].index : full.length;
    const text = full.slice(boundary.index, end).replace(/\s+/g, " ").trim();
    if (boundary.section) currentSection = boundary.section;
    if (!text) return;
    const page = pageOf(offsets, boundary.index);
    // 太短的小节并入前一段，避免只有标题的碎片；寄存器定义始终单独成段。
    if (pending && !boundary.register && pending.text.length < MIN_CHARS) {
      pending.text += " " + text;
      return;
    }
    flush();
    pending = { page, section: boundary.section || currentSection, register: boundary.register, text };
  });
  flush();
  return chunks;
}
