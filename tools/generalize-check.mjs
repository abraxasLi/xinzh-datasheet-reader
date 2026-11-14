// 泛化检查：拿别的数据手册走同一条流水线，看哪些能力还行、哪些会退化。
// 检查项：文字层可用性、位域表解析、段落翻译、中文检索命中。
// 用法: node tools/generalize-check.mjs
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { parseBitfields, parseRegisterHeader } from '../src/lib/datasheet/bitfields.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DOCS = ['rm0008-en.pdf', 'rm0008-v20.pdf', 'ili9341.pdf', 'nm25q128.pdf', 'ds18b20.pdf'];
const PYTHON = process.env.XINZH_PYTHON || 'python';
const MODEL_DIR = (() => {
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return null;
    if (fs.existsSync(path.join(dir, 'model.bin'))) return dir;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) { const hit = walk(path.join(dir, entry.name)); if (hit) return hit; }
    }
    return null;
  };
  return walk(path.join(ROOT, 'models', 'argos-en-zh'));
})();

function groupText(tc) {
  // 粗粒度：按行聚合，再按间距分段（与阅读器同思路的简化版）
  const items = tc.items.filter((i) => i.str && i.str.trim()).map((i) => ({
    text: i.str, x: i.transform[4], y: i.transform[5], w: i.width || 0, h: Math.abs(i.transform[3]) || i.height || 10,
  })).sort((a, b) => b.y - a.y || a.x - b.x);
  const lines = [];
  for (const item of items) {
    const line = lines.find((l) => Math.abs(l.y - item.y) < Math.max(2, Math.min(l.h, item.h) * 0.45));
    if (line) { line.items.push(item); line.h = Math.max(line.h, item.h); }
    else lines.push({ y: item.y, h: item.h, items: [item] });
  }
  lines.sort((a, b) => b.y - a.y);
  for (const line of lines) {
    line.items.sort((a, b) => a.x - b.x);
    line.text = line.items.reduce((t, it, i) => {
      if (i === 0) return it.text;
      const prev = line.items[i - 1];
      const gap = it.x - (prev.x + prev.w);
      return t + (gap > Math.min(it.h, prev.h) * 0.2 && !/^[,.;:!?%)\]}]/.test(it.text) ? ' ' : '') + it.text;
    }, '').replace(/\s+/g, ' ').trim();
  }
  return lines.map((l) => l.text).filter(Boolean);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)); });
  });
}

async function startEngine() {
  const port = await freePort();
  const child = spawn(PYTHON, ['-X', 'utf8', path.join(ROOT, 'runtime', 'translate_server.py'), '--model-dir', MODEL_DIR, '--port', String(port)], {
    env: { ...process.env, PYTHONPATH: path.join(ROOT, '.runtime'), PYTHONIOENCODING: 'utf-8' },
    stdio: 'ignore', windowsHide: true,
  });
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    try { if ((await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) })).ok) return { port, child }; } catch { /* 等待 */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  child.kill();
  throw new Error('翻译服务启动超时');
}

console.log('启动本机翻译服务…');
const engine = await startEngine();

const summary = [];
for (const file of DOCS) {
  const pdfPath = path.join(ROOT, '.samples', file);
  if (!fs.existsSync(pdfPath)) continue;
  const doc = await getDocument({ data: new Uint8Array(fs.readFileSync(pdfPath)), useSystemFonts: true, isEvalSupported: false }).promise;
  const pages = Math.min(doc.numPages, 60);
  let chars = 0;
  let items = 0;
  let bitfieldRows = 0;
  let registerPages = 0;
  const samples = [];
  const seen = new Set();

  for (let pageNumber = 1; pageNumber <= pages; pageNumber++) {
    const page = await doc.getPage(pageNumber);
    const tc = await page.getTextContent();
    items += tc.items.length;
    const text = tc.items.map((i) => i.str).join(' ');
    chars += text.replace(/\s+/g, ' ').trim().length;
    const lines = groupText(tc);
    if (text.length < 40) continue;

    const rows = parseBitfields(lines.join(' '));
    if (rows.length >= 2) { bitfieldRows += rows.length; registerPages++; }
    if (rows.length >= 2) {
      const header = parseRegisterHeader(lines.join(' '));
      if (!seen.has(header.register || pageNumber)) {
        seen.add(header.register || pageNumber);
        const description = rows.find((row) => row.description.length > 60)?.description;
        if (description && samples.length < 2) samples.push({ page: pageNumber, register: header.register, text: description.slice(0, 320) });
      }
    }
  }
  await doc.destroy();

  let translations = [];
  if (samples.length) {
    const response = await fetch(`http://127.0.0.1:${engine.port}/translate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ texts: samples.map((s) => s.text) }),
    });
    translations = (await response.json()).items || [];
  }

  const perPageChars = Math.round(chars / pages);
  summary.push({ file, pages: doc.numPages, perPageChars, registerPages, bitfieldRows, samples: samples.length });
  console.log(`\n===== ${file} =====`);
  console.log(`总页数 ${doc.numPages}；抽查前 ${pages} 页：每页文字约 ${perPageChars} 字符；识别到位域页 ${registerPages} 个、位域行 ${bitfieldRows} 条`);
  samples.forEach((sample, index) => {
    console.log(`  样例 p${sample.page} ${sample.register || ''}`);
    console.log(`    EN : ${sample.text.slice(0, 160)}`);
    console.log(`    ZH : ${(translations[index]?.text || '(空)').slice(0, 160)}`);
  });
}

engine.child.kill();
console.log('\n===== 汇总 =====');
for (const row of summary) console.log(`${row.file}: ${row.pages} 页, 位域行 ${row.bitfieldRows}, 每页 ${row.perPageChars} 字符`);
