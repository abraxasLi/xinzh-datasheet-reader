// 表格解析自测：用真实 PDF 的文字层坐标跑 detectTables。
// 用法: node tools/test-tables.mjs
import fs from 'node:fs';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { buildLines, detectTables, tableKind } from '../src/lib/datasheet/tables.ts';

const DOCS = [
  { file: 'ds18b20.pdf', pages: [2, 3, 4] },
  { file: 'nm25q128.pdf', pages: [7, 8, 9, 10, 11, 12, 13] },
  { file: 'ili9341.pdf', pages: [20, 21, 22, 23] },
  { file: 'rm0008-en.pdf', pages: [184, 250] },
];

for (const doc of DOCS) {
  const pdf = await getDocument({ data: new Uint8Array(fs.readFileSync(`.samples/${doc.file}`)), useSystemFonts: true, isEvalSupported: false }).promise;
  for (const pageNumber of doc.pages) {
    if (pageNumber > pdf.numPages) continue;
    const page = await pdf.getPage(pageNumber);
    const tc = await page.getTextContent();
    const spans = tc.items
      .filter((item) => item.str && item.str.trim())
      .map((item) => ({
        text: item.str,
        x: item.transform[4],
        y: item.transform[5],
        width: item.width || 0,
        height: Math.abs(item.transform[3]) || item.height || 10,
      }));
    const tables = detectTables(buildLines(spans), pageNumber);
    if (!tables.length) continue;
    console.log(`\n=== ${doc.file} p${pageNumber}：${tables.length} 个表 ===`);
    for (const table of tables.slice(0, 2)) {
      console.log(`  [${tableKind(table)}] ${table.title} | 列=${table.headers.join(" | ")} | 行=${table.rows.length}`);
      table.rows.slice(0, 3).forEach((row) => console.log("    " + row.map((cell) => cell.slice(0, 26)).join(" ¦ ")));
    }
  }
  await pdf.destroy();
}
