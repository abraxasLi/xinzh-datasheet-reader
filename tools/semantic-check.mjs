// 语义搜索 UI 验收（Playwright + 本机 Edge）：
// 打开 PDF → 关闭"精确搜索" → 等索引 → 搜索 → 截图 → 点"跳到这一页"。
// 用法: node tools/semantic-check.mjs [baseUrl] [query]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const base = process.argv[2] || 'http://127.0.0.1:3010';
const query = process.argv[3] || '复用映射 AFIO_MAPR';
const shotDir = path.join(ROOT, 'outputs', 'screenshots');
fs.mkdirSync(shotDir, { recursive: true });

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on('pageerror', (error) => errors.push(String(error)));
await page.goto(base, { waitUntil: 'networkidle' });
await page.locator('input[type=file][accept*="pdf"]').setInputFiles(path.join(ROOT, '.samples', 'rm0008-en.pdf'));
await page.waitForFunction(() => /页/.test(document.querySelector('.document-label small')?.textContent || ''), null, { timeout: 60000 });

console.log('精确搜索开关默认：', (await page.locator('button:has-text("精确搜索")').innerText()).replace(/\s+/g, ' '));
await page.locator('button:has-text("精确搜索")').click();
await page.waitForSelector('.semantic-notice:has-text("索引已就绪")', { timeout: 300000 });
console.log('提示：', await page.locator('.semantic-notice').first().innerText());

await page.locator('input[aria-label="用中文搜索手册"]').fill(query);
const started = Date.now();
await page.locator('.search-bar button[type=submit]').click();
await page.waitForSelector('.semantic-card', { timeout: 60000 });
console.log(`搜索耗时：${Date.now() - started} ms`);
await page.screenshot({ path: path.join(shotDir, 'semantic-search-cards.png') });
console.log('卡片数：', await page.locator('.semantic-card').count());
console.log('第一条标题：', await page.locator('.semantic-card h3').first().innerText());
await page.locator('.semantic-card .jump-button').first().click();
await page.waitForTimeout(1500);
console.log('当前页：', await page.locator('input[type=number]').first().inputValue());
await page.screenshot({ path: path.join(shotDir, 'semantic-search-jump.png') });
console.log('页面错误：', errors.length ? errors.join(' | ') : '无');
await browser.close();
