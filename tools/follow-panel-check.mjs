// 跟随译读面板验收（Playwright + 本机 Edge）：
//   第 1 页 · 引擎 DeepL · 点 Introduction 那段 →
//   1. 译文里有中文，不是空的
//   2. 只显示当前引擎的提示：选 DeepL 时不出现“离线模型 / 不联网 / 本机模型翻译中”
//   3. 中英对照：一句中文对一句原文，每条都有中文和原文；原文每一行都能在 PDF 这一段的原行里找到
//   4. 原文视图的行数 = PDF 文字层里这一段的行数（段落、换行和 PDF 一样）
//   5. 切回本机离线：提示跟着换成离线的说法，不再出现 DeepL 的发送提示
// 判分标准只写在这里（RM0008 第 1 页），不进 src/。
// 用法: node tools/follow-panel-check.mjs [baseUrl]
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
page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
const shot = (name) => page.screenshot({ path: path.join(shotDir, `follow-${name}.png`) });
const panel = page.locator('.translation-preview-panel');

await page.goto(base, { waitUntil: 'networkidle' });
await page.locator('input[type=file][accept*="pdf"]').setInputFiles(path.join(ROOT, '.samples', 'rm0008-en.pdf'));
await page.waitForFunction(() => /\d+\s*页/.test(document.querySelector('.document-label small')?.textContent || ''), null, { timeout: 120000 });
await page.waitForTimeout(2500);
await page.locator('.translation-mode-button', { hasText: '跟随译读' }).click();
await page.locator('.translation-panel-controls select').nth(1).selectOption('deepl');

// 第 1 页 Introduction 那段：取它第一行的位置，并数 PDF 文字层里这一段有几行
const target = await page.evaluate(() => {
  const spans = [...document.querySelectorAll('.textLayer span[data-translation-paragraph]')].filter((span) => span.dataset.translationParagraph.startsWith('1:'));
  const intro = spans.find((span) => /Introduction/.test(span.textContent || ''));
  if (!intro) return null;
  const id = intro.dataset.translationParagraph;
  // 和 PdfReader 同样的同行判定：纵向差小于字高的 0.4 倍算同一行（上标 ® 不会被单独算一行）
  const boxes = spans.filter((span) => span.dataset.translationParagraph === id).map((span) => span.getBoundingClientRect()).sort((a, b) => a.top - b.top);
  const lineTops = [];
  for (const box of boxes) if (!lineTops.some((top) => Math.abs(top.top - box.top) < Math.max(2, Math.min(top.height, box.height) * 0.4))) lineTops.push(box);
  const tops = { size: lineTops.length };
  const rect = intro.getBoundingClientRect();
  return { id, x: rect.left + 10, y: rect.top + rect.height / 2, pdfLines: tops.size };
});
if (!target) { check('找到第 1 页 Introduction 段', false); process.exit(1); }
await page.mouse.click(target.x, target.y);
const done = await page.waitForFunction(() => {
  const text = document.querySelector('.translation-preview-panel .translation-content')?.textContent || '';
  const chineseChars = ((document.querySelector('.translation-local-result')?.textContent || '').match(/[一-鿿]/g) || []).length;
  return !/翻译中/.test(text) && (chineseChars >= 50 || Boolean(document.querySelector('.translation-pending')));
}, null, { timeout: 60000 }).then(() => true).catch(() => false);

// 1. 译文不空
const zh = (await page.locator('.translation-local-result').innerText().catch(() => '')).trim();
check('DeepL 译文不空', done && (zh.match(/[一-鿿]/g) || []).length >= 50, `${(zh.match(/[一-鿿]/g) || []).length} 个汉字：${zh.replace(/\n/g, ' ⏎ ').slice(0, 90)}`);
check('译文按 PDF 换行分条（标题、列表项另起一行）', zh.split('\n').length >= 3, `${zh.split('\n').length} 行`);
await shot('01-deepl-translation');

