// 从 PDF 文字层的段落里还原位域表结构。
// RM0008 这类寄存器章节的位域描述是固定格式：
//   Bits 26:24 SWJ_CFG[2:0]: Serial wire JTAG configuration
//   These bits are write-only (when read, the value is undefined)...
//   Bits 31:27 Reserved
// 这里把「位段 / 名称 / 说明 / 读写属性」拆出来，界面据此生成中文表格。
// 不依赖任何模型：结构解析是确定性的，模型只负责把说明译成中文。

export type BitfieldRow = {
  id: string;
  bits: string;          // "26:24" / "15" / "31:27"
  high: number;
  low: number;
  name: string;          // "SWJ_CFG[2:0]" / "ADC3RST" / "Reserved"
  heading: string;       // 冒号前的英文标题
  description: string;   // 冒号后的英文说明（含 0/1 取值）
  access: string | null; // "只写" / "只读" / "读写" / null
};

const MARKER = /(?:^|[\s;.])(Bits?\s+\d+(?:\s*:\s*\d+)?)\s+/g;

function accessOf(text: string): string | null {
  if (/\bwrite-only\b/i.test(text)) return "只写";
  if (/\bread-only\b/i.test(text)) return "只读";
  if (/\bread\/write\b|\bread-write\b/i.test(text)) return "读写";
  return null;
}

/** 解析一页文字（多段用空格拼接），返回位域行。 */
export function parseBitfields(pageText: string): BitfieldRow[] {
  const text = pageText.replace(/\s+/g, " ").trim();
  const markers: { index: number; label: string; header: string }[] = [];
  for (const match of text.matchAll(MARKER)) {
    markers.push({ index: match.index ?? 0, label: match[1], header: match[0] });
  }
  const rows: BitfieldRow[] = [];
  for (const [index, marker] of markers.entries()) {
    const start = marker.index + marker.header.length;
    const end = index + 1 < markers.length ? markers[index + 1].index : text.length;
    const body = text.slice(start, end).trim();
    if (!body) continue;

    const range = marker.label.replace(/^Bits?\s+/i, "").split(":").map((part) => Number.parseInt(part.trim(), 10));
    const high = range[0];
    const low = range.length > 1 ? range[1] : range[0];
    if (!Number.isFinite(high) || !Number.isFinite(low)) continue;

    // 名称：形如 SWJ_CFG[2:0]: 或 ADC3RST: 的冒号前标识符。
    // 注意位域名自带方括号和冒号（JSQ4[4:0]:），不能直接用 indexOf(":")。
    let name = "";
    let rest = body;
    const named = body.match(/^([A-Za-z][A-Za-z0-9_]*(?:\[\d+(?::\d+)?\])?)\s*:\s*/);
    if (named) {
      name = named[1];
      rest = body.slice(named[0].length);
    } else if (/^Reserved\b/i.test(body)) {
      name = "Reserved";
      rest = body.replace(/^Reserved\s*[,.;:]?\s*/i, "");
    } else {
      const firstToken = body.split(/\s+/)[0] || "";
      if (/^[A-Za-z][A-Za-z0-9_]*(?:\[\d+(?::\d+)?\])?$/.test(firstToken) && !/^(These|This|It|The|When)\b/i.test(firstToken)) {
        name = firstToken;
        rest = body.slice(firstToken.length).trim();
      }
    }

    const description = rest.replace(/^[,;:.\s]+/, "").replace(/\s+/g, " ").trim();
    rows.push({
      id: `${high}:${low}:${name || index}`,
      bits: high === low ? String(high) : `${high}:${low}`,
      high,
      low,
      name: name || "—",
      heading: description.split(/[.;]/)[0]?.trim() || description,
      description,
      access: accessOf(`${name} ${description}`),
    });
  }
  return rows;
}

/** 从页面文字里顺手取出寄存器标题、地址偏移和复位值（有就返回）。 */
export function parseRegisterHeader(pageText: string) {
  const text = pageText.replace(/\s+/g, " ").trim();
  const register = text.match(/^.*?\b([A-Z][A-Za-z0-9_]*_[A-Za-z0-9_]+)\b/);
  const offset = text.match(/Address offset:\s*(0x[0-9A-Fa-f]+)/i);
  const reset = text.match(/Reset value:\s*(0x[0-9A-Fa-f]{1,8}(?:\s[0-9A-Fa-f]{1,8})?)/i);
  return {
    register: register?.[1] || null,
    offset: offset?.[1] || null,
    reset: reset?.[1]?.trim() || null,
  };
}
