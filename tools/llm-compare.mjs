// 翻译对照实验：同一批 RM0008 真实段落，分别用「本机 Argos」和「免费大模型 API」翻译，
// 生成可直接人工评分的对照表。默认只跑本机模型；要调用在线 API 必须同时给 key 和 --confirm。
//
// 用法：
//   node tools/llm-compare.mjs --check               # 只验证 key / 模型名（不发手册内容）
//   node tools/llm-compare.mjs                       # 只跑本机模型，生成对照表骨架
//   node tools/llm-compare.mjs --confirm             # 同时调用智谱（需要 ZHIPU_API_KEY）
//   node tools/llm-compare.mjs --confirm --model glm-4.7-flash
//
// 环境变量：ZHIPU_API_KEY；可选 ZHIPU_BASE（默认 https://open.bigmodel.cn/api/paas/v4）
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] && !args[index + 1].startsWith('--') ? args[index + 1] : fallback;
};
const has = (name) => args.includes(`--${name}`);

const PDF = flag('pdf', path.join(ROOT, '.samples', 'rm0008-en.pdf'));
const OUT_DIR = path.join(ROOT, 'outputs');
const PYTHON = process.env.XINZH_PYTHON || 'python';
const CONFIRM = has('confirm');
let LLM_MODEL = flag('model', process.env.ZHIPU_MODEL || 'glm-4-flash-250414');
// key 来源优先级：环境变量 ZHIPU_API_KEY > 工作区 .zhipu-key 文件（不进仓库）
function readKeyFile() {
  const file = path.join(ROOT, '.zhipu-key');
  if (!fs.existsSync(file)) return '';
  const raw = fs.readFileSync(file, 'utf8').trim();
  const match = raw.match(/^(?:ZHIPU_API_KEY\s*=\s*)?(.+)$/m);
  return (match?.[1] || '').trim().replace(/^["']|["']$/g, '');
}

const LLM_BASE = process.env.ZHIPU_BASE || 'https://open.bigmodel.cn/api/paas/v4';
const API_KEY = process.env.ZHIPU_API_KEY || readKeyFile();

// 安装包可能带一层版本目录，这里递归找含 model.bin + config.json 的目录。
function locateModelDir(start) {
  const queue = [start];
  while (queue.length) {
    const current = queue.shift();
    if (fs.existsSync(path.join(current, 'model.bin')) && fs.existsSync(path.join(current, 'config.json'))) return current;
    if (!fs.existsSync(current)) continue;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.isDirectory()) queue.push(path.join(current, entry.name));
    }
  }
  return null;
}

const MODEL_DIR = flag('model-dir', locateModelDir(path.join(ROOT, 'models', 'argos-en-zh')) || path.join(ROOT, 'models', 'argos-en-zh', 'model'));

const SYSTEM_PROMPT = [
  '你是嵌入式芯片数据手册的英译中翻译引擎。把用户给的英文段落译成简体中文。',
  '硬性规则：',
  '1. 寄存器名、位域名、缩写、十六进制地址、数值和单位保持原样，不翻译、不改写、不添加空格；',
  '2. 必须保留否定和条件关系（must not / do not / unless / only when / when read）；',
  '3. 只输出译文本身，不要解释、不要加注释、不要用 Markdown；',
  '4. 术语约定：register=寄存器，bit=位，set=置位，cleared=清零，reset=复位，offset=偏移，prescaler=预分频器，alternate function=复用功能，reserved=保留。',
].join('\n');

async function llmComplete(text) {
  const response = await fetch(`${LLM_BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify({
      model: LLM_MODEL,
      temperature: 0.2,
      stream: false,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: text },
      ],
    }),
    signal: AbortSignal.timeout(60000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${response.status} ${JSON.stringify(payload).slice(0, 300)}`);
  return payload.choices?.[0]?.message?.content?.trim() || '';
}

const RETRYABLE = /429|1302|1305|timeout|aborted|50[0-9]/i;

/** 免费模型经常 429，用指数退避重试；不可重试的错误（401/400）直接抛出。 */
async function llmCompleteWithRetry(text, { attempts = 5, baseDelay = 8000 } = {}) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await llmComplete(text);
    } catch (error) {
      lastError = error;
      const message = String(error?.message || error);
      if (!RETRYABLE.test(message) || attempt === attempts - 1) throw error;
      const wait = Math.round(baseDelay * Math.pow(1.8, attempt) + Math.random() * 2000);
      console.log(`    限流/超时，等待 ${(wait / 1000).toFixed(0)}s 后重试（${attempt + 1}/${attempts - 1}）：${message.slice(0, 60)}`);
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
  throw lastError;
}

