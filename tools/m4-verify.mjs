// M4 最小可运行证明：从真实 RM0008 英文 PDF 取三类段落，交给本机离线模型整段翻译，
// 记录来源/尺寸/SHA-256/许可、输入输出与耗时。全程只在本机，不联网。
// 用法: node tools/m4-verify.mjs <pdf> <modelDir> [out.md]
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pdfPath = process.argv[2];
const modelDir = process.argv[3];
const outPath = process.argv[4] || path.join(ROOT, 'outputs', 'M4-离线整段翻译最小验证.md');

const PYTHON = process.env.XINZH_PYTHON || 'D:/Users/32700/miniconda3/python.exe';
const RUNTIME_DIR = path.join(ROOT, '.runtime');

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function groupParagraphs(items) {
  const usable = items
    .filter((item) => item.str && item.str.trim())
    .map((item) => ({
      text: item.str,
      x: item.transform[4],
      y: item.transform[5],
      width: item.width || 0,
      height: Math.abs(item.transform[3]) || item.height || 10,
    }))
    .sort((a, b) => b.y - a.y || a.x - b.x);

  const lines = [];
  for (const item of usable) {
    const line = lines.find((candidate) => Math.abs(candidate.y - item.y) < Math.max(2, Math.min(candidate.height, item.height) * 0.45));
    if (line) { line.items.push(item); line.height = Math.max(line.height, item.height); }
    else lines.push({ y: item.y, height: item.height, items: [item] });
  }
  lines.sort((a, b) => b.y - a.y);
  for (const line of lines) {
    line.items.sort((a, b) => a.x - b.x);
    line.text = line.items.reduce((text, item, index) => {
      if (index === 0) return item.text;
      const previous = line.items[index - 1];
      const gap = item.x - (previous.x + previous.width);
      const needsSpace = gap > Math.min(item.height, previous.height) * 0.2 && !/^[,.;:!?%)\]}]/.test(item.text) && !/\s$/.test(text);
      return text + (needsSpace ? ' ' : '') + item.text;
    }, '').replace(/\s+/g, ' ').trim();
    line.top = line.y + line.height;
    line.bottom = line.y;
  }

  const blocks = [];
  for (const line of lines) {
    const previous = blocks.at(-1);
    if (previous && previous.bottom - line.top <= Math.max(4, line.height * 0.9) && previous.bottom - line.top >= -2) {
      previous.lines.push(line);
      previous.bottom = Math.min(previous.bottom, line.bottom);
      previous.height = Math.max(previous.height, line.height);
    } else {
      blocks.push({ lines: [line], top: line.top, bottom: line.bottom, height: line.height });
    }
  }
  return blocks
    .map((block) => block.lines.map((line) => line.text).join(' ').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

// 三类代表段落：位域定义、含否定/条件的说明、含地址与单位的说明。
const SAMPLE_RULES = [
  {
    key: 'A',
    label: '寄存器位域定义',
    test: (t) => /^(?:Bits?|Bit)\s+\d+(?::\d+)?\s+[A-Za-z][A-Za-z0-9_]*(?:\[\d+(?::\d+)?\])?\s*:/.test(t) && t.length > 120 && t.length < 460,
  },
  {
    key: 'B',
    label: '含否定或条件的说明',
    test: (t) => /\b(must not|do not|only when|is undefined|write-only|read-only|when read|unless)\b/i.test(t) && t.length > 120 && t.length < 460,
  },
  {
    key: 'C',
    label: '含地址或单位的说明',
    test: (t) => /\b\d+(?:\.\d+)?\s*(?:MHz|kHz|us|µs|ns|ms|V|mA)\b/.test(t) && /\b(offset|address|reset value|frequency|time|maximum|minimum)\b/i.test(t) && t.length > 120 && t.length < 460,
  },
];

const data = new Uint8Array(fs.readFileSync(pdfPath));
const doc = await getDocument({ data, useSystemFonts: true, isEvalSupported: false }).promise;
const info = (await doc.getMetadata().catch(() => null))?.info || {};
const pageCount = doc.numPages;
const found = new Map();
for (let pageNumber = 1; pageNumber <= Math.min(pageCount, 320) && found.size < SAMPLE_RULES.length; pageNumber++) {
  const page = await doc.getPage(pageNumber);
  const content = await page.getTextContent();
  const paragraphs = groupParagraphs(content.items);
  for (const rule of SAMPLE_RULES) {
    if (found.has(rule.key)) continue;
    const match = paragraphs.find((paragraph) => rule.test(paragraph));
    if (match) found.set(rule.key, { page: pageNumber, text: match });
  }
}
const samples = SAMPLE_RULES.map((rule) => ({ ...rule, ...(found.get(rule.key) || {}) })).filter((sample) => sample.text);
if (samples.length !== SAMPLE_RULES.length) {
  console.error(`只找到 ${samples.length}/${SAMPLE_RULES.length} 类段落`, samples.map((s) => s.key));
}
await doc.destroy();

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

const port = await freePort();
const startedAt = Date.now();
const child = spawn(PYTHON, ['-X', 'utf8', path.join(ROOT, 'runtime', 'translate_server.py'), '--model-dir', modelDir, '--port', String(port)], {
  env: { ...process.env, PYTHONPATH: RUNTIME_DIR, PYTHONIOENCODING: 'utf-8' },
  stdio: 'ignore',
  windowsHide: true,
});
let health = null;
const deadline = Date.now() + 120000;
while (Date.now() < deadline && !health) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) });
    if (response.ok) health = await response.json();
  } catch { /* 还没起来 */ }
  if (!health) await new Promise((resolve) => setTimeout(resolve, 300));
}
if (!health) { child.kill(); throw new Error('翻译服务启动超时'); }
const coldStartMs = Date.now() - startedAt;

