// 按坐标还原数据手册里的表格：引脚定义表、电气参数表这一类。
// 输入是文字层的 span（带 x/y/宽高），输出是「表头 + 行 + 单元格」。
// 不依赖模型：表格结构是确定性的，模型只负责把单元格文字译成中文。

export type Span = { text: string; x: number; y: number; width: number; height: number };
export type Cell = { text: string; x: number; width: number };
export type Line = { y: number; height: number; cells: Cell[]; items: Span[] };
export type ParsedTable = {
  id: string;
  page: number;
  title: string;
  headers: string[];
  rows: string[][];
  columns: number;
  bounds?: { x0: number; y0: number; x1: number; y1: number };
  /** 列边界 x 坐标（含最左最右），用于识别下一页的续表。 */
  columnEdges?: number[];
};

/** 把文字层 span 聚成行；同一行内按 x 排序并合并挨得很近的碎片。 */
export function buildLines(spans: Span[]): Line[] {
  const usable = spans
    .filter((span) => span.text && span.text.trim() && span.height > 0)
    .map((span) => ({ ...span, text: span.text.replace(/\s+/g, " ").trim() }))
    .sort((a, b) => b.y - a.y || a.x - b.x);

  const lines: Line[] = [];
  for (const span of usable) {
    const line = lines.find((candidate) => Math.abs(candidate.y - span.y) < Math.max(2, Math.min(candidate.height, span.height) * 0.5));
    if (!line) {
      lines.push({ y: span.y, height: span.height, cells: [{ text: span.text, x: span.x, width: span.width }], items: [span] });
      continue;
    }
    line.height = Math.max(line.height, span.height);
    line.items.push(span);
    const previous = line.cells[line.cells.length - 1];
    const gap = span.x - (previous.x + previous.width);
    if (gap < Math.max(2, span.height * 0.35)) {
      // 同一单元格内的碎片：直接拼接
      previous.text = `${previous.text}${/[\s-]$/.test(previous.text) ? "" : " "}${span.text}`.replace(/\s+/g, " ").trim();
      previous.width = Math.max(previous.width, span.x + span.width - previous.x);
    } else {
      line.cells.push({ text: span.text, x: span.x, width: span.width });
    }
  }
  lines.sort((a, b) => b.y - a.y);
  for (const line of lines) line.cells.sort((a, b) => a.x - b.x);
  return lines;
}

const CORE_HEADER = new Set([
  "pin", "pins", "pin no", "pin no.", "pin number", "pin name", "pin description",
  "symbol", "name", "type", "i/o", "io", "direction", "description", "function",
  "parameter", "conditions", "min", "typ", "max", "unit", "units", "value",
  "ball", "balls", "pad", "pads", "number", "comment", "state",
]);

const HEADER_WORDS = new Set([
  ...CORE_HEADER,
  "buffer", "reset", "comments", "symbols", "min.", "typ.", "max.",
]);

function normalizeCell(text: string) {
  return text.toLowerCase().replace(/[()\s]+/g, " ").trim();
}

function isCoreHeader(cell: string) {
  const normalized = normalizeCell(cell);
  if (CORE_HEADER.has(normalized)) return true;
  // "PIN NO." / "8PIN SOIC" / "DESCRIPTION (1)" 这类
  return /^(?:\d+)?(pin|ball|pad)( no\.?| number| name| description)?$/.test(normalized)
    || /^(vdd|vss|vih|vil|vol|voh|supply|input|output|ground)$/.test(normalized);
}

function headerScore(line: Line) {
  if (line.cells.length < 2 || line.cells.length > 10) return 0;
  // 表头单元格必须是短标签，不能是整句
  if (line.cells.some((cell) => cell.text.length > 26)) return 0;
  let core = 0;
  let weak = 0;
  for (const cell of line.cells) {
    if (!cell.text.trim()) continue;
    if (isCoreHeader(cell.text)) core += 2;
    else if (HEADER_WORDS.has(normalizeCell(cell.text))) weak += 1;
  }
  // 至少两个"像表头"的标签，否则容易把数据行当成表头（DS18B20 第 2 页踩过）
  return core >= 2 ? core + weak : 0;
}

