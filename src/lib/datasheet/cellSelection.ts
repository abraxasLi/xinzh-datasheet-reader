// 表格里的划词：每个格子（一块文字）单独算一个划词单位。
//
// 为什么要自己处理：PDF.js 的文字层是一堆绝对定位的 span。表格里格子之间、格子周围都是大片空白，
// 鼠标按在空白处时，浏览器找不到最近的文字，会把选区起点放到文字层里很远的位置，
// 结果一拖就把整张表连同下面的段落都选进去（实测 800 多个字）。
// 这里的做法：页面渲染完后把表格行里的每一块文字标成“格子”；按下鼠标时如果落在格子里（或离格子很近的空白处），
// 就由我们自己接管这一次拖选——起点、终点都折算成这个格子里的字符位置，选区永远不出这一格。
// 一个格子可能被 PDF 拆成几段（正文 + 下标 + 正文，如 fPCLK/2），这几段算同一个格子，选区在它们之间连续。
// 全部是版面几何规则，不针对某本手册，也不依赖表头关键词（寄存器表、位表、引脚表、参数表都一样）。

export const CELL_ATTR = "data-table-cell";
export const GROUP_ATTR = "data-cell-group";

type LinePart = { span: HTMLElement; left: number; right: number; fontSize: number };
type LineBox = { top: number; bottom: number; fontSize: number; parts: LinePart[] };

/** 按下的位置离格子多近算“按在这个格子上”（像素）。 */
const REACH_PX = 28;
/** 单独一块文字的行，至少短到这个长度才可能是格子（避免把正文段落的行当成格子）。 */
const MAX_SINGLE_CELL_CHARS = 40;

/** 一行里有多块文字、且块与块之间隔着明显的列间距，就是表格行。 */
function isTabularLine(line: LineBox) {
  if (line.parts.length < 2) return false;
  const columnGap = Math.max(line.fontSize * 1.0, 10);
  for (let index = 1; index < line.parts.length; index += 1) {
    if (line.parts[index].left - line.parts[index - 1].right > columnGap) return true;
  }
  return false;
}

/**
 * 给表格行里的每一块文字打上“格子”标记。lines 要按从上到下排好，每行的 parts 按从左到右排好。
 * 返回被标成格子的 span 数。
 */
export function markTableCells(lines: LineBox[]) {
  const tabular = lines.map(isTabularLine);
  const marked = new Set<HTMLElement>();
  const mark = (part: LinePart) => { part.span.setAttribute(CELL_ATTR, "1"); marked.add(part.span); };
  lines.forEach((line, index) => { if (tabular[index]) line.parts.forEach(mark); });
  // 紧挨着已识别的格子行、且和它的某一列对齐的短文字（如单独一行的 rw、Reserved，或者格子里文字换行后的下一行）也是格子。
  // 换行的格子可能有两三行，所以从表格行开始往上下传递几轮；轮数有限，不会一路蔓延到正文里去。
  const rowIsCells = lines.map((line, index) => tabular[index] && line.parts.length > 0);
  for (let round = 0; round < 3; round += 1) {
    let changed = false;
    lines.forEach((line, index) => {
      if (rowIsCells[index] || line.parts.length !== 1) return;
      const part = line.parts[0];
      if ((part.span.textContent || "").trim().length > MAX_SINGLE_CELL_CHARS) return;
      for (const neighbour of [index - 1, index + 1]) {
        const other = lines[neighbour];
        if (!other || !rowIsCells[neighbour]) continue;
        const gap = neighbour < index ? line.top - other.bottom : other.top - line.bottom;
        if (gap > Math.max(6, line.fontSize * 1.2)) continue;
        const centre = (part.left + part.right) / 2;
        if (other.parts.some((candidate) => Math.abs(candidate.left - part.left) <= 4 || Math.abs((candidate.left + candidate.right) / 2 - centre) <= 4)) {
          mark(part);
          rowIsCells[index] = true;
          changed = true;
          return;
        }
      }
    });
    if (!changed) break;
  }
  groupInlinePieces(lines, marked);
  return marked.size;
}

