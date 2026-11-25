// 划词灵敏度验收（Playwright + 本机 Edge）：第 45 页、跟随译读已开。
// 只有真正拖出一段字（按住后拖动超过 5 像素、且选中至少 2 个字）才弹“选中片段”划词面板；
// 点一下只锁定跟随译文；点一下手抖、轻微滑动、双击（浏览器自动选中单词）、三击都不弹。
// 判分标准只写在这里（RM0008 第 45 页），不进 src/。
// 用法: node tools/selection-sensitivity-check.mjs [baseUrl]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const base = process.argv[2] || 'http://127.0.0.1:3010';
const shotDir = path.join(ROOT, 'outputs', 'screenshots');
fs.mkdirSync(shotDir, { recursive: true });
const results = [];
const check = (name, pass, detail = '') => { results.push({ name, pass, detail }); console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`); };

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const consoleErrors = [];
page.on('pageerror', (error) => consoleErrors.push(String(error)));
await page.goto(base, { waitUntil: 'networkidle' });
await page.locator('input[type=file][accept*="pdf"]').setInputFiles(path.join(ROOT, '.samples', 'rm0008-en.pdf'));
await page.waitForFunction(() => /\d+\s*页/.test(document.querySelector('.document-label small')?.textContent || ''), null, { timeout: 120000 });
await page.waitForTimeout(2000);
await page.locator('.translation-mode-button', { hasText: '跟随译读' }).click();
const pageInput = page.locator('.reader-page-controls input').first();
await pageInput.fill('45');
await pageInput.press('Enter');
await page.waitForTimeout(3500);

const word = await page.evaluate(() => {
  for (const span of document.querySelectorAll('.textLayer span[data-translation-paragraph^="45:"]')) {
    const text = span.textContent || '';
    const rect = span.getBoundingClientRect();
    if (text.length < 25 || rect.top < 240 || rect.bottom > innerHeight - 100 || rect.right > innerWidth - 560) continue;
    return { x: rect.left + rect.width * 0.35, y: rect.top + rect.height / 2, text: text.slice(0, 40) };
  }
  return null;
});
if (!word) { check('第 45 页找到一段正文', false); await browser.close(); process.exit(1); }
console.log(`第 45 页目标：「${word.text}」`);

async function reset() {
  // 先判断按钮在不在再点：不存在时直接 click() 会白等 30 秒超时。
  const closeButton = page.locator('button[aria-label="关闭选中翻译"]');
  if (await closeButton.count()) await closeButton.click();
  await page.evaluate(() => window.getSelection()?.removeAllRanges());
  if (await page.locator('.pinned-badge').count()) { await page.mouse.click(word.x, word.y); await page.waitForTimeout(150); }
  await page.waitForTimeout(150);
}
async function trial(action) {
  await reset();
  await page.evaluate(() => { window.__sel = ''; document.addEventListener('mouseup', () => { window.__sel = (getSelection()?.toString() || '').replace(/\s+/g, ' ').trim(); }, { capture: true, once: true }); });
  await action();
  await page.waitForTimeout(500);
  return {
    panel: (await page.locator('.selection-panel').count()) > 0,
    pinned: (await page.locator('.pinned-badge').count()) > 0,
    selection: await page.evaluate(() => window.__sel),
  };
}
const drag = (dx) => async () => { await page.mouse.move(word.x, word.y); await page.mouse.down(); await page.mouse.move(word.x + dx, word.y, { steps: Math.max(2, Math.round(dx / 2)) }); await page.mouse.up(); };

let r = await trial(async () => { await page.mouse.click(word.x, word.y); });
check('点一下：只锁定跟随译文，不弹划词面板', r.pinned && !r.panel, `锁定=${r.pinned}，划词面板=${r.panel}`);
await page.screenshot({ path: path.join(shotDir, 'selection-01-click-only-locks.png') });

for (const dx of [1, 2, 3]) {
  r = await trial(drag(dx));
  check(`点一下手抖 ${dx} 像素：不弹划词面板`, !r.panel, `划词面板=${r.panel}，锁定=${r.pinned}`);
}
r = await trial(drag(5));
check('拖动恰好 5 像素：不弹（要超过 5 才算）', !r.panel, `划词面板=${r.panel}，选区“${r.selection}”`);
r = await trial(async () => { await page.mouse.dblclick(word.x, word.y); });
check('双击（浏览器自动选中整个单词）：不弹划词面板', !r.panel, `划词面板=${r.panel}，选区“${r.selection}”`);
r = await trial(async () => { await page.mouse.click(word.x, word.y, { clickCount: 3 }); });
check('三击（选中整行）：不弹划词面板', !r.panel, `划词面板=${r.panel}，选区“${r.selection}”`);
r = await trial(async () => { await page.mouse.click(word.x, word.y); await page.waitForTimeout(700); await page.mouse.click(word.x, word.y); });
check('隔 0.7 秒点两下（锁定再解锁）：不弹划词面板', !r.panel, `划词面板=${r.panel}`);

r = await trial(drag(80));
check('真正拖出一段字（80 像素）：弹出划词面板', r.panel && r.selection.length >= 2, `划词面板=${r.panel}，选区“${r.selection}”`);
await page.screenshot({ path: path.join(shotDir, 'selection-02-drag-opens-panel.png') });
const shown = (await page.locator('.selection-source').innerText().catch(() => '')).trim();
check('面板里显示的就是拖出来的那段字', shown === r.selection && shown.length >= 2, `面板“${shown}”`);
// 拖 14 像素能选中几个字取决于字号；规则是：只选中 1 个字不弹，选中 2 个字以上才弹。
r = await trial(drag(14));
check('拖出 14 像素：只选中 1 个字时不弹，2 个字以上才弹', r.panel === (r.selection.length >= 2), `选区“${r.selection}”（${r.selection.length} 个字），划词面板=${r.panel}`);
r = await trial(drag(40));
check('拖出 40 像素（一小段字）：弹出划词面板', r.panel && r.selection.length >= 2, `划词面板=${r.panel}，选区“${r.selection}”`);

check('浏览器控制台无报错', consoleErrors.length === 0, consoleErrors.slice(0, 2).join(' | ') || '无');
const failed = results.filter((result) => !result.pass);
console.log(`\n共 ${results.length} 项，通过 ${results.length - failed.length}，未通过 ${failed.length}`);
await browser.close();
