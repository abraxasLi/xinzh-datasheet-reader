import path from 'node:path';
import { chromium } from 'playwright-core';

async function open(route, pageNumber, file, shot) {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto('http://127.0.0.1:3010', { waitUntil: 'networkidle' });
  await page.locator('input[type=file][accept*="pdf"]').setInputFiles(path.resolve('.samples/' + file));
  await page.waitForTimeout(6000);
  const input = page.locator('.reader-page-controls input').first();
  await input.fill(String(pageNumber));
  await input.press('Enter');
  await page.waitForTimeout(4500);
  await page.locator('button', { hasText: '表格' }).first().click();
  await page.waitForTimeout(1500);
  const info = await page.evaluate(() => {
    const panel = document.querySelector('.table-panel');
    if (!panel) return { open: false };
    const headers = Array.from(panel.querySelectorAll('thead th')).map((th) => th.innerText.trim());
    const rows = panel.querySelectorAll('tbody tr');
    return {
      open: true,
      heading: panel.querySelector('.bitfield-heading')?.innerText.replace(/\n/g, ' · '),
      headers,
      rows: rows.length,
      first: rows[0] ? Array.from(rows[0].querySelectorAll('td')).map((td) => td.innerText.trim().slice(0, 30)) : [],
    };
  });
  await page.screenshot({ path: 'outputs/screenshots/' + shot });
  console.log(JSON.stringify(info));
  console.log('errors:', errors.slice(0, 2).join(' | ') || 'none');
  await browser.close();
}

await open('/api', 8, 'nm25q128.pdf', '13-table-nm25q128.png');