/**
 * 同一个格子被 PDF 拆成几段：紧挨着（水平间隙很小）、纵向有重叠、且字号明显不同（上下标）的两段文字属于同一个格子。
 * 属于格子的一段带动与它相连的其它段一起标成格子，并给它们同一个分组号。
 * 只有字号不同才合并：挨得很紧的两个同字号格子（如密排的位名）仍然是两个格子。
 */
function groupInlinePieces(lines: LineBox[], marked: Set<HTMLElement>) {
  type Piece = LinePart & { top: number; bottom: number; group: number };
  const pieces: Piece[] = [];
  for (const line of lines) {
    for (const part of line.parts) {
      const rect = part.span.getBoundingClientRect();
      pieces.push({ ...part, top: rect.top, bottom: rect.bottom, group: pieces.length });
    }
  }
  const find = (index: number): number => (pieces[index].group === index ? index : (pieces[index].group = find(pieces[index].group)));
  const sameCell = (a: Piece, b: Piece) => {
    const [first, second] = a.left <= b.left ? [a, b] : [b, a];
    const gap = second.left - first.right;
    if (gap > Math.max(Math.min(a.fontSize, b.fontSize) * 0.6, 4)) return false;
    const overlap = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
    if (overlap < Math.min(a.bottom - a.top, b.bottom - b.top) * 0.4) return false;
    return Math.abs(a.fontSize - b.fontSize) / Math.max(a.fontSize, b.fontSize) > 0.15;
  };
  // 只在“邻近”的块之间找：按水平位置排序后只看后面一小段，避免整页两两比较
  const order = pieces.map((_, index) => index).sort((x, y) => pieces[x].left - pieces[y].left);
  for (let at = 0; at < order.length; at += 1) {
    for (let next = at + 1; next < order.length && next <= at + 12; next += 1) {
      const a = pieces[order[at]];
      const b = pieces[order[next]];
      if (b.left - a.right > Math.max(a.fontSize, b.fontSize)) { if (b.left > a.right + 40) break; continue; }
      if (sameCell(a, b)) pieces[find(order[next])].group = find(order[at]);
    }
  }
  const members = new Map<number, Piece[]>();
  pieces.forEach((piece, index) => {
    const root = find(index);
    if (!members.has(root)) members.set(root, []);
    members.get(root)!.push(piece);
  });
  let groupId = 0;
  for (const group of members.values()) {
    if (group.length < 2 || !group.some((piece) => marked.has(piece.span))) continue;
    groupId += 1;
    for (const piece of group) {
      piece.span.setAttribute(CELL_ATTR, "1");
      piece.span.setAttribute(GROUP_ATTR, String(groupId));
      marked.add(piece.span);
    }
  }
}

function distanceToRect(rect: DOMRect, x: number, y: number) {
  const dx = Math.max(rect.left - x, 0, x - rect.right);
  const dy = Math.max(rect.top - y, 0, y - rect.bottom);
  return Math.hypot(dx, dy);
}

/**
 * 找“按在哪个格子上”：整个文字层里离鼠标最近的那块文字，必须是格子，且离得不远。
 * 最近的是正文（不是格子）就返回 null，让浏览器按原来的方式处理，不改正文的划词。
 */
export function cellAtPoint(layer: Element, x: number, y: number): HTMLElement | null {
  let nearest: HTMLElement | null = null;
  let best = Infinity;
  for (const span of layer.querySelectorAll<HTMLElement>("span")) {
    if (!span.textContent?.trim()) continue;
    const distance = distanceToRect(span.getBoundingClientRect(), x, y);
    if (distance < best) { best = distance; nearest = span; }
  }
  return nearest && best <= REACH_PX && nearest.hasAttribute(CELL_ATTR) ? nearest : null;
}

export function firstTextNode(element: HTMLElement): Text | null {
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  return walker.nextNode() as Text | null;
}

