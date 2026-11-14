import fs from 'node:fs';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { parseBitfields, parseRegisterHeader } from '../src/lib/datasheet/bitfields.ts';

const doc = await getDocument({ data: new Uint8Array(fs.readFileSync('.samples/rm0008-en.pdf')), useSystemFonts: true, isEvalSupported: false }).promise;
for (const pageNumber of [184, 250]) {
  const page = await doc.getPage(pageNumber);
  const tc = await page.getTextContent();
  const text = tc.items.map((i) => i.str).join(' ').replace(/\s+/g, ' ').trim();
  const rows = parseBitfields(text);
  console.log(`\n=== 第 ${pageNumber} 页：${rows.length} 行 ===`);
  console.log('header:', JSON.stringify(parseRegisterHeader(text)));
  for (const row of rows.slice(0, 6)) console.log(`  [${row.bits}] ${row.name} | ${row.access || '-'} | ${row.heading.slice(0, 70)}`);
}
await doc.destroy();
