// DeepL key 自检：只翻译一句英文测试句，确认 key 和额度可用。
// 用法: node tools/deepl-check.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const keyFile = path.join(ROOT, '.deepl-key');
let apiKey = process.env.DEEPL_API_KEY || '';
if (!apiKey && fs.existsSync(keyFile)) {
  apiKey = fs.readFileSync(keyFile, 'utf8').trim().replace(/^DEEPL_API_KEY\s*=\s*/, '').replace(/^["']|["']$/g, '');
}
if (!apiKey) {
  console.error('未设置 DEEPL_API_KEY，也没有 .deepl-key 文件。');
  process.exit(2);
}
const free = apiKey.endsWith(':fx');
const endpoint = free ? 'https://api-free.deepl.com/v2/translate' : 'https://api-prod.deepl.com/v2/translate';
console.log(`key 类型：${free ? 'Free（:fx 结尾）' : 'Pro'}；端点：${endpoint}`);

const started = Date.now();
try {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `DeepL-Auth-Key ${apiKey}` },
    body: JSON.stringify({ text: ['The ADC clock must not exceed 14 MHz.'], source_lang: 'EN', target_lang: 'ZH' }),
    signal: AbortSignal.timeout(30000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${response.status} ${payload.message || JSON.stringify(payload).slice(0, 200)}`);
  console.log(`✅ 可用（${Date.now() - started} ms）：${payload.translations?.[0]?.text}`);
} catch (error) {
  console.error(`❌ 失败：${error.message}`);
  process.exit(3);
}
