import fs from 'node:fs';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { buildLines, detectTables, detectContinuation } from '../src/lib/datasheet/tables.ts';

const pdf = await getDocument({ data: new Uint8Array(fs.readFileSync('.samples/nm25q128.pdf')), useSystemFonts: true, isEvalSupported: false }).promise;
const linesOf = async (p) => {
  const page = await pdf.getPage(p);
  const spans = (await page.getTextContent()).items.filter((i) => i.str && i.str.trim()).map((i) => ({
    text: i.str, x: i.transform[4], y: i.transform[5], width: i.width || 0, height: Math.abs(i.transform[3]) || i.height || 10,
  }));
  return buildLines(spans);
};
const p8 = detectTables(await linesOf(8), 8);
console.log('p8 表:', p8.length, p8.map((t) => `${t.title.slice(0, 20)}/${t.rows.length}行/列${t.columns}/edges ${t.columnEdges?.length ?? 0}`));
const prev = p8.find((t) => t.columnEdges && t.columnEdges.length >= 3);
if (prev) {
  for (const nextPage of [9, 10]) {
    const cont = detectContinuation(await linesOf(nextPage), prev);
    console.log(`续页 ${nextPage}:`, cont ? `${cont.rows.length} 行，表头 ${JSON.stringify(cont.headers)}` : '无');
    if (cont) cont.rows.slice(0, 3).forEach((r) => console.log('   ', r.map((c) => c.slice(0, 18)).join(' ¦ ')));
  }
}
await pdf.destroy();