/** 把横向位置折算成文字节点里的字符位置：按每个字符的中点二分，落在格子外就取到两端。 */
export function charOffsetAt(node: Text, x: number): number {
  const range = document.createRange();
  let low = 0;
  let high = node.data.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    range.setStart(node, middle);
    range.setEnd(node, middle + 1);
    const rect = range.getBoundingClientRect();
    if (x < rect.left + rect.width / 2) high = middle; else low = middle + 1;
  }
  return low;
}

type Piece = { span: HTMLElement; node: Text; left: number; right: number };

/** 一个格子由哪几段文字组成（从左到右）。几段在 DOM 里不是连续相邻的，就只算按下的那一段，免得选区把别的格子也带进去。 */
function piecesOfCell(layer: Element, span: HTMLElement): Piece[] {
  const single = (): Piece[] => {
    const node = firstTextNode(span);
    const rect = span.getBoundingClientRect();
    return node ? [{ span, node, left: rect.left, right: rect.right }] : [];
  };
  const group = span.getAttribute(GROUP_ATTR);
  if (!group) return single();
  const members = [...layer.querySelectorAll<HTMLElement>(`[${GROUP_ATTR}="${group}"]`)]
    .map((member) => ({ member, rect: member.getBoundingClientRect() }))
    .sort((a, b) => a.rect.left - b.rect.left);
  // 按从左到右排好的这几段，在 DOM 里必须一个紧挨着一个（中间只允许换行占位元素）
  for (let index = 0; index + 1 < members.length; index += 1) {
    let next = members[index].member.nextElementSibling;
    while (next && next.tagName === "BR") next = next.nextElementSibling;
    if (next !== members[index + 1].member) return single();
  }
  const pieces: Piece[] = [];
  for (const { member, rect } of members) {
    const node = firstTextNode(member);
    if (node) pieces.push({ span: member, node, left: rect.left, right: rect.right });
  }
  return pieces.length ? pieces : single();
}

/** 横向位置 → 这个格子里的 (文字节点, 字符位置)：落在哪一段里就用哪一段，落在段与段之间或格子外就取最近的一段并夹到两端。 */
function positionInCell(pieces: Piece[], x: number): { node: Text; offset: number; order: number } {
  let chosen = 0;
  let best = Infinity;
  pieces.forEach((piece, index) => {
    const distance = Math.max(piece.left - x, 0, x - piece.right);
    if (distance < best) { best = distance; chosen = index; }
  });
  const piece = pieces[chosen];
  return { node: piece.node, offset: charOffsetAt(piece.node, x), order: chosen };
}

export type CellDrag = { pieces: Piece[]; anchor: { node: Text; offset: number; order: number } };

/** 鼠标按下：落在格子里就接管这次拖选，返回拖选状态；不是格子返回 null（交给浏览器）。 */
export function beginCellDrag(event: MouseEvent): CellDrag | null {
  if (event.button !== 0 || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return null;
  const layer = (event.target as Element | null)?.closest?.(".textLayer");
  if (!layer) return null;
  const span = cellAtPoint(layer, event.clientX, event.clientY);
  if (!span) return null;
  const pieces = piecesOfCell(layer, span);
  if (!pieces.length) return null;
  // 阻止浏览器自己找选区起点（这正是选中一大片的原因）；双击、三击也一样不会再选中整词、整行。
  event.preventDefault();
  window.getSelection()?.removeAllRanges();
  return { pieces, anchor: positionInCell(pieces, event.clientX) };
}

/** 拖动中：选区 = 这个格子里，从起点字符到当前鼠标横向位置对应的字符。纵向位置不参与，所以不会跨行。 */
export function updateCellDrag(drag: CellDrag, event: MouseEvent) {
  const selection = window.getSelection();
  if (!selection) return;
  const focus = positionInCell(drag.pieces, event.clientX);
  if (focus.node === drag.anchor.node && focus.offset === drag.anchor.offset) selection.removeAllRanges();
  else selection.setBaseAndExtent(drag.anchor.node, drag.anchor.offset, focus.node, focus.offset);
}
