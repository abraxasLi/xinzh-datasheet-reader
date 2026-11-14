const texts = [
  'Bits 26:24 SWJ_CFG[2:0]: Serial wire JTAG configuration These bits are write-only (when read, the value is undefined). They are used to configure the SWJ and trace alternate function I/Os.',
  'The ADC clock frequency must not exceed 14 MHz, and the sampling time is 1.5 us.',
  'Note: Setting the TPAL and TPE bits at the same time is always safe, however resetting both at the same time can generate a spurious Tamper event. For this reason it is recommended to change the TPAL bit only when the TPE bit is reset.',
  'The device requires a 2.0-to-3.6 V operating voltage supply (VDD). An embedded regulator is used to supply the internal 1.8 V digital power.',
];
(async () => {
  const base = 'http://127.0.0.1:3010';
  for (const provider of ['deepl', 'offline']) {
    const started = Date.now();
    const r = await fetch(base + '/api/translate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ texts, provider }) });
    const j = await r.json();
    console.log(`\n===== ${provider} (${Date.now() - started} ms) =====`);
    if (!j.ok) { console.log('失败:', j.code, j.error); continue; }
    j.items.forEach((it, i) => console.log(`${i + 1}. [保护${it.protectedCount}${it.qualityFailed ? ' / 拦截:' + it.qualityReason : ''}] ${it.translation}`));
  }
})();