// 2. 只显示当前引擎的提示
const panelText = await panel.innerText();
const contradictions = ['离线模型', '不联网', '本机模型翻译中'].filter((word) => panelText.includes(word));
check('选 DeepL 时没有离线/不联网的提示', contradictions.length === 0, contradictions.length ? `出现：${contradictions.join('、')}` : '');
check('选 DeepL 时有发送到 DeepL 的提示', /发送到\s*DeepL/.test(panelText));
check('没有“已拦截”提示', !/已拦截/.test(panelText));

// 4. 原文视图：行数和 PDF 一样
await panel.locator('.translation-panel-controls button', { hasText: '原文' }).click();
await page.waitForTimeout(300);
const sourceText = await panel.locator('.translation-source').innerText();
const sourceLines = sourceText.split('\n').filter((line) => line.trim());
check('原文视图的行数和 PDF 一样', sourceLines.length === target.pdfLines, `原文 ${sourceLines.length} 行，PDF 文字层 ${target.pdfLines} 行`);
check("原文里没有私用区方块字符", ![...sourceText].some((char) => char.charCodeAt(0) >= 0xe000 && char.charCodeAt(0) <= 0xf8ff));
await shot('02-source');

// 3. 中英对照：一句中文对一句原文
await panel.locator('.translation-panel-controls button', { hasText: '中英对照' }).click();
await page.waitForTimeout(300);
const pairs = await panel.locator('.bilingual-pair').evaluateAll((nodes) => nodes.map((node) => ({
  zh: node.querySelector('.bilingual-target')?.textContent?.trim() || '',
  en: node.querySelector('.bilingual-source')?.textContent || '',
  kind: node.className,
})));
const missingZh = pairs.filter((pair) => !/[一-鿿]/.test(pair.zh) && !/^[A-Za-z0-9 .()-]+$/.test(pair.zh));
check('中英对照每条都有中文和原文', pairs.length >= 5 && missingZh.length === 0 && pairs.every((pair) => pair.en.trim()), `${pairs.length} 条；缺中文 ${missingZh.length} 条`);
const pdfLineSet = sourceLines.map((line) => line.trim());
const badLines = pairs.flatMap((pair) => pair.en.split('\n').map((line) => line.trim()).filter(Boolean)).filter((line) => !pdfLineSet.some((pdfLine) => pdfLine.includes(line)));
check('对照里原文的每一行都是 PDF 原行（换行没被打乱）', badLines.length === 0, badLines.length ? `对不上：${badLines.slice(0, 2).join(' | ')}` : `${pairs.filter((pair) => pair.en.includes('\n')).length} 条句子保留了跨行换行`);
const firstPairs = pairs.slice(0, 4).map((pair) => `「${pair.zh.slice(0, 18)}」↔「${pair.en.replace(/\n/g, '⏎').slice(0, 30)}」`).join(' ');
console.log('   前几对：', firstPairs);
await shot('03-bilingual');

// 5. 切回本机离线
await page.locator('.translation-panel-controls select').nth(1).selectOption('offline');
await page.waitForFunction(() => !/翻译中/.test(document.querySelector('.translation-preview-panel .translation-content')?.textContent || ''), null, { timeout: 60000 }).catch(() => {});
await page.waitForTimeout(500);
const offlineText = await panel.innerText();
check('切回本机离线后没有 DeepL 发送提示', !/发送到\s*DeepL/.test(offlineText) && !/在线模式/.test(offlineText));
check('本机离线时底部写明不联网', /翻译在本机完成，不联网/.test(offlineText));
await shot('04-offline');

check('浏览器控制台无报错', consoleErrors.length === 0, consoleErrors.slice(0, 2).join(' | ') || '无');
const failed = results.filter((result) => !result.pass);
console.log(`\n共 ${results.length} 项，通过 ${results.length - failed.length}，未通过 ${failed.length}`);
await browser.close();
