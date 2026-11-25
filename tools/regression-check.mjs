// 回归检查（Playwright + 本机 Edge）：改完搜索后，旧功能在第 184 页是否都还对，再验两种搜索。
//   1. 打开 RM0008 → 第 184 页
//   2. 跟随译读：悬停只高亮、不翻译；点击后锁定并翻译整段
//   3. PDF 里划词 → 左下角出现选中片段的译文
//   4. 默认搜“复用映射”：2–4 秒、结果里有第 184 页、卡片有原句中文/英文（搜索摘要）、结果面板里划词能翻译、跳页并高亮
//   5. 本地按字找的搜索摘要（/api/ask，作为退路仍在）：命中句不是固定提示
//   6. 打开精确搜索再搜“复用映射”：显示“正在仔细想…”、5–10 秒、第一条 AFIO_MAPR 第 184 页、不走 /api/ask、不显示“不联网”
// 判分标准只写在这里（RM0008 验收样本），不进 src/。
// 用法: node tools/regression-check.mjs [baseUrl]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const base = process.argv[2] || 'http://127.0.0.1:3010';
const shotDir = path.join(ROOT, 'outputs', 'screenshots');
fs.mkdirSync(shotDir, { recursive: true });
const shot = (name) => page.screenshot({ path: path.join(shotDir, `regression-${name}.png`) });

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name} — ${detail}`);
}

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const consoleErrors = [];
page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
page.on('pageerror', (error) => consoleErrors.push(String(error)));
const requests = [];
page.on('request', (request) => { if (request.url().includes('/api/')) requests.push({ url: request.url(), body: request.postData() || '', at: Date.now() }); });

await page.goto(base, { waitUntil: 'networkidle' });
await page.locator('input[type=file][accept*="pdf"]').setInputFiles(path.join(ROOT, '.samples', 'rm0008-en.pdf'));
await page.waitForFunction(() => /\d+\s*页/.test(document.querySelector('.document-label small')?.textContent || ''), null, { timeout: 120000 });
await page.waitForSelector('.semantic-notice:has-text("索引已就绪")', { timeout: 300000 });

// 0. 联网提示必须真的看得见（不是只在 DOM 里）
const noticeVisible = await page.evaluate(() => {
  const notice = document.querySelector('.semantic-notice');
  if (!notice) return false;
  const rect = notice.getBoundingClientRect();
  const top = document.elementFromPoint(rect.left + 20, rect.top + rect.height / 2);
  return rect.width > 0 && Boolean(top) && (top === notice || notice.contains(top));
});
check('联网提示常驻可见', noticeVisible, (await page.locator('.semantic-notice').first().innerText()).slice(0, 80));

// 1. 第 184 页
const pageInput = page.locator('.reader-page-controls input').first();
await pageInput.fill('184');
await pageInput.press('Enter');
await page.waitForTimeout(3500);
check('打开第 184 页', (await pageInput.inputValue()) === '184', `页码框 = ${await pageInput.inputValue()}`);
await shot('01-page184');

// 找第 184 页里、不被面板挡住的一行正文
async function pickSpan(minLength, tag) {
  return page.evaluate(([min, mark]) => {
    for (const span of document.querySelectorAll('.textLayer span')) {
      const text = (span.textContent || '').trim();
      const rect = span.getBoundingClientRect();
      if (text.length < min || rect.width < 60 || rect.height < 6) continue;
      // 避开顶部工具栏、左下角页码控件、右侧滚动条；这一步时左右两侧都还没有面板。
      if (rect.top < 230 || rect.bottom > window.innerHeight - 120 || rect.left < 120 || rect.right > window.innerWidth - 60) continue;
      span.setAttribute('data-regression', mark);
      return { x: rect.left + Math.min(rect.width / 2, 60), y: rect.top + rect.height / 2, text };
    }
    return null;
  }, [minLength, tag]);
}

// 2. 跟随译读：悬停只高亮、点击才翻译
await page.locator('.translation-mode-button', { hasText: '跟随译读' }).click();
const target = await pickSpan(20, 'hover');
if (!target) {
  check('悬停高亮', false, '第 184 页没找到可悬停的正文');
} else {
  const translateBefore = requests.filter((r) => r.url.includes('/api/translate')).length;
  await page.mouse.move(target.x - 50, target.y - 50);
  await page.mouse.move(target.x, target.y, { steps: 6 });
  await page.waitForTimeout(1200);
  const frame = await page.locator('.translation-paragraph-frame').count();
  const translateAfterHover = requests.filter((r) => r.url.includes('/api/translate')).length - translateBefore;
  check('悬停只高亮、不翻译', frame > 0 && translateAfterHover === 0, `高亮框 ${frame} 个；悬停期间翻译请求 ${translateAfterHover} 次`);
  await shot('02-hover');

  await page.mouse.click(target.x, target.y);
  const translated = await page.waitForFunction(() => {
    // 要等“翻译中…”这类加载提示消失、真的出现中文译文才算。
    const text = document.querySelector('.translation-preview-panel .translation-content')?.textContent || '';
    return !/翻译中|加载模型/.test(text) && /[一-鿿]{4,}/.test(text);
  }, null, { timeout: 60000 }).then(() => true).catch(() => false);
  const pinned = await page.locator('.pinned-badge').count();
  const panelText = (await page.locator('.translation-preview-panel .translation-content').innerText().catch(() => '')).replace(/\s+/g, ' ');
  check('点击锁定并翻译整段', translated && pinned > 0, `已锁定=${pinned > 0}；译文：${panelText.slice(0, 120)}`);
  await shot('03-click-translate');
  await page.locator('.translation-mode-button', { hasText: '跟随译读' }).click(); // 关掉跟随，免得干扰后面的划词
  await page.locator('.translation-preview-panel button[aria-label="关闭译读面板"]').click().catch(() => {});
}

// 3. PDF 里划词
const selectSpan = await pickSpan(12, 'select');
const selected = await page.evaluate(() => {
  const span = document.querySelector('[data-regression="select"]');
  if (!span) return '';
  const range = document.createRange();
  range.selectNodeContents(span);
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
  span.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  return selection.toString().replace(/\s+/g, ' ').trim();
});
const selectionDone = await page.waitForSelector('.selection-result', { timeout: 60000 }).then(() => true).catch(() => false);
const selectionSource = (await page.locator('.selection-source').innerText().catch(() => '')).trim();
const selectionText = (await page.locator('.selection-result').innerText().catch(() => '')).trim();
check('PDF 划词翻译', Boolean(selectSpan) && selectionDone && selectionSource === selected, `选中“${selected.slice(0, 60)}” → ${selectionText.slice(0, 60)}`);
await shot('04-pdf-selection');
await page.locator('button[aria-label="关闭选中翻译"]').click().catch(() => {});
await page.evaluate(() => window.getSelection()?.removeAllRanges());

// 4. 默认搜（快）
const searchBox = page.locator('.search-bar input');
const submit = page.locator('.search-bar button[type=submit]');
await searchBox.fill('复用映射');
const askBeforeFast = requests.filter((r) => r.url.includes('/api/ask')).length;
let started = Date.now();
await submit.click();
await page.waitForSelector('.semantic-card', { timeout: 60000 });
const fastMs = Date.now() - started;
const fastCards = await page.locator('.semantic-card').evaluateAll((cards) => cards.map((card) => ({
  title: card.querySelector('h3')?.textContent || '',
  page: (card.querySelector('.card-locate button')?.textContent || '').match(/第\s*(\d+)\s*页/)?.[1] || '',
  zh: card.querySelector('.card-quote')?.textContent || '',
  en: card.querySelector('.card-en')?.textContent || '',
})));
const fastPages = fastCards.map((card) => card.page);
const fastBody = requests.filter((r) => r.url.includes('/api/search') && r.body.includes('复用映射')).at(-1)?.body || '';
check('默认搜 2–4 秒', fastMs >= 0 && fastMs <= 4000, `${(fastMs / 1000).toFixed(1)} 秒（请求 mode=${JSON.parse(fastBody || '{}').mode}）`);
check('默认搜结果含第 184 页', fastPages.includes('184'), `卡片页码 ${fastPages.join(', ')}；第一条：${fastCards[0]?.title}（第 ${fastCards[0]?.page} 页）`);
check('默认搜卡片有原句中文和英文（搜索摘要）', fastCards.length > 0 && fastCards.every((card) => card.en.trim().length > 10) && fastCards.filter((card) => card.zh.trim()).length >= Math.ceil(fastCards.length / 2), `${fastCards.length} 张，原句中文 ${fastCards.filter((card) => card.zh.trim()).length} 张，英文原句 ${fastCards.filter((card) => card.en.trim().length > 10).length} 张`);
check('默认搜（索引已就绪时）不走 /api/ask', requests.filter((r) => r.url.includes('/api/ask')).length === askBeforeFast, '');
await shot('05-fast-search');

// 4b. 结果面板里划词
const resultSelected = await page.evaluate(() => {
  const node = document.querySelector('.semantic-card .card-en');
  if (!node) return '';
  const range = document.createRange();
  range.selectNodeContents(node);
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
  node.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  return selection.toString().replace(/\s+/g, ' ').trim();
});
const resultSelectionDone = await page.waitForSelector('.selection-result', { timeout: 60000 }).then(() => true).catch(() => false);
check('搜索结果里划词翻译', resultSelectionDone, `选中“${resultSelected.slice(0, 60)}” → ${(await page.locator('.selection-result').innerText().catch(() => '')).slice(0, 60)}`);
await shot('06-result-selection');
await page.locator('button[aria-label="关闭选中翻译"]').click().catch(() => {});
await page.evaluate(() => window.getSelection()?.removeAllRanges());

// 4c. 跳到第 184 页并高亮
const card184 = page.locator('.semantic-card').filter({ has: page.locator('.card-locate button', { hasText: '第 184 页' }) }).first();
if (await card184.count()) {
  await card184.locator('.jump-button').click();
  await page.waitForTimeout(2500);
  const highlights = await page.locator('.pdf-search-highlight').count();
  check('跳到第 184 页并高亮', (await pageInput.inputValue()) === '184' && highlights > 0, `页码 ${await pageInput.inputValue()}，高亮 ${highlights} 处`);
  await shot('07-jump-highlight');
} else {
  check('跳到第 184 页并高亮', false, '结果里没有第 184 页的卡片');
}

// 5. 本地按字找的搜索摘要（退路，接口不变）
const ask = await page.evaluate(async () => {
  const id = await (async () => {
    const entries = performance.getEntriesByType('resource').map((entry) => entry.name);
    const url = entries.reverse().find((name) => name.includes('/api/search?documentId='));
    return url ? new URL(url).searchParams.get('documentId') : '';
  })();
  const response = await fetch('/api/ask', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ documentId: id, question: 'AFIO_MAPR' }) });
  return response.json();
});
const askFirst = ask.answer?.evidence?.[0];
const summaries = (ask.answer?.evidence || []).map((evidence) => evidence.translation_zh);
check('本地按字找的搜索摘要（退路）', askFirst?.page === 184 && new Set(summaries).size === summaries.length && /AFIO_MAPR/i.test(askFirst?.translation_zh || ''), `第一条第 ${askFirst?.page} 页：${(askFirst?.translation_zh || '').slice(0, 90)}`);

// 6. 精确搜
const toggle = page.locator('.translation-mode-button', { hasText: '精确搜索' });
await toggle.click();
const toggleText = (await toggle.innerText()).replace(/\s+/g, ' ');
const toggleTitle = (await toggle.getAttribute('title')) || '';
await searchBox.fill('复用映射');
const askBeforePrecise = requests.filter((r) => r.url.includes('/api/ask')).length;
started = Date.now();
await submit.click();
await page.waitForTimeout(300);
const thinkingLabel = (await submit.innerText()).trim();
const thinkingPanel = (await page.locator('.semantic-panel .no-results').innerText().catch(() => '')).trim();
await page.waitForFunction(() => !document.querySelector('.search-bar button[type=submit]')?.textContent?.includes('正在'), null, { timeout: 90000 });
const preciseMs = Date.now() - started;
await page.waitForSelector('.semantic-card', { timeout: 10000 });
const preciseFirst = await page.locator('.semantic-card').first().evaluate((card) => ({
  title: card.querySelector('h3')?.textContent || '',
  page: (card.querySelector('.card-locate button')?.textContent || '').match(/第\s*(\d+)\s*页/)?.[1] || '',
  checked: card.querySelector('.card-checked')?.textContent || '',
}));
const preciseBody = requests.filter((r) => r.url.includes('/api/search') && r.body.includes('复用映射')).at(-1)?.body || '';
check('精确搜索开关', /已开启/.test(toggleText) && !/不联网/.test(toggleTitle), `按钮“${toggleText}”；提示“${toggleTitle}”`);
check('精确搜显示“正在仔细想…”', thinkingLabel.includes('正在仔细想') && thinkingPanel.includes('正在仔细想'), `按钮“${thinkingLabel}”；面板“${thinkingPanel}”`);
check('精确搜 5–10 秒', preciseMs >= 5000 && preciseMs <= 10000, `${(preciseMs / 1000).toFixed(1)} 秒（请求 mode=${JSON.parse(preciseBody || '{}').mode}）`);
check('精确搜第一条 AFIO_MAPR 第 184 页', /AFIO_MAPR/.test(preciseFirst.title) && preciseFirst.page === '184', `${preciseFirst.title}（第 ${preciseFirst.page} 页）；${preciseFirst.checked}`);
check('精确搜不走 /api/ask', requests.filter((r) => r.url.includes('/api/ask')).length === askBeforePrecise, '');
await shot('08-precise-search');

const visibleText = await page.evaluate(() => [document.querySelector('.search-bar'), ...document.querySelectorAll('.semantic-notice'), document.querySelector('.semantic-panel')].map((node) => node?.textContent || '').join(' '));
check('搜索相关界面不出现“不联网”', !/不联网/.test(visibleText), '');
check('浏览器控制台无报错', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | ') || '无');

const failed = results.filter((result) => !result.pass);
console.log(`\n共 ${results.length} 项，通过 ${results.length - failed.length}，未通过 ${failed.length}`);
fs.writeFileSync(path.join(ROOT, '.tmp', 'regression-result.json'), JSON.stringify(results, null, 1));
await browser.close();
