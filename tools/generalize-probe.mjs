// 泛化实测：不同厂商/不同形态的手册，段落翻译与中文搜索分别还能不能打。
// 用法: node tools/generalize-probe.mjs
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PYTHON = process.env.XINZH_PYTHON || 'python';
const BASE = 'http://127.0.0.1:3010';

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

const DOCS = [
  { file: 'ili9341.pdf', queries: ['显示初始化命令', '内存写命令', '如何设置显示窗口'] },
  { file: 'nm25q128.pdf', queries: ['写使能命令', '状态寄存器', '扇区擦除'] },
  { file: 'ds18b20.pdf', queries: ['温度转换命令', '读取温度', '分辨率设置'] },
];

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)); });
  });
}

async function paragraphsOf(pdfPath) {
  const doc = await getDocument({ data: new Uint8Array(fs.readFileSync(pdfPath)), useSystemFonts: true, isEvalSupported: false }).promise;
  const out = [];
  for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber++) {
    const page = await doc.getPage(pageNumber);
    const tc = await page.getTextContent();
    const text = tc.items.map((i) => i.str).join(' ').replace(/\s+/g, ' ').trim();
    for (const piece of text.split(/(?<=\.)\s+(?=[A-Z])/)) {
      const sentence = piece.trim();
      if (sentence.length > 120 && sentence.length < 380 && /^[A-Z]/.test(sentence) && !/[|]{1}/.test(sentence)) {
        out.push({ page: pageNumber, text: sentence });
        break;
      }
    }
    if (out.length >= 2) break;
  }
  await doc.destroy();
  return out;
}

const port = await freePort();
const child = spawn(PYTHON, ['-X', 'utf8', path.join(ROOT, 'runtime', 'translate_server.py'), '--model-dir', MODEL_DIR, '--port', String(port)], {
  env: { ...process.env, PYTHONPATH: path.join(ROOT, '.runtime'), PYTHONIOENCODING: 'utf-8' }, stdio: 'ignore', windowsHide: true,
});
const deadline = Date.now() + 120000;
let ready = false;
while (Date.now() < deadline && !ready) {
  try { ready = (await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) })).ok; } catch { /* 等待 */ }
  if (!ready) await new Promise((r) => setTimeout(r, 300));
}
if (!ready) throw new Error('翻译服务启动失败');

for (const doc of DOCS) {
  const pdfPath = path.join(ROOT, '.samples', doc.file);
  if (!fs.existsSync(pdfPath)) continue;
  console.log(`\n===== ${doc.file} =====`);

  const samples = await paragraphsOf(pdfPath);
  for (const sample of samples) {
    const response = await fetch(`http://127.0.0.1:${port}/translate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ texts: [sample.text] }),
    });
    const payload = await response.json();
    console.log(`[p${sample.page}] EN: ${sample.text.slice(0, 150)}`);
    console.log(`        ZH: ${(payload.items?.[0]?.text || '').slice(0, 150)}`);
  }

  // 中文搜索：走真实应用的 /api/documents + /api/ask
  try {
    const form = new FormData();
    form.append('file', new Blob([fs.readFileSync(pdfPath)], { type: 'application/pdf' }), doc.file);
    const uploadResponse = await fetch(`${BASE}/api/documents`, { method: 'POST', body: form });
    const upload = await uploadResponse.json();
    if (!upload.documentId) throw new Error(upload.error || '索引失败');
    for (const query of doc.queries) {
      const started = Date.now();
      const askResponse = await fetch(`${BASE}/api/ask`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ documentId: upload.documentId, question: query }),
      });
      const ask = await askResponse.json();
      const top = ask.answer?.evidence?.[0];
      console.log(`查询「${query}」→ ${ask.answer?.evidence?.length || 0} 条，Top1: ${top ? `第 ${top.page} 页 / ${top.section?.slice(0, 50)}` : '无结果'} (${Date.now() - started}ms)`);
    }
  } catch (error) {
    console.log(`搜索测试失败：${error.message}`);
  }
}
child.kill();
