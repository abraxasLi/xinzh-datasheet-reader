// 浏览器实机验收（Playwright + 本机 Edge）：
// 打开 PDF → 中文搜索定位 → 悬停段落看整段译文 → 固定段落 → 打开模型面板。
// 用法: node tools/ui-check.mjs [baseUrl]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const base = process.argv[2] || 'http://127.0.0.1:3010';
const shotDir = path.join(ROOT, 'outputs', 'screenshots');
fs.mkdirSync(shotDir, { recursive: true });

const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--force-device-scale-factor=1'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const log = [];
const consoleErrors = [];
page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
page.on('pageerror', (error) => consoleErrors.push(String(error)));

await page.goto(base, { waitUntil: 'networkidle' });
await page.screenshot({ path: path.join(shotDir, '01-home.png') });
log.push(`首页标题：${await page.locator('h1').first().innerText()}`);

const modelState = await page.evaluate(async () => (await fetch('/api/model')).json());
log.push(`模型状态：installed=${modelState.installed} runtime=${modelState.runtime?.ready}`);

await page.locator('input[type=file][accept*="pdf"]').setInputFiles(path.join(ROOT, '.samples', 'rm0008-en.pdf'));
await page.waitForFunction(() => {
  const label = document.querySelector('.document-label small');
  return label && /\d+\s*页/.test(label.textContent || '');
}, null, { timeout: 120000 });
await page.waitForTimeout(2500);
log.push(`文档标签：${(await page.locator('.document-label').innerText()).replace(/\n/g, ' · ')}`);
await page.screenshot({ path: path.join(shotDir, '02-pdf-open.png') });

const search = page.locator('.search-bar input');
await search.click();
await search.fill('GPIO 复用功能重映射寄存器');
await search.press('Enter');
await page.waitForSelector('.search-results-panel .result-card', { timeout: 60000 });
const resultCount = await page.locator('.search-results-panel .result-card').count();
const firstResult = await page.locator('.search-results-panel .result-card').first().innerText();
log.push(`搜索结果数：${resultCount}；首条：${firstResult.split('\n').slice(0, 3).join(' | ')}`);
await page.screenshot({ path: path.join(shotDir, '03-search-results.png') });

await page.locator('.search-results-panel .jump-button').first().click();
await page.waitForTimeout(2500);
const pageNumberInput = page.locator('.reader-page-controls input').first();
log.push(`定位后页码：${await pageNumberInput.inputValue()}`);
const highlightCount = await page.locator('.pdf-search-highlight').count();
log.push(`高亮片段数：${highlightCount}`);
await page.screenshot({ path: path.join(shotDir, '04-jump-highlight.png') });

// 悬停正文段落：挑一个不被右侧译读面板遮住的 span，用鼠标坐标悬停
const targetPoint = await page.evaluate(() => {
  const spans = Array.from(document.querySelectorAll('.textLayer span'));
  for (const span of spans) {
    const rect = span.getBoundingClientRect();
    if (!span.textContent?.trim()) continue;
    if (rect.width < 30 || rect.height < 6) continue;
    if (rect.left < 20 || rect.top < 90) continue;
    if (rect.right > window.innerWidth * 0.52) continue;
    if (rect.bottom > window.innerHeight - 60) continue;
    return { x: rect.left + Math.min(rect.width / 2, 40), y: rect.top + rect.height / 2 };
  }
  return null;
});
log.push(`悬停目标：${targetPoint ? `${Math.round(targetPoint.x)},${Math.round(targetPoint.y)}` : '未找到'}`);
if (targetPoint) {
  await page.mouse.move(targetPoint.x - 40, targetPoint.y - 40);
  await page.mouse.move(targetPoint.x, targetPoint.y, { steps: 6 });
  await page.waitForTimeout(3000);
}
const panelVisible = await page.locator('.translation-preview-panel').isVisible().catch(() => false);
log.push(`译读面板可见：${panelVisible}`);
if (panelVisible) {
  const translationText = await page.locator('.translation-preview-panel').innerText();
  log.push('译读面板内容：' + translationText.replace(/\n+/g, ' | ').slice(0, 500));
}
await page.screenshot({ path: path.join(shotDir, '05-hover-translation.png') });

// 固定段落 + 中英对照
if (targetPoint) {
  await page.mouse.click(targetPoint.x, targetPoint.y);
  await page.waitForTimeout(800);
}
const pinned = await page.locator('.pinned-badge').count();
log.push(`固定标记：${pinned}`);
await page.locator('.translation-panel-controls button', { hasText: '中英对照' }).first().click().catch(() => {});
await page.waitForTimeout(400);
await page.screenshot({ path: path.join(shotDir, '06-pinned-bilingual.png') });

await page.locator('.model-button').click();
await page.waitForTimeout(600);
await page.screenshot({ path: path.join(shotDir, '07-model-panel.png') });
const modelPanel = await page.locator('.model-panel').innerText().catch(() => '');
log.push('模型面板：' + modelPanel.replace(/\n+/g, ' | ').slice(0, 300));

// 窄屏检查
await page.setViewportSize({ width: 760, height: 900 });
await page.waitForTimeout(800);
await page.screenshot({ path: path.join(shotDir, '08-narrow.png') });

console.log(log.join('\n'));
console.log('\n控制台错误：' + (consoleErrors.length ? consoleErrors.slice(0, 5).join(' | ') : '无'));
await browser.close();
