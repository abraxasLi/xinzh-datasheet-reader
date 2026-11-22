// 从手册自己的页眉/章节标题里抽取「英文标题 (缩写)」，作为查询改写的领域词表。
// 通用：不含任何具体手册的内容，换一本手册就换一份词表。
// 例：某页页眉写着 "Xxx controller (XXXC) …"，就会得到 "Xxx controller (XXXC)"。

const HEAD_CHARS = 140;
const MAX_ENTRIES = 140;
const TITLE_WITH_ABBR = /([A-Z][A-Za-z0-9/&,'’ -]{2,70}?)\s*\(\s*([A-Z][A-Za-z0-9]{1,11}(?: and [A-Z][A-Za-z0-9]{1,11})?)\s*\)/g;
// 页眉里标题前常粘着“文档号 / 版本 / 页码 / 章节号”（形如 "XX0000 Rev 3 12/900 XX0000"）。
const HEADER_NOISE = /\b[A-Z]{1,4}\d{3,6}\b|\bRev\s*\d+\b|\b\d+\/\d+\b|^\d+(?:\.\d+)*\s/;

export function buildOutline(pages: string[]): string[] {
  const seen = new Map<string, { title: string; abbr: string; pages: number }>();
  for (const text of pages) {
    const head = text.slice(0, HEAD_CHARS);
    for (const match of head.matchAll(TITLE_WITH_ABBR)) {
      // 取最后一个噪声记号之后的部分当标题。
      const title = match[1].split(HEADER_NOISE).pop()!.trim();
      const abbr = match[2];
      if (title.length < 3) continue;
      const key = abbr.toLowerCase();
      const entry = seen.get(key);
      if (entry) entry.pages += 1;
      else seen.set(key, { title, abbr, pages: 1 });
    }
  }
  // 出现在多页页眉里的才是章节/外设名（页眉会在整章重复），偶发的括号不算。
  return [...seen.values()]
    .filter((entry) => entry.pages >= 2)
    .sort((a, b) => b.pages - a.pages)
    .slice(0, MAX_ENTRIES)
    .map((entry) => `${entry.title} (${entry.abbr})`);
}
