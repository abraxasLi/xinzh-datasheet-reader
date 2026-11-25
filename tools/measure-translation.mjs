import fs from 'node:fs';
import assert from 'node:assert/strict';

const base = process.argv[2] || 'http://127.0.0.1:3010';
const samples = JSON.parse(fs.readFileSync('outputs/翻译对照-20段.json', 'utf8')).items.slice(0, 5);
const report = { measuredAt: new Date().toISOString(), base, mode: '10 serial HTTP requests, one paragraph per request', samples: samples.map(({ id, page, source }) => ({ id, page, source })), results: [] };
for (const sample of report.samples) {
  for (const provider of ['online', 'deepl']) {
    const id = `timing-${sample.id}-${provider}`;
    const started = performance.now();
    try {
      const response = await fetch(`${base}/api/translate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-xinzh-timing-id': id },
        body: JSON.stringify({ texts: [sample.source], provider }),
        signal: AbortSignal.timeout(150000),
      });
      const body = await response.json();
      report.results.push({ id, sample: sample.id, provider, status: response.status, wallMs: Math.round(performance.now() - started), engineMs: body.totalMs ?? null, ok: body.ok ?? false, engine: body.engine ?? null, items: body.items ?? [], error: body.error ?? null });
    } catch (error) {
      report.results.push({ id, sample: sample.id, provider, wallMs: Math.round(performance.now() - started), ok: false, error: error.message });
    }
    fs.writeFileSync('outputs/任务3-翻译耗时原始记录.json', JSON.stringify(report, null, 2) + '\n');
    const last = report.results.at(-1);
    console.log(`${id} status=${last.status ?? 'error'} wallMs=${last.wallMs} engineMs=${last.engineMs ?? 'unavailable'}`);
  }
}
assert.equal(report.results.length, 10);
