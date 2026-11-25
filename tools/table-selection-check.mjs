// 表格划词验收（Playwright + 本机 Edge）：
//   每个表格格子单独算一个划词单位——在格子里拖，只选中格子里的字，不跨格子、不跨行，
//   起点或终点落在格子旁边的空白处也一样（以前会选中整张表甚至后面的段落）。
// 检查：第 65 页 Reserved；另外几张表（页码在 PAGES 里）每页取几个格子各做 7 种拖法；正文划词不受影响。
// 判分标准只写在这里（RM0008 验收样本），不进 src/。
// 用法: node tools/table-selection-check.mjs [baseUrl]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const base = process.argv[2] || 'http://127.0.0.1:3010';
const shotDir = path.join(ROOT, 'outputs', 'screenshots');
fs.mkdirSync(shotDir, { recursive: true });
// 默认抽 4 页；可用环境变量 TABLE_PAGES=104,330,700 指定别的页（逗号分隔）。
const PAGES = process.env.TABLE_PAGES ? process.env.TABLE_PAGES.split(',').map(Number) : [65, 184, 499, 64]; // 第 65 页是用户报告的；其余是另外几张寄存器 / 位表
const CELLS_PER_PAGE = 5;

const results = [];
const check = (name, pass, detail = '') => { results.push({ name, pass, detail }); console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`); };
const norm = (text) => text.replace(/\s+/g, ' ').trim();

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const consoleErrors = [];
page.on('pageerror', (error) => consoleErrors.push(String(error)));
await page.goto(base, { waitUntil: 'networkidle' });
await page.locator('input[type=file][accept*="pdf"]').setInputFiles(path.join(ROOT, '.samples', 'rm0008-en.pdf'));
await page.waitForFunction(() => /\d+\s*页/.test(document.querySelector('.document-label small')?.textContent || ''), null, { timeout: 120000 });
await page.waitForTimeout(2000);
const pageInput = page.locator('.reader-page-controls input').first();

async function goTo(pageNo) {
  await pageInput.fill(String(pageNo));
  await pageInput.press('Enter');
  await page.waitForFunction((n) => document.querySelector(`.page[data-page-number="${n}"] .textLayer span`), pageNo, { timeout: 30000 });
  await page.waitForTimeout(1500);
}
// 取本页里的格子：文字长度 3–24 的标了 data-table-cell 的 span；返回它们的文字，用文字再回头定位，避免滚动后坐标失效
async function listCells(pageNo, wanted) {
  return page.evaluate(([n, limit, preferred]) => {
    const layer = document.querySelector(`.page[data-page-number="${n}"] .textLayer`);
    const all = [...layer.querySelectorAll('span')].filter((s) => s.textContent.trim());
    const cells = all.filter((s) => s.hasAttribute('data-table-cell'));
    // 只抽真正的表格内容：页面中部（排除页眉页脚）、同一行至少有 3 个格子、文字 2–24 个字。
    const page = layer.getBoundingClientRect();
    const rowSize = (s) => cells.filter((other) => Math.abs(other.getBoundingClientRect().top - s.getBoundingClientRect().top) < 3).length;
    const usable = cells.filter((s) => {
      const text = s.textContent.trim();
      const top = (s.getBoundingClientRect().top - page.top) / page.height;
      return text.length >= 2 && text.length <= 24 && top > 0.15 && top < 0.85 && rowSize(s) >= 3;
    });
    const picked = [];
    const pushed = new Set();
    // 尽量抽不同的内容，并且从上、中、下不同位置各取一些，不集中在同一行
    const add = (s) => { const t = s.textContent; if (!pushed.has(t) && picked.length < limit) { pushed.add(t); picked.push(t); } };
    for (const s of usable) if (preferred && s.textContent.trim() === preferred) add(s);
    const step = Math.max(1, Math.floor(usable.length / limit));
    for (let index = 0; index < usable.length; index += step) add(usable[index]);
    for (const s of usable) add(s);
    return { total: all.length, cells: cells.length, rows: usable.length, picked };
  }, [pageNo, wanted, pageNo === 65 ? 'Reserved' : '']);
}
async function locate(pageNo, text) {
  return page.evaluate(async ([n, t]) => {
    const layer = document.querySelector(`.page[data-page-number="${n}"] .textLayer`);
    const span = [...layer.querySelectorAll('span[data-table-cell]')].find((s) => s.textContent === t);
    if (!span) return null;
    span.scrollIntoView({ block: 'center', inline: 'center' });
    await new Promise((r) => setTimeout(r, 400));
    const r = span.getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height };
  }, [pageNo, text]);
}
async function dragAndRead(x1, y1, x2, y2) {
  await page.evaluate(() => getSelection().removeAllRanges());
  const close = page.locator('button[aria-label="关闭选中翻译"]');
  if (await close.count()) await close.click();
  await page.mouse.move(x1, y1);
  await page.mouse.down();
  await page.mouse.move(x2, y2, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(250);
  return norm(await page.evaluate(() => getSelection().toString()));
}

let tested = 0;
let leaked = 0;
const leakDetails = [];
for (const pageNo of PAGES) {
  await goTo(pageNo);
  const { total, cells, rows, picked } = await listCells(pageNo, CELLS_PER_PAGE);
  console.log(`\n第 ${pageNo} 页：文字块 ${total} 个，识别为表格格子 ${cells} 个（页面中部的表格行内 ${rows} 个）；抽测 ${picked.length} 个：${picked.map((t) => `「${t.trim().slice(0, 14)}」`).join(' ')}`);
  check(`第 ${pageNo} 页识别出表格格子`, cells >= 4 && picked.length >= 1, `${cells} 个格子`);
  for (const text of picked) {
    const box = await locate(pageNo, text);
    if (!box || box.y < 120 || box.y > 780) { console.log(`   跳过「${text}」：不在可视区`); continue; }
    const y = box.y + box.h / 2;
    const left = box.x;
    const right = box.x + box.w;
    const word = norm(text);
    const variants = [
      ['词内 → 词内', left + 2, y, right - 2, y],
      ['左边空白 8px → 词内', left - 8, y, right - 2, y],
      ['词内 → 右边空白 15px', left + 2, y, right + 15, y],
      ['左边空白 → 右边空白（整格）', left - 8, y, right + 15, y],
      ['从右往左：右边空白 → 词内', right + 12, y, left + 4, y],
      ['斜着拖到下一行空白', left + 2, y, right + 10, y + 20],
      ['往上拖出一点', left + 2, y, right - 4, y - 16],
    ];
    for (const [name, x1, y1, x2, y2] of variants) {
      // 先弄清按下那一点可以属于谁：落在某些文字块的框里就属于它们（框可能互相重叠），落在空白处就属于离它最近的那块；
      // 位号那种密排的行格子只隔十几个像素，“格子旁边 12 像素”可能已经落在邻居格子里，这时拖选就应该在邻居里。
      // 一个格子被 PDF 拆成几段（正文 + 下标 + 正文，如 fPCLK/2）时，格子的文字是这几段连起来的整体。
      const owners = await page.evaluate(([n, x, yy]) => {
        const layer = document.querySelector(`.page[data-page-number="${n}"] .textLayer`);
        const items = [...layer.querySelectorAll('span')].filter((s) => s.textContent.trim()).map((s) => ({ s, r: s.getBoundingClientRect() }));
        const cellText = (s) => {
          const g = s.getAttribute('data-cell-group');
          if (!g) return s.textContent;
          return [...layer.querySelectorAll(`[data-cell-group="${g}"]`)].sort((p, q) => p.getBoundingClientRect().left - q.getBoundingClientRect().left).map((m) => m.textContent).join('');
        };
        const containing = items.filter(({ r }) => x >= r.left && x <= r.right && yy >= r.top && yy <= r.bottom);
        if (containing.length) return containing.map(({ s }) => cellText(s));
        const dist = ({ r }) => Math.hypot(Math.max(r.left - x, 0, x - r.right), Math.max(r.top - yy, 0, yy - r.bottom));
        // 落在两个格子正中间时（距离相差不到 2 像素）没有唯一答案，选哪个都算对
        const ranked = items.sort((p, q) => dist(p) - dist(q));
        const closest = dist(ranked[0]);
        return ranked.filter((item) => dist(item) <= closest + 2).map(({ s }) => cellText(s));
      }, [pageNo, x1, y1]);
      const ownerTexts = owners.map(norm);
      const selected = await dragAndRead(x1, y1, x2, y2);
      tested += 1;
      // 选中的内容必须是“按下那一格”文字的一部分（不跨格子、不跨行、不选中整表）；
      // 起点只属于目标格子时，整格拖法必须正好选中整格文字。
      const inside = selected === '' || ownerTexts.some((owner) => owner.includes(selected));
      // 目标只是整个格子的其中一段（如 fPCLK/2 里的 “/2 max.)”）时，在它旁边按下可能落在前一段里，不要求整格。
      const wholeCell = name.startsWith('左边空白 → 右边空白') && ownerTexts.length === 1 && ownerTexts[0] === word;
      const exact = wholeCell ? selected === word : true;
      if (!inside || !exact || selected.length > 60) {
        leaked += 1;
        leakDetails.push(`第 ${pageNo} 页「${word.slice(0, 20)}」${name}：按下处属于「${ownerTexts[0].slice(0, 20)}」，选中 ${selected.length} 字“${selected.slice(0, 40)}”`);
      }
    }
  }
}
console.log(`\n共抽测 ${tested} 次拖选（${PAGES.length} 张表 × 每页 ${CELLS_PER_PAGE} 个格子 × 7 种拖法）`);
check('所有拖选都只选中按下那个格子里的字（没有跨格子、跨行、选中整表）', tested >= 40 && leaked === 0, leaked ? `${leaked} 次越界：${leakDetails.slice(0, 10).join('；')}` : `${tested} 次全部在格子内`);

// 用户报告的：第 65 页表里划 Reserved 只选中 Reserved
await goTo(65);
const reservedBox = await locate(65, 'Reserved');
if (reservedBox && reservedBox.y > 120 && reservedBox.y < 780) {
  const y = reservedBox.y + reservedBox.h / 2;
  const selected = await dragAndRead(reservedBox.x - 8, y, reservedBox.x + reservedBox.w + 15, y);
  check('第 65 页表里划 Reserved：只选中 Reserved 一个词', selected === 'Reserved', `选中 ${selected.length} 字“${selected}”`);
  const panel = norm(await page.locator('.selection-source').innerText().catch(() => ''));
  check('划词面板里就是这个词', panel === 'Reserved', `面板“${panel}”`);
  await page.screenshot({ path: path.join(shotDir, 'table-selection-01-reserved.png') });
} else {
  check('第 65 页找到 Reserved 格子', false);
}

// 格子里点一下 / 双击 / 三击：既不弹划词面板，也不会选中整行整表
for (const [name, action] of [
  ['点一下', (x, y) => page.mouse.click(x, y)],
  ['双击', (x, y) => page.mouse.dblclick(x, y)],
  ['三击', (x, y) => page.mouse.click(x, y, { clickCount: 3 })],
]) {
  await page.evaluate(() => getSelection().removeAllRanges());
  const close = page.locator('button[aria-label="关闭选中翻译"]');
  if (await close.count()) await close.click();
  await action(reservedBox.x + reservedBox.w / 2, reservedBox.y + reservedBox.h / 2);
  await page.waitForTimeout(400);
  const selected = norm(await page.evaluate(() => getSelection().toString()));
  const panelOpen = (await page.locator('.selection-panel').count()) > 0;
  check(`格子里${name}：不弹划词面板，也没有选中一片`, !panelOpen && selected.length <= 8, `选区 ${selected.length} 字，划词面板=${panelOpen}`);
}

// 正文划词不受影响：第 1 页 Introduction 段，从第一行拖到第三行，应该能跨行选中
await goTo(1);
const body = await page.evaluate(() => {
  const layer = document.querySelector('.page[data-page-number="1"] .textLayer');
  const spans = [...layer.querySelectorAll('span')].filter((s) => /^(This reference manual|It provides complete|STM32F103xx and STM32F105xx|These devices, featuring)/.test(s.textContent.trim()));
  if (spans.length < 3) return null;
  spans[0].scrollIntoView({ block: 'center' });
  const a = spans[0].getBoundingClientRect();
  const c = spans[2].getBoundingClientRect();
  return { x1: a.left + 8, y1: a.top + a.height / 2, x2: c.left + c.width * 0.6, y2: c.top + c.height / 2, marked: spans.some((s) => s.hasAttribute('data-table-cell')) };
});
if (body) {
  await page.waitForTimeout(500);
  const fresh = await page.evaluate(() => {
    const layer = document.querySelector('.page[data-page-number="1"] .textLayer');
    const spans = [...layer.querySelectorAll('span')].filter((s) => /^(This reference manual|It provides complete|STM32F103xx and STM32F105xx|These devices, featuring)/.test(s.textContent.trim()));
    const a = spans[0].getBoundingClientRect();
    const c = spans[2].getBoundingClientRect();
    return { x1: a.left + 8, y1: a.top + a.height / 2, x2: c.left + c.width * 0.6, y2: c.top + c.height / 2 };
  });
  const selected = await dragAndRead(fresh.x1, fresh.y1, fresh.x2, fresh.y2);
  check('正文没被误标成表格格子', body.marked === false);
  check('正文划词不受影响：可以从第一行拖到第三行跨行选中', selected.length > 100, `选中 ${selected.length} 字：“${selected.slice(0, 50)}…”`);
  await page.screenshot({ path: path.join(shotDir, 'table-selection-02-body-multiline.png') });
} else {
  check('第 1 页找到正文段落', false);
}

check('浏览器控制台无报错', consoleErrors.length === 0, consoleErrors.slice(0, 2).join(' | ') || '无');
const failed = results.filter((result) => !result.pass);
console.log(`\n共 ${results.length} 项，通过 ${results.length - failed.length}，未通过 ${failed.length}`);
await browser.close();
