// 端到端接口验收：模型安装 → PDF 索引 → 中文搜索 → 整段翻译。
// 用法: node tools/e2e-api.mjs [baseUrl] [pdf] [modelPackage]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const base = process.argv[2] || 'http://127.0.0.1:3010';
const pdfPath = process.argv[3] || path.join(ROOT, '.samples', 'rm0008-en.pdf');
const modelPath = process.argv[4] || path.join(ROOT, 'models', 'argos-en-zh.argosmodel');

async function getJson(route) {
  const response = await fetch(base + route);
  return { status: response.status, body: await response.json() };
}

function report(title, value) {
  console.log(`\n### ${title}\n` + (typeof value === 'string' ? value : JSON.stringify(value, null, 2)));
}

const before = await getJson('/api/model');
report('安装前模型状态', {
  installed: before.body.installed,
  runtimeReady: before.body.runtime?.ready,
  python: before.body.runtime?.python,
});

if (!before.body.installed && fs.existsSync(modelPath)) {
  const started = Date.now();
  const form = new FormData();
  form.append('file', new Blob([fs.readFileSync(modelPath)], { type: 'application/octet-stream' }), path.basename(modelPath));
  const response = await fetch(base + '/api/model', { method: 'POST', body: form });
  const body = await response.json();
  report('安装模型包', { status: response.status, ok: body.ok, error: body.error, manifest: body.manifest, seconds: ((Date.now() - started) / 1000).toFixed(1) });
}

const after = await getJson('/api/model');
report('安装后模型状态', {
  installed: after.body.installed,
  sizeBytes: after.body.sizeBytes,
  license: after.body.manifest?.license?.slice(0, 120),
  licenseNote: after.body.manifest?.licenseNote,
  runtime: after.body.runtime,
  engine: after.body.engine,
});

const pdfForm = new FormData();
pdfForm.append('file', new Blob([fs.readFileSync(pdfPath)], { type: 'application/pdf' }), path.basename(pdfPath));
const uploadStarted = Date.now();
const uploadResponse = await fetch(base + '/api/documents', { method: 'POST', body: pdfForm });
const upload = await uploadResponse.json();
report('建立文档索引', { status: uploadResponse.status, ...upload, seconds: ((Date.now() - uploadStarted) / 1000).toFixed(1) });

if (upload.documentId) {
  const askStarted = Date.now();
  const askResponse = await fetch(base + '/api/ask', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ documentId: upload.documentId, question: 'GPIO 复用功能重映射寄存器' }),
  });
  const ask = await askResponse.json();
  report('中文搜索', {
    status: askResponse.status,
    ms: Date.now() - askStarted,
    answer: ask.answer?.answer_zh,
    resolved: ask.answer?.resolved_term,
    top: ask.answer?.evidence?.[0] && {
      page: ask.answer.evidence[0].page,
      section: ask.answer.evidence[0].section,
      term: ask.answer.evidence[0].highlight_term,
    },
  });
}

const translateTexts = [
  'The GPIOx_MODER register is used to configure the I/O direction mode of the GPIO pins.',
  'When the TC bit is set, the transmission is complete and the USART is ready for the next data.',
  'The ADC clock frequency must not exceed 14 MHz, and the sampling time is 1.5 us.',
];
const translateStarted = Date.now();
const translateResponse = await fetch(base + '/api/translate', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ texts: translateTexts }),
});
const translate = await translateResponse.json();
report('整段翻译', {
  status: translateResponse.status,
  ok: translate.ok,
  code: translate.code,
  error: translate.error,
  totalMs: translate.totalMs,
  wallMs: Date.now() - translateStarted,
  items: translate.items,
});

const repeatStarted = Date.now();
const repeatResponse = await fetch(base + '/api/translate', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ texts: translateTexts }),
});
const repeat = await repeatResponse.json();
report('重复请求（应命中缓存）', { totalMs: repeat.totalMs, wallMs: Date.now() - repeatStarted, ok: repeat.ok });
