import path from 'node:path';
import { chromium } from 'playwright-core';
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
await page.goto('http://127.0.0.1:3010', { waitUntil: 'networkidle' });
await page.locator('input[type=file][accept*="pdf"]').setInputFiles(path.resolve('.samples/rm0008-en.pdf'));
await page.waitForTimeout(6000);
const search = page.locator('.search-bar input');
await search.click(); await search.fill('GPIO 复用功能重映射寄存器'); await search.press('Enter');
await page.waitForSelector('.search-results-panel .jump-button', { timeout: 60000 });
await page.locator('.search-results-panel .jump-button').first().click();
await page.waitForTimeout(4000);
await page.locator('.bitfield-button').click();
await page.waitForTimeout(6000);
const info = await page.evaluate(() => {
  const panel = document.querySelector('.bitfield-panel');
  if (!panel) return { open: false };
  const rows = Array.from(panel.querySelectorAll('tbody tr'));
  return {
    open: true,
    heading: panel.querySelector('.bitfield-heading')?.innerText,
    rows: rows.length,
    sample: rows.slice(0, 4).map((r) => Array.from(r.querySelectorAll('td')).map((td) => td.innerText.trim().slice(0, 70))),
    busy: Boolean(panel.querySelector('.bitfield-status')),
  };
});
console.log(JSON.stringify(info, null, 1));
await page.screenshot({ path: 'outputs/screenshots/12-bitfield-table.png' });
console.log('errors:', errors.slice(0, 3).join(' | ') || 'none');
await browser.close();