// 用 key 查询账号可用的模型列表
if (has('list-models')) {
  if (!API_KEY) {
    console.error('未设置 ZHIPU_API_KEY。可以设置环境变量 $env:ZHIPU_API_KEY，或把 key 写进工作区的 .zhipu-key 文件。');
    process.exit(2);
  }
  try {
    const response = await fetch(`${LLM_BASE}/models`, {
      headers: { Authorization: `Bearer ${API_KEY}` },
      signal: AbortSignal.timeout(30000),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`${response.status} ${JSON.stringify(payload).slice(0, 300)}`);
    const models = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload) ? payload : [];
    if (!models.length) {
      console.log('接口没有返回模型列表，原始内容：');
      console.log(JSON.stringify(payload).slice(0, 1500));
    } else {
      console.log(`这个 key 可用模型 ${models.length} 个：`);
      for (const model of models) console.log('  - ' + (model.id || model.model || JSON.stringify(model)));
    }
    console.log('\n挑一个填到 --model 后面，例如：');
    console.log('  node tools\\llm-compare.mjs --model <模型名> --check');
  } catch (error) {
    console.error(`查询失败：${error.message}`);
    console.error('有些账号不允许列模型，可以跳过这步，直接用下面的 --check 逐个试。');
    process.exit(3);
  }
  process.exit(0);
}

// 只验证 key 是否可用，不发手册内容
if (has('check')) {
  if (!API_KEY) {
    console.error('未设置 ZHIPU_API_KEY。可以设置环境变量 $env:ZHIPU_API_KEY，或把 key 写进工作区的 .zhipu-key 文件。');
    process.exit(2);
  }
  const explicit = has('model');
  const candidates = explicit ? [LLM_MODEL] : ['glm-4.7-flash', 'glm-4-flash-250414', 'glm-4-flash', 'glm-4-air', 'glm-4-plus'];
  const okModels = [];
  for (const model of candidates) {
    LLM_MODEL = model;
    const started = Date.now();
    try {
      const reply = await llmComplete('Hello, this is a connectivity test.');
      console.log(`✅ 模型 ${model} 可用（${Date.now() - started} ms）：${reply.slice(0, 80)}`);
      okModels.push(model);
      if (explicit) break;
    } catch (error) {
      console.log(`❌ 模型 ${model} 不可用：${error.message.slice(0, 160)}`);
    }
  }
  if (!okModels.length) {
    console.error('\n没有可用模型。先跑 --list-models，或到控制台确认已开通免费模型。');
    process.exit(3);
  }
  if (okModels.length > 1) {
    console.log(`\n建议用第一个可用的：--model ${okModels[0]}`);
  }
  process.exit(0);
}

// ---------- 段落抽取 ----------
const SAMPLE_PLAN = [
  {
    key: 'reg', label: '寄存器/位域定义', quota: 6,
    test: (t) => /^(?:Bits?|Bit)\s+\d+(?::\d+)?\s+[A-Za-z][A-Za-z0-9_]*(?:\[\d+(?::\d+)?\])?\s*:/.test(t) && t.length > 150 && t.length < 420,
  },
  {
    key: 'cond', label: '否定或条件说明', quota: 6,
    test: (t) => /\b(must not|do not|only when|when read|unless|write-only|read-only|is undefined)\b/i.test(t) && t.length > 150 && t.length < 420,
  },
  {
    key: 'unit', label: '数值与单位', quota: 4,
    test: (t) => /\b\d+(?:\.\d+)?\s*(?:MHz|kHz|us|µs|ns|ms|V|mA|pF|nF)\b/.test(t) && /\b(offset|address|reset value|frequency|time|maximum|minimum|between)\b/i.test(t) && t.length > 150 && t.length < 420,
  },
  {
    key: 'note', label: '注意事项/警告', quota: 4,
    test: (t) => /^(?:Note|Caution|Warning)\b/i.test(t) && t.length > 100 && t.length < 420,
  },
];

