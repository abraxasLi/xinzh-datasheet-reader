// 下载 M4 最小验证所需的本机依赖：CTranslate2 / SentencePiece 轮子 + Argos en→zh 模型包
// 用法: node tools/fetch-deps.mjs
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WHEEL_DIR = path.join(ROOT, '.wheels');
const MODEL_DIR = path.join(ROOT, 'models');
fs.mkdirSync(WHEEL_DIR, { recursive: true });
fs.mkdirSync(MODEL_DIR, { recursive: true });

function get(url, redirects = 5) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 60000, headers: { 'user-agent': 'xinzh-m4-probe/1.0' } }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects > 0) {
        res.resume();
        const next = new URL(res.headers.location, url).toString();
        resolve(get(next, redirects - 1));
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        return;
      }
      resolve(res);
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

async function getJson(url, redirects = 5) {
  const res = await get(url, redirects);
  const chunks = [];
  for await (const c of res) chunks.push(c);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function download(url, dest, expectedBytes) {
  const tmp = `${dest}.part`;
  const res = await get(url);
  const total = Number(res.headers['content-length'] || 0);
  console.log(`\n>> ${url}`);
  console.log(`   content-length=${total}${expectedBytes ? ` expected=${expectedBytes}` : ''}`);
  const hash = crypto.createHash('sha256');
  let done = 0;
  let lastLog = 0;
  const out = fs.createWriteStream(tmp);
  for await (const chunk of res) {
    done += chunk.length;
    hash.update(chunk);
    if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
    if (done - lastLog > 4 * 1024 * 1024 || done === total) {
      lastLog = done;
      const pct = total ? ((done / total) * 100).toFixed(1) : '?';
      console.log(`   ${(done / 1048576).toFixed(1)} MiB / ${(total / 1048576).toFixed(1)} MiB (${pct}%)`);
    }
  }
  await new Promise((r) => out.end(r));
  if (total && done !== total) throw new Error(`short read: ${done} != ${total}`);
  if (expectedBytes && done !== expectedBytes) throw new Error(`size mismatch: ${done} != ${expectedBytes}`);
  fs.rmSync(dest, { force: true });
  fs.renameSync(tmp, dest);
  const sha = hash.digest('hex');
  console.log(`   saved ${dest} (${done} bytes) sha256=${sha}`);
  return sha;
}

function pickWheel(json, filenameRe) {
  const files = json.urls.filter((u) => u.packagetype === 'bdist_wheel' && filenameRe.test(u.filename));
  if (!files.length) throw new Error(`no wheel matching ${filenameRe} for ${json.info.name} ${json.info.version}`);
  return files[0];
}

const tasks = [];
for (const pkg of ['ctranslate2', 'sentencepiece']) {
  const json = await getJson(`https://pypi.org/pypi/${pkg}/json`);
  console.log(`${pkg} latest = ${json.info.version}, license=${json.info.license || '(none)'}`);
  const wheel = pickWheel(json, /cp313-cp313-win_amd64\.whl$/);
  console.log(`  wheel: ${wheel.filename} ${wheel.size} bytes`);
  tasks.push(() => download(wheel.url, path.join(WHEEL_DIR, wheel.filename), wheel.size));
}

const modelUrl = 'https://data.argosopentech.com/argospm/v1/translate-en_zh-1_9.argosmodel';
tasks.push(() => download(modelUrl, path.join(MODEL_DIR, 'translate-en_zh-1_9.argosmodel'), 70743021));

for (const t of tasks) {
  for (let attempt = 1; ; attempt++) {
    try {
      await t();
      break;
    } catch (e) {
      console.error(`  attempt ${attempt} failed: ${e.message}`);
      if (attempt >= 3) throw e;
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}
console.log('\nALL DONE');
