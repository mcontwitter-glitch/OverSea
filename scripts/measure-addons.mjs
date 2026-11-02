// Before/after load times for LIL FOOTS activity + holders. BEFORE=http://localhost:4332 (HEAD build) AFTER=http://localhost:4331
import { chromium } from 'playwright';
const runs = +(process.env.RUNS || 3); const b = await chromium.launch(); const out = {};
for (const [name, base] of [['before', process.env.BEFORE || 'http://localhost:4332'], ['after', process.env.AFTER || 'http://localhost:4331']]) {
  out[name] = [];
  for (let i = 0; i < runs; i++) {
    const ctx = await b.newContext({ viewport: { width: 1280, height: 860 } }); await ctx.addInitScript(() => { const o = Storage.prototype.setItem; const t = performance.now(); Storage.prototype.setItem = function (k, v) { if (String(k).startsWith('ms-live-owners:')) window.__ownersLiveMs = performance.now() - t; return o.call(this, k, v); }; });
    const p = await ctx.newPage(); const t0 = Date.now();
    await p.goto(base + '/c/lil-foots?tab=activity');
    await p.waitForSelector('.actr', { timeout: 60000 }); const firstRows = Date.now() - t0;
    const live = await p.waitForFunction(() => window.__ownersLiveMs != null, null, { timeout: 90000 }).then(() => p.evaluate(() => Math.round(window.__ownersLiveMs)), () => null);
    if (name === 'after') await p.waitForFunction(() => (window).__msPerf?.activityInsightAllMs != null, null, { timeout: 90000 }).catch(() => {});
    const info = await p.evaluate(() => ({ perf: (window).__msPerf || null, rows: document.querySelectorAll('.actr').length }));
    // newest row + chains present, from the data model via the DOM: switch to "all" sort is default newest first
    const snapNewest = await p.evaluate(async () => { const a = await (await fetch('/data/lil-foots/activity.json')).json(); return Math.max(...a.map(x => +x.ts || 0)); });
    const chainsSeen = await p.evaluate(() => [...new Set([...document.querySelectorAll('.actr img.cl')].map(i => i.getAttribute('alt')))]);
    out[name].push({ firstRowsMs: firstRows, ownersLiveMs: live, rows: info.rows, snapNewest, chainsSeen, perf: info.perf });
    await ctx.close();
  }
}
console.log(JSON.stringify(out, null, 1)); await b.close();