function groupParagraphs(items) {
  const usable = items.filter((i) => i.str && i.str.trim()).map((i) => ({
    text: i.str, x: i.transform[4], y: i.transform[5], width: i.width || 0, height: Math.abs(i.transform[3]) || i.height || 10,
  })).sort((a, b) => b.y - a.y || a.x - b.x);
  const lines = [];
  for (const item of usable) {
    const line = lines.find((c) => Math.abs(c.y - item.y) < Math.max(2, Math.min(c.height, item.height) * 0.45));
    if (line) { line.items.push(item); line.height = Math.max(line.height, item.height); }
    else lines.push({ y: item.y, height: item.height, items: [item] });
  }
  lines.sort((a, b) => b.y - a.y);
  for (const line of lines) {
    line.items.sort((a, b) => a.x - b.x);
    line.text = line.items.reduce((text, item, index) => {
      if (index === 0) return item.text;
      const prev = line.items[index - 1];
      const gap = item.x - (prev.x + prev.width);
      const space = gap > Math.min(item.height, prev.height) * 0.2 && !/^[,.;:!?%)\]}]/.test(item.text) && !/\s$/.test(text);
      return text + (space ? ' ' : '') + item.text;
    }, '').replace(/\s+/g, ' ').trim();
    line.top = line.y + line.height;
    line.bottom = line.y;
  }
  const blocks = [];
  for (const line of lines) {
    const prev = blocks.at(-1);
    if (prev && prev.bottom - line.top <= Math.max(4, line.height * 0.9) && prev.bottom - line.top >= -2) {
      prev.lines.push(line);
      prev.bottom = Math.min(prev.bottom, line.bottom);
    } else {
      blocks.push({ lines: [line], bottom: line.bottom });
    }
  }
  return blocks.map((b) => b.lines.map((l) => l.text).join(' ').replace(/\s+/g, ' ').trim()).filter(Boolean);
}

console.log(`读取 ${PDF}`);
const doc = await getDocument({ data: new Uint8Array(fs.readFileSync(PDF)), useSystemFonts: true, isEvalSupported: false }).promise;
const samples = [];
const seen = new Set();
for (let pageNumber = 1; pageNumber <= Math.min(doc.numPages, 400); pageNumber++) {
  if (SAMPLE_PLAN.every((plan) => samples.filter((s) => s.key === plan.key).length >= plan.quota)) break;
  const page = await doc.getPage(pageNumber);
  const paragraphs = groupParagraphs((await page.getTextContent()).items);
  for (const paragraph of paragraphs) {
    if (seen.has(paragraph)) continue;
    for (const plan of SAMPLE_PLAN) {
      const current = samples.filter((s) => s.key === plan.key).length;
      if (current >= plan.quota) continue;
      if (!plan.test(paragraph)) continue;
      samples.push({ key: plan.key, label: plan.label, page: pageNumber, text: paragraph });
      seen.add(paragraph);
      break;
    }
  }
}
await doc.destroy();
console.log(`抽取到 ${samples.length} 段：` + SAMPLE_PLAN.map((p) => `${p.label} ${samples.filter((s) => s.key === p.key).length}`).join('，'));

