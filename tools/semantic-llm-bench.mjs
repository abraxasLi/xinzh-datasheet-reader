// 语义搜索大模型横向对比：同一本手册、同一套检索，只换改写 + 出卡的模型。
// 前提：开发服务以 XINZH_SEARCH_DEBUG=1 启动（只有这样才允许按请求覆盖模型），且索引已建好。
// 用法: node tools/semantic-llm-bench.mjs <baseUrl> <out.json> <provider/model> [<provider/model> ...]
// 判分标准（仅用于验收，写在脚本里，不进 src/）：RM0008 实测口径——
//   复用映射 → 前 5 含第 184 页；怎么开看门狗 → 前 5 含第 494 与 496 页；外部时钟最高多少 → 前 5 含第 94 与 127 页。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [base, outFile, ...models] = process.argv.slice(2);
const RUNS = Number(process.env.BENCH_RUNS || 4);
const CASES = [
  { q: '复用映射', need: [184], top1: [184] },
  { q: '怎么开看门狗', need: [494, 496] },
  { q: '外部时钟最高多少', need: [94, 127] },
];

const form = new FormData();
form.append('file', new Blob([fs.readFileSync(path.join(ROOT, '.samples', 'rm0008-en.pdf'))], { type: 'application/pdf' }), 'rm0008-en.pdf');
const { documentId } = await (await fetch(`${base}/api/documents`, { method: 'POST', body: form })).json();
await fetch(`${base}/api/search`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ documentId, action: 'index' }) });
for (;;) {
  const { index } = await (await fetch(`${base}/api/search?documentId=${documentId}`)).json();
  if (index.state === 'ready') break;
  if (index.state === 'error') throw new Error(index.error);
  await new Promise((r) => setTimeout(r, 3000));
}

async function once(llm, question) {
  const started = Date.now();
  try {
    const response = await fetch(`${base}/api/search`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ documentId, question, llm }), signal: AbortSignal.timeout(90000),
    });
    const data = await response.json();
    const wall = Date.now() - started;
    if (!response.ok) return { ok: false, wall, error: String(data.error || response.status).slice(0, 120) };
    const pages = (data.debug?.hits || []).map((h) => h.page);
    const cards = data.cards || [];
    return {
      ok: true, wall, pages, english: data.debug?.english || '', timing: data.timing,
      cardsFull: cards.filter((c) => c.what && c.quote_zh && c.title).length, cards: cards.length,
      firstTitle: cards[0]?.title || '', firstQuote: cards[0]?.quote_zh || '',
    };
  } catch (error) {
    return { ok: false, wall: Date.now() - started, error: String(error).slice(0, 120) };
  }
}

const results = [];
for (const spec of models) {
  const [provider, ...rest] = spec.split('/');
  const llm = { provider, model: rest.join('/') };
  console.log(`== ${spec}`);
  const warm = await once(llm, '怎么开看门狗'); // 预热，不计入
  if (!warm.ok) { console.log('  不可用：', warm.error); results.push({ spec, unavailable: warm.error }); continue; }
  const rows = [];
  for (const c of CASES) {
    for (let i = 0; i < RUNS; i += 1) {
      const r = await once(llm, c.q);
      const hit = r.ok && c.need.every((p) => r.pages.includes(p));
      const top1 = r.ok && (c.top1 ? c.top1.includes(r.pages[0]) : true);
      rows.push({ q: c.q, ...r, pass: hit, top1 });
      console.log(`  ${c.q} #${i + 1} ${r.ok ? `${r.wall}ms pass=${hit} pages=${r.pages.join(',')}` : `FAIL ${r.error}`}`);
    }
  }
  results.push({ spec, rows });
  fs.writeFileSync(outFile, JSON.stringify(results, null, 1));
}
fs.writeFileSync(outFile, JSON.stringify(results, null, 1));

console.log('\n模型 | 每次耗时 中位/最大(s) | 改写 s | 出卡 s | 准确率(前5含目标页) 复用/看门狗/时钟 | 卡片完整率 | 失败');
const med = (a) => (a.length ? [...a].sort((x, y) => x - y)[a.length >> 1] : 0);
for (const item of results) {
  if (item.unavailable) { console.log(`${item.spec} | 不可用：${item.unavailable}`); continue; }
  const ok = item.rows.filter((r) => r.ok);
  const per = CASES.map((c) => { const rs = item.rows.filter((r) => r.q === c.q); return `${rs.filter((r) => r.pass).length}/${rs.length}`; }).join(' ');
  const cardOk = ok.reduce((s, r) => s + r.cardsFull, 0);
  const cardAll = ok.reduce((s, r) => s + r.cards, 0);
  console.log([
    item.spec,
    `${(med(ok.map((r) => r.wall)) / 1000).toFixed(1)} / ${(Math.max(0, ...ok.map((r) => r.wall)) / 1000).toFixed(1)}`,
    (med(ok.map((r) => r.timing?.rewriteMs || 0)) / 1000).toFixed(1),
    (med(ok.map((r) => r.timing?.glmMs || 0)) / 1000).toFixed(1),
    per, `${cardOk}/${cardAll}`, item.rows.length - ok.length,
  ].join(' | '));
}
