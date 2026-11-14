import path from 'node:path';
import { chromium } from 'playwright-core';
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
await page.goto('http://127.0.0.1:3010', { waitUntil: 'networkidle' });
await page.locator('input[type=file][accept*="pdf"]').setInputFiles(path.resolve('.samples/rm0008-en.pdf'));
await page.waitForTimeout(7000);
const search = page.locator('.search-bar input');
await search.click(); await search.fill('GPIO 复用功能重映射寄存器'); await search.press('Enter');
await page.waitForSelector('.search-results-panel .jump-button', { timeout: 60000 });
await page.locator('.search-results-panel .jump-button').first().click();
await page.waitForTimeout(4000);
const point = await page.evaluate(() => {
  for (const span of Array.from(document.querySelectorAll('.textLayer span'))) {
    const rect = span.getBoundingClientRect();
    if (!span.textContent?.trim() || rect.width < 40) continue;
    if (rect.left < 30 || rect.top < 120 || rect.right > window.innerWidth * 0.5 || rect.bottom > window.innerHeight - 80) continue;
    return { x: rect.left + 20, y: rect.top + rect.height / 2 };
  }
  return null;
});
if (point) { await page.mouse.move(point.x - 30, point.y - 30); await page.mouse.move(point.x, point.y, { steps: 5 }); await page.waitForTimeout(2500); }
const select = page.locator('.translation-panel-controls select').nth(1);
await select.selectOption('deepl');
await page.waitForTimeout(6000);
const panel = await page.locator('.translation-preview-panel').innerText().catch(() => '');
console.log('引擎选项:', await select.inputValue());
console.log('面板:', panel.replace(/\n+/g, ' | ').slice(0, 320));
await page.screenshot({ path: 'outputs/screenshots/15-deepl-translate.png' });
console.log('errors:', errors.slice(0, 2).join(' | ') || 'none');
await browser.close();