// ---------- 本机 Argos ----------
function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function runLocal(texts) {
  const port = await freePort();
  const child = spawn(PYTHON, ['-X', 'utf8', path.join(ROOT, 'runtime', 'translate_server.py'), '--model-dir', MODEL_DIR, '--port', String(port)], {
    env: { ...process.env, PYTHONPATH: path.join(ROOT, '.runtime'), PYTHONIOENCODING: 'utf-8' },
    stdio: 'ignore',
    windowsHide: true,
  });
  try {
    const deadline = Date.now() + 120000;
    let ready = false;
    while (Date.now() < deadline && !ready) {
      try { ready = (await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) })).ok; } catch { /* 等待 */ }
      if (!ready) await new Promise((r) => setTimeout(r, 300));
    }
    if (!ready) throw new Error(`本机翻译服务启动超时（模型目录：${MODEL_DIR}）`);
    const response = await fetch(`http://127.0.0.1:${port}/translate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ texts }),
    });
    const payload = await response.json();
    return payload.items || [];
  } finally {
    child.kill();
  }
}

console.log('调用本机 Argos 翻译…');
const localResults = await runLocal(samples.map((s) => s.text));

const llmResults = new Array(samples.length).fill(null);
const JSON_PATH = path.join(OUT_DIR, '翻译对照-20段.json');

// --resume：读取上一次结果，已经译好的段直接复用，只补失败的
if (has('resume') && fs.existsSync(JSON_PATH)) {
  try {
    const previous = JSON.parse(fs.readFileSync(JSON_PATH, 'utf8'));
    const done = new Map((previous.items || []).filter((item) => item?.llm?.text).map((item) => [item.source, item.llm.text]));
    samples.forEach((sample, index) => {
      const hit = done.get(sample.text);
      if (hit) llmResults[index] = hit;
    });
    const reused = llmResults.filter(Boolean).length;
    if (reused) console.log(`--resume：复用上次已完成的 ${reused} 段`);
  } catch (error) {
    console.error(`读取上次结果失败，忽略：${error.message}`);
  }
}

const LIMIT = Number(flag('limit', '0')) || samples.length;
const DELAY = Number(flag('delay', '4000'));

if (CONFIRM) {
  if (!API_KEY) {
    console.error('缺少 ZHIPU_API_KEY，跳过在线翻译。');
  } else {
    console.log(`调用在线模型 ${LLM_MODEL}（会把段落文本发到 ${LLM_BASE}）…`);
    for (const [index, sample] of samples.entries()) {
      if (index >= LIMIT) break;
      if (llmResults[index]) {
        console.log(`  ${index + 1}/${samples.length} 已有译文，跳过`);
        continue;
      }
      try {
        llmResults[index] = await llmCompleteWithRetry(sample.text);
        console.log(`  ${index + 1}/${samples.length} ok`);
      } catch (error) {
        console.error(`  ${index + 1}/${samples.length} 失败：${error.message.slice(0, 160)}`);
      }
      await new Promise((r) => setTimeout(r, DELAY));
    }
    const filled = llmResults.filter(Boolean).length;
    console.log(`本次在线完成 ${filled}/${samples.length} 段` + (filled < samples.length ? '，可加 --resume 再跑一次补齐' : ''));
  }
} else {
  console.log('未加 --confirm：只跑本机模型，在线列留空。');
}

// ---------- 输出 ----------
fs.mkdirSync(OUT_DIR, { recursive: true });
const payload = samples.map((sample, index) => ({
  id: index + 1,
  category: sample.key,
  categoryLabel: sample.label,
  page: sample.page,
  source: sample.text,
  local: { engine: 'argos-en_zh-1.9 + ctranslate2', text: localResults[index]?.text || '', ms: localResults[index]?.ms ?? null },
  llm: { engine: CONFIRM && API_KEY ? LLM_MODEL : null, text: llmResults[index] || null },
}));
fs.writeFileSync(path.join(OUT_DIR, '翻译对照-20段.json'), JSON.stringify({
  generatedAt: new Date().toISOString(),
  pdf: path.basename(PDF),
  count: payload.length,
  llmModel: CONFIRM && API_KEY ? LLM_MODEL : null,
  items: payload,
}, null, 2), 'utf8');

const md = [];
md.push('# 翻译对照实验：本机 Argos vs 在线大模型');
md.push('');
md.push(`生成时间：${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`);
md.push('');
md.push('同一批 RM0008 真实段落，两栏译文并排。评分列留空，请按 1–5 分打：');
md.push('**术语**（寄存器名/位名是否保留正确）、**否定条件**（must not/unless/only when 是否没丢）、**数值单位**（数字、单位、地址是否原样）、**可读性**、**整体可用**。');
md.push('');
md.push('- 本机：Argos `translate-en_zh` 1.9 + CTranslate2（离线，CPU）');
md.push(`- 在线：${CONFIRM && API_KEY ? `智谱 \`${LLM_MODEL}\`` : '未运行（加 `--confirm` 并设置 `ZHIPU_API_KEY` 后重跑）'}`);
md.push(`- 样本：${payload.length} 段，来自 \`${path.basename(PDF)}\``);
md.push('');
md.push('## 评分汇总（人工填写）');
md.push('');
md.push('| 指标 | 本机 Argos 平均 | 在线大模型平均 | 结论 |');
md.push('| --- | --- | --- | --- |');
for (const row of ['术语', '否定条件', '数值单位', '可读性', '整体可用']) md.push(`| ${row} |  |  |  |`);
md.push('');
md.push('## 逐段对照');
md.push('');
for (const item of payload) {
  md.push(`### ${item.id}. [${item.categoryLabel}] 第 ${item.page} 页`);
  md.push('');
  md.push('**原文**');
  md.push('');
  md.push('> ' + item.source);
  md.push('');
  md.push(`**本机 Argos**（${item.local.ms ?? '?'} ms）`);
  md.push('');
  md.push('> ' + (item.local.text || '(空)'));
  md.push('');
  md.push(`**在线 ${item.llm.engine || '(未运行)'}**`);
  md.push('');
  md.push('> ' + (item.llm.text || '(待运行)'));
  md.push('');
  md.push('| 术语 | 否定条件 | 数值单位 | 可读性 | 整体 | 备注 |');
  md.push('| --- | --- | --- | --- | --- | --- |');
  md.push('|  |  |  |  |  |  |');
  md.push('');
}
md.push('## 判读标准');
md.push('');
md.push('- **整体可用 ≥ 4** 且没有术语/数值错误，才算这段能直接给初学者看。');
md.push('- 只要出现寄存器名被译掉、地址/单位被改写、否定条件丢失，这一栏记 1–2 分，不管句子多通顺。');
md.push('- 如果在线模型在 20 段里明显领先（比如整体均分高 1.5 分以上），才值得为它破坏离线承诺；否则继续用本机模型 + 术语校正。');
fs.writeFileSync(path.join(OUT_DIR, '翻译对照-20段.md'), md.join('\n'), 'utf8');
console.log('\n已生成：\n- outputs/翻译对照-20段.md\n- outputs/翻译对照-20段.json');