const response = await fetch(`http://127.0.0.1:${port}/translate`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ texts: samples.map((sample) => sample.text) }),
});
const payload = await response.json();
child.kill();
const results = samples.map((sample, index) => ({
  ...sample,
  translation: payload.items?.[index]?.text ?? '(无输出)',
  ms: payload.items?.[index]?.ms,
  tokens: payload.items?.[index]?.tokens,
}));

const modelFiles = fs.existsSync(modelDir)
  ? fs.readdirSync(modelDir, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => ({ name: e.name, size: fs.statSync(path.join(modelDir, e.name)).size }))
  : [];
const packageDir = path.dirname(modelDir);
const licenseFiles = ['LICENSE', 'README.md', 'metadata.json']
  .map((name) => path.join(packageDir, name))
  .filter((file) => fs.existsSync(file))
  .map((file) => ({ name: path.basename(file), text: fs.readFileSync(file, 'utf8').slice(0, 1200) }));
const lines = [];
lines.push('# M4 最小可运行证明：离线整段翻译');
lines.push('');
lines.push(`生成时间：${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`);
lines.push('');
lines.push('## 材料');
lines.push('');
lines.push(`- 样本 PDF：\`${pdfPath}\`（${fs.statSync(pdfPath).size} 字节，SHA-256 \`${sha256(pdfPath)}\`）`);
lines.push(`- 文档信息：${info.Title || '(无标题)'}；${info.Author || '(无作者)'}；${pageCount} 页`);
lines.push(`- 模型：Argos \`translate-en_zh\` 1.9 包（70,743,021 字节，SHA-256 \`433e7c4f034d87fbe2353161e05f18646d7999452f801a4e1f0378522b9850ab\`），已解包到 \`models/argos-en-zh\``);
for (const file of modelFiles) lines.push(`  - \`model/${file.name}\`：${file.size} 字节`);
lines.push(`- 运行时：Python 3.13.9 + CTranslate2（\`.runtime\`，未改全局环境）；推理进程只监听 127.0.0.1:${port}`);
lines.push(`- 冷启动：${coldStartMs} ms（其中模型加载 ${health.load_ms} ms）；compute_type=${health.compute_type}，threads=${health.threads}`);
lines.push(`- 推理参数：beam_size=1，int8 量化，CPU`);
lines.push('');
lines.push('## 输入与输出');
lines.push('');
for (const result of results) {
  lines.push(`### ${result.key}. ${result.label}（第 ${result.page} 页，${result.ms} ms，${result.tokens ?? '?'} tokens）`);
  lines.push('');
  lines.push('原文：');
  lines.push('');
  lines.push('> ' + result.text);
  lines.push('');
  lines.push('译文：');
  lines.push('');
  lines.push('> ' + result.translation);
  lines.push('');
}
lines.push('## 模型包内许可与元数据');
lines.push('');
for (const file of licenseFiles) {
  lines.push(`### ${file.name}`);
  lines.push('');
  lines.push('```');
  lines.push(file.text.trim());
  lines.push('```');
  lines.push('');
}
lines.push('## 边界');
lines.push('');
lines.push('- 本轮只证明「本机模型能给真实 RM0008 段落产出完整中文」并记录耗时，不构成整册质量验收。');
lines.push('- 译文未做标识符占位保护；阅读器接入时会在送入模型前保护寄存器名、地址、数值和单位。');
lines.push('- 模型包内 README 声明原始 OPUS 模型为 CC-BY 4.0；引擎许可（MIT）不能代替模型许可，分发前仍需单独核对。');

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, lines.join('\n'), 'utf8');
console.log(lines.join('\n'));
