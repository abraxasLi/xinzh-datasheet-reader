// 澶氳繛鎺ュ垎娈典笅杞藉櫒锛氭湰鏈哄埌澧冨 CDN 鐨勫崟杩炴帴鍚炲悙寰堜綆锛堢害 20鈥?0 KB/s锛夛紝
// 浣嗗苟鍙戝涓?Range 璇锋眰鍙互鍙犲姞鍒?150鈥?00 KB/s锛屾墍浠?M4 鐢ㄨ繖涓剼鏈彇妯″瀷鍖呫€?// 鐢ㄦ硶: node tools/pget.mjs <url> <outFile> [size] [connections]
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const url = process.argv[2];
const outFile = process.argv[3];
const expectedSize = process.argv[4] ? Number(process.argv[4]) : undefined;
const CONNECTIONS = Number(process.argv[5] || 8);
const CHUNK = 1024 * 1024;

function head() {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method: 'HEAD', timeout: 30000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        resolve(null);
        return;
      }
      resolve({ status: res.statusCode, size: Number(res.headers['content-length'] || 0), ranges: res.headers['accept-ranges'] });
    });
    req.on('timeout', () => req.destroy(new Error('HEAD timeout')));
    req.on('error', reject);
    req.end();
  });
}

function fetchRange(start, end, attempt = 1) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 300000, headers: { Range: `bytes=${start}-${end}`, 'user-agent': 'xinzh-m4/1.0' } }, (res) => {
      if (res.statusCode !== 206) {
        res.resume();
        reject(new Error(`status ${res.statusCode} for ${start}-${end}`));
        return;
      }
      const chunks = [];
      let got = 0;
      res.on('data', (c) => { chunks.push(c); got += c.length; });
      res.on('end', () => {
        if (got !== end - start + 1) {
          reject(new Error(`short range ${start}-${end}: ${got}`));
        } else {
          resolve(Buffer.concat(chunks));
        }
      });
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('range timeout')));
    req.on('error', (err) => {
      if (attempt < 6) {
        setTimeout(() => fetchRange(start, end, attempt + 1).then(resolve, reject), 2000 * attempt);
      } else {
        reject(err);
      }
    });
  });
}

const info = await head();
let size = info?.size || expectedSize;
if (!size) throw new Error('unknown size');
if (expectedSize && info?.size && info.size !== expectedSize) {
  console.warn(`warning: HEAD size ${info.size} != expected ${expectedSize}`);
}
console.log(`url=${url}\nsize=${size} bytes (${(size / 1048576).toFixed(1)} MiB) connections=${CONNECTIONS}`);

const partFile = `${outFile}.part`;
fs.mkdirSync(path.dirname(outFile), { recursive: true });
const fd = fs.openSync(partFile, 'w+');

const ranges = [];
for (let start = 0; start < size; start += CHUNK) {
  ranges.push([start, Math.min(start + CHUNK - 1, size - 1)]);
}
let cursor = 0;
let completedBytes = 0;
const startedAt = Date.now();
const hash = crypto.createHash('sha256');

async function worker(id) {
  for (;;) {
    const index = cursor++;
    if (index >= ranges.length) return;
    const [start, end] = ranges[index];
    let buffer;
    try {
      buffer = await fetchRange(start, end);
    } catch (error) {
      console.error(`worker ${id} chunk ${start} failed: ${error.message}`);
      throw error;
    }
    fs.writeSync(fd, buffer, 0, buffer.length, start);
    completedBytes += buffer.length;
    const seconds = (Date.now() - startedAt) / 1000;
    if (completedBytes % (8 * 1048576) < CHUNK) {
      console.log(`  ${(completedBytes / 1048576).toFixed(1)} / ${(size / 1048576).toFixed(1)} MiB  ${(completedBytes / 1024 / seconds).toFixed(0)} KiB/s`);
    }
  }
}

try {
  await Promise.all(Array.from({ length: CONNECTIONS }, (_, id) => worker(id)));
} finally {
  fs.closeSync(fd);
}

if (completedBytes !== size) throw new Error(`incomplete: ${completedBytes} != ${size}`);
const buffer = fs.readFileSync(partFile);
hash.update(buffer);
const sha = hash.digest('hex');
if (buffer.length !== size) throw new Error(`size mismatch: ${buffer.length}`);
fs.rmSync(outFile, { force: true });
fs.renameSync(partFile, outFile);
console.log(`saved ${outFile} ${size} bytes in ${((Date.now() - startedAt) / 1000).toFixed(0)}s sha256=${sha}`);

