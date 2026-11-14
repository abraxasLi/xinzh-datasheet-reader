import path from 'node:path';
import { chromium } from 'playwright-core';
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
await page.goto('http://127.0.0.1:3010', { waitUntil: 'networkidle' });
await page.locator('input[type=file][accept*="pdf"]').setInputFiles(path.resolve('.samples/nm25q128.pdf'));
await page.waitForTimeout(6000);
const input = page.locator('.reader-page-controls input').first();
await input.fill('8'); await input.press('Enter');
await page.waitForTimeout(4000);
// 打开译读面板并把引擎切到 DeepL
await page.locator('.translation-mode-button').click();
await page.locator('.translation-panel-controls select').nth(1).selectOption('deepl');
// 选中表格里的 "Chip Select"
const selected = await page.evaluate(() => {
  const spans = Array.from(document.querySelectorAll('.textLayer span')).filter((s) => (s.textContent || '').trim().length > 4);
  const span = spans.find((s) => /Chip Select/i.test(s.textContent || '')) || spans[0];
  if (!span) return '';
  const range = document.createRange();
  range.selectNodeContents(span);
  const sel = window.getSelection();
  sel.removeAllRanges(); sel.addRange(range);
  document.querySelector('.pdf-viewer-container').dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  return sel.toString();
});
await page.waitForTimeout(600);
await page.locator('.selection-actions button').click();
await page.waitForTimeout(8000);
const result = await page.locator('.selection-result').innerText().catch(() => '(无)');
const meta = await page.locator('.selection-meta').innerText().catch(() => '');
console.log('选中:', JSON.stringify(selected));
console.log('译文:', result);
console.log('引擎:', meta);
await page.screenshot({ path: 'outputs/screenshots/16-selection-deepl.png' });
console.log('errors:', errors.slice(0, 2).join(' | ') || 'none');
await browser.close();