function median(values: number[]) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/** 从一页的行里找出表格。标题取表头上一行（短行）。 */
export function detectTables(lines: Line[], page: number): ParsedTable[] {
  const tables: ParsedTable[] = [];
  const heights = lines.map((line) => line.height).filter((height) => height > 0);
  const baseHeight = median(heights) || 10;

  let index = 0;
  while (index < lines.length) {
    const header = lines[index];
    if (headerScore(header) < 3 || header.cells.length < 2) {
      index += 1;
      continue;
    }

    const columns = header.cells.length;
    // 用表头单元格的“左边缘”划分列：表头文字常居中，用中心会把右侧内容错分到左列
    //（NM25Q128 第 8 页 DESCRIPTION 表头居中在 x=341，但内容从 x=236 开始）。
    const centers = header.cells.map((cell) => cell.x);
    const bounds: number[] = [];
    for (let i = 0; i < centers.length - 1; i++) bounds.push((centers[i] + centers[i + 1]) / 2);

    const rows: string[][] = [];
    let cursor = index + 1;
    let previousY = header.y;
    for (; cursor < lines.length; cursor++) {
      const line = lines[cursor];
      const gap = previousY - line.y;
      if (gap > baseHeight * 3.2) break;
      if (headerScore(line) >= 4) break;
      const onlyCell = line.cells.length === 1;
      const longText = onlyCell && line.cells[0].text.length > 110;
      if (longText && rows.length > 2) break;

      const cells: string[] = new Array(columns).fill("");
      // 用原始 span 逐项分列：行级合并过的 cell 可能把相邻两列并成一个（"CS# Chip Select"）。
      for (const item of line.items) {
        const center = item.x + Math.min(item.width, 120) / 2;
        let column = 0;
        while (column < bounds.length && center > bounds[column]) column += 1;
        const text = item.text.trim();
        if (!text) continue;
        cells[column] = cells[column] ? `${cells[column]} ${text}` : text;
      }
      if (!cells.some((cell) => cell.trim())) { previousY = line.y; continue; }

      // 关键：表格里同一逻辑行往往跨多根文本行（说明换行、符号垂直居中）。
      // 只有最左列出现新内容时才开新行，否则把这一行并到上一行。
      const startsNewRow = cells[0].trim().length > 0 || rows.length === 0;
      if (startsNewRow) {
        rows.push(cells.map((cell) => cell.trim()));
      } else {
        const current = rows[rows.length - 1];
        cells.forEach((cell, column) => {
          if (!cell.trim()) return;
          current[column] = current[column] ? `${current[column]} ${cell.trim()}` : cell.trim();
        });
      }
      previousY = line.y;
      if (rows.length > 80) break;
    }

    if (rows.length >= 2) {
      const titleLine = lines[index - 1];
      const title = titleLine && titleLine.cells.length <= 2
        ? titleLine.cells.map((cell) => cell.text).join(" ").slice(0, 80)
        : "表格";
      const usedLines = lines.slice(index, cursor);
      const xs = usedLines.flatMap((line) => line.items.map((item) => item.x));
      const right = usedLines.flatMap((line) => line.items.map((item) => item.x + item.width));
      tables.push({
        id: `${page}:${index}`,
        page,
        title,
        headers: header.cells.map((cell) => cell.text),
        rows,
        columns,
        bounds: {
          x0: Math.min(...xs) - 4,
          x1: Math.max(...right) + 4,
          y1: Math.max(...usedLines.map((line) => line.y + line.height)) + 4,
          y0: Math.min(...usedLines.map((line) => line.y)) - 4,
        },
        columnEdges: [
          Math.min(...xs) - 4,
          ...bounds,
          Math.max(...right) + 4,
        ],
      });
      index = cursor;
    } else {
      index += 1;
    }
  }
  return tables;
}

/** 电气参数表里常见的占位符/单位，用于给界面加一句提示。 */
export function tableKind(table: ParsedTable): "pin" | "electrical" | "other" {
  const header = table.headers.join(" ").toLowerCase();
  if (/(^|\s)pin|symbol|ball|pad/.test(header) && /description|type|function|i\/o/.test(header)) return "pin";
  if (/min|typ|max|unit|parameter/.test(header)) return "electrical";
  return "other";
}

/** 跨页续表：用上一页表格的表头和列边界，继续解析本页开头的表格行。 */
export function detectContinuation(lines: Line[], previous: ParsedTable): ParsedTable | null {
  const edges = previous.columnEdges;
  if (!edges || edges.length < 3) return null;
  // 只有上一页的表一直画到页底，才可能是跨页续表（否则它在本页就结束了）
  if (!previous.bounds || previous.bounds.y0 > 130) return null;
  const x0 = edges[0];
  const x1 = edges[edges.length - 1];
  const bounds = edges.slice(1, -1);
  const columns = bounds.length + 1;
  const rows: string[][] = [];
  let multiColumnRows = 0;

  for (const line of lines) {
    if (headerScore(line) >= 3) break;
    // 跳过页眉页脚（"RM0008 Rev 21 184/1136" 这类）
    const flat = line.cells.map((cell) => cell.text).join(" ");
    if (/rev\s*\d|\b\d{1,4}\s*\/\s*\d{1,4}\b|机密|confidential|www\./i.test(flat)) continue;

    const cells: string[] = new Array(columns).fill("");
    let filled = 0;
    for (const item of line.items) {
      const center = item.x + Math.min(item.width, 120) / 2;
      if (center < x0 - 8 || center > x1 + 8) continue;
      let column = 0;
      while (column < bounds.length && center > bounds[column]) column += 1;
      cells[column] = cells[column] ? `${cells[column]} ${item.text}` : item.text;
      filled += 1;
    }
    if (!filled) continue;
    if (filled === 1 && cells.join("").length > 110 && rows.length >= 2) break;
    if (filled >= 2) multiColumnRows += 1;
    rows.push(cells.map((cell) => cell.replace(/\s+/g, " ").trim()));
    if (rows.length >= 40) break;
  }

  // 至少要有几行真正是「多列」的表格行，否则只是正文碰巧落在同一 x 区间
  if (rows.length < 3 || multiColumnRows < 3) return null;
  return {
    id: `cont:${previous.id}`,
    page: previous.page + 1,
    title: `续表（接第 ${previous.page} 页的 ${previous.title.slice(0, 24)}）`,
    headers: previous.headers,
    rows,
    columns,
    columnEdges: edges,
  };
}
